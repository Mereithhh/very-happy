/** B-724: the logo geometry is the single source for the React mark, splash, static assets and the B-720 mask. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  MARK_PIXELS_16, MARK_PIXELS_32, insideMarkBlock, insideMarkFace, markMask, markPath, pixelPath,
} from './veryHappyMarkGeometry';
import { VeryHappyMark } from './VeryHappyMark';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('very happy mark geometry', () => {
  it('pixel maps are square and mirror-symmetric', () => {
    for (const rows of [MARK_PIXELS_16, MARK_PIXELS_32]) {
      expect(rows.every(r => r.length === rows.length)).toBe(true);
      expect(rows.every(r => [...r].reverse().join('') === r)).toBe(true);
    }
  });

  it('separates block, face and corners', () => {
    expect(insideMarkBlock(48, 48)).toBe(true);
    expect(insideMarkBlock(2.2, 2.2)).toBe(false); // rounded corner
    expect(insideMarkFace(28, 40)).toBe(false); // the notch under the left caret apex
    expect(insideMarkFace(28, 30)).toBe(true); // left caret
    expect(insideMarkFace(68, 30)).toBe(true); // right caret
    expect(insideMarkFace(48, 67)).toBe(true); // mouth
    expect(insideMarkFace(48, 55)).toBe(false);
  });

  it('markMask rasterises block, face and the knockout consistently (B-720)', () => {
    const m = markMask(24, 24);
    expect(m.block).toHaveLength(576);
    const at = (a: Float32Array, c: number, r: number) => a[r * 24 + c];
    expect(at(m.block, 12, 12)).toBe(1);
    expect(at(m.block, 0, 0)).toBeLessThan(1);
    // the mouth row/col at 96→24 scale: x 35–61 → cols 9–15, y 63.5–70.5 → rows 16–17
    expect(at(m.face, 12, 16)).toBeGreaterThan(0.5);
    expect(at(m.mark, 12, 16)).toBeLessThan(0.5);
    for (let i = 0; i < m.mark.length; i += 1) expect(m.mark[i]).toBeCloseTo(Math.max(0, m.block[i] - m.face[i]), 5);
  });

  it('React mark switches to the pixel map at 16 px', () => {
    expect(renderToStaticMarkup(createElement(VeryHappyMark, { size: 24 }))).toContain(`d="${markPath()}"`);
    const small = renderToStaticMarkup(createElement(VeryHappyMark, { size: 16 }));
    expect(small).toContain('viewBox="0 0 16 16"');
    expect(small).toContain(`d="${pixelPath(MARK_PIXELS_16)}"`);
  });

  it('splash and generated assets carry the current geometry (re-run scripts/brand/build-logo-assets.ts)', () => {
    expect(read('./startupArtwork.html')).toContain(`d="${markPath()}"`);
    expect(read('../../public/logo/very-happy-mark.svg')).toContain(`d="${markPath()}"`);
    expect(read('../../public/logo/very-happy-mark-16.svg')).toContain(`d="${pixelPath(MARK_PIXELS_16)}"`);
    expect(read('../../public/logo/very-happy-mark-32.svg')).toContain(`d="${pixelPath(MARK_PIXELS_32)}"`);
  });
});
