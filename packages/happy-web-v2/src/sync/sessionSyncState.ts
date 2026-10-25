/**
 * B-812 (B-807 spec §5.3, PR-5b): the per-session sync state machine of a
 * subscribed session in subscribe mode. Pure: `transition(state, event)`
 * returns the next state and the effects the scheduler carries out.
 *
 *   cold → loading → live ⇄ syncing → stale
 *
 * `live` has two ways in (spec §5.3 r7): an ack with `hasMore=false` whose head
 * is not behind the request's afterSeq (G2) — the merge has then moved lastSeq
 * to the head, holes included (G2a: an old session with seq holes is live after
 * ONE subscribe, no retry loop) — or, legacy-strength (no head proof), a REST
 * fallback / hedge that finished while catching up or stale(server/timeout);
 * the next 120s reconcile proves the head.
 */

export type SyncPhase = 'cold' | 'loading' | 'live' | 'syncing' | 'stale';
export type StaleReason = 'timeout' | 'server' | 'offline' | 'socket';

export type SessionSyncState = {
    phase: SyncPhase;
    staleReason?: StaleReason;
    generation: number;
    /** Consecutive `unavailable` (or invalid) acks; 3 → stale(server) + one REST fallback. */
    unavailableStreak: number;
};

/** Spec §3.4: 1s → 2s → 4s, then stale(server). */
export const UNAVAILABLE_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
export const UNAVAILABLE_STALE_AFTER = 3;
/** rate_limited: retryAfterMs plus 0–30% jitter. */
export const RATE_LIMIT_JITTER = 0.3;

export type AckOutcome =
    /** hasMore=false, head proved: live. */
    | { t: 'live' }
    /** hasMore=true: pull on from the new lastSeq. */
    | { t: 'more' }
    /** headSeq < request afterSeq: drop local state, one cold subscribe. */
    | { t: 'head-behind' }
    /** A range result of a superseded generation: ignored. */
    | { t: 'superseded' }
    /** Rows outside the snapshot range (server bug): handled like `unavailable`. */
    | { t: 'invalid' };

export type SyncEvent =
    | { t: 'open'; anchored: boolean }
    | { t: 'ack'; outcome: AckOutcome }
    | { t: 'ack-error'; error: string; retryAfterMs?: number; random?: number }
    | { t: 'ack-timeout' }
    | { t: 'push-gap' }
    | { t: 'resume' }
    | { t: 'connect' }
    | { t: 'socket-down' }
    | { t: 'offline' }
    | { t: 'online' }
    | { t: 'retry' }
    | { t: 'reconcile' }
    | { t: 'rest-done' };

export type SyncEffect =
    /** session-subscribe; `cold` = afterSeq null, otherwise afterSeq = current lastSeq. */
    | { t: 'subscribe'; cold: boolean; delayMs?: number }
    /** Drop the session's local window and cursor (head behind the request). */
    | { t: 'invalidate' }
    /** One REST catch-up (PR-1 path, 10s deadline). */
    | { t: 'rest' }
    /** apiSocket.checkLiveness() — the 铁律 13 entry. */
    | { t: 'check-liveness' }
    /** Stop syncing it; the existing deleted/no-access path takes over. */
    | { t: 'remove' }
    /** Leave subscribe mode for this connection (legacy, PR-1..3 behaviour). */
    | { t: 'legacy' }
    /** Drop the least recently viewed subscription and subscribe again. */
    | { t: 'evict-and-retry' };

export function initialSyncState(): SessionSyncState {
    return { phase: 'cold', generation: 0, unavailableStreak: 0 };
}

type Result = { state: SessionSyncState; effects: SyncEffect[] };

const same = (state: SessionSyncState): Result => ({ state, effects: [] });

function catchingUp(state: SessionSyncState): boolean {
    return state.phase === 'loading' || state.phase === 'syncing';
}

/** Hello-level errors that mean "no subscribe mode on this connection" (spec §3.4). */
export const LEGACY_ERRORS: ReadonlySet<string> = new Set(['disabled', 'unsupported_client', 'invalid_request']);

export function transition(state: SessionSyncState, event: SyncEvent): Result {
    switch (event.t) {
        case 'open':
            if (state.phase === 'cold') {
                return event.anchored
                    ? { state: { ...state, phase: 'syncing' }, effects: [{ t: 'subscribe', cold: false }] }
                    : { state: { ...state, phase: 'loading' }, effects: [{ t: 'subscribe', cold: true }] };
            }
            if (state.phase === 'live' || state.phase === 'stale') {
                return { state: { ...state, phase: 'syncing', staleReason: undefined }, effects: [{ t: 'subscribe', cold: !event.anchored }] };
            }
            return same(state);

        case 'ack': {
            const outcome = event.outcome;
            if (outcome.t === 'superseded') return same(state);
            if (outcome.t === 'live') return { state: { ...state, phase: 'live', staleReason: undefined, unavailableStreak: 0 }, effects: [] };
            if (outcome.t === 'more') return { state: { ...state, phase: state.phase === 'loading' ? 'loading' : 'syncing', unavailableStreak: 0 }, effects: [{ t: 'subscribe', cold: false }] };
            if (outcome.t === 'head-behind') {
                return { state: { ...state, phase: 'loading', unavailableStreak: 0, generation: state.generation + 1 }, effects: [{ t: 'invalidate' }, { t: 'subscribe', cold: true }] };
            }
            return unavailable(state);
        }

        case 'ack-error': {
            if (LEGACY_ERRORS.has(event.error)) return { state, effects: [{ t: 'legacy' }] };
            if (event.error === 'not_found') return { state, effects: [{ t: 'remove' }] };
            if (event.error === 'too_many_subscriptions') return { state, effects: [{ t: 'evict-and-retry' }] };
            if (event.error === 'rate_limited') {
                const base = event.retryAfterMs ?? UNAVAILABLE_BACKOFF_MS[0];
                const delayMs = Math.round(base * (1 + RATE_LIMIT_JITTER * (event.random ?? Math.random())));
                return { state: { ...state, phase: catchingUp(state) ? state.phase : 'syncing' }, effects: [{ t: 'subscribe', cold: state.phase === 'loading', delayMs }] };
            }
            return unavailable(state, event.retryAfterMs);
        }

        case 'ack-timeout':
            // Link suspect: probe it; a reconnect re-runs hello (connect).
            return { state: { ...state, phase: 'stale', staleReason: 'timeout' }, effects: [{ t: 'check-liveness' }] };

        case 'push-gap':
            if (state.phase === 'live') return { state: { ...state, phase: 'syncing' }, effects: [{ t: 'subscribe', cold: false }] };
            if (catchingUp(state)) return { state, effects: [{ t: 'subscribe', cold: false }] };
            return same(state);

        case 'resume':
        case 'connect':
        case 'online':
        case 'retry': {
            // A fresh attempt: older range results are superseded (rule 1).
            if (state.phase === 'cold') return same(state);
            const phase: SyncPhase = state.phase === 'loading' ? 'loading' : 'syncing';
            const bump = event.t === 'resume' ? 0 : 1;
            return { state: { ...state, phase, staleReason: undefined, unavailableStreak: 0, generation: state.generation + bump }, effects: [] };
        }

        case 'socket-down':
            if (state.phase === 'cold') return same(state);
            return { state: { ...state, phase: 'stale', staleReason: 'socket' }, effects: [] };

        case 'offline':
            if (state.phase === 'cold') return same(state);
            return { state: { ...state, phase: 'stale', staleReason: 'offline' }, effects: [] };

        case 'reconcile':
            if (state.phase !== 'live') return same(state);
            return { state, effects: [{ t: 'subscribe', cold: false }] };

        case 'rest-done':
            // The REST fallback / hedge caught the session up (legacy-strength proof).
            if (catchingUp(state) || (state.phase === 'stale' && (state.staleReason === 'server' || state.staleReason === 'timeout'))) {
                return { state: { ...state, phase: 'live', staleReason: undefined, unavailableStreak: 0 }, effects: [] };
            }
            return same(state);
    }
}

function unavailable(state: SessionSyncState, retryAfterMs?: number): Result {
    const streak = state.unavailableStreak + 1;
    if (streak >= UNAVAILABLE_STALE_AFTER) {
        return { state: { ...state, phase: 'stale', staleReason: 'server', unavailableStreak: 0 }, effects: [{ t: 'rest' }] };
    }
    const delayMs = Math.max(UNAVAILABLE_BACKOFF_MS[streak - 1], retryAfterMs ?? 0);
    const phase: SyncPhase = state.phase === 'loading' ? 'loading' : 'syncing';
    return { state: { ...state, phase, unavailableStreak: streak }, effects: [{ t: 'subscribe', cold: state.phase === 'loading', delayMs }] };
}
