import { describe, expect, it } from 'vitest';
import { MARK_HEIGHT, MARK_WIDTH, TIDE_RAMP, isWinking, tideFrame } from './asciiTide';

describe('B-700 ASCII tide frames', () => {
  it('is exactly rows × cols at any size (never wider than measured — no phone overflow)', () => {
    for (const [cols, rows] of [[20, 6], [48, 10], [72, 10], [5, 2]]) {
      const frame = tideFrame(cols, rows, 3.2);
      expect(frame).toHaveLength(rows);
      for (const line of frame) expect([...line]).toHaveLength(cols);
    }
  });
  it('is deterministic for a given time and moves over time', () => {
    expect(tideFrame(48, 10, 1)).toEqual(tideFrame(48, 10, 1));
    expect(tideFrame(48, 10, 1)).not.toEqual(tideFrame(48, 10, 1.5));
  });
  it('carries the Very Happy mark centred when there is room, and winks briefly', () => {
    const open = tideFrame(48, 10, 0).join('\n');
    expect(open).toContain('|  ^   ^  |');
    expect(open).toContain('|   ___   |');
    expect(isWinking(4.3)).toBe(true);
    expect(isWinking(2)).toBe(false);
    expect(tideFrame(48, 10, 4.3).join('\n')).toContain('|  ^   -  |');
    const row = tideFrame(48, 10, 0).find((l) => l.includes('.---------.'))!;
    expect(row.indexOf('.---------.')).toBe(Math.floor((48 - MARK_WIDTH) / 2));
  });
  it('drops the mark when the frame is too small to hold it', () => {
    expect(tideFrame(MARK_WIDTH + 3, 10, 0).join('')).not.toContain('.---------.');
    expect(tideFrame(48, MARK_HEIGHT + 1, 0).join('')).not.toContain('.---------.');
  });
  it('uses only the ramp, the surface foam and the mark', () => {
    const allowed = new Set([...TIDE_RAMP, '~', ...".-|^_' "]);
    for (const ch of tideFrame(72, 10, 2.7).join('')) expect(allowed.has(ch)).toBe(true);
  });
});
