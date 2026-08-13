/**
 * Open-presets-menu shortcut: ⌘. (macOS) / Ctrl+. (Windows/Linux) toggles the
 * prompt-presets dropdown of the CURRENT view — the chat composer's
 * PresetsMenu on /session/*, the terminal header's TermPresetsMenu on
 * /terminal/*. Registered by the menu component itself (so it only exists
 * while an entry point is rendered), listening on window in the CAPTURE phase
 * — same story as ⌘W in ./viewShortcuts.ts: the xterm helper textarea owns
 * focus whenever a terminal is open and would swallow a bubbling listener.
 *
 * Chord choice notes:
 *   - ⌘./Ctrl+. is not browser-reserved in Chrome (normal tab or PWA), unlike
 *     ⌘W/⌘N which only survive in the PWA window.
 *   - xterm.js has no mapping for Ctrl+Period (no C0 control code exists for
 *     '.'), and meta-chords are never forwarded to the pty — so intercepting
 *     it steals nothing from the shell or a claude TUI. preventDefault +
 *     stopPropagation in capture keeps it from reaching xterm at all.
 *   - The chord must fire INSIDE editable targets (composer textarea, xterm
 *     helper textarea): that's exactly where the user is when they want a
 *     preset. A ⌘/Ctrl chord types nothing, so there is no target exemption.
 *
 * While the menu is open, plain digits 1-9 pick the Nth preset directly
 * (see presetDigitIndex; wired in the menu components' onKeyDown — Radix
 * typeahead is skipped via preventDefault, matching happens on e.key which is
 * layout-correct for digit rows and numpads alike).
 *
 * Touch devices: no hardware keyboard — the hook is inert under a coarse
 * pointer (no listener registered, no numbering shown, tooltips unchanged).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isImeGuardedEvent } from '@/utils/ime';

// Same probe as AgentInput/WebTerminalScreen use for their touch-first gates.
const IS_COARSE_POINTER =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

/** True where the presets shortcut + digit numbering are meaningful (desktop). */
export const PRESETS_SHORTCUT_ACTIVE = !IS_COARSE_POINTER;

/** Tooltip badge for the trigger button (platform-shaped, like ⌘-badges elsewhere). */
export const PRESETS_SHORTCUT_HINT =
    typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '')
        ? '⌘.'
        : 'Ctrl+.';

/** Pure chord matcher (exported for tests). Exactly one of ⌘/Ctrl plus the
 *  physical Period key, no other modifiers. `target` is part of the event
 *  shape on purpose: the chord fires on EVERY target — including ordinary
 *  inputs and the xterm helper textarea — and the tests pin that down. */
export function matchPresetsMenuChord(e: {
    metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
    code: string; target: EventTarget | null;
}): boolean {
    if (e.altKey || e.shiftKey) return false;
    if (e.metaKey === e.ctrlKey) return false; // need exactly one of ⌘/Ctrl
    // e.code, not e.key: '.' arrives as e.g. '。' under CJK layouts; the
    // physical key is the stable identity (same reasoning as ⌥W/⌥N matchers).
    return e.code === 'Period';
}

/** Digit-key → preset index for direct selection while the menu is open.
 *  '1'..'9' → 0..8 when that preset exists; anything else (including '0',
 *  multi-char keys like 'Digit1'-less 'ArrowDown', or an out-of-range digit)
 *  → null. Presets beyond the 9th are reachable by arrows + Enter only. */
export function presetDigitIndex(key: string, presetCount: number): number | null {
    if (!/^[1-9]$/.test(key)) return null;
    const idx = Number(key) - 1;
    return idx < presetCount ? idx : null;
}

/**
 * Controlled-open state for a presets dropdown plus the global ⌘./Ctrl+.
 * toggle. `enabled` mirrors "is this menu openable at all": the chat
 * composer passes `presets.length > 0` (its trigger hides when empty), the
 * terminal header passes true unconditionally (its menu shows a manage item
 * when empty — it absorbed the old quick-commands menu, B-052). Inert on
 * coarse-pointer devices.
 *
 * `onChordClose` fires when the chord closes an already-open menu — a
 * keyboard cancel. Callers use it (together with Radix's onEscapeKeyDown) to
 * hand focus back to the composer/terminal instead of leaving it in limbo.
 */
export function usePresetsMenuShortcut(
    enabled: boolean,
    onChordClose?: () => void,
): [boolean, (open: boolean) => void] {
    const [open, _setOpen] = useState(false);
    // Mirror of `open` readable inside the listener without re-registering it.
    const openRef = useRef(false);
    const setOpen = useCallback((o: boolean) => {
        openRef.current = o;
        _setOpen(o);
    }, []);
    const onChordCloseRef = useRef(onChordClose);
    onChordCloseRef.current = onChordClose;
    useEffect(() => {
        if (!enabled || !PRESETS_SHORTCUT_ACTIVE) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (isImeGuardedEvent(e)) return;
            if (!matchPresetsMenuChord(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (openRef.current) {
                onChordCloseRef.current?.(); // BEFORE the close — see onCloseAutoFocus consumers
                setOpen(false);
            } else {
                setOpen(true);
            }
        };
        // CAPTURE phase — beat xterm's textarea keydown handler.
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [enabled, setOpen]);
    return [open, setOpen];
}
