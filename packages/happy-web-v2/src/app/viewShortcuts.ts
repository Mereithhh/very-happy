/**
 * Close-current-view shortcut: ⌘W (PWA) / ⌥W (normal-tab fallback).
 *
 * Semantics: CLOSE THE VIEW — navigate back to home. Never kills/archives the
 * session; it's the editor-tab-close gesture, not a destructive action.
 *
 * Platform reality (same story as ⌘N in ./newTerminal.ts): ⌘W is
 * browser-reserved in a normal Chrome tab — preventDefault is ignored and the
 * TAB closes before the page sees anything. Only the installed PWA window
 * delivers it to the page. So ⌘W is the PWA chord, ⌥W the normal-tab fallback.
 *
 * ⌥W and editable targets: in ordinary inputs macOS ⌥W types "∑" — don't
 * steal that. The xterm helper textarea is the exception: focus practically
 * lives there whenever a terminal is open (the very view you want to close),
 * and Meta-W has no shell/claude-TUI binding worth preserving, so ⌥W IS
 * intercepted inside the terminal.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isImeGuardedEvent } from '@/utils/ime';

// Duck-typed (no instanceof DOM classes): keeps the matcher pure and unit-
// testable in the node test environment, and immune to cross-realm instanceof.
interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

function isXtermTextarea(t: EventTarget | null): boolean {
  const el = t as ElementLike | null;
  return !!el?.classList?.contains?.('xterm-helper-textarea');
}

function isEditableTarget(t: EventTarget | null): boolean {
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
  // helper textarea is deliberately NOT exempt (see module comment).
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

export function useCloseViewShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImeGuardedEvent(e)) return;
      if (!matchCloseViewChord(e)) return;
      // window.location (not a captured router value): this once-registered
      // capture handler must never act on a stale route.
      if (!isClosableViewPath(window.location.pathname, window.location.search)) return;
      e.preventDefault(); // effective in the PWA; a normal tab ignores it for ⌘W
      e.stopPropagation();
      navigate('/');
    };
    // CAPTURE phase — beat xterm's textarea keydown handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [navigate]);
}
