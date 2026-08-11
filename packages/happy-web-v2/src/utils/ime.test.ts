import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_COMPOSITION_MS,
  isImeComposingEvent,
  isImeGuardedEvent,
  markCompositionEnd,
  wasRecentlyComposing,
} from './ime';

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // Push any composition mark from a previous test far outside the window.
  markCompositionEnd(T0 - 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isImeComposingEvent / isImeGuardedEvent', () => {
  it('lets a normal Enter through (no composition context)', () => {
    const e = { key: 'Enter', isComposing: false, keyCode: 13 };
    expect(isImeComposingEvent(e)).toBe(false);
    expect(isImeGuardedEvent(e)).toBe(false);
  });

  it('blocks a keydown with isComposing set (active composition)', () => {
    expect(isImeGuardedEvent({ key: 'Enter', isComposing: true })).toBe(true);
  });

  it('reads isComposing off nativeEvent for React synthetic events', () => {
    const e = { key: 'Enter', nativeEvent: { isComposing: true } as unknown as Event };
    expect(isImeGuardedEvent(e)).toBe(true);
  });

  it("blocks Chrome's key === 'Process' (key swallowed by the IME)", () => {
    expect(isImeGuardedEvent({ key: 'Process', isComposing: false })).toBe(true);
  });

  it('blocks Enter within the post-compositionend window (Safari committing Enter)', () => {
    markCompositionEnd(); // compositionend just fired
    vi.advanceTimersByTime(40); // committing keydown lands 40ms later
    expect(isImeGuardedEvent({ key: 'Enter', isComposing: false })).toBe(true);
  });

  it('lets Enter through once the post-compositionend window has passed', () => {
    markCompositionEnd();
    vi.advanceTimersByTime(RECENT_COMPOSITION_MS + 1);
    expect(isImeGuardedEvent({ key: 'Enter', isComposing: false })).toBe(false);
  });

  it('Android regression: bare keyCode 229 with NO composition context is NOT blocked', () => {
    // GBoard & co. report 229 for EVERY key, including a plain Enter — the
    // old `keyCode === 229` check disabled Enter-to-submit on all of Android.
    const e = { key: 'Enter', isComposing: false, keyCode: 229 };
    expect(isImeComposingEvent(e)).toBe(false);
    expect(isImeGuardedEvent(e)).toBe(false);
  });
});

describe('wasRecentlyComposing', () => {
  it('tracks the marked compositionend moment against the given window', () => {
    markCompositionEnd(T0);
    expect(wasRecentlyComposing(50, T0 + 49)).toBe(true);
    expect(wasRecentlyComposing(50, T0 + 50)).toBe(false);
    expect(wasRecentlyComposing(200, T0 + 100)).toBe(true);
  });
});
