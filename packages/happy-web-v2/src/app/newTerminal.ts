import { useEffect } from 'react';
import { IS_MAC, isAppChord } from '@/app/appChord';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { storage } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { soleOnlineMachine, machineLabel, isMachineOnline } from '@/utils/machineUtils';
import { isImeGuardedEvent } from '@/utils/ime';
import { isClaudeSessionId } from '@/sync/closedTerminals';

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

/**
 * Open a NEW terminal on a SPECIFIC machine, starting in `cwd` (B-084: the
 * archive view's "new terminal in this directory" on a closed-terminal
 * record — where `claude --resume` can pick the old conversation back up).
 * Reuses the machinery createTerminalOrPick uses; the only addition is the
 * `cwd` query param, which the terminal screen forwards into the EXISTING
 * open-terminal RPC `cwd` field (the daemon's create path has always done
 * `tmux new-session -c <cwd>` — no protocol change, old daemons included).
 * Returns false (and does nothing) when the machine is unknown or offline.
 * Callers disable the button, so this is the imperative backstop — but it can
 * still lose the race (B-146: the machine drops between the dialog's fs-list
 * probe and the click), and a caller that closes its dialog afterwards MUST
 * check the result, or the user gets a dismissed dialog and no terminal.
 */
/**
 * @param resumeClaudeSessionId B-149: continue this claude conversation in the
 *   new terminal. Only the ID travels (as `resume`), never a command line — the
 *   terminal screen rebuilds `claude --resume <id>` after re-validating it, so a
 *   crafted URL cannot run something else in the user's shell.
 */
export function createTerminalAt(
  navigate: NavigateFunction,
  machineId: string,
  cwd?: string,
  resumeClaudeSessionId?: string,
): boolean {
  const m = storage.getState().machines[machineId];
  if (!m || !isMachineOnline(m)) return false;
  const term = useTerminalSessions.getState().create(machineId, machineLabel(m));
  const q = new URLSearchParams({ tid: term.id, fresh: '1' });
  if (cwd) q.set('cwd', cwd);
  if (isClaudeSessionId(resumeClaudeSessionId)) q.set('resume', resumeClaudeSessionId);
  navigate(`/terminal/${machineId}?${q.toString()}`);
  return true;
}

/** Shown next to the palette's "New terminal" action (matches the ⌘-badge style). */
export const NEW_TERMINAL_SHORTCUT_HINT = IS_MAC ? '⌘N · ⌥N' : 'Ctrl+N · Alt+N';

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
        isAppChord(e) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N'); // Ctrl+N = readline next-history，mac 上留给终端
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
