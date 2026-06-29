import * as React from 'react';
import { Platform } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { storage } from '@/sync/storage';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { getQuickSwitchTarget } from '@/hooks/quickSwitchStore';
import { Modal } from '@/modal';
import { sessionUpdateTitle } from '@/sync/ops';
import { ShortcutsHelpModal } from '@/components/ShortcutsHelpModal';
import { t } from '@/text';

/**
 * Web-only global keyboard shortcuts for session navigation:
 *  - ⌘1..⌘9  jump to the Nth active session (same order as the hover badges)
 *  - ⌘R       rename the currently-open session (only on a /session/:id route
 *             and only when focus isn't in a text field — otherwise the browser
 *             reload is allowed through)
 *  - ?  /  ⌘/ open the shortcuts help overlay
 *
 * ⌘K (command palette) is intentionally NOT handled here — it lives in
 * useGlobalKeyboard and we don't touch it.
 *
 * Guards are deliberately narrow: we only call preventDefault for the exact
 * key+context combination we handle, so we never swallow the user's reload or
 * other system shortcuts.
 */

// Parse the current session id from an expo-router pathname like
// `/session/<id>` or `/session/<id>/info`. Returns null off the session route.
function currentSessionIdFromPathname(pathname: string): string | null {
    if (!pathname.startsWith('/session/')) return null;
    const id = pathname.split('/')[2];
    if (!id) return null;
    return decodeURIComponent(id);
}

// True when the keyboard event originated from (or focus rests in) an editable
// field, so we should leave the keystroke alone.
function isEditableTarget(e: KeyboardEvent): boolean {
    const target = (e.target as HTMLElement | null) ?? (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Reuse the same rename flow as the session quick-actions menu: prompt with the
// current title, then write it via sessionUpdateTitle. Reads the session from
// the store on demand so it never goes stale.
async function renameCurrentSession(sessionId: string) {
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    const current = session.metadata?.summary?.text ?? '';
    const next = await Modal.prompt(
        t('session.renameTitle'),
        undefined,
        {
            defaultValue: current,
            placeholder: t('session.renamePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('common.save'),
        },
    );
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === current.trim()) return;
    try {
        await sessionUpdateTitle(sessionId, trimmed);
    } catch (error) {
        Modal.alert(t('common.error'), String(error instanceof Error ? error.message : error));
    }
}

function openHelp() {
    Modal.show({ component: ShortcutsHelpModal });
}

export function useGlobalSessionShortcuts() {
    const router = useRouter();
    const pathname = usePathname();

    // Keep the latest pathname in a ref so the window listener can stay mounted
    // once (no re-subscribe churn) while always reading the fresh value. The
    // quick-switch map is read synchronously from the module store.
    const pathnameRef = React.useRef(pathname);
    pathnameRef.current = pathname;

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') {
            return;
        }

        const onKeyDown = (e: KeyboardEvent) => {
            const modifier = e.metaKey || e.ctrlKey;

            // ⌘1..⌘9 — quick switch into the Nth active row (session or
            // terminal), matching the hover badge order. Ignore numpad/shifted
            // variants by checking the digit directly; only act when a row is
            // mapped to it, and navigate by the target's kind.
            if (modifier && !e.altKey && e.key >= '1' && e.key <= '9') {
                const n = Number(e.key);
                const target = getQuickSwitchTarget(n);
                if (target) {
                    e.preventDefault();
                    if (target.kind === 'session') {
                        navigateToSession(router, target.sessionId);
                    } else {
                        router.push(`/terminal/web/${target.machineId}?tid=${target.tid}` as any);
                    }
                }
                return;
            }

            // ⌘R — rename current session. Only intercept the browser reload when
            // we're on a session route AND focus isn't in an editable field;
            // otherwise let the reload happen normally.
            if (modifier && !e.altKey && (e.key === 'r' || e.key === 'R')) {
                if (isEditableTarget(e)) return;
                const sessionId = currentSessionIdFromPathname(pathnameRef.current);
                if (!sessionId) return;
                e.preventDefault();
                void renameCurrentSession(sessionId);
                return;
            }

            // ⌘/ — help overlay.
            if (modifier && e.key === '/') {
                e.preventDefault();
                openHelp();
                return;
            }

            // ? — help overlay (no modifier; skip when typing). `?` is Shift+/
            // on most layouts, so don't require/forbid shift explicitly — just
            // match the produced character.
            if (!modifier && e.key === '?') {
                if (isEditableTarget(e)) return;
                e.preventDefault();
                openHelp();
                return;
            }
        };

        // Capture phase so ⌘1-9 / ⌘R / ? fire before any bubble-phase listener
        // swallows the event (same reason as useCommandKeyHeld). The in-handler
        // guards (editable target, pathname, mapping presence) still apply.
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [router]);
}

export function GlobalSessionShortcuts() {
    useGlobalSessionShortcuts();
    return null;
}
