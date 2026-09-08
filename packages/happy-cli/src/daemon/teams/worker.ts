import axios from 'axios';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import type { TeamOperation, TeamState, TeamResponse, TeamAction } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readPersistedSessions } from '@/persistence';
import { sendUserMessage, waitForSessionKey } from '@/commands/sessionMessage';
import { archiveSession } from '@/sessions/sessionOps';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { readReceipt, writeReceipt, type TeamEffectReceipt } from './journal';
import { prepareTeamWorktree, removeTeamWorktree } from './worktree';

export interface TeamWorkerDeps {
    machineId: string;
    token: string;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stop: (sessionId: string) => boolean;
    live: (sessionId: string) => boolean;
    log: (message: string) => void;
    home?: string;
    serverUrl?: string;
}

/** A daemon-owned effect runner. Server owns state; the local receipt only fences OS side effects. */
export function createTeamWorker(deps: TeamWorkerDeps) {
    const home = deps.home ?? configuration.happyHomeDir;
    const server = deps.serverUrl ?? configuration.serverUrl;
    const http = axios.create({ baseURL: server, timeout: 20_000, headers: { Authorization: `Bearer ${deps.token}` } });
    let running = false;
    let closed = false;
    let disabledUntil = 0;
    const action = async (teamId: string, requestId: string, value: TeamAction): Promise<TeamResponse> =>
        (await http.post(`/v1/teams/${encodeURIComponent(teamId)}/actions`, { requestId, action: value })).data;

    async function complete(op: TeamOperation, receipt: TeamEffectReceipt) {
        await action(op.teamId, `complete-${op.id}`, { type: 'complete-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}) });
        writeReceipt(home, { ...receipt, phase: 'completed' });
    }

    async function execute(op: TeamOperation) {
        let receipt = readReceipt(home, op.id);
        let credential: TeamResponse['credential'];
        if (!receipt) {
            // A claimed operation with no local receipt may have executed on a previous installation.
            // Only a pending operation is safe to claim and start here.
            if (op.status !== 'pending') return;
            const claimed = await action(op.teamId, `claim-${op.id}`, { type: 'claim-operation', operationId: op.id, machineId: deps.machineId });
            if (!claimed.operation?.claimId) throw new Error('Operation claim did not return a receipt');
            op = claimed.operation;
            credential = claimed.credential;
            receipt = { operationId: op.id, teamId: op.teamId, claimId: op.claimId!, phase: 'prepared' };
            writeReceipt(home, receipt);
        }
        if (receipt.phase === 'completed') return;
        try {
            if (op.type === 'spawn') {
                if (receipt.phase === 'prepared') {
                    // Retrying a prepared receipt is safe: spawning has not begun. Re-read the same
                    // claim response to recover the credential if this daemon restarted.
                    if (!credential) credential = (await action(op.teamId, `claim-${op.id}`, { type: 'claim-operation', operationId: op.id, machineId: deps.machineId })).credential;
                    if (!credential) throw new Error('No scoped credential for worker');
                    if (!op.directory) throw new Error('No repository selected for worker');
                    const resource = await prepareTeamWorktree(home, op.directory, op.id);
                    const scopes = join(home, 'teams', 'scopes');
                    ensurePrivateDirectorySync(scopes);
                    const scopeFile = join(scopes, `${op.id}.json`);
                    writePrivateFileSync(scopeFile, JSON.stringify({ serverUrl: server, scopeToken: credential.token, teamId: op.teamId, botId: op.botId, taskId: op.taskId, attemptId: op.attemptId }));
                    receipt = { ...receipt, ...resource, scopeFile, phase: 'spawning' };
                    writeReceipt(home, receipt); // BEFORE spawn; uncertainty never authorizes a second spawn
                    const spawned = await deps.spawn({ directory: resource.directory, agent: op.assistant === 'pi-acp' ? 'pi' : op.assistant, permissionMode: 'default', spawnedBy: 'teams', environmentVariables: { VH_TEAM_SCOPE_FILE: scopeFile, VH_TEAM_OPERATION_ID: op.id } });
                    if (spawned.type !== 'success') throw new Error(spawned.type === 'error' ? spawned.errorMessage : 'Directory approval required');
                    receipt = { ...receipt, sessionId: spawned.sessionId, phase: 'spawned' };
                    writeReceipt(home, receipt);
                }
                if (receipt.phase === 'spawning') {
                    // The wrapper registers metadata + key before spawn completes. A persisted exact
                    // correlation is positive evidence, while absence is NOT evidence of failure.
                    const matches = Object.entries(readPersistedSessions()).filter(([, entry]) => entry.metadata?.teamOperationId === op.id);
                    if (matches.length !== 1) throw new Error('Spawn outcome unknown; reconcile the worker before retrying');
                    receipt = { ...receipt, sessionId: matches[0][0], phase: 'spawned' };
                    writeReceipt(home, receipt);
                }
                if (receipt.phase === 'spawned') {
                    const key = await waitForSessionKey(receipt.sessionId!, 10_000);
                    await sendUserMessage(receipt.sessionId!, key, op.prompt, 'teams', { localId: `teams-initial-${op.id}`, sentFrom: 'team' });
                    receipt = { ...receipt, phase: 'delivered' };
                    writeReceipt(home, receipt);
                }
                await complete(op, receipt);
            } else {
                if (op.sessionId) {
                    if (deps.live(op.sessionId)) {
                        deps.stop(op.sessionId);
                        const deadline = Date.now() + 15_000;
                        while (deps.live(op.sessionId) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
                        if (deps.live(op.sessionId)) throw new Error('Worker is still running; cleanup retained for retry');
                    }
                    await archiveSession(op.sessionId);
                }
                // Cleanup targets the spawn receipt belonging to this attempt, never arbitrary paths.
                const team: TeamState = (await http.get(`/v1/teams/${encodeURIComponent(op.teamId)}`)).data.team;
                const spawned = team.operations.find(candidate => candidate.type === 'spawn' && candidate.attemptId === op.attemptId);
                if (spawned) {
                    const resource = readReceipt(home, spawned.id);
                    if (resource) await removeTeamWorktree(resource);
                }
                await complete(op, receipt);
            }
        } catch (error) {
            const unknown = op.type === 'spawn' && receipt.phase === 'spawning';
            // Keep the receipt and claim: a subsequent pass can recover partial spawn/message/cleanup.
            const detail = error instanceof Error ? error.message : 'Team operation failed';
            await action(op.teamId, `failure-${op.id}-${receipt.phase}`, { type: 'fail-operation', operationId: op.id, machineId: deps.machineId, claimId: receipt.claimId, error: detail.slice(0, 1000), unknown }).catch(() => {});
            deps.log(`Teams operation ${op.id} ${unknown ? 'needs reconciliation' : 'will retry'}`);
        }
    }

    async function deliver(team: TeamState) {
        for (const message of team.messages) {
            if (closed || message.deliveredAt !== null) continue;
            const bot = team.bots.find(b => b.id === message.recipientBotId);
            // Do not deliver into a dead session and call it consumed; leave it pending for rebind.
            if (!bot?.sessionId || !deps.live(bot.sessionId)) continue;
            try {
                const key = await waitForSessionKey(bot.sessionId, 0);
                const sender = message.source === 'system' ? 'System' : message.senderBotId ? team.bots.find(b => b.id === message.senderBotId)?.name ?? 'teammate' : 'Owner';
                const body = `[Very Happy team message ${message.id}; task ${message.taskId}; from ${sender}]\n${message.body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
                await sendUserMessage(bot.sessionId, key, body, 'teams', { localId: `teams-message-${message.id}-${bot.generation}`, sentFrom: 'team' });
                await action(team.id, `delivered-${message.id}-${bot.generation}`, { type: 'message-delivered', messageId: message.id });
            } catch { deps.log(`Teams message ${message.id} remains pending`); }
        }
    }

    const eventDir = join(home, 'teams', 'events');
    function report(sessionId: string, event: 'idle' | 'blocked' | 'exited') {
        if (closed) return;
        try {
            ensurePrivateDirectorySync(eventDir);
            const id = randomUUID();
            writePrivateFileSync(join(eventDir, `${id}.json`), JSON.stringify({ id, sessionId, event }));
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
                if (!team) continue;
                await action(team.id, event.id, { type: 'session-event', sessionId: event.sessionId, event: event.event });
                unlinkSync(path);
            } catch { /* preserved for reconciliation */ }
        }
    }

    async function tick() {
        if (running || closed || Date.now() < disabledUntil) return;
        running = true;
        try {
            const { data } = await http.get<{ operations: TeamOperation[]; teams: TeamState[] }>('/v1/teams/operations', { params: { machineId: deps.machineId } });
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
    return { tick, report, get busy() { return running; }, stop: () => { closed = true; clearInterval(timer); } };
}
