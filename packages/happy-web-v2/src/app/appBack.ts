/**
 * Global "back" — ONE semantic, one control, three triggers.
 *
 * Before this module every detail screen grew its own back arrow with its own
 * meaning (chat → `/`, terminal → `/`, board → `/`, settings → parent page),
 * so "back" meant something different depending on where you were standing and
 * never returned you to the conversation you actually came from.
 *
 * The unified rule:
 *
 *  1. **Real history first.** If this browsing session has pushed at least one
 *     in-app entry, `navigate(-1)` — that is what returns you to the previous
 *     conversation / terminal / settings page, exactly like the browser back
 *     button but scoped to the app.
 *  2. **Hierarchical parent otherwise.** Deep link, PWA cold start or a full
 *     reload all land you on a detail view with an EMPTY in-app stack; going
 *     "back" would leave the app. Then we walk up the information architecture
 *     instead (see `backParentPath`).
 *  3. **Nothing at the root.** `/` has no parent — the control hides.
 *
 * Why an own depth counter and not `document.referrer` / `history.length`:
 * `referrer` is empty for same-document SPA navigation and `history.length`
 * counts entries from OTHER sites in the same tab — stepping back into those
 * is precisely the bug we are avoiding. The counter below only ever moves on
 * router transitions we performed ourselves, and it starts at 0 on every fresh
 * document (reload / cold start), which is the case rule 2 exists for.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { isImeGuardedEvent } from '@/utils/ime';
import { isEditableTarget } from '@/app/closeGuard';
import { useEdgeSwipeBack } from '@/app/edgeSwipeBack';

// ---------------------------------------------------------------------------
// pure semantics (unit-tested; no DOM, no router)
// ---------------------------------------------------------------------------

/** Which hub the user came through. Only ever `/` or `/board` — those are the
 *  two list surfaces a detail view can be opened from. */
export type BackOrigin = 'home' | 'board';

export type BackTarget =
  | { kind: 'history' }
  | { kind: 'path'; to: string }
  | { kind: 'none' };

export interface BackContext {
  pathname: string;
  search: string;
  /** in-app navigations pushed in THIS document (0 after reload / cold start) */
  depth: number;
  origin: BackOrigin | null;
}

function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return p === '' ? '/' : p;
}

/** The hub a given path IS (used to remember where a detail view was opened
 *  from, so a reloaded deep link can still fall back to the right list). */
export function navHubFor(pathname: string): BackOrigin | null {
  const p = normalizePath(pathname);
  if (p === '/') return 'home';
  if (p === '/board') return 'board';
  return null;
}

/**
 * Hierarchical parent of a route, or `null` when there is none (root / auth
 * screens). This is the fallback used when there is no in-app history.
 *
 * `_search` is part of the contract (the resolver is specified over path+search)
 * even though the current table does not branch on it: `/terminal/:mid?tid=`
 * (an open terminal) and `/terminal/:mid` (attaching) share the same parent.
 */
export function backParentPath(
  pathname: string,
  _search: string,
  origin: BackOrigin | null,
): string | null {
  const p = normalizePath(pathname);
  // Root and the auth screens are terminal points — no back affordance.
  if (p === '/' || p === '/login' || p === '/signup') return null;
  // Detail views opened from a list go back to THAT list.
  const hub = origin === 'board' ? '/board' : '/';
  if (p === '/board') return '/';
  if (p === '/assistant') return '/';
  if (p.startsWith('/session/')) return hub;
  if (p === '/terminal') return '/'; // the picker is a chooser, not a hub child
  if (p.startsWith('/terminal/')) return hub;
  // Machines are only listed inside Settings → Diagnostics.
  if (p.startsWith('/machine/')) return '/settings/diagnostics';
  if (p === '/settings') return '/';
  if (p.startsWith('/settings/')) return '/settings';
  return '/';
}

export function resolveBackTarget(ctx: BackContext): BackTarget {
  const parent = backParentPath(ctx.pathname, ctx.search, ctx.origin);
  if (parent === null) return { kind: 'none' };
  if (ctx.depth > 0) return { kind: 'history' };
  return { kind: 'path', to: parent };
}

/**
 * Back chord: `⌘[` (mac, matching Safari/Chrome) and `Alt+←` (everywhere).
 *
 * Editable targets: `Alt+←` is "move one word left" in every text field AND in
 * readline/shells inside the terminal, so it is NEVER stolen from an editable
 * target — including the xterm helper textarea. That is a deliberate departure
 * from ⌥W in `viewShortcuts.ts` (which DOES fire inside xterm): ⌥W has no
 * shell binding worth preserving, Alt+← very much does. `⌘[` has no
 * text-editing meaning on macOS, so it fires on any target and is the chord
 * that works while the terminal has focus.
 */
export function matchBackChord(e: {
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  key: string; code: string; target: EventTarget | null;
}): boolean {
  const cmdBracket =
    e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
    // e.code as well as e.key: '[' moves around under non-US layouts.
    (e.key === '[' || e.code === 'BracketLeft');
  const altArrow =
    e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft';
  if (!cmdBracket && !altArrow) return false;
  if (altArrow && isEditableTarget(e.target)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// in-app history depth + origin (module state, one per document)
// ---------------------------------------------------------------------------

const ORIGIN_KEY = 'vh.backOrigin';

let navDepth = 0;

export function getNavDepth(): number {
  return navDepth;
}

/** Test seam. Production code never calls this — the counter is per-document
 *  and a fresh document is exactly what resets it. */
export function __setNavDepth(n: number): void {
  navDepth = n;
}

export function getNavOrigin(): BackOrigin | null {
  try {
    const v = sessionStorage.getItem(ORIGIN_KEY);
    return v === 'board' || v === 'home' ? v : null;
  } catch {
    return null;
  }
}

function setNavOrigin(o: BackOrigin): void {
  try {
    // sessionStorage, not memory: it is the ONE piece of back context that must
    // survive a reload — the reloaded page has depth 0 and needs to know which
    // list the detail view was opened from.
    sessionStorage.setItem(ORIGIN_KEY, o);
  } catch {
    /* private mode / storage disabled — fall back to '/' */
  }
}

/** Tracks in-app navigations. Mounted once, above every authenticated screen. */
function useNavHistoryTracker(): void {
  const location = useLocation();
  const navType = useNavigationType();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
    } else if (navType === 'PUSH') {
      navDepth += 1;
    } else if (navType === 'POP') {
      navDepth = Math.max(0, navDepth - 1);
    }
    // REPLACE keeps the depth: it swaps the current entry, it does not add one.
    const hub = navHubFor(location.pathname);
    if (hub) setNavOrigin(hub);
    // location.key changes once per history entry — the right granularity.
  }, [location.key, location.pathname, navType]);
}

// ---------------------------------------------------------------------------
// the hook every trigger shares
// ---------------------------------------------------------------------------

export interface AppBack {
  /** Whether this route has anywhere to go back to (drives control visibility). */
  canGoBack: boolean;
  /** Performs the back navigation. Returns false when there was nothing to do
   *  (so a key handler can decline to preventDefault). */
  goBack: () => boolean;
}

export function useAppBack(): AppBack {
  const navigate = useNavigate();
  const location = useLocation();
  // Latest location in a ref so `goBack` keeps a stable identity: the global
  // key/gesture listeners register once and must never act on a stale route.
  const locRef = useRef(location);
  locRef.current = location;

  const goBack = useCallback((): boolean => {
    const l = locRef.current;
    const target = resolveBackTarget({
      pathname: l.pathname,
      search: l.search,
      depth: getNavDepth(),
      origin: getNavOrigin(),
    });
    if (target.kind === 'history') {
      navigate(-1);
      return true;
    }
    if (target.kind === 'path') {
      navigate(target.to);
      return true;
    }
    return false;
  }, [navigate]);

  return {
    // Whether a parent EXISTS never depends on the origin (origin only picks
    // WHICH hub), so this stays a pure function of the route — no storage read
    // on every render of every header.
    canGoBack: backParentPath(location.pathname, location.search, null) !== null,
    goBack,
  };
}

/** ⌘[ / Alt+← — capture phase so xterm's textarea handler cannot eat it. */
function useBackShortcuts(goBack: () => boolean): void {
  const backRef = useRef(goBack);
  backRef.current = goBack;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImeGuardedEvent(e)) return;
      if (!matchBackChord(e)) return;
      // Only claim the chord if we actually handled it; at the root we let the
      // browser's own back run (leaving the app is then the user's intent).
      if (!backRef.current()) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

/**
 * Installs every global back trigger. Mounted once, above all authenticated
 * screens (including the chromeless assistant, which lives outside AppLayout).
 */
export function useGlobalBackNav(): void {
  useNavHistoryTracker();
  const { goBack } = useAppBack();
  useBackShortcuts(goBack);
  useEdgeSwipeBack(goBack);
}
