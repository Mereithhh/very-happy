/**
 * B-800: drag the B-795 sidebar drawer open from the left edge, and shut by
 * swiping left on it. The drawer follows the finger (inline margin-left, the
 * same property the CSS animates — never transform, see layout.css) and the
 * scrim fades with it; on release `shouldCommit` picks open/closed by distance
 * or flick velocity, and the inline styles are dropped so the CSS transition
 * settles from where the finger left it (instantly under reduced motion).
 *
 * Passive listeners: we never preventDefault, so the sidebar list keeps its
 * native vertical scroll — a stroke that locks vertical is simply not ours.
 */
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import {
  drawerOffset,
  DRAWER_COMMIT,
  drawerOpenZone,
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
  type Sample,
} from '@/app/edgeGesture';
import { useSidebarPrefs } from '@/app/useSidebarPrefs';

const DRAWER_MAX_SLOPE = 0.7;

const DRAWER_SEL = '.app-sidebar--drawer';
const SCRIM_SEL = '.app-drawer-scrim';

export function useDrawerSwipe(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !IS_COARSE_POINTER) return;

    let stroke: { x: number; y: number; open: boolean; dir: 1 | -1 } | null = null;
    let axis: AxisLock = 'pending';
    let samples: Sample[] = [];
    let width = 0;
    let aside: HTMLElement | null = null;
    let scrim: HTMLElement | null = null;

    const clearInline = () => {
      for (const el of [aside, scrim]) {
        if (!el) continue;
        el.style.removeProperty('transition');
        el.style.removeProperty('visibility');
        el.style.removeProperty('margin-left');
        el.style.removeProperty('opacity');
      }
    };
    const reset = () => {
      clearInline();
      stroke = null;
      axis = 'pending';
      samples = [];
      aside = scrim = null;
    };

    const onTouchStart = (e: TouchEvent) => {
      reset();
      const p = e.touches[0];
      if (!p) return;
      const { drawer, drawerOpen } = useSidebarPrefs.getState();
      if (!drawer) return; // the drawer shell answers every edge stroke (edgeGestureFor)
      const target = e.target instanceof Element ? e.target : null;
      if (drawerOpen) {
        // Close: anywhere on the drawer or its scrim — but not inside a dialog the sidebar opened.
        if (!target?.closest(`${DRAWER_SEL}, ${SCRIM_SEL}`) || target.closest('.vh-dialog-overlay')) return;
      } else {
        const safeLeft = safeAreaLeft();
        if (!inEdgeZone(p.clientX, safeLeft, drawerOpenZone(isStandalone(), safeLeft))) return;
      }
      const ok = strokeMayArm({
        touchCount: e.touches.length,
        terminalSelecting: terminalIsSelecting(),
        horizontallyScrollable: isInHorizontalScroller(e.target),
      });
      if (!ok) return;
      stroke = { x: p.clientX, y: p.clientY, open: drawerOpen, dir: drawerOpen ? -1 : 1 };
      samples = [{ x: p.clientX, t: e.timeStamp }];
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!stroke) return;
      if (e.touches.length > 1) return reset();
      const p = e.touches[0];
      if (!p) return;
      const dx = p.clientX - stroke.x;
      samples.push({ x: p.clientX, t: e.timeStamp });
      if (samples.length > 12) samples.shift();
      if (axis === 'pending') {
        axis = lockAxis(dx, p.clientY - stroke.y, stroke.dir, DRAWER_MAX_SLOPE);
        if (axis === 'horizontal') {
          aside = document.querySelector<HTMLElement>(DRAWER_SEL);
          scrim = document.querySelector<HTMLElement>(SCRIM_SEL);
          width = aside?.offsetWidth ?? 0;
          if (!aside || width <= 0) return reset();
        }
      }
      if (axis === 'vertical') return reset();
      if (axis !== 'horizontal' || !aside) return;
      const offset = drawerOffset(width, stroke.open, dx);
      aside.style.transition = 'none';
      aside.style.visibility = 'visible';
      aside.style.marginLeft = `${offset}px`;
      if (scrim) {
        scrim.style.transition = 'none';
        scrim.style.visibility = 'visible';
        scrim.style.opacity = String(1 + offset / width);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const s = stroke;
      const p = e.changedTouches[0];
      if (!s || axis !== 'horizontal' || !p) return reset();
      const travel = (p.clientX - s.x) * s.dir;
      const commit = shouldCommit(travel, releaseVelocity(samples, e.timeStamp) * s.dir, width, DRAWER_COMMIT);
      const open = s.open ? !commit : commit;
      // Class first, then drop the inline position: the CSS transition runs from the finger's spot.
      flushSync(() => useSidebarPrefs.getState().setDrawerOpen(open));
      reset();
    };

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
  }, [enabled]);
}
