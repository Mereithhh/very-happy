/**
 * IME (CJK input method) guard for key-driven submit/navigation handlers.
 *
 * While an IME composition is active, Space/Enter/arrow keys operate the
 * candidate window — they must NEVER submit a form, confirm a modal, or move a
 * list selection. Signals, in order of reliability:
 *
 * 1. `KeyboardEvent.isComposing` — the spec'd signal: true for every keydown
 *    routed through an active composition.
 * 2. `key === 'Process'` — Chrome (and legacy IME paths) report keys swallowed
 *    by the IME with this key value.
 * 3. A "recently composed" window — Safari fires the composition-committing
 *    Enter keydown AFTER `compositionend` with `isComposing === false`; only
 *    its proximity to the compositionend reveals it. `markCompositionEnd()`
 *    records that moment (a document-level listener below feeds it globally;
 *    the `useImeGuard` hook also marks per input) and the guard treats any key
 *    within RECENT_COMPOSITION_MS as composition traffic.
 *
 * ⚠️ Bare `keyCode === 229` is deliberately NOT a signal. Android soft
 * keyboards (GBoard & co.) report 229 for EVERY key — including a plain Enter
 * with no composition anywhere — so the old `keyCode === 229` check silently
 * disabled Enter-to-submit for all Android users. The three signals above
 * cover the real composition cases 229 used to proxy for.
 *
 * Works on both native `KeyboardEvent` and React synthetic events (which hide
 * `isComposing` on `nativeEvent`).
 */
import { useMemo, useRef } from 'react';

type KeyEventLike = {
  key?: string;
  isComposing?: boolean;
  nativeEvent?: Event;
};

/** How long after a compositionend a key event still counts as composition
 *  traffic (covers Safari's post-compositionend committing Enter). */
export const RECENT_COMPOSITION_MS = 50;

let lastCompositionEndAt = 0;

/** Record that a composition just ended. Called by the global listener below
 *  and by `useImeGuard().onCompositionEnd`; exported for non-hook callers. */
export function markCompositionEnd(now: number = Date.now()): void {
  lastCompositionEndAt = now;
}

/** Whether a composition ended within the last `ms` — i.e. this key event may
 *  be the one that committed it (Safari ordering quirk). */
export function wasRecentlyComposing(
  ms: number = RECENT_COMPOSITION_MS,
  now: number = Date.now(),
): boolean {
  return now - lastCompositionEndAt < ms;
}

// Feed the recent-composition window from EVERY input on the page, so guards
// that listen at window/document level (sidebar shortcuts, modal keydown) are
// covered even for inputs that don't use the hook. Capture phase: composition
// events bubble, but a stopPropagation in some widget must not starve the
// guard. No-op outside the browser (vitest node env).
if (typeof document !== 'undefined') {
  document.addEventListener('compositionend', () => markCompositionEnd(), true);
}

/** The event itself says "composition": isComposing, or Chrome's 'Process'. */
export function isImeComposingEvent(e: KeyEventLike): boolean {
  const native = (e.nativeEvent ?? e) as Partial<KeyboardEvent>;
  const key = native.key ?? e.key;
  return !!native.isComposing || !!e.isComposing || key === 'Process';
}

/** Full guard for submit/navigation keydown handlers: composition signaled on
 *  the event, OR a composition ended a moment ago (Safari's committing Enter
 *  arrives after compositionend with isComposing=false). */
export function isImeGuardedEvent(e: KeyEventLike): boolean {
  return isImeComposingEvent(e) || wasRecentlyComposing();
}

export interface ImeGuard {
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /** true → this key event is composition traffic; do not submit/navigate. */
  isGuarded: (e: KeyEventLike) => boolean;
  /** Live composition state, for non-key submit paths (e.g. a send button
   *  tapped while a composition is still open). */
  isComposing: () => boolean;
}

/**
 * Per-input IME guard (the chat composer's composingRef pattern, extracted).
 * Wire `onCompositionStart`/`onCompositionEnd` onto the input (or a container
 * — composition events bubble) and gate key handlers with `isGuarded(e)`:
 * it combines the local composing flag (covers browsers that misreport both
 * isComposing and key) with the event/window signals above. The composing
 * flag resets one tick late because some browsers deliver the composition-
 * committing keydown after compositionend.
 */
export function useImeGuard(): ImeGuard {
  const composingRef = useRef(false);
  return useMemo(
    () => ({
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        markCompositionEnd();
        setTimeout(() => {
          composingRef.current = false;
        }, 0);
      },
      isGuarded: (e: KeyEventLike) => composingRef.current || isImeGuardedEvent(e),
      isComposing: () => composingRef.current,
    }),
    [],
  );
}
