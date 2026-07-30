/**
 * Chinese/Japanese/Korean IME fix for xterm.js.
 *
 * Ground truth from xterm 5.5's CompositionHelper (lib/xterm.js):
 *  - The ONLY visible composition UI is the `.composition-view` div. On
 *    compositionstart xterm adds `.active` to it (display toggling is xterm's),
 *    writes the composing string into it on compositionupdate, and positions it
 *    at the cursor (inline left/top/fontFamily/fontSize/lineHeight).
 *  - The helper <textarea> NEVER gets a `.composing` class in 5.5 — any CSS
 *    targeting `.xterm-helper-textarea.composing` is dead. (An earlier fix did
 *    exactly that, and a follow-up then hid `.composition-view` entirely, which
 *    made composition invisible — pinyin seemed "broken / english only".)
 *
 * So the real fix is to style `.composition-view` itself: xterm's default is a
 * bare black box with no padding that visually collides with the cell text
 * under it. Give it the terminal's opaque background, a border and padding so
 * the composing pinyin reads as a small input bubble at the cursor. We must NOT
 * touch `display` — xterm drives visibility via `.active`.
 */
let injected = false;

export function ensureImeFix() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'vh-xterm-ime-fix';
  style.textContent = `
.xterm .composition-view {
  background: #181F2A !important;
  color: #E8EDF4 !important;
  border: 1px solid #34E2C4 !important;
  border-radius: 6px !important;
  padding: 2px 6px !important;
  z-index: 10 !important;
  white-space: pre !important;
  box-shadow: 0 4px 16px -4px rgba(0,0,0,0.6) !important;
}`;
  document.head.appendChild(style);
}
