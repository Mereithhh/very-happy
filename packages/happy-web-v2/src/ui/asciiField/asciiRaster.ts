/**
 * B-720 — CPU glyph raster for AsciiField. Text is rasterised once per layer
 * into a tiny alpha atlas (one bitmap per ramp character, blur baked in), and a
 * layer re-render is then plain typed-array copies into a one-row RGBA buffer,
 * uploaded with putImageData and drawn onto the layer. That keeps the per-frame
 * cost proportional to the rows we choose to draw, with no fillText / ctx.filter
 * raster landing on the main thread later (software canvas paints there).
 * Pure functions; `asciiFieldEngine.ts` owns canvases and timing.
 */

export interface GlyphBitmap {
  w: number;
  h: number;
  /** Row-major alpha, 0..255. */
  alpha: Uint8Array;
}

/** Separable box blur of an alpha bitmap, `passes` times (3 ≈ gaussian). In place. */
export function boxBlurAlpha(alpha: Uint8Array, w: number, h: number, radius: number, passes = 2): void {
  if (radius < 1) return;
  const r = Math.round(radius);
  const tmp = new Float32Array(w * h);
  const src = new Float32Array(alpha);
  const win = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) sum += src[y * w + xx]; }
        tmp[y * w + x] = sum / win;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) sum += tmp[yy * w + x]; }
        src[y * w + x] = sum / win;
      }
    }
  }
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(255, Math.round(src[i]));
}

/**
 * Stamp a glyph's alpha into an RGBA buffer at (x0, y0), keeping the max alpha
 * where glyph halos overlap. RGB is pre-filled with the ink colour, so only the
 * alpha byte changes. Clipped to the buffer.
 */
export function stampGlyph(data: Uint8ClampedArray, bw: number, bh: number, g: GlyphBitmap, x0: number, y0: number): void {
  const xs = Math.max(0, -x0);
  const xe = Math.min(g.w, bw - x0);
  const ys = Math.max(0, -y0);
  const ye = Math.min(g.h, bh - y0);
  for (let gy = ys; gy < ye; gy++) {
    const src = gy * g.w;
    let dst = ((y0 + gy) * bw + x0 + xs) * 4 + 3;
    for (let gx = xs; gx < xe; gx++, dst += 4) {
      const a = g.alpha[src + gx];
      if (a > data[dst]) data[dst] = a;
    }
  }
}

/** RGBA bytes [r, g, b, 0] as the platform's Uint32 so a buffer can be reset with one fill(). */
export function packInk(r: number, g: number, b: number): number {
  return new Uint32Array(new Uint8Array([r, g, b, 0]).buffer)[0];
}
