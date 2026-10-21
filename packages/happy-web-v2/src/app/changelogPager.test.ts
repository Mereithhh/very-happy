import { describe, expect, it } from 'vitest';
import type { ChangelogRelease } from './changelogRelease';
import { CHANGELOG_RELEASES } from './changelogRelease';
import {
  changelogPages,
  markChangelogRead,
  pageReleaseIds,
  parseChangelogRead,
  pendingChangelogReleases,
  type ChangelogReadState,
  unreadMajorCount,
} from './changelogPager';
import { isDeepLinkEntry } from './entryKind';

const rel = (id: string, major = false): ChangelogRelease => ({
  id,
  date: '2026-10-21',
  major,
  titleKey: 'changelog.releases.oct21.title',
  summaryKey: 'changelog.releases.oct21.summary',
  itemKeys: [],
});
// newest first, like CHANGELOG_RELEASES
const R = [rel('r4-major', true), rel('r3-minor'), rel('r2-major', true), rel('r1-minor'), rel('r0')];

describe('B-715 pager: stacked unread releases', () => {
  it('2 major + 2 minor unread → majors oldest first, minors folded into one last page', () => {
    const pending = pendingChangelogReleases({ seen: 'r0', read: [] }, R);
    const pages = changelogPages(pending);
    expect(pages.map((p) => p.kind)).toEqual(['major', 'major', 'minor']);
    expect(pages.map(pageReleaseIds)).toEqual([['r2-major'], ['r4-major'], ['r3-minor', 'r1-minor']]);
    expect(unreadMajorCount(pending)).toBe(2);
  });

  it('only minors → one page (nothing to lock)', () => {
    const pages = changelogPages(pendingChangelogReleases({ seen: 'r2-major', read: [] }, R).filter((r) => !r.major));
    expect(pages).toHaveLength(1);
    expect(pages[0].kind).toBe('minor');
  });

  it('a reload resumes at the first unread page: finished pages are recorded one by one', () => {
    let state: ChangelogReadState = { seen: 'r0', read: [] };
    state = markChangelogRead(state, ['r2-major'], R);
    // r1-minor (below r2) is still unread, so the watermark stays and r2 sits in the set.
    expect(state).toEqual({ seen: 'r0', read: ['r2-major'] });
    const resumed = changelogPages(pendingChangelogReleases(state, R));
    expect(resumed.map(pageReleaseIds)).toEqual([['r4-major'], ['r3-minor', 'r1-minor']]);
    state = markChangelogRead(state, ['r4-major'], R);
    expect(unreadMajorCount(pendingChangelogReleases(state, R))).toBe(0);
    // The minor page completes the run: watermark jumps to the head, set empties.
    state = markChangelogRead(state, ['r3-minor', 'r1-minor'], R);
    expect(state).toEqual({ seen: 'r4-major', read: [] });
    expect(pendingChangelogReleases(state, R)).toEqual([]);
  });

  it('the watermark advances over a contiguous read run only', () => {
    expect(markChangelogRead({ seen: 'r0', read: [] }, ['r1-minor', 'r2-major'], R)).toEqual({ seen: 'r2-major', read: [] });
  });

  it('no receipt (fresh browser) → only the head is unread, and reading it sets the receipt', () => {
    expect(pendingChangelogReleases({ seen: null, read: [] }, R).map((r) => r.id)).toEqual(['r4-major']);
    expect(markChangelogRead({ seen: null, read: [] }, ['r4-major'], R)).toEqual({ seen: 'r4-major', read: [] });
  });

  it('a malformed read set is ignored, never thrown', () => {
    expect(parseChangelogRead('not json')).toEqual([]);
    expect(parseChangelogRead('{"a":1}')).toEqual([]);
    expect(parseChangelogRead('["x",2]')).toEqual(['x']);
  });

  it('the 10-21 updates (oct21, oct21b) are major and carry highlights', () => {
    const major = CHANGELOG_RELEASES.filter((r) => r.major);
    expect(major.map((r) => r.titleKey)).toEqual(expect.arrayContaining(['changelog.releases.oct21b.title', 'changelog.releases.oct21.title']));
    for (const r of major) expect(r.highlights?.length, `${r.id} is major without highlights`).toBeGreaterThan(0);
  });
});

describe('B-715 deep-link entry', () => {
  it.each([
    ['/teams/t1', '?task=abc', true],
    ['/session/abc', '?vh_presence=1', true],
    ['/', '?panel=files', true],
    ['/terminal/connect', '', true],
    ['/machine/connect', '', true],
    ['/', '', false],
    ['/session/abc', '', false],
    ['/', '?', false],
  ])('%s%s → deep link %s', (pathname, search, expected) => {
    expect(isDeepLinkEntry({ pathname, search })).toBe(expected);
  });
  it('honours a base path', () => {
    expect(isDeepLinkEntry({ pathname: '/app/machine/connect', search: '' }, '/app')).toBe(true);
    expect(isDeepLinkEntry({ pathname: '/app/', search: '' }, '/app')).toBe(false);
  });
});
