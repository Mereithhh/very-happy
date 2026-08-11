/**
 * Mobile (soft-keyboard) input bridge for xterm.js — v2, diff-engine design.
 *
 * ── Why the v1 bridge (capture `input` on the textarea + clear it) was wrong ──
 * Verified against xterm 5.5 src (browser/Terminal.ts + CompositionHelper.ts):
 *
 *  1. DOUBLE-SEND: every soft-keyboard key arrives as keydown keyCode 229. When
 *     no composition is active, xterm's `_keyDown` → `CompositionHelper.keydown`
 *     → `_handleAnyTextareaChanges()` snapshots the textarea and, in a 0ms
 *     timer, diff-sends the change itself (shorter → it sends a DEL). The v1
 *     bridge ALSO sent `\x7f` for `deleteContentBackward` and then CLEARED the
 *     textarea — making xterm's timer see "5 chars → 0 chars" and send its own
 *     DEL: two deletes per backspace press. `stopImmediatePropagation` on the
 *     `input` event can't stop a timer armed by `keydown`.
 *  2. KEYBOARD DESYNC (the "one letter can't be deleted" bug): the OS keyboard
 *     mirrors the FIELD (the hidden textarea) — it is the keyboard's model of
 *     what exists before the caret. v1 cleared the textarea after every send,
 *     so after an IME/predictive commit ("hello" committed via composition →
 *     textarea "hello", pty "hello"), the FIRST backspace sent one `\x7f` and
 *     wiped the whole textarea. The keyboard then believed the field was empty
 *     and stopped emitting delete events (empty-field backspace on iOS/Gboard
 *     often produces NO key or input event at all) — while the pty still held
 *     letters. Those letters are undeletable until refocus: the reported bug.
 *  3. LOST COMMITS: xterm's composition commit (`_finalizeComposition`) reads
 *     the textarea in a 0ms timer AFTER compositionend. v1 cleared the textarea
 *     in the `insertText`/`insertLineBreak` handler for the space/enter that
 *     follows a predictive commit — racing that timer; if the clear ran first,
 *     the whole committed word was silently dropped.
 *  4. EATEN BACKSPACES (Gboard recomposition): backspacing into an already-
 *     committed word makes Gboard RE-COMPOSE it (compositionstart on existing
 *     text). xterm's `_compositionPosition.start` is set to the textarea LENGTH
 *     at compositionstart, so for a recomposition (which reuses existing chars
 *     instead of appending) the final substring is empty — every backspace
 *     inside that recomposition reached nobody, and the pty kept the word.
 *
 * ── v2 design: one idempotent diff engine, textarea = shared model ──────────
 * The hidden textarea is the ONLY model both sides agree on: the OS keyboard
 * reads and edits it natively; we mirror every observed change to the pty as
 * `\x7f` × removed + inserted text. We never clear it behind the keyboard's
 * back, so the keyboard's view can never diverge from what the pty received.
 *
 *  - All listeners are registered in the CAPTURE phase on `term.element` (an
 *    ANCESTOR of the textarea). DOM dispatch runs ancestor-capture listeners
 *    before ANY listener on the target, regardless of registration order — the
 *    only reliable way to preempt xterm's own textarea listeners (which are
 *    registered directly on the textarea, before ours).
 *  - keydown 229 is stopped before xterm sees it → `_handleAnyTextareaChanges`
 *    can never arm → kills double-sends at the root. Real keys (hardware
 *    Backspace/Enter/arrows) still flow to xterm's keydown machinery untouched.
 *  - every `input` event is stopped before xterm's `_inputEvent`; outside
 *    composition we run `sync()` — diff textarea against our shadow and send.
 *  - composition: compositionstart/update still flow to xterm so its
 *    .composition-view bubble keeps working (imeFix styles it), but
 *    compositionEND is intercepted: we hide the bubble, reset the helper's
 *    private flags, and commit via the SAME diff engine (0ms deferred, like
 *    xterm does, because the textarea settles after compositionend). This
 *    fixes (3) and (4): a recomposition ends as a plain "hello"→"hell" diff.
 *  - `sync()` is idempotent (diff against a shadow that is updated on every
 *    run), so overlapping triggers (input event + compositionend timer) can
 *    never double-send.
 *  - after any keydown xterm DID handle (Enter/^C clear the textarea inside
 *    xterm, line 1066), we resync the shadow WITHOUT sending on a 0ms timer.
 *
 * Desktop is untouched — install only under a coarse pointer.
 */
import type { Terminal } from '@xterm/xterm';

/**
 * END-RELATIVE edit diff between two textarea values, expressed as what a
 * terminal cursor at end-of-line can actually perform: delete everything after
 * the common PREFIX (as a CODE POINT count — one `\x7f` erases one code point
 * on the pty side), then retype the rest. Deliberately NO common-suffix
 * preservation: "helo "→"hello " must become "delete 2, type 'lo '", not an
 * impossible mid-string insert. End-of-line edits (the 99% mobile case:
 * typing, backspace, autocorrect replacing the last word) are minimal.
 */
export function diffTextValue(prev: string, next: string): { deletes: number; insert: string } {
    if (prev === next) return { deletes: 0, insert: '' };
    const minLen = Math.min(prev.length, next.length);
    let p = 0;
    while (p < minLen && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    // Don't split a surrogate pair at the prefix boundary.
    if (p > 0 && p < prev.length && p < next.length) {
        const c = prev.charCodeAt(p - 1);
        if (c >= 0xd800 && c <= 0xdbff) p--;
    }
    const removed = prev.slice(p);
    const insert = next.slice(p);
    return { deletes: [...removed].length, insert };
}

/** Normalize textarea-borne text for the pty: newlines become CR. */
export function toPtyText(insert: string): string {
    return insert.replace(/\r?\n/g, '\r');
}

export interface MobileBridgeHandle {
    dispose(): void;
}

export function installMobileInputBridge(
    term: Terminal,
    sendInput: (data: string) => void,
): MobileBridgeHandle | null {
    const el = term.element;
    const ta = el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!el || !ta) return null;

    // Hint the OS toward a plain text keyboard; 'send' labels Return sensibly.
    ta.setAttribute('inputmode', 'text');
    ta.setAttribute('enterkeyhint', 'send');

    // Shadow of the textarea contents we have already mirrored to the pty.
    let lastValue = ta.value;
    let composing = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
    };

    /** Mirror any unseen textarea change to the pty (idempotent). */
    const sync = () => {
        const cur = ta.value;
        if (cur === lastValue) return;
        const { deletes, insert } = diffTextValue(lastValue, cur);
        const out = '\x7f'.repeat(deletes) + toPtyText(insert);
        lastValue = cur;
        if (out) sendInput(out);
        // Bound growth at a natural boundary: right after a newline commit the
        // keyboard starts a fresh context anyway, so clearing can't desync it.
        if (!composing && cur.length > 400 && /[\n\s]$/.test(cur)) {
            ta.value = '';
            lastValue = '';
        }
    };

    /** Adopt the current textarea value without sending (external mutation —
     *  e.g. xterm clears it when handling a real Enter/^C keydown). */
    const adopt = () => { lastValue = ta.value; };

    const core = (term as unknown as { _core?: any })._core;
    const helper = core?._compositionHelper;

    const onKeyDown = (ev: Event) => {
        if (ev.target !== ta) return;
        const e = ev as KeyboardEvent;
        if (e.keyCode === 229 || composing) {
            // Soft-keyboard sentinel (or any key while composing): the change
            // arrives via input/composition events which WE handle. Blocking it
            // here prevents xterm's CompositionHelper.keydown from arming its
            // duplicate `_handleAnyTextareaChanges` sender / mis-finalizing an
            // in-flight composition. No preventDefault — the browser/IME still
            // performs the edit; we only hide it from xterm.
            ev.stopImmediatePropagation();
            return;
        }
        // A real key xterm will process (it preventDefaults, so the textarea
        // normally doesn't change — EXCEPT Enter/^C, which xterm itself clears
        // the textarea for). Resync the shadow after its handler ran.
        later(adopt, 0);
    };

    const onInput = (ev: Event) => {
        if (ev.target !== ta) return;
        // Always hide textarea-borne input from xterm's `_inputEvent` — with
        // keydown 229 blocked, `_keyDownSeen` stays false and xterm would
        // otherwise send `insertText` itself (double-send).
        ev.stopImmediatePropagation();
        const e = ev as InputEvent;
        if (composing || e.isComposing) return; // committed via compositionend path
        sync();
    };

    const onCompositionStart = (ev: Event) => {
        if (ev.target !== ta) return;
        // Let it flow to xterm: CompositionHelper shows + positions the
        // .composition-view bubble (the only visible composition UI).
        // Adopt any not-yet-seen value first so the commit diff is exact.
        sync();
        composing = true;
    };

    const onCompositionEnd = (ev: Event) => {
        if (ev.target !== ta) return;
        // Take over the COMMIT: block xterm's _finalizeComposition (its
        // substring bookkeeping double-sends against our diff and sends nothing
        // at all for recompositions). We do its two UI duties ourselves…
        ev.stopImmediatePropagation();
        composing = false;
        try {
            const view = el.querySelector('.composition-view');
            if (view) { view.classList.remove('active'); view.textContent = ''; }
            if (helper) { helper._isComposing = false; helper._isSendingComposition = false; }
        } catch { /* private API best-effort */ }
        // …and commit via the diff engine. Deferred 0ms because composition
        // events fire before the textarea value settles (same reason xterm
        // defers); a trailing non-composed `input` event may run sync() first —
        // harmless, sync is idempotent.
        later(sync, 0);
        later(sync, 40); // safety: some IMEs settle the value a beat later
    };

    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('input', onInput, true);
    el.addEventListener('compositionstart', onCompositionStart, true);
    el.addEventListener('compositionend', onCompositionEnd, true);

    return {
        dispose() {
            el.removeEventListener('keydown', onKeyDown, true);
            el.removeEventListener('input', onInput, true);
            el.removeEventListener('compositionstart', onCompositionStart, true);
            el.removeEventListener('compositionend', onCompositionEnd, true);
            for (const t of timers) clearTimeout(t);
            timers.clear();
        },
    };
}
