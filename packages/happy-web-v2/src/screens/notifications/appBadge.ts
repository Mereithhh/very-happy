/**
 * PWA app-icon badge (B-559). Spec: specs/2026-10-pwa-app-badge.md §D2.
 *
 * The inbox unread count (the bell's number) is mirrored to the Badging API
 * and reported to the service worker, which uses the last reported count to
 * bump the badge when a Web Push lands while no window is visible (see
 * public/push-sw.js). Feature-detected everywhere: browsers without the API
 * (Firefox, non-installed Safari) are a silent no-op, never an error.
 */

export interface BadgeNavigatorLike {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
    serviceWorker?: { controller: { postMessage(message: unknown): void } | null } | undefined;
}

/** Message the page sends the service worker (push-sw.js listens for it). */
export const BADGE_COUNT_MESSAGE = 'vh-badge-count';

export type BadgePlan = { kind: 'set'; n: number } | { kind: 'clear' };

export function planBadge(count: number): BadgePlan {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    return n > 0 ? { kind: 'set', n } : { kind: 'clear' };
}

/**
 * Apply `count` to the app badge + tell the SW. Returns whether the Badging
 * API was actually invoked. Rejections (not installed, permission) are
 * swallowed — the badge is an affordance, never a failure surface.
 */
export function applyAppBadge(nav: BadgeNavigatorLike | undefined, count: number): boolean {
    if (!nav) return false;
    const plan = planBadge(count);
    try {
        nav.serviceWorker?.controller?.postMessage({
            type: BADGE_COUNT_MESSAGE,
            count: plan.kind === 'set' ? plan.n : 0,
        });
    } catch {
        /* detached controller — the next change re-sends */
    }
    if (typeof nav.setAppBadge !== 'function') return false;
    try {
        const p = plan.kind === 'set'
            ? nav.setAppBadge(plan.n)
            : typeof nav.clearAppBadge === 'function' ? nav.clearAppBadge() : nav.setAppBadge(0);
        void Promise.resolve(p).catch(() => {});
    } catch {
        return false;
    }
    return true;
}

/**
 * Stateful wrapper: only touches the badge when the count actually changes
 * (both bells and every re-render recompute the same number).
 */
export function createBadgeSyncer(getNav: () => BadgeNavigatorLike | undefined) {
    let last: number | null = null;
    return {
        sync(count: number) {
            const plan = planBadge(count);
            const n = plan.kind === 'set' ? plan.n : 0;
            if (n === last) return;
            last = n;
            applyAppBadge(getNav(), n);
        },
        /** forget the last value — the next sync re-applies (SW controller changed) */
        reset() {
            last = null;
        },
    };
}

export type BadgeSyncer = ReturnType<typeof createBadgeSyncer>;

/**
 * Coming back to the page FORCES a rewrite of the badge and the SW count: while
 * hidden the SW may have bumped the badge on a push (count+1), and that
 * estimate must be replaced by the exact number even when the page's own count
 * did not change (the deduping syncer would otherwise skip it).
 */
export function installVisibleResync(
    doc: Pick<Document, 'addEventListener' | 'removeEventListener'> & { visibilityState: DocumentVisibilityState },
    syncer: BadgeSyncer,
    getCount: () => number,
): () => void {
    const onVisibility = () => {
        if (doc.visibilityState !== 'visible') return;
        syncer.reset();
        syncer.sync(getCount());
    };
    doc.addEventListener('visibilitychange', onVisibility);
    return () => doc.removeEventListener('visibilitychange', onVisibility);
}
