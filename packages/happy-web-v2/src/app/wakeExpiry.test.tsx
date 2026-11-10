// @vitest-environment happy-dom
/**
 * B-906b — the waking grace (B-906) must also END on its own, and must not be
 * stretched by a wrapper machine clock that runs ahead of the browser.
 *
 * 1. A waking row whose wrapper never heartbeats leaves the list (and lands in
 *    归档) within 5 s of WAKE_GRACE_MS even when the store never updates again.
 *    Before: lists evaluated isListedLive at render time only, so the row
 *    stayed for as long as the page stayed open (QA: > 6.5 min).
 * 2. No waking row → no timer at all (no periodic list re-render).
 * 3. Clock skew between the wrapper machine (lifecycleStateSince), the server
 *    (activeAt / updatedAt) and the browser (now): fast 1 h, slow 1 h, ±5 s.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { visibleSidebarSessions } from '@/screens/sessions/sidebarRows';
import { isWaking, nextWakeExpiry, wakeExpiresAt, WAKE_FUTURE_TOLERANCE_MS, WAKE_GRACE_MS } from './sessionHibernation';
import { useWakeExpiryTick } from './useWakeExpiryTick';

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const HIB_AT = NOW - 3 * HOUR;
const base = { path: '/w', host: 'h', machineId: 'm', flavor: 'claude', lifecycleState: 'running' };

function mk(id: string, over: Partial<Session> & { since?: number } = {}): Session {
    const { since = NOW - 500, ...rest } = over;
    return {
        id, seq: 0, createdAt: 1, updatedAt: NOW - 400, active: false, activeAt: HIB_AT,
        metadata: { ...base, lifecycleStateSince: since } as Session['metadata'],
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence: 'online',
        ...rest,
    } as Session;
}

describe('B-906b grace expiry re-renders without a store update', () => {
    let host: HTMLDivElement; let root: Root;
    const seen: { list: string[]; archived: string[] }[] = [];
    function Probe({ sessions }: { sessions: Session[] }) {
        useWakeExpiryTick(sessions);
        seen.push({ list: visibleSidebarSessions(sessions, 'list').map((s) => s.id), archived: visibleSidebarSessions(sessions, 'archived').map((s) => s.id) });
        return null;
    }
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
        seen.length = 0;
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

    it('a wake that never heartbeats leaves the list ≤ 5 s after the grace, into 归档', () => {
        const stable = [mk('dead'), mk('online', { active: true, activeAt: NOW })];
        act(() => root.render(<Probe sessions={stable} />));
        expect(seen.at(-1)).toEqual({ list: ['dead', 'online'], archived: [] });
        // Just before the grace ends it is still waking.
        act(() => { vi.advanceTimersByTime(WAKE_GRACE_MS - 1000); });
        expect(seen.at(-1)!.list).toContain('dead');
        // Same props, no store update — only the timer can re-render.
        act(() => { vi.advanceTimersByTime(1000 + 5000); });
        expect(seen.at(-1)).toEqual({ list: ['online'], archived: ['dead'] });
        // Nothing is waking any more → the timer is gone (no periodic re-render).
        expect(vi.getTimerCount()).toBe(0);
    });

    it('no waking row → no timer', () => {
        act(() => root.render(<Probe sessions={[mk('online', { active: true, activeAt: NOW }), mk('offline', { activeAt: NOW - 100 })]} />));
        expect(vi.getTimerCount()).toBe(0);
        const renders = seen.length;
        act(() => { vi.advanceTimersByTime(10 * WAKE_GRACE_MS); });
        expect(seen.length).toBe(renders);
    });

    it('several waking rows: one timer, armed for the earliest expiry', () => {
        act(() => root.render(<Probe sessions={[mk('a', { since: NOW - 60_000, updatedAt: NOW - 60_000 }), mk('b')]} />));
        expect(vi.getTimerCount()).toBe(1);
        act(() => { vi.advanceTimersByTime(60_000 + 5000); });
        expect(seen.at(-1)!.list).toEqual(['b']);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(seen.at(-1)).toEqual({ list: [], archived: ['a', 'b'] });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('B-906b wrapper clock skew', () => {
    // The start write lands on the server at NOW - 400 (updatedAt), the browser reads at NOW.
    it('machine 1 h FAST: a real wake is still listed, but only for the grace measured in server time', () => {
        const s = mk('fast', { since: NOW - 500 + HOUR });
        expect(isWaking(s, NOW)).toBe(true);
        expect(wakeExpiresAt(s, NOW)).toBe(NOW - 400 + WAKE_GRACE_MS);
        expect(isWaking(s, NOW - 400 + WAKE_GRACE_MS + 1)).toBe(false);
        // …and never comes back when the browser clock reaches the machine's.
        expect(isWaking(s, NOW + HOUR - 1000)).toBe(false);
        expect(isWaking(s, NOW + HOUR + 1000)).toBe(false);
        // A dead row of a fast machine (its start write long ago, server time).
        // A row of a fast machine that just went offline: its server-side write
        // (updatedAt) predates its last heartbeat — a plain offline row, not a wake,
        // even though the machine's start time is "newer" than the heartbeat.
        expect(isWaking(mk('offline-fast', { since: NOW - 10 * 60_000 + HOUR, updatedAt: NOW - 30_000, activeAt: NOW - 10_000 }), NOW)).toBe(false);
        expect(isWaking(mk('dead-fast', { since: NOW + HOUR - 3 * HOUR, updatedAt: NOW - 2 * HOUR, activeAt: NOW - 2 * HOUR - 60_000 }), NOW)).toBe(false);
    });

    it('machine 1 h SLOW: never hangs on (the start only looks older)', () => {
        const s = mk('slow', { since: NOW - 500 - HOUR });
        expect(isWaking(s, NOW)).toBe(false);
        expect(nextWakeExpiry([s], NOW)).toBeNull();
    });

    it('skew within 5 s: listed through the grace, gone right after', () => {
        for (const skew of [-5000, -1, 0, 1, 5000]) {
            const s = mk(`skew${skew}`, { since: NOW - 500 + skew });
            const start = Math.min(NOW - 500 + skew, NOW - 400);
            expect(isWaking(s, NOW)).toBe(true);
            expect(wakeExpiresAt(s, NOW)).toBe(start + WAKE_GRACE_MS);
            expect(isWaking(s, start + WAKE_GRACE_MS)).toBe(true);
            expect(isWaking(s, start + WAKE_GRACE_MS + 1)).toBe(false);
        }
    });

    it('no server time to cap with: a start far in the browser future is not believed', () => {
        const noServer = (since: number) => ({ ...mk('x', { since }), updatedAt: undefined });
        expect(isWaking(noServer(NOW + HOUR), NOW)).toBe(false);
        expect(isWaking(noServer(NOW + WAKE_FUTURE_TOLERANCE_MS + 1), NOW)).toBe(false);
        expect(isWaking(noServer(NOW + 5000), NOW)).toBe(true);
    });
});
