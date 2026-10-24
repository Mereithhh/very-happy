import { describe, it, expect } from 'vitest';
import {
  DRAWER_COMMIT,
  drawerOffset,
  edgeGestureFor,
  inEdgeZone,
  lockAxis,
  shouldCommit,
  strokeMayArm,
  SYSTEM_EDGE_STRIP,
  velocityX,
  releaseVelocity,
  drawerOpenZone,
  DRAWER_EDGE_ZONE,
} from './edgeGesture';

describe('edgeGestureFor', () => {
  it('the drawer shell owns the edge, standalone or not', () => {
    expect(edgeGestureFor({ drawerMode: true, standalone: true, canGoBack: true })).toBe('drawer');
    expect(edgeGestureFor({ drawerMode: true, standalone: false, canGoBack: false })).toBe('drawer');
  });

  it('standalone with somewhere to go = back', () => {
    expect(edgeGestureFor({ drawerMode: false, standalone: true, canGoBack: true })).toBe('back');
  });

  it('a browser tab keeps its own edge-back — we never answer it', () => {
    expect(edgeGestureFor({ drawerMode: false, standalone: false, canGoBack: true })).toBeNull();
  });

  it('the root list has nowhere to go back to', () => {
    expect(edgeGestureFor({ drawerMode: false, standalone: true, canGoBack: false })).toBeNull();
  });
});

describe('inEdgeZone (measured from the safe-area inset)', () => {
  it('shifts the zone by --sa-l', () => {
    expect(inEdgeZone(10, 0, { from: 0, to: 24 })).toBe(true);
    // 47px landscape notch: x = 10 is inside the inset, x = 60 is 13px past it.
    expect(inEdgeZone(10, 47, { from: 0, to: 24 })).toBe(false);
    expect(inEdgeZone(60, 47, { from: 0, to: 24 })).toBe(true);
    expect(inEdgeZone(72, 47, { from: 0, to: 24 })).toBe(false);
  });

  it('the drawer zone leaves the system strip to a browser tab only', () => {
    expect(inEdgeZone(8, 0, drawerOpenZone(false, 0))).toBe(false);
    expect(inEdgeZone(SYSTEM_EDGE_STRIP + 4, 0, drawerOpenZone(false, 0))).toBe(true);
    expect(inEdgeZone(8, 0, drawerOpenZone(true, 0))).toBe(true);
    expect(inEdgeZone(DRAWER_EDGE_ZONE + 1, 0, drawerOpenZone(true, 0))).toBe(false);
  });

  it('with a left inset the drawer zone ends past the inset; the browser strip stays physical', () => {
    const sa = 47;
    // standalone: the whole inset plus the rail
    expect(inEdgeZone(2, sa, drawerOpenZone(true, sa))).toBe(true);
    expect(inEdgeZone(sa + DRAWER_EDGE_ZONE, sa, drawerOpenZone(true, sa))).toBe(true);
    expect(inEdgeZone(sa + DRAWER_EDGE_ZONE + 1, sa, drawerOpenZone(true, sa))).toBe(false);
    // browser: only x < 16 (physical) is the browser's
    expect(inEdgeZone(10, sa, drawerOpenZone(false, sa))).toBe(false);
    expect(inEdgeZone(20, sa, drawerOpenZone(false, sa))).toBe(true);
  });
});

describe('strokeMayArm', () => {
  const base = { touchCount: 1, terminalSelecting: false, horizontallyScrollable: false };
  it('arms a plain one-finger touch', () => expect(strokeMayArm(base)).toBe(true));
  it('horizontal scrollers (code, tables, key bar, breadcrumbs) win', () => {
    expect(strokeMayArm({ ...base, horizontallyScrollable: true })).toBe(false);
  });
  it('terminal select mode vetoes', () => expect(strokeMayArm({ ...base, terminalSelecting: true })).toBe(false));
  it('multi-touch is never ours', () => {
    expect(strokeMayArm({ ...base, touchCount: 2 })).toBe(false);
    expect(strokeMayArm({ ...base, touchCount: 0 })).toBe(false);
  });
});

describe('lockAxis', () => {
  it('waits for the slop', () => expect(lockAxis(4, 3, 1, 0.7)).toBe('pending'));
  it('a flat stroke the right way is ours', () => {
    expect(lockAxis(20, 5, 1, 0.7)).toBe('horizontal');
    expect(lockAxis(-20, 5, -1, 0.7)).toBe('horizontal');
  });
  it('the wrong direction is not', () => {
    expect(lockAxis(-20, 0, 1, 0.7)).toBe('vertical');
    expect(lockAxis(20, 0, -1, 0.7)).toBe('vertical');
  });
  it('a steep stroke is a scroll', () => expect(lockAxis(10, 30, 1, 0.7)).toBe('vertical'));
  it('a tighter slope rejects what a loose one accepts', () => {
    expect(lockAxis(30, 15, 1, 0.7)).toBe('horizontal');
    expect(lockAxis(30, 15, 1, 0.35)).toBe('vertical');
  });
});

describe('velocityX', () => {
  it('uses only the recent window', () => {
    const s = [{ x: 0, t: 0 }, { x: 10, t: 500 }, { x: 60, t: 550 }, { x: 110, t: 600 }];
    expect(velocityX(s)).toBeCloseTo(1); // 100px / 100ms
  });
  it('is 0 without two samples', () => {
    expect(velocityX([])).toBe(0);
    expect(velocityX([{ x: 3, t: 1 }])).toBe(0);
  });
  it('falls back to the last pair when samples are sparse', () => {
    expect(velocityX([{ x: 0, t: 0 }, { x: 40, t: 400 }])).toBeCloseTo(0.1);
  });
});

describe('releaseVelocity', () => {
  const moves = [{ x: 0, t: 0 }, { x: 30, t: 30 }, { x: 60, t: 60 }];
  it('a finger lifted mid-motion keeps its velocity', () => {
    expect(releaseVelocity(moves, 70)).toBeCloseTo(1);
  });
  it('a finger that stopped before lifting has none', () => {
    expect(releaseVelocity(moves, 200)).toBe(0);
  });
  it('no moves, no velocity', () => expect(releaseVelocity([], 10)).toBe(0));
});

describe('shouldCommit', () => {
  const W = 300;
  it('a slow release commits past the fraction', () => {
    expect(shouldCommit(W * 0.39, 0, W, DRAWER_COMMIT)).toBe(false);
    expect(shouldCommit(W * 0.41, 0, W, DRAWER_COMMIT)).toBe(true);
  });
  it('a flick commits short of it', () => {
    expect(shouldCommit(40, 0.8, W, DRAWER_COMMIT)).toBe(true);
  });
  it('a twitch is not a flick', () => {
    expect(shouldCommit(10, 2, W, DRAWER_COMMIT)).toBe(false);
  });
  it('flicking back cancels even past the distance', () => {
    expect(shouldCommit(W * 0.8, -0.8, W, DRAWER_COMMIT)).toBe(false);
  });
});

describe('drawerOffset', () => {
  it('opening tracks the finger from fully closed', () => {
    expect(drawerOffset(300, false, 0)).toBe(-300);
    expect(drawerOffset(300, false, 120)).toBe(-180);
    expect(drawerOffset(300, false, 500)).toBe(0);
  });
  it('closing tracks it from fully open, never past either end', () => {
    expect(drawerOffset(300, true, -100)).toBe(-100);
    expect(drawerOffset(300, true, 50)).toBe(0);
    expect(drawerOffset(300, true, -900)).toBe(-300);
  });
});
