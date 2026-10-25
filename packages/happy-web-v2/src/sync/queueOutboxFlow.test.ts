/**
 * B-815: a prompt the composer sent to the server prompt queue (B-509) while
 * the agent was busy, not accepted yet (offline: 「未加入队列 · 重试」), is
 * kept in the B-814 persistent outbox (`kind: 'queue'`). Real Sync +
 * promptQueue store against a fake server whose queue dedupes by localId
 * (store.ts enqueuePrompt) and whose dispatch stores a message with the
 * item's localId (deduped like sessionMessageStore), plus fake-indexeddb.
 *
 * The property every case pins: such a prompt is enqueued exactly once —
 * whatever happened to the page in between — never POSTed as a message, and
 * an ordinary message's row never lands in the dock.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { OutboxRow } from './cache/outboxStore';

const tabs = vi.hoisted(() => ({ alive: new Set<string>(['tab-me']) }));
vi.mock('./tabLiveness', () => ({
    thisTabId: () => 'tab-me',
    holdTabLiveness: () => {},
    isTabAlive: async (tab: string) => tabs.alive.has(tab),
    withTabLock: async (_name: string, fn: () => Promise<void>) => fn(),
}));

let sync: typeof import('./sync').sync;
let storage: typeof import('./storage').storage;
let apiSocket: typeof import('./apiSocket').apiSocket;
let syncCache: typeof import('./cache/syncCache').syncCache;
let outboxStore: typeof import('./cache/syncCache').outboxStore;
let queue: typeof import('./promptQueue');

type ServerMessage = { id: string; seq: number; localId: string | null; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };
type QueueItem = { id: string; localId: string; position: number; content: { t: 'encrypted'; c: string }; createdAt: number; updatedAt: number };

let server: Map<string, ServerMessage[]>;
let queues: Map<string, QueueItem[]>;
/** Every enqueue POST as it arrived, with what IndexedDB held for its localId at that moment. */
let enqueues: Array<{ sid: string; localId: string; durable: boolean }>;
/** Every message POST (localIds). */
let messagePosts: string[][];
/** The link is down: every request fails on the way. */
let down: boolean;
let enqueueStatus: number;
let online: boolean;
let counter = 0;
const onlineListeners: Array<() => void> = [];
let itemCounter = 0;

beforeAll(async () => {
    installBrowserTestGlobals();
    // The page's real `online` listeners (promptQueue.ts registers one at import).
    (globalThis as unknown as { window: { addEventListener: unknown } }).window.addEventListener = (type: string, listener: () => void) => {
        if (type === 'online') onlineListeners.push(listener);
    };
    Object.defineProperty(globalThis, 'navigator', { value: { get onLine() { return online; } }, configurable: true });
    ({ sync } = await import('./sync'));
    ({ storage } = await import('./storage'));
    ({ apiSocket } = await import('./apiSocket'));
    ({ syncCache, outboxStore } = await import('./cache/syncCache'));
    queue = await import('./promptQueue');
});

const cipher = (record: unknown) => `enc:${JSON.stringify(record)}`;
const plain = (body: string) => (body.startsWith('enc:') ? JSON.parse(body.slice(4)) : null);

beforeEach(async () => {
    server = new Map();
    queues = new Map();
    enqueues = [];
    messagePosts = [];
    down = false;
    enqueueStatus = 200;
    online = true;
    tabs.alive = new Set(['tab-me']);
    const encryption = {
        encryptRawRecord: async (record: unknown) => cipher(record),
        decryptRaw: async (body: string) => plain(body),
        decryptMessage: async (m: ServerMessage) => decrypt(m),
        decryptMessages: async (ms: ServerMessage[]) => ms.map(decrypt),
        forgetMessages: () => {},
    };
    (sync as unknown as { encryption: unknown }).encryption = { getSessionEncryption: (id: string) => (server.has(id) ? encryption : null), removeSessionEncryption: () => {} };
    vi.spyOn(apiSocket, 'deliverSessionMessages').mockImplementation(async () => null as never);
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
        if (down) throw new TypeError('Failed to fetch');
        const url = new URL(String(path), 'http://x');
        const sid = url.pathname.split('/')[3];
        if (url.pathname.endsWith('/prompt-queue')) {
            const items = queues.get(sid) ?? [];
            if (init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as { localId: string; content: string };
                const durable = (await outboxStore.all()).some((row) => row.localId === body.localId);
                enqueues.push({ sid, localId: body.localId, durable });
                if (enqueueStatus !== 200) return json({ error: 'nope' }, enqueueStatus);
                if (!items.some((item) => item.localId === body.localId)) {
                    const n = ++itemCounter;
                    items.push({ id: `q${n}`, localId: body.localId, position: items.length + 1, content: { t: 'encrypted', c: body.content }, createdAt: n, updatedAt: n });
                    queues.set(sid, items);
                }
                return json({ items });
            }
            return json({ items });
        }
        const all = server.get(sid) ?? [];
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as { messages: Array<{ localId: string; content: string }> };
            messagePosts.push(body.messages.map((m) => m.localId));
            const acks = body.messages.map((m) => all.find((s) => s.localId === m.localId) ?? storeRaw(sid, m.content, m.localId));
            return json({ messages: acks.map(({ id, seq, localId, createdAt, updatedAt }) => ({ id, seq, localId, createdAt, updatedAt })) });
        }
        const after = url.searchParams.get('after_seq');
        const messages = after !== null ? all.filter((m) => m.seq > Number(after)) : [...all].reverse();
        return json({ messages, hasMore: false });
    });
    await syncCache.open(`queue-outbox-account-${++counter}`);
});

afterEach(async () => {
    await settle();
    vi.restoreAllMocks();
});

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function decrypt(message: ServerMessage) {
    return { id: message.id, seq: message.seq, localId: message.localId, createdAt: message.createdAt, content: plain(message.content.c) };
}

function storeRaw(sid: string, body: string, localId: string | null): ServerMessage {
    const list = server.get(sid)!;
    const seq = (list.at(-1)?.seq ?? 0) + 1;
    const message: ServerMessage = { id: `${sid}-m${seq}`, seq, localId, content: { t: 'encrypted', c: body }, createdAt: seq, updatedAt: seq };
    list.push(message);
    return message;
}

/** The wrapper pops the queue head into a message (store.ts dispatchPromptQueueHead): a replayed localId is not stored again. */
function dispatchHead(sid: string): { localId: string; created: boolean } | null {
    const head = (queues.get(sid) ?? []).shift();
    if (!head) return null;
    const existing = server.get(sid)!.find((m) => m.localId === head.localId);
    if (!existing) storeRaw(sid, head.content.c, head.localId);
    return { localId: head.localId, created: !existing };
}

const userRecord = (text: string) => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web' } });

function newSession(): string {
    const sid = `b815-${++counter}`;
    server.set(sid, []);
    storeRaw(sid, cipher({ role: 'user', content: { type: 'text', text: 'history' } }), null);
    storage.setState((state) => ({
        sessions: {
            ...state.sessions,
            [sid]: { id: sid, presence: 'online', thinking: true, active: true, metadata: { flavor: 'claude', path: '/tmp/x', host: 'h', machineId: 'm1', capabilities: ['prompt-queue-v1'] }, agentState: null } as never,
        },
    }));
    return sid;
}

async function settle() {
    for (let i = 0; i < 60; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A reload as far as this session goes: memory forgets it (messages and the dock), IndexedDB keeps it. */
async function reload(sid: string) {
    const s = sync as unknown as Record<string, Map<string, unknown>>;
    for (const key of ['sessionLastSeq', 'sessionOldestSeq', 'messagesSync', 'sendSync', 'pendingOutbox', 'unverifiedCacheHits']) s[key].delete(sid);
    for (const [localId, record] of [...s.outboxRecords]) if ((record as { sessionId: string }).sessionId === sid) s.outboxRecords.delete(localId);
    storage.getState().resetSessionMessages(sid);
    queue.promptQueueStore.setState((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sid];
        return { sessions };
    });
    // The previous load's tab id is gone: its rows are orphans now.
    const rows = await outboxStore.all();
    await outboxStore.put(rows.filter((row) => row.sid === sid).map((row) => ({ ...row, ownerTabId: 'tab-previous-load' })));
}

/** A non-recovered socket reconnect, as apiSocket's `connect` handler fires it, through Sync's own handler. */
let subscribed = false;
async function socketReconnected() {
    if (!subscribed) {
        (sync as unknown as { subscribeToUpdates: () => void }).subscribeToUpdates();
        subscribed = true;
    }
    const listeners = (apiSocket as unknown as { reconnectedListeners: Set<() => void> }).reconnectedListeners;
    expect(listeners.size).toBeGreaterThan(0);
    for (const listener of listeners) listener();
}

const reclaim = () => (sync as unknown as { reclaimOutbox: () => Promise<void> }).reclaimOutbox();
const dock = (sid: string) => queue.promptQueueStore.getState().sessions[sid]?.pending ?? [];
const transcriptTexts = (sid: string) => (storage.getState().sessionMessages[sid]?.messages ?? [])
    .filter((m) => m.kind === 'user-text').map((m) => (m as { text: string }).text).reverse();
const serverTexts = (sid: string) => server.get(sid)!.map((m) => plain(m.content.c).content.text as string);
const queuedTexts = (sid: string) => (queues.get(sid) ?? []).map((item) => plain(item.content.c).content.text as string);

/**
 * Submit with the link down. `judged`: the app already shows 「已离线」 (the
 * row waits); not yet (QA8's exact shape, < 8s after the link died): the POST
 * fails unanswered and the dock says 「未加入队列」.
 */
async function submitOffline(sid: string, text: string, judged = true): Promise<string> {
    down = true;
    online = !judged;
    await queue.submitPrompt(sid, text, {}).catch(() => {});
    await settle();
    const [row] = dock(sid);
    expect(row).toMatchObject(judged ? { text, state: 'waiting' } : { text, state: 'failed', retryable: true });
    return row.localId;
}

function queueOrphan(sid: string, localId: string, text: string, patch: Partial<OutboxRow> = {}): OutboxRow {
    return {
        localId, sid, body: cipher(userRecord(text)), createdAt: Date.now() - 60_000, state: 'queued',
        attempts: 0, ownerTabId: 'tab-gone', group: localId, order: 0, kind: 'queue', ...patch,
    };
}

describe('B-815 write-through', () => {
    it('the row (kind queue, ciphertext only) is durable before the enqueue POST; acceptance deletes it', async () => {
        const sid = newSession();
        expect(await queue.submitPrompt(sid, 'while busy', {})).toBe('queued');
        await settle();
        expect(enqueues).toHaveLength(1);
        expect(enqueues[0].durable).toBe(true);
        expect(messagePosts).toEqual([]);
        expect(queuedTexts(sid)).toEqual(['while busy']);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('offline: the row stays queued on disk while the dock shows 「未加入队列」', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'offline prompt');
        const [row] = await outboxStore.all();
        expect(row).toMatchObject({ localId, sid, kind: 'queue', state: 'queued', ownerTabId: 'tab-me' });
        expect(plain(row.body).content.text).toBe('offline prompt');
        expect(Object.keys(row).sort()).toEqual(['attempts', 'body', 'createdAt', 'group', 'kind', 'localId', 'order', 'ownerTabId', 'sid', 'state']);
    });

    it('a rejection while online leaves the row failed (not re-enqueued on its own after a reload)', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const sid = newSession();
        enqueueStatus = 409;
        await queue.submitPrompt(sid, 'queue full', {}).catch(() => {});
        await settle();
        expect((await outboxStore.all())[0]).toMatchObject({ kind: 'queue', state: 'failed' });
        enqueueStatus = 200;
        await reload(sid);
        enqueues = [];
        await reclaim();
        await settle();
        expect(enqueues).toEqual([]);
        expect(dock(sid)).toMatchObject([{ text: 'queue full', state: 'failed' }]);
    });

    it('discarding the dock row (删除 / 放回输入框) deletes it', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'never mind');
        expect(queue.discardPendingPrompt(sid, localId)?.text).toBe('never mind');
        await settle();
        expect(await outboxStore.all()).toEqual([]);
    });
});

describe('B-815 takeover after a reload', () => {
    it('QA8 U2: offline submit, reload, network back → enqueued exactly once under its localId, run once, dock empty, row gone', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'survives the reload');
        await reload(sid);
        // Network back.
        down = false;
        online = true;
        await reclaim();
        await settle();
        expect(enqueues.map((e) => [e.localId, e.durable])).toEqual([[localId, true]]);
        expect(queuedTexts(sid)).toEqual(['survives the reload']);
        expect((queues.get(sid) ?? [])[0].localId).toBe(localId);
        expect(messagePosts).toEqual([]);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
        // The wrapper runs it once.
        expect(dispatchHead(sid)).toEqual({ localId, created: true });
        expect(dispatchHead(sid)).toBeNull();
        expect(serverTexts(sid).filter((t) => t === 'survives the reload')).toHaveLength(1);
    });

    it('QA8 exact shape: 「未加入队列」 (failed on the way before the app judged it offline) is still re-enqueued after the reload — once', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'not judged offline yet', false);
        expect((await outboxStore.all())[0]).toMatchObject({ localId, state: 'queued' });
        await reload(sid);
        down = false;
        online = true;
        await reclaim();
        await settle();
        expect(enqueues.map((e) => e.localId)).toEqual([localId]);
        expect(queuedTexts(sid)).toEqual(['not judged offline yet']);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('QA8 exact shape, no reload: 「未加入队列」 (link died before the app judged it offline) goes out on the socket reconnect — once', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'same page', false);
        down = false;
        // No `online` event and no recovered edge (never judged offline): only Sync's reconnect handler.
        await socketReconnected();
        await settle();
        expect(enqueues.filter((e) => e.localId === localId)).toHaveLength(1);
        expect(queuedTexts(sid)).toEqual(['same page']);
        expect(messagePosts.flat()).not.toContain(localId);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
        // Dispatched later: run once; a second reconnect sends nothing more.
        expect(dispatchHead(sid)).toEqual({ localId, created: true });
        await socketReconnected();
        await settle();
        expect(enqueues.filter((e) => e.localId === localId)).toHaveLength(1);
        expect(serverTexts(sid)).toEqual(['history', 'same page']);
    });

    it('judged offline, no reload: the waiting row goes out on the browser\'s `online` event — once', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'back online');
        down = false;
        online = true;
        for (const listener of onlineListeners) listener();
        await settle();
        expect(enqueues.filter((e) => e.localId === localId)).toHaveLength(1);
        expect(queuedTexts(sid)).toEqual(['back online']);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('still offline after the reload: back in the dock as 「未加入队列」, enqueued once the network returns', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'still offline');
        await reload(sid);
        // The session list and key came from the cache; the network is still down.
        (sync as unknown as { getMessagesSync: (id: string) => { invalidateAndAwait: () => Promise<void> } }).getMessagesSync(sid).invalidateAndAwait = () => Promise.resolve();
        await reclaim();
        await settle();
        expect(dock(sid)).toMatchObject([{ localId, text: 'still offline', state: 'waiting' }]);
        expect((await outboxStore.all())[0]).toMatchObject({ localId, state: 'queued' });
        down = false;
        online = true;
        queue.retryWaitingPrompts();
        await settle();
        expect(queuedTexts(sid)).toEqual(['still offline']);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('the server had accepted it (answer lost with the page): listed in its queue → no second enqueue, row dropped', async () => {
        const sid = newSession();
        const row = queueOrphan(sid, 'accepted-1', 'already queued');
        queues.set(sid, [{ id: 'q-a', localId: 'accepted-1', position: 1, content: { t: 'encrypted', c: row.body }, createdAt: 1, updatedAt: 1 }]);
        await outboxStore.put([row]);
        await reclaim();
        await settle();
        expect(enqueues).toEqual([]);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('accepted and already run (its message is in the latest page) → not re-enqueued, the agent does not run it again', async () => {
        const sid = newSession();
        const row = queueOrphan(sid, 'ran-1', 'already ran');
        storeRaw(sid, row.body, 'ran-1');
        await outboxStore.put([row]);
        await reclaim();
        await settle();
        expect(enqueues).toEqual([]);
        expect(queuedTexts(sid)).toEqual([]);
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('>10 min: back in the dock failed, not enqueued; the user\'s Retry enqueues it once and restarts the clock', async () => {
        const sid = newSession();
        await outboxStore.put([queueOrphan(sid, 'old-1', 'an hour ago', { createdAt: Date.now() - 11 * 60_000 })]);
        await reclaim();
        await settle();
        expect(enqueues).toEqual([]);
        expect(dock(sid)).toMatchObject([{ localId: 'old-1', text: 'an hour ago', state: 'failed' }]);
        expect((await outboxStore.all())[0]).toMatchObject({ localId: 'old-1', state: 'failed', ownerTabId: 'tab-me' });

        down = true;
        online = false;
        const before = Date.now();
        await queue.retryPendingPrompt(sid, 'old-1').catch(() => {});
        await settle();
        const [retried] = await outboxStore.all();
        expect(retried).toMatchObject({ state: 'queued', attempts: 1 });
        expect(retried.createdAt).toBeGreaterThanOrEqual(before);

        down = false;
        online = true;
        await queue.retryPendingPrompt(sid, 'old-1');
        await settle();
        expect(queuedTexts(sid)).toEqual(['an hour ago']);
        expect(await outboxStore.all()).toEqual([]);
    });

    it('an automatic retry when the network returns does not restart the 10-minute clock', async () => {
        const sid = newSession();
        const localId = await submitOffline(sid, 'auto');
        const [row] = await outboxStore.all();
        await outboxStore.put([{ ...row, createdAt: Date.now() - 9 * 60_000 }]);
        queue.retryWaitingPrompts(); // still down
        await settle();
        expect((await outboxStore.all())[0]).toMatchObject({ localId, attempts: 0 });
        expect((await outboxStore.all())[0].createdAt).toBeLessThan(Date.now() - 8 * 60_000);
    });

    it('rows of a tab that is still open are left to it; when it closes the next pass enqueues them once', async () => {
        const sid = newSession();
        tabs.alive.add('tab-other');
        await outboxStore.put([queueOrphan(sid, 'theirs', 'other tab', { ownerTabId: 'tab-other' })]);
        await reclaim();
        await settle();
        expect(enqueues).toEqual([]);
        expect(dock(sid)).toEqual([]);
        tabs.alive.delete('tab-other');
        await reclaim();
        await reclaim();
        await settle();
        expect(enqueues.map((e) => e.localId)).toEqual(['theirs']);
        expect(queuedTexts(sid)).toEqual(['other tab']);
    });

    it('several prompts go back in their order', async () => {
        const sid = newSession();
        await outboxStore.put([
            // IndexedDB returns them by key (localId): the reverse of their order.
            queueOrphan(sid, 'a-second', 'two', { createdAt: Date.now() - 2_000 }),
            queueOrphan(sid, 'b-first', 'one', { createdAt: Date.now() - 3_000 }),
        ]);
        await reclaim();
        await settle();
        expect(queuedTexts(sid)).toEqual(['one', 'two']);
    });
});

describe('B-815 × B-814: queue rows and message rows never cross', () => {
    it('a message row is re-sent as a message and stays out of the dock; a queue row is enqueued and never POSTed as a message', async () => {
        const sid = newSession();
        await outboxStore.put([
            queueOrphan(sid, 'q-1', 'for the queue'),
            { ...queueOrphan(sid, 'm-1', 'a message'), kind: undefined, group: 'g-m-1' },
        ]);
        await reclaim();
        await settle();
        expect(messagePosts).toEqual([['m-1']]);
        expect(enqueues.map((e) => e.localId)).toEqual(['q-1']);
        expect(serverTexts(sid)).toEqual(['history', 'a message']);
        expect(queuedTexts(sid)).toEqual(['for the queue']);
        expect(transcriptTexts(sid)).not.toContain('for the queue');
        expect(dock(sid)).toEqual([]);
        expect(await outboxStore.all()).toEqual([]);
        // Dispatch: one message for the queued prompt, nothing doubled.
        dispatchHead(sid);
        expect(serverTexts(sid)).toEqual(['history', 'a message', 'for the queue']);
    });

    it('an ordinary send and a queued prompt in the same offline stretch each reach the server once, by their own route', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const sid = newSession();
        const queuedId = await submitOffline(sid, 'queued offline');
        const sentId = (await sync.sendMessage(sid, 'sent offline')) as string;
        await settle();
        expect((await outboxStore.all()).map((row) => [row.localId, row.kind ?? 'message']).sort()).toEqual([[queuedId, 'queue'], [sentId, 'message']].sort());
        await reload(sid);
        down = false;
        online = true;
        await reclaim();
        await settle();
        expect(messagePosts.flat().filter((id) => id === queuedId)).toEqual([]);
        expect(enqueues.map((e) => e.localId).filter((id) => id === sentId)).toEqual([]);
        expect(serverTexts(sid).filter((t) => t === 'sent offline')).toHaveLength(1);
        expect(queuedTexts(sid)).toEqual(['queued offline']);
        expect(await outboxStore.all()).toEqual([]);
    });
});
