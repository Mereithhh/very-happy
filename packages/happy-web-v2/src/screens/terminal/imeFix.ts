/**
 * Chinese/Japanese/Korean IME fix for xterm.js.
 *
 * xterm parks its helper <textarea> at ~1px and transparent. During IME
 * composition the candidate/pinyin box renders against that textarea, so CJK
 * users see their composing text overlapping terminal output, mis-positioned and
 * invisible. xterm adds the `.composing` class to the textarea during an active
 * composition (compositionstart→compositionend), so we make it visible, opaque,
 * and auto-sized only while composing. Committed text still flows through
 * term.onData normally — no custom composition handling needed.
 */
let injected = false;

export function ensureImeFix() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'vh-xterm-ime-fix';
  style.textContent = `
.xterm .xterm-helper-textarea.composing {
  opacity: 1 !important;
  z-index: 10 !important;
  width: auto !important;
  min-width: 1ch;
  max-width: 90vw;
  height: auto !important;
  padding: 2px 6px !important;
  color: #E8EDF4 !important;
  background-color: #181F2A !important;
  border: 1px solid #34E2C4 !important;
  border-radius: 6px !important;
  caret-color: #34E2C4 !important;
  white-space: pre !important;
  font-family: var(--font-mono), monospace !important;
  line-height: 1.4 !important;
  box-shadow: 0 4px 16px -4px rgba(0,0,0,0.6) !important;
}`;
  document.head.appendChild(style);
}
