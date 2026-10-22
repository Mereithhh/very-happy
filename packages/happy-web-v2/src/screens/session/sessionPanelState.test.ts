import { describe, expect, it } from 'vitest';
import { isHistoryPanel, readSessionPanel, readSubagentTarget, toggleHistoryPanel, withSessionPanel, withSubagentPanel } from './sessionPanelState';

describe('session panel URL state (B-208)', () => {
  it('accepts the public panel names', () => {
    expect(readSessionPanel('changes')).toBe('changed');
    expect(readSessionPanel('files')).toBe('all');
    expect(readSessionPanel('browse')).toBe('browse');
    expect(readSessionPanel('btw')).toBe('btw');
    expect(readSessionPanel('agent')).toBe('subagent');
    expect(readSessionPanel('notes')).toBe('notes');
    expect(readSessionPanel('web')).toBe('web');
    expect(readSessionPanel('board')).toBe('board');
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
    expect(withSessionPanel(opened, 'notes').toString()).toBe('foo=1&panel=notes');
    expect(withSessionPanel(opened, 'web').toString()).toBe('foo=1&panel=web');
    expect(readSubagentTarget(new URLSearchParams('panel=agent'))).toBeNull();
  });
});

describe('preview / clipboard history panel (B-602)', () => {
  it('round-trips through ?panel= and clears a stale sub-agent target', () => {
    expect(readSessionPanel('previews')).toBe('previews');
    expect(readSessionPanel('clipboard')).toBe('clipboard');
    const opened = withSubagentPanel(new URLSearchParams('foo=1'), 'msg-7');
    expect(withSessionPanel(opened, 'previews').toString()).toBe('foo=1&panel=previews');
    expect(withSessionPanel(opened, 'clipboard').toString()).toBe('foo=1&panel=clipboard');
  });

  it('only the two history tabs count as history', () => {
    expect(isHistoryPanel('previews')).toBe(true);
    expect(isHistoryPanel('clipboard')).toBe(true);
    for (const tab of ['changed', 'all', 'browse', 'btw', 'subagent', 'notes', 'web', null] as const) {
      expect(isHistoryPanel(tab)).toBe(false);
    }
  });

  it('a dock chip toggles its own tab and switches from any other', () => {
    expect(toggleHistoryPanel(null, 'previews')).toBe('previews');
    expect(toggleHistoryPanel('previews', 'previews')).toBeNull();
    expect(toggleHistoryPanel('previews', 'clipboard')).toBe('clipboard');
    expect(toggleHistoryPanel('browse', 'clipboard')).toBe('clipboard');
  });
});
