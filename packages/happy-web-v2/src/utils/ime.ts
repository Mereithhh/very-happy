/**
 * IME (CJK input method) guard for key-driven submit/navigation handlers.
 *
 * While an IME composition is active, Space/Enter/arrow keys operate the
 * candidate window — they must NEVER submit a form, confirm a modal, or move a
 * list selection. Browsers signal this via `KeyboardEvent.isComposing`, but
 * with two long-standing quirks the check has to cover as well:
 * - Chrome/legacy IMEs report `keyCode === 229` for every key routed through
 *   the IME (sometimes with `isComposing` unset).
 * - Safari fires the composition-committing Enter/Space keydown AFTER
 *   `compositionend`, with `isComposing === false` but `keyCode === 229`.
 *
 * Works on both native `KeyboardEvent` and React synthetic events (which hide
 * `isComposing` on `nativeEvent`).
 */
export function isImeComposingEvent(
  e: Pick<KeyboardEvent, 'keyCode'> & { isComposing?: boolean; nativeEvent?: Event },
): boolean {
  const native = (e.nativeEvent ?? e) as Partial<KeyboardEvent>;
  return !!native.isComposing || native.keyCode === 229 || e.keyCode === 229;
}
