/**
 * B-728 (UI-P1-03 / UI-M-02) — keyboard focus rings only after keyboard input.
 *
 * Browsers decide `:focus-visible` per focus() call, and programmatic focus
 * inherits it: a dialog title focused on open, a native `<dialog>`'s first
 * button, a Radix menu handing focus back to its ⋯ trigger after a tap — all
 * showed the accent ring although the person only used a mouse or a finger.
 *
 * We track the last input modality on <html data-input="pointer|keyboard">.
 * While it is `pointer`, base.css zeroes `--focus-ring`, so every component
 * that paints keyboard focus with the token goes quiet; the first real key
 * press (Tab, arrows, Esc, …) brings the ring straight back.
 */
export type InputModality = 'pointer' | 'keyboard';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);

/** Pure: the modality an event implies, or null when it should not change it. */
export function modalityFor(event: { type: string; key?: string }): InputModality | null {
  if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'touchstart') return 'pointer';
  if (event.type === 'keydown') return event.key && MODIFIER_KEYS.has(event.key) ? null : 'keyboard';
  return null;
}

export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const onEvent = (event: Event) => {
    const next = modalityFor(event as KeyboardEvent);
    if (next && root.dataset.input !== next) root.dataset.input = next;
  };
  const types = ['pointerdown', 'keydown'] as const;
  for (const type of types) doc.addEventListener(type, onEvent, { capture: true, passive: true });
  return () => { for (const type of types) doc.removeEventListener(type, onEvent, { capture: true }); };
}
