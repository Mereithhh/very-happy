/**
 * Markdown → plain preview text (display-only; never round-tripped).
 *
 * Shared by the board/sidebar session preview (B-553) and the folded team /
 * cross-session / delegation cards (B-716): a preview must never show raw
 * markdown syntax (`**`, `#`, `|---|`, fences). Pure, unit-tested.
 */

/** Cap at `max` code points (never splits a surrogate pair), with an ellipsis. */
export function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/** HTML-ish tags an agent actually emits in prose; anything else (`Array<string>`) is text. */
const HTML_TAG_RE = /<\/?(?:br|p|div|span|details|summary|kbd|sup|sub|b|i|u|em|strong|code|pre|img|a|ul|ol|li|table|tr|td|th|hr)\b[^<>]*>/gi;

/**
 * Markdown → plain lines, one per source line that still has text. A fenced
 * code block becomes a single `[code]` line; table separator rows and rules
 * vanish; table cells are joined by spaces.
 */
export function plainMarkdownLines(raw: string): string[] {
  // Inline code is literal: park it behind placeholders so no markdown rule
  // below can touch `*.ts`, `__init__` or `Array<string>`, restore at the end.
  const code: string[] = [];
  const parked = raw
    .replace(/```[\s\S]*?(```|$)/g, '\n[code]\n')
    .replace(/`([^`\n]+)`/g, (_m, inner: string) => `\u0000${code.push(inner) - 1}\u0000`);
  const text = parked
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(HTML_TAG_RE, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // `__bold__` only around phrases with a space: identifiers (mcp__happy__x,
    // __init__) stay intact even outside backticks.
    .replace(/(^|[^\w])__(?!\s)([^_\n]*\s[^_\n]*?)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '');
  return text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Markdown → one plain line, capped at `max` code points. */
export function plainPreviewText(raw: string, max = 300): string {
  return capChars(plainMarkdownLines(raw).join(' '), max);
}

/** Markdown → the first `maxLines` plain lines (each capped), for a multi-line folded preview. */
export function plainPreviewLines(raw: string, maxLines = 3, maxLineChars = 200): { lines: string[]; truncated: boolean } {
  const all = plainMarkdownLines(raw);
  const lines = all.slice(0, maxLines).map((line) => capChars(line, maxLineChars));
  return { lines, truncated: all.length > maxLines || lines.some((line, i) => line !== all[i]) };
}
