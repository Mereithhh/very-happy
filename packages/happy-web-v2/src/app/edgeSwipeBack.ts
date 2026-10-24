/**
 * Left-edge swipe → global back, in a standalone PWA only (B-054, B-800).
 *
 * Why standalone only: a Home-Screen web app on iOS has no system back
 * gesture, so the edge swipe is ours to give. In a browser tab Safari's own
 * edge-back already pops history; answering the same stroke a second time made
 * one swipe go back twice. The browser keeps it (see edgeGesture.ts). In the
 * B-795 drawer shell the edge opens the drawer instead (drawerSwipe.ts).
 *
 * Hand-written (no gesture library — zero new deps). Touch events, capture
 * phase, PASSIVE: we never preventDefault, so nothing that already listens
 * (xterm's touch-scroll shim, native scrolling, selection) is starved. While
 * the finger moves, a chevron follows it from the edge and fills once a release
 * would go back; release decides by distance or flick velocity.
 *
 * ── Terminal conflict, and the trade-off taken ────────────────────────────
 * `.term-host` spans the full viewport width on mobile, so a left-edge start
 * lands INSIDE xterm, and xterm's own drag handling (touch drag → synthetic
 * wheel, see WebTerminalScreen) also starts there. Two rules keep them apart:
 *
 *  1. **Select mode is absolute veto.** When the terminal is in select mode
 *     (`.term-host.is-selecting`) the user is deliberately dragging to select
 *     text — the gesture does not arm at all.
 *  2. **Stricter geometry on terminal routes.** Narrower start zone (14px vs
 *     24px), longer travel (96px vs 64px) and a tighter slope (0.35 vs 0.7).
 *     A scroll-back drag is near-vertical and rarely begins in the leftmost
 *     14px, so it cannot be mistaken for a back swipe.
 *
 * Residual, accepted: a qualifying terminal edge swipe ALSO feeds xterm's
 * wheel shim, but a horizontal stroke has ~no vertical delta, so it scrolls by
 * zero lines — visually a no-op.
 */
import { useEffect, useRef } from 'react';
import {
  edgeGestureFor,
  inEdgeZone,
  isInHorizontalScroller,
  isStandalone,
  IS_COARSE_POINTER,
  lockAxis,
  safeAreaLeft,
  shouldCommit,
  strokeMayArm,
  terminalIsSelecting,
  releaseVelocity,
  type AxisLock,
  type CommitRule,
  type Sample,
} from '@/app/edgeGesture';
import './edgeGesture.css';

export interface SwipeConfig {
  /** how far past the safe-area inset the finger may land, px */
  edgeZone: number;
  /** rightward travel that goes back on a slow release, px */
  minDistance: number;
  /** |dy| may not exceed this fraction of dx (0.7 ≈ 35°) */
  maxSlopeRatio: number;
  /** flick: velocity (px/ms) and the travel it still needs */
  flick: number;
  flickMinTravel: number;
}

export const SWIPE_DEFAULT: SwipeConfig = {
  edgeZone: 24,
  minDistance: 64,
  maxSlopeRatio: 0.7,
  flick: 0.5,
  flickMinTravel: 32,
};

/** See the module header: xterm owns the same pixels, so the terminal demands
 *  a narrower start zone, a longer stroke and a flatter angle. */
export const SWIPE_TERMINAL: SwipeConfig = {
  edgeZone: 14,
  minDistance: 96,
  maxSlopeRatio: 0.35,
  flick: 0.7,
  flickMinTravel: 56,
};

export function swipeConfigFor(pathname: string): SwipeConfig {
  // Only an attached terminal view — the picker (`/terminal`) is an ordinary list.
  return pathname.startsWith('/terminal/') ? SWIPE_TERMINAL : SWIPE_DEFAULT;
}

export function backCommitRule(cfg: SwipeConfig): CommitRule {
  return { fraction: 1, flick: cfg.flick, flickMinTravel: cfg.flickMinTravel };
}

/** Release verdict for a back stroke: `dx` from the start, `vx` px/ms. */
export function backShouldCommit(dx: number, vx: number, cfg: SwipeConfig): boolean {
  return shouldCommit(dx, vx, cfg.minDistance, backCommitRule(cfg));
}

const CHEVRON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';

export function useEdgeSwipeBack(goBack: () => boolean, canGoBack: () => boolean): void {
  const backRef = useRef(goBack);
  backRef.current = goBack;
  const canRef = useRef(canGoBack);
  canRef.current = canGoBack;

  useEffect(() => {
    if (!IS_COARSE_POINTER) return; // no touch → no gesture, no listeners

    let start: { x: number; y: number; safeLeft: number } | null = null;
    let cfg = SWIPE_DEFAULT;
    let axis: AxisLock = 'pending';
    let samples: Sample[] = [];
    let cue: HTMLDivElement | null = null;

    const hideCue = () => {
      cue?.remove();
      cue = null;
    };
    const showCue = (y: number, dx: number, safeLeft: number) => {
      if (!cue) {
        cue = document.createElement('div');
        cue.className = 'vh-edge-back';
        cue.setAttribute('aria-hidden', 'true');
        cue.innerHTML = CHEVRON;
        document.body.appendChild(cue);
      }
      const progress = Math.min(1, Math.max(0, dx / cfg.minDistance));
      cue.style.top = `${y}px`;
      cue.style.left = `${safeLeft}px`;
      cue.style.setProperty('--edge-progress', String(progress));
      cue.classList.toggle('is-armed', progress >= 1);
    };

    const reset = () => {
      start = null;
      axis = 'pending';
      samples = [];
      hideCue();
    };

    const onTouchStart = (e: TouchEvent) => {
      reset();
      const p = e.touches[0];
      if (!p) return;
      const gesture = edgeGestureFor({
        // The rendered shell, not useSidebarPrefs: this module sits under appBack, which loads without storage.
        drawerMode: document.querySelector('.app-sidebar--drawer') !== null,
        standalone: isStandalone(),
        canGoBack: canRef.current(),
      });
      if (gesture !== 'back') return;
      cfg = swipeConfigFor(window.location.pathname);
      const safeLeft = safeAreaLeft();
      // Zone first: the scroller walk only runs for touches that start at the edge.
      if (!inEdgeZone(p.clientX, safeLeft, { from: -safeLeft, to: cfg.edgeZone })) return;
      const ok = strokeMayArm({
        touchCount: e.touches.length,
        terminalSelecting: terminalIsSelecting(),
        horizontallyScrollable: isInHorizontalScroller(e.target),
      });
      if (!ok) return;
      start = { x: p.clientX, y: p.clientY, safeLeft };
      samples = [{ x: p.clientX, t: e.timeStamp }];
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      if (e.touches.length > 1) return reset(); // became a pinch
      const p = e.touches[0];
      if (!p) return;
      const dx = p.clientX - start.x;
      samples.push({ x: p.clientX, t: e.timeStamp });
      if (samples.length > 12) samples.shift();
      if (axis === 'pending') axis = lockAxis(dx, p.clientY - start.y, 1, cfg.maxSlopeRatio);
      if (axis === 'vertical') return reset();
      if (axis === 'horizontal') showCue(start.y, dx, start.safeLeft);
    };

    const onTouchEnd = (e: TouchEvent) => {
      const s = start;
      const locked = axis === 'horizontal';
      const p = e.changedTouches[0];
      const vx = releaseVelocity(samples, e.timeStamp);
      reset();
      if (!s || !p || !locked) return;
      if (!backShouldCommit(p.clientX - s.x, vx, cfg)) return;
      backRef.current();
    };

    // capture + passive: we observe, we never preventDefault.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('touchstart', onTouchStart, opts);
    window.addEventListener('touchmove', onTouchMove, opts);
    window.addEventListener('touchend', onTouchEnd, opts);
    window.addEventListener('touchcancel', reset, opts);
    return () => {
      reset();
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', reset, true);
    };
  }, []);
}
