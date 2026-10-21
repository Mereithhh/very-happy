/**
 * B-715 — stacked release notes are read page by page (specs/2026-10-whats-new.md
 * §B-715). Pure: storage, React and the router live in changelogReadStore.ts
 * and ChangelogNotice.tsx.
 *
 * Read state = the B-315 receipt (`vh.changelog.seen`, a watermark: that
 * release and everything older is read) + a small set of ids read one by one
 * above the watermark (`vh.changelog.read`). Finishing a page adds its ids to
 * the set; the watermark then advances over every contiguous read release, so
 * the set stays tiny and old clients that only know the receipt keep working.
 */
import { CHANGELOG_RELEASES, normalizeChangelogSeen, unseenChangelogReleases, type ChangelogRelease } from './changelogRelease';

export const CHANGELOG_READ_KEY = 'vh.changelog.read';

export interface ChangelogReadState {
  seen: string | null;
  read: readonly string[];
}

/** One page of the notice: a major release alone, or every minor release folded together. */
export type ChangelogPage =
  | { kind: 'major'; key: string; release: ChangelogRelease }
  | { kind: 'minor'; key: string; releases: readonly ChangelogRelease[] };

/** Tolerant parse of the read-set value; anything malformed reads as empty. */
export function parseChangelogRead(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Unread releases, newest first: the receipt diff (B-320) minus the ones read one by one. */
export function pendingChangelogReleases(
  state: ChangelogReadState,
  releases: readonly ChangelogRelease[] = CHANGELOG_RELEASES,
): ChangelogRelease[] {
  const read = new Set(state.read);
  return unseenChangelogReleases(state.seen, releases).filter((release) => !read.has(release.id));
}

/**
 * Pages oldest → newest: each major release gets its own page; minor ones are
 * folded into one 「其他改进」 page at the end, so a small fix never costs a
 * click of its own but still is not skipped.
 */
export function changelogPages(pending: readonly ChangelogRelease[]): ChangelogPage[] {
  const oldestFirst = [...pending].reverse();
  const pages: ChangelogPage[] = oldestFirst
    .filter((release) => release.major)
    .map((release) => ({ kind: 'major', key: release.id, release }));
  const minor = pending.filter((release) => !release.major);
  if (minor.length > 0) pages.push({ kind: 'minor', key: `minor:${minor.map((r) => r.id).join(',')}`, releases: minor });
  return pages;
}

export function pageReleaseIds(page: ChangelogPage): string[] {
  return page.kind === 'major' ? [page.release.id] : page.releases.map((release) => release.id);
}

/** Major releases still unread — what the sidebar entry counts. */
export function unreadMajorCount(pending: readonly ChangelogRelease[]): number {
  return pending.filter((release) => release.major).length;
}

/**
 * Record `ids` as read. The watermark advances over every release directly
 * above it that is now read; ids it passes leave the set. With no receipt (a
 * fresh browser only ever sees the head, B-320) the watermark starts just
 * below the head.
 */
export function markChangelogRead(
  state: ChangelogReadState,
  ids: readonly string[],
  releases: readonly ChangelogRelease[] = CHANGELOG_RELEASES,
): ChangelogReadState {
  if (releases.length === 0) return state;
  const read = new Set([...state.read, ...ids]);
  const seenId = normalizeChangelogSeen(state.seen);
  const seenIndex = seenId === null ? -1 : releases.findIndex((release) => release.id === seenId);
  // Index of the newest release counted as read; `releases.length` = nothing read.
  let floor = seenIndex === -1 ? 1 : seenIndex;
  while (floor > 0 && read.has(releases[floor - 1].id)) floor -= 1;
  const valid = new Set(releases.slice(0, floor).map((release) => release.id));
  const nextRead = [...read].filter((id) => valid.has(id));
  const advanced = seenIndex === -1 ? floor < 1 : floor < seenIndex;
  return {
    seen: advanced ? releases[floor].id : state.seen,
    read: nextRead,
  };
}
