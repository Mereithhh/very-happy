// @vitest-environment happy-dom
/**
 * B-946: the phone list's offset survives the unmount that opening a session
 * causes (see listScrollMemory.ts). Only the parsing and the restore maths are
 * pure — the DOM wiring lives in Sidebar.tsx.
 */
import { describe, expect, it } from 'vitest';
import {
  getListScroll,
  parseListScroll,
  rememberListScroll,
  rememberOpenedRow,
  resetListScrollForTest,
  restoredScrollTop,
} from './listScrollMemory';

describe('parseListScroll', () => {
  it('accepts a real record and drops the row key when it is not a non-empty string', () => {
    expect(parseListScroll('{"top":420,"rowKey":"s:abc"}')).toEqual({ top: 420, rowKey: 's:abc' });
    expect(parseListScroll('{"top":420}')).toEqual({ top: 420, rowKey: null });
    expect(parseListScroll('{"top":1.6,"rowKey":""}')).toEqual({ top: 2, rowKey: null });
  });

  it('rejects absent / broken / wrong-shaped / impossible offsets', () => {
    for (const raw of [null, '', '{', '[]', '{"top":"120"}', '{"top":-1}', '{"top":null}', '{"top":1e12}', '{"rowKey":"x"}']) {
      expect(parseListScroll(raw)).toBeNull();
    }
  });
});

describe('rememberListScroll / rememberOpenedRow', () => {
  it('keeps the offset when only the opened row is recorded', () => {
    resetListScrollForTest();
    rememberListScroll({ top: 300, rowKey: null });
    rememberOpenedRow('s:abc');
    expect(getListScroll()).toEqual({ top: 300, rowKey: 's:abc' });
  });

  it('round-trips through sessionStorage', () => {
    resetListScrollForTest();
    rememberListScroll({ top: 512, rowKey: 's:abc' });
    resetListScrollForTest(); // fresh document / reload
    expect(getListScroll()).toEqual({ top: 512, rowKey: 's:abc' });
  });
});

describe('restoredScrollTop', () => {
  const containerHeight = 600;

  it('returns the remembered offset while the opened row is inside it', () => {
    expect(
      restoredScrollTop({ top: 400, containerHeight, contentRowTop: 450, rowHeight: 40 }),
    ).toBe(400);
  });

  it('without a row (gone from the list) it is just the offset', () => {
    expect(restoredScrollTop({ top: 400, containerHeight, contentRowTop: null })).toBe(400);
  });

  it('a row above the window brings its top into view with a margin', () => {
    expect(
      restoredScrollTop({ top: 400, containerHeight, contentRowTop: 380, rowHeight: 40 }),
    ).toBe(372);
  });

  it('a row below the window is put at the bottom edge', () => {
    expect(
      restoredScrollTop({ top: 100, containerHeight, contentRowTop: 800, rowHeight: 40 }),
    ).toBe(800 + 40 - 600 + 8);
  });

  it('never scrolls above the top', () => {
    expect(restoredScrollTop({ top: 0, containerHeight, contentRowTop: 3, rowHeight: 40 })).toBe(0);
    expect(restoredScrollTop({ top: -5, containerHeight, contentRowTop: null })).toBe(0);
  });
});
