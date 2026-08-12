/**
 * Desktop IME stuck-composition guard for xterm.js.
 *
 * ── The failure (reproduced; real user reports 2026-08-12: "切了中文输入法
 *    只能打出英文 / 切换不了输入法" and "输入框前面留着一个字母怎么也删不掉") ──
 * Switching the macOS input source MID-COMPOSITION can abort the composition
 * WITHOUT delivering a compositionend event. xterm 5.5's CompositionHelper is
 * then stuck with `_isComposing = true`, and its keydown() does this while the
 * flag is up (verified against @xterm/xterm 5.5 lib source):
 *
 *  - keyCode 229 — EVERY key routed through a CJK IME — returns false: the key
 *    is silently swallowed. Chinese typing goes completely dead while plain
 *    English keys still work, which users read as "只能英文输入".
 *  - any other keyCode → `_finalizeComposition(false)`: the aborted preedit
 *    sitting in the hidden textarea is committed to the pty — the stray letter
 *    that appears in front of (e.g.) the claude input box.
 *
 * Meanwhile the `.composition-view` bubble stays `.active`, pinned at the
 * cursor showing the aborted preedit — a DOM overlay that no amount of
 * backspace can remove ("一个字母怎么也删不掉").
 *
 * The existing refocus() heal (blur fires compositionend per spec) does NOT
 * cover this state: the browser-side composition is already gone, so blur
 * fires nothing and the flag stays stuck (verified: blur + focus left
 * `_isComposing === true`). That's why "来回切换输入法/切走再切回来" never
 * fixes it for the user.
 *
 * ── Healing ──────────────────────────────────────────────────────────────
 * The abort is only observable at the NEXT keydown: KeyboardEvent.isComposing
 * (plus Chrome's key === 'Process') is the browser's truth about whether a
 * composition is really active. helper-says-composing + event-says-not ⇒ the
 * composition was aborted eventlessly ⇒ reset the helper BEFORE xterm's own
 * textarea keydown listener runs (capture listener on term.element — DOM
 * dispatch runs ancestor-capture listeners before any target listener; same
 * mechanism mobileInputBridge relies on).
 *
 * Healing drops the aborted preedit entirely — the IME never committed it, so
 * committing it here would just resurrect the stray-letter bug: reset both
 * helper flags, hide the bubble, clear the textarea, zero the composition
 * position. If a composition were somehow still alive despite the signals
 * (belt for a mis-reporting IME), zeroed bookkeeping still commits correctly:
 * finalize(true) then sends substring(0) = the full textarea = the composed
 * text.
 *
 * ── Second duty: textarea residue hygiene ────────────────────────────────
 * On desktop nothing ever clears the helper textarea (xterm itself clears it
 * only when handling Enter/^C keydowns), so committed compositions accumulate
 * forever ("n", "n你好", …). That residue is exactly what macOS commits into
 * the pty on an input-source switch, and stale content skews the helper's
 * substring/replace bookkeeping. After a composition settles — compositionend
 * processed AND finalize's deferred textarea read done (it reads ASYNCHRONOUSLY
 * in a 0ms timer; clearing earlier would eat the commit) — clear the textarea.
 * Any keydown cancels a pending clear (never mutate the field under an active
 * typist / mid direct-commit diff); the next compositionend re-arms it.
 *
 * Mobile must NOT install this: mobileInputBridge owns the textarea as the
 * soft keyboard's shared model and clearing behind its back re-introduces the
 * keyboard-desync bug it exists to fix. Fine pointers only.
 */
import type { Terminal } from '@xterm/xterm';

/**
 * helper-says-composing + event-says-NOT-composing ⇒ eventless abort.
 *
 * The event signal must be the spec'd `isComposing` and nothing else —
 * deliberately NOT ime.ts's isImeComposingEvent: Chrome reports EVERY key
 * routed through a CJK IME as key='Process', including the swallowed keys of
 * the stuck state itself, so treating 'Process' as "composing" would make the
 * healer skip exactly the case users hit (typing Chinese while stuck).
 * `isComposing` is precise: true for every keydown dispatched inside a REAL
 * composition, false for the composition-opening keydown (helper flag is
 * still false there — no heal) and false in the stuck state (heal). Strict
 * `=== false` so browsers that omit the property never trigger a heal.
 */
export function shouldHealStuckComposition(
    helperComposing: boolean,
    ev: { isComposing?: boolean },
): boolean {
    return helperComposing && ev.isComposing === false;
}

export interface SettleFlags {
    /** helper._isComposing — a (new) composition is active. */
    composing: boolean;
    /** helper._isSendingComposition — finalize's 0ms textarea read pending. */
    sending: boolean;
}

export interface CompositionSettleClear {
    /** A composition ended — schedule a clear once the helper settles. */
    arm(): void;
    /** User activity — do not clear under an active typist. */
    cancelPending(): void;
    dispose(): void;
}

/**
 * Deferred "clear the textarea once the composition fully settled" scheduler.
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
        // A new composition took over — its own compositionend re-arms us.
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
    dispose(): void;
}

export function installImeStuckGuard(term: Terminal): ImeStuckGuardHandle | null {
    const el = term.element;
    const ta = el?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (!el || !ta) return null;
    // Private API, best-effort — same access pattern as refocus()/mobileInputBridge.
    const core = (term as unknown as { _core?: any })._core;
    const helper = core?._compositionHelper;

    const settle = createCompositionSettleClear({
        read: () => ({
            composing: !!helper?._isComposing,
            sending: !!helper?._isSendingComposition,
        }),
        clear: () => { ta.value = ''; },
    });

    const heal = () => {
        try {
            helper._isComposing = false;
            helper._isSendingComposition = false;
            if (helper._compositionPosition) {
                helper._compositionPosition.start = 0;
                helper._compositionPosition.end = 0;
            }
            const view = el.querySelector('.composition-view');
            if (view) { view.classList.remove('active'); view.textContent = ''; }
        } catch { /* private API best-effort */ }
        ta.value = '';
    };

    const onKeyDown = (ev: Event) => {
        if (ev.target !== ta) return;
        settle.cancelPending();
        if (helper && shouldHealStuckComposition(!!helper._isComposing, ev as KeyboardEvent)) {
            // Never stop/preventDefault the event: after healing, this same
            // keydown flows into a now-consistent xterm and types normally
            // (a fresh 229 starts a fresh composition; an English key sends).
            heal();
        }
    };
    const onCompositionEnd = (ev: Event) => {
        if (ev.target !== ta) return;
        settle.arm();
    };

    // Capture on the ANCESTOR: runs before xterm's own textarea keydown
    // listener regardless of registration order.
    el.addEventListener('keydown', onKeyDown, true);
    // Bubble: runs after xterm's compositionend handler armed its finalize.
    el.addEventListener('compositionend', onCompositionEnd);

    return {
        dispose() {
            el.removeEventListener('keydown', onKeyDown, true);
            el.removeEventListener('compositionend', onCompositionEnd);
            settle.dispose();
        },
    };
}
