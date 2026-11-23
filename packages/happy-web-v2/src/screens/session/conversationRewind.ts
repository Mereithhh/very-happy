import { useEffect } from 'react';
import { randomUUID } from 'expo-crypto';
import { apiSocket } from '@/sync/apiSocket';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Message, UserTextMessage } from '@/sync/typesMessage';
import type { ReusableAttachment } from '@/sync/attachmentTypes';
import type { Session } from '@/sync/storageTypes';

/**
 * B-528: edit or delete one of the user's prompts IN PLACE, like Claude
 * Desktop / Codex: the agent forgets it (the wrapper rewinds its own
 * transcript — `conversation-rewind` session RPC) and the transcript hides it
 * (a `transcript-drop` tombstone). Edit then sends the new text as the next
 * prompt. Files the dropped turns changed are NOT reverted.
 *
 * Order matters: the tombstone is written only after the agent confirmed, so
 * a failure never leaves the screen and the agent's memory disagreeing.
 *
 * B-544: the RPC ack is only the fast path. Each request carries a
 * `requestId`; the wrapper records `metadata.rewind.requestId` before it acks
 * and keeps the rewind provisional until a tombstone with the same id lands
 * (else it switches back after 120 s). So when the ack is lost (timeout,
 * dropped socket) this waits briefly for that record: present → the agent did
 * rewind, write the tombstone and send as usual; absent → fail as before.
 * Either both sides changed or neither did.
 */

export type RewindAction = 'edit' | 'delete';

export class RewindFailure extends Error {
    constructor(public readonly kind: 'unsupported' | 'outdated' | 'unsent' | 'agent' | 'record' | 'send' | 'attachments', message: string) {
        super(message);
        this.name = 'RewindFailure';
    }
}

export type RewindDeps = {
    rpc: (sessionId: string, params: Record<string, unknown>) => Promise<unknown>;
    recordDrop: (sessionId: string, drop: { fromSeq: number; toSeq?: number; reason: RewindAction; requestId?: string }) => Promise<void>;
    /** B-961b: `attachments` are re-sent by reference (edit keeps them). */
    send: (sessionId: string, text: string, attachments?: ReusableAttachment[]) => Promise<unknown>;
    /** Seqs of the session's server-confirmed user prompts. */
    userSeqs: (sessionId: string) => number[];
    /** B-544: resolves true once session metadata shows `rewind.requestId === requestId`, false after `ms`. */
    waitForRewindRecord?: (sessionId: string, requestId: string, ms: number) => Promise<boolean>;
    newRequestId?: () => string;
};

/** B-544: how long a lost ack waits for the wrapper's metadata record. */
export const REWIND_RECORD_WAIT_MS = 10_000;

function hasRewindRecord(sessionId: string, requestId: string): boolean {
    const record = storage.getState().sessions[sessionId]?.metadata?.rewind;
    // A record the wrapper already rolled back is not a rewind to build on.
    return record?.requestId === requestId && record.state !== 'reverted' && record.state !== 'superseded';
}

/** Metadata updates arrive over the update stream into the store; watch it. */
export function waitForRewindRecordInStore(sessionId: string, requestId: string, ms: number): Promise<boolean> {
    if (hasRewindRecord(sessionId, requestId)) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (found: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(found);
        };
        const unsubscribe = storage.subscribe(() => {
            if (hasRewindRecord(sessionId, requestId)) finish(true);
        });
        const timer = setTimeout(() => finish(hasRewindRecord(sessionId, requestId)), ms);
    });
}

const defaultDeps: RewindDeps = {
    rpc: (sessionId, params) => apiSocket.sessionRPC<unknown, Record<string, unknown>>(sessionId, 'conversation-rewind', params, { timeoutMs: 30_000 }),
    recordDrop: (sessionId, drop) => sync.recordTranscriptDrop(sessionId, drop),
    send: (sessionId, text, attachments) => sync.sendMessage(sessionId, text, {
        source: 'chat',
        ...(attachments && attachments.length > 0 ? { reuseAttachments: attachments } : {}),
    }),
    userSeqs: (sessionId) => (storage.getState().sessionMessages[sessionId]?.messages ?? [])
        .flatMap((message) => message.kind === 'user-text' && typeof message.seq === 'number' ? [message.seq] : []),
    waitForRewindRecord: waitForRewindRecordInStore,
    newRequestId: randomUUID,
};

const UNSUPPORTED = /method not found|rpc method not available|unknown method/i;

/** The turn a delete removes: this prompt up to (not including) the next one. */
export function deleteRange(seq: number, userSeqs: readonly number[]): { fromSeq: number; toSeq?: number } {
    const next = userSeqs.filter((other) => other > seq).sort((a, b) => a - b)[0];
    return next === undefined ? { fromSeq: seq } : { fromSeq: seq, toSeq: next };
}

export async function rewindConversation(
    sessionId: string,
    message: Pick<UserTextMessage, 'seq' | 'localId' | 'text'> & { codexItemId?: string },
    request: { action: 'delete' } | { action: 'edit'; text: string },
    deps: RewindDeps = defaultDeps,
    attachments?: ReusableAttachment[],
): Promise<void> {
    if (typeof message.seq !== 'number') throw new RewindFailure('unsent', 'unsent');
    const requestId = (deps.newRequestId ?? randomUUID)();
    applying.add(requestId);
    try {
        await rewindWithId(sessionId, message, request, deps, requestId, attachments);
    } finally {
        applying.delete(requestId);
    }
}

/** B-961: rewinds this page is applying itself — its reconcile leaves them alone. */
const applying = new Set<string>();
/** B-961: requestIds this page already reconciled. */
const reconciled = new Set<string>();

/**
 * B-961: a Codex rewind cannot be switched back (thread/revert), so the
 * wrapper's `metadata.rewind` (state `applied`, written before its ack) is
 * the truth: when the prompt it names is still on screen, this page missed
 * the ack (closed, reloaded, dropped socket) and hides from that prompt on —
 * the same tombstone the live path writes. Pure.
 */
export function codexRewindReconcile(
    session: Pick<Session, 'metadata' | 'share'> | null | undefined,
    newestFirst: readonly Message[],
): { requestId: string; reason: RewindAction; fromSeq: number } | null {
    const record = session?.metadata?.rewind;
    if (session?.metadata?.flavor !== 'codex' || session.share || !record || record.state !== 'applied' || !record.requestId) return null;
    if (!record.sourceId && !record.codexItemId) return null;
    const target = newestFirst.find((message) => message.kind === 'user-text'
        && ((record.sourceId && message.localId === record.sourceId) || (record.codexItemId && message.codexItemId === record.codexItemId)));
    if (!target || typeof target.seq !== 'number') return null;
    return { requestId: record.requestId, reason: record.action === 'edit' ? 'edit' : 'delete', fromSeq: target.seq };
}

export function useCodexRewindReconcile(sessionId: string, session: Session | null | undefined, newestFirst: readonly Message[], isLoaded: boolean): void {
    const next = isLoaded ? codexRewindReconcile(session, newestFirst) : null;
    const key = next ? `${next.requestId}:${next.fromSeq}` : null;
    useEffect(() => {
        if (!next || applying.has(next.requestId) || reconciled.has(next.requestId)) return;
        reconciled.add(next.requestId);
        sync.recordTranscriptDrop(sessionId, { fromSeq: next.fromSeq, reason: next.reason, requestId: next.requestId })
            .catch(() => reconciled.delete(next.requestId));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, key]);
}

async function rewindWithId(
    sessionId: string,
    message: Pick<UserTextMessage, 'seq' | 'localId' | 'text'> & { codexItemId?: string },
    request: { action: 'delete' } | { action: 'edit'; text: string },
    deps: RewindDeps,
    requestId: string,
    attachments?: ReusableAttachment[],
): Promise<void> {
    if (typeof message.seq !== 'number') throw new RewindFailure('unsent', 'unsent');
    let raw: unknown;
    try {
        raw = await deps.rpc(sessionId, {
            action: request.action,
            ...(message.localId ? { sourceId: message.localId } : {}),
            // B-961: a Codex wrapper finds the turn by it (prompts mirrored from Codex); Claude ignores it.
            ...(message.codexItemId ? { codexItemId: message.codexItemId } : {}),
            text: message.text,
            requestId,
            // B-961b: the wrapper checks these before it rewinds (nothing is
            // dropped when a file is gone) and re-sends them with the text.
            ...(attachments && attachments.length > 0 ? { attachments: attachments.map((attachment) => ({
                ref: attachment.ref,
                name: attachment.name,
                size: attachment.size,
                ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
                ...(attachment.image ? { image: attachment.image } : {}),
            })) } : {}),
        });
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (UNSUPPORTED.test(text)) throw new RewindFailure('unsupported', text);
        // The ack was lost, not refused: the agent may have rewound anyway.
        // Its durable record decides (old CLIs never write one → fail as before).
        const recorded = deps.waitForRewindRecord
            ? await deps.waitForRewindRecord(sessionId, requestId, REWIND_RECORD_WAIT_MS).catch(() => false)
            : false;
        if (!recorded) throw new RewindFailure('agent', text);
        raw = { ok: true };
    }
    const result = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (result.ok !== true) {
        const text = typeof result.error === 'string' && result.error ? result.error : 'Rewind failed';
        // B-961: the wrapper can rewind, the Codex it runs cannot (no thread/revert).
        if (result.code === 'codex-outdated') throw new RewindFailure('outdated', text);
        // B-961b: the wrapper could not resolve an attachment — before any rewind.
        if (result.code === 'attachment-gone') throw new RewindFailure('attachments', text);
        throw new RewindFailure(UNSUPPORTED.test(text) ? 'unsupported' : 'agent', text);
    }
    // B-961: Codex `thread/revert` drops this turn and every later one (`dropsLater`) — hide them all.
    const range = request.action === 'delete' && result.dropsLater !== true ? deleteRange(message.seq, deps.userSeqs(sessionId)) : { fromSeq: message.seq };
    try {
        await deps.recordDrop(sessionId, { ...range, reason: request.action, requestId });
    } catch (error) {
        throw new RewindFailure('record', error instanceof Error ? error.message : String(error));
    }
    if (request.action === 'edit') {
        const receipt = await deps.send(sessionId, request.text, attachments).catch(() => null);
        if (!receipt) throw new RewindFailure('send', 'send');
    }
}
