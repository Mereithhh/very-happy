// @vitest-environment happy-dom
/** B-567: auto-read needs a human — visible + focused + recent trusted input. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ensurePresenceTracking, hasRecentInput, isUserPresent, notePresenceInput, PRESENCE_INPUT_EVENTS,
    PRESENCE_INPUT_WINDOW_MS, readPresence, resetPresenceForTest, subscribePresenceInput,
} from './userPresence';

const NOW = 1_800_000_000_000;
const snap = (o: Partial<Parameters<typeof isUserPresent>[0]> = {}) => ({ visible: true, focused: true, lastInputAt: NOW - 1000, now: NOW, ...o });

describe('isUserPresent (pure)', () => {
    it('present = visible + focused + input within 5 min', () => {
        expect(isUserPresent(snap())).toBe(true);
        expect(isUserPresent(snap({ lastInputAt: NOW - PRESENCE_INPUT_WINDOW_MS }))).toBe(true);
        expect(isUserPresent(snap({ lastInputAt: NOW - PRESENCE_INPUT_WINDOW_MS - 1 }))).toBe(false);
    });
    it('hidden or unfocused is not present', () => {
        expect(isUserPresent(snap({ visible: false }))).toBe(false);
        expect(isUserPresent(snap({ focused: false }))).toBe(false);
    });
    it('unknown presence does not count (never any input / hasFocus unavailable)', () => {
        expect(isUserPresent(snap({ lastInputAt: null }))).toBe(false);
        expect(isUserPresent(snap({ focused: null }))).toBe(false);
        expect(hasRecentInput(snap({ lastInputAt: null }))).toBe(false);
    });
    it('mobile: a tap that opened the session makes the user present', () => {
        // PWA foreground: visible + hasFocus true; the tap is the input
        expect(isUserPresent(snap({ lastInputAt: NOW - 700 }))).toBe(true);
    });
});

describe('presence carrier', () => {
    afterEach(() => resetPresenceForTest());

    it('listens to exactly the four input kinds, capture + passive, on one target', () => {
        const add = vi.fn();
        ensurePresenceTracking({ addEventListener: add, removeEventListener: vi.fn() } as never);
        ensurePresenceTracking({ addEventListener: add, removeEventListener: vi.fn() } as never); // idempotent
        expect(add.mock.calls.map((c) => c[0])).toEqual([...PRESENCE_INPUT_EVENTS]);
        expect(PRESENCE_INPUT_EVENTS).toEqual(['pointerdown', 'keydown', 'wheel', 'touchstart']);
        for (const c of add.mock.calls) expect(c[2]).toEqual({ capture: true, passive: true });
    });

    it('records only trusted input', () => {
        notePresenceInput({ isTrusted: false }, NOW);
        expect(readPresence(NOW).lastInputAt).toBeNull();
        notePresenceInput({ isTrusted: true }, NOW);
        expect(readPresence(NOW).lastInputAt).toBe(NOW);
    });

    it('synthetic DOM events (isTrusted=false) never mark presence', () => {
        ensurePresenceTracking();
        window.dispatchEvent(new Event('pointerdown'));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        expect(readPresence().lastInputAt).toBeNull();
    });

    it('notifies subscribers at most once per second, but always records the time', () => {
        const cb = vi.fn();
        const off = subscribePresenceInput(cb);
        notePresenceInput({ isTrusted: true }, NOW);
        notePresenceInput({ isTrusted: true }, NOW + 500);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(readPresence(NOW + 500).lastInputAt).toBe(NOW + 500);
        notePresenceInput({ isTrusted: true }, NOW + 1500);
        expect(cb).toHaveBeenCalledTimes(2);
        off();
        notePresenceInput({ isTrusted: true }, NOW + 5000);
        expect(cb).toHaveBeenCalledTimes(2);
    });
});
