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
 * B-091 / B-522: priority is a tag convention, not a schema field — old
 * clients just render it as a chip. Levels `P0` > `P1` > `P2` (Owner
 * 2026-10-02: 「优先级可以排 P0, P1, P2」; B-091 had deliberately kept a single
 * `priority` tag). The legacy `priority` tag reads as P0, so sessions marked
 * before keep their place at the top. Matching is case-insensitive like every
 * other tag comparison.
 */
export const PRIORITY_TAG = 'priority';
export const PRIORITY_LEVELS = [0, 1, 2] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export function priorityTag(level: PriorityLevel): string {
  return `P${level}`;
}

/** The level a single tag stands for, or null when it is not a priority tag. */
export function priorityLevelOfTag(tag: string): PriorityLevel | null {
  const lower = tag.toLowerCase();
  if (lower === PRIORITY_TAG) return 0;
  const m = /^p([0-2])$/.exec(lower);
  return m ? (Number(m[1]) as PriorityLevel) : null;
}

export function isPriorityTag(tag: string): boolean {
  return priorityLevelOfTag(tag) !== null;
}

/** Highest (numerically lowest) level among the tags, or null. */
export function priorityLevel(tags: string[] | undefined): PriorityLevel | null {
  let best: PriorityLevel | null = null;
  for (const tag of tags ?? []) {
    const level = priorityLevelOfTag(tag);
    if (level !== null && (best === null || level < best)) best = level;
  }
  return best;
}

export function hasPriorityTag(tags: string[] | undefined): boolean {
  return priorityLevel(tags) !== null;
}

/**
 * Set (or with null clear) the row's priority. Every existing priority tag,
 * legacy spelling included, is replaced; the new one goes FIRST so it becomes
 * the grouping tag. Never mutates the input.
 */
export function setPriorityLevel(tags: string[] | undefined, level: PriorityLevel | null): string[] {
  const rest = (tags ?? []).filter((t) => !isPriorityTag(t));
  return level === null ? rest : [priorityTag(level), ...rest];
}

/** Toggle the legacy single priority (kept for callers that only know on/off): off → P0. */
export function togglePriorityTag(tags: string[] | undefined): string[] {
  return setPriorityLevel(tags, hasPriorityTag(tags) ? null : 0);
}

/**
 * Stable sort by priority level: P0, P1, P2, then everything else, each band
 * keeping its existing relative order — this layers on top of whatever order
 * the caller already established (recent/manual/board rank) instead of
 * replacing it. Returns the input array when nothing moves.
 */
export function sortByPriority<T>(items: readonly T[], levelOf: (item: T) => number | null): T[] {
  const bands: T[][] = [[], [], [], []];
  for (const item of items) {
    const level = levelOf(item);
    bands[level === null || level < 0 || level > 2 ? 3 : level].push(item);
  }
  const out = bands.flat();
  return out.every((item, i) => item === items[i]) ? (items as T[]) : out;
}

/** Two-band form of `sortByPriority` (priority items first). */
export function sortPriorityFirst<T>(items: readonly T[], isPriority: (item: T) => boolean): T[] {
  return sortByPriority(items, (item) => (isPriority(item) ? 0 : null));
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
