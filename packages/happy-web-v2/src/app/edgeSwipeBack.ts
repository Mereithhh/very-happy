/**
 * Mobile left-edge swipe → global back.
 *
 * Hand-written (no gesture library — zero new deps, same house rule the
 * sidebar resize handle and the terminal's touch-scroll shim follow). Touch
 * events, capture phase, PASSIVE: we never preventDefault, so nothing that
 * already listens (xterm's touch-scroll shim, native scrolling, selection) is
 * starved. The gesture only decides, at touchend, whether the finger drew a
 * back swipe; if it did we navigate, if it did not the app behaves exactly as
 * before.
 *
 * ── Terminal conflict, and the trade-off taken ────────────────────────────
 * `.term-host` spans the full viewport width on mobile, so a left-edge start
 * lands INSIDE xterm, and xterm's own drag handling (touch drag → synthetic
 * wheel, see WebTerminalScreen) also starts there. Two rules keep them apart:
 *
 *  1. **Select mode is absolute veto.** When the terminal is in select mode
 *     (`.term-host.is-selecting`) the user is deliberately dragging to select
 *     text — the gesture does not arm at all. Select mode is an explicit,
 *     visible toggle, so this is a user-legible rule, not a heuristic.
 *  2. **Stricter geometry on terminal routes.** Narrower start zone (14px vs
 *     24px), longer travel (96px vs 64px) and a tighter slope (0.35 vs 0.7).
 *     A scroll-back drag is near-vertical and rarely begins in the leftmost
 *     14px, so it cannot be mistaken for a back swipe; the cost is that the
 *     back swipe itself must be a deliberate, clearly horizontal stroke there.
 *
 * Residual, accepted: a qualifying terminal edge swipe ALSO feeds xterm's
 * wheel shim, but a horizontal stroke has ~no vertical delta, so it scrolls by
 * zero lines — visually a no-op. And it is far past the 12px tap threshold, so
 * it never summons the soft keyboard.
 *
 * Horizontally scrollable content (code blocks, wide tables in chat) vetoes
 * the gesture too — panning those must stay possible.
 */
import { useEffect, useRef } from 'react';

// Same probe the other touch-first gates use.
const IS_COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

export interface SwipeConfig {
  /** how close to the left screen edge the finger must land, px */
  edgeZone: number;
  /** minimum rightward travel to accept, px */
  minDistance: number;
  /** |dy| may not exceed this fraction of dx (0.7 ≈ 35°) */
  maxSlopeRatio: number;
  /** a slower stroke is a drag/scroll, not a flick, ms */
  maxDuration: number;
}

export const SWIPE_DEFAULT: SwipeConfig = {
  edgeZone: 24,
  minDistance: 64,
  maxSlopeRatio: 0.7,
  maxDuration: 700,
};

/** See the module header: xterm owns the same pixels, so the terminal demands
 *  a narrower start zone, a longer stroke and a flatter angle. */
export const SWIPE_TERMINAL: SwipeConfig = {
  edgeZone: 14,
  minDistance: 96,
  maxSlopeRatio: 0.35,
  maxDuration: 500,
};

export function swipeConfigFor(pathname: string): SwipeConfig {
  // Only an attached terminal view — the picker (`/terminal`) is an ordinary list.
  return pathname.startsWith('/terminal/') ? SWIPE_TERMINAL : SWIPE_DEFAULT;
}

export interface SwipePoint {
  x: number;
  y: number;
  t: number;
}

/** Everything that can veto arming the gesture, as data (pure + tested). */
export interface EdgeSwipeStart {
  x: number;
  /** number of active touch points — pinch/two-finger gestures are not ours */
  touchCount: number;
  /** the terminal is in explicit text-selection mode */
  terminalSelecting: boolean;
  /** the touch landed inside something that pans horizontally */
  horizontallyScrollable: boolean;
}

export function canStartEdgeSwipe(s: EdgeSwipeStart, cfg: SwipeConfig): boolean {
  if (s.touchCount !== 1) return false;
  if (s.terminalSelecting) return false;
  if (s.horizontallyScrollable) return false;
  return s.x >= 0 && s.x <= cfg.edgeZone;
}

export type SwipeVerdict = 'accept' | 'reject';

export function classifySwipe(start: SwipePoint, end: SwipePoint, cfg: SwipeConfig): SwipeVerdict {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dt = end.t - start.t;
  if (dt > cfg.maxDuration) return 'reject';
  if (dx < cfg.minDistance) return 'reject'; // also rejects leftward strokes
  if (Math.abs(dy) > cfg.maxSlopeRatio * dx) return 'reject';
  return 'accept';
}

// ---------------------------------------------------------------------------
// DOM side
// ---------------------------------------------------------------------------

/** Walks a few ancestors looking for a pannable horizontal scroller. */
function isInHorizontalScroller(target: EventTarget | null): boolean {
  let el = target as Element | null;
  for (let i = 0; el && i < 6; i += 1) {
    if (el.scrollWidth - el.clientWidth > 4) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

function terminalIsSelecting(): boolean {
  // Read from the DOM rather than plumbing state out of WebTerminalScreen —
  // the class is already the rendered truth and this keeps that file untouched.
  return document.querySelector('.term-host.is-selecting') !== null;
}

export function useEdgeSwipeBack(goBack: () => boolean): void {
  const backRef = useRef(goBack);
  backRef.current = goBack;

  useEffect(() => {
    if (!IS_COARSE_POINTER) return; // no touch → no gesture, no listeners

    let start: SwipePoint | null = null;
    let cfg = SWIPE_DEFAULT;

    const onTouchStart = (e: TouchEvent) => {
      start = null;
      const p = e.touches[0];
      if (!p) return;
      cfg = swipeConfigFor(window.location.pathname);
      const ok = canStartEdgeSwipe(
        {
          x: p.clientX,
          touchCount: e.touches.length,
          terminalSelecting: terminalIsSelecting(),
          horizontallyScrollable: isInHorizontalScroller(e.target),
        },
        cfg,
      );
      if (ok) start = { x: p.clientX, y: p.clientY, t: e.timeStamp };
    };

    const onTouchMove = (e: TouchEvent) => {
      if (start && e.touches.length > 1) start = null; // became a pinch
    };

    const onTouchEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s) return;
      const p = e.changedTouches[0];
      if (!p) return;
      if (classifySwipe(s, { x: p.clientX, y: p.clientY, t: e.timeStamp }, cfg) !== 'accept') return;
      backRef.current();
    };

    const onTouchCancel = () => {
      start = null;
    };

    // capture + passive: we observe, we never preventDefault.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('touchstart', onTouchStart, opts);
    window.addEventListener('touchmove', onTouchMove, opts);
    window.addEventListener('touchend', onTouchEnd, opts);
    window.addEventListener('touchcancel', onTouchCancel, opts);
    return () => {
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchCancel, true);
    };
  }, []);
}
