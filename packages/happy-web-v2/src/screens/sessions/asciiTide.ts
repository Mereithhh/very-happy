/**
 * B-700 — the empty main area's ASCII tide: a slow swell of density characters
 * with the Very Happy mark (the `>` + wink face) floating on it. Pure frame
 * builder; `AsciiTide.tsx` owns timing, sizing and pausing.
 *
 * Original work. The brief pointed at stackedlol/ascii-sharks for the general
 * idea of creatures drawn with density characters; that repository has no
 * license, so nothing of its code or artwork is used here.
 */

/** Calm → dense. The first entry is open air above the surface. */
export const TIDE_RAMP = [' ', '.', '·', ':', '-', '=', '+', '*'] as const;

// B-724 mark in plain text: the ^_^ face (the reverse-video block itself needs █, which leaves the grid).
const MARK_OPEN = ['.---------.', '|  ^   ^  |', '|   ___   |', "'---------'"];
/** Plain ASCII only: box-drawing glyphs fall back to another font and leave the grid. */
const MARK_WINK = ['.---------.', '|  ^   -  |', '|   ___   |', "'---------'"];
export const MARK_WIDTH = MARK_OPEN[0].length;
export const MARK_HEIGHT = MARK_OPEN.length;

/** One blink of ~0.25 s every ~4.5 s. */
export function isWinking(t: number): boolean {
  return t % 4.5 > 4.25;
}

/** Height of the water surface (rows from the top) at column `x`. */
export function surfaceAt(x: number, t: number, rows: number): number {
  const base = rows * 0.5;
  return base + 1.3 * Math.sin(x * 0.17 + t * 1.1) + 0.7 * Math.sin(x * 0.061 - t * 0.6);
}

/**
 * A `rows` × `cols` frame at time `t` (seconds). Deterministic. The mark is
 * centred and rides the swell; it is left out when the frame is too narrow
 * or short to hold it with a margin.
 */
export function tideFrame(cols: number, rows: number, t: number): string[] {
  const grid: string[][] = [];
  for (let y = 0; y < rows; y++) {
    const line: string[] = [];
    for (let x = 0; x < cols; x++) {
      const depth = y - surfaceAt(x, t, rows);
      if (depth < 0) { line.push(' '); continue; }
      if (depth < 0.8) { line.push('~'); continue; }
      // Deeper water is denser, with a slow shimmer so the body is not banded.
      const shimmer = 0.5 + 0.5 * Math.sin(x * 0.9 + y * 1.7 + t * 0.8);
      const level = Math.min(TIDE_RAMP.length - 1, 1 + Math.floor(depth * 0.7 + shimmer * 1.4));
      line.push(TIDE_RAMP[level]);
    }
    grid.push(line);
  }
  if (cols >= MARK_WIDTH + 4 && rows >= MARK_HEIGHT + 2) {
    const mark = isWinking(t) ? MARK_WINK : MARK_OPEN;
    const left = Math.floor((cols - MARK_WIDTH) / 2);
    const float = surfaceAt(left + MARK_WIDTH / 2, t, rows);
    const top = Math.max(0, Math.min(rows - MARK_HEIGHT, Math.round(float - MARK_HEIGHT + 1.5)));
    mark.forEach((row, dy) => {
      [...row].forEach((ch, dx) => { grid[top + dy][left + dx] = ch; });
    });
  }
  return grid.map((line) => line.join(''));
}
