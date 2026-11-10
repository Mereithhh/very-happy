/**
 * B-906b — re-render once when a waking session's grace runs out.
 *
 * isListedLive keeps a waking row (B-906) only for WAKE_GRACE_MS after its
 * wrapper started. Lists compute it at render time, so without a store update
 * a wrapper that died before its first heartbeat stayed listed for as long as
 * the page stayed open. This arms ONE timeout for the earliest expiry, and only
 * while some row is waking — no row waking, no timer (no periodic re-render).
 * The returned counter goes into the list memos' deps.
 */
import { useEffect, useState } from 'react';
import { nextWakeExpiry, type HibernationSession } from './sessionHibernation';

/** Fire a little after the expiry so `now - start > WAKE_GRACE_MS` already holds. */
export const WAKE_EXPIRY_SLACK_MS = 250;

export function useWakeExpiryTick(sessions: Iterable<HibernationSession | string> | null | undefined): number {
    const [tick, setTick] = useState(0);
    const next = sessions ? nextWakeExpiry(sessions, Date.now()) : null;
    useEffect(() => {
        if (next === null) return;
        const id = setTimeout(() => setTick((n) => n + 1), Math.max(0, next - Date.now()) + WAKE_EXPIRY_SLACK_MS);
        return () => clearTimeout(id);
    }, [next, tick]);
    return tick;
}
