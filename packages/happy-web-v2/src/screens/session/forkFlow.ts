import { apiSocket } from '@/sync/apiSocket';
import { withRunPicks } from '@/sync/runPicks';
import { machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
import type { ForkSource } from '@/utils/sessionFork';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { isHeartbeatFresh } from '@/sync/heartbeatLease';
import { forkFailureKind, forkPrefill, resolveForkPoint, sessionForkBlock, type ForkPoint, type ForkReason } from './forkModel';
import { getRewindTarget, rewindPermissionMode, type RewindTarget } from './messageActionsModel';
import { createCompletedTurnsFork, createRewindBranch, createSessionFork } from './rewindOperation';

/**
 * B-851: 「分叉会话」 (header ⋯) and 「从这里分叉」 (a prompt's actions).
 * Both run on the machine that owns the session and open a NEW session with
 * the same machine, directory, agent, permission mode, model and effort; the
 * source session is never touched. Lineage (`parentSessionId`,
 * `forkedFromMessageId`) rides the spawn into the new session's metadata.
 */
export type ForkFailureKind = ReturnType<typeof forkFailureKind> | 'missingPoint' | 'noHistory';
export class ForkFailure extends Error {
    constructor(public readonly kind: ForkFailureKind, message: string) {
        super(message);
        this.name = 'ForkFailure';
    }
}

type RpcResult = { type?: string; error?: string; errorMessage?: string; points?: { uuid?: string; itemId?: string; text?: string }[] } | null;
const rpc = (machineId: string, method: string, args: Record<string, string>) =>
    apiSocket.machineRPC<unknown, Record<string, string>>(machineId, method, args, { timeoutMs: 30_000 });
const deps = {
    rpc,
    spawn: machineSpawnNewSession,
    rememberMode: (sessionId: string, mode: string) => storage.getState().updateSessionPermissionMode(sessionId, mode),
};

function machineOnline(machineId: string): boolean {
    return storage.getState().machines[machineId]?.active === true;
}

/**
 * Read at click time: a fork is the user's explicit act, not a live status to
 * subscribe to. B-860: it only picks what a whole-session fork keeps (the
 * completed turns) and the notice — it never blocks a fork.
 */
export function sessionRunningNow(session: Session): boolean {
    return isAgentWorkLive({ presence: session.presence, thinking: session.thinking, runningSubagentsInTurn: 0, heartbeatFresh: isHeartbeatFresh(session.id) });
}

/**
 * Why 「从这里分叉」 cannot start for this prompt, or what to cut. Allowed
 * while a turn runs (B-860): an earlier prompt cuts inside the completed
 * turns; the running prompt cuts before itself and is prefilled, as when idle.
 */
export function messageForkTarget(session: Session, message: UserTextMessage, hasAttachments: boolean): RewindTarget | ForkReason {
    const state = sessionForkBlock(session, { machineOnline: machineOnline(session.metadata?.machineId ?? '') });
    if (typeof state === 'string') return state;
    return getRewindTarget(session, message, hasAttachments);
}

function classify(source: ForkSource, error: unknown): ForkFailure {
    if (error instanceof ForkFailure) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ForkFailure(forkFailureKind(message, machineOnline(source.machineId)), message);
}

function parentPermissionMode(session: Session, kind: ForkSource['kind']): string {
    return rewindPermissionMode(kind, session.permissionMode ?? session.metadata?.permissionMode ?? null);
}

/** Model and effort are per-session local choices: copy them once the new row is in the store. */
async function settle(parent: Session, newId: string, draft?: string): Promise<void> {
    if (draft) storage.getState().updateSessionDraft(newId, draft);
    try { await sync.refreshSessions(); } catch { /* the update stream hydrates it shortly */ }
    const state = storage.getState();
    // B-849b: the parent's own choice (its recorded intent, not just this device's pick).
    const picks = withRunPicks(parent);
    if (picks.modelMode) state.updateSessionModelMode(newId, picks.modelMode);
    if (picks.effortLevel) state.updateSessionEffortLevel(newId, picks.effortLevel);
}

/**
 * `partial`: the session was mid-turn, so the fork holds its completed turns
 * only (B-860); `prefilled`: that turn's message waits in the new composer.
 */
export type WholeFork = { id: string; partial: boolean; prefilled: boolean };

/**
 * `draft` (B-861, side chat 「转成分叉会话」) replaces the running turn's
 * prefill: the user's next step is the side question, while the running
 * prompt keeps running in the source session.
 */
export async function forkWholeSession(parent: Session, source: ForkSource, running: boolean, draft?: string): Promise<WholeFork> {
    try {
        const mode = parentPermissionMode(parent, source.kind);
        if (!running) {
            const id = await createSessionFork(source, mode, deps);
            await settle(parent, id, draft);
            return { id, partial: false, prefilled: false };
        }
        const fork = await createCompletedTurnsFork(source, mode, deps);
        if (fork === 'noCompletedTurn') throw new ForkFailure('noHistory', 'The running turn is the first one');
        const prefill = draft ?? forkPrefill(fork.excludedPrompts, confirmedPrompts(source.sessionId));
        await settle(parent, fork.sessionId, prefill);
        return { id: fork.sessionId, partial: fork.excludedPrompts.length > 0, prefilled: draft === undefined && prefill.length > 0 };
    } catch (error) {
        throw classify(source, error);
    }
}

/** Server-confirmed prompts of the session, oldest first (what the agent saw, in order). */
function confirmedPrompts(sessionId: string): { id: string; text: string }[] {
    return (storage.getState().sessionMessages[sessionId]?.messages ?? [])
        .filter((m): m is UserTextMessage => m.kind === 'user-text' && typeof m.seq === 'number' && !m.inputState && !m.cancelReason)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((m) => ({ id: m.id, text: m.text }));
}

/** Prompts sent from the Web carry no claude uuid / codex item id: ask the machine's transcript. */
async function findPoint(target: RewindTarget): Promise<string> {
    if (target.pointId) return target.pointId;
    const { source } = target;
    const response = await rpc(source.machineId, source.kind === 'claude' ? 'claude-list-rewind-points' : 'codex-list-rewind-points', source.kind === 'claude'
        ? { directory: source.directory, claudeSessionId: source.claudeSessionId }
        : { directory: source.directory, codexThreadId: source.codexThreadId }) as RpcResult;
    if (!response || response.error || response.type !== 'success' || !Array.isArray(response.points)) {
        throw new Error(response?.error || response?.errorMessage || 'Invalid rewind points response');
    }
    const points: ForkPoint[] = response.points.flatMap((p) => {
        const id = p.uuid ?? p.itemId;
        return id && typeof p.text === 'string' ? [{ id, text: p.text }] : [];
    });
    const pointId = target.messageId ? resolveForkPoint(confirmedPrompts(source.sessionId), target.messageId, points, source.kind) : null;
    if (!pointId) throw new ForkFailure('missingPoint', 'No matching prompt in the agent transcript');
    return pointId;
}

/** The new session keeps everything before `message`; its text is prefilled in the new composer. */
export async function forkFromMessage(parent: Session, target: RewindTarget, text: string): Promise<string> {
    try {
        const pointId = await findPoint(target);
        const id = await createRewindBranch({ ...target, pointId }, parentPermissionMode(parent, target.source.kind), deps);
        await settle(parent, id, text);
        return id;
    } catch (error) {
        throw classify(target.source, error);
    }
}
