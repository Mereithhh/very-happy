import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSED_GROUPS_LIMIT,
  COLLAPSED_GROUPS_STORAGE_KEY,
  findRevealTarget,
  flattenOpenGroups,
  getCollapsedGroups,
  isGroupCollapsed,
  nearestScrollTop,
  parseCollapsedGroups,
  resetCollapsedGroupsForTest,
  setGroupCollapsed,
  summarizeGroup,
  withGroupCollapsed,
} from './sidebarCollapsedGroups';

describe('collapse state (B-580)', () => {
  it('defaults: only 已完成 starts folded; explicit choices win', () => {
    expect(isGroupCollapsed({}, 'completed')).toBe(true);
    expect(isGroupCollapsed({}, 'workspace:a')).toBe(false);
    expect(isGroupCollapsed({ completed: false }, 'completed')).toBe(false);
    expect(isGroupCollapsed({ 'tag:x': true }, 'tag:x')).toBe(true);
  });

  it('trims to the most recent choices', () => {
    let s = {};
    for (let i = 0; i < COLLAPSED_GROUPS_LIMIT + 5; i++) s = withGroupCollapsed(s, `workspace:${i}`, true);
    const keys = Object.keys(s);
    expect(keys).toHaveLength(COLLAPSED_GROUPS_LIMIT);
    expect(keys[0]).toBe('workspace:5');
    // re-choosing an old key moves it to the newest slot
    s = withGroupCollapsed(s, 'workspace:5', false);
    expect(Object.keys(s).at(-1)).toBe('workspace:5');
  });

  it('parse tolerates garbage', () => {
    expect(parseCollapsedGroups(null)).toEqual({});
    expect(parseCollapsedGroups('not json')).toEqual({});
    expect(parseCollapsedGroups('[1]')).toEqual({});
    expect(parseCollapsedGroups('{"a":true,"b":"x"}')).toEqual({ a: true });
  });
});

describe('store persistence (B-580)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCollapsedGroupsForTest();
  });

  it('round-trips through localStorage', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
    resetCollapsedGroupsForTest();
    setGroupCollapsed('workspace:a', true);
    expect(JSON.parse(mem.get(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual({ 'workspace:a': true });
    resetCollapsedGroupsForTest();
    expect(isGroupCollapsed(getCollapsedGroups(), 'workspace:a')).toBe(true);
  });

  it('falls back to memory when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota'); },
    });
    resetCollapsedGroupsForTest();
    expect(() => setGroupCollapsed('tag:x', true)).not.toThrow();
    expect(isGroupCollapsed(getCollapsedGroups(), 'tag:x')).toBe(true);
  });
});

describe('summarizeGroup (B-580)', () => {
  it('counts waiting / running (+background) / unread, ignores the rest', () => {
    expect(summarizeGroup(['input', 'running', 'background', 'unread', 'unread', null, 'offline', 'unknown'])).toEqual({ input: 1, running: 2, unread: 2 });
  });
});

describe('findRevealTarget (B-580)', () => {
  const sections = [
    { id: 'workspace:a', collapsible: true, keys: ['s1', 's2'] },
    { id: 'workspace:b', collapsible: true, keys: ['s3'] },
    { id: 'all', collapsible: false, keys: ['s4'] },
  ];
  it('finds the group and asks to expand only when folded', () => {
    expect(findRevealTarget(sections, (k) => k === 's3', (id) => id === 'workspace:b')).toEqual({ sectionId: 'workspace:b', key: 's3', expand: true });
    expect(findRevealTarget(sections, (k) => k === 's2', () => false)).toEqual({ sectionId: 'workspace:a', key: 's2', expand: false });
    expect(findRevealTarget(sections, (k) => k === 's4', () => true)).toEqual({ sectionId: 'all', key: 's4', expand: false });
    expect(findRevealTarget(sections, () => false, () => true)).toBeNull();
  });
});

describe('nearestScrollTop (B-580)', () => {
  const box = { containerTop: 100, containerHeight: 400, scrollTop: 200 };
  it('leaves a fully visible row alone', () => {
    expect(nearestScrollTop({ ...box, rowTop: 150, rowHeight: 32 })).toBeNull();
  });
  it('scrolls up to a row above the viewport', () => {
    expect(nearestScrollTop({ ...box, rowTop: 50, rowHeight: 32 })).toBe(200 - 50 - 8);
  });
  it('scrolls down just enough for a row below', () => {
    // row bottom at 100+600-100 → relative bottom 632; overshoot 232 + margin
    expect(nearestScrollTop({ ...box, rowTop: 700, rowHeight: 32 })).toBe(200 + 632 - 400 + 8);
  });
});

describe('flattenOpenGroups (B-580)', () => {
  it('folded groups take no positions in the visible sequence (⌘1-9, move up/down)', () => {
    const groups = [{ key: 'a', rows: ['r1', 'r2'] }, { key: 'b', rows: ['r3'] }, { key: 'c', rows: ['r4'] }];
    const id = (g: { key: string }) => `workspace:${g.key}`;
    expect(flattenOpenGroups(groups, id, {})).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(flattenOpenGroups(groups, id, { 'workspace:b': true })).toEqual(['r1', 'r2', 'r4']);
  });
});
