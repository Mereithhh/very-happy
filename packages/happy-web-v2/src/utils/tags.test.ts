import { describe, it, expect } from 'vitest';
import { normalizeTag, addTag, tagHueIndex, TAG_HUE_COUNT, TAG_MAX_LENGTH } from './tags';

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
