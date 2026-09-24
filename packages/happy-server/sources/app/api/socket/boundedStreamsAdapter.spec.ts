import { describe, expect, it, vi } from 'vitest';
import {
    boundedRestoreSession,
    createBoundedStreamsAdapter,
    defaultRecoveryLimits,
    RecoveryGate,
    SOCKET_STREAM_MAX_LEN,
    type BoundedRestoreDeps,
    type RecoveryLimits,
    type RecoveryOutcome,
} from './boundedStreamsAdapter';

// B-494 regression: recovery storms must not produce unbounded Redis replies,
// and recovery reads must not share a connection with XADD.

const NOW = 1_790_000_000_000;
const STREAM = 'vh:test';

type Entry = [string, string[]];

function broadcastEntry(id: string, rooms: string[], event: string, nsp = '/'): Entry {
    const data = JSON.stringify({
        packet: { type: 2, data: [event], nsp },
        opts: { rooms, except: [], flags: {} },
    });
    return [id, ['uid', 'other-node', 'nsp', nsp, 'type', '3', 'data', data]];
}

function heartbeatEntry(id: string): Entry {
    return [id, ['uid', 'other-node', 'nsp', '/', 'type', '0']];
}

/** In-memory stream that honours XRANGE start/end/COUNT the way Redis does. */
function fakeStream(entries: Entry[]) {
    const cmp = (a: string, b: string) => {
        const [am, as] = a.split('-').map(Number);
        const [bm, bs] = b.split('-').map(Number);
        return am - bm || as - bs;
    };
    const xrange = vi.fn(async (_key: string, start: string, end: string, _c: 'COUNT', count: number) => {
        return entries
            .filter(([id]) => cmp(id, start) >= 0 && (end === '+' || cmp(id, end) <= 0))
            .slice(0, count);
    });
    return { xrange };
}

function fakePublish(session: unknown | null) {
    const exec = vi.fn(async () => [[null, session === null ? null : JSON.stringify(session)], [null, 1]]);
    const multi = vi.fn(() => {
        const chain: any = { get: vi.fn(() => chain), del: vi.fn(() => chain), exec };
        return chain;
    });
    return { multi, exec };
}

const adapter = {
    nsp: { name: '/' },
    constructor: {
        decode(raw: Record<string, string>) {
            return { uid: raw.uid, nsp: raw.nsp, type: Number(raw.type), data: raw.data ? JSON.parse(raw.data) : undefined };
        },
    },
};

function limits(overrides: Partial<RecoveryLimits> = {}): RecoveryLimits {
    return { ...defaultRecoveryLimits(30_000), ...overrides };
}

function deps(
    entries: Entry[],
    session: unknown | null,
    overrides: Partial<RecoveryLimits> = {},
    gate?: RecoveryGate,
) {
    const outcomes: Array<[RecoveryOutcome, number]> = [];
    const restore = fakeStream(entries);
    const publish = fakePublish(session);
    const l = limits(overrides);
    const d: BoundedRestoreDeps = {
        publish,
        restore,
        streamName: STREAM,
        sessionKeyPrefix: 'vh:sio:session:',
        limits: l,
        gate: gate ?? new RecoveryGate(l.maxConcurrent, l.queueTimeoutMs),
        decodeSession: (raw) => JSON.parse(raw),
        now: () => NOW,
        observer: { onOutcome: (o, n) => outcomes.push([o, n]) },
    };
    return { d, restore, publish, outcomes };
}

const SESSION = { sid: 's1', pid: 'p1', rooms: ['user:a'], data: {} };

describe('SOCKET_STREAM_MAX_LEN', () => {
    it('keeps minutes, not the ~35 minutes that let one restore pull 200k entries', () => {
        // ~90 entries/s in production: 20k ≈ 3.7 min, ~7x the 30 s recovery window.
        expect(SOCKET_STREAM_MAX_LEN).toBe(20_000);
        expect(SOCKET_STREAM_MAX_LEN / 90).toBeGreaterThan(defaultRecoveryLimits(30_000).maxOffsetAgeMs / 1000 * 3);
    });
});

describe('boundedRestoreSession', () => {
    it('replays missed packets for the session rooms, paging with COUNT', async () => {
        const base = NOW - 5_000;
        const entries: Entry[] = [
            broadcastEntry(`${base}-0`, ['user:a'], 'before'),
            broadcastEntry(`${base + 1}-0`, ['user:a'], 'missed-1'),
            heartbeatEntry(`${base + 2}-0`),
            broadcastEntry(`${base + 3}-0`, ['user:b'], 'other-user'),
            broadcastEntry(`${base + 4}-0`, [], 'everyone'),
            broadcastEntry(`${base + 5}-0`, ['user:a'], 'missed-2'),
        ];
        const { d, restore, outcomes } = deps(entries, SESSION, { pageSize: 2 });
        const session = await boundedRestoreSession(adapter, d, 'p1', `${base}-0`);
        expect(session.missedPackets).toEqual([
            ['missed-1', `${base + 1}-0`],
            ['everyone', `${base + 4}-0`],
            ['missed-2', `${base + 5}-0`],
        ]);
        // Every XRANGE carries a COUNT — the unbounded `XRANGE offset +` is gone.
        for (const call of restore.xrange.mock.calls) {
            expect(call[3]).toBe('COUNT');
            expect(call[4]).toBeLessThanOrEqual(2);
        }
        expect(outcomes).toEqual([['recovered', 5]]);
    });

    it('gives up without touching Redis when the offset is older than the window', async () => {
        const { d, restore, publish, outcomes } = deps([], SESSION);
        const stale = `${NOW - 60_001}-0`;
        await expect(boundedRestoreSession(adapter, d, 'p1', stale)).rejects.toThrow('offset_too_old');
        expect(restore.xrange).not.toHaveBeenCalled();
        expect(publish.multi).not.toHaveBeenCalled();
        expect(outcomes).toEqual([['offset_too_old', 0]]);
    });

    it('rejects malformed offsets', async () => {
        const { d, outcomes } = deps([], SESSION);
        await expect(boundedRestoreSession(adapter, d, 'p1', '$')).rejects.toThrow('invalid_offset');
        expect(outcomes[0][0]).toBe('invalid_offset');
    });

    it('rejects when the offset was trimmed out of the stream', async () => {
        const base = NOW - 1_000;
        const { d, outcomes } = deps([broadcastEntry(`${base + 1}-0`, [], 'x')], SESSION);
        await expect(boundedRestoreSession(adapter, d, 'p1', `${base}-0`)).rejects.toThrow('offset_missing');
        expect(outcomes[0][0]).toBe('offset_missing');
    });

    it('rejects when the persisted session expired', async () => {
        const base = NOW - 1_000;
        const { d, outcomes } = deps([broadcastEntry(`${base}-0`, [], 'x')], null);
        await expect(boundedRestoreSession(adapter, d, 'p1', `${base}-0`)).rejects.toThrow('session_missing');
        expect(outcomes[0][0]).toBe('session_missing');
    });

    it('stops scanning past maxScanEntries instead of reading the whole tail', async () => {
        const base = NOW - 10_000;
        const entries: Entry[] = [];
        for (let i = 0; i < 50; i++) entries.push(broadcastEntry(`${base}-${i}`, ['user:a'], `e${i}`));
        const { d, restore, outcomes } = deps(entries, SESSION, { pageSize: 5, maxScanEntries: 12 });
        await expect(boundedRestoreSession(adapter, d, 'p1', `${base}-0`)).rejects.toThrow('scan_limit');
        // offset check + 3 pages (5 + 5 + 5 > 12), never the remaining 34 entries
        expect(restore.xrange).toHaveBeenCalledTimes(4);
        expect(outcomes).toEqual([['scan_limit', 15]]);
    });

    it('bounds concurrent restores and gives up after the queue timeout', async () => {
        vi.useFakeTimers();
        try {
            const gate = new RecoveryGate(1, 100);
            expect(await gate.acquire()).toBe(true);
            const base = NOW - 1_000;
            const { d, outcomes } = deps([broadcastEntry(`${base}-0`, [], 'x')], SESSION, {}, gate);
            const pending = boundedRestoreSession(adapter, d, 'p1', `${base}-0`);
            const settled = expect(pending).rejects.toThrow('busy');
            await vi.advanceTimersByTimeAsync(101);
            await settled;
            expect(outcomes[0][0]).toBe('busy');
            gate.release();
            expect(gate.inFlight).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hands a freed slot to the next waiter', async () => {
        const gate = new RecoveryGate(1, 1_000);
        expect(await gate.acquire()).toBe(true);
        const waiter = gate.acquire();
        gate.release();
        await expect(waiter).resolves.toBe(true);
        expect(gate.inFlight).toBe(1);
    });
});

describe('createBoundedStreamsAdapter connection split', () => {
    it('routes XADD to publish, XREAD to poll and recovery XRANGE to restore', async () => {
        const calls: Record<string, string[]> = { publish: [], poll: [], restore: [] };
        const make = (role: string) => new Proxy({}, {
            get(_t, prop: string) {
                return (...args: any[]) => {
                    calls[role].push(prop);
                    if (prop === 'xread') return new Promise((r) => setTimeout(() => r(null), 5));
                    if (prop === 'xadd') {
                        const flat = args.flat();
                        calls[role].push(`xadd-args:${flat.slice(1, 4).join(' ')}`);
                        return Promise.resolve(`${Date.now()}-0`);
                    }
                    if (prop === 'xrange') return Promise.resolve([]);
                    if (prop === 'multi') {
                        const chain: any = { get: () => chain, del: () => chain, exec: async () => [[null, null], [null, 0]] };
                        return chain;
                    }
                    return Promise.resolve('OK');
                };
            },
        }) as any;
        const connections = { publish: make('publish'), poll: make('poll'), restore: make('restore') };
        const factory = createBoundedStreamsAdapter(connections, {
            streamName: STREAM,
            sessionKeyPrefix: 'vh:sio:session:',
            maxLen: SOCKET_STREAM_MAX_LEN,
            readCount: 100,
            heartbeatInterval: 60_000,
            heartbeatTimeout: 120_000,
            limits: limits(),
            decodeSession: (raw) => JSON.parse(raw),
        });
        const nsp = {
            name: '/',
            sockets: new Map(),
            server: { opts: { connectionStateRecovery: { maxDisconnectionDuration: 30_000 } }, encoder: { encode: (p: unknown) => [p] } },
        };
        // socket.io constructs the adapter with `new` (namespace._initAdapter).
        const instance = new (factory as any)(nsp);
        await instance.broadcast({ type: 2, data: ['hello'], nsp: '/' }, { rooms: new Set(['r']), except: new Set(), flags: {} });
        await expect(instance.restoreSession('p1', `${Date.now() - 1_000}-0`)).rejects.toThrow('session_missing');
        await new Promise((r) => setTimeout(r, 20));
        instance.close();

        expect(calls.publish).toContain('xadd');
        expect(calls.publish).toContain(`xadd-args:MAXLEN ~ ${SOCKET_STREAM_MAX_LEN}`);
        expect(calls.publish).not.toContain('xread');
        expect(calls.publish).not.toContain('xrange');
        expect(calls.poll).toEqual(expect.arrayContaining(['xread']));
        expect(calls.poll.filter((c) => c !== 'xread')).toEqual([]);
        expect(calls.restore).toContain('xrange');
        expect(calls.restore.filter((c) => c !== 'xrange')).toEqual([]);
    });
});

describe('boundedRestoreSession deadline', () => {
    it('gives up on a hung connection and frees the slot when it settles', async () => {
        vi.useFakeTimers();
        try {
            const base = NOW - 1_000;
            const { d, publish, outcomes } = deps([broadcastEntry(`${base}-0`, [], 'x')], SESSION, { deadlineMs: 200 });
            let unblock!: () => void;
            publish.exec.mockImplementationOnce(() => new Promise((r) => { unblock = () => r([[null, null], [null, 0]]); }));
            const pending = boundedRestoreSession(adapter, d, 'p1', `${base}-0`);
            const settled = expect(pending).rejects.toThrow('timeout');
            await vi.advanceTimersByTimeAsync(201);
            await settled;
            expect(outcomes).toEqual([['timeout', 0]]);
            expect(d.gate.inFlight).toBe(1);
            unblock();
            await vi.advanceTimersByTimeAsync(0);
            expect(d.gate.inFlight).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
