import axios from 'axios';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import type { TeamOperation, TeamState, TeamResponse, TeamAction } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readPersistedSessions } from '@/persistence';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { teamInitialPrompt } from './initialPrompt';
import { archiveSession } from '@/sessions/sessionOps';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { readReceipt, writeReceipt, type TeamEffectReceipt } from './journal';
import { prepareTeamWorktree, removeTeamWorktree, resolveTeamRepository } from './worktree';
import { afterStartupFailure, consumeOwnerRetry, ownerRetryPending, spawnGate, startupFailureMessage, TEAM_CLEANUP_RETRY_MS, TEAM_SPAWN_MAX_ATTEMPTS } from './spawnRetry';

export interface TeamWorkerDeps {
    machineId: string;
    token: string;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopAndWait: (sessionId: string) => Promise<void>;
    live: (sessionId: string) => boolean;
    log: (message: string) => void;
    home?: string;
    serverUrl?: string;
}

function persistedSpawnMatches(operationId: string) {
    return Object.entries(readPersistedSessions()).filter(([, entry]) => entry.metadata?.teamOperationId === operationId);
}

/** A daemon-owned effect runner. Server owns state; the local receipt only fences OS side effects. */
export function createTeamWorker(deps: TeamWorkerDeps) {
    const home = deps.home ?? configuration.happyHomeDir;
    const server = deps.serverUrl ?? configuration.serverUrl;
    const http = axios.create({ baseURL: server, timeout: 20_000, headers: { Authorization: `Bearer ${deps.token}` } });
    let running = false;
    let closed = false;
    let disabledUntil = 0;
    let knownSessionIds = new Set<string>();
    const action = async (teamId: string, requestId: string, value: TeamAction): Promise<TeamResponse> =>
        (await http.post(`/v1/teams/${encodeURIComponent(teamId)}/actions`, { requestId, action: value })).data;

    async function complete(op: TeamOperation, receipt: TeamEffectReceipt) {
        await action(op.teamId, `complete-${op.id}`, { type: 'complete-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}), ...(op.type === 'spawn' && receipt.directory ? { workingDirectory: receipt.directory } : {}) });
        writeReceipt(home, { ...receipt, phase: 'completed' });
    }

    async function execute(op: TeamOperation) {
        let receipt = readReceipt(home, op.id);
        let credential: TeamResponse['credential'];
        if (!receipt) {
            // A claimed operation with no local receipt may have executed on a previous installation.
            // Only a pending operation is safe to claim and start here.
            if (op.status !== 'pending') {
                if (op.status === 'claimed' && op.claimId) {
                    await action(op.teamId, `missing-receipt-${op.id}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: op.claimId, error: 'Local execution receipt missing; verify the old process before manual reconciliation', unknown: true });
                }
                return;
            }
            const claimed = await action(op.teamId, `claim-${op.id}`, { type: 'claim-operation', operationId: op.id, machineId: deps.machineId, ...(op.teamLaunchVersion === 1 ? { teamLaunchVersion: 1 as const } : {}) });
            if (!claimed.operation?.claimId) throw new Error('Operation claim did not return a receipt');
            op = claimed.operation;
            credential = claimed.credential;
            receipt = { operationId: op.id, teamId: op.teamId, claimId: op.claimId!, phase: 'prepared' };
            writeReceipt(home, receipt);
        }
        if (receipt.phase === 'completed') return;
        try {
            if (op.type === 'spawn') {
                // B-689: the owner's「重试启动」. For an uncertain spawn the owner has confirmed
                // the old process is gone; a wrapper that DID report for this op still wins.
                if (ownerRetryPending(op, receipt) && (receipt.phase === 'prepared' || (receipt.phase === 'spawning' && persistedSpawnMatches(op.id).length === 0))) {
                    receipt = consumeOwnerRetry(op, receipt);
                    writeReceipt(home, receipt);
                    deps.log(`Teams operation ${op.id} relaunch requested by owner`);
                }
                if (receipt.phase === 'prepared' && spawnGate(receipt, Date.now()) !== 'run') return;
                if (receipt.phase === 'prepared') {
                    // Retrying a prepared receipt is safe: spawning has not begun. Re-read the same
                    // claim response to recover the credential if this daemon restarted.
                    if (!credential) credential = (await action(op.teamId, `claim-${op.id}`, { type: 'claim-operation', operationId: op.id, machineId: deps.machineId, ...(op.teamLaunchVersion === 1 ? { teamLaunchVersion: 1 as const } : {}) })).credential;
                    if (!credential) throw new Error('No scoped credential for worker');
                    const current: TeamState = (await http.get(`/v1/teams/${encodeURIComponent(op.teamId)}`)).data.team;
                    const task = current.tasks.find(t => t.id === op.taskId);
                    if (!task) throw new Error('Task state unavailable; refusing to start');
                    if (task.currentAttemptId !== op.attemptId || ['done', 'cancelled'].includes(task.status)) {
                        await action(op.teamId, `cancelled-before-spawn-${op.id}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, error: 'task_closed_before_spawn' });
                        writeReceipt(home, { ...receipt, phase: 'completed' });
                        return;
                    }
                    if (!op.directory) throw new Error('No repository selected for worker');
                    let resource: Awaited<ReturnType<typeof prepareTeamWorktree>>;
                    try {
                        // B-706: reactivating a bot must never reuse its removed worktree path.
                        const repository = await resolveTeamRepository(home, op.directory, id => { try { return readReceipt(home, id)?.repository; } catch { return undefined; } });
                        resource = await prepareTeamWorktree(home, repository, op.id);
                    } catch (error) {
                        // A preflight failure is definite (nothing was spawned): report the cause and
                        // back off like a startup failure instead of failing again on every poll.
                        const now = Date.now();
                        receipt = afterStartupFailure(receipt, now);
                        writeReceipt(home, receipt);
                        const detail = error instanceof Error ? error.message : 'Team worktree could not be prepared';
                        await action(op.teamId, `preflight-failure-${op.id}-${receipt.retryConsumed ?? 0}-${receipt.spawnFailures}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, error: startupFailureMessage(detail, receipt, now).slice(0, 1000) }).catch(() => {});
                        deps.log(`Teams operation ${op.id} preflight failed (${receipt.spawnFailures}/${TEAM_SPAWN_MAX_ATTEMPTS})`);
                        return;
                    }
                    const scopes = join(home, 'teams', 'scopes');
                    ensurePrivateDirectorySync(scopes);
                    const scopeFile = join(scopes, `${op.id}.json`);
                    writePrivateFileSync(scopeFile, JSON.stringify({ serverUrl: server, scopeToken: credential.token, teamId: op.teamId, botId: op.botId, taskId: op.taskId, attemptId: op.attemptId }));
                    receipt = { ...receipt, ...resource, scopeFile, phase: 'spawning' };
                    writeReceipt(home, receipt); // BEFORE spawn; uncertainty never authorizes a second spawn
                    const spawned = await deps.spawn({ directory: resource.directory, agent: op.assistant === 'pi-acp' ? 'pi' : op.assistant, permissionMode: op.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default', spawnedBy: 'teams', environmentVariables: { VH_TEAM_SCOPE_FILE: scopeFile, VH_TEAM_OPERATION_ID: op.id } });
                    if (spawned.type === 'error' && spawned.startupExit?.exited) {
                        // B-689: the wrapper is confirmed gone — a definite failure, not an
                        // uncertain spawn. Back to `prepared` with a backed-off relaunch.
                        const now = Date.now();
                        receipt = afterStartupFailure(receipt, now);
                        writeReceipt(home, receipt);
                        await action(op.teamId, `startup-failure-${op.id}-${receipt.retryConsumed ?? 0}-${receipt.spawnFailures}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, error: startupFailureMessage(spawned.errorMessage, receipt, now).slice(0, 1000) }).catch(() => {});
                        deps.log(`Teams operation ${op.id} startup failed (${receipt.spawnFailures}/${TEAM_SPAWN_MAX_ATTEMPTS}); ${receipt.retryAt !== undefined ? 'will relaunch' : 'waiting for owner retry'}`);
                        return;
                    }
                    if (spawned.type !== 'success') throw new Error(spawned.type === 'error' ? spawned.errorMessage : 'Directory approval required');
                    receipt = { ...receipt, sessionId: spawned.sessionId, phase: 'spawned' };
                    writeReceipt(home, receipt);
                }
                if (receipt.phase === 'spawning') {
                    // The wrapper registers metadata + key before spawn completes. A persisted exact
                    // correlation is positive evidence, while absence is NOT evidence of failure.
                    const matches = persistedSpawnMatches(op.id);
                    if (matches.length !== 1) throw new Error('Spawn outcome unknown; reconcile the worker before retrying');
                    receipt = { ...receipt, sessionId: matches[0][0], phase: 'spawned' };
                    writeReceipt(home, receipt);
                }
                if (receipt.phase === 'spawned') {
                    const current: TeamState = (await http.get(`/v1/teams/${encodeURIComponent(op.teamId)}`)).data.team;
                    const task = current.tasks.find(t => t.id === op.taskId);
                    const bot = current.bots.find(b => b.id === op.botId);
                    const active = task?.currentAttemptId === op.attemptId && !['done', 'cancelled'].includes(task.status) && bot?.generation === op.generation;
                    if (!active) {
                        // A late wrapper must never receive the withdrawn task. Stop it first;
                        // then report the known session so the server can retain cleanup work.
                        await deps.stopAndWait(receipt.sessionId!);
                        await complete(op, receipt);
                        return;
                    }
                    const key = await waitForSessionKey(receipt.sessionId!, 10_000);
                    await sendUserMessage(receipt.sessionId!, key, teamInitialPrompt(op.prompt, bot?.root === true, receipt.directory), 'teams', { localId: `teams-initial-${op.id}`, sentFrom: 'team', ...(op.model ? { model: op.model } : {}) });
                    receipt = { ...receipt, phase: 'delivered' };
                    writeReceipt(home, receipt);
                }
                await complete(op, receipt);
            } else {
                // B-691: a retained cleanup is re-checked every few minutes (it used to
                // stop/archive/inspect every 5 s, ~2000 times a week per entry), and at
                // once when the owner chooses「重试清理」.
                if (ownerRetryPending(op, receipt)) {
                    const { retryAt: _retryAt, ...rest } = receipt;
                    receipt = { ...rest, retryConsumed: op.retryRequestedAt };
                    writeReceipt(home, receipt);
                    deps.log(`Teams operation ${op.id} cleanup retry requested by owner`);
                } else if (receipt.retryAt !== undefined && Date.now() < receipt.retryAt) return;
                const team: TeamState = (await http.get(`/v1/teams/${encodeURIComponent(op.teamId)}`)).data.team;
                const latest = team.operations.find(candidate => candidate.id === op.id);
                if (latest?.status === 'completed') { writeReceipt(home, { ...receipt, phase: 'completed' }); return; }
                const bot = team.bots.find(candidate => candidate.id === op.botId);
                if (!bot || bot.generation !== op.generation || bot.sessionId !== op.sessionId) throw new Error('Worker binding changed; preserve resources for reconciliation');
                if (op.sessionId) {
                    await deps.stopAndWait(op.sessionId);
                    await archiveSession(op.sessionId);
                }
                // Archiving hides a team, it never authorizes deleting its worktrees.
                if (team.archivedAt !== undefined) { await complete(op, receipt); return; }
                // Cleanup targets the exact wrapper's original resource receipt, never arbitrary paths.
                // A return creates a new attempt while keeping the same wrapper/worktree.
                // Resource ownership follows that exact binding, not the latest attempt id.
                const origins = team.operations.filter(candidate => candidate.type === 'spawn' && candidate.botId === op.botId && candidate.generation === op.generation && candidate.sessionId === op.sessionId);
                if (origins.length !== 1) throw new Error('Original worktree ownership is unknown; manual reconciliation required');
                const resource = readReceipt(home, origins[0].id);
                if (!resource?.directory || !resource.repository || !resource.branch) throw new Error('Original worktree receipt is missing; manual reconciliation required');
                await removeTeamWorktree(resource);
                await complete(op, receipt);
            }
        } catch (error) {
            const unknown = op.type === 'spawn' && receipt.phase === 'spawning';
            // Keep the receipt and claim: a subsequent pass can recover partial spawn/message/cleanup.
            const detail = error instanceof Error ? error.message : 'Team operation failed';
            if (op.type === 'stop') {
                receipt = { ...receipt, retryAt: Date.now() + TEAM_CLEANUP_RETRY_MS };
                try { writeReceipt(home, receipt); } catch { /* retried on the next pass */ }
            }
            // B-691: one request per distinct reason, so a changed reason (e.g. the owner
            // pushed but left a file) replaces the stale one instead of replaying it.
            await action(op.teamId, `failure-${op.id}-${receipt.phase}-${createHash('sha256').update(detail).digest('hex').slice(0, 12)}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, error: detail.slice(0, 1000), unknown }).catch(() => {});
            deps.log(`Teams operation ${op.id} ${unknown ? 'needs reconciliation' : 'will retry'}`);
        }
    }

    async function deliver(team: TeamState) {
        for (const message of team.messages) {
            if (closed || message.deliveredAt !== null || message.cancelledAt !== undefined) continue;
            const bot = team.bots.find(b => b.id === message.recipientBotId);
            // Do not deliver into a dead session and call it consumed; leave it pending for rebind.
            if (!bot?.sessionId || !deps.live(bot.sessionId)) continue;
            try {
                const key = await waitForSessionKey(bot.sessionId, 0);
                if (message.scheduleId) {
                    // Pause/cancel can race the poll snapshot. Re-check immediately before sending;
                    // a request already in flight still cannot be recalled from the session queue.
                    const current: TeamState = (await http.get(`/v1/teams/${encodeURIComponent(team.id)}`)).data.team;
                    const pending = current.messages.find(m => m.id === message.id);
                    const binding = current.bots.find(b => b.id === bot.id);
                    if (!pending || pending.cancelledAt !== undefined || pending.deliveredAt !== null || binding?.generation !== bot.generation || binding.sessionId !== bot.sessionId) continue;
                }
                const sender = message.source === 'system' ? 'System' : message.senderBotId ? team.bots.find(b => b.id === message.senderBotId)?.name ?? 'teammate' : 'Owner';
                const body = `[Very Happy team message ${message.id}; ${message.scheduleId ? `schedule ${message.scheduleId}` : `task ${message.taskId}`}; from ${sender}]\n${message.body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
                await sendUserMessage(bot.sessionId, key, body, 'teams', { localId: `teams-message-${message.id}-${bot.generation}`, sentFrom: 'team' });
                await action(team.id, `delivered-${message.id}-${bot.generation}`, { type: 'message-delivered', messageId: message.id, recipientBotId: bot.id, generation: bot.generation, sessionId: bot.sessionId });
            } catch { deps.log(`Teams message ${message.id} remains pending`); }
        }
    }

    const eventDir = join(home, 'teams', 'events');
    function report(sessionId: string, event: 'idle' | 'blocked' | 'exited') {
        if (closed) return;
        try {
            ensurePrivateDirectorySync(eventDir);
            const id = randomUUID();
            writePrivateFileSync(join(eventDir, `${id}.json`), JSON.stringify({ id, sessionId, event, createdAt: Date.now() }));
        } catch { deps.log('Teams event could not be persisted'); }
    }
    async function flushEvents(teams: TeamState[]) {
        let files: string[];
        try { files = readdirSync(eventDir); } catch { return; }
        for (const file of files) {
            if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
            const path = join(eventDir, file);
            try {
                const event = JSON.parse(readFileSync(path, 'utf8'));
                const team = teams.find(t => t.bots.some(b => b.sessionId === event.sessionId));
                if (!team) {
                    // The successful full machine snapshot proves this binding is retired.
                    // Keep a short window for a spawn whose server acknowledgement is in flight.
                    if (typeof event.createdAt === 'number' && Date.now() - event.createdAt > 60_000) unlinkSync(path);
                    continue;
                }
                await action(team.id, event.id, { type: 'session-event', sessionId: event.sessionId, event: event.event });
                unlinkSync(path);
            } catch { /* preserved for reconciliation */ }
        }
    }

    async function tick() {
        if (running || closed || Date.now() < disabledUntil) return;
        running = true;
        try {
            try {
                await http.post('/v1/teams/schedules/tick', { machineId: deps.machineId });
            } catch (error) {
                // Older servers do not have schedules; ordinary Teams must keep working.
                const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                if (status !== 404) deps.log('Teams schedule advancement unavailable; regular reconciliation continues');
            }
            const { data } = await http.get<{ operations: TeamOperation[]; teams: TeamState[] }>('/v1/teams/operations', { params: { machineId: deps.machineId, schedulesVersion: 1, teamLaunchVersion: 1, teamArchiveVersion: 1 } });
            knownSessionIds = new Set((data.teams ?? []).flatMap(team => team.bots.flatMap(bot => bot.sessionId ? [bot.sessionId] : [])));
            // Limit simultaneous launch IO; a running model does not occupy this polling slot.
            for (const op of data.operations) {
                if (closed) break;
                try { await execute(op); } catch { deps.log(`Teams operation ${op.id} remains pending`); }
            }
            await flushEvents(data.teams ?? []);
            for (const team of data.teams ?? []) await deliver(team);
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            disabledUntil = Date.now() + (status === 404 || status === 403 ? 60_000 : 10_000);
            // Never log Axios config/headers or response bodies (may contain scoped credentials).
            if (status !== 404 && status !== 403) deps.log(`Teams reconciliation unavailable${status ? ` (${status})` : ''}`);
        } finally { running = false; }
    }
    const timer = setInterval(() => { void tick(); }, 5_000);
    timer.unref();
    void tick();
    /**
     * B-730: rebuild a relaunched member's missing scope file. Replaying this
     * daemon's own claim request returns the bot's current credential; only an
     * unchanged binding (same session, same generation, live team) qualifies.
     */
    async function recoverScope(operationId: string, sessionId: string, scopeFile: string): Promise<void> {
        const teams: TeamState[] = (await http.get('/v1/teams')).data.teams ?? [];
        const team = teams.find(candidate => candidate.archivedAt === undefined && candidate.operations.some(op => op.id === operationId));
        const op = team?.operations.find(candidate => candidate.id === operationId);
        if (!team || !op || op.type !== 'spawn' || op.machineId !== deps.machineId) throw new Error('No live team launch for this session');
        const bot = team.bots.find(candidate => candidate.id === op.botId);
        if (!bot || bot.sessionId !== sessionId || bot.generation !== op.generation) throw new Error('Team binding changed; not restoring its scope');
        const claimed = await action(op.teamId, `claim-${op.id}`, { type: 'claim-operation', operationId: op.id, machineId: deps.machineId, ...(op.teamLaunchVersion === 1 ? { teamLaunchVersion: 1 as const } : {}) });
        if (!claimed.credential?.token || claimed.credential.botId !== op.botId) throw new Error('Team did not reissue the member credential');
        ensurePrivateDirectorySync(join(home, 'teams', 'scopes'));
        writePrivateFileSync(scopeFile, JSON.stringify({ serverUrl: server, scopeToken: claimed.credential.token, teamId: op.teamId, botId: op.botId, taskId: op.taskId, attemptId: op.attemptId }));
    }
    return { tick, report, recoverScope, hasSession: (id: string) => knownSessionIds.has(id), get busy() { return running; }, stop: () => { closed = true; clearInterval(timer); } };
}
