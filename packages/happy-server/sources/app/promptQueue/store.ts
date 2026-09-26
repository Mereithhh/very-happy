import { PROMPT_QUEUE_MAX_ITEMS, type PromptQueueItem } from '@slopus/happy-wire';
import { SESSION_MESSAGE_CONTENT_MAX_BYTES, storeSessionMessagesInTx } from '@/app/api/sessionMessageStore';
import { lockAccountResources } from '@/app/api/resourceLimits';
import { buildNewMessageUpdate, buildPromptQueueUpdate, eventRouter } from '@/app/events/eventRouter';
import { db } from '@/storage/db';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

/**
 * B-509 server-side prompt queue (spec `specs/2026-09-server-prompt-queue.md`).
 *
 * Every mutation runs in one `inTx`, re-reads the whole queue for the session
 * and broadcasts the snapshot as a `prompt-queue` update to every connection
 * interested in the session (web tabs + the session's wrapper). `dispatch` is
 * the only reader that turns an item into a `SessionMessage`; it is atomic with
 * the item's deletion so a retry can never create the message twice.
 */
export class PromptQueueError extends Error {
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}

type Row = {
    id: string;
    sessionId: string;
    localId: string;
    position: number;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
};

function toItem(row: Row): PromptQueueItem {
    const content = row.content as { t?: unknown; c?: unknown } | null;
    return {
        id: row.id,
        localId: row.localId,
        position: row.position,
        content: { t: 'encrypted', c: typeof content?.c === 'string' ? content.c : '' },
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

async function requireSession(tx: Tx, accountId: string, sessionId: string): Promise<void> {
    const session = await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } });
    if (!session) throw new PromptQueueError('session_not_found', 404);
}

/**
 * Repository-wide lock order is Account → Session (sessionMessageStore,
 * every other writer). dispatch continues into storeSessionMessagesInTx,
 * which takes the same two locks in that order, so taking Session first here
 * would invert it against a concurrent message write (deadlock 40P01).
 */
async function lockQueue(tx: Tx, accountId: string, sessionId: string): Promise<void> {
    await lockAccountResources(tx, accountId);
    await tx.$queryRawUnsafe(`SELECT "id" FROM "Session" WHERE "id" = $1 FOR UPDATE`, sessionId);
}

async function listRows(tx: Tx, sessionId: string): Promise<Row[]> {
    return tx.sessionPromptQueueItem.findMany({
        where: { sessionId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    }) as Promise<Row[]>;
}

function broadcastAfterTx(tx: Tx, accountId: string, sessionId: string, rows: Row[]): void {
    const items = rows.map(toItem);
    afterTx(tx, () => {
        void allocateUserSeq(accountId).then((updateSeq) => {
            eventRouter.emitUpdate({
                userId: accountId,
                payload: buildPromptQueueUpdate(sessionId, items, updateSeq, randomKeyNaked(12)),
                recipientFilter: { type: 'all-interested-in-session', sessionId },
            });
        }).catch(() => { /* broadcast is best-effort; GET is the source of truth */ });
    });
}

export async function listPromptQueue(accountId: string, sessionId: string): Promise<PromptQueueItem[]> {
    const session = await db.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } });
    if (!session) throw new PromptQueueError('session_not_found', 404);
    const rows = await db.sessionPromptQueueItem.findMany({
        where: { sessionId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return (rows as Row[]).map(toItem);
}

export async function enqueuePrompt(accountId: string, sessionId: string, input: { localId: string; content: string }): Promise<{ item: PromptQueueItem; items: PromptQueueItem[]; created: boolean }> {
    if (Buffer.byteLength(input.content, 'utf8') > SESSION_MESSAGE_CONTENT_MAX_BYTES) {
        throw new PromptQueueError('prompt_queue_content_too_large', 413, { maxBytes: SESSION_MESSAGE_CONTENT_MAX_BYTES });
    }
    return inTx(async (tx) => {
        await requireSession(tx, accountId, sessionId);
        // Serialize per session: the account row is the repository-wide lock root.
        await lockQueue(tx, accountId, sessionId);
        const rows = await listRows(tx, sessionId);
        const existing = rows.find((row) => row.localId === input.localId);
        if (existing) return { item: toItem(existing), items: rows.map(toItem), created: false };
        if (rows.length >= PROMPT_QUEUE_MAX_ITEMS) {
            throw new PromptQueueError('prompt_queue_full', 409, { limit: PROMPT_QUEUE_MAX_ITEMS, count: rows.length });
        }
        const position = rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
        const created = await tx.sessionPromptQueueItem.create({
            data: { sessionId, localId: input.localId, position, content: { t: 'encrypted', c: input.content } },
        }) as Row;
        const after = [...rows, created];
        broadcastAfterTx(tx, accountId, sessionId, after);
        return { item: toItem(created), items: after.map(toItem), created: true };
    });
}

export async function updatePromptContent(accountId: string, sessionId: string, itemId: string, content: string): Promise<{ item: PromptQueueItem; items: PromptQueueItem[] }> {
    if (Buffer.byteLength(content, 'utf8') > SESSION_MESSAGE_CONTENT_MAX_BYTES) {
        throw new PromptQueueError('prompt_queue_content_too_large', 413, { maxBytes: SESSION_MESSAGE_CONTENT_MAX_BYTES });
    }
    return inTx(async (tx) => {
        await requireSession(tx, accountId, sessionId);
        await lockQueue(tx, accountId, sessionId);
        const target = await tx.sessionPromptQueueItem.findFirst({ where: { id: itemId, sessionId } });
        if (!target) throw new PromptQueueError('prompt_queue_item_gone', 404);
        const updated = await tx.sessionPromptQueueItem.update({
            where: { id: itemId },
            data: { content: { t: 'encrypted', c: content } },
        }) as Row;
        const rows = await listRows(tx, sessionId);
        broadcastAfterTx(tx, accountId, sessionId, rows);
        return { item: toItem(updated), items: rows.map(toItem) };
    });
}

export async function removePrompt(accountId: string, sessionId: string, itemId: string): Promise<{ removed: boolean; items: PromptQueueItem[] }> {
    return inTx(async (tx) => {
        await requireSession(tx, accountId, sessionId);
        await lockQueue(tx, accountId, sessionId);
        const deleted = await tx.sessionPromptQueueItem.deleteMany({ where: { id: itemId, sessionId } });
        const rows = await listRows(tx, sessionId);
        if (deleted.count > 0) broadcastAfterTx(tx, accountId, sessionId, rows);
        return { removed: deleted.count > 0, items: rows.map(toItem) };
    });
}

/** Pure: the order the queue takes after a client asks for `ids` first. Ids the
 *  server no longer holds are ignored; items the client did not list keep their
 *  relative order behind the listed ones (a concurrent enqueue is never lost). */
export function reorderedRows<T extends { id: string }>(rows: T[], ids: string[]): T[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const listed: T[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        const row = byId.get(id);
        if (row && !seen.has(id)) { listed.push(row); seen.add(id); }
    }
    return [...listed, ...rows.filter((row) => !seen.has(row.id))];
}

export async function reorderPromptQueue(accountId: string, sessionId: string, ids: string[]): Promise<{ items: PromptQueueItem[] }> {
    return inTx(async (tx) => {
        await requireSession(tx, accountId, sessionId);
        await lockQueue(tx, accountId, sessionId);
        const rows = await listRows(tx, sessionId);
        const ordered = reorderedRows(rows, ids);
        for (let index = 0; index < ordered.length; index += 1) {
            if (ordered[index].position !== index + 1) {
                await tx.sessionPromptQueueItem.update({ where: { id: ordered[index].id }, data: { position: index + 1 } });
            }
        }
        const after = await listRows(tx, sessionId);
        broadcastAfterTx(tx, accountId, sessionId, after);
        return { items: after.map(toItem) };
    });
}

export async function dispatchPromptQueueHead(accountId: string, sessionId: string): Promise<{
    /** `created:false` = the message row already existed (replayed localId); the wrapper has seen it before. */
    dispatched: { itemId: string; localId: string; messageId: string; seq: number; created: boolean } | null;
    remaining: number;
}> {
    return inTx(async (tx) => {
        await requireSession(tx, accountId, sessionId);
        // Same lock order as storeSessionMessagesInTx (Account → Session), so the
        // head read and the message write see one queue and never deadlock a
        // concurrent message write.
        await lockQueue(tx, accountId, sessionId);
        const rows = await listRows(tx, sessionId);
        const head = rows[0];
        if (!head) return { dispatched: null, remaining: 0 };
        const content = head.content as { c?: unknown } | null;
        if (typeof content?.c !== 'string' || content.c.length === 0) {
            // Unreadable item: drop it rather than wedge the queue forever.
            await tx.sessionPromptQueueItem.delete({ where: { id: head.id } });
            const rest = rows.slice(1);
            broadcastAfterTx(tx, accountId, sessionId, rest);
            return { dispatched: null, remaining: rest.length };
        }
        const stored = await storeSessionMessagesInTx(tx, {
            accountId,
            sessionId,
            messages: [{ localId: head.localId, content: content.c }],
        });
        const message = stored.messages.find((candidate) => candidate.localId === head.localId);
        if (!message) throw new PromptQueueError('prompt_queue_dispatch_failed', 500);
        await tx.sessionPromptQueueItem.delete({ where: { id: head.id } });
        const rest = rows.slice(1);
        for (const created of stored.createdMessages) {
            const { updateSeq, ...storedMessage } = created;
            const payload = buildNewMessageUpdate(storedMessage, sessionId, updateSeq, randomKeyNaked(12));
            afterTx(tx, () => eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: 'all-interested-in-session', sessionId },
            }));
        }
        broadcastAfterTx(tx, accountId, sessionId, rest);
        return {
            dispatched: {
                itemId: head.id, localId: head.localId, messageId: message.id, seq: message.seq,
                created: stored.createdMessages.some((created) => created.localId === head.localId),
            },
            remaining: rest.length,
        };
    });
}
