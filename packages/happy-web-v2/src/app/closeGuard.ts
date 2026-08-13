/**
 * closeGuard — the PURE logic behind ⌘W/⌥W "close the session" (B-089): the
 * chord matcher, which routes carry a closable target (and WHAT that target
 * is — chat session to archive vs terminal to close), whether to ask first,
 * and whether the tab-close guard should be armed.
 *
 * Why a separate module from the hooks in ./viewShortcuts.ts: those hooks pull
 * in Modal + i18n + the storage layer, and `@/text` reads persisted settings at
 * IMPORT time via the mmkv web shim — so merely importing them in the node test
 * environment throws (`localStorage.getItem` of undefined). Keeping the
 * decisions here keeps them unit-testable, which is the whole point.
 *
 * Everything here is duck-typed (no `instanceof` on DOM classes): keeps it
 * runnable without a DOM and immune to cross-realm instanceof.
 */

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

function isXtermTextarea(t: EventTarget | null): boolean {
  const el = t as ElementLike | null;
  return !!el?.classList?.contains?.('xterm-helper-textarea');
}

/** Shared with appBack.ts's chord matcher (Alt+← must never leave a text field). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as ElementLike | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

/** Pure chord matcher (exported for tests). Returns whether the event is the
 *  close-view chord AND is allowed to fire on its current target. */
export function matchCloseViewChord(e: {
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  key: string; code: string; target: EventTarget | null;
}): boolean {
  const cmdW = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'w' || e.key === 'W');
  // e.code, not e.key: macOS ⌥W produces "∑" in e.key.
  const altW = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyW';
  if (!cmdW && !altW) return false;
  // ⌥W in an ordinary editable target types "∑" — leave it alone. The xterm
  // helper textarea is deliberately NOT exempt (see viewShortcuts' header).
  if (altW && isEditableTarget(e.target) && !isXtermTextarea(e.target)) return false;
  return true;
}

/**
 * The object ⌘W acts on at this location — the chord means "close the
 * SESSION" (archive a chat / close a terminal), not "close the view" (B-089).
 *
 *  - `/session/:id`              → the chat session (archive flow)
 *  - `/terminal/:machineId?tid=` → the open terminal (close flow). The
 *    terminal PICKER (`/terminal`, or a machine route without ?tid) carries
 *    no target — only an actually-open terminal does.
 *  - anything else (home, /board, /assistant, settings…) → null: there is
 *    nothing to archive, so the chord is left entirely alone (the browser
 *    keeps its native ⌘W, ⌥W still types "∑").
 */
export type CloseViewTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; machineId: string; terminalId: string };

export function closeViewTarget(pathname: string, search: string): CloseViewTarget | null {
  const session = /^\/session\/([^/]+)\/?$/.exec(pathname);
  if (session) return { kind: 'session', sessionId: decodeURIComponent(session[1]) };
  const terminal = /^\/terminal\/([^/]+)\/?$/.exec(pathname);
  if (terminal) {
    const terminalId = new URLSearchParams(search).get('tid');
    if (terminalId) {
      return { kind: 'terminal', machineId: decodeURIComponent(terminal[1]), terminalId };
    }
  }
  return null;
}

/** True when the current location carries a ⌘W target (also gates the
 *  beforeunload guard — same routes, different layer). */
export function isClosableViewPath(pathname: string, search: string): boolean {
  return closeViewTarget(pathname, search) !== null;
}

/**
 * What the close-view chord should do right now.
 *
 *  - 'none'    — no closable target here: leave the event completely alone (⌥W
 *                must still type "∑" nowhere else, and ⌘W in a normal tab is
 *                the browser's anyway).
 *  - 'swallow' — eat the chord but do nothing: a confirm dialog is already up
 *                (or the archive/close is in flight), so key-repeat / a second
 *                ⌘W must not stack dialogs or double-fire, and the keystroke
 *                must not fall through to xterm either.
 *  - 'close'   — confirmation disabled (`closeViewConfirm` off): archive the
 *                session / close the terminal immediately, no dialog.
 *  - 'confirm' — ask first via the row-menu confirm, act only on confirm.
 */
export type CloseViewAction = 'none' | 'swallow' | 'close' | 'confirm';

export function closeViewAction(input: {
  closable: boolean;
  confirmEnabled: boolean;
  confirmOpen: boolean;
}): CloseViewAction {
  if (!input.closable) return 'none';
  if (input.confirmOpen) return 'swallow';
  return input.confirmEnabled ? 'confirm' : 'close';
}

/**
 * Should the browser's native "leave site?" dialog be armed?
 *
 * Deliberately narrow: only while a session/terminal view is actually open, so
 * idling on the home screen never nags. `programmaticReload` is the escape
 * hatch for OUR OWN reloads (stale-bundle auto-update, preload-error recovery,
 * logout) — arming against those would break the auto-update chain.
 */
export function shouldWarnOnUnload(input: {
  enabled: boolean;
  pathname: string;
  search: string;
  programmaticReload: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.programmaticReload) return false;
  return isClosableViewPath(input.pathname, input.search);
}

/**
 * Which element gets focus back after a cancelled close.
 *
 * `captured` is whatever had focus when the dialog opened (normally xterm's
 * helper textarea, or the chat composer). It is unusable if it went away while
 * the dialog was up, or if focus was on <body> to begin with — then fall back
 * (the caller passes the live terminal textarea).
 */
export function pickRefocusTarget<T extends { isConnected?: boolean }>(
  captured: T | null | undefined,
  fallback: T | null | undefined,
  body?: T | null,
): T | null {
  const usable = !!captured && captured.isConnected !== false && captured !== body;
  return usable ? (captured as T) : (fallback ?? null);
}
