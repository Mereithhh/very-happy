/**
 * termEnterScroll — keep the web terminal on its LAST line when nothing but
 * layout moved.
 *
 * Measured mechanism (real xterm 5.5 DOM renderer in real Chromium, T-009,
 * probe in ~/code/github/skills/tmp/vh-t009-enter-scroll/probe2.mjs):
 *
 *   1. The user is on the last line (`buffer.viewportY === buffer.baseY`,
 *      DOM `.xterm-viewport.scrollTop === scrollHeight - clientHeight`).
 *   2. The pane's container GROWS — soft keyboard closes, iOS/Android browser
 *      chrome collapses, a bottom bar shrinks, DevTools/window resize, a tab
 *      re-laid-out while hidden, or the scroll area SHRINKS underneath the
 *      viewport (`term.reset()` between a large buffer and its replacement).
 *   3. The browser clamps `scrollTop` to the new maximum and fires a `scroll`
 *      event for it. xterm's `Viewport._handleScroll` cannot tell that clamp
 *      from a wheel: it reads the (smaller) scrollTop, computes
 *      `newRow - ydisp < 0`, calls `scrollLines(-k)` and — because the delta is
 *      negative — sets `isUserScrolling = true`.
 *   4. From then on `viewportY = baseY - k` (k = grown pixels ÷ row height:
 *      300px → 20 rows) and, worse, every later write no longer follows the
 *      tail: "the terminal stopped scrolling", "opened in the middle of
 *      history". A later `fit()` does NOT heal it (Buffer.resize preserves the
 *      offset), and a catch-up REPLAY does not either (only `reset()` clears
 *      xterm's flag).
 *
 * Nothing in the entry sequence itself (reset → restore → deep rebuild →
 * reveal → adopt geometry) moves the view off the tail — that was measured
 * too — so the fix is not "scroll harder on entry"; it is to stop the ONE
 * misclassification. The signal is unambiguous at the moment the event
 * fires, BEFORE xterm handles it: a user scrolling away from the tail leaves
 * the viewport BELOW its maximum, a layout clamp leaves it exactly AT the
 * (moved) maximum. A capture-phase listener on an ancestor sees the event
 * first (scroll does not bubble, but capture still runs on ancestors), so the
 * screen can classify, let xterm do its thing, and re-pin one frame later
 * only when xterm really did drift.
 *
 * What this deliberately does NOT do: touch a viewport the user has scrolled
 * up in (`viewportY < baseY` ⇒ every event is theirs — new output must keep
 * NOT pulling them down), or act in the alternate buffer (no scroll range, no
 * events; `scrollToBottom` is a no-op there anyway).
 */

export interface ViewportScrollSample {
    /** `term.buffer.active.viewportY`, read BEFORE xterm handles the event. */
    viewportY: number;
    /** `term.buffer.active.baseY` at the same instant. */
    baseY: number;
    /** DOM `.xterm-viewport` geometry at the same instant. */
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

export type ViewportScrollKind =
    /** The user moved the viewport (or is already reading history). Hands off. */
    | 'user'
    /** The viewport is still at its maximum — the maximum moved, not the user. */
    | 'layout';

/**
 * Fractional `scrollTop` (DPR ≠ 1) can sit a hair under an integer
 * `scrollHeight - clientHeight`. A real user scroll of ≤1px cannot move a row
 * anyway (xterm rounds to rows), so treating it as "at max" is lossless.
 */
export const SCROLL_MAX_TOLERANCE_PX = 1;

export function classifyViewportScroll(s: ViewportScrollSample): ViewportScrollKind {
    const followingTail = s.viewportY >= s.baseY;
    if (!followingTail) return 'user';
    const max = s.scrollHeight - s.clientHeight;
    return s.scrollTop >= max - SCROLL_MAX_TOLERANCE_PX ? 'layout' : 'user';
}

export interface TailFollowGuardOptions {
    /** `viewportY < baseY` right now — evaluated when the scheduled re-pin runs. */
    isBehindTail(): boolean;
    /** `term.scrollToBottom()` — clears xterm's isUserScrolling and re-syncs the DOM. */
    pin(): void;
    /**
     * Defer past xterm's own handling of the same event. In the browser this is
     * `requestAnimationFrame`: a rAF requested during the scroll dispatch still
     * runs in the same frame, after every scroll listener. A microtask would be
     * too early (it runs between listeners), a timeout is acceptable.
     */
    schedule(cb: () => void): void;
}

export interface TailFollowGuard {
    /** Feed one capture-phase `scroll` event on `.xterm-viewport`. */
    onViewportScroll(sample: ViewportScrollSample): void;
    dispose(): void;
    readonly counters: { readonly layoutRepins: number; readonly userScrolls: number };
}

export function createTailFollowGuard(o: TailFollowGuardOptions): TailFollowGuard {
    let disposed = false;
    let scheduled = false;
    const counters = { layoutRepins: 0, userScrolls: 0 };
    return {
        onViewportScroll(sample) {
            if (disposed) return;
            if (classifyViewportScroll(sample) === 'user') {
                counters.userScrolls += 1;
                return;
            }
            if (scheduled) return;
            scheduled = true;
            o.schedule(() => {
                scheduled = false;
                if (disposed) return;
                // xterm's own `_innerRefresh` sync fires the same shape of event
                // and leaves the buffer where it was — nothing to heal then.
                if (!o.isBehindTail()) return;
                counters.layoutRepins += 1;
                o.pin();
            });
        },
        dispose() {
            disposed = true;
        },
        counters,
    };
}

/** The class xterm gives its scroll container; the guard filters events by it. */
export const XTERM_VIEWPORT_CLASS = 'xterm-viewport';

/** True for the element whose `scroll` events the guard should read. */
export function isXtermViewport(target: EventTarget | null): target is HTMLElement {
    return typeof HTMLElement !== 'undefined'
        && target instanceof HTMLElement
        && target.classList.contains(XTERM_VIEWPORT_CLASS);
}
