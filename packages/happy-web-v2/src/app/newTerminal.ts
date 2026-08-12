import { useEffect } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { storage } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { soleOnlineMachine, machineLabel } from '@/utils/machineUtils';
import { isImeGuardedEvent } from '@/utils/ime';

/**
 * The ONE "new terminal" entry point — every button/shortcut/palette item goes
 * through here so they all share the same behavior:
 *
 *   exactly 1 online machine → create the terminal there and jump straight to
 *   it (the terminal screen has its own connecting state, no loading needed);
 *   0 or >1 online           → the machine picker at /terminal (which shows an
 *                              empty state when there are no machines at all).
 *
 * Reads the stores imperatively (getState) so callers don't need to subscribe
 * to machines just to open a terminal — and the decision uses the freshest
 * state at click time rather than a render-time snapshot.
 */
export function createTerminalOrPick(navigate: NavigateFunction): void {
  const m = soleOnlineMachine(Object.values(storage.getState().machines));
  if (m) {
    const term = useTerminalSessions.getState().create(m.id, machineLabel(m));
    // fresh=1: the ONE open allowed to create the tmux session (see
    // WebTerminalScreen) — every other open is attach-only.
    navigate(`/terminal/${m.id}?tid=${term.id}&fresh=1`);
  } else {
    navigate('/terminal');
  }
}

/** Shown next to the palette's "New terminal" action (matches the ⌘-badge style). */
export const NEW_TERMINAL_SHORTCUT_HINT = '⌘N · ⌥N';

/** True for targets where plain typing must win over shortcuts (inputs,
 *  textareas — including xterm's hidden helper textarea — and contenteditable). */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

/**
 * Global new-terminal shortcuts. Mounted at AppLayout level (NOT in Sidebar,
 * where the old ⌘N listener lived) so they keep working with the sidebar
 * collapsed, on mobile detail screens, and on /board.
 *
 *   ⌘/Ctrl+N — browser-reserved in normal tabs (Chrome opens its own window
 *              before the page ever sees the event); it DOES reach us in the
 *              installed PWA window, so keep it for that case.
 *   ⌥N       — the normal-tab fallback: not on any browser's reserved list
 *              (⌃T would be — Ctrl+T is "new tab" on Windows/Linux, and Emacs
 *              transpose in terminals). Skipped while typing in an editable
 *              target: inside a terminal ⌥N is the shell's Meta-N, and in text
 *              inputs macOS uses ⌥N as a dead key — those must not be stolen.
 */
export function useNewTerminalShortcuts(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // IME guard: keys routed through a CJK composition never trigger shortcuts.
      if (isImeGuardedEvent(e)) return;
      const cmdN =
        (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N');
      // e.code, not e.key: on macOS ⌥N produces a dead key ('Dead'/'˜'), the
      // physical-key code is the only stable way to match the chord.
      const altN = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyN';
      if (!cmdN && !altN) return;
      if (altN && isEditableTarget(e.target)) return;
      // Ctrl+N (no ⌘) while typing is readline/shell "down-history" — leave it
      // to the terminal/input. ⌘N is a pure app chord and always wins.
      if (cmdN && !e.metaKey && isEditableTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      createTerminalOrPick(navigate);
    };
    // CAPTURE phase: run before any focused widget can swallow the shortcut
    // (same registration style as the sidebar's ⌘1-9 / ⌘R listener).
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [navigate]);
}
