/**
 * B-799: one app-wide 「离线」 judgment — the top bar, the composer's offline
 * send state and the send outbox all read it.
 *
 * Inputs are the existing facts only: `navigator.onLine` (+ online/offline
 * events), the browser↔server socket status from storage, and whether the
 * page is visible. It is display/outbox state, NOT a recovery path: recovery
 * stays on resumeSync → sync.onWebResume (AGENTS 13); this adds no reconnect.
 *
 * No false alarms:
 *  - `navigator.onLine === false` must hold for BROWSER_OFFLINE_AFTER_MS (a
 *    Wi-Fi → cellular hand-over flips it for a moment).
 *  - a lost socket counts only after SOCKET_OFFLINE_AFTER_MS of VISIBLE time.
 *    A background tab's socket is often dead when it comes back; the resume
 *    probe reconnects it within a few seconds, so the clock starts at zero on
 *    every hidden → visible edge (like the agent lease clock, AGENTS 13).
 *  - before the socket has ever connected (cold start), only the browser's
 *    own offline flag counts.
 * Leaving 「离线」 needs both: the browser online AND the socket back (when
 * it ever connected) — the bar keeps saying 「正在重连」 until it really is.
 */
import { create } from 'zustand';

/**
 * socket.io here retries at 1s → 5s (apiSocket: reconnectionDelay 1000,
 * reconnectionDelayMax 5000, ±50% jitter) and a liveness probe waits 5s, so a
 * server restart or a short blip is over in ~2–6s. 8s = at least two retries
 * plus one probe timeout without a connection.
 */
export const SOCKET_OFFLINE_AFTER_MS = 8_000;
/** The browser's own offline flag, debounced against hand-over flaps. */
export const BROWSER_OFFLINE_AFTER_MS = 1_500;
/** 「已恢复」 stays this long, then the bar fades out. */
export const RECOVERED_SHOW_MS = 2_000;
/** A tick never charges more than this (timers are throttled / frozen in the background). */
export const MAX_STEP_MS = 2_000;
export const NETWORK_TICK_MS = 500;

export type NetworkPhase = 'online' | 'offline' | 'recovered';

export type NetworkInput = {
    browserOnline: boolean;
    socketConnected: boolean;
    /** The socket connected at least once in this tab. */
    everConnected: boolean;
    visible: boolean;
    now: number;
};

export type NetworkState = {
    phase: NetworkPhase;
    /** Visible time `navigator.onLine` has been false. */
    browserOfflineMs: number;
    /** Visible time the (once connected) socket has been down. */
    socketDownMs: number;
    lastAt: number | null;
    lastVisible: boolean;
    /** The previous observation's conditions: only an interval that is down at BOTH ends is charged. */
    lastBrowserOffline: boolean;
    lastSocketDown: boolean;
    recoveredAt: number | null;
};

export const INITIAL_NETWORK_STATE: NetworkState = {
    phase: 'online',
    browserOfflineMs: 0,
    socketDownMs: 0,
    lastAt: null,
    lastVisible: false,
    lastBrowserOffline: false,
    lastSocketDown: false,
    recoveredAt: null,
};

/**
 * Pure step: fold one observation into the state. An interval is charged only
 * when it was visible and down at both of its ends.
 */
export function stepNetwork(state: NetworkState, input: NetworkInput): NetworkState {
    const counting = input.visible && state.lastVisible && state.lastAt !== null;
    const dt = counting ? Math.min(MAX_STEP_MS, Math.max(0, input.now - state.lastAt!)) : 0;
    const browserOffline = !input.browserOnline;
    const browserOfflineMs = browserOffline ? state.browserOfflineMs + (state.lastBrowserOffline ? dt : 0) : 0;
    const socketDown = input.everConnected && !input.socketConnected;
    const socketDownMs = socketDown ? state.socketDownMs + (state.lastSocketDown ? dt : 0) : 0;
    const base = {
        browserOfflineMs,
        socketDownMs,
        lastAt: input.now,
        lastVisible: input.visible,
        lastBrowserOffline: browserOffline,
        lastSocketDown: socketDown,
    };

    const goesOffline = browserOfflineMs >= BROWSER_OFFLINE_AFTER_MS || socketDownMs >= SOCKET_OFFLINE_AFTER_MS;
    const back = input.browserOnline && !socketDown;

    if (state.phase === 'offline') {
        if (back) return { ...base, phase: 'recovered', recoveredAt: input.now };
        return { ...base, phase: 'offline', recoveredAt: null };
    }
    if (goesOffline) return { ...base, phase: 'offline', recoveredAt: null };
    if (state.phase === 'recovered' && state.recoveredAt !== null && input.now - state.recoveredAt < RECOVERED_SHOW_MS) {
        return { ...base, phase: 'recovered', recoveredAt: state.recoveredAt };
    }
    return { ...base, phase: 'online', recoveredAt: null };
}

export const networkStore = create<{ phase: NetworkPhase; syncing: readonly string[] }>(() => ({ phase: 'online', syncing: [] }));

/**
 * Hook for B-802 (not wired yet): a catch-up after a reconnect / resume can hold
 * the bar on 「同步中…」 until its data is in. Each holder passes its own reason
 * and calls the returned release (idempotent). Offline still wins over it.
 */
export function beginNetworkSync(reason: string): () => void {
    networkStore.setState((s) => ({ syncing: [...s.syncing, reason] }));
    let released = false;
    return () => {
        if (released) return;
        released = true;
        networkStore.setState((s) => {
            const at = s.syncing.indexOf(reason);
            return at < 0 ? s : { syncing: [...s.syncing.slice(0, at), ...s.syncing.slice(at + 1)] };
        });
    };
}

/** What the top bar shows: offline > syncing > recovered > nothing. */
export type BannerPhase = 'offline' | 'syncing' | 'recovered' | null;

export function bannerPhase(phase: NetworkPhase, syncing: boolean): BannerPhase {
    if (phase === 'offline') return 'offline';
    if (syncing) return 'syncing';
    return phase === 'recovered' ? 'recovered' : null;
}

export function useBannerPhase(): BannerPhase {
    return networkStore((s) => bannerPhase(s.phase, s.syncing.length > 0));
}

/** True while the app judges the device offline (the bar shows 「已离线」). */
export function isNetworkOffline(): boolean {
    return networkStore.getState().phase === 'offline';
}

export function useNetworkPhase(): NetworkPhase {
    return networkStore((s) => s.phase);
}

export type NetworkMonitorDeps = {
    read: () => Omit<NetworkInput, 'now'>;
    /** Fires on every change of the inputs (online/offline events, socket status). */
    subscribe: (onChange: () => void) => () => void;
    /** offline → back: let waiting work go out now instead of after its backoff. */
    onRecovered?: () => void;
    now?: () => number;
};

/** Does this state still need time to pass (a debounce clock or the 「已恢复」 fade)? */
export function networkNeedsTick(state: NetworkState, input: Omit<NetworkInput, 'now'>): boolean {
    return !input.browserOnline || (input.everConnected && !input.socketConnected) || state.phase !== 'online';
}

/**
 * Drive `networkStore` from live inputs: on every input change, and every
 * NETWORK_TICK_MS only while a clock runs (an idle app holds no timer).
 * Returns a stop function.
 */
export function startNetworkMonitor(deps: NetworkMonitorDeps): () => void {
    const now = deps.now ?? Date.now;
    let state = INITIAL_NETWORK_STATE;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const input = deps.read();
        const prev = state.phase;
        state = stepNetwork(state, { ...input, now: now() });
        if (state.phase !== prev) {
            networkStore.setState({ phase: state.phase });
            if (prev === 'offline' && state.phase === 'recovered') deps.onRecovered?.();
        }
        if (networkNeedsTick(state, input)) timer = setTimeout(update, NETWORK_TICK_MS);
    };
    update();
    const unsubscribe = deps.subscribe(update);
    return () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
        timer = null;
        state = INITIAL_NETWORK_STATE;
        networkStore.setState({ phase: 'online' });
    };
}
