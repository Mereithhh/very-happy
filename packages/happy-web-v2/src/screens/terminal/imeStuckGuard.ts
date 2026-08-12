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
 * ── Detection ─────────────────────────────────────────────────────────────
 * helper-says-composing + event-says-NOT-composing ⇒ eventless abort. On top
 * of round 1, the 229/modifier path now requires the contradiction to be
 * SUSTAINED (2+ consecutive keydowns with no composition event in between):
 * any compositionstart/update/end resets the streak, so an exotic IME that
 * mis-reports isComposing during a LIVE composition (it keeps emitting
 * composition events) can never be healed into data corruption, while a truly
 * dead composition (no events at all) heals on the second key. Non-229 keys
 * heal immediately — spec guarantees keydowns inside a real composition have
 * isComposing=true, and waiting would let finalize(false) commit the stray.
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
 *  composition key itself and bare modifiers. Everything else triggers
 *  finalize(false) inside xterm — the stray-letter commit. */
const SWALLOWED_WHILE_STUCK = new Set([229, 16, 17, 18]);

export interface StuckDetector {
    /** Any composition event — a live composition exists; reset the streak. */
    compositionEvent(): void;
    /** Evaluate one keydown; returns true when the guard should heal NOW. */
    keydown(helperComposing: boolean, ev: { keyCode?: number; isComposing?: boolean }): boolean;
}

/**
 * Sustained-contradiction detector (pure, unit-testable).
 *  - non-229 contradictory keydown → heal immediately (must beat xterm's
 *    finalize(false) stray-letter commit on this very event).
 *  - 229/modifier contradictory keydowns → heal only when the contradiction
 *    survives 2+ consecutive keydowns with no composition event in between
 *    (xterm swallows these keys silently, so nothing is lost by waiting —
 *    and a real composition starting on key 1 resets the streak via its
 *    compositionstart before key 2 can arrive).
 */
export function createStuckDetector(): StuckDetector {
    let streak = 0;
    return {
        compositionEvent() { streak = 0; },
        keydown(helperComposing, ev) {
            if (!shouldHealStuckComposition(helperComposing, ev)) {
                streak = 0;
                return false;
            }
            streak++;
            if (!SWALLOWED_WHILE_STUCK.has(ev.keyCode ?? 229)) return true;
            return streak >= 2;
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
    /** Observability for tests/harness: how often the guard actually acted. */
    readonly counters: { heals: number; residueClears: number };
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
        if (helper && detector.keydown(!!helper._isComposing, ev as KeyboardEvent)) {
            // Never stop/preventDefault the event: after healing, this same
            // keydown flows into a now-consistent xterm and types normally.
            heal();
        }
    };
    const onCompositionAny = (ev: Event) => {
        if (ev.target !== ta) return;
        detector.compositionEvent();
    };
    const onFocusOut = (ev: Event) => {
        if (ev.target !== ta) return;
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
    el.addEventListener('compositionstart', onCompositionAny, true);
    el.addEventListener('compositionupdate', onCompositionAny, true);
    el.addEventListener('compositionend', onCompositionAny, true);
    // focusin/focusout bubble (focus/blur do not) — plain listeners suffice.
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('focusin', onFocusIn);

    return {
        counters,
        dispose() {
            el.removeEventListener('keydown', onKeyDown, true);
            el.removeEventListener('compositionstart', onCompositionAny, true);
            el.removeEventListener('compositionupdate', onCompositionAny, true);
            el.removeEventListener('compositionend', onCompositionAny, true);
            el.removeEventListener('focusout', onFocusOut);
            el.removeEventListener('focusin', onFocusIn);
            settle.dispose();
        },
    };
}
