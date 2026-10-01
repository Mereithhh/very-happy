import { beforeEach, describe, expect, it, vi } from 'vitest';

const played: string[] = [];
vi.mock('@/utils/chimes', () => ({ playChime: () => played.push('chime') }));
vi.mock('@/utils/soundPackPlayer', () => ({ playPackSound: async () => 'played' }));
vi.mock('./soundPrefs', () => ({ getSoundPrefs: () => ({ enabled: true, events: { permission: true, question: true, done: true }, voice: 'ding', volume: 0.5, pack: null }) }));
vi.mock('./notificationPrefs', () => ({ getNotificationPrefs: () => ({}), isWithinQuietHours: () => false }));

vi.stubGlobal('window', { location: { pathname: '/', search: '' } });
vi.stubGlobal('document', { visibilityState: 'hidden' });

const { maybePlayNotificationSound, chimeSlot, END_OF_TURN_FOLD_MS } = await import('./notificationChime');

describe('B-525 one ring per finished turn', () => {
    beforeEach(() => { played.length = 0; vi.useFakeTimers(); });

    it('done then a later review verdict for the same session ring once', async () => {
        maybePlayNotificationSound({ event: 'done', key: 's1', href: '/session/s1' });
        await vi.advanceTimersByTimeAsync(12_000);
        maybePlayNotificationSound({ event: 'question', key: 's1', href: '/session/s1' });
        expect(played).toEqual(['chime']);
        await vi.advanceTimersByTimeAsync(END_OF_TURN_FOLD_MS);
        maybePlayNotificationSound({ event: 'done', key: 's1', href: '/session/s1' });
        await vi.advanceTimersByTimeAsync(0);
        expect(played).toEqual(['chime', 'chime']);
    });

    it('a permission request keeps its own slot; other sessions are independent', async () => {
        maybePlayNotificationSound({ event: 'done', key: 's2', href: '/session/s2' });
        maybePlayNotificationSound({ event: 'permission', key: 's2', href: '/session/s2' });
        maybePlayNotificationSound({ event: 'done', key: 's3', href: '/session/s3' });
        await vi.advanceTimersByTimeAsync(0);
        expect(played).toHaveLength(3);
        expect(chimeSlot('s', 'question').slot).toBe(chimeSlot('s', 'done').slot);
    });
});

describe('B-525 one tab rings', () => {
    it('a second tab (same lock name held) stays silent', async () => {
        vi.useRealTimers();
        played.length = 0;
        if (!(globalThis.navigator as Navigator & { locks?: LockManager })?.locks) return; // no Web Locks here: per-tab only
        let release!: () => void;
        const held = navigator.locks.request('vh-chime:s9:end-of-turn', () => new Promise<void>((r) => { release = r; }));
        maybePlayNotificationSound({ event: 'done', key: 's9', href: '/session/s9' });
        await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
        expect(played).toEqual([]);
        release(); await held;
    });
});
