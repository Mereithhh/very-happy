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

/**
 * B-091: the ONE tag spelling that means "优先". A convention, not a schema
 * field — old clients just render it as a normal chip (harmless). Matching is
 * case-insensitive like every other tag comparison. Chosen over `p0`: it
 * reads as a word in both the chip and the row menu, and `p0/p1/p2` invites a
 * ladder we don't want to sort by.
 */
export const PRIORITY_TAG = 'priority';

export function isPriorityTag(tag: string): boolean {
  return tag.toLowerCase() === PRIORITY_TAG;
}

export function hasPriorityTag(tags: string[] | undefined): boolean {
  return (tags ?? []).some(isPriorityTag);
}

/** Toggle the priority tag on a tag list (row menu 标记优先/取消优先).
 *  Adding puts it FIRST so it becomes the grouping tag; removing strips every
 *  case variant. Never mutates the input. */
export function togglePriorityTag(tags: string[] | undefined): string[] {
  const cur = tags ?? [];
  return hasPriorityTag(cur) ? cur.filter((t) => !isPriorityTag(t)) : [PRIORITY_TAG, ...cur];
}

/**
 * Stable partition: items the predicate marks as priority float to the top,
 * BOTH halves keeping their existing relative order — this layers on top of
 * whatever order the caller already established (recent/manual/board rank)
 * instead of replacing it. Returns the input array when nothing moves.
 */
export function sortPriorityFirst<T>(items: readonly T[], isPriority: (item: T) => boolean): T[] {
  const top: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isPriority(item) ? top : rest).push(item);
  if (top.length === 0 || rest.length === 0) return items as T[];
  return [...top, ...rest];
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
