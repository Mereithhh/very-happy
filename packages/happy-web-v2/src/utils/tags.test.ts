import { describe, it, expect } from 'vitest';
import {
  normalizeTag,
  addTag,
  tagHueIndex,
  TAG_HUE_COUNT,
  TAG_MAX_LENGTH,
  PRIORITY_TAG,
  isPriorityTag,
  hasPriorityTag,
  togglePriorityTag,
  priorityLevel,
  setPriorityLevel,
  sortByPriority,
  sortPriorityFirst,
} from './tags';

describe('normalizeTag', () => {
  it('strips leading # and trims', () => {
    expect(normalizeTag('  #deploy ')).toBe('deploy');
    expect(normalizeTag('##x')).toBe('x');
  });
  it('collapses inner whitespace to - (must survive #tag tokenization)', () => {
    expect(normalizeTag('my cool tag')).toBe('my-cool-tag');
  });
  it('caps length', () => {
    expect(normalizeTag('a'.repeat(100))).toHaveLength(TAG_MAX_LENGTH);
  });
  it('empty-ish input → empty string', () => {
    expect(normalizeTag('   ')).toBe('');
    expect(normalizeTag('#')).toBe('');
  });
  it('preserves case for display', () => {
    expect(normalizeTag('Deploy')).toBe('Deploy');
  });
});

describe('addTag', () => {
  it('appends a normalized tag', () => {
    expect(addTag(['a'], ' #b ')).toEqual(['a', 'b']);
  });
  it('dedupes case-insensitively, returning the SAME array (no-op signal)', () => {
    const tags = ['Deploy'];
    expect(addTag(tags, 'deploy')).toBe(tags);
  });
  it('ignores empty input', () => {
    const tags = ['a'];
    expect(addTag(tags, '  ')).toBe(tags);
  });
});

describe('tagHueIndex', () => {
  it('is stable and in range', () => {
    for (const tag of ['deploy', 'infra', 'prod', '中文标签', 'x']) {
      const h = tagHueIndex(tag);
      expect(h).toBe(tagHueIndex(tag));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(TAG_HUE_COUNT);
    }
  });
  it('is case-insensitive (same color for Deploy/deploy)', () => {
    expect(tagHueIndex('Deploy')).toBe(tagHueIndex('deploy'));
  });
});

describe('priority tag (B-091)', () => {
  it('matches the convention tag case-insensitively', () => {
    expect(isPriorityTag(PRIORITY_TAG)).toBe(true);
    expect(isPriorityTag('Priority')).toBe(true);
    expect(isPriorityTag('p0')).toBe(true); // B-522 levels
    expect(isPriorityTag('p3')).toBe(false);
    expect(hasPriorityTag(['deploy', 'PRIORITY'])).toBe(true);
    expect(hasPriorityTag(['deploy'])).toBe(false);
    expect(hasPriorityTag(undefined)).toBe(false);
  });

  it('togglePriorityTag prepends when absent (first tag = grouping tag)', () => {
    expect(togglePriorityTag(['deploy'])).toEqual(['P0', 'deploy']);
    expect(togglePriorityTag(undefined)).toEqual(['P0']);
  });

  it('togglePriorityTag strips every case variant when present', () => {
    expect(togglePriorityTag(['Priority', 'deploy', 'priority'])).toEqual(['deploy']);
    expect(togglePriorityTag([PRIORITY_TAG])).toEqual([]);
  });

  it('togglePriorityTag never mutates the input', () => {
    const tags = ['deploy'];
    togglePriorityTag(tags);
    expect(tags).toEqual(['deploy']);
  });
});

describe('sortPriorityFirst', () => {
  const item = (key: string, priority: boolean) => ({ key, priority });
  it('floats priority items, both halves keeping relative order (stable partition)', () => {
    const rows = [item('a', false), item('b', true), item('c', false), item('d', true)];
    expect(sortPriorityFirst(rows, (r) => r.priority).map((r) => r.key)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });
  it('returns the input array unchanged when nothing moves', () => {
    const none = [item('a', false), item('b', false)];
    expect(sortPriorityFirst(none, (r) => r.priority)).toBe(none);
    const all = [item('a', true), item('b', true)];
    expect(sortPriorityFirst(all, (r) => r.priority)).toBe(all);
  });
});

describe('priority levels (B-522)', () => {
  it('reads P0/P1/P2 case-insensitively; legacy `priority` is P0; the highest wins', () => {
    expect(priorityLevel(['P2'])).toBe(2);
    expect(priorityLevel(['deploy', 'p1'])).toBe(1);
    expect(priorityLevel(['priority'])).toBe(0);
    expect(priorityLevel(['P2', 'P1'])).toBe(1);
    expect(priorityLevel(['deploy'])).toBeNull();
  });
  it('setPriorityLevel replaces every priority spelling and puts the new level first', () => {
    expect(setPriorityLevel(['deploy', 'priority', 'p2'], 1)).toEqual(['P1', 'deploy']);
    expect(setPriorityLevel(['P0', 'deploy'], null)).toEqual(['deploy']);
    expect(setPriorityLevel(undefined, 2)).toEqual(['P2']);
  });
  it('sortByPriority bands P0, P1, P2, rest — stable within each band', () => {
    const rows = [{ k: 'a', l: null }, { k: 'b', l: 2 }, { k: 'c', l: 0 }, { k: 'd', l: 2 }, { k: 'e', l: 1 }];
    expect(sortByPriority(rows, (r) => r.l).map((r) => r.k)).toEqual(['c', 'e', 'b', 'd', 'a']);
    const sorted = [{ l: 0 }, { l: 1 }, { l: null }];
    expect(sortByPriority(sorted, (r) => r.l)).toBe(sorted);
  });
});
