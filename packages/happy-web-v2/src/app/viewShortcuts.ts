/**
 * Close-current-view shortcut: ⌘W (PWA) / ⌥W (normal-tab fallback), plus the
 * tab-close guard — TWO layers protecting against "the view is gone and I
 * didn't mean to", because they cover different scenarios:
 *
 *  layer 1 (useCloseViewShortcuts) — in-app confirm. We see the chord, ask via
 *    Modal.confirm, and only navigate home on confirm. Reachable wherever the
 *    page actually receives the chord: ⌘W in the installed PWA, ⌥W anywhere.
 *  layer 2 (useUnloadGuard) — the browser's own leave-site dialog. In a normal
 *    Chrome tab ⌘W is browser-reserved: preventDefault is ignored and the TAB
 *    closes before the page sees anything, so layer 1 never runs. `beforeunload`
 *    is the ONLY hook that exists there — its wording and styling belong to the
 *    browser, we can only ask for it.
 *
 * Semantics of "close" (both layers): navigate back home. The session/terminal
 * keeps running; nothing is killed, archived or deleted. It's the
 * editor-tab-close gesture — the confirm copy says so explicitly.
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
import { useLocalSetting } from '@/sync/storage';
import {
  closeViewAction,
  isClosableViewPath,
  matchCloseViewChord,
  pickRefocusTarget,
  shouldWarnOnUnload,
} from '@/app/closeGuard';
import { isProgrammaticReloadPending } from '@/app/programmaticReload';

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

/** The confirm round-trip. `openRef` dedupes: key-repeat or a second ⌘W while
 *  the dialog is up must not stack dialogs (and must not jam the shortcut
 *  either — the flag is cleared in `finally`, and a backdrop/Esc dismissal
 *  resolves the promise as "cancel", see ModalProvider). */
async function confirmThenClose(
  navigate: NavigateFunction,
  openRef: { current: boolean },
): Promise<void> {
  const captured = (document.activeElement as HTMLElement | null) ?? null;
  openRef.current = true;
  let ok = false;
  try {
    ok = await Modal.confirm(t('closeView.confirmTitle'), t('closeView.confirmMessage'), {
      cancelText: t('common.cancel'),
      confirmText: t('closeView.confirmAction'),
    });
  } finally {
    openRef.current = false;
  }
  if (ok) {
    navigate('/');
    return;
  }
  restoreFocusAfterCancel(captured);
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
      const action = closeViewAction({
        closable: isClosableViewPath(window.location.pathname, window.location.search),
        confirmEnabled: confirmEnabledRef.current,
        confirmOpen: confirmOpenRef.current,
      });
      if (action === 'none') return;
      e.preventDefault(); // effective in the PWA; a normal tab ignores it for ⌘W
      e.stopPropagation();
      if (action === 'swallow') return;
      if (action === 'close') {
        navigate('/');
        return;
      }
      void confirmThenClose(navigate, confirmOpenRef);
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
