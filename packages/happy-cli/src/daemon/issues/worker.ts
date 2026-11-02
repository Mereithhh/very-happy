import { agentProfileUnavailableReason, ISSUE_ASSIGNABLE_AGENTS, ISSUE_DISPATCH_LOCAL_ID_PREFIX, ISSUE_SENT_FROM, type IssueDispatchView } from '@slopus/happy-wire';
import { isAbsolute } from 'node:path';
import { configuration } from '@/configuration';
import { readPersistedSessions } from '@/persistence';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { resolveFirstMessageMeta, resolveSpawnPermissionMode } from '@/commands/spawnDefaults';
import { accountUnavailableError } from '@/agentProfiles/launchAccount';
import { sanitizeSpawnPermissionMode } from '@/daemon/spawnPermissionMode';
import { IssueRequestError, IssuesUnsupportedError, type IssuesClient } from '@/issues/client';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { listIssueReceipts, readIssueReceipt, writeIssueReceipt, type IssueReceipt } from './journal';

/**
 * B-874 daemon issue worker (spec 2026-11-issues §3.2 / §11). Same shape as
 * the Teams worker: the server never calls the daemon; every 5 s this polls
 * `GET /v1/issues/dispatch`, claims each dispatch (the claim freezes the spawn
 * prompt — the poll's prompt is only a preview), runs it, then completes or
 * fails it.
 *
 * spawn:   account check (B-850d, refused = never the machine login) → spawn
 *          (`spawnedBy:'issue'`, env VH_ISSUE_ID / VH_ISSUE_RUN_ID / VH_ISSUE_KEY)
 *          → joinProject(via 'issue') → first message `issue-<dispatchId>` →
 *          complete {sessionId}.
 * message: the run's session is live → queued user message (never steer) →
 *          complete; not live → fail (the server starts a new run).
 *
 * A spawn that clearly failed (directory not creatable, wrapper exited, …)
 * fails the run with its reason (§3.7 → 「需要我决策」). One whose outcome is
 * unknown keeps its claim and is re-checked each tick for
 * ISSUE_SPAWN_UNKNOWN_GRACE_MS, then recovered or failed — never left `claimed`.
 *
 * Old server / switch off: the client answers `IssuesUnsupportedError` and
 * backs off 10 minutes, so the worker costs one 404 per 10 minutes.
 */

export const ISSUE_POLL_MS = 5_000;
export const ISSUE_SPAWNED_BY = 'issue';
/**
 * B-874c (QA43 P2-1): a spawn whose outcome is unknown (the wrapper may still
 * come up) holds its claim and is re-checked every tick; past this it fails
 * the run with a reason. Below the server's 120 s claim lease, so the claim is
 * still ours when we report; a daemon that dies meanwhile is bounded by the
 * lease (3 expiries fail the run).
 */
export const ISSUE_SPAWN_UNKNOWN_GRACE_MS = 60_000;
const FIRST_MESSAGE_KEY_WAIT_MS = 10_000;

type SessionEvent = 'running' | 'idle' | 'exited' | 'crashed';

export interface IssueWorkerDeps {
    machineId: string;
    client: IssuesClient;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    live: (sessionId: string) => boolean;
    log: (message: string) => void;
    /** B-850d: the daemon's spawn-time account check (throws `agent-profile-unavailable:<reason>`). */
    resolveAccount?: (agent: 'claude' | 'codex', requested: string | null | undefined) => string | null;
    joinProject?: (sessionId: string, projectId: string) => Promise<unknown>;
    send?: (sessionId: string, text: string, options: Parameters<typeof sendUserMessage>[4]) => Promise<void>;
    capabilities?: (sessionId: string) => string[] | null;
    home?: string;
    /** Tests drive `tick()` themselves. */
    autoStart?: boolean;
    now?: () => number;
}

/** `VH-12` from the frozen prompt's first line (`You are assigned issue VH-12: …`); the dispatch view carries no key. */
export function issueKeyFromPrompt(prompt: string): string | null {
    return /^You are assigned issue ([A-Z]+-\d{1,9}):/.exec(prompt)?.[1] ?? null;
}

/** The spawn's `agentProfileId`: absent = machine / project default, null = machine login. */
export function issueSpawnAccount(spawn: Pick<NonNullable<IssueDispatchView['spawn']>, 'agentProfile'>): string | null | undefined {
    if (spawn.agentProfile === undefined) return undefined;
    return spawn.agentProfile === null ? null : spawn.agentProfile.id;
}

/** Why this spawn must not start (account unusable / not supported for the agent), or null. */
export function issueAccountRefusal(resolve: IssueWorkerDeps['resolveAccount'], agent: string, requested: string | null | undefined): string | null {
    if (!resolve) return null;
    if (agent !== 'claude' && agent !== 'codex') return typeof requested === 'string' ? `Account unavailable (agent-mismatch): accounts are not supported for ${agent} yet` : null;
    try { resolve(agent, requested); return null; }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return accountUnavailableError(message, 'issue');
    }
}

/**
 * Wrapper exit → run session event (B-505: an infrastructure stop — SIGTERM /
 * SIGINT / clean exit — is `exited`, never a failure; anything else is a crash).
 */
export function issueExitEvent(exit: { code: number | null; signal: NodeJS.Signals | null } | undefined): 'exited' | 'crashed' {
    if (!exit) return 'exited';
    if (exit.signal) return ['SIGTERM', 'SIGINT', 'SIGHUP'].includes(exit.signal) ? 'exited' : 'crashed';
    return exit.code === 0 || exit.code === null || exit.code === 130 || exit.code === 143 ? 'exited' : 'crashed';
}

function persistedRunSessions(runId: string): string[] {
    return Object.entries(readPersistedSessions())
        .filter(([, entry]) => (entry.metadata as { issue?: { runId?: unknown } } | undefined)?.issue?.runId === runId)
        .map(([sessionId]) => sessionId);
}

function httpCode(error: unknown): string | null {
    return error instanceof IssueRequestError ? error.code : null;
}

export function createIssueWorker(deps: IssueWorkerDeps) {
    const home = deps.home ?? configuration.happyHomeDir;
    const client = deps.client;
    const send = deps.send ?? (async (sessionId, text, options) => {
        const key = await waitForSessionKey(sessionId, FIRST_MESSAGE_KEY_WAIT_MS);
        await sendUserMessage(sessionId, key, text, 'issue', options);
    });
    const capabilities = deps.capabilities ?? ((sessionId: string) => readPersistedSessions()[sessionId]?.metadata?.capabilities ?? null);
    let running = false;
    let closed = false;
    let retryAt = 0;
    /** Live run sessions this machine started (rebuilt from receipts after a restart). */
    const runBySession = new Map<string, string>();
    const lastEvent = new Map<string, SessionEvent>();
    const events: { sessionId: string; runId: string; event: SessionEvent }[] = [];
    for (const r of listIssueReceipts(home)) {
        if (r.kind === 'spawn' && r.sessionId && !r.ended && (r.phase === 'delivered' || r.phase === 'completed')) runBySession.set(r.sessionId, r.runId);
    }

    const save = (receipt: IssueReceipt) => { writeIssueReceipt(home, receipt); return receipt; };

    const now = deps.now ?? Date.now;
    /** Spawns whose outcome is not known yet, by dispatch id (claim held, re-checked every tick). */
    const unknownSpawns = new Map<string, { view: IssueDispatchView; receipt: IssueReceipt; reason: string; deadline: number }>();

    // Every failure is definite (the run fails and lands in 「需要我决策」); an unknown outcome is held locally, never `unknown:true`.
    async function fail(receipt: IssueReceipt, error: string) {
        await client.fail(receipt.dispatchId, { machineId: deps.machineId, claimId: receipt.claimId, error: error.slice(0, 4000) });
        save({ ...receipt, phase: 'failed' });
        deps.log(`Issue dispatch ${receipt.dispatchId} failed`);
    }

    function holdUnknown(view: IssueDispatchView, receipt: IssueReceipt, reason: string) {
        const held = unknownSpawns.get(view.id);
        unknownSpawns.set(view.id, { view, receipt, reason, deadline: held?.deadline ?? now() + ISSUE_SPAWN_UNKNOWN_GRACE_MS });
        deps.log(`Issue dispatch ${view.id} spawn outcome unknown; re-checking`);
    }

    /** Recover a held spawn from its session's metadata, or fail it once the grace is over. */
    async function recheckUnknown() {
        for (const [id, held] of [...unknownSpawns]) {
            if (closed) return;
            const matches = persistedRunSessions(held.view.runId);
            try {
                if (matches.length === 1) {
                    unknownSpawns.delete(id);
                    await afterSpawn(held.view, save({ ...held.receipt, sessionId: matches[0], phase: 'spawned' }));
                } else if (matches.length > 1 || now() >= held.deadline) {
                    unknownSpawns.delete(id);
                    await fail(held.receipt, matches.length > 1
                        ? `Spawn produced ${matches.length} sessions for this run; stop the extra ones and retry`
                        : `Session did not start within ${Math.round(ISSUE_SPAWN_UNKNOWN_GRACE_MS / 1000)} s (${held.reason}); check the machine before retrying`);
                }
            } catch (error) {
                // Claim gone (lease expired → re-queued, or run superseded): the next claim decides again.
                if (httpCode(error) === 'issue_dispatch_claim_mismatch' || error instanceof IssuesUnsupportedError) unknownSpawns.delete(id);
                deps.log(`Issue dispatch ${id} remains pending${error instanceof IssueRequestError && error.code ? ` (${error.code})` : ''}`);
            }
        }
    }

    async function complete(receipt: IssueReceipt) {
        // A complete lost in transit would leave the agent's first issue_update unbound: retry briefly in place.
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await client.complete(receipt.dispatchId, { machineId: deps.machineId, claimId: receipt.claimId, sessionId: receipt.sessionId! });
                save({ ...receipt, phase: 'completed' });
                return;
            } catch (error) {
                lastError = error;
                if (httpCode(error) === 'issue_dispatch_claim_mismatch' || error instanceof IssuesUnsupportedError) break;
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
        throw lastError;
    }

    async function runSpawn(view: IssueDispatchView, receipt: IssueReceipt) {
        const spawn = view.spawn;
        if (receipt.phase === 'failed') { await fail(receipt, 'This dispatch already failed on this machine'); return; }
        if (!spawn) { await fail(receipt, 'Dispatch has no spawn payload'); return; }
        const agent = spawn.agent;
        if (receipt.phase === 'claimed') {
            if (!(ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(agent)) { await fail(receipt, `Agent "${agent}" cannot run issues on this machine`); return; }
            if (!isAbsolute(spawn.directory)) { await fail(receipt, `Directory must be absolute: ${spawn.directory}`); return; }
            const account = issueSpawnAccount(spawn);
            const refusal = issueAccountRefusal(deps.resolveAccount, agent, account);
            if (refusal) { await fail(receipt, refusal); return; }
            const mode = sanitizeSpawnPermissionMode(spawn.permissionMode ?? undefined);
            const permissionMode = resolveSpawnPermissionMode(agent, mode ?? undefined);
            const key = issueKeyFromPrompt(spawn.prompt);
            receipt = save({ ...receipt, phase: 'spawning' }); // BEFORE spawn: uncertainty never authorizes a second spawn
            const spawned = await deps.spawn({
                directory: spawn.directory, agent: agent as SpawnSessionOptions['agent'], permissionMode, spawnedBy: ISSUE_SPAWNED_BY,
                environmentVariables: { VH_ISSUE_ID: view.issueId, VH_ISSUE_RUN_ID: view.runId, ...(key ? { VH_ISSUE_KEY: key } : {}) },
                ...(account !== undefined ? { agentProfileId: account } : {}),
            });
            if (spawned.type === 'error' && agentProfileUnavailableReason(spawned.errorMessage)) {
                await fail({ ...receipt, phase: 'claimed' }, accountUnavailableError(spawned.errorMessage, 'issue') ?? spawned.errorMessage);
                return;
            }
            // B-874c: refused before any process existed (directory not creatable, env, agent) or the wrapper already exited — definite.
            if (spawned.type === 'error' && (spawned.startupExit?.exited || spawned.notStarted)) { await fail(receipt, `Session failed to start: ${spawned.errorMessage}`); return; }
            if (spawned.type === 'requestToApproveDirectoryCreation') { await fail(receipt, `Directory does not exist on this machine: ${spawn.directory}`); return; }
            if (spawned.type !== 'success') {
                // The wrapper may still be coming up: only a persisted session for this run is evidence either way.
                const matches = persistedRunSessions(view.runId);
                if (matches.length !== 1) { holdUnknown(view, receipt, spawned.errorMessage); return; }
                receipt = save({ ...receipt, sessionId: matches[0], phase: 'spawned' });
            } else {
                receipt = save({ ...receipt, sessionId: spawned.sessionId, phase: 'spawned' });
            }
        } else if (receipt.phase === 'spawning') {
            // Re-claimed after a restart mid-spawn: recover the session from its metadata, never spawn again.
            const matches = persistedRunSessions(view.runId);
            if (matches.length !== 1) { holdUnknown(view, receipt, 'the spawn was interrupted by a daemon restart'); return; }
            receipt = save({ ...receipt, sessionId: matches[0], phase: 'spawned' });
        } else {
            // Re-claimed past the spawn (spawned / delivered / completed): finish delivering and completing.
            if (receipt.sessionId && !receipt.ended) runBySession.set(receipt.sessionId, view.runId);
            await deliverAndComplete(view, receipt);
            return;
        }
        await afterSpawn(view, receipt);
    }

    /** A session exists for this run: track it, join the project, then first message + complete. */
    async function afterSpawn(view: IssueDispatchView, receipt: IssueReceipt) {
        runBySession.set(receipt.sessionId!, view.runId);
        const projectId = view.spawn?.projectId;
        if (projectId && deps.joinProject) await deps.joinProject(receipt.sessionId!, projectId).catch(() => undefined);
        await deliverAndComplete(view, receipt);
    }

    async function deliverAndComplete(view: IssueDispatchView, receipt: IssueReceipt) {
        const spawn = view.spawn!;
        const agent = spawn.agent;
        if (receipt.phase === 'spawned') {
            const sessionId = receipt.sessionId!;
            const mode = sanitizeSpawnPermissionMode(spawn.permissionMode ?? undefined);
            const permissionMode = resolveSpawnPermissionMode(agent, mode ?? undefined);
            const meta = resolveFirstMessageMeta({ agent, permissionMode, explicitModel: spawn.model ?? undefined, capabilities: capabilities(sessionId) });
            try {
                await send(sessionId, spawn.prompt, { localId: `${ISSUE_DISPATCH_LOCAL_ID_PREFIX}${view.id}`, sentFrom: ISSUE_SENT_FROM, ...meta });
            } catch (error) {
                await fail(receipt, `First message failed: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            receipt = save({ ...receipt, phase: 'delivered' });
        }
        if (receipt.phase === 'delivered' || receipt.phase === 'completed') {
            await complete(receipt);
            lastEvent.set(receipt.sessionId!, 'running');
        }
    }

    async function runMessage(view: IssueDispatchView, receipt: IssueReceipt) {
        const message = view.message;
        if (receipt.phase === 'failed') { await fail(receipt, 'Session is not running on this machine'); return; }
        if (!message) { await fail(receipt, 'Dispatch has no message payload'); return; }
        if (receipt.phase === 'claimed') {
            // §3.5: queued into the live session; a dead one fails and the server starts a new run.
            if (!deps.live(message.sessionId)) { await fail(receipt, 'Session is not running on this machine'); return; }
            try {
                await send(message.sessionId, message.text, { localId: `${ISSUE_DISPATCH_LOCAL_ID_PREFIX}${view.id}`, sentFrom: ISSUE_SENT_FROM });
            } catch (error) {
                await fail(receipt, `Message delivery failed: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            receipt = save({ ...receipt, sessionId: message.sessionId, phase: 'delivered' });
        }
        await complete({ ...receipt, sessionId: receipt.sessionId ?? message.sessionId });
    }

    async function execute(polled: IssueDispatchView) {
        let claimed: IssueDispatchView;
        try { claimed = (await client.claim(polled.id, deps.machineId)).dispatch; }
        catch (error) {
            // Another claimer won, or the run is no longer current: nothing to do here.
            const code = httpCode(error);
            if (code === 'issue_dispatch_claim_mismatch' || code === 'issue_run_not_current' || code === 'issue_dispatch_not_found') return;
            throw error;
        }
        if (!claimed.claimId) throw new Error('Dispatch claim did not return a claim id');
        const prior = readIssueReceipt(home, claimed.id);
        // A re-claim (lease expired / daemon restarted) keeps the local phase and takes the new claim id.
        const receipt = save(prior
            ? { ...prior, claimId: claimed.claimId }
            : { dispatchId: claimed.id, kind: claimed.kind === 'message' ? 'message' : 'spawn', runId: claimed.runId, issueId: claimed.issueId, claimId: claimed.claimId, phase: 'claimed', updatedAt: Date.now() });
        if (claimed.kind === 'message') await runMessage(claimed, receipt);
        else if (claimed.kind === 'spawn') await runSpawn(claimed, receipt);
        else await fail(receipt, `Unknown dispatch kind "${claimed.kind}"`);
    }

    let flushing = false;
    async function flushEvents() {
        if (flushing) return;
        flushing = true;
        try { await drainEvents(); } finally { flushing = false; }
    }
    async function drainEvents() {
        while (events.length && !closed) {
            const next = events[0];
            try {
                await client.sessionEvent(next.runId, { machineId: deps.machineId, sessionId: next.sessionId, event: next.event });
            } catch (error) {
                const code = httpCode(error);
                if (!(error instanceof IssuesUnsupportedError) && code !== 'issue_run_not_found' && !(error instanceof IssueRequestError && error.status < 500 && error.status !== 429)) return; // retried next tick
            }
            events.shift();
            if (next.event === 'exited' || next.event === 'crashed') {
                runBySession.delete(next.sessionId);
                lastEvent.delete(next.sessionId);
                for (const r of listIssueReceipts(home)) if (r.sessionId === next.sessionId && r.kind === 'spawn') save({ ...r, ended: true });
            }
        }
    }

    async function tick() {
        if (running || closed || Date.now() < retryAt) return;
        running = true;
        try {
            await recheckUnknown();
            let dispatches: IssueDispatchView[];
            try { dispatches = (await client.poll(deps.machineId)).dispatches ?? []; }
            catch (error) {
                // Unsupported: the client already backs off 10 minutes (≤1 request per window). Other errors: 30 s.
                if (!(error instanceof IssuesUnsupportedError)) { retryAt = Date.now() + 30_000; deps.log(`Issue dispatch poll unavailable${error instanceof IssueRequestError ? ` (${error.status}${error.code ? ` ${error.code}` : ''})` : ''}`); }
                return;
            }
            for (const dispatch of dispatches) {
                if (closed) break;
                // Never log dispatch payloads (issue text is plaintext).
                try { await execute(dispatch); } catch (error) { deps.log(`Issue dispatch ${dispatch.id} remains pending${error instanceof IssueRequestError && error.code ? ` (${error.code})` : ''}`); }
            }
            await flushEvents();
        } finally { running = false; }
    }

    let timer: NodeJS.Timeout | undefined;
    if (deps.autoStart !== false) {
        timer = setInterval(() => { void tick(); }, ISSUE_POLL_MS);
        timer.unref();
        void tick();
    }

    return {
        tick,
        hasSession: (sessionId: string) => runBySession.has(sessionId),
        /** Daemon hooks (turn start/end, wrapper exit) → run session event; deduplicated per session. */
        report(sessionId: string, event: SessionEvent) {
            const runId = runBySession.get(sessionId);
            if (!runId || closed || lastEvent.get(sessionId) === event) return;
            lastEvent.set(sessionId, event);
            events.push({ sessionId, runId, event });
            if (events.length > 500) events.splice(0, events.length - 500);
            void flushEvents();
        },
        get busy() { return running; },
        stop: () => { closed = true; if (timer) clearInterval(timer); },
    };
}
