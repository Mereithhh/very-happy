import { apiSocket } from '@/sync/apiSocket';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { UserTextMessage } from '@/sync/typesMessage';

/**
 * B-528: edit or delete one of the user's prompts IN PLACE, like Claude
 * Desktop / Codex: the agent forgets it (the wrapper rewinds its own
 * transcript — `conversation-rewind` session RPC) and the transcript hides it
 * (a `transcript-drop` tombstone). Edit then sends the new text as the next
 * prompt. Files the dropped turns changed are NOT reverted.
 *
 * Order matters: the tombstone is written only after the agent confirmed, so
 * a failure never leaves the screen and the agent's memory disagreeing.
 */

export type RewindAction = 'edit' | 'delete';

export class RewindFailure extends Error {
    constructor(public readonly kind: 'unsupported' | 'unsent' | 'agent' | 'record' | 'send', message: string) {
        super(message);
        this.name = 'RewindFailure';
    }
}

export type RewindDeps = {
    rpc: (sessionId: string, params: Record<string, unknown>) => Promise<unknown>;
    recordDrop: (sessionId: string, drop: { fromSeq: number; toSeq?: number; reason: RewindAction }) => Promise<void>;
    send: (sessionId: string, text: string) => Promise<unknown>;
    /** Seqs of the session's server-confirmed user prompts. */
    userSeqs: (sessionId: string) => number[];
};

const defaultDeps: RewindDeps = {
    rpc: (sessionId, params) => apiSocket.sessionRPC<unknown, Record<string, unknown>>(sessionId, 'conversation-rewind', params, { timeoutMs: 30_000 }),
    recordDrop: (sessionId, drop) => sync.recordTranscriptDrop(sessionId, drop),
    send: (sessionId, text) => sync.sendMessage(sessionId, text, { source: 'chat' }),
    userSeqs: (sessionId) => (storage.getState().sessionMessages[sessionId]?.messages ?? [])
        .flatMap((message) => message.kind === 'user-text' && typeof message.seq === 'number' ? [message.seq] : []),
};

const UNSUPPORTED = /method not found|rpc method not available|unknown method/i;

/** The turn a delete removes: this prompt up to (not including) the next one. */
export function deleteRange(seq: number, userSeqs: readonly number[]): { fromSeq: number; toSeq?: number } {
    const next = userSeqs.filter((other) => other > seq).sort((a, b) => a - b)[0];
    return next === undefined ? { fromSeq: seq } : { fromSeq: seq, toSeq: next };
}

export async function rewindConversation(
    sessionId: string,
    message: Pick<UserTextMessage, 'seq' | 'localId' | 'text'>,
    request: { action: 'delete' } | { action: 'edit'; text: string },
    deps: RewindDeps = defaultDeps,
): Promise<void> {
    if (typeof message.seq !== 'number') throw new RewindFailure('unsent', 'unsent');
    let raw: unknown;
    try {
        raw = await deps.rpc(sessionId, {
            action: request.action,
            ...(message.localId ? { sourceId: message.localId } : {}),
            text: message.text,
        });
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        throw new RewindFailure(UNSUPPORTED.test(text) ? 'unsupported' : 'agent', text);
    }
    const result = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (result.ok !== true) {
        const text = typeof result.error === 'string' && result.error ? result.error : 'Rewind failed';
        throw new RewindFailure(UNSUPPORTED.test(text) ? 'unsupported' : 'agent', text);
    }
    const range = request.action === 'delete' ? deleteRange(message.seq, deps.userSeqs(sessionId)) : { fromSeq: message.seq };
    try {
        await deps.recordDrop(sessionId, { ...range, reason: request.action });
    } catch (error) {
        throw new RewindFailure('record', error instanceof Error ? error.message : String(error));
    }
    if (request.action === 'edit') {
        const receipt = await deps.send(sessionId, request.text).catch(() => null);
        if (!receipt) throw new RewindFailure('send', 'send');
    }
}
