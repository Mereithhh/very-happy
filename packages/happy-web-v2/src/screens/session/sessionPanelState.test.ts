import { describe, expect, it } from 'vitest';
import { readSessionPanel, withSessionPanel } from './sessionPanelState';

describe('session panel URL state (B-208)', () => {
  it('accepts only the three public panel names', () => {
    expect(readSessionPanel('changes')).toBe('changed');
    expect(readSessionPanel('files')).toBe('all');
    expect(readSessionPanel('browse')).toBe('browse');
    expect(readSessionPanel('changed')).toBeNull();
    expect(readSessionPanel(null)).toBeNull();
  });

  it('updates only panel and preserves unrelated query state', () => {
    const start = new URLSearchParams('foo=1&panel=changes');
    expect(withSessionPanel(start, 'browse').toString()).toBe('foo=1&panel=browse');
    expect(withSessionPanel(start, null).toString()).toBe('foo=1');
    expect(start.toString()).toBe('foo=1&panel=changes');
  });
});
