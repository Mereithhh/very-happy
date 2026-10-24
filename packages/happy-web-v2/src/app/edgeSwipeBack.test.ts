import { describe, it, expect } from 'vitest';
import { backShouldCommit, swipeConfigFor, SWIPE_DEFAULT, SWIPE_TERMINAL } from './edgeSwipeBack';

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
    expect(SWIPE_TERMINAL.flick).toBeGreaterThan(SWIPE_DEFAULT.flick);
    expect(SWIPE_TERMINAL.flickMinTravel).toBeGreaterThan(SWIPE_DEFAULT.flickMinTravel);
  });
});

describe('backShouldCommit', () => {
  it('a slow drag goes back once it reaches minDistance', () => {
    expect(backShouldCommit(63, 0, SWIPE_DEFAULT)).toBe(false);
    expect(backShouldCommit(64, 0, SWIPE_DEFAULT)).toBe(true);
  });

  it('a flick goes back early, but not on a twitch', () => {
    expect(backShouldCommit(40, 0.9, SWIPE_DEFAULT)).toBe(true);
    expect(backShouldCommit(20, 0.9, SWIPE_DEFAULT)).toBe(false);
  });

  it('dragging back towards the edge cancels', () => {
    expect(backShouldCommit(120, -0.6, SWIPE_DEFAULT)).toBe(false);
  });

  it('the terminal profile rejects strokes the default profile accepts', () => {
    expect(backShouldCommit(92, 0, SWIPE_DEFAULT)).toBe(true);
    expect(backShouldCommit(92, 0, SWIPE_TERMINAL)).toBe(false);
    expect(backShouldCommit(40, 0.6, SWIPE_DEFAULT)).toBe(true);
    expect(backShouldCommit(40, 0.6, SWIPE_TERMINAL)).toBe(false);
    expect(backShouldCommit(100, 0, SWIPE_TERMINAL)).toBe(true);
  });
});
