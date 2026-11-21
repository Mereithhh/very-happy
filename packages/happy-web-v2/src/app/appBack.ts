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
 *     instead (see `backParentPath`), REPLACING the current entry so the
 *     stack stays empty and the next press keeps climbing (`backNavigation`).
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

/** List/team surface the user opened a session from, retained across reload. */
export type BackOrigin = 'home' | 'board' | '/teams' | `/teams/${string}`;

export type BackTarget =
  | { kind: 'history' }
  /** B-946: pop straight back to a list entry that is still behind us —
   *  `index` is its position in this document's stack (`delta` entries up). */
  | { kind: 'pop'; index: number; to: string; delta: number }
  | { kind: 'path'; to: string }
  | { kind: 'none' };

export interface BackContext {
  pathname: string;
  search: string;
  /** in-app navigations pushed in THIS document (0 after reload / cold start) */
  depth: number;
  origin: BackOrigin | null;
  /**
   * B-946: is a sidebar (or its rail / drawer) on screen? Defaults to `true`:
   * the two-pane shell, where the list stays visible beside the conversation
   * and rule 1 is right. On the single-pane shell it is `false` — there the
   * list is the level above, not the conversation behind.
   */
  pinnedSidebar?: boolean;
  /** Pathnames of this document's in-app entries, oldest → newest (the entry on
   *  screen last). Lets a list be reached by POPPING rather than replacing, so
   *  the system back button cannot walk into the conversation again. */
  trail?: readonly string[];
}

function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return p === '' ? '/' : p;
}

/**
 * Where the list lives. `/` in the app; the DEV device harness mounts the same
 * shell under `/dev/device`, and the rules below must read that exactly like
 * the real root (it is the same layout code on the same screens).
 */
let appRoot = '/';

export function setAppRoot(path: string): void {
  const p = normalizePath(path);
  appRoot = p === '' ? '/' : p;
}

export function getAppRoot(): string {
  return appRoot;
}

/** Route path → app-space path (`/dev/device/session/x` → `/session/x`). */
function inApp(pathname: string): string {
  const p = normalizePath(pathname);
  if (appRoot === '/') return p;
  if (p === appRoot) return '/';
  return p.startsWith(`${appRoot}/`) ? p.slice(appRoot.length) : p;
}

/** App-space path → route path. */
function onRoute(path: string): string {
  if (appRoot === '/') return path;
  return path === '/' ? appRoot : `${appRoot}${path}`;
}

/** The hub a given path IS (used to remember where a detail view was opened
 *  from, so a reloaded deep link can still fall back to the right list). */
export function navHubFor(pathname: string): BackOrigin | null {
  const p = inApp(pathname);
  if (p === '/') return 'home';
  if (p === '/board') return 'board';
  if (p === '/teams' || /^\/teams\/[^/]+$/.test(p)) return p as BackOrigin;
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
  const parent = backParentInApp(inApp(pathname), origin);
  return parent === null ? null : onRoute(parent);
}

function backParentInApp(p: string, origin: BackOrigin | null): string | null {
  // Root and the auth screens are terminal points — no back affordance.
  if (p === '/' || p === '/login' || p === '/signup') return null;
  // Detail views opened from a list go back to THAT list.
  const hub = origin === 'board' ? '/board' : origin?.startsWith('/teams') ? origin : '/';
  if (p === '/teams') return '/';
  if (p.startsWith('/teams/')) return '/teams';
  if (p === '/board') return '/';
  if (p === '/assistant') return '/';
  if (p.startsWith('/session/')) return hub;
  if (p === '/terminal') return '/'; // the picker is a chooser, not a hub child
  if (p.startsWith('/terminal/')) return hub;
  // B-796: every secondary page walks up its own hierarchy (a phone has no sidebar to fall back on).
  if (/^\/projects\/[^/]+\/settings$/.test(p)) return p.slice(0, -'/settings'.length);
  if (p.startsWith('/projects/')) return '/projects';
  if (/^\/automations\/[^/]+\/edit$/.test(p)) return p.slice(0, -'/edit'.length);
  if (p.startsWith('/automations/')) return '/automations';
  const panel = /^(\/machine\/[^/]+)\/panel\/[^/]+$/.exec(p);
  if (panel) return panel[1];
  // Machines are only listed inside Settings → Diagnostics.
  if (p.startsWith('/machine/')) return '/settings/machines';
  if (p === '/settings') return '/';
  if (p.startsWith('/settings/')) return '/settings';
  return '/';
}

/**
 * B-946: a detail view whose list is a *place* rather than a pane — a session
 * or an open terminal. Those are the routes the no-sidebar rule covers.
 */
export function isListDetail(pathname: string): boolean {
  const p = inApp(pathname);
  return p.startsWith('/session/') || /^\/terminal\/[^/]+$/.test(p);
}

/** Last stack position holding `pathname`, or −1 (normalized, so `/` ≈ `//`). */
function lastEntryIndex(trail: readonly string[], pathname: string): number {
  const want = normalizePath(pathname);
  for (let i = trail.length - 1; i >= 0; i--) if (normalizePath(trail[i]) === want) return i;
  return -1;
}

export function resolveBackTarget(ctx: BackContext): BackTarget {
  const parent = backParentPath(ctx.pathname, ctx.search, ctx.origin);
  if (parent === null) return { kind: 'none' };
  // B-946 (Owner 11-21): with no sidebar on screen, the list is the level
  // above a conversation — even when another conversation sits behind it. The
  // stack may still hold that list, and popping to it (instead of replacing)
  // is what keeps the system back button from walking into the conversation
  // again and bouncing back (the ping-pong backNavigation warns about).
  if (ctx.pinnedSidebar === false && isListDetail(ctx.pathname)) {
    const trail = ctx.trail ?? [];
    const index = lastEntryIndex(trail, parent);
    if (index >= 0 && index < ctx.depth) return { kind: 'pop', index, to: parent, delta: index - ctx.depth };
    return { kind: 'path', to: parent };
  }
  if (ctx.depth > 0) return { kind: 'history' };
  return { kind: 'path', to: parent };
}

/**
 * How a resolved target is handed to `navigate`. The parent fallback MUST
 * replace: it runs exactly when the in-app stack is empty (deep link / cold
 * start), and a PUSH there would bump the depth to 1 — the parent's own back
 * would then `navigate(-1)` straight into the deep link again, ping-ponging
 * child ↔ parent forever with no way home (B-798 P0-2). Replacing keeps the
 * depth at 0, so each press walks one level up the IA until `/`.
 */
export function backNavigation(
  target: BackTarget,
): { delta: number } | { to: string; replace: true } | null {
  if (target.kind === 'history') return { delta: -1 };
  if (target.kind === 'pop') return { delta: target.delta };
  if (target.kind === 'path') return { to: target.to, replace: true };
  return null;
}

/** In-app depth after one router transition. REPLACE keeps the depth: it swaps
 *  the current entry, it does not add one. */
export function nextNavDepth(depth: number, navType: 'PUSH' | 'POP' | 'REPLACE'): number {
  if (navType === 'PUSH') return depth + 1;
  if (navType === 'POP') return Math.max(0, depth - 1);
  return depth;
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

/** B-946: pathnames of this document's in-app entries, oldest → newest.
 *  Empty only before the first location is seen (or after the test seam). */
let navTrail: string[] = [];

/** Multi-entry pops this module performed itself: the router reports them as
 *  one POP, but the counters were already moved — see `dropNavTo`. */
let selfPops = 0;

/** B-946: whether a sidebar is on screen, published by AppLayout (the only
 *  place that knows the shell mode). `true` until a layout says otherwise, so
 *  the desktop rule is the default. */
let pinnedSidebar = true;

export function setPinnedSidebar(pinned: boolean): void {
  pinnedSidebar = pinned;
}

export function getPinnedSidebar(): boolean {
  return pinnedSidebar;
}

export function getNavDepth(): number {
  return navDepth;
}

export function getNavTrail(): readonly string[] {
  return navTrail;
}

/** Test seam. Production code never calls this — the counter is per-document
 *  and a fresh document is exactly what resets it. */
export function __setNavDepth(n: number): void {
  navDepth = n;
  navTrail = [];
  selfPops = 0;
}

/** Move the counters to `index` BEFORE the pop that `goBack` is about to run:
 *  the router will report one POP, which the tracker must not count again. */
export function dropNavTo(index: number): void {
  navDepth = Math.max(0, index);
  navTrail = navTrail.slice(0, navDepth + 1);
  selfPops += 1;
}

export function getNavOrigin(): BackOrigin | null {
  try {
    const v = sessionStorage.getItem(ORIGIN_KEY);
    return v === 'board' || v === 'home' ? v : v === '/teams' || (v && /^\/teams\/[^/]+$/.test(v)) ? v as BackOrigin : null;
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
      navTrail = [location.pathname];
    } else if (navType === 'POP' && selfPops > 0) {
      // A pop this module already accounted for (dropNavTo): keep the depth,
      // just record where we landed.
      selfPops -= 1;
      if (navTrail.length === 0) navTrail = [location.pathname];
      else navTrail[navTrail.length - 1] = location.pathname;
    } else {
      navDepth = nextNavDepth(navDepth, navType);
      if (navType === 'PUSH') navTrail.push(location.pathname);
      else if (navTrail.length === 0) navTrail = [location.pathname];
      else if (navType === 'REPLACE') navTrail[navTrail.length - 1] = location.pathname;
      else {
        navTrail.pop();
        if (navTrail.length === 0) navTrail = [location.pathname];
        else navTrail[navTrail.length - 1] = location.pathname;
      }
    }
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
      pinnedSidebar: getPinnedSidebar(),
      trail: navTrail,
    });
    const nav = backNavigation(target);
    if (!nav) return false;
    if ('delta' in nav) {
      // B-946: a multi-entry pop has to move the bookkeeping first — the
      // router will report the whole jump as ONE POP.
      if (target.kind === 'pop') dropNavTo(target.index);
      navigate(nav.delta);
    } else navigate(nav.to, { replace: nav.replace });
    return true;
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

/** Read at touchstart, so it follows the live URL rather than the last render. */
function canGoBackNow(): boolean {
  return backParentPath(window.location.pathname, window.location.search, null) !== null;
}

/**
 * Installs every global back trigger. Mounted once, above all authenticated
 * screens (including the chromeless assistant, which lives outside AppLayout).
 */
export function useGlobalBackNav(): void {
  useNavHistoryTracker();
  const { goBack } = useAppBack();
  useBackShortcuts(goBack);
  useEdgeSwipeBack(goBack, canGoBackNow);
}
