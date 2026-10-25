/**
 * B-812 (B-807 spec §5.3, §9.2-1): the per-session state machine, one case
 * per table row.
 */
import { describe, expect, it } from 'vitest';
import { initialSyncState, transition, UNAVAILABLE_BACKOFF_MS, type SessionSyncState, type SyncEvent } from './sessionSyncState';

const at = (phase: SessionSyncState['phase'], extra: Partial<SessionSyncState> = {}): SessionSyncState => ({ ...initialSyncState(), phase, ...extra });

type Row = { name: string; from: SessionSyncState; event: SyncEvent; phase: SessionSyncState['phase']; effects: unknown[]; staleReason?: string };

const rows: Row[] = [
    { name: '(none) OPEN, no cache → loading, subscribe(null)', from: initialSyncState(), event: { t: 'open', anchored: false }, phase: 'loading', effects: [{ t: 'subscribe', cold: true }] },
    { name: '(none) OPEN, cached / anchored → syncing, subscribe(lastSeq)', from: initialSyncState(), event: { t: 'open', anchored: true }, phase: 'syncing', effects: [{ t: 'subscribe', cold: false }] },
    { name: 'loading ACK ok, !hasMore, head proved → live', from: at('loading'), event: { t: 'ack', outcome: { t: 'live' } }, phase: 'live', effects: [] },
    { name: 'syncing ACK ok, !hasMore, head proved (also a holed session) → live', from: at('syncing'), event: { t: 'ack', outcome: { t: 'live' } }, phase: 'live', effects: [] },
    { name: 'syncing ACK headSeq < request afterSeq → loading, invalidate, subscribe(null)', from: at('syncing'), event: { t: 'ack', outcome: { t: 'head-behind' } }, phase: 'loading', effects: [{ t: 'invalidate' }, { t: 'subscribe', cold: true }] },
    { name: 'syncing ACK hasMore → unchanged, continue', from: at('syncing'), event: { t: 'ack', outcome: { t: 'more' } }, phase: 'syncing', effects: [{ t: 'subscribe', cold: false }] },
    { name: 'loading ACK hasMore → unchanged, continue', from: at('loading'), event: { t: 'ack', outcome: { t: 'more' } }, phase: 'loading', effects: [{ t: 'subscribe', cold: false }] },
    { name: 'syncing ACK gapTooLarge (merged as the latest page, head proved) → live', from: at('syncing'), event: { t: 'ack', outcome: { t: 'live' } }, phase: 'live', effects: [] },
    { name: 'live PUSH gap, reorder window closed → syncing, subscribe', from: at('live'), event: { t: 'push-gap' }, phase: 'syncing', effects: [{ t: 'subscribe', cold: false }] },
    { name: 'live RESUME → syncing (hello by the scheduler)', from: at('live'), event: { t: 'resume' }, phase: 'syncing', effects: [] },
    { name: 'live CONNECT → syncing (hello by the scheduler)', from: at('live'), event: { t: 'connect' }, phase: 'syncing', effects: [] },
    { name: 'any SOCKET_DOWN → stale(socket), data kept', from: at('live'), event: { t: 'socket-down' }, phase: 'stale', effects: [], staleReason: 'socket' },
    { name: 'any OFFLINE → stale(offline)', from: at('syncing'), event: { t: 'offline' }, phase: 'stale', effects: [], staleReason: 'offline' },
    { name: 'syncing ACK timeout → stale(timeout), checkLiveness', from: at('syncing'), event: { t: 'ack-timeout' }, phase: 'stale', effects: [{ t: 'check-liveness' }], staleReason: 'timeout' },
    { name: 'syncing 3rd unavailable → stale(server), one REST fallback', from: at('syncing', { unavailableStreak: 2 }), event: { t: 'ack-error', error: 'unavailable' }, phase: 'stale', effects: [{ t: 'rest' }], staleReason: 'server' },
    { name: 'stale CONNECT → syncing', from: at('stale', { staleReason: 'socket' }), event: { t: 'connect' }, phase: 'syncing', effects: [] },
    { name: 'stale ONLINE → syncing', from: at('stale', { staleReason: 'offline' }), event: { t: 'online' }, phase: 'syncing', effects: [] },
    { name: 'stale RETRY → syncing', from: at('stale', { staleReason: 'timeout' }), event: { t: 'retry' }, phase: 'syncing', effects: [] },
    { name: 'any ACK disabled → legacy for the connection', from: at('syncing'), event: { t: 'ack-error', error: 'disabled' }, phase: 'syncing', effects: [{ t: 'legacy' }] },
    { name: 'any ACK unsupported_client → legacy', from: at('live'), event: { t: 'ack-error', error: 'unsupported_client' }, phase: 'live', effects: [{ t: 'legacy' }] },
    { name: 'any ACK invalid_request → legacy (implementation bug, no retry)', from: at('syncing'), event: { t: 'ack-error', error: 'invalid_request' }, phase: 'syncing', effects: [{ t: 'legacy' }] },
    { name: 'any ACK not_found → removed', from: at('syncing'), event: { t: 'ack-error', error: 'not_found' }, phase: 'syncing', effects: [{ t: 'remove' }] },
    { name: 'too_many_subscriptions → evict the least recent, retry', from: at('loading'), event: { t: 'ack-error', error: 'too_many_subscriptions' }, phase: 'loading', effects: [{ t: 'evict-and-retry' }] },
    { name: 'live, visible, 120s → one reconcile subscribe', from: at('live'), event: { t: 'reconcile' }, phase: 'live', effects: [{ t: 'subscribe', cold: false }] },
    { name: 'syncing reconcile tick → nothing (only live reconciles)', from: at('syncing'), event: { t: 'reconcile' }, phase: 'syncing', effects: [] },
    { name: 'stale(server) REST done → live', from: at('stale', { staleReason: 'server' }), event: { t: 'rest-done' }, phase: 'live', effects: [] },
    { name: 'syncing REST hedge done → live (legacy-strength)', from: at('syncing'), event: { t: 'rest-done' }, phase: 'live', effects: [] },
    { name: 'stale(offline) REST done → stays (offline)', from: at('stale', { staleReason: 'offline' }), event: { t: 'rest-done' }, phase: 'stale', effects: [] },
    { name: 'superseded ack → ignored', from: at('syncing'), event: { t: 'ack', outcome: { t: 'superseded' } }, phase: 'syncing', effects: [] },
];

describe('B-812 sync state machine (spec §5.3)', () => {
    for (const row of rows) {
        it(row.name, () => {
            const { state, effects } = transition(row.from, row.event);
            expect(state.phase).toBe(row.phase);
            expect(effects).toEqual(row.effects);
            if (row.staleReason) expect(state.staleReason).toBe(row.staleReason);
        });
    }

    it('live has two ways in: an ack whose head proved the range, or a finished REST fallback (legacy-strength)', () => {
        const events: SyncEvent[] = [
            { t: 'open', anchored: true }, { t: 'open', anchored: false }, { t: 'push-gap' }, { t: 'resume' }, { t: 'connect' },
            { t: 'online' }, { t: 'retry' }, { t: 'reconcile' }, { t: 'ack-timeout' }, { t: 'socket-down' }, { t: 'offline' },
            { t: 'ack', outcome: { t: 'more' } }, { t: 'ack', outcome: { t: 'head-behind' } }, { t: 'ack', outcome: { t: 'invalid' } },
            { t: 'ack', outcome: { t: 'superseded' } }, { t: 'ack-error', error: 'unavailable' }, { t: 'ack-error', error: 'rate_limited', random: 0 },
        ];
        for (const phase of ['cold', 'loading', 'syncing', 'stale'] as const) {
            for (const event of events) expect(transition(at(phase), event).state.phase, `${phase} + ${event.t}`).not.toBe('live');
        }
        expect(transition(at('stale', { staleReason: 'server' }), { t: 'rest-done' }).state.phase).toBe('live'); // the REST fallback (legacy-strength)
    });

    it('unavailable backs off 1s → 2s, invalid counts like unavailable, success resets the streak', () => {
        let s = at('syncing');
        let r = transition(s, { t: 'ack-error', error: 'unavailable' });
        expect(r.effects).toEqual([{ t: 'subscribe', cold: false, delayMs: UNAVAILABLE_BACKOFF_MS[0] }]);
        s = r.state;
        r = transition(s, { t: 'ack', outcome: { t: 'invalid' } });
        expect(r.effects).toEqual([{ t: 'subscribe', cold: false, delayMs: UNAVAILABLE_BACKOFF_MS[1] }]);
        s = transition(r.state, { t: 'ack', outcome: { t: 'live' } }).state;
        expect(s.unavailableStreak).toBe(0);
        // A server-suggested retryAfterMs wins when longer.
        expect(transition(at('syncing'), { t: 'ack-error', error: 'unavailable', retryAfterMs: 1_400 }).effects).toEqual([{ t: 'subscribe', cold: false, delayMs: 1_400 }]);
    });

    it('rate_limited waits retryAfterMs plus 0–30% jitter and stays syncing', () => {
        // retryAfterMs ≠ the 1s unavailable step (G1-16: a fixed 1s must not pass).
        expect(transition(at('live'), { t: 'ack-error', error: 'rate_limited', retryAfterMs: 2_500, random: 0 }).effects).toEqual([{ t: 'subscribe', cold: false, delayMs: 2_500 }]);
        const r = transition(at('syncing'), { t: 'ack-error', error: 'rate_limited', retryAfterMs: 2_500, random: 1 });
        expect(r.effects).toEqual([{ t: 'subscribe', cold: false, delayMs: 3_250 }]);
        expect(r.state.phase).toBe('syncing');
        expect(transition(at('syncing'), { t: 'ack-error', error: 'rate_limited', retryAfterMs: 400, random: 0 }).effects).toEqual([{ t: 'subscribe', cold: false, delayMs: 400 }]);
    });

    it('an unknown error code counts as unavailable: 1s → 2s → stale(server) + one REST (§9.2-5 r2)', () => {
        let s = at('syncing');
        let r = transition(s, { t: 'ack-error', error: 'unavailable' });
        const viaUnknown = transition(s, { t: 'ack-error', error: 'foo' as never });
        expect(viaUnknown).toEqual(r);
        expect(r.effects).toEqual([{ t: 'subscribe', cold: false, delayMs: UNAVAILABLE_BACKOFF_MS[0] }]);
        s = r.state;
        r = transition(s, { t: 'ack-error', error: 'foo' as never });
        expect(r.effects).toEqual([{ t: 'subscribe', cold: false, delayMs: UNAVAILABLE_BACKOFF_MS[1] }]);
        r = transition(r.state, { t: 'ack-error', error: 'foo' as never });
        expect(r.state).toMatchObject({ phase: 'stale', staleReason: 'server' });
        expect(r.effects).toEqual([{ t: 'rest' }]);
    });

    it('connect / online / retry bump the generation (older range results are superseded); resume does not', () => {
        const s = at('live', { generation: 4 });
        expect(transition(s, { t: 'connect' }).state.generation).toBe(5);
        expect(transition(s, { t: 'online' }).state.generation).toBe(5);
        expect(transition(s, { t: 'retry' }).state.generation).toBe(5);
        expect(transition(s, { t: 'resume' }).state.generation).toBe(4);
        expect(transition(s, { t: 'ack', outcome: { t: 'head-behind' } }).state.generation).toBe(5);
    });
});
