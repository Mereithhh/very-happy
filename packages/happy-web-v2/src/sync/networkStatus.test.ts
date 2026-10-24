// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bannerPhase,
    beginNetworkSync,
    BROWSER_OFFLINE_AFTER_MS,
    INITIAL_NETWORK_STATE,
    isNetworkOffline,
    NETWORK_TICK_MS,
    networkStore,
    RECOVERED_SHOW_MS,
    SOCKET_OFFLINE_AFTER_MS,
    startNetworkMonitor,
    stepNetwork,
    type NetworkInput,
    type NetworkState,
} from './networkStatus';
import { offlineSendState } from '@/screens/session/offlineSend';

const live: Omit<NetworkInput, 'now'> = { browserOnline: true, socketConnected: true, everConnected: true, visible: true };

/** Feed `input` every 500ms from `from` to `to` (inclusive), like the monitor's ticker. */
function run(state: NetworkState, input: Partial<NetworkInput>, from: number, to: number): NetworkState {
    for (let now = from; now <= to; now += 500) state = stepNetwork(state, { ...live, ...input, now });
    return state;
}

describe('stepNetwork (B-799)', () => {
    it('navigator.onLine=false counts only after the debounce — a hand-over flap is not offline', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 1000);
        s = run(s, { browserOnline: false }, 1500, 1500 + BROWSER_OFFLINE_AFTER_MS - 500);
        expect(s.phase).toBe('online');
        s = run(s, {}, 3000, 3000); // back before the debounce ran out
        expect(s.phase).toBe('online');
        expect(s.browserOfflineMs).toBe(0);
        s = run(s, { browserOnline: false }, 3500, 3500 + BROWSER_OFFLINE_AFTER_MS);
        expect(s.phase).toBe('offline');
    });

    it('a lost socket is offline only after SOCKET_OFFLINE_AFTER_MS of visible time', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 1000);
        const lost = 1500;
        s = run(s, { socketConnected: false }, lost, lost + SOCKET_OFFLINE_AFTER_MS - 500);
        expect(s.phase).toBe('online'); // a short reconnect (≤ 7.5s) never shows the bar
        s = run(s, { socketConnected: false }, lost + SOCKET_OFFLINE_AFTER_MS, lost + SOCKET_OFFLINE_AFTER_MS);
        expect(s.phase).toBe('offline');
    });

    it('a background tab coming back with a dead socket is not offline (hidden time does not count)', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 1000);
        // hidden for a minute with the socket dead, timers throttled to one tick a minute
        s = stepNetwork(s, { ...live, socketConnected: false, visible: false, now: 1500 });
        s = stepNetwork(s, { ...live, socketConnected: false, visible: false, now: 61_500 });
        // the hidden → visible edge: the clock starts at zero, the resume probe reconnects in a few seconds
        s = run(s, { socketConnected: false }, 61_600, 61_600 + 5_000);
        expect(s.phase).toBe('online');
        expect(s.socketDownMs).toBeLessThan(SOCKET_OFFLINE_AFTER_MS);
        s = run(s, {}, 67_000, 67_000);
        expect(s.phase).toBe('online');
        expect(s.socketDownMs).toBe(0);
    });

    it('one late tick (frozen timer) is charged at most MAX_STEP_MS', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 500);
        s = stepNetwork(s, { ...live, socketConnected: false, now: 600 });
        s = stepNetwork(s, { ...live, socketConnected: false, now: 60_600 });
        expect(s.phase).toBe('online');
    });

    it('before the socket ever connected (cold start) only the browser flag counts', () => {
        let s = run(INITIAL_NETWORK_STATE, { socketConnected: false, everConnected: false }, 0, 30_000);
        expect(s.phase).toBe('online');
        s = run(s, { socketConnected: false, everConnected: false, browserOnline: false }, 30_500, 30_500 + BROWSER_OFFLINE_AFTER_MS);
        expect(s.phase).toBe('offline');
        // back online: there is no socket to wait for
        s = run(s, { socketConnected: false, everConnected: false }, 33_000, 33_000);
        expect(s.phase).toBe('recovered');
    });

    it('leaves offline only when the browser is online AND the socket is back; 「已恢复」 then fades', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 500);
        s = run(s, { browserOnline: false, socketConnected: false }, 1000, 1000 + BROWSER_OFFLINE_AFTER_MS);
        expect(s.phase).toBe('offline');
        s = run(s, { socketConnected: false }, 5000, 6000); // browser back, socket still reconnecting
        expect(s.phase).toBe('offline');
        s = run(s, {}, 6500, 6500);
        expect(s.phase).toBe('recovered');
        s = run(s, {}, 7000, 6500 + RECOVERED_SHOW_MS - 500);
        expect(s.phase).toBe('recovered');
        s = run(s, {}, 6500 + RECOVERED_SHOW_MS, 6500 + RECOVERED_SHOW_MS);
        expect(s.phase).toBe('online');
    });

    it('stays offline across a hidden spell; dropping again during 「已恢复」 goes straight back', () => {
        let s = run(INITIAL_NETWORK_STATE, {}, 0, 500);
        s = run(s, { browserOnline: false }, 1000, 1000 + BROWSER_OFFLINE_AFTER_MS);
        s = stepNetwork(s, { ...live, browserOnline: false, visible: false, now: 10_000 });
        s = stepNetwork(s, { ...live, browserOnline: false, visible: true, now: 20_000 });
        expect(s.phase).toBe('offline');
        s = run(s, {}, 20_500, 20_500);
        expect(s.phase).toBe('recovered');
        s = run(s, { browserOnline: false }, 21_000, 21_000 + BROWSER_OFFLINE_AFTER_MS);
        expect(s.phase).toBe('offline');
    });
});

describe('startNetworkMonitor (B-799)', () => {
    afterEach(() => vi.useRealTimers());

    it('publishes the phase, fires onRecovered once on offline → back, and holds no timer while idle', () => {
        vi.useFakeTimers();
        let input = { ...live };
        const listeners = new Set<() => void>();
        const onRecovered = vi.fn();
        const stop = startNetworkMonitor({
            read: () => input,
            subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
            onRecovered,
            now: () => Date.now(),
        });
        const change = (next: Partial<typeof input>) => { input = { ...input, ...next }; for (const fn of listeners) fn(); };
        vi.advanceTimersByTime(NETWORK_TICK_MS);
        expect(vi.getTimerCount()).toBe(0); // all live: no ticker
        expect(isNetworkOffline()).toBe(false);

        change({ browserOnline: false });
        vi.advanceTimersByTime(BROWSER_OFFLINE_AFTER_MS + NETWORK_TICK_MS);
        expect(networkStore.getState().phase).toBe('offline');
        expect(isNetworkOffline()).toBe(true);
        expect(onRecovered).not.toHaveBeenCalled();

        change({ browserOnline: true });
        expect(networkStore.getState().phase).toBe('recovered');
        expect(isNetworkOffline()).toBe(false);
        expect(onRecovered).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(RECOVERED_SHOW_MS + NETWORK_TICK_MS);
        expect(networkStore.getState().phase).toBe('online');
        expect(vi.getTimerCount()).toBe(0);
        expect(onRecovered).toHaveBeenCalledTimes(1);
        stop();
        expect(listeners.size).toBe(0);
    });
});

describe('offline send state (B-799)', () => {
    it('text queues; attachments wait for the network; online is untouched', () => {
        expect(offlineSendState(false, false)).toBeNull();
        expect(offlineSendState(false, true)).toBeNull();
        expect(offlineSendState(true, false)).toBe('queue');
        expect(offlineSendState(true, true)).toBe('blocked');
    });
});

describe('offline wiring (B-799)', () => {
    const sync = readFileSync(resolve(__dirname, 'sync.ts'), 'utf8');
    const queue = readFileSync(resolve(__dirname, 'promptQueue.ts'), 'utf8');

    it('the send deadline pauses while the app judges the device offline (a queued send waits, not fails)', () => {
        expect(sync).toContain('this.sendDeadlines.tick(Date.now(), isBrowserOnline() && !isNetworkOffline())');
    });

    it('a server-queue row that failed while offline waits for the network instead of failing', () => {
        expect(queue).toContain("isOnline: () => (typeof navigator === 'undefined' || navigator.onLine !== false) && !isNetworkOffline(),");
    });

    it('recovery flushes queued sends now and retries waiting queue rows', () => {
        expect(sync).toMatch(/onRecovered: \(\) => \{\s*this\.flushOutboxesNow\(\);\s*retryWaitingPrompts\(\);/);
        expect(sync).toContain('if (pending.length > 0) this.getSendSync(sessionId).invalidateNow();');
    });

    it('the monitor reads the socket status and its ever-connected fact from storage', () => {
        expect(sync).toContain("socketConnected: state.socketStatus === 'connected',");
        expect(sync).toContain('everConnected: state.socketLastConnectedAt != null,');
        expect(sync).toContain("visible: document.visibilityState === 'visible',");
    });
});

describe('「同步中」 hook for B-802', () => {
    it('offline beats syncing beats recovered; online and idle shows nothing', () => {
        expect(bannerPhase('offline', true)).toBe('offline');
        expect(bannerPhase('online', true)).toBe('syncing');
        expect(bannerPhase('recovered', true)).toBe('syncing');
        expect(bannerPhase('recovered', false)).toBe('recovered');
        expect(bannerPhase('online', false)).toBeNull();
    });

    it('holders are counted per call; release is idempotent', () => {
        const a = beginNetworkSync('resume');
        const b = beginNetworkSync('resume');
        expect(networkStore.getState().syncing).toEqual(['resume', 'resume']);
        a();
        a();
        expect(networkStore.getState().syncing).toEqual(['resume']);
        b();
        expect(networkStore.getState().syncing).toEqual([]);
    });
});
