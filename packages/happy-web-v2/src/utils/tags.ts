/**
 * Session-tag helpers: input normalization and the stable text→hue mapping
 * used by tag chips. Pure; unit-tested.
 */

/** Number of tag hue slots (must match the `--tagc-N-*` tokens in
 *  ui/tagchip.css). */
export const TAG_HUE_COUNT = 6;

export const TAG_MAX_LENGTH = 24;

/**
 * Normalize raw chip input into a storable tag:
 *  - strips leading `#`s (people type "#deploy")
 *  - trims, collapses inner whitespace to `-` (tags must survive the
 *    whitespace-tokenized `#tag` search syntax)
 *  - hard cap at TAG_MAX_LENGTH chars
 * Case is preserved for display; matching is case-insensitive everywhere.
 * Returns '' when nothing usable remains.
 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, TAG_MAX_LENGTH);
}

/** Add a (raw) tag to a list, deduplicating case-insensitively. Returns the
 *  original array when nothing was added. */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (!tag) return tags;
  const lower = tag.toLowerCase();
  if (tags.some((t) => t.toLowerCase() === lower)) return tags;
  return [...tags, tag];
}

/** Stable FNV-1a hash of the (lowercased) tag text → hue slot 0..TAG_HUE_COUNT-1.
 *  Case-insensitive so "Deploy" and "deploy" always share a color. */
export function tagHueIndex(tag: string, hueCount: number = TAG_HUE_COUNT): number {
  const s = tag.toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % hueCount;
}
