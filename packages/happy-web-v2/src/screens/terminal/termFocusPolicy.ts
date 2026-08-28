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
 * NOTHING auto-refocuses the terminal until the next explicit terminal-body
 * tap or keyboard-toggle request. Key-bar keys and snippet actions still do
 * their work — they never count as consent to raise the keyboard.
 *
 * Desktop is unaffected: the machine is only consulted from coarse-pointer
 * code paths; desktop runCommand keeps its separate historical refocus.
 *
 * States (orthogonal flags):
 *  - dismissed:  user closed the keyboard; suppress automatic terminal refocus.
 *  - barMode:    line-input mode — a real <textarea> below the key bar owns
 *                typing; the terminal body must never steal its focus.
 *  - webKeyboard: our focusless Web keyboard owns typing; native input must
 *                 stay blurred until the user explicitly switches back.
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
    /** Pure Web keyboard mode: key buttons emit bytes; native inputs stay down. */
    webKeyboard: boolean;
    /** Select/copy mode: output frozen, focus left alone entirely. */
    selectMode: boolean;
}

export type TermFocusEvent =
    /** A tap (≤ threshold movement) on the terminal body. */
    | { type: 'tap' }
    /** Explicit keyboard control requested that every input surface blur. */
    | { type: 'dismiss-key' }
    /** Explicit keyboard toggle requested that the active input surface show. */
    | { type: 'show-keyboard' }
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
    /** Show/hide the focusless, fully controlled Web keyboard. */
    | { type: 'web-keyboard'; on: boolean }
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

/**
 * Whether the coarse-pointer terminal must consume a completed touch tap.
 *
 * Chrome follows a touch tap with compatibility mouse events. On the `own`
 * input path those events make xterm focus its hidden textarea *after* we have
 * synchronously focused our textarea, producing an own -> xterm -> own focus
 * bounce. Mobile Chrome closes the soft keyboard during that bounce, so the
 * first tap flashes the keyboard and a second tap is required. Claiming only a
 * genuine tap suppresses that redundant mouse sequence; drags, selection mode,
 * and the legacy xterm-owned input path retain their native behavior.
 */
export const TERMINAL_TOUCH_END_OPTIONS: AddEventListenerOptions = Object.freeze({
    capture: true,
    passive: false,
});

export function completeTerminalTouchTap(input: {
    inputOwnership: 'xterm' | 'own';
    barMode: boolean;
    webKeyboard: boolean;
    selectMode: boolean;
    distanceSquared: number;
    threshold: number;
    cancelable: boolean;
    scrolled: boolean;
}, effects: {
    preventDefault(): void;
    stopPropagation(): void;
    dispatchTap(): void;
}): boolean {
    if (input.selectMode || input.scrolled || input.distanceSquared > input.threshold * input.threshold) return false;
    // The line-input bar also needs to claim the touch. Its tap action blurs
    // the bar; allowing Chrome's compatibility mousedown through would then
    // focus xterm's hidden textarea and reopen the keyboard immediately.
    if (input.inputOwnership === 'own' || input.barMode || input.webKeyboard) {
        if (input.cancelable) effects.preventDefault();
        effects.stopPropagation();
    }
    // Deliberately synchronous: mobile browsers only open the soft keyboard
    // when focus happens inside the original user-gesture call stack.
    effects.dispatchTap();
    return true;
}

export function reduceTermFocus(
    s: TermFocusState,
    e: TermFocusEvent,
): { state: TermFocusState; action: TermFocusAction } {
    switch (e.type) {
        case 'tap':
            // Select mode: the gesture belongs to the OS text selection.
            if (s.selectMode) return { state: s, action: 'none' };
            // The Web keyboard sends bytes from its own buttons. A terminal
            // tap must not focus the hidden textarea and raise the OS keyboard
            // behind it.
            if (s.webKeyboard) return { state: s, action: 'none' };
            // Bar mode: the terminal body is read-only — a tap means "let me
            // see the output", i.e. put the keyboard away (normal web
            // semantics: tapping a non-editable area blurs).
            if (s.barMode) return { state: s, action: 'blur-input-bar' };
            // Per-key mode: a tap is the one explicit way to summon the
            // keyboard — it also clears a prior dismissal.
            return { state: { ...s, dismissed: false }, action: 'focus-terminal' };

        case 'dismiss-key':
            return { state: { ...s, dismissed: true, webKeyboard: false }, action: 'blur-all' };

        case 'show-keyboard':
            if (s.selectMode) return { state: s, action: 'none' };
            return {
                state: { ...s, dismissed: false, webKeyboard: false },
                action: s.barMode ? 'focus-input-bar' : 'focus-terminal',
            };

        case 'bar-key':
            // Bytes are sent independently of focus. The key-bar buttons use
            // preventDefault to preserve an already-open keyboard, so focusing
            // here adds no value and makes Esc/arrows unexpectedly summon a
            // closed keyboard. Termux uses the same separation: extra keys and
            // the explicit KEYBOARD control are distinct actions.
            return { state: s, action: 'none' };

        case 'snippet':
            // A menu/preset action may write bytes, but it is not consent to
            // raise the keyboard. The explicit keyboard control or a terminal
            // body tap is the only way back into mobile text entry.
            return { state: s, action: 'none' };

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
                state: { ...s, barMode, dismissed: false, webKeyboard: false },
                action: barMode ? 'focus-input-bar' : 'focus-terminal',
            };
        }

        case 'web-keyboard':
            if (s.selectMode) return { state: s, action: 'none' };
            if (e.on) {
                // Direct-byte mode and the whole-line input bar cannot both be
                // active: visually leaving the line bar mounted would imply
                // that Web-key presses edit it, when they intentionally go to
                // the PTY. Activating Web mode therefore returns to per-key.
                return {
                    state: { ...s, barMode: false, webKeyboard: true, dismissed: true },
                    action: 'blur-all',
                };
            }
            // Closing the Web keyboard maximizes the terminal without raising
            // the OS keyboard. The explicit system-key button owns that switch.
            return {
                state: { ...s, webKeyboard: false, dismissed: true },
                action: 'blur-all',
            };

        case 'select-mode':
            if (e.on) {
                // Entering select mode intentionally drops the keyboard so the
                // OS long-press selection isn't fighting the caret.
                return {
                    state: { ...s, selectMode: true, webKeyboard: false, dismissed: true },
                    action: 'blur-all',
                };
            }
            // Leaving selection is a view-mode action, not a request to type.
            // Keep the keyboard down until the explicit toggle/tap.
            return { state: { ...s, selectMode: false, dismissed: true }, action: 'none' };
    }
}

export const initialTermFocusState: TermFocusState = Object.freeze({
    dismissed: false,
    barMode: false,
    webKeyboard: false,
    selectMode: false,
});
