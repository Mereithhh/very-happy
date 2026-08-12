/**
 * Sidebar search-query parsing with `#tag` syntax. Pure; unit-tested.
 *
 * Grammar (whitespace-tokenized):
 *   `#foo`     → tag term: row must carry a tag that equals or starts with
 *                "foo" (case-insensitive). Multiple tag terms AND together.
 *   `#`        → bare hash: row must have at least one tag.
 *   everything else → text: the non-tag remainder (joined by single spaces)
 *                is a case-insensitive substring match on title or subtitle,
 *                preserving the pre-tag search behavior.
 */

export interface ParsedSidebarQuery {
  /** Lowercased free-text remainder ('' = no text constraint). */
  text: string;
  /** Lowercased tag prefixes (each must match some row tag). */
  tags: string[];
  /** A bare `#` was present → only rows with at least one tag match. */
  requireAnyTag: boolean;
}

export function parseSidebarQuery(query: string): ParsedSidebarQuery {
  const tags: string[] = [];
  let requireAnyTag = false;
  const textTokens: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('#')) {
      const tag = token.slice(1).toLowerCase();
      if (tag) tags.push(tag);
      else requireAnyTag = true;
      continue;
    }
    textTokens.push(token);
  }
  return { text: textTokens.join(' ').toLowerCase(), tags, requireAnyTag };
}

export function sidebarQueryIsEmpty(q: ParsedSidebarQuery): boolean {
  return !q.text && q.tags.length === 0 && !q.requireAnyTag;
}

export function rowMatchesSidebarQuery(
  row: { title: string; subtitle: string; tags?: string[] },
  q: ParsedSidebarQuery,
): boolean {
  if (q.text) {
    const hit =
      row.title.toLowerCase().includes(q.text) || row.subtitle.toLowerCase().includes(q.text);
    if (!hit) return false;
  }
  const rowTags = (row.tags ?? []).map((t) => t.toLowerCase());
  if (q.requireAnyTag && rowTags.length === 0) return false;
  for (const term of q.tags) {
    if (!rowTags.some((t) => t === term || t.startsWith(term))) return false;
  }
  return true;
}
