/**
 * closeGuard — the PURE logic behind "closing the current session view": the
 * ⌘W/⌥W chord matcher, which routes count as closable, what the chord should
 * do (close vs ask first), and whether the tab-close guard should be armed.
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

/** True when the current location is a closable detail view. */
export function isClosableViewPath(pathname: string, search: string): boolean {
  if (pathname.startsWith('/session/')) return true;
  // The terminal picker (/terminal, no tid) is not a "session" — only close
  // an actual open terminal view.
  if (pathname.startsWith('/terminal/') && new URLSearchParams(search).has('tid')) return true;
  return false;
}

/**
 * What the close-view chord should do right now.
 *
 *  - 'none'    — not a closable view: leave the event completely alone (⌥W must
 *                still type "∑" nowhere else, and ⌘W in a normal tab is the
 *                browser's anyway).
 *  - 'swallow' — eat the chord but do nothing: a confirm dialog is already up,
 *                so key-repeat / a second ⌘W must not stack dialogs, and the
 *                keystroke must not fall through to xterm either.
 *  - 'close'   — confirmation disabled: navigate home immediately (legacy
 *                behavior).
 *  - 'confirm' — ask first, close only on confirm.
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
