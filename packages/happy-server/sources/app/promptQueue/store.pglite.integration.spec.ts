import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './store';

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate } };
});

/** Broadcasts run after commit through an async seq allocation: wait for a count, never a fixed delay. */
const flushBroadcasts = async (expectedCalls = emitUpdate.mock.calls.length) => {
    for (let index = 0; index < 200 && emitUpdate.mock.calls.length < expectedCalls; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('B-509 prompt queue store (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/prompt-queue-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let store: typeof Store; let accountId: string; let otherAccountId: string; let sessionId: string;
    let counter = 0;
    const enqueue = (text: string, localId = `local-${++counter}`) => store.enqueuePrompt(accountId, sessionId, { localId, content: Buffer.from(text).toString('base64') });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'prompt-queue-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        store = await import('./store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(async () => {
        await db.sessionPromptQueueItem.deleteMany({ where: { sessionId } });
        emitUpdate.mockClear();
    });

    it('enqueue appends in order, is idempotent on localId, and broadcasts a full snapshot to the session', async () => {
        const first = await enqueue('one', 'same');
        const second = await enqueue('two');
        const again = await store.enqueuePrompt(accountId, sessionId, { localId: 'same', content: Buffer.from('different').toString('base64') });
        expect(first.created).toBe(true);
        expect(again.created).toBe(false);
        expect(again.item.id).toBe(first.item.id);
        expect(again.item.content.c).toBe(first.item.content.c);
        expect(second.items.map((item) => item.position)).toEqual([1, 2]);
        expect((await store.listPromptQueue(accountId, sessionId)).map((item) => item.localId)).toEqual(['same', second.item.localId]);
        await flushBroadcasts(2);
        // Two created items → two broadcasts; the idempotent retry emits nothing.
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        const last = emitUpdate.mock.calls[1][0];
        expect(last.recipientFilter).toEqual({ type: 'all-interested-in-session', sessionId });
        expect(last.payload.body.t).toBe('prompt-queue');
        expect(last.payload.body.sid).toBe(sessionId);
        expect(last.payload.body.items.map((item: { localId: string }) => item.localId)).toEqual(['same', second.item.localId]);
    });

    it('a session the account does not own is 404 for every verb', async () => {
        await expect(store.listPromptQueue(otherAccountId, sessionId)).rejects.toMatchObject({ code: 'session_not_found', status: 404 });
        await expect(store.enqueuePrompt(otherAccountId, sessionId, { localId: 'x', content: 'eA==' })).rejects.toMatchObject({ status: 404 });
        await expect(store.dispatchPromptQueueHead(otherAccountId, sessionId)).rejects.toMatchObject({ status: 404 });
        await expect(store.removePrompt(otherAccountId, sessionId, 'nope')).rejects.toMatchObject({ status: 404 });
    });

    it('caps the queue at PROMPT_QUEUE_MAX_ITEMS with a 409 the client can name', async () => {
        const { PROMPT_QUEUE_MAX_ITEMS } = await import('@slopus/happy-wire');
        for (let index = 0; index < PROMPT_QUEUE_MAX_ITEMS; index += 1) await enqueue(`item ${index}`);
        await expect(enqueue('overflow')).rejects.toMatchObject({ code: 'prompt_queue_full', status: 409, details: { limit: PROMPT_QUEUE_MAX_ITEMS } });
    });

    it('update rewrites content, remove is idempotent, and a dispatched item is gone for both', async () => {
        const { item } = await enqueue('draft');
        const updated = await store.updatePromptContent(accountId, sessionId, item.id, Buffer.from('final').toString('base64'));
        expect(updated.item.content.c).toBe(Buffer.from('final').toString('base64'));
        const removed = await store.removePrompt(accountId, sessionId, item.id);
        expect(removed).toEqual({ removed: true, items: [] });
        expect(await store.removePrompt(accountId, sessionId, item.id)).toEqual({ removed: false, items: [] });
        await expect(store.updatePromptContent(accountId, sessionId, item.id, 'eA==')).rejects.toMatchObject({ code: 'prompt_queue_item_gone', status: 404 });
    });

    it('reorder follows the client list, keeps unlisted items behind it and ignores unknown ids', async () => {
        const a = (await enqueue('a')).item; const b = (await enqueue('b')).item; const c = (await enqueue('c')).item;
        const { items } = await store.reorderPromptQueue(accountId, sessionId, [c.id, 'ghost', a.id]);
        expect(items.map((item) => item.id)).toEqual([c.id, a.id, b.id]);
        expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
        expect(store.reorderedRows([{ id: '1' }, { id: '2' }, { id: '3' }], ['3', '3', '9']).map((row) => row.id)).toEqual(['3', '1', '2']);
    });

    it('dispatch pops the head into a SessionMessage with the same localId, atomically, one per call, and never twice', async () => {
        const first = (await enqueue('first', 'lid-first')).item;
        await enqueue('second', 'lid-second');
        await flushBroadcasts(2);
        emitUpdate.mockClear();
        const one = await store.dispatchPromptQueueHead(accountId, sessionId);
        expect(one.dispatched).toMatchObject({ itemId: first.id, localId: 'lid-first' });
        expect(one.remaining).toBe(1);
        const message = await db.sessionMessage.findFirst({ where: { sessionId, localId: 'lid-first' } });
        expect(message).not.toBeNull();
        expect(message!.seq).toBe(one.dispatched!.seq);
        expect((message!.content as { c: string }).c).toBe(first.content.c);
        expect(await db.sessionPromptQueueItem.findFirst({ where: { id: first.id } })).toBeNull();
        await flushBroadcasts(2);
        // The message reaches the wrapper the way every user message does (new-message
        // to everyone interested in the session), and the queue snapshot shrinks.
        const bodies = emitUpdate.mock.calls.map((call) => call[0].payload.body.t).sort();
        expect(bodies).toEqual(['new-message', 'prompt-queue']);
        const newMessage = emitUpdate.mock.calls.find((call) => call[0].payload.body.t === 'new-message')![0];
        expect(newMessage.recipientFilter).toEqual({ type: 'all-interested-in-session', sessionId });
        expect(newMessage.payload.body.message.localId).toBe('lid-first');

        const two = await store.dispatchPromptQueueHead(accountId, sessionId);
        expect(two.dispatched?.localId).toBe('lid-second');
        expect(two.remaining).toBe(0);
        expect(await store.dispatchPromptQueueHead(accountId, sessionId)).toEqual({ dispatched: null, remaining: 0 });
        expect(await db.sessionMessage.count({ where: { sessionId, localId: { in: ['lid-first', 'lid-second'] } } })).toBe(2);
        // Re-enqueueing a localId that already became a message is harmless: dispatch
        // reuses the existing row (storeSessionMessages dedupe) and creates nothing new.
        await enqueue('replay', 'lid-first');
        const replay = await store.dispatchPromptQueueHead(accountId, sessionId);
        expect(replay.dispatched?.messageId).toBe(message!.id);
        expect(replay.dispatched?.created).toBe(false);
        expect(one.dispatched?.created).toBe(true);
        expect(await db.sessionMessage.count({ where: { sessionId, localId: 'lid-first' } })).toBe(1);
    });

    it('B-509 review: dispatch and a concurrent message write (turn-end / assistant text) both commit — lock order Account → Session, no deadlock', async () => {
        const { storeSessionMessages } = await import('@/app/api/sessionMessageStore');
        await enqueue('c1', 'lid-c1');
        await enqueue('c2', 'lid-c2');
        const rounds = await Promise.all([
            store.dispatchPromptQueueHead(accountId, sessionId),
            storeSessionMessages({ accountId, sessionId, messages: [{ localId: 'wrapper-turn-end', content: 'ZW5k' }] }),
            store.dispatchPromptQueueHead(accountId, sessionId),
            storeSessionMessages({ accountId, sessionId, messages: [{ localId: 'wrapper-assistant', content: 'YXNzaXN0YW50' }] }),
        ]);
        const dispatched = [rounds[0], rounds[2]].map((round) => round.dispatched?.localId).sort();
        expect(dispatched).toEqual(['lid-c1', 'lid-c2']);
        const rows = await db.sessionMessage.findMany({ where: { sessionId, localId: { in: ['lid-c1', 'lid-c2', 'wrapper-turn-end', 'wrapper-assistant'] } }, orderBy: { seq: 'asc' } });
        expect(rows).toHaveLength(4);
        expect(new Set(rows.map((row) => row.seq)).size).toBe(4);
        expect(await db.sessionPromptQueueItem.count({ where: { sessionId } })).toBe(0);
    });
});
