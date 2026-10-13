import { describe, expect, it } from 'vitest';
import { columnChanges, columnSignature, flipDelta, isVisibleWithin } from './boardFlip';

describe('boardFlip (B-588)', () => {
  it('only keys that exist in both maps with a different column move', () => {
    const prev = { a: 'running', b: 'waiting', c: 'running' };
    const next = { a: 'waiting', b: 'waiting', d: 'running' };
    expect(columnChanges(prev, next)).toEqual(['a']);
  });

  it('a streaming update (same columns, new order) moves nothing and keeps the signature', () => {
    const prev = { a: 'running', b: 'running' };
    const next = { b: 'running', a: 'running' };
    expect(columnChanges(prev, next)).toEqual([]);
    expect(columnSignature(prev)).toBe(columnSignature(next));
  });

  it('signature changes when a card changes column', () => {
    expect(columnSignature({ a: 'running' })).not.toBe(columnSignature({ a: 'waiting' }));
  });

  it('delta inverts the new position back to the old one', () => {
    expect(flipDelta({ left: 10, top: 300, width: 200, height: 80 }, { left: 410, top: 120, width: 200, height: 80 }))
      .toEqual({ dx: -400, dy: 180 });
  });

  it('visibility needs half the height inside the clip box', () => {
    const clip = { left: 0, top: 100, width: 300, height: 400 };
    expect(isVisibleWithin({ left: 10, top: 120, width: 200, height: 80 }, clip)).toBe(true);
    expect(isVisibleWithin({ left: 10, top: 470, width: 200, height: 80 }, clip)).toBe(false); // 30/80 inside
    expect(isVisibleWithin({ left: 10, top: 600, width: 200, height: 80 }, clip)).toBe(false);
    expect(isVisibleWithin({ left: 400, top: 120, width: 200, height: 80 }, clip)).toBe(false);
    expect(isVisibleWithin({ left: 10, top: 120, width: 0, height: 0 }, clip)).toBe(false);
  });
});
