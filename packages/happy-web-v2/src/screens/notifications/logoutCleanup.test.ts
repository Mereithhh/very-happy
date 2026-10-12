import { beforeEach, describe, expect, it, vi } from 'vitest';

// Plain function, not vi.fn(): vitest 3 surfaces an error thrown by a vi.fn
// implementation as a test failure even when the code under test catches it.
const store = vi.hoisted(() => ({ calls: 0, throws: false }));
vi.mock('@/sync/notificationUnreadMarksStore', () => ({
    clearAllUnreadMarks: () => {
        store.calls++;
        if (store.throws) throw new Error('mmkv');
    },
}));

const { clearNotificationStateOnLogout } = await import('./logoutCleanup');

describe('clearNotificationStateOnLogout (B-559)', () => {
    beforeEach(() => {
        store.calls = 0;
        store.throws = false;
    });

    it('clears the app badge, tells the SW count 0 and drops mark-unread', () => {
        const calls: string[] = [];
        const posted: unknown[] = [];
        clearNotificationStateOnLogout({
            setAppBadge: async (n) => { calls.push(`set:${n}`); },
            clearAppBadge: async () => { calls.push('clear'); },
            serviceWorker: { controller: { postMessage: (m) => posted.push(m) } },
        });
        expect(calls).toEqual(['clear']);
        expect(posted).toEqual([{ type: 'vh-badge-count', count: 0 }]);
        expect(store.calls).toBe(1);
    });

    it('never throws (no Badging API, failing store)', () => {
        store.throws = true;
        expect(() => clearNotificationStateOnLogout({})).not.toThrow();
        expect(store.calls).toBe(1);
    });
});
