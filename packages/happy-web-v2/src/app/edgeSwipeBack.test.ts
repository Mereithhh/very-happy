import { describe, it, expect } from 'vitest';
import {
  canStartEdgeSwipe,
  classifySwipe,
  swipeConfigFor,
  SWIPE_DEFAULT,
  SWIPE_TERMINAL,
} from './edgeSwipeBack';

describe('swipeConfigFor', () => {
  it('uses the strict terminal profile only on an attached terminal view', () => {
    expect(swipeConfigFor('/terminal/m1')).toBe(SWIPE_TERMINAL);
    expect(swipeConfigFor('/terminal')).toBe(SWIPE_DEFAULT);
    expect(swipeConfigFor('/session/a')).toBe(SWIPE_DEFAULT);
    expect(swipeConfigFor('/board')).toBe(SWIPE_DEFAULT);
  });

  it('the terminal profile really is stricter on every axis', () => {
    expect(SWIPE_TERMINAL.edgeZone).toBeLessThan(SWIPE_DEFAULT.edgeZone);
    expect(SWIPE_TERMINAL.minDistance).toBeGreaterThan(SWIPE_DEFAULT.minDistance);
    expect(SWIPE_TERMINAL.maxSlopeRatio).toBeLessThan(SWIPE_DEFAULT.maxSlopeRatio);
  });
});

describe('canStartEdgeSwipe', () => {
  const base = {
    x: 5,
    touchCount: 1,
    terminalSelecting: false,
    horizontallyScrollable: false,
  };

  it('arms inside the edge zone', () => {
    expect(canStartEdgeSwipe(base, SWIPE_DEFAULT)).toBe(true);
    expect(canStartEdgeSwipe({ ...base, x: 24 }, SWIPE_DEFAULT)).toBe(true);
  });

  it('does not arm away from the edge', () => {
    expect(canStartEdgeSwipe({ ...base, x: 25 }, SWIPE_DEFAULT)).toBe(false);
    expect(canStartEdgeSwipe({ ...base, x: 200 }, SWIPE_DEFAULT)).toBe(false);
  });

  it('the terminal zone is narrower — 20px arms elsewhere but not there', () => {
    expect(canStartEdgeSwipe({ ...base, x: 20 }, SWIPE_DEFAULT)).toBe(true);
    expect(canStartEdgeSwipe({ ...base, x: 20 }, SWIPE_TERMINAL)).toBe(false);
    expect(canStartEdgeSwipe({ ...base, x: 10 }, SWIPE_TERMINAL)).toBe(true);
  });

  it('terminal select mode vetoes the gesture outright (the user is selecting text)', () => {
    expect(canStartEdgeSwipe({ ...base, terminalSelecting: true }, SWIPE_TERMINAL)).toBe(false);
    expect(canStartEdgeSwipe({ ...base, terminalSelecting: true }, SWIPE_DEFAULT)).toBe(false);
  });

  it('horizontally pannable content wins (code blocks, wide tables)', () => {
    expect(canStartEdgeSwipe({ ...base, horizontallyScrollable: true }, SWIPE_DEFAULT)).toBe(false);
  });

  it('multi-touch is never a back swipe', () => {
    expect(canStartEdgeSwipe({ ...base, touchCount: 2 }, SWIPE_DEFAULT)).toBe(false);
    expect(canStartEdgeSwipe({ ...base, touchCount: 0 }, SWIPE_DEFAULT)).toBe(false);
  });
});

describe('classifySwipe', () => {
  const start = { x: 8, y: 300, t: 0 };

  it('accepts a fast, flat, rightward stroke', () => {
    expect(classifySwipe(start, { x: 100, y: 310, t: 200 }, SWIPE_DEFAULT)).toBe('accept');
  });

  it('rejects a short stroke', () => {
    expect(classifySwipe(start, { x: 60, y: 300, t: 200 }, SWIPE_DEFAULT)).toBe('reject');
  });

  it('rejects a leftward stroke', () => {
    expect(classifySwipe(start, { x: 0, y: 300, t: 200 }, SWIPE_DEFAULT)).toBe('reject');
  });

  it('rejects a mostly vertical stroke — that is a scroll', () => {
    expect(classifySwipe(start, { x: 100, y: 420, t: 200 }, SWIPE_DEFAULT)).toBe('reject');
  });

  it('rejects a slow drag', () => {
    expect(classifySwipe(start, { x: 200, y: 300, t: 1500 }, SWIPE_DEFAULT)).toBe('reject');
  });

  it('the terminal profile rejects strokes the default profile accepts', () => {
    // 92px, 10px of drift: fine anywhere else, too short inside a terminal.
    expect(classifySwipe(start, { x: 100, y: 310, t: 200 }, SWIPE_DEFAULT)).toBe('accept');
    expect(classifySwipe(start, { x: 100, y: 310, t: 200 }, SWIPE_TERMINAL)).toBe('reject');
    // 150px with 60px of drift: a diagonal scroll-back drag, accepted by the
    // loose profile, rejected by the terminal one.
    expect(classifySwipe(start, { x: 158, y: 360, t: 300 }, SWIPE_DEFAULT)).toBe('accept');
    expect(classifySwipe(start, { x: 158, y: 360, t: 300 }, SWIPE_TERMINAL)).toBe('reject');
    // A deliberate long flat stroke still works in the terminal.
    expect(classifySwipe(start, { x: 158, y: 310, t: 300 }, SWIPE_TERMINAL)).toBe('accept');
  });
});
