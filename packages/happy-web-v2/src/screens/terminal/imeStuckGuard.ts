/**
 * Desktop IME stuck-composition guard for xterm.js — round 2.
 *
 * ── The failure this guards (round 1, reproduced) ────────────────────────
 * Switching the macOS input source MID-COMPOSITION can abort the composition
 * WITHOUT delivering a compositionend event. xterm 5.5's CompositionHelper is
 * then stuck with `_isComposing = true` (verified against the 5.5 source):
 *
 *  - keyCode 229 — every key routed through a CJK IME — returns false from
 *    keydown(): silently swallowed.
 *  - any other keyCode → `_finalizeComposition(false)`: the aborted preedit in
 *    the hidden textarea is committed to the pty — the stray letter that
 *    appears in front of (e.g.) the claude input box.
 *  - the `.composition-view` bubble stays `.active` at the cursor — a DOM
 *    overlay no backspace can remove.
 *
 * blur/refocus does NOT heal it: the browser-side composition is already
 * gone, so blur fires no compositionend and the flag stays up.
 *
 * ── Round-2 hardening (2026-08-12, after the fix failed in the field) ────
 * A real-order replay (CDP Input domain: rawKeyDown 229 → imeSetComposition →
 * insertText, the same pipeline the macOS browser process feeds the renderer)
 * established three facts this file's shape now follows:
 *
 *  1. The round-1 detection never misfires on a real composition: the OPENING
 *     keydown of a composition is keyCode 229 with `isComposing === false`
 *     (isComposing is true only for keydowns dispatched between
 *     compositionstart and compositionend — UI Events §keyboard-events; MDN
 *     keydown_event documents the opening-keydown exception explicitly), but
 *     the helper flag is still false at that instant, so the
 *     helper-vs-event contradiction cannot fire. Replay-verified: zero guard
 *     activations across full 你/好 compositions.
 *  2. Programmatically writing the textarea value while a composition is
 *     active makes Chromium cancel the composition EVENTLESSLY — i.e. it
 *     manufactures exactly the stuck state this guard exists to heal
 *     (replay scenario E). Therefore the guard must NEVER write the textarea
 *     while an IME could be attached to it: heal() only resets helper flags
 *     and hides the bubble; residue clearing happens on BLUR, when no IME
 *     context can exist for the field. (Same iron law mobileInputBridge v2
 *     learned on mobile: never mutate the field behind the input method.)
 *  3. The stuck state largely self-heals through xterm itself once a NEW
 *     composition starts: compositionstart re-syncs the helper and sets
 *     `_compositionPosition.start` to the textarea length, so stale residue
 *     is never part of a commit. What xterm can NOT survive is a non-229
 *     keydown while stuck — `_finalizeComposition(false)` commits the aborted
 *     preedit (the stray letter). That path must be healed on the FIRST
 *     contradictory keydown; everything else can afford a stricter signal.
 *
 * ── Round-3 retirement (2026-08-14): the 229 branch was DEAD CODE ────────
 * CDP measurement of the real failure established that round-2's
 * "sustained contradiction (streak >= 2)" branch can NEVER fire: the
 * compositionstart that follows key 1 resets the streak, and keys 2..n of a
 * real composition report `isComposing: true` (no contradiction at all). So
 * the hardening locked itself out. It is retired here rather than left as a
 * comforting no-op — with it, the streak counter and the "wait for key 2"
 * plumbing are gone too.
 *
 * What survived measurement is the NON-229 branch: in the stuck state, a plain
 * key really does reach the guard with a contradiction, heal() really is called
 * and it really does stop xterm's finalize(false) from committing the aborted
 * preedit (the stray letter). That path is kept exactly as it was.
 *
 * 229/bare-modifier contradictions now heal NEVER: xterm swallows those keys
 * silently (no finalize ⇒ nothing can be corrupted by waiting), and healing
 * them was the only way this guard could ever damage a LIVE composition that
 * mis-reports isComposing. "Never" is the strictly safer end of a branch that
 * demonstrably never ran.
 *
 * ── Detection ─────────────────────────────────────────────────────────────
 * helper-says-composing + event-says-NOT-composing ⇒ eventless abort, healed
 * immediately on non-229 keys (spec guarantees keydowns inside a real
 * composition have isComposing=true, and waiting would let finalize(false)
 * commit the stray letter).
 *
 * Deliberately NOT ime.ts's isImeComposingEvent: Chrome reports every key
 * routed through a CJK IME as key='Process', including the swallowed keys of
 * the stuck state itself, so treating 'Process' as "composing" would make the
 * healer skip exactly the case users hit. Strict `isComposing === false` so
 * browsers that omit the property never trigger a heal.
 *
 * ── Residue hygiene (blur-scoped) ─────────────────────────────────────────
 * On desktop nothing clears the helper textarea except xterm's own Enter/^C
 * handling, so committed compositions accumulate ("n", "n你好", …). Stale
 * content is harmless for commits (fact 3) but unbounded growth is not.
 * Clearing is armed on focusout — the one moment no IME context can be
 * attached — and still waits for the helper to settle (finalize's deferred
 * 0ms textarea read must not be starved) with keydown/focusin cancelling.
 *
 * ── Composition flag for FOCUS decisions only (round 3) ──────────────────
 * This module also tracks "is a composition in flight" for ONE purpose: so
 * nothing moves keyboard focus while the user has uncommitted preedit text
 * (`createCompositionFocusFlag`). That is the other half of the 2026-08-14
 * failure: `refocus()`'s `ta.blur()` under a live composition made xterm emit
 * ZERO onData for the already-typed pinyin — "中文哑英文正常". The flag is
 * maintained from the browser's own composition events (never from xterm's
 * private `_isComposing`), and it MUST NEVER be consulted to decide whether
 * text may be sent to the pty: gating data on a composition flag is exactly
 * the xterm design flaw this whole file exists to work around. Focus only.
 *
 * Mobile must NOT install this: mobileInputBridge owns the textarea as the
 * soft keyboard's shared model. Fine pointers only.
 */
import type { Terminal } from '@xterm/xterm';

/**
 * helper-says-composing + event-says-NOT-composing ⇒ eventless abort.
 * `isComposing` is precise: true for every keydown dispatched inside a REAL
 * composition, false for the composition-opening keydown (where the helper
 * flag is still false — no contradiction) and false in the stuck state.
 */
export function shouldHealStuckComposition(
    helperComposing: boolean,
    ev: { isComposing?: boolean },
): boolean {
    return helperComposing && ev.isComposing === false;
}

/** keyCodes xterm's stuck keydown() swallows WITHOUT finalizing: the
 *  composition key itself and bare modifiers. Nothing can be corrupted by NOT
 *  healing on these (no finalize ⇒ no stray-letter commit), and healing them is
 *  the only way this guard could damage a live-but-mis-reporting composition —
 *  so they are never healed (round-3: the old "heal on a sustained streak"
 *  branch was measured to be unreachable, see the header). Everything else
 *  triggers finalize(false) inside xterm — the stray-letter commit — and must
 *  be healed on the very event that carries the contradiction. */
const SWALLOWED_WHILE_STUCK = new Set([229, 16, 17, 18]);

export interface StuckDetector {
    /** Evaluate one keydown; returns true when the guard should heal NOW. */
    keydown(helperComposing: boolean, ev: { keyCode?: number; isComposing?: boolean }): boolean;
}

/**
 * Contradiction detector (pure, unit-testable). One rule left after round-3's
 * retirement of the dead sustained branch:
 *   contradiction ∧ the key is NOT one xterm swallows ⇒ heal NOW.
 */
export function createStuckDetector(): StuckDetector {
    return {
        keydown(helperComposing, ev) {
            if (!shouldHealStuckComposition(helperComposing, ev)) return false;
            return !SWALLOWED_WHILE_STUCK.has(ev.keyCode ?? 229);
        },
    };
}

/**
 * "A composition is in flight" — **for focus decisions only** (see header).
 * Maintained from the browser's own composition events; deliberately NOT from
 * xterm's private `_isComposing` (that flag is the thing that gets stuck).
 *
 * Staleness matters: the failure mode this whole file guards is a composition
 * that dies WITHOUT compositionend. A sticky `true` would disable the focus
 * watchdog forever, so the flag expires (`staleMs`) and is also cleared by:
 *  - compositionend (the normal path),
 *  - blur/focusout (no IME context can survive it),
 *  - a keydown the BROWSER reports as `isComposing === false` (its own truth
 *    that no composition is in flight — the same evidence heal() acts on).
 * Pure (injected clock) so the expiry is unit-testable in node.
 */
export interface CompositionFocusFlag {
    /** compositionstart */
    start(): void;
    /** compositionupdate — keeps the flag fresh while the user types pinyin */
    update(): void;
    /** compositionend */
    end(): void;
    /** blur / browser-says-not-composing ⇒ definitely nothing in flight */
    clear(): void;
    /** ONLY ever consulted for "may I move focus?" — never for sending text. */
    composing(): boolean;
}

export function createCompositionFocusFlag(opts?: {
    now?: () => number;
    /** how long a composition may go event-less before we stop believing it */
    staleMs?: number;
}): CompositionFocusFlag {
    const now = opts?.now ?? (() => Date.now());
    const staleMs = opts?.staleMs ?? 5000;
    let active = false;
    let lastEventAt = 0;
    return {
        start() { active = true; lastEventAt = now(); },
        update() { if (active) lastEventAt = now(); },
        end() { active = false; },
        clear() { active = false; },
        composing() {
            if (!active) return false;
            if (now() - lastEventAt >= staleMs) {
                // Event-less abort (the round-1/2 failure): stop believing it,
                // or focus could never be restored again.
                active = false;
                return false;
            }
            return true;
        },
    };
}

export interface SettleFlags {
    /** helper._isComposing — a (new) composition is active. */
    composing: boolean;
    /** helper._isSendingComposition — finalize's 0ms textarea read pending. */
    sending: boolean;
}

export interface CompositionSettleClear {
    /** Field left the IME's hands (blur) — schedule a clear once settled. */
    arm(): void;
    /** User activity — do not clear under an active typist. */
    cancelPending(): void;
    dispose(): void;
}

/**
 * Deferred "clear the textarea once the helper fully settled" scheduler.
 * Pure timing logic (injected read/clear) so it is unit-testable.
 */
export function createCompositionSettleClear(opts: {
    read: () => SettleFlags;
    clear: () => void;
    /** first check + retry spacing; must stay comfortably above finalize's 0ms read */
    intervalMs?: number;
    /** bounded retries while finalize is still sending */
    maxTries?: number;
}): CompositionSettleClear {
    const intervalMs = opts.intervalMs ?? 50;
    const maxTries = opts.maxTries ?? 8;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const stop = () => {
        if (timer != null) clearTimeout(timer);
        timer = null;
    };
    const tick = () => {
        timer = null;
        const f = opts.read();
        // A composition is somehow live again — never clear under it.
        if (f.composing) return;
        if (f.sending) {
            // finalize's deferred read hasn't consumed the textarea yet.
            if (++tries < maxTries) timer = setTimeout(tick, intervalMs);
            return;
        }
        opts.clear();
    };
    return {
        arm() {
            stop();
            tries = 0;
            timer = setTimeout(tick, intervalMs);
        },
        cancelPending: stop,
        dispose: stop,
    };
}

export interface ImeStuckGuardHandle {
    /** Observability for tests/harness/diag hook: how often the guard acted. */
    readonly counters: { heals: number; residueClears: number };
    /**
     * Is the user mid-composition? **Focus decisions only** — callers use it to
     * refuse to move focus while uncommitted preedit text exists. Never gate
     * sending text on this (see the header).
     */
    isComposingForFocus(): boolean;
    dispose(): void;
}

export function installImeStuckGuard(term: Terminal): ImeStuckGuardHandle | null {
    const el = term.element;
    const ta = el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!el || !ta) return null;
    // Private API, best-effort — same access pattern as refocus()/mobileInputBridge.
    const core = (term as unknown as { _core?: any })._core;
    const helper = core?._compositionHelper;

    const counters = { heals: 0, residueClears: 0 };
    const detector = createStuckDetector();
    // Focus-only composition flag (see header). Fed by the browser's events,
    // never by helper._isComposing.
    const composingFlag = createCompositionFocusFlag();

    const settle = createCompositionSettleClear({
        read: () => ({
            composing: !!helper?._isComposing,
            sending: !!helper?._isSendingComposition,
        }),
        clear: () => {
            // Only ever reached via blur + settled helper: no IME context can
            // be attached to the field here, so the write cannot abort a
            // composition (writing under one cancels it EVENTLESSLY — replay-
            // verified — which would manufacture the stuck state itself).
            ta.value = '';
            counters.residueClears++;
        },
    });

    // Flags + bubble only. Never write the textarea here: a heal that fired
    // against a live-but-misreporting composition would eventlessly kill it
    // (see header, fact 2). The aborted preedit residue is inert — the next
    // compositionstart sets _compositionPosition.start past it — and gets
    // dropped by xterm's Enter/^C clears or our blur clear.
    const heal = () => {
        try {
            helper._isComposing = false;
            helper._isSendingComposition = false;
            const view = el.querySelector('.composition-view');
            if (view) { view.classList.remove('active'); view.textContent = ''; }
        } catch { /* private API best-effort */ }
        counters.heals++;
    };

    const onKeyDown = (ev: Event) => {
        if (ev.target !== ta) return;
        settle.cancelPending();
        // The browser's own truth: no composition is in flight on this keydown.
        // Clears the focus flag so an event-less abort can't freeze focus
        // restoration (the flag is focus-only — this does not touch xterm).
        if ((ev as KeyboardEvent).isComposing === false) composingFlag.clear();
        if (helper && detector.keydown(!!helper._isComposing, ev as KeyboardEvent)) {
            // Never stop/preventDefault the event: after healing, this same
            // keydown flows into a now-consistent xterm and types normally.
            heal();
        }
    };
    const onCompositionStart = (ev: Event) => {
        if (ev.target !== ta) return;
        composingFlag.start();
    };
    const onCompositionUpdate = (ev: Event) => {
        if (ev.target !== ta) return;
        composingFlag.update();
    };
    const onCompositionEnd = (ev: Event) => {
        if (ev.target !== ta) return;
        composingFlag.end();
    };
    const onFocusOut = (ev: Event) => {
        if (ev.target !== ta) return;
        // Field left the IME's hands: nothing can be in flight any more.
        composingFlag.clear();
        settle.arm();
    };
    const onFocusIn = (ev: Event) => {
        if (ev.target !== ta) return;
        settle.cancelPending();
    };

    // Capture on the ANCESTOR: runs before xterm's own textarea keydown
    // listener regardless of registration order (heal must precede xterm's
    // finalize(false) for the same event).
    el.addEventListener('keydown', onKeyDown, true);
    el.addEventListener('compositionstart', onCompositionStart, true);
    el.addEventListener('compositionupdate', onCompositionUpdate, true);
    el.addEventListener('compositionend', onCompositionEnd, true);
    // focusin/focusout bubble (focus/blur do not) — plain listeners suffice.
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('focusin', onFocusIn);

    return {
        counters,
        isComposingForFocus: () => composingFlag.composing(),
        dispose() {
            el.removeEventListener('keydown', onKeyDown, true);
            el.removeEventListener('compositionstart', onCompositionStart, true);
            el.removeEventListener('compositionupdate', onCompositionUpdate, true);
            el.removeEventListener('compositionend', onCompositionEnd, true);
            el.removeEventListener('focusout', onFocusOut);
            el.removeEventListener('focusin', onFocusIn);
            settle.dispose();
        },
    };
}
