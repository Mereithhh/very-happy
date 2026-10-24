/**
 * Edge gestures (B-800): the pure decisions shared by the two touch gestures
 * the shell owns, plus the few DOM probes they need.
 *
 *  - **Drawer** (`drawerSwipe.ts`, B-795 drawer mode): a right swipe from the
 *    left edge pulls the sidebar drawer open, a left swipe on the open drawer
 *    pushes it shut. The drawer tracks the finger; release decides.
 *  - **Back** (`edgeSwipeBack.ts`): a right swipe from the left edge = appBack,
 *    ONLY in a standalone PWA. iOS gives a Home-Screen web app no system back
 *    gesture; in a browser tab Safari / Chrome already own the edge, and two
 *    gestures answering one stroke (Safari pops history while we navigate too)
 *    is exactly the conflict to avoid — so the browser keeps it.
 *
 * Who answers a stroke is decided once, at touchstart (`edgeGestureFor`): the
 * drawer whenever the shell is in drawer mode, else back. Phones never have a
 * drawer (the sidebar IS the root list), so on a phone the swipe is "back to the
 * list" in standalone and the browser's own back otherwise.
 *
 * Geometry: every zone is measured from the safe-area inset (`--sa-l`), not from
 * x = 0 — in landscape the inset is notch/status area the finger can't start in
 * on purpose. A swipe starting inside something that pans horizontally (code
 * block, table, terminal key bar, breadcrumb, tab strip) is never ours.
 */
import { isStandalonePwa } from '@/app/pwaInstallPolicy';

// ---------------------------------------------------------------------------
// pure (unit-tested)
// ---------------------------------------------------------------------------

export type EdgeGesture = 'drawer' | 'back' | null;

/** Which gesture may answer an edge stroke, from the shell's state at touchstart. */
export function edgeGestureFor(s: { drawerMode: boolean; standalone: boolean; canGoBack: boolean }): EdgeGesture {
  if (s.drawerMode) return 'drawer';
  if (s.standalone && s.canGoBack) return 'back';
  return null;
}

export interface EdgeZone {
  /** px past the safe-area inset where the zone starts (a strip the OS owns) */
  from: number;
  /** px past the safe-area inset where it ends */
  to: number;
}

/**
 * Browser tabs leave the outermost strip to the browser's own edge-back
 * (iPadOS Safari, Android gesture nav). The drawer still opens from the rest of
 * the rail; standalone has no system gesture there, so it takes the whole zone.
 */
export const SYSTEM_EDGE_STRIP = 16;

/** The rail (52px on touch, after the inset) is where the finger lands to open the drawer; the zone covers most of it. */
export const DRAWER_EDGE_ZONE = 44;

/**
 * Relative to the inset like every zone, but the strip a browser keeps is PHYSICAL
 * (the browser's edge-back starts at x = 0, inset or not), so it is shifted back.
 */
export function drawerOpenZone(standalone: boolean, safeLeft: number): EdgeZone {
  return { from: (standalone ? 0 : SYSTEM_EDGE_STRIP) - safeLeft, to: DRAWER_EDGE_ZONE };
}

export function inEdgeZone(x: number, safeLeft: number, zone: EdgeZone): boolean {
  const rel = x - safeLeft;
  return rel >= zone.from && rel <= zone.to;
}

export interface StrokeStart {
  /** active touch points — pinch / two-finger gestures are not ours */
  touchCount: number;
  /** terminal select mode: the user is dragging to select text */
  terminalSelecting: boolean;
  /** the finger landed inside something that pans horizontally */
  horizontallyScrollable: boolean;
}

export function strokeMayArm(s: StrokeStart): boolean {
  return s.touchCount === 1 && !s.terminalSelecting && !s.horizontallyScrollable;
}

export type AxisLock = 'pending' | 'horizontal' | 'vertical';

/**
 * Decides, once the finger has moved `slop` px, whether the stroke is ours.
 * `dir` is the direction that drives the gesture (+1 right, −1 left); a stroke
 * the wrong way, or steeper than `maxSlope` (|dy| / |dx|), is a scroll.
 */
export function lockAxis(dx: number, dy: number, dir: 1 | -1, maxSlope: number, slop = 10): AxisLock {
  if (Math.hypot(dx, dy) < slop) return 'pending';
  const along = dx * dir;
  if (along <= 0) return 'vertical';
  return Math.abs(dy) <= maxSlope * along ? 'horizontal' : 'vertical';
}

export interface Sample {
  x: number;
  t: number;
}

/** Horizontal velocity (px/ms) over the last `windowMs` of samples; 0 with too little data. */
export function velocityX(samples: readonly Sample[], windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/**
 * Velocity at release, from the MOVE samples only: touchend repeats the last
 * position with a later time, which would read every flick as a slow-down. A
 * finger that sat still for `stillMs` before lifting has no velocity.
 */
export function releaseVelocity(moves: readonly Sample[], releaseT: number, windowMs = 100, stillMs = 80): number {
  const last = moves[moves.length - 1];
  if (!last || releaseT - last.t > stillMs) return 0;
  return velocityX(moves, windowMs);
}

export interface CommitRule {
  /** fraction of `extent` that commits on a slow release */
  fraction: number;
  /** velocity (px/ms, along the gesture) that counts as a flick */
  flick: number;
  /** a flick still needs this much travel (px) — a twitch is not a swipe */
  flickMinTravel: number;
}

export const DRAWER_COMMIT: CommitRule = { fraction: 0.4, flick: 0.45, flickMinTravel: 24 };

/**
 * Release decision. `travel` and `velocity` are signed ALONG the gesture
 * (positive = towards completing). A flick back the other way cancels even past
 * the distance threshold — the user changed their mind mid-stroke.
 */
export function shouldCommit(travel: number, velocity: number, extent: number, rule: CommitRule): boolean {
  if (velocity <= -rule.flick) return false;
  if (velocity >= rule.flick && travel >= rule.flickMinTravel) return true;
  return travel >= extent * rule.fraction;
}

/** Drawer offset (0 = fully open, −width = closed) for a finger `dx` from the stroke start. */
export function drawerOffset(width: number, wasOpen: boolean, dx: number): number {
  const raw = wasOpen ? dx : -width + dx;
  return Math.max(-width, Math.min(0, raw));
}

// ---------------------------------------------------------------------------
// DOM probes
// ---------------------------------------------------------------------------

/** Pans horizontally by design even before it overflows (a key bar on a wide screen). */
const HSCROLL_SELECTOR = 'pre, table, .term-keybar, [data-no-edge-swipe]';

/** True when the touch landed in something that pans horizontally (vetoes every edge gesture). */
export function isInHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest(HSCROLL_SELECTOR)) return true;
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth - el.clientWidth > 4) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
  }
  return false;
}

export function terminalIsSelecting(): boolean {
  // The class is the rendered truth; reading it keeps WebTerminalScreen untouched.
  return document.querySelector('.term-host.is-selecting') !== null;
}

let standaloneMq: MediaQueryList | null | undefined;

export function isStandalone(): boolean {
  if (standaloneMq === undefined) standaloneMq = window.matchMedia?.('(display-mode: standalone)') ?? null;
  return isStandalonePwa(standaloneMq?.matches === true, (navigator as Navigator & { standalone?: boolean }).standalone);
}

let insetProbe: HTMLElement | null = null;

/** `--sa-l` in px (env(safe-area-inset-left) cannot be read from script directly). */
export function safeAreaLeft(): number {
  if (!insetProbe || !insetProbe.isConnected) {
    insetProbe = document.createElement('div');
    insetProbe.setAttribute('aria-hidden', 'true');
    insetProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-left:var(--sa-l)';
    document.body.appendChild(insetProbe);
  }
  return parseFloat(getComputedStyle(insetProbe).paddingLeft) || 0;
}

export const IS_COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
