/**
 * Daemon-side executor for B-496 Automations. Its own 5s loop next to the
 * Teams worker: claim due runs for this machine, execute them (spawn a
 * session, continue a sticky one, send into a fixed one, or run a script),
 * renew leases, and decide completion.
 *
 * The server owns run state (claim fencing by claimId, lease expiry, maxRuntime).
 * Locally only two things matter: the receipt file, which guarantees a run id
 * is never spawned twice across restarts, and the completion judgement —
 * an explicit `automation_report` from the agent wins (we learn it from the
 * lease-renewal response); otherwise the wrapper's B-466 turn edge
 * (turn_started → turn_ended) followed by a log read that confirms the turn
 * ended marks the run done with the agent's final text as the summary.
 */
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
    AUTOMATION_DEFAULT_LEASE_MS, AUTOMATION_SUMMARY_MAX_CHARS, isAutomationRunTerminal,
    type AutomationClaimedRun, type AutomationReport,
} from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readPersistedSessions } from '@/persistence';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { resolveFirstMessageMeta, resolveSpawnPermissionMode } from '@/commands/spawnDefaults';
import { readSessionLog, TURN_WINDOW } from '@/sessions/sessionOps';
import { analyzeLatestTurn, type TurnState } from '@/sessions/turnState';
import { sanitizeSpawnPermissionMode } from '@/daemon/spawnPermissionMode';
import { isSpawnAgent } from '@/utils/spawnAgents';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { AutomationsRequestError, createAutomationsClient, isAutomationsUnavailable, type AutomationsClient } from '@/automations/client';
import { clipText, renderAction, renderTemplate, type TemplateContext } from '@/automations/template';
import { prepareTeamWorktree } from '@/daemon/teams/worktree';
import { readReceipts, writeReceipt, type AutomationReceipt } from './receipts';
import { runScript as defaultRunScript, type ScriptRunOptions, type ScriptRunResult } from './script';

export const AUTOMATION_TICK_MS = 5_000;
export const AUTOMATION_LEASE_RENEW_MS = 30_000;
/** How often "automations unavailable (404)" may be logged. */
export const AUTOMATION_UNAVAILABLE_LOG_MS = 10 * 60_000;
export const AUTOMATION_SPAWNED_BY = 'automation';

export interface AutomationRunnerDeps {
    machineId: string;
    token: string;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    /** The daemon tracks a live wrapper process for this session. */
    live: (sessionId: string) => boolean;
    /** A turn is in flight per the wrapper's B-466 heartbeat. */
    turnActive: (sessionId: string) => boolean;
    log: (message: string) => void;
    home?: string;
    serverUrl?: string;
    client?: AutomationsClient;
    runScript?: (options: ScriptRunOptions) => Promise<ScriptRunResult>;
    readTurn?: (sessionId: string) => Promise<TurnState>;
    send?: (sessionId: string, text: string, meta: { localId: string; model?: string | null; permissionMode?: string; effort?: string | null }) => Promise<void>;
    prepareWorktree?: (home: string, repository: string, id: string) => Promise<{ directory: string }>;
    now?: () => number;
    tickMs?: number;
}

interface Tracked {
    runId: string;
    automationId: string;
    claimId: string;
    kind: 'spawn' | 'send' | 'script';
    sessionId?: string;
    child?: ChildProcess;
    /** A turn_started was observed (or assumed after a restart). */
    sawTurn: boolean;
    startedAt: number;
    lastLeaseAt: number;
    attentionReported: boolean;
    exited: boolean;
    /** Final report that failed to send; retried each tick. */
    pendingFinal?: AutomationReport;
}

async function defaultReadTurn(sessionId: string): Promise<TurnState> {
    const persisted = readPersistedSessions()[sessionId];
    if (!persisted) throw new Error(`No local key for session ${sessionId}`);
    return analyzeLatestTurn(await readSessionLog(sessionId, persisted, TURN_WINDOW));
}

async function defaultSend(sessionId: string, text: string, meta: { localId: string; model?: string | null; permissionMode?: string; effort?: string | null }): Promise<void> {
    const persisted = await waitForSessionKey(sessionId, 15_000);
    await sendUserMessage(sessionId, persisted, text, 'automation', { ...meta, sentFrom: 'automation' });
}

function expandHome(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
}

/** One line the agent can act on even when its environment names an older run (sticky continuation). */
export function automationPromptHeader(name: string, runId: string): string {
    return `[Very Happy automation "${name}" run ${runId}; finish with automation_report (runId ${runId}) or \`very-happy auto report --run ${runId}\`]`;
}

export function createAutomationRunner(deps: AutomationRunnerDeps) {
    const home = deps.home ?? configuration.happyHomeDir;
    const client = deps.client ?? createAutomationsClient({ serverUrl: deps.serverUrl ?? configuration.serverUrl, token: deps.token, client: 'daemon-auto' });
    const runScript = deps.runScript ?? defaultRunScript;
    const readTurn = deps.readTurn ?? defaultReadTurn;
    const send = deps.send ?? defaultSend;
    const prepareWorktree = deps.prepareWorktree ?? prepareTeamWorktree;
    const now = deps.now ?? (() => Date.now());
    const tracked = new Map<string, Tracked>();
    let running = false;
    let closed = false;
    let disabledUntil = 0;
    let lastUnavailableLogAt = -Infinity;
    let recovered = false;

    function persist(receipt: Omit<AutomationReceipt, 'updatedAt'>): void { writeReceipt(home, receipt, now()); }

    /** Terminal report + receipt; a transport failure keeps the run tracked for a retry. */
    async function finish(item: Tracked, report: AutomationReport): Promise<void> {
        try {
            await client.report(item.runId, report);
        } catch (error) {
            if (!(error instanceof AutomationsRequestError)) { item.pendingFinal = report; deps.log(`Automation run ${item.runId} final report deferred`); return; }
            // 409 run_finished / claim_mismatch: the server already settled it; nothing more to do here.
        }
        persist({ runId: item.runId, automationId: item.automationId, kind: item.kind, phase: 'finished', claimId: item.claimId, sessionId: item.sessionId });
        tracked.delete(item.runId);
    }

    async function failNow(claimed: { run: { id: string; claimId: string }; automation: { id: string } }, kind: Tracked['kind'], error: string, attentionReason?: string, sessionId?: string): Promise<void> {
        const item: Tracked = { runId: claimed.run.id, automationId: claimed.automation.id, claimId: claimed.run.claimId, kind, sessionId, sawTurn: false, startedAt: now(), lastLeaseAt: now(), attentionReported: false, exited: false };
        tracked.set(item.runId, item);
        await finish(item, { claimId: item.claimId, status: 'failed', error: clipText(error, AUTOMATION_SUMMARY_MAX_CHARS), ...(sessionId ? { sessionId } : {}), ...(attentionReason ? { needsAttention: true, attentionReason } : {}) });
    }

    function track(claimed: AutomationClaimedRun, kind: Tracked['kind'], sessionId?: string, child?: ChildProcess): Tracked {
        const item: Tracked = { runId: claimed.run.id, automationId: claimed.automation.id, claimId: claimed.run.claimId, kind, sessionId, child, sawTurn: false, startedAt: now(), lastLeaseAt: now(), attentionReported: false, exited: false };
        tracked.set(item.runId, item);
        return item;
    }

    async function execute(claimed: AutomationClaimedRun): Promise<void> {
        const { run, automation } = claimed;
        const existing = readReceipts(home)[run.id];
        if (existing) {
            if (existing.phase === 'finished' || tracked.has(run.id)) return;
            if (existing.phase === 'starting') { await failNow(claimed, existing.kind, 'Local execution outcome unknown after restart; verify before re-running', 'unknown_outcome'); return; }
            // 'running' with a live claim again: re-attach rather than redo.
            if (existing.kind === 'script') { await failNow(claimed, 'script', 'Daemon restarted while the script was running', 'daemon_restarted'); return; }
            const item = track(claimed, existing.kind, existing.sessionId);
            item.sawTurn = true;
            return;
        }
        const context: TemplateContext = { payload: run.payload, runId: run.id, automationName: automation.name, ...(automation.trigger.kind === 'cron' ? { tz: automation.trigger.tz } : {}), now: now() };
        const action = renderAction(automation.action, context);
        const env = { VH_AUTOMATION_RUN_ID: run.id, VH_AUTOMATION_NAME: automation.name };
        const header = automationPromptHeader(automation.name, run.id);

        if (action.kind === 'script') {
            const timeoutMs = action.timeoutMs ?? automation.maxRuntimeMs;
            persist({ runId: run.id, automationId: automation.id, kind: 'script', phase: 'starting', claimId: run.claimId });
            const item = track(claimed, 'script');
            const finished = runScript({
                command: action.command, cwd: action.cwd ? expandHome(action.cwd) : undefined, timeoutMs,
                env: { ...(action.env ?? {}), ...env, ...(run.payload ? { VH_AUTOMATION_PAYLOAD: run.payload } : {}) },
                onStart: (child) => { item.child = child; },
            });
            persist({ runId: run.id, automationId: automation.id, kind: 'script', phase: 'running', claimId: run.claimId });
            await client.report(run.id, { claimId: run.claimId, status: 'running' }).catch(() => deps.log(`Automation run ${run.id} running report deferred`));
            void finished.then(async (result) => {
                if (!tracked.has(run.id)) return; // cancelled meanwhile
                const ok = result.exitCode === 0 && !result.timedOut && !result.error;
                const error = result.error ? `Launch failed: ${result.error}` : result.timedOut ? `Timed out after ${timeoutMs}ms` : result.exitCode !== 0 ? `Exit ${result.exitCode ?? `signal ${result.signal}`}` : undefined;
                await finish(item, { claimId: run.claimId, status: ok ? 'done' : 'failed', summary: clipText(result.output, AUTOMATION_SUMMARY_MAX_CHARS, 'tail'), exitCode: result.exitCode, ...(error ? { error } : {}) });
            });
            return;
        }

        if (action.kind === 'send') {
            if (!deps.live(action.sessionId)) { await failNow(claimed, 'send', `Session ${action.sessionId} is not running on this machine`, 'session_not_live', action.sessionId); return; }
            persist({ runId: run.id, automationId: automation.id, kind: 'send', phase: 'running', claimId: run.claimId, sessionId: action.sessionId });
            try { await send(action.sessionId, `${header}\n${action.prompt}`, { localId: `automation-${run.id}` }); }
            catch (error) { await failNow(claimed, 'send', `Message delivery failed: ${error instanceof Error ? error.message : String(error)}`, 'send_failed', action.sessionId); return; }
            await client.report(run.id, { claimId: run.claimId, status: 'running', sessionId: action.sessionId }).catch(() => deps.log(`Automation run ${run.id} running report deferred`));
            track(claimed, 'send', action.sessionId);
            return;
        }

        // spawn (possibly sticky)
        const agent = action.agent;
        if (!isSpawnAgent(agent)) { await failNow(claimed, 'spawn', `Unknown agent "${agent}"`, 'invalid_action'); return; }
        if (action.permissionMode && sanitizeSpawnPermissionMode(action.permissionMode) === null) { await failNow(claimed, 'spawn', `Invalid permission mode "${action.permissionMode}"`, 'invalid_action'); return; }
        const permissionMode = resolveSpawnPermissionMode(agent, action.permissionMode ?? undefined);
        const stickyKey = action.sticky ? renderTemplate(action.sticky.key, context) : undefined;
        if (stickyKey) {
            const bound = claimed.stickies.find((sticky) => sticky.key === stickyKey);
            if (bound && deps.live(bound.sessionId)) {
                persist({ runId: run.id, automationId: automation.id, kind: 'send', phase: 'running', claimId: run.claimId, sessionId: bound.sessionId, stickyKey });
                try { await send(bound.sessionId, `${header}\n${action.prompt}`, { localId: `automation-${run.id}` }); }
                catch (error) { await failNow(claimed, 'send', `Sticky session delivery failed: ${error instanceof Error ? error.message : String(error)}`, 'send_failed', bound.sessionId); return; }
                await client.report(run.id, { claimId: run.claimId, status: 'running', sessionId: bound.sessionId, stickyKey }).catch(() => deps.log(`Automation run ${run.id} running report deferred`));
                track(claimed, 'send', bound.sessionId);
                return;
            }
            if (bound) await client.deleteSticky(automation.id, stickyKey).catch(() => deps.log(`Automation ${automation.name}: stale sticky ${stickyKey} not cleared`));
        }
        let directory = expandHome(action.directory);
        if (!isAbsolute(directory)) { await failNow(claimed, 'spawn', `Directory must be absolute: ${action.directory}`, 'invalid_action'); return; }
        if (action.worktree) {
            try { directory = (await prepareWorktree(home, directory, `auto-${run.id}`)).directory; }
            catch (error) { await failNow(claimed, 'spawn', `Worktree preparation failed: ${error instanceof Error ? error.message : String(error)}`, 'worktree_failed'); return; }
        }
        persist({ runId: run.id, automationId: automation.id, kind: 'spawn', phase: 'starting', claimId: run.claimId, stickyKey, ...(action.worktree ? { directory } : {}) });
        const spawned = await deps.spawn({ directory, agent, permissionMode, spawnedBy: AUTOMATION_SPAWNED_BY, environmentVariables: env });
        if (spawned.type !== 'success') {
            persist({ runId: run.id, automationId: automation.id, kind: 'spawn', phase: 'finished', claimId: run.claimId });
            await failNow(claimed, 'spawn', spawned.type === 'error' ? spawned.errorMessage : 'Directory approval required', 'spawn_failed');
            return;
        }
        persist({ runId: run.id, automationId: automation.id, kind: 'spawn', phase: 'running', claimId: run.claimId, sessionId: spawned.sessionId, stickyKey, ...(action.worktree ? { directory } : {}) });
        const item = track(claimed, 'spawn', spawned.sessionId);
        try {
            const capabilities = readPersistedSessions()[spawned.sessionId]?.metadata?.capabilities ?? null;
            const meta = resolveFirstMessageMeta({ agent, permissionMode, explicitModel: action.model ?? undefined, capabilities });
            await send(spawned.sessionId, `${header}\n${action.prompt}`, { localId: `automation-${run.id}`, ...meta });
        } catch (error) {
            await finish(item, { claimId: run.claimId, status: 'failed', sessionId: spawned.sessionId, error: `First message failed: ${error instanceof Error ? error.message : String(error)}`, needsAttention: true, attentionReason: 'first_message_failed' });
            return;
        }
        await client.report(run.id, { claimId: run.claimId, status: 'running', sessionId: spawned.sessionId, ...(stickyKey ? { stickyKey } : {}) }).catch(() => deps.log(`Automation run ${run.id} running report deferred`));
    }

    /** Completion / lease pass over tracked runs. */
    async function monitor(): Promise<void> {
        const at = now();
        for (const item of [...tracked.values()]) {
            if (closed) return;
            if (item.pendingFinal) { await finish(item, item.pendingFinal); continue; }
            if (item.kind === 'script') { await renew(item, at); continue; }
            const sessionId = item.sessionId!;
            if (deps.turnActive(sessionId)) item.sawTurn = true;
            const alive = deps.live(sessionId) && !item.exited;
            if (!alive) {
                // Exited: whatever the log says is final.
                const turn = await readTurn(sessionId).catch(() => null);
                if (turn?.ended && turn.status !== 'failed') await finish(item, { claimId: item.claimId, status: 'done', sessionId, summary: clipText(turn.answer, AUTOMATION_SUMMARY_MAX_CHARS) });
                else await finish(item, { claimId: item.claimId, status: 'failed', sessionId, error: turn?.error ?? 'Session exited before the turn ended', needsAttention: true, attentionReason: 'session_exited' });
                continue;
            }
            const due = item.sawTurn ? !deps.turnActive(sessionId) : at - item.lastLeaseAt >= AUTOMATION_LEASE_RENEW_MS;
            if (due) {
                // Turn edge fell (or, for wrappers without B-466 reporting, a periodic look): confirm on the log.
                const turn = await readTurn(sessionId).catch(() => null);
                if (turn?.ended) {
                    if (turn.status === 'failed') await finish(item, { claimId: item.claimId, status: 'failed', sessionId, error: turn.error ?? 'Turn failed', needsAttention: true, attentionReason: 'turn_failed' });
                    else await finish(item, { claimId: item.claimId, status: 'done', sessionId, summary: clipText(turn.answer, AUTOMATION_SUMMARY_MAX_CHARS) });
                    continue;
                }
            }
            await renew(item, at);
        }
    }

    async function renew(item: Tracked, at: number): Promise<void> {
        if (at - item.lastLeaseAt < AUTOMATION_LEASE_RENEW_MS) return;
        item.lastLeaseAt = at;
        try {
            const run = await client.report(item.runId, { claimId: item.claimId, leaseMs: AUTOMATION_DEFAULT_LEASE_MS });
            if (isAutomationRunTerminal(run.status)) settleExternally(item);
        } catch (error) {
            if (error instanceof AutomationsRequestError && error.status === 409) settleExternally(item);
            else deps.log(`Automation run ${item.runId} lease renewal failed`);
        }
    }

    /** The server closed the run (explicit report, cancel, expiry): stop local work. */
    function settleExternally(item: Tracked): void {
        if (item.child && item.child.exitCode === null) { try { item.child.kill('SIGTERM'); } catch { /* gone */ } }
        persist({ runId: item.runId, automationId: item.automationId, kind: item.kind, phase: 'finished', claimId: item.claimId, sessionId: item.sessionId });
        tracked.delete(item.runId);
    }

    /** Receipts left by a previous daemon process. */
    async function recover(): Promise<void> {
        recovered = true;
        let receipts: Record<string, AutomationReceipt>;
        try { receipts = readReceipts(home); } catch { deps.log('Automation receipts unreadable; refusing to execute until repaired'); closed = true; return; }
        for (const receipt of Object.values(receipts)) {
            if (receipt.phase === 'finished') continue;
            const item: Tracked = { runId: receipt.runId, automationId: receipt.automationId, claimId: receipt.claimId, kind: receipt.kind, sessionId: receipt.sessionId, sawTurn: true, startedAt: now(), lastLeaseAt: 0, attentionReported: false, exited: false };
            tracked.set(item.runId, item);
            if (receipt.phase === 'starting') await finish(item, { claimId: receipt.claimId, status: 'failed', error: 'Daemon restarted before the launch outcome was known', needsAttention: true, attentionReason: 'unknown_outcome' });
            else if (receipt.kind === 'script') await finish(item, { claimId: receipt.claimId, status: 'failed', error: 'Daemon restarted while the script was running', needsAttention: true, attentionReason: 'daemon_restarted' });
            // Session runs keep being monitored with the recovered claim.
        }
    }

    async function tick(): Promise<void> {
        if (running || closed) return;
        running = true;
        try {
            if (!recovered) await recover();
            if (closed) return;
            if (now() >= disabledUntil) {
                try {
                    const claimed = await client.claim({ machineId: deps.machineId, leaseMs: AUTOMATION_DEFAULT_LEASE_MS });
                    for (const entry of claimed.runs) {
                        if (closed) break;
                        try { await execute(entry); } catch (error) { deps.log(`Automation run ${entry.run.id} failed to start: ${error instanceof Error ? error.message : String(error)}`); }
                    }
                } catch (error) {
                    if (isAutomationsUnavailable(error)) {
                        // Old server or gate off: never noisy (spec: ≤1 debug line / 10 min).
                        disabledUntil = now() + 60_000;
                        if (now() - lastUnavailableLogAt >= AUTOMATION_UNAVAILABLE_LOG_MS) { lastUnavailableLogAt = now(); deps.log('Automations unavailable on this server (404); claim loop idle'); }
                    } else {
                        disabledUntil = now() + 10_000;
                        deps.log(`Automation claim failed${error instanceof AutomationsRequestError ? ` (${error.status})` : ''}`);
                    }
                }
            }
            await monitor();
        } finally { running = false; }
    }

    /** Session lifecycle from the daemon: blocked → attention, exited → settle on the log. */
    function report(sessionId: string, event: 'idle' | 'blocked' | 'exited'): void {
        for (const item of tracked.values()) {
            if (item.sessionId !== sessionId) continue;
            if (event === 'exited') item.exited = true;
            if (event === 'blocked' && !item.attentionReported) {
                item.attentionReported = true;
                void client.report(item.runId, { claimId: item.claimId, needsAttention: true, attentionReason: 'needs_input' }).catch(() => deps.log(`Automation run ${item.runId} attention report failed`));
            }
        }
    }

    const timer = setInterval(() => { void tick(); }, deps.tickMs ?? AUTOMATION_TICK_MS);
    timer.unref();
    void tick();
    return {
        tick, report,
        hasSession: (id: string) => [...tracked.values()].some((item) => item.sessionId === id),
        trackedRunIds: () => [...tracked.keys()],
        get busy() { return running; },
        stop: () => { closed = true; clearInterval(timer); },
    };
}
