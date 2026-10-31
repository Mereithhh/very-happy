import { apiSocket } from '@/sync/apiSocket';
import { machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import type { UserTextMessage } from '@/sync/typesMessage';
import type { ForkSource } from '@/utils/sessionFork';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { isHeartbeatFresh } from '@/sync/heartbeatLease';
import { forkFailureKind, resolveForkPoint, sessionForkBlock, type ForkPoint, type ForkReason } from './forkModel';
import { getRewindTarget, rewindPermissionMode, type RewindTarget } from './messageActionsModel';
import { createRewindBranch, createSessionFork } from './rewindOperation';

/**
 * B-851: 「分叉会话」 (header ⋯) and 「从这里分叉」 (a prompt's actions).
 * Both run on the machine that owns the session and open a NEW session with
 * the same machine, directory, agent, permission mode, model and effort; the
 * source session is never touched. Lineage (`parentSessionId`,
 * `forkedFromMessageId`) rides the spawn into the new session's metadata.
 */
export type ForkFailureKind = ReturnType<typeof forkFailureKind> | 'missingPoint';
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

/** Read at click time: a fork is the user's explicit act, not a live status to subscribe to. */
export function sessionRunningNow(session: Session): boolean {
    return isAgentWorkLive({ presence: session.presence, thinking: session.thinking, runningSubagentsInTurn: 0, heartbeatFresh: isHeartbeatFresh(session.id) });
}

/** Why 「从这里分叉」 cannot start for this prompt, or what to cut. */
export function messageForkTarget(session: Session, message: UserTextMessage, hasAttachments: boolean): RewindTarget | ForkReason {
    const running = sessionRunningNow(session);
    const state = sessionForkBlock(session, { machineOnline: machineOnline(session.metadata?.machineId ?? ''), running });
    if (typeof state === 'string') return state;
    return getRewindTarget(session, message, hasAttachments, running);
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
    if (parent.modelMode) state.updateSessionModelMode(newId, parent.modelMode);
    if (parent.effortLevel) state.updateSessionEffortLevel(newId, parent.effortLevel);
}

export async function forkWholeSession(parent: Session, source: ForkSource): Promise<string> {
    try {
        const id = await createSessionFork(source, parentPermissionMode(parent, source.kind), deps);
        await settle(parent, id);
        return id;
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
