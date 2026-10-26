import { describe, expect, it, vi } from 'vitest';
import {
    createSnapshotGate,
    createSocketRateLimiter,
    handleSessionSubscribe,
    handleSessionUnsubscribe,
    handleSyncHello,
    resolveSessionSyncConfig,
    resolveSnapshotConcurrency,
    sessionSyncHandler,
    snapshotShape,
    type SessionSyncContext,
    type SessionSyncDeps,
} from './sessionSyncHandler';

/** In-memory stand-in for the three statements the snapshot module issues (head batch, latest batch, increment batch). */
function fakeDb(sessions: Record<string, { accountId: string; seqs: number[] }>) {
    const calls: string[] = [];
    const client = {
        $queryRawUnsafe: vi.fn(async (sql: string, ...values: any[]): Promise<any> => {
            if (sql.includes('ANY($1::text[])')) {
                calls.push('heads');
                return (values[0] as string[]).filter((id) => sessions[id]).map((id) => ({
                    id, seq: Math.max(0, ...sessions[id].seqs), accountId: sessions[id].accountId,
                }));
            }
            const increment = sql.includes('"seq" > r.after_seq');
            calls.push(increment ? 'increment' : 'latest');
            const [sids, second, third] = values as [string[], number[], number[]];
            // Rows come back in reverse batch order: the module must not rely on row order.
            return sids.flatMap((sid, i): any[] => {
                const session = sessions[sid];
                if (!session) return [];
                const head = Math.max(0, ...session.seqs);
                const row = (seq: number) => ({ idx: i + 1, head, id: `m${seq}`, seq, content: { c: String(seq) }, localId: null, createdAt: new Date(1), updatedAt: new Date(2) });
                const rows = increment
                    ? session.seqs.filter((seq) => seq > second[i]).sort((x, y) => x - y).slice(0, third[i]).map(row)
                    : [...session.seqs].sort((x, y) => y - x).slice(0, second[i]).map(row);
                return rows.length > 0 ? rows : [{ idx: i + 1, head, id: null, seq: null, content: null, localId: null, createdAt: null, updatedAt: null }];
            }).reverse();
        }),
    };
    return { client, calls };
}

function makeCtx(options: {
    env?: Record<string, string>;
    sessions?: Record<string, { accountId: string; seqs: number[] }>;
    connectionType?: string;
    access?: (userId: string, sid: string) => unknown;
    gate?: SessionSyncDeps['gate'];
    client?: SessionSyncDeps['client'];
    rooms?: Set<string>;
} = {}) {
    const { client, calls } = fakeDb(options.sessions ?? {});
    const rooms = options.rooms ?? new Set(['user:u1:user-scoped']);
    const deps: SessionSyncDeps = {
        config: () => resolveSessionSyncConfig(options.env ?? {}),
        gate: options.gate ?? createSnapshotGate(32),
        client: options.client ?? client,
        resolveAccess: async (userId, sid) => options.access?.(userId, sid) ?? null,
        now: () => 1_000,
        random: () => 0.5,
    };
    const ctx: SessionSyncContext = {
        userId: 'u1',
        socket: { rooms, join: (room: string) => { rooms.add(room); }, data: {} } as any,
        connection: { connectionType: options.connectionType ?? 'user-scoped' },
        rateLimit: () => 0,
        deps,
    };
    return { ctx, calls, client };
}

const own = (seqs: number[]) => ({ accountId: 'u1', seqs });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('sync-hello', () => {
    it('answers each sub in order with head, increment and limits; v negotiated down', async () => {
        const { ctx } = makeCtx({ sessions: { a: own([1, 2, 3]), b: own([1]) } });
        const ack = await handleSyncHello(ctx, { v: 3, subs: [{ sid: 'a', afterSeq: 1 }, { sid: 'b', afterSeq: 1 }], reason: 'connect' });
        expect(ack).toMatchObject({ ok: true, v: 1, serverTime: 1_000, limits: { maxSubs: 16, maxLimit: 500, gapThreshold: 500 } });
        if (!ack.ok) throw new Error('unreachable');
        expect(ack.results).toEqual([
            { sid: 'a', ok: true, headSeq: 3, hasMore: false, messages: [
                { id: 'm2', seq: 2, content: { c: '2' }, localId: null, createdAt: 1, updatedAt: 2 },
                { id: 'm3', seq: 3, content: { c: '3' }, localId: null, createdAt: 1, updatedAt: 2 },
            ] },
            { sid: 'b', ok: true, headSeq: 1, hasMore: false, messages: [] },
        ]);
    });

    it('caught-up subs cost only the batched head read', async () => {
        const { ctx, calls } = makeCtx({ sessions: { a: own([1, 2]), b: own([4]) } });
        await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 2 }, { sid: 'b', afterSeq: 4 }] });
        expect(calls).toEqual(['heads']);
    });

    // B-821 (spec §4.4): statements per hello are bounded, not one per sub.
    it('a 16-sub cold hello is 2 statements; a mixed hello at most 3 — whatever the sub count', async () => {
        const sessions = Object.fromEntries(range(1, 16).map((i) => [`s${i}`, own(range(1, 30))]));
        const cold = makeCtx({ sessions });
        const coldAck = await handleSyncHello(cold.ctx, { v: 1, subs: range(1, 16).map((i) => ({ sid: `s${i}`, afterSeq: null, limit: 2 })) });
        expect(coldAck.ok && coldAck.results.every((r) => r.ok && r.messages.length === 2)).toBe(true);
        expect(cold.calls).toEqual(['heads', 'latest']);

        const mixed = makeCtx({ sessions, env: { SYNC_GAP_THRESHOLD: '10' } });
        const subs = range(1, 16).map((i) => ({ sid: `s${i}`, afterSeq: [null, 25, 30, 5][i % 4], limit: 3 }));
        const mixedAck = await handleSyncHello(mixed.ctx, { v: 1, subs });
        if (!mixedAck.ok) throw new Error('unreachable');
        expect(mixed.calls).toEqual(['heads', 'latest', 'increment']);
        // Every sub still gets ITS answer, in request order.
        mixedAck.results.forEach((result: any, i) => {
            const afterSeq = subs[i].afterSeq;
            expect(result.sid).toBe(subs[i].sid);
            const expected = afterSeq === null || afterSeq === 5 ? [28, 29, 30] : afterSeq === 25 ? [26, 27, 28] : [];
            expect(result.messages.map((m: any) => m.seq)).toEqual(expected);
            expect(!!result.gapTooLarge).toBe(afterSeq === 5);
        });
    });

    it('the same session asked twice in one hello gets two independent answers from one statement', async () => {
        const { ctx, calls } = makeCtx({ sessions: { a: own(range(1, 10)) } });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 2, limit: 2 }, { sid: 'a', afterSeq: 7, limit: 5 }] });
        if (!ack.ok) throw new Error('unreachable');
        expect(ack.results.map((r: any) => [r.messages.map((m: any) => m.seq), r.hasMore])).toEqual([[[3, 4], true], [[8, 9, 10], false]]);
        expect(calls).toEqual(['heads', 'increment']);
    });

    it('cold returns the latest page ascending with oldestSeq; limit clamps to 500', async () => {
        const { ctx, client } = makeCtx({ sessions: { a: own(range(1, 800)) } });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: null, limit: 3 }, { sid: 'a', afterSeq: null, limit: 10_000 }] });
        if (!ack.ok) throw new Error('unreachable');
        const [small, big] = ack.results as any[];
        expect(small.messages.map((m: any) => m.seq)).toEqual([798, 799, 800]);
        expect(small).toMatchObject({ oldestSeq: 798, hasMore: false, headSeq: 800 });
        expect(small).not.toHaveProperty('gapTooLarge');
        expect(big.messages).toHaveLength(500);
        expect(client.$queryRawUnsafe.mock.calls.some((call: any[]) => Array.isArray(call[2]) && call[2].includes(500))).toBe(true);
    });

    it('gapTooLarge: 500 behind is an increment, 501 behind is the latest page', async () => {
        const { ctx } = makeCtx({ sessions: { a: own(range(1, 1000)) } });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 500, limit: 5 }, { sid: 'a', afterSeq: 499, limit: 5 }] });
        if (!ack.ok) throw new Error('unreachable');
        const [atThreshold, past] = ack.results as any[];
        expect(atThreshold.messages.map((m: any) => m.seq)).toEqual([501, 502, 503, 504, 505]);
        expect(atThreshold).toMatchObject({ hasMore: true });
        expect(past).toMatchObject({ gapTooLarge: true, oldestSeq: 996, hasMore: false });
        expect(past.messages.map((m: any) => m.seq)).toEqual([996, 997, 998, 999, 1000]);
    });

    it('SYNC_GAP_THRESHOLD is honoured and echoed', async () => {
        const { ctx } = makeCtx({ env: { SYNC_GAP_THRESHOLD: '10' }, sessions: { a: own(range(1, 30)) } });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 19 }] });
        if (!ack.ok) throw new Error('unreachable');
        expect(ack.limits.gapThreshold).toBe(10);
        expect(ack.results[0]).toMatchObject({ gapTooLarge: true });
    });

    it('not_found for missing, foreign and revoked sessions — indistinguishable', async () => {
        const { ctx } = makeCtx({
            sessions: { mine: own([1]), foreign: { accountId: 'u2', seqs: [1] }, shared: { accountId: 'u2', seqs: [1, 2] } },
            access: (_user, sid) => sid === 'shared' ? { kind: 'grant' } : null,
        });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [
            { sid: 'missing', afterSeq: 0 }, { sid: 'foreign', afterSeq: 0 }, { sid: 'shared', afterSeq: 1 }, { sid: 'mine', afterSeq: 0 },
        ] });
        if (!ack.ok) throw new Error('unreachable');
        expect(ack.results[0]).toEqual({ sid: 'missing', ok: false, error: 'not_found' });
        expect(ack.results[1]).toEqual({ sid: 'foreign', ok: false, error: 'not_found' });
        expect(ack.results[2]).toMatchObject({ sid: 'shared', ok: true, headSeq: 2 });
        expect(ack.results[3]).toMatchObject({ sid: 'mine', ok: true });
    });

    it('the 17th sub onwards gets too_many_subscriptions; more than 64 is invalid', async () => {
        const sessions = Object.fromEntries(range(1, 18).map((i) => [`s${i}`, own([1])]));
        const { ctx } = makeCtx({ sessions });
        const ack = await handleSyncHello(ctx, { v: 1, subs: range(1, 18).map((i) => ({ sid: `s${i}`, afterSeq: 1 })) });
        if (!ack.ok) throw new Error('unreachable');
        expect(ack.results).toHaveLength(18);
        expect(ack.results.slice(0, 16).every((r) => r.ok)).toBe(true);
        expect(ack.results.slice(16)).toEqual([
            { sid: 's17', ok: false, error: 'too_many_subscriptions' },
            { sid: 's18', ok: false, error: 'too_many_subscriptions' },
        ]);
        expect(await handleSyncHello(ctx, { v: 1, subs: range(1, 65).map((i) => ({ sid: `s${i}`, afterSeq: 1 })) }))
            .toEqual({ ok: false, error: 'invalid_request' });
    });

    it('invalid_request on schema mismatch and v < 1', async () => {
        const { ctx } = makeCtx();
        for (const bad of [null, 'x', {}, { v: 1, subs: [{ sid: 'a' }] }, { v: 0, subs: [] }]) {
            expect(await handleSyncHello(ctx, bad)).toEqual({ ok: false, error: 'invalid_request' });
        }
    });

    // Review S1: `reason` is diagnostics only — an overlong one must not turn the hello into invalid_request (→ legacy).
    it('an overlong reason is accepted', async () => {
        const { ctx } = makeCtx({ sessions: { a: own([1]) } });
        const ack = await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }], reason: 'x'.repeat(500) });
        expect(ack).toMatchObject({ ok: true, results: [{ sid: 'a', ok: true }] });
    });

    it('a hello rebuilds the subscription table', async () => {
        const { ctx } = makeCtx({ sessions: { a: own([1]), b: own([1]), c: own([1]) } });
        await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }, { sid: 'b', afterSeq: 0 }] });
        expect([...ctx.socket.data.syncSubs.keys()]).toEqual(['a', 'b']);
        await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'c', afterSeq: 0 }, { sid: 'gone', afterSeq: 0 }] });
        expect([...ctx.socket.data.syncSubs.keys()]).toEqual(['c']);
    });

    it('joins the user-scoped room before reading when it is somehow not in it (§4.2 precondition)', async () => {
        const rooms = new Set<string>();
        const order: string[] = [];
        const { ctx } = makeCtx({ rooms, sessions: { a: own([1]) } });
        ctx.socket.join = ((room: string) => { order.push(`join:${room}`); rooms.add(room); }) as any;
        const query = ctx.deps.client.$queryRawUnsafe;
        ctx.deps.client = { $queryRawUnsafe: (async (...args: any[]) => { order.push('read'); return (query as any)(...args); }) as any };
        await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] });
        expect(order[0]).toBe('join:user:u1:user-scoped');
        expect(order).toContain('read');
    });

    it('DB failure → unavailable, never a thrown ack', async () => {
        const { ctx } = makeCtx({ client: { $queryRawUnsafe: async () => { throw new Error('connection reset'); } } as any });
        expect(await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] })).toEqual({ ok: false, error: 'unavailable' });
    });

    it('a snapshot slower than the deadline → unavailable', async () => {
        vi.useFakeTimers();
        try {
            const { ctx } = makeCtx({ client: { $queryRawUnsafe: () => new Promise(() => {}) } as any });
            const pending = handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] });
            await vi.advanceTimersByTimeAsync(1_600);
            expect(await pending).toEqual({ ok: false, error: 'unavailable' });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('switches and client types (§6.1, §9.1-7/8)', () => {
    it('SYNC_SUBSCRIBE_DISABLED=1: disabled for every op, and the DB is never touched', async () => {
        const { ctx, calls } = makeCtx({ env: { SYNC_SUBSCRIBE_DISABLED: '1' }, sessions: { a: own([1]) } });
        expect(await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] })).toEqual({ ok: false, error: 'disabled' });
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 })).toEqual({ sid: 'a', ok: false, error: 'disabled' });
        expect(handleSessionUnsubscribe(ctx, { v: 1, sid: 'a' })).toEqual({ ok: false, error: 'disabled' });
        expect(calls).toEqual([]);
    });

    it('SYNC_SUBSCRIBE_ACCOUNTS: only listed accounts get ok', async () => {
        const listed = makeCtx({ env: { SYNC_SUBSCRIBE_ACCOUNTS: 'u9, u1' }, sessions: { a: own([1]) } });
        expect(await handleSyncHello(listed.ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] })).toMatchObject({ ok: true });
        const unlisted = makeCtx({ env: { SYNC_SUBSCRIBE_ACCOUNTS: 'u9' }, sessions: { a: own([1]) } });
        expect(await handleSyncHello(unlisted.ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] })).toEqual({ ok: false, error: 'disabled' });
        expect(unlisted.calls).toEqual([]);
    });

    it('session-scoped (CLI) and machine-scoped sockets get unsupported_client', async () => {
        for (const connectionType of ['session-scoped', 'machine-scoped']) {
            const { ctx, calls } = makeCtx({ connectionType, sessions: { a: own([1]) } });
            expect(await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] })).toEqual({ ok: false, error: 'unsupported_client' });
            expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 })).toEqual({ sid: 'a', ok: false, error: 'unsupported_client' });
            expect(calls).toEqual([]);
        }
    });
});

describe('session-subscribe / unsubscribe', () => {
    it('returns a SubResult and records the subscription; unsubscribe removes it', async () => {
        const { ctx } = makeCtx({ sessions: { a: own([1, 2]) } });
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 1 })).toMatchObject({ sid: 'a', ok: true, headSeq: 2, hasMore: false });
        expect(ctx.socket.data.syncSubs.get('a')).toEqual({ since: 1_000, afterSeqAtAck: 2 });
        expect(handleSessionUnsubscribe(ctx, { v: 1, sid: 'a' })).toEqual({ ok: true });
        expect(ctx.socket.data.syncSubs.has('a')).toBe(false);
        expect(handleSessionUnsubscribe(ctx, { v: 1 })).toEqual({ ok: false, error: 'invalid_request' });
    });

    it('a 17th distinct subscription is refused before any DB work; re-subscribing a held one is fine', async () => {
        const sessions = Object.fromEntries(range(1, 17).map((i) => [`s${i}`, own([1])]));
        const { ctx, calls } = makeCtx({ sessions });
        for (const i of range(1, 16)) expect(await handleSessionSubscribe(ctx, { v: 1, sid: `s${i}`, afterSeq: 1 })).toMatchObject({ ok: true });
        calls.length = 0;
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 's17', afterSeq: 1 })).toEqual({ sid: 's17', ok: false, error: 'too_many_subscriptions' });
        expect(calls).toEqual([]);
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 's3', afterSeq: 1 })).toMatchObject({ ok: true });
    });

    it('not_found drops a held subscription (revoked / deleted)', async () => {
        const sessions: Record<string, { accountId: string; seqs: number[] }> = { a: own([1]) };
        const { ctx } = makeCtx({ sessions });
        await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 });
        delete sessions.a;
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 })).toEqual({ sid: 'a', ok: false, error: 'not_found' });
        expect(ctx.socket.data.syncSubs.has('a')).toBe(false);
    });
});

describe('rate limit (§4.4)', () => {
    it('20 hello+subscribe per 10s per socket, then rate_limited with the time until a slot frees', () => {
        let t = 0;
        const limit = createSocketRateLimiter({ max: 20, windowMs: 10_000 }, () => t);
        for (let i = 0; i < 20; i += 1) { expect(limit()).toBe(0); t += 100; }
        expect(limit()).toBe(10_000 - 2_000);
        t = 10_000;
        expect(limit()).toBe(0);
    });

    it('the limiter is shared by hello and subscribe on one socket', async () => {
        const { ctx } = makeCtx({ sessions: { a: own([1]) } });
        let t = 0;
        ctx.rateLimit = createSocketRateLimiter({ max: 2, windowMs: 10_000 }, () => t);
        expect(await handleSyncHello(ctx, { v: 1, subs: [] })).toMatchObject({ ok: true });
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 })).toMatchObject({ ok: true });
        expect(await handleSyncHello(ctx, { v: 1, subs: [] })).toEqual({ ok: false, error: 'rate_limited', retryAfterMs: 10_000 });
        expect(await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: 0 })).toEqual({ sid: 'a', ok: false, error: 'rate_limited', retryAfterMs: 10_000 });
    });
});

describe('gate size follows Prisma connection_limit (B-821, §4.4)', () => {
    const url = (query: string) => `postgresql://u:p@pool:6432/happy?pgbouncer=true${query}`;

    it('defaults to half the pool, at least 1', () => {
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('&connection_limit=20') })).toBe(10);
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('&connection_limit=16') })).toBe(8);
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('&connection_limit=1') })).toBe(1);
    });

    it('an explicit SYNC_HELLO_MAX_CONCURRENCY is honoured but never exceeds connection_limit', () => {
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('&connection_limit=20'), SYNC_HELLO_MAX_CONCURRENCY: '6' })).toBe(6);
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('&connection_limit=20'), SYNC_HELLO_MAX_CONCURRENCY: '32' })).toBe(20);
    });

    it('no connection_limit (local / PGlite): 10, or the explicit value', () => {
        expect(resolveSnapshotConcurrency({})).toBe(10);
        expect(resolveSnapshotConcurrency({ DATABASE_URL: url('') })).toBe(10);
        expect(resolveSnapshotConcurrency({ DATABASE_URL: 'not a url' })).toBe(10);
        expect(resolveSnapshotConcurrency({ SYNC_HELLO_MAX_CONCURRENCY: '32' })).toBe(32);
        expect(resolveSessionSyncConfig({ DATABASE_URL: url('&connection_limit=20') }).maxConcurrency).toBe(10);
    });
});

describe('snapshot shape label (B-821, §4.7)', () => {
    it('cold = every sub afterSeq null, warm = none, mixed = both; an empty hello is warm', () => {
        expect(snapshotShape([{ afterSeq: null }, { afterSeq: null }])).toBe('cold');
        expect(snapshotShape([{ afterSeq: 0 }, { afterSeq: 9 }])).toBe('warm');
        expect(snapshotShape([{ afterSeq: null }, { afterSeq: 9 }])).toBe('mixed');
        expect(snapshotShape([])).toBe('warm');
    });

    it('the duration histogram is observed with op and shape', async () => {
        const metrics = await import('@/app/monitoring/metrics2');
        const observe = vi.spyOn(metrics.syncSnapshotDuration, 'observe');
        try {
            const { ctx } = makeCtx({ sessions: { a: own([1, 2]) } });
            await handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: null }, { sid: 'a', afterSeq: 1 }] });
            await handleSessionSubscribe(ctx, { v: 1, sid: 'a', afterSeq: null });
            expect(observe.mock.calls.map((call) => call[0])).toEqual([{ op: 'hello', shape: 'mixed' }, { op: 'subscribe', shape: 'cold' }]);
        } finally {
            observe.mockRestore();
        }
    });
});

describe('concurrency gate (§4.4, §9.1-5)', () => {
    it('admits up to the limit, then serves waiters strictly FIFO', async () => {
        const gate = createSnapshotGate(2);
        const a = await gate.acquire(1_000);
        const b = await gate.acquire(1_000);
        const order: string[] = [];
        const waiters = ['c', 'd', 'e'].map((name) => gate.acquire(1_000).then((release) => { order.push(name); return release!; }));
        expect(gate.queued).toBe(3);
        a!();
        const c = await waiters[0];
        b!();
        const d = await waiters[1];
        c();
        const e = await waiters[2];
        expect(order).toEqual(['c', 'd', 'e']);
        d(); e();
        expect(gate.active).toBe(0);
    });

    it('does not starve: under constant churn every waiter is eventually admitted in arrival order', async () => {
        const gate = createSnapshotGate(3);
        const admitted: number[] = [];
        await Promise.all(range(1, 200).map(async (i) => {
            const release = await gate.acquire(60_000);
            admitted.push(i);
            await new Promise((resolve) => setTimeout(resolve, i % 3));
            release!();
        }));
        expect(admitted).toEqual(range(1, 200));
        expect(gate.active).toBe(0);
    });

    // Review M1: the gate bounds concurrent snapshot STATEMENTS (spec §4.4), not requests —
    // a 16-sub cold hello under one slot used to run 16 statements at once (Promise.all).
    // B-821: the latest and increment batches of one hello are statements too — still one at a time.
    it('gate(1): a 16-sub cold + increment hello (owners and grantees) and a parallel subscribe never run more than one statement at a time', async () => {
        const sessions: Record<string, { accountId: string; seqs: number[] }> = {};
        for (let i = 0; i < 16; i += 1) sessions[`s${i}`] = { accountId: i % 4 === 0 ? 'other' : 'u1', seqs: range(1, 5) };
        let running = 0;
        let peak = 0;
        const track = async <T>(work: () => Promise<T>): Promise<T> => {
            running += 1;
            peak = Math.max(peak, running);
            try {
                await new Promise((resolve) => setTimeout(resolve, 1));
                return await work();
            } finally {
                running -= 1;
            }
        };
        const { client } = fakeDb(sessions);
        const tracked = { $queryRawUnsafe: (...args: any[]) => track(() => (client.$queryRawUnsafe as any)(...args)) } as any;
        const gate = createSnapshotGate(1);
        const { ctx } = makeCtx({ gate, client: tracked, sessions, access: () => ({ role: 'grantee' }) });
        // Grant lookups are statements too.
        ctx.deps.resolveAccess = (userId, sid) => track(async () => ({ role: 'grantee', userId, sid }) as any);
        const subs = Object.keys(sessions).map((sid, i) => ({ sid, afterSeq: i % 2 === 0 ? null : 2 }));
        const [hello, subscribe] = await Promise.all([
            handleSyncHello(ctx, { v: 1, subs }),
            handleSessionSubscribe(ctx, { v: 1, sid: 's1', afterSeq: 2 }),
        ]);
        expect(hello.ok).toBe(true);
        expect((hello as any).results.map((r: any) => r.ok && r.messages.length)).toEqual(subs.map((sub) => sub.afterSeq === null ? 5 : 3));
        expect(subscribe).toMatchObject({ ok: true, messages: [{ seq: 3 }, { seq: 4 }, { seq: 5 }] });
        expect(peak).toBe(1);
    });

    it('a release is idempotent', async () => {
        const gate = createSnapshotGate(1);
        const release = await gate.acquire(1_000);
        release!(); release!();
        expect(gate.active).toBe(0);
        expect(await gate.acquire(10)).not.toBeNull();
        expect(gate.active).toBe(1);
    });

    it('queue wait over 3s → unavailable with a 500–1500ms retryAfter, and the waiter leaves the queue', async () => {
        vi.useFakeTimers();
        try {
            const gate = createSnapshotGate(1);
            const hold = await gate.acquire(1_000);
            const { ctx } = makeCtx({ gate, sessions: { a: own([1]) } });
            ctx.deps.random = () => 0.999;
            const pending = handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] });
            await vi.advanceTimersByTimeAsync(3_001);
            const ack = await pending;
            expect(ack).toMatchObject({ ok: false, error: 'unavailable' });
            expect((ack as any).retryAfterMs).toBeGreaterThanOrEqual(500);
            expect((ack as any).retryAfterMs).toBeLessThanOrEqual(1_500);
            expect(gate.queued).toBe(0);
            hold!();
            expect(gate.active).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the slot until a timed-out query really settles', async () => {
        vi.useFakeTimers();
        try {
            const gate = createSnapshotGate(1);
            let finish!: (rows: unknown) => void;
            const client = { $queryRawUnsafe: () => new Promise((resolve) => { finish = resolve; }) } as any;
            const { ctx } = makeCtx({ gate, client });
            const pending = handleSyncHello(ctx, { v: 1, subs: [{ sid: 'a', afterSeq: 0 }] });
            await vi.advanceTimersByTimeAsync(1_600);
            expect(await pending).toEqual({ ok: false, error: 'unavailable' });
            expect(gate.active).toBe(1);
            finish([]);
            await vi.advanceTimersByTimeAsync(0);
            expect(gate.active).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('socket wiring', () => {
    function fakeSocket() {
        const handlers = new Map<string, (...args: any[]) => unknown>();
        const socket = { on: (event: string, fn: any) => handlers.set(event, fn), rooms: new Set(['user:u1:user-scoped']), join: () => {}, data: {} } as any;
        return { socket, handlers };
    }

    it('registers the three events; an event without an ack callback is ignored', async () => {
        const { socket, handlers } = fakeSocket();
        const { ctx } = makeCtx({ sessions: { a: own([1]) } });
        sessionSyncHandler('u1', socket, { connectionType: 'user-scoped' }, ctx.deps);
        expect([...handlers.keys()]).toEqual(['sync-hello', 'session-subscribe', 'session-unsubscribe', 'disconnect']);
        await expect(handlers.get('sync-hello')!({ v: 1, subs: [] })).resolves.toBeUndefined();
        const ack = vi.fn();
        await handlers.get('sync-hello')!({ v: 1, subs: [{ sid: 'a', afterSeq: 0 }] }, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('disconnect releases the table; a late ack does not re-grow it', async () => {
        const { socket, handlers } = fakeSocket();
        let release!: () => void;
        const gate = createSnapshotGate(1);
        const hold = await gate.acquire(1_000);
        release = hold!;
        const { ctx } = makeCtx({ gate, sessions: { a: own([1]) } });
        sessionSyncHandler('u1', socket, { connectionType: 'user-scoped' }, ctx.deps);
        const ack = vi.fn();
        const pending = handlers.get('session-subscribe')!({ v: 1, sid: 'a', afterSeq: 0 }, ack);
        handlers.get('disconnect')!();
        release();
        await pending;
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        expect(socket.data.syncSubs.size).toBe(0);
    });
});
