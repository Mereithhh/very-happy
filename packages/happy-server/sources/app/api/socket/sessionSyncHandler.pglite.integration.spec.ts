/**
 * B-811 (B-807 spec §9.1): sync-hello / session-subscribe against a REAL
 * database and REAL socket.io, with the four production new-message writers.
 *
 * Runs on PGlite by default (CI). Set VH_TEST_DATABASE_URL to a throwaway
 * Postgres to run the same suite with true concurrent connections, e.g.
 *   docker run -d --name vh-sync-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55811:5432 postgres:17-alpine
 *   VH_TEST_DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55811/postgres pnpm exec vitest run sessionSyncHandler.pglite
 *
 * The atomicity property (§9.1-1) is the load-bearing test: a web socket that
 * missed everything reconnects and says hello while all four writers commit
 * around it; snapshot ∪ pushes must equal every committed seq > afterSeq.
 * Web sockets here are NOT put in their push room at connect (joinMode
 * 'lazy'), so the handler's own join-before-snapshot is what is under test;
 * a second pass repeats it with startSocket's real join order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Harness from '../testing/sessionSyncHarness';
import type { SessionSyncDeps } from './sessionSyncHandler';

let harness: typeof Harness;
let database: Harness.SyncTestDatabase;
let server: Harness.SyncTestServer;
let fixture: Harness.SharedSessionFixture;
let writers: Harness.Writers;
let db: typeof import('@/storage/db').db;
let snapshot: typeof import('@/app/session/sessionSyncSnapshot');
const serverOptions: Harness.SyncServerOptions = { joinMode: 'lazy', routeEvents: true };
const hooks: NonNullable<SessionSyncDeps['hooks']> = {};

beforeAll(async () => {
    harness = await import('../testing/sessionSyncHarness');
    database = await harness.prepareSyncTestDatabase('session-sync');
    ({ db } = await import('@/storage/db'));
    snapshot = await import('@/app/session/sessionSyncSnapshot');
    const sync = await import('./sessionSyncHandler');
    const { resolveSessionAccess } = await import('@/app/session/sessionShares');
    serverOptions.syncDeps = {
        config: () => sync.resolveSessionSyncConfig(process.env),
        gate: sync.createSnapshotGate(32),
        client: db,
        resolveAccess: resolveSessionAccess,
        now: Date.now,
        random: Math.random,
        hooks: {
            beforeSnapshot: () => hooks.beforeSnapshot?.(),
            afterHeads: () => hooks.afterHeads?.(),
            afterSnapshot: () => hooks.afterSnapshot?.(),
        },
    };
    server = await harness.startSyncServer(serverOptions);
    fixture = await harness.createSharedSession('sync');
    writers = await harness.createWriters(server.url, fixture);
}, 120_000);

afterAll(async () => {
    await writers?.close();
    await server?.close();
    await db?.$disconnect();
    database?.cleanup();
});

async function bulkSession(accountId: string, count: number, contentBytes = 8) {
    const session = await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'm', seq: count } });
    const content = { t: 'encrypted' as const, c: 'x'.repeat(contentBytes) };
    for (let start = 1; start <= count; start += 500) {
        await db.sessionMessage.createMany({ data: Array.from({ length: Math.min(500, count - start + 1) }, (_, i) => ({
            sessionId: session.id, seq: start + i, localId: `bulk-${start + i}`, content,
        })) });
    }
    return session.id;
}

async function hello(client: Harness.TestClient, subs: unknown[]) {
    return harness.emitWithAck(client.socket, 'sync-hello', { v: 1, subs, reason: 'connect' });
}

describe('atomicity: snapshot ∪ push is gap-free (§9.1-1, §9.1-10)', () => {
    async function runRounds(rounds: number, seed: number) {
        for (let round = 0; round < rounds; round += 1) {
            const random = harness.seededRandom(seed + round);
            const asGrantee = round % 5 === 4;
            // Review M2: session-subscribe rests on the same join-before-read proof as hello.
            const viaSubscribe = round % 2 === 1;
            const userId = asGrantee ? fixture.granteeId : fixture.ownerId;
            const head = await harness.sessionHead(fixture.sessionId);
            const afterSeq = Math.max(0, head - Math.floor(random() * 3));
            const beforeDelay = Math.floor(random() * 12);
            // B-821: writes land between the head batch and the page statements — a page whose
            // head came from the head batch (not its own statement) tears here.
            const betweenDelay = Math.floor(random() * 12);
            const afterDelay = Math.floor(random() * 12);
            hooks.beforeSnapshot = async () => { await harness.sleep(beforeDelay); };
            // Every third round also commits one write INSIDE that window, so it is hit for sure.
            const writeBetween = round % 3 === 0
                ? harness.WRITER_KINDS[Math.floor(random() * harness.WRITER_KINDS.length)]
                : null;
            hooks.afterSnapshot = async () => { await harness.sleep(afterDelay); };

            const writes = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
                kind: harness.WRITER_KINDS[Math.floor(random() * harness.WRITER_KINDS.length)],
                delay: Math.floor(random() * 25),
            }));
            const writing = Promise.all(writes.map(async ({ kind, delay }) => {
                await harness.sleep(delay);
                await writers.write(kind);
            }));
            hooks.afterHeads = async () => {
                await harness.sleep(betweenDelay);
                if (!writeBetween) return;
                // After the round's other writes: one account's serializable writers racing each
                // other exhaust inTx's retries on a busy real Postgres — not what is under test.
                await writing;
                await writers.write(writeBetween);
            };
            await harness.sleep(Math.floor(random() * 10));
            const client = await harness.connectClient(server.url, { userId });
            try {
                let result;
                if (viaSubscribe) {
                    result = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid: fixture.sessionId, afterSeq });
                    await writing;
                } else {
                    // One hello drives BOTH batch statements (increment + latest page of the same
                    // session) plus a gone sid, so the per-session proof is tested inside a batch.
                    const ack = await hello(client, [
                        { sid: fixture.sessionId, afterSeq },
                        { sid: 'gone-session', afterSeq: null },
                        { sid: fixture.sessionId, afterSeq: null, limit: 5 },
                    ]);
                    await writing;
                    expect(ack.ok, `round ${round}`).toBe(true);
                    result = ack.results[0];
                    expect(ack.results[1]).toEqual({ sid: 'gone-session', ok: false, error: 'not_found' });
                    const latest = ack.results[2];
                    expect(latest.ok, `round ${round} latest`).toBe(true);
                    // The latest page is exactly the newest 5 rows at ITS head (same statement snapshot).
                    const atHead = (await harness.committedSeqs(fixture.sessionId, 0)).filter((seq) => seq <= latest.headSeq).slice(-5);
                    expect(latest.messages.map((m: { seq: number }) => m.seq), `round ${round} latest page at head ${latest.headSeq}`).toEqual(atHead);
                }
                expect(result.ok, `round ${round} (${viaSubscribe ? 'subscribe' : 'hello'})`).toBe(true);

                // Head and page come from one snapshot.
                const seqs: number[] = result.messages.map((m: { seq: number }) => m.seq);
                expect(seqs.every((seq) => seq > afterSeq && seq <= result.headSeq), `round ${round} page within (afterSeq, head]`).toBe(true);
                // r1 §4.2: a complete answer holds every DB row in (afterSeq, head] (max ≤ head, holes allowed).
                if (!result.hasMore) {
                    const inRange = (await harness.committedSeqs(fixture.sessionId, afterSeq)).filter((seq) => seq <= result.headSeq);
                    expect(seqs, `round ${round} head`).toEqual(inRange);
                }

                const expected = await harness.committedSeqs(fixture.sessionId, afterSeq);
                const seen = () => [...new Set([...seqs, ...(client.pushes.get(fixture.sessionId) ?? [])])].filter((s) => s > afterSeq).sort((a, b) => a - b);
                for (let wait = 0; wait < 300 && seen().length < expected.length; wait += 1) await harness.sleep(10);
                expect(seen(), `round ${round} seed ${seed + round} (${asGrantee ? 'grantee' : 'owner'}, ${viaSubscribe ? 'subscribe' : 'hello'}) writes=${JSON.stringify(writes)} between=${writeBetween}`).toEqual(expected);
            } finally {
                client.socket.close();
            }
        }
        hooks.beforeSnapshot = undefined;
        hooks.afterHeads = undefined;
        hooks.afterSnapshot = undefined;
    }

    it('200 random interleavings of all four writers, owner and grantee, hello and subscribe, handler-owned join', async () => {
        serverOptions.joinMode = 'lazy';
        await runRounds(200, 811_000);
    }, 240_000);

    it('50 more with startSocket\'s join-at-connect order', async () => {
        serverOptions.joinMode = 'prod';
        try {
            await runRounds(50, 811_500);
        } finally {
            serverOptions.joinMode = 'lazy';
        }
    }, 120_000);
});

describe('one statement: head and page agree under concurrent writes (§9.1-2)', () => {
    it('every batched snapshot taken while writers commit has page ⊆ (afterSeq, head] and, when complete, holds every row in that range', async () => {
        const random = harness.seededRandom(811_900);
        let writing = true;
        const writer = (async () => {
            for (let i = 0; i < 120; i += 1) await writers.write(random() < 0.5 ? 'v3-post' : 'prompt-queue');
            writing = false;
        })();
        let reads = 0;
        while (writing) {
            const head = await harness.sessionHead(fixture.sessionId);
            const afterSeqs = [0, 1, 2].map(() => Math.max(0, head - Math.floor(random() * 4)));
            // B-821: several reads of the same session in ONE increment statement and ONE latest statement.
            const increments = await snapshot.readIncrements(db, afterSeqs.map((afterSeq) => ({ sessionId: fixture.sessionId, afterSeq, limit: 500 })));
            const pages = await snapshot.readLatestPages(db, [3, 8].map((limit) => ({ sessionId: fixture.sessionId, limit })));
            for (const [i, read] of increments.entries()) {
                const afterSeq = afterSeqs[i];
                expect(read).not.toBeNull();
                const seqs = read!.messages.map((m) => m.seq);
                expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
                expect(seqs.every((seq) => seq > afterSeq && seq <= read!.head)).toBe(true);
                if (!read!.hasMore) {
                    expect(seqs).toEqual((await harness.committedSeqs(fixture.sessionId, afterSeq)).filter((seq) => seq <= read!.head));
                }
            }
            for (const [i, page] of pages.entries()) {
                expect(page!.messages.map((m) => m.seq)).toEqual((await harness.committedSeqs(fixture.sessionId, 0)).filter((seq) => seq <= page!.head).slice(-[3, 8][i]));
            }
            reads += 1;
        }
        await writer;
        expect(reads).toBeGreaterThan(10);
    }, 120_000);
});

describe('seq holes are returned as-is (§4.2.1, §9.1-2a)', () => {
    it('Session.seq=12 with rows 1–4, 6–10: head 12, hasMore false, rows per range, Session.seq untouched', async () => {
        const session = await db.session.create({ data: { accountId: fixture.ownerId, tag: crypto.randomUUID(), metadata: 'm', seq: 12 } });
        await db.sessionMessage.createMany({ data: [1, 2, 3, 4, 6, 7, 8, 9, 10].map((seq) => ({
            sessionId: session.id, seq, localId: `hole-${seq}`, content: { t: 'encrypted' as const, c: `c${seq}` },
        })) });
        const client = await harness.connectClient(server.url, { userId: fixture.ownerId });
        try {
            const ack = await hello(client, [null, 4, 10, 12].map((afterSeq) => ({ sid: session.id, afterSeq })));
            expect(ack.ok).toBe(true);
            const expected = [[1, 2, 3, 4, 6, 7, 8, 9, 10], [6, 7, 8, 9, 10], [], []];
            ack.results.forEach((result: any, i: number) => {
                expect(result).toMatchObject({ ok: true, headSeq: 12, hasMore: false });
                expect(result).not.toHaveProperty('gapTooLarge');
                expect(result.messages.map((m: any) => m.seq)).toEqual(expected[i]);
            });
            const sub = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid: session.id, afterSeq: 10 });
            expect(sub).toEqual({ sid: session.id, ok: true, headSeq: 12, messages: [], hasMore: false });
        } finally {
            client.socket.close();
        }
        expect(await harness.sessionHead(session.id)).toBe(12);
    });
});

describe('gap threshold and cold page on a real database (§9.1-3)', () => {
    let sid: string;
    let client: Harness.TestClient;
    beforeAll(async () => {
        sid = await bulkSession(fixture.ownerId, 1000);
        client = await harness.connectClient(server.url, { userId: fixture.ownerId });
    });
    afterAll(() => client.socket.close());

    it('499 / 500 behind are increments, 501 behind is the latest page', async () => {
        const ack = await hello(client, [
            { sid, afterSeq: 501, limit: 3 },
            { sid, afterSeq: 500, limit: 3 },
            { sid, afterSeq: 499, limit: 3 },
        ]);
        expect(ack.ok).toBe(true);
        const [gap499, gap500, gap501] = ack.results;
        expect(gap499).toMatchObject({ ok: true, headSeq: 1000, hasMore: true });
        expect(gap499.messages.map((m: any) => m.seq)).toEqual([502, 503, 504]);
        expect(gap499).not.toHaveProperty('gapTooLarge');
        expect(gap500.messages.map((m: any) => m.seq)).toEqual([501, 502, 503]);
        expect(gap500).not.toHaveProperty('gapTooLarge');
        expect(gap501).toMatchObject({ ok: true, headSeq: 1000, gapTooLarge: true, oldestSeq: 998, hasMore: false });
        expect(gap501.messages.map((m: any) => m.seq)).toEqual([998, 999, 1000]);
    });

    it('cold returns the newest 200, ascending, in the REST message shape', async () => {
        const ack = await hello(client, [{ sid, afterSeq: null }]);
        const [cold] = ack.results;
        expect(cold).toMatchObject({ ok: true, headSeq: 1000, oldestSeq: 801, hasMore: false });
        expect(cold.messages).toHaveLength(200);
        expect(cold.messages[0].seq).toBe(801);
        expect(cold.messages.at(-1).seq).toBe(1000);
        const rest = await db.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, seq: 1000 } });
        expect(cold.messages.at(-1)).toEqual({
            id: rest.id, seq: 1000, content: rest.content, localId: rest.localId,
            createdAt: rest.createdAt.getTime(), updatedAt: rest.updatedAt.getTime(),
        });
    });

    it('an empty session: cold and warm both answer head 0 with no messages', async () => {
        const empty = (await db.session.create({ data: { accountId: fixture.ownerId, tag: crypto.randomUUID(), metadata: 'm' } })).id;
        const ack = await hello(client, [{ sid: empty, afterSeq: null }, { sid: empty, afterSeq: 0 }]);
        expect(ack.results).toEqual([
            { sid: empty, ok: true, headSeq: 0, messages: [], hasMore: false },
            { sid: empty, ok: true, headSeq: 0, messages: [], hasMore: false },
        ]);
        expect(await snapshot.readSessionSnapshot(db, { sessionId: empty, afterSeq: null, limit: 5 })).toEqual({ head: 0, messages: [], hasMore: false });
    });

    it('subscribe follows hasMore to the head', async () => {
        let afterSeq = 0;
        const seen: number[] = [];
        for (let page = 0; page < 10; page += 1) {
            const result = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid, afterSeq, limit: 500 });
            seen.push(...result.messages.map((m: any) => m.seq));
            if (!result.hasMore) break;
            afterSeq = result.messages.at(-1).seq;
        }
        // 1000 behind > gap threshold → latest page first; from a recent seq it is a plain walk.
        expect(seen.length).toBeGreaterThan(0);
        const walk: number[] = [];
        afterSeq = 600;
        for (let page = 0; page < 10; page += 1) {
            const result = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid, afterSeq, limit: 150 });
            walk.push(...result.messages.map((m: any) => m.seq));
            if (!result.hasMore) { expect(result.headSeq).toBe(1000); break; }
            afterSeq = result.messages.at(-1).seq;
        }
        expect(walk).toEqual(Array.from({ length: 400 }, (_, i) => 601 + i));
    });
});

describe('auth (§4.5, §9.1-4)', () => {
    it('owner and active grantee are served; stranger, revoked, expired and deleted are not_found, indistinguishable from nonexistent', async () => {
        const shares = await import('@/app/session/sessionShares');
        const shared = await harness.createSharedSession('auth');
        const ask = async (userId: string, sid: string) => {
            const client = await harness.connectClient(server.url, { userId });
            try {
                const ack = await hello(client, [{ sid, afterSeq: 0 }]);
                const sub = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid, afterSeq: 0 });
                return { hello: ack.results[0], sub };
            } finally {
                client.socket.close();
            }
        };
        const notFound = (sid: string) => ({ hello: { sid, ok: false, error: 'not_found' }, sub: { sid, ok: false, error: 'not_found' } });

        expect((await ask(shared.ownerId, shared.sessionId)).hello).toMatchObject({ ok: true });
        expect((await ask(shared.granteeId, shared.sessionId)).hello).toMatchObject({ ok: true });
        expect(await ask(shared.strangerId, shared.sessionId)).toEqual(notFound(shared.sessionId));
        expect(await ask(shared.strangerId, 'does-not-exist')).toEqual(notFound('does-not-exist'));

        await db.sessionGrant.update({ where: { id: shared.grantId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
        expect(await ask(shared.granteeId, shared.sessionId)).toEqual(notFound(shared.sessionId));
        await db.sessionGrant.update({ where: { id: shared.grantId }, data: { expiresAt: null } });
        expect((await ask(shared.granteeId, shared.sessionId)).hello).toMatchObject({ ok: true });

        await shares.revokeSessionGrant(shared.ownerId, shared.sessionId, shared.granteeId);
        expect(await ask(shared.granteeId, shared.sessionId)).toEqual(notFound(shared.sessionId));

        const doomed = await bulkSession(shared.ownerId, 3);
        expect((await ask(shared.ownerId, doomed)).hello).toMatchObject({ ok: true, headSeq: 3 });
        await db.sessionMessage.deleteMany({ where: { sessionId: doomed } });
        await db.session.delete({ where: { id: doomed } });
        expect(await ask(shared.ownerId, doomed)).toEqual(notFound(doomed));
    });
});

describe('ack size budget (§4.4, §9.1-6)', () => {
    it('600KB of increment is cut under 512KB with hasMore, and subscribe picks up the rest', async () => {
        const sid = await bulkSession(fixture.ownerId, 60, 10 * 1024);
        const client = await harness.connectClient(server.url, { userId: fixture.ownerId });
        try {
            const ack = await hello(client, [{ sid, afterSeq: 0 }, { sid, afterSeq: 0 }]);
            const [first, second] = ack.results;
            const bytes = first.messages.reduce((total: number, m: any) => total + Buffer.byteLength(JSON.stringify(m)), 0);
            expect(bytes).toBeLessThanOrEqual(512 * 1024);
            expect(first.hasMore).toBe(true);
            expect(first.messages.map((m: any) => m.seq)).toEqual(Array.from({ length: first.messages.length }, (_, i) => i + 1));
            expect(second).toMatchObject({ ok: true, messages: [], hasMore: true, headSeq: 60 });
            const rest = await harness.emitWithAck(client.socket, 'session-subscribe', { v: 1, sid, afterSeq: first.messages.at(-1).seq });
            expect(rest).toMatchObject({ ok: true, hasMore: false, headSeq: 60 });
            expect(rest.messages.at(-1).seq).toBe(60);
        } finally {
            client.socket.close();
        }
    });
});

describe('legacy behaviour is unchanged (§6.2 rows 1, 3, 7)', () => {
    async function legacyRun(disabled: boolean) {
        if (disabled) process.env.SYNC_SUBSCRIBE_DISABLED = '1';
        else delete process.env.SYNC_SUBSCRIBE_DISABLED;
        // Production join order: an old web client never says hello.
        serverOptions.joinMode = 'prod';
        // A web client that never says hello (old Web), and the CLI's session socket.
        const web = await harness.connectClient(server.url, { userId: fixture.ownerId });
        const cli = await harness.connectClient(server.url, { userId: fixture.ownerId, clientType: 'session-scoped', sessionId: fixture.sessionId });
        try {
            const before = await harness.sessionHead(fixture.sessionId);
            for (const kind of harness.WRITER_KINDS) await writers.write(kind);
            const expected = await harness.committedSeqs(fixture.sessionId, before);
            for (let wait = 0; wait < 300 && (web.pushes.get(fixture.sessionId) ?? []).length < expected.length; wait += 1) await harness.sleep(10);
            const cliHello = await harness.emitWithAck(cli.socket, 'sync-hello', { v: 1, subs: [{ sid: fixture.sessionId, afterSeq: 0 }] });
            const webHello = await hello(web, [{ sid: fixture.sessionId, afterSeq: before }]);
            return { web, cli, expected, cliHello, webHello };
        } finally {
            web.socket.close();
            cli.socket.close();
            delete process.env.SYNC_SUBSCRIBE_DISABLED;
            serverOptions.joinMode = 'lazy';
        }
    }

    function shapeOf(update: any) {
        return {
            keys: Object.keys(update).sort(),
            body: Object.keys(update.body).sort(),
            message: Object.keys(update.body.message).sort(),
            content: update.body.message.content.t,
        };
    }

    it('with the feature on and with SYNC_SUBSCRIBE_DISABLED=1, legacy pushes are identical in count and shape', async () => {
        const on = await legacyRun(false);
        const off = await legacyRun(true);
        for (const run of [on, off]) {
            const newMessages = run.web.updates.filter((u) => u.body?.t === 'new-message');
            // Exactly one push per committed message from every writer, in seq order.
            expect(newMessages.map((u) => u.body.message.seq)).toEqual(run.expected);
            expect(new Set(newMessages.map((u) => JSON.stringify(shapeOf(u))))).toEqual(new Set([JSON.stringify({
                keys: ['body', 'createdAt', 'id', 'seq'],
                body: ['message', 'sid', 't'],
                message: ['content', 'createdAt', 'id', 'localId', 'seq', 'updatedAt'],
                content: 'encrypted',
            })]));
            // An old CLI session socket keeps receiving every message through the session room
            // (the writers' own CLI socket is a different one, skipped as sender).
            expect(run.cli.updates.filter((u) => u.body?.t === 'new-message').map((u) => u.body.message.seq)).toEqual(run.expected);
            expect(run.cliHello).toEqual({ ok: false, error: 'unsupported_client' });
        }
        expect(on.webHello).toMatchObject({ ok: true });
        // Disabled: refused immediately, never an ok ack.
        expect(off.webHello).toEqual({ ok: false, error: 'disabled' });
    }, 60_000);
});
