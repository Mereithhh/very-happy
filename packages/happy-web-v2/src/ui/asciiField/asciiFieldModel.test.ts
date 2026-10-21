import { describe, expect, it } from 'vitest';
import {
  FIELD_RAMP, MAX_FPS, PRESETS, SPRITES, creaturePosition, fieldValue, frameDue, isWinking, layerRow, mirrorSprite, pickTier,
  rng, spawnCreature, specForTier, spriteLines, type AsciiFieldPreset,
} from './asciiFieldModel';
import { boxBlurAlpha, packInk, stampGlyph } from './asciiRaster';

const presets = Object.keys(PRESETS) as AsciiFieldPreset[];

describe('B-720 AsciiField presets — depth of field', () => {
  it('every preset has ≥ 3 layers: far is small, dim, blurred and slow; near is large, bright, sharp and fast', () => {
    for (const name of presets) {
      const { layers } = PRESETS[name];
      expect(layers.length, name).toBeGreaterThanOrEqual(3);
      const far = layers[0];
      const near = layers[layers.length - 1];
      expect(far.fontPx, name).toBeLessThan(near.fontPx);
      expect(far.alpha, name).toBeLessThan(near.alpha);
      expect(far.blurPx, name).toBeGreaterThan(0);
      expect(near.blurPx, name).toBe(0);
      expect(Math.abs(far.driftX), name).toBeLessThan(Math.abs(near.driftX));
      expect(far.mousePx, name).toBeLessThanOrEqual(near.mousePx);
    }
  });

  it('is ordered by strength: hero > empty > band > faint > sidebar (near-layer ink)', () => {
    const near = (p: AsciiFieldPreset) => PRESETS[p].layers[2].alpha;
    expect(near('hero')).toBeGreaterThan(near('empty'));
    expect(near('empty')).toBeGreaterThan(near('band'));
    expect(near('band')).toBeGreaterThan(near('faint'));
    expect(near('faint')).toBeGreaterThan(near('sidebar'));
    // The sidebar must stay far below text contrast.
    expect(near('sidebar')).toBeLessThanOrEqual(0.1);
  });

  it('never asks for more than 30 fps', () => {
    for (const name of presets) expect(PRESETS[name].fps).toBeLessThanOrEqual(MAX_FPS);
  });

  it('phones / low-end drop the blurred far layer, keep no live blur and no mouse/scroll parallax', () => {
    for (const name of presets) {
      const lite = specForTier(name, 'lite');
      expect(lite.layers.length).toBe(PRESETS[name].layers.length - 1);
      expect(lite.layers.every((l) => l.blurPx === 0 && l.mousePx === 0 && l.scroll === 0)).toBe(true);
      expect(lite.fps).toBeLessThanOrEqual(24);
      expect(specForTier(name, 'full')).toBe(PRESETS[name]);
    }
  });

  it('picks the lite tier for coarse pointers, narrow screens and ≤ 4 cores / ≤ 4 GB', () => {
    expect(pickTier({ coarsePointer: true, narrow: false })).toBe('lite');
    expect(pickTier({ coarsePointer: false, narrow: true })).toBe('lite');
    expect(pickTier({ coarsePointer: false, narrow: false, hardwareConcurrency: 4 })).toBe('lite');
    expect(pickTier({ coarsePointer: false, narrow: false, deviceMemory: 2 })).toBe('lite');
    expect(pickTier({ coarsePointer: false, narrow: false, hardwareConcurrency: 10, deviceMemory: 16 })).toBe('full');
    expect(pickTier({ coarsePointer: false, narrow: false })).toBe('full');
  });
});

describe('B-720 AsciiField field and frame gating', () => {
  it('rows are exactly `cols` wide, plain ASCII from the ramp, deterministic, and move over time', () => {
    const row = layerRow(-40, 12, 120, 3.5, 1, 0.3);
    expect(row).toHaveLength(120);
    expect([...row].every((c) => c === ' ' || (FIELD_RAMP as readonly string[]).includes(c))).toBe(true);
    expect(layerRow(-40, 12, 120, 3.5, 1, 0.3)).toBe(row);
    expect(layerRow(-40, 12, 120, 9, 1, 0.3)).not.toBe(row);
  });

  it('density controls how many cells carry a glyph', () => {
    const fill = (d: number) => {
      let n = 0;
      for (let y = 0; y < 40; y++) n += [...layerRow(0, y, 200, 2, 0, d)].filter((c) => c !== ' ').length;
      return n / (40 * 200);
    };
    expect(fill(0.1)).toBeLessThan(fill(0.45));
    expect(fill(0.1)).toBeGreaterThan(0);
    expect(fill(0.45)).toBeLessThan(0.75);
  });

  it('fieldValue stays in [0, 1]', () => {
    for (let i = 0; i < 500; i++) {
      const v = fieldValue(i * 3.1, i * 1.7, i * 0.13, i % 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('frameDue caps at 30 fps even if a preset asks for more', () => {
    expect(frameDue(1000, 1000 - 16.7, 30)).toBe(false);
    expect(frameDue(1000, 1000 - 33.4, 30)).toBe(true);
    expect(frameDue(1000, 1000 - 16.7, 60)).toBe(false);
    expect(frameDue(1000, 1000 - 39, 24)).toBe(false);
    expect(frameDue(1000, 1000 - 42, 24)).toBe(true);
  });
});

describe('B-720 AsciiField creatures', () => {
  it('mirroring flips direction glyphs and is an involution', () => {
    expect(mirrorSprite(['><(((*>'])).toEqual(['<*)))><']);
    for (const name of Object.keys(SPRITES) as (keyof typeof SPRITES)[]) {
      const lines = [...SPRITES[name]];
      const width = Math.max(...lines.map((l) => l.length));
      expect(mirrorSprite(mirrorSprite(lines)).map((l) => l.padEnd(width))).toEqual(lines.map((l) => l.padEnd(width)));
    }
  });

  it('the Very Happy mark winks briefly and never mirrors', () => {
    expect(spriteLines('mark', -1, 0).join('\n')).toContain('|  ^   ^  |');
    expect(isWinking(4.3)).toBe(true);
    expect(spriteLines('mark', 1, 4.3).join('\n')).toContain('|  ^   -  |');
    expect(isWinking(2)).toBe(false);
  });

  it('a creature enters fully off one edge, crosses, and is gone after its duration', () => {
    const c = { name: 'fish' as const, layer: 2, dir: 1 as const, yFrac: 0.5, duration: 10, born: 5 };
    expect(creaturePosition(c, 4.9, 800, 400, 60, 20)).toBeNull();
    expect(creaturePosition(c, 5, 800, 400, 60, 20)!.x).toBeLessThanOrEqual(-60);
    expect(creaturePosition(c, 15, 800, 400, 60, 20)!.x).toBeGreaterThanOrEqual(800);
    expect(creaturePosition(c, 15.1, 800, 400, 60, 20)).toBeNull();
    const back = creaturePosition({ ...c, dir: -1 }, 5, 800, 400, 60, 20)!;
    expect(back.x).toBeGreaterThanOrEqual(800);
  });

  it('spawns are reproducible from the seed and only include the mark when allowed', () => {
    const a = rng(7);
    const b = rng(7);
    expect(spawnCreature(a, 0, 3, false)).toEqual(spawnCreature(b, 0, 3, false));
    const r = rng(1);
    const names = new Set(Array.from({ length: 200 }, () => spawnCreature(r, 0, 3, false).name));
    expect(names.has('mark')).toBe(false);
    const r2 = rng(1);
    expect(new Set(Array.from({ length: 200 }, () => spawnCreature(r2, 0, 3, true).name)).has('mark')).toBe(true);
  });
});

describe('B-720 glyph raster', () => {
  it('stampGlyph keeps the max alpha, never touches RGB, and clips at the buffer edges', () => {
    const bw = 4;
    const bh = 3;
    const data = new Uint8ClampedArray(bw * bh * 4).fill(7);
    const g = { w: 2, h: 2, alpha: new Uint8Array([200, 3, 50, 255]) };
    stampGlyph(data, bw, bh, g, 3, 2); // only the top-left glyph pixel lands (3,2)
    expect(data[(2 * bw + 3) * 4 + 3]).toBe(200);
    expect(data[(2 * bw + 3) * 4]).toBe(7);
    stampGlyph(data, bw, bh, g, -1, -1); // only the bottom-right glyph pixel lands (0,0)
    expect(data[3]).toBe(255);
    const before = data[3];
    stampGlyph(data, bw, bh, { w: 1, h: 1, alpha: new Uint8Array([10]) }, 0, 0);
    expect(data[3]).toBe(before);
  });

  it('box blur spreads a point but keeps alpha in range and total roughly conserved', () => {
    const w = 9;
    const a = new Uint8Array(w * w);
    a[4 * w + 4] = 255;
    boxBlurAlpha(a, w, w, 1, 2);
    expect(a[4 * w + 4]).toBeLessThan(255);
    expect(a[4 * w + 5]).toBeGreaterThan(0);
    expect(Math.max(...a)).toBeLessThanOrEqual(255);
    const total = a.reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThan(200);
    expect(total).toBeLessThan(300);
  });

  it('packInk lays out [r, g, b, 0] bytes for a Uint32 fill', () => {
    const word = packInk(1, 2, 3);
    expect([...new Uint8Array(new Uint32Array([word]).buffer)]).toEqual([1, 2, 3, 0]);
  });
});
