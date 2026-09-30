/**
 * B-516 review: which browser tabs are alive, for pending-session ownership.
 *
 * Preferred: Web Locks. Each tab holds `vh-tab:<id>` for its whole life; the
 * browser releases it when the tab goes away, so `navigator.locks.query()`
 * answers "is that tab still open" without heartbeats. Fallback (no Web
 * Locks): a BroadcastChannel ping the live tab answers. Without either, the
 * environment is treated as single-tab (the owner is gone).
 */
const LOCK_PREFIX = 'vh-tab:';
const CHANNEL = 'vh-tab-liveness';
const PING_TIMEOUT_MS = 400;

interface LockManagerLike {
    request(name: string, options: { mode?: 'exclusive' | 'shared' } | ((lock: unknown) => Promise<unknown>), callback?: (lock: unknown) => Promise<unknown>): Promise<unknown>;
    query(): Promise<{ held?: Array<{ name?: string }> }>;
}

function locks(): LockManagerLike | null {
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    return nav?.locks ?? null;
}

let channel: BroadcastChannel | null = null;

/** Start announcing this tab as alive. Idempotent per tab id. */
export function holdTabLiveness(tabId: string): void {
    const manager = locks();
    if (manager) {
        void manager.request(`${LOCK_PREFIX}${tabId}`, () => new Promise(() => { /* held for the tab's life */ })).catch(() => {});
    }
    if (typeof BroadcastChannel !== 'undefined' && !channel) {
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (event: MessageEvent<{ type?: string; tab?: string; nonce?: string }>) => {
            if (event.data?.type === 'ping' && event.data.tab === tabId) {
                channel?.postMessage({ type: 'pong', tab: tabId, nonce: event.data.nonce });
            }
        };
    }
}

export async function isTabAlive(tabId: string): Promise<boolean> {
    const manager = locks();
    if (manager) {
        try {
            const state = await manager.query();
            return (state.held ?? []).some((lock) => lock.name === `${LOCK_PREFIX}${tabId}`);
        } catch { /* fall through to the channel */ }
    }
    if (typeof BroadcastChannel === 'undefined') return false;
    return new Promise((resolve) => {
        const probe = new BroadcastChannel(CHANNEL);
        const nonce = Math.random().toString(36).slice(2);
        const finish = (alive: boolean) => { clearTimeout(timer); probe.close(); resolve(alive); };
        const timer = setTimeout(() => finish(false), PING_TIMEOUT_MS);
        probe.onmessage = (event: MessageEvent<{ type?: string; tab?: string; nonce?: string }>) => {
            if (event.data?.type === 'pong' && event.data.tab === tabId && event.data.nonce === nonce) finish(true);
        };
        probe.postMessage({ type: 'ping', tab: tabId, nonce });
    });
}

/** Cross-tab exclusive section (no Web Locks → runs directly). */
export async function withTabLock(name: string, fn: () => Promise<void>): Promise<void> {
    const manager = locks();
    if (!manager) return fn();
    await manager.request(name, { mode: 'exclusive' }, () => fn());
}
