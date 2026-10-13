/**
 * B-588 — board card column-change animation (FLIP: First, Last, Invert, Play).
 *
 * Only a COLUMN change animates: streaming updates re-render cards constantly
 * but leave the key→column map alone, so they never move anything. The pure
 * helpers below are unit-tested; `useBoardFlip` wires them to the DOM.
 *
 * Why a ghost and not the card itself: each column is its own scroll container
 * (`.bd-col-list` / `.bd-lane-cards`), so translating the real card across
 * columns gets clipped. A fixed-position clone flies over the layout instead,
 * the real card stays in place (hidden) — no layout change at all.
 *
 * Idea from Orca `dashboard-popout/useDashboardSnapshot.ts` (animate only when
 * the column signature changes; MIT). Implementation is ours.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

export const FLIP_DURATION_MS = 180;
const FLIP_EASING = 'cubic-bezier(.2, 0, 0, 1)';
/** Scroll containers that clip a card; a card outside its container's view does not fly. */
const CLIP_SELECTOR = '.bd-col-list, .bd-lane-cards, .bd-cols, .bd-lanes';

export type ColumnMap = Readonly<Record<string, string>>;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keys present in both maps whose column differs (new / removed cards do not fly). */
export function columnChanges(prev: ColumnMap, next: ColumnMap): string[] {
  const moved: string[] = [];
  for (const key of Object.keys(next)) {
    const before = prev[key];
    if (before !== undefined && before !== next[key]) moved.push(key);
  }
  return moved;
}

/** Stable signature of a column map, so equal maps across renders compare cheaply. */
export function columnSignature(map: ColumnMap): string {
  return Object.keys(map)
    .sort()
    .map((key) => `${key}\u0001${map[key]}`)
    .join('\u0002');
}

/** The translate that puts a card at `last` back where it was (`first`). */
export function flipDelta(first: Box, last: Box): { dx: number; dy: number } {
  return { dx: first.left - last.left, dy: first.top - last.top };
}

/** A box counts as visible when at least half of its height is inside `clip`. */
export function isVisibleWithin(box: Box, clip: Box): boolean {
  if (box.width <= 0 || box.height <= 0) return false;
  const top = Math.max(box.top, clip.top);
  const bottom = Math.min(box.top + box.height, clip.top + clip.height);
  const left = Math.max(box.left, clip.left);
  const right = Math.min(box.left + box.width, clip.left + clip.width);
  if (right <= left) return false;
  return bottom - top >= box.height / 2;
}

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function viewportBox(): Box {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/** Visible within its nearest clipping container AND the viewport. */
function visibleBox(el: HTMLElement): Box | null {
  const box = toBox(el.getBoundingClientRect());
  if (!isVisibleWithin(box, viewportBox())) return null;
  const clip = el.parentElement?.closest<HTMLElement>(CLIP_SELECTOR);
  if (clip && !isVisibleWithin(box, toBox(clip.getBoundingClientRect()))) return null;
  return box;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function cardsByKey(container: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-flip-key]'))) {
    const key = el.dataset.flipKey;
    if (key) map.set(key, el);
  }
  return map;
}

/**
 * Animate cards whose column changed. `columns` is the key→column map of the
 * render being committed; cards carry `data-flip-key`.
 *
 * First rects are read during render — the DOM still shows the previous
 * commit at that point — and only when the column signature changed.
 */
export function useBoardFlip(
  containerRef: RefObject<HTMLElement | null>,
  columns: ColumnMap,
  /** a different scope (e.g. switching board layout) re-baselines without animating */
  scope = '',
): void {
  const committed = useRef<{ signature: string; columns: ColumnMap; scope: string }>({ signature: '', columns: {}, scope });
  const firstRects = useRef<Map<string, Box>>(new Map());
  const ghosts = useRef<Map<string, { ghost: HTMLElement; card: HTMLElement; anim?: Animation }>>(new Map());

  const signature = columnSignature(columns);
  const changed = signature !== committed.current.signature;
  // A new signature always starts from a clean slate: stale First rects from a
  // render that never committed (or a skipped scope / reduced-motion pass)
  // must not fly cards on the next commit.
  if (changed) firstRects.current = new Map();
  if (changed && committed.current.signature && committed.current.scope === scope && containerRef.current && !prefersReducedMotion()) {
    const moved = columnChanges(committed.current.columns, columns);
    if (moved.length > 0) {
      const els = cardsByKey(containerRef.current);
      const rects = new Map<string, Box>();
      for (const key of moved) {
        const el = els.get(key);
        const box = el ? visibleBox(el) : null;
        if (box) rects.set(key, box);
      }
      firstRects.current = rects;
    }
  }

  useLayoutEffect(() => {
    if (signature === committed.current.signature && scope === committed.current.scope) return;
    committed.current = { signature, columns, scope };
    const firsts = firstRects.current;
    firstRects.current = new Map();
    const container = containerRef.current;
    if (!container || firsts.size === 0 || prefersReducedMotion()) return;
    const els = cardsByKey(container);
    for (const [key, first] of firsts) {
      const card = els.get(key);
      if (!card) continue;
      const last = visibleBox(card);
      if (!last) continue;
      const { dx, dy } = flipDelta(first, last);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      ghosts.current.get(key)?.anim?.finish();
      const ghost = card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-flip-key');
      ghost.removeAttribute('tabindex');
      ghost.setAttribute('aria-hidden', 'true');
      // A clone of an interactive card: no focus, no clicks, no find-in-page.
      ghost.inert = true;
      ghost.classList.add('bd-card-ghost');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: `${last.left}px`,
        top: `${last.top}px`,
        width: `${last.width}px`,
        height: `${last.height}px`,
        margin: '0',
      });
      document.body.appendChild(ghost);
      card.style.visibility = 'hidden';
      const entry: { ghost: HTMLElement; card: HTMLElement; anim?: Animation } = { ghost, card };
      ghosts.current.set(key, entry);
      const cleanup = () => {
        ghost.remove();
        card.style.visibility = '';
        if (ghosts.current.get(key) === entry) ghosts.current.delete(key);
      };
      if (typeof ghost.animate !== 'function') {
        cleanup();
        continue;
      }
      entry.anim = ghost.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
      );
      entry.anim.onfinish = cleanup;
      entry.anim.oncancel = cleanup;
    }
  });

  // Unmount mid-flight: drop the ghosts, restore the cards.
  useLayoutEffect(() => {
    const live = ghosts.current;
    return () => {
      for (const { anim } of Array.from(live.values())) anim?.cancel();
    };
  }, []);
}
