import { describe, expect, it } from 'vitest';
import { readSessionPanel, readSubagentTarget, withSessionPanel, withSubagentPanel } from './sessionPanelState';

describe('session panel URL state (B-208)', () => {
  it('accepts only the three public panel names', () => {
    expect(readSessionPanel('changes')).toBe('changed');
    expect(readSessionPanel('files')).toBe('all');
    expect(readSessionPanel('browse')).toBe('browse');
    expect(readSessionPanel('btw')).toBe('btw');
    expect(readSessionPanel('agent')).toBe('subagent');
    expect(readSessionPanel('changed')).toBeNull();
    expect(readSessionPanel(null)).toBeNull();
  });

  it('updates only panel and preserves unrelated query state', () => {
    const start = new URLSearchParams('foo=1&panel=changes');
    expect(withSessionPanel(start, 'browse').toString()).toBe('foo=1&panel=browse');
    expect(withSessionPanel(start, null).toString()).toBe('foo=1');
    expect(withSessionPanel(start, 'btw').toString()).toBe('foo=1&panel=btw');
    expect(start.toString()).toBe('foo=1&panel=changes');
  });

  it('carries the sub-agent target and drops it when the drawer closes (B-317)', () => {
    const opened = withSubagentPanel(new URLSearchParams('foo=1'), 'msg-7');
    expect(opened.toString()).toBe('foo=1&panel=agent&sub=msg-7');
    expect(readSubagentTarget(opened)).toBe('msg-7');
    // A stale target would resurrect the wrong card the next time the drawer
    // opens, so every other tab clears it.
    expect(withSessionPanel(opened, null).toString()).toBe('foo=1');
    expect(withSessionPanel(opened, 'changed').toString()).toBe('foo=1&panel=changes');
    expect(readSubagentTarget(new URLSearchParams('panel=agent'))).toBeNull();
  });
});
