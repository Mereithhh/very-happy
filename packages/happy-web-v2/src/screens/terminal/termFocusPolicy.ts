/**
 * termFocusPolicy — pure state machine deciding WHO gets focus (and therefore
 * whether the mobile soft keyboard is up) on the web-terminal screen.
 *
 * Why this exists (the "keyboard won't go away" bug): the terminal keeps input
 * alive by focusing xterm's hidden helper textarea, and every affordance on the
 * screen used to *unconditionally* re-focus it — tap-to-focus, the assistive
 * key bar, snippet insertion. Once the keyboard was up there was no legitimate
 * way to put it down: any ≤12px touch re-opened it, and the key bar's
 * keep-focus (onMouseDown preventDefault) meant even its keys kept it up. On
 * iOS this is compounded by the standalone-PWA viewport-shrink bug (see the
 * onViewport/focusout dual restore channel in WebTerminalScreen): the layout
 * never recovered either.
 *
 * The machine's core invariant: after the user EXPLICITLY dismisses the
 * keyboard (`dismiss-key`, or an unhandled focus loss = `focus-settled:none`),
 * NOTHING auto-refocuses the terminal until the next explicit tap on the
 * terminal body. Key-bar keys still send their bytes — they just stop dragging
 * the keyboard back up.
 *
 * Desktop is unaffected: the machine is only consulted from coarse-pointer
 * code paths (and from runCommand, where the desktop state is the initial
 * state and reduces to the historical focus-terminal behavior).
 *
 * States (orthogonal flags):
 *  - dismissed:  user closed the keyboard; suppress automatic terminal refocus.
 *  - barMode:    line-input mode — a real <textarea> below the key bar owns
 *                typing; the terminal body must never steal its focus.
 *  - selectMode: freeze-output select/copy mode; no focus changes at all.
 *
 * Events → actions are pure data; WebTerminalScreen executes the actions
 * (focus/blur/restore-layout) against the DOM.
 */

export interface TermFocusState {
    /** User explicitly put the keyboard away; no auto-refocus until a tap. */
    dismissed: boolean;
    /** Line-input mode: the input bar owns typing; terminal is read-only. */
    barMode: boolean;
    /** Select/copy mode: output frozen, focus left alone entirely. */
    selectMode: boolean;
}

export type TermFocusEvent =
    /** A tap (≤ threshold movement) on the terminal body. */
    | { type: 'tap' }
    /** The key bar's hide-keyboard key. */
    | { type: 'dismiss-key' }
    /** Any pty key on the key bar (Esc/Tab/arrows/Ctrl-fold/…). */
    | { type: 'bar-key' }
    /** A snippet command was pasted (explicit menu gesture). */
    | { type: 'snippet' }
    /**
     * Focus settled somewhere after a focusout (probed one tick later).
     * 'terminal'  = helper textarea regained focus (no-op);
     * 'input-bar' = the line-input textarea has it (keyboard stays, no-op);
     * 'none'      = keyboard is gone — treat as a dismissal + restore layout.
     */
    | { type: 'focus-settled'; target: 'terminal' | 'input-bar' | 'none' }
    /** Key bar toggle between per-key mode and line-input mode. */
    | { type: 'toggle-bar-mode' }
    /** Select/copy mode toggled. */
    | { type: 'select-mode'; on: boolean };

export type TermFocusAction =
    /** Focus xterm (must run inside the user-gesture stack to open the keyboard). */
    | 'focus-terminal'
    /** Focus the line-input textarea. */
    | 'focus-input-bar'
    /** Blur the line-input textarea only. */
    | 'blur-input-bar'
    /** Blur anything focused on the terminal screen (helper textarea + input bar). */
    | 'blur-all'
    /** Keyboard is gone: clear maxHeight, refit, scroll the page back to top. */
    | 'restore-layout'
    | 'none';

export function reduceTermFocus(
    s: TermFocusState,
    e: TermFocusEvent,
): { state: TermFocusState; action: TermFocusAction } {
    switch (e.type) {
        case 'tap':
            // Select mode: the gesture belongs to the OS text selection.
            if (s.selectMode) return { state: s, action: 'none' };
            // Bar mode: the terminal body is read-only — a tap means "let me
            // see the output", i.e. put the keyboard away (normal web
            // semantics: tapping a non-editable area blurs).
            if (s.barMode) return { state: s, action: 'blur-input-bar' };
            // Per-key mode: a tap is the one explicit way to summon the
            // keyboard — it also clears a prior dismissal.
            return { state: { ...s, dismissed: false }, action: 'focus-terminal' };

        case 'dismiss-key':
            return { state: { ...s, dismissed: true }, action: 'blur-all' };

        case 'bar-key':
            // The key's bytes go to the pty regardless; the only question is
            // whether pressing it drags the keyboard back up. It must NOT
            // after an explicit dismissal (arrow keys with the screen fully
            // visible is a first-class TUI flow), and it must never steal the
            // input bar's focus in bar mode (the bar's buttons keep focus via
            // preventDefault — no action needed to preserve it).
            if (s.barMode || s.dismissed || s.selectMode) return { state: s, action: 'none' };
            return { state: s, action: 'focus-terminal' };

        case 'snippet':
            // Explicit menu gesture. In bar mode the paste goes to the pty
            // while the user keeps editing in the bar — don't move focus.
            if (s.barMode || s.selectMode) return { state: s, action: 'none' };
            return { state: { ...s, dismissed: false }, action: 'focus-terminal' };

        case 'focus-settled':
            if (e.target === 'none') {
                // The keyboard is genuinely gone (user tapped Done, the OS
                // closed it, or our own dismiss). Record the dismissal so
                // nothing re-opens it, and restore the layout — this is the
                // SECOND restore channel; the visualViewport one never fires
                // under the iOS standalone-PWA shrink bug.
                return { state: { ...s, dismissed: true }, action: 'restore-layout' };
            }
            return { state: s, action: 'none' };

        case 'toggle-bar-mode': {
            const barMode = !s.barMode;
            // Entering: hand focus to the input bar (gesture stack → keyboard
            // opens on it). Leaving: back to per-key — focus the terminal.
            // Both are explicit gestures, so they clear a dismissal.
            return {
                state: { ...s, barMode, dismissed: false },
                action: barMode ? 'focus-input-bar' : 'focus-terminal',
            };
        }

        case 'select-mode':
            if (e.on) {
                // Entering select mode intentionally drops the keyboard so the
                // OS long-press selection isn't fighting the caret.
                return { state: { ...s, selectMode: true, dismissed: true }, action: 'blur-all' };
            }
            // Leaving (explicit gesture): resume the mode that owns typing.
            return {
                state: { ...s, selectMode: false, dismissed: false },
                action: s.barMode ? 'focus-input-bar' : 'focus-terminal',
            };
    }
}

export const initialTermFocusState: TermFocusState = Object.freeze({
    dismissed: false,
    barMode: false,
    selectMode: false,
});
