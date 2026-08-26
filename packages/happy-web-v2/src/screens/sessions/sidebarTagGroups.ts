/**
 * sidebarTagGroups — the 列表 view's optional "按 tag 分组" rendering (B-091).
 * Pure; unit-tested (sidebarTagGroups.test.ts).
 *
 * Grouping key = a row's FIRST tag (the tag list is user-ordered; the first
 * one is the identity). Rows without tags fall into the trailing 未分组 group
 * (`tag: null`); terminals from new daemons participate like sessions. Group
 * identity is case-insensitive ("Deploy" and "deploy" share a group, first
 * seen casing labels it), matching every other tag comparison in the app.
 *
 * Group order: the priority group (utils/tags PRIORITY_TAG) always first,
 * then groups by first appearance in the incoming row order (which the caller
 * has already sorted), untagged last. Row order WITHIN a group is untouched.
 */
import { isPriorityTag } from '@/utils/tags';

export interface TagGroup<R> {
  /** display tag (first-seen casing); null = the 未分组 bucket */
  tag: string | null;
  rows: R[];
}

export function groupRowsByTag<R extends { tags?: string[] }>(rows: readonly R[]): Array<TagGroup<R>> {
  const byKey = new Map<string, TagGroup<R>>();
  const untagged: R[] = [];
  for (const row of rows) {
    const tag = row.tags?.[0];
    if (!tag) {
      untagged.push(row);
      continue;
    }
    const key = tag.toLowerCase();
    let group = byKey.get(key);
    if (!group) {
      group = { tag, rows: [] };
      byKey.set(key, group);
    }
    group.rows.push(row);
  }
  const groups = [...byKey.values()];
  const priority = groups.filter((g) => g.tag !== null && isPriorityTag(g.tag));
  const others = groups.filter((g) => g.tag === null || !isPriorityTag(g.tag));
  const out: Array<TagGroup<R>> = [...priority, ...others];
  if (untagged.length > 0) out.push({ tag: null, rows: untagged });
  return out;
}
