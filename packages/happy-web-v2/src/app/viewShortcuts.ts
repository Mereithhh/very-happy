/**
 * Close-the-SESSION shortcut: ⌘W (PWA) / ⌥W (normal-tab fallback), plus the
 * tab-close guard.
 *
 * Semantics (B-089 — the old "close the view, go home" reading was wrong):
 * ⌘W means "I'm done with this session". On a chat session view it runs the
 * row-menu archive flow (rowActions.confirmArchiveSession → kill-first
 * archive); on an open terminal view it runs the row-menu close flow
 * (rowActions.confirmCloseTerminal → ends the tmux session, B-083 neutral
 * copy). After the session is gone we navigate home — the same place the
 * sidebar row actions leave you. On every other route (home, /board,
 * /assistant, settings…) the chord is NOT handled at all: there is nothing to
 * archive, so the browser keeps its native ⌘W and ⌥W still types "∑".
 *
 * Two layers, covering different scenarios:
 *
 *  layer 1 (useCloseViewShortcuts) — the in-app flow above. The confirm
 *    dialog is gated by the `closeViewConfirm` local setting: ON (default) =
 *    ask first, OFF = archive/close immediately. Reachable wherever the page
 *    actually receives the chord: ⌘W in the installed PWA, ⌥W anywhere.
 *  layer 2 (useUnloadGuard) — the browser's own leave-site dialog. In a normal
 *    Chrome tab ⌘W is browser-reserved: preventDefault is ignored and the TAB
 *    closes before the page sees anything, so layer 1 never runs. `beforeunload`
 *    is the ONLY hook that exists there — its wording and styling belong to the
 *    browser, we can only ask for it. (Closing the tab does NOT archive
 *    anything — the session keeps running without a viewer.)
 *
 * Platform reality (same story as ⌘N in ./newTerminal.ts): only the installed
 * PWA window delivers ⌘W to the page. So ⌘W is the PWA chord, ⌥W the normal-tab
 * fallback.
 *
 * ⌥W and editable targets: in ordinary inputs macOS ⌥W types "∑" — don't steal
 * that. The xterm helper textarea is the exception: focus practically lives
 * there whenever a terminal is open (the very view you want to close), and
 * Meta-W has no shell/claude-TUI binding worth preserving, so ⌥W IS intercepted
 * inside the terminal.
 *
 * Pure decisions live in ./closeGuard.ts (this module can't be imported from a
 * node test — see that file's header).
 */
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { isImeGuardedEvent } from '@/utils/ime';
import { Modal } from '@/modal';
import { t } from '@/i18n/useTranslation';
import { storage, useLocalSetting } from '@/sync/storage';
import {
  closeViewAction,
  closeViewTarget,
  matchCloseViewChord,
  pickRefocusTarget,
  shouldWarnOnUnload,
  type CloseViewTarget,
} from '@/app/closeGuard';
import { isProgrammaticReloadPending } from '@/app/programmaticReload';
import {
  archiveSessionNow,
  closeTerminalNow,
  confirmArchiveSession,
  confirmCloseTerminal,
} from '@/app/rowActions';

// NOTE: deliberately NO re-exports of the closeGuard helpers. Importing this
// module drags in Modal + i18n, which cannot be imported in the node test
// environment — appBack.ts (and its test) import `isEditableTarget` straight
// from ./closeGuard for exactly that reason.

/**
 * Hand focus back after a CANCELLED close.
 *
 * Post-unmount and twice on purpose — the lesson from TermPresetsMenu's
 * onCloseAutoFocus: a focus() issued while the dialog is still mounted loses to
 * whatever the dialog does with focus, and the user is left typing into <body>
 * (the terminal LOOKS focused but Enter goes nowhere). A macrotask puts us after
 * React's commit that unmounts the modal; the rAF pass covers a late layout/
 * focus settle. focus() is idempotent, so running twice costs nothing.
 */
function restoreFocusAfterCancel(captured: HTMLElement | null): void {
  const run = () => {
    const fallback = document.querySelector<HTMLElement>('.xterm-helper-textarea');
    pickRefocusTarget<HTMLElement>(captured, fallback, document.body)?.focus?.();
  };
  setTimeout(run, 0);
  requestAnimationFrame(() => run());
}

/** The archive/close round-trip — the row-menu flows from rowActions, wired
 *  for the keyboard: cancel restores focus, success navigates home.
 *
 *  `openRef` dedupes for the WHOLE flow: key-repeat or a second ⌘W while the
 *  dialog is up (or the archive/close is still in flight) must not stack
 *  dialogs or double-fire (the flag is cleared in `finally`, and a
 *  backdrop/Esc dismissal resolves the confirm as "cancel", see
 *  ModalProvider). */
async function archiveOrCloseTarget(
  target: CloseViewTarget,
  navigate: NavigateFunction,
  confirmFirst: boolean,
  openRef: { current: boolean },
): Promise<void> {
  const captured = (document.activeElement as HTMLElement | null) ?? null;
  openRef.current = true;
  try {
    if (target.kind === 'session') {
      const session = storage.getState().sessions[target.sessionId];
      if (!session) return; // stale route / not loaded yet — nothing to archive
      if (confirmFirst) {
        const archived = await confirmArchiveSession(session);
        if (!archived) {
          restoreFocusAfterCancel(captured);
          return;
        }
      } else {
        await archiveSessionNow(session);
      }
      // Same landing spot as the command palette's "archive current chat".
      navigate('/');
    } else {
      // Navigate BEFORE the kill: a still-mounted terminal screen would
      // re-open the id and recreate the killed tmux session (see
      // rowActions.confirmCloseTerminal — same ordering as the sidebar row).
      const leave = () => navigate('/');
      if (confirmFirst) {
        const confirmed = await confirmCloseTerminal(target.machineId, target.terminalId, leave);
        if (!confirmed) restoreFocusAfterCancel(captured);
      } else {
        await closeTerminalNow(target.machineId, target.terminalId, leave);
      }
    }
  } catch (error) {
    // archiveSessionNow rolled back the optimistic flip; surface, don't vanish.
    console.error('[closeView] archive/close failed', error);
    Modal.alert(
      t('common.error'),
      target.kind === 'session'
        ? t('sessionInfo.failedToArchiveSession')
        : t('sessionInfo.failedToKillSession'),
    );
  } finally {
    openRef.current = false;
  }
}

export function useCloseViewShortcuts(): void {
  const navigate = useNavigate();
  const confirmEnabled = useLocalSetting('closeViewConfirm');
  // Mirrored into a ref: the capture handler below is registered ONCE, so it
  // must never close over a stale setting value (same reason it reads
  // window.location instead of a captured route).
  const confirmEnabledRef = useRef(confirmEnabled);
  useEffect(() => {
    confirmEnabledRef.current = confirmEnabled;
  }, [confirmEnabled]);
  const confirmOpenRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImeGuardedEvent(e)) return;
      if (!matchCloseViewChord(e)) return;
      const target = closeViewTarget(window.location.pathname, window.location.search);
      const action = closeViewAction({
        closable: target !== null,
        confirmEnabled: confirmEnabledRef.current,
        confirmOpen: confirmOpenRef.current,
      });
      if (action === 'none') return;
      e.preventDefault(); // effective in the PWA; a normal tab ignores it for ⌘W
      e.stopPropagation();
      if (action === 'swallow') return;
      // 'confirm' = ask first; 'close' = closeViewConfirm off, act immediately.
      void archiveOrCloseTarget(target!, navigate, action === 'confirm', confirmOpenRef);
    };
    // CAPTURE phase — beat xterm's textarea keydown handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [navigate]);
}

/**
 * Layer 2: arm the browser's native leave-site dialog while a session/terminal
 * view is open — the only thing that can interrupt ⌘W closing a real browser
 * TAB (and, as a side effect, an accidental ⌘R / window close).
 *
 * Precision matters more than coverage here, or it degenerates into a nag:
 *  - armed ONLY on a closable view (idle home screen = no listener at all,
 *    which also keeps the page bfcache-eligible when there's nothing to guard);
 *  - re-checked at FIRE time against the programmatic-reload flag, so our own
 *    auto-update / logout reloads are never second-guessed;
 *  - governed by its own local setting, separate from the in-app confirm.
 */
export function useUnloadGuard(): void {
  const enabled = useLocalSetting('closeTabWarning');
  const location = useLocation();
  useEffect(() => {
    const armed = shouldWarnOnUnload({
      enabled,
      pathname: location.pathname,
      search: location.search,
      programmaticReload: false, // registration-time: only route + setting decide
    });
    if (!armed) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (
        !shouldWarnOnUnload({
          enabled: true,
          pathname: window.location.pathname,
          search: window.location.search,
          programmaticReload: isProgrammaticReloadPending(),
        })
      ) {
        return;
      }
      e.preventDefault();
      // Legacy but still required by Chrome/Safari to actually show the dialog.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [enabled, location.pathname, location.search]);
}
