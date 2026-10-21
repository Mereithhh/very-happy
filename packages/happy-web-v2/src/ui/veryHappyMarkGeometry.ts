/**
 * Very Happy logo geometry (B-724) — the single source for the "reverse-video ^_^ block":
 * a solid cursor block with the kaomoji ^_^ knocked out of it. The React mark, the
 * startup artwork, every generated icon (scripts/brand/build-logo-assets.ts) and the
 * B-720 landing mask all read from here. Pure data + pure functions, no DOM.
 *
 * Master grid is 96×96. 16/32 px versions are hand-placed pixel maps (no anti-aliased
 * diagonals) so tab favicons stay crisp. Rules: docs/design-language.md §Logo.
 */

export type Point = readonly [number, number];

export const MARK_GRID = 96;
/** The block: a 92-unit rounded square inset 2 units, corner radius 5. */
export const MARK_BLOCK = { x: 2, y: 2, size: 92, radius: 5 } as const;

/** Mitred caret ^ (8-unit stroke) centred on `cx`, apex at y≈26, feet on y=47. */
function caret(cx: number): Point[] {
  return [[cx - 14.92, 47], [cx, 26.12], [cx + 14.92, 47], [cx + 5.08, 47], [cx, 39.88], [cx - 5.08, 47]];
}

export const MARK_EYE_LEFT: readonly Point[] = caret(28);
export const MARK_EYE_RIGHT: readonly Point[] = caret(68);
/** The mouth _ as a rectangle [x0, y0, x1, y1]. */
export const MARK_MOUTH = [35, 63.5, 61, 70.5] as const;

/** 16 px pixel map: `#` = block, `.` = knocked out. */
export const MARK_PIXELS_16: readonly string[] = [
  '.##############.',
  '################',
  '################',
  '################',
  '################',
  '####.######.####',
  '###.#.####.#.###',
  '##.###.##.###.##',
  '################',
  '################',
  '################',
  '#####......#####',
  '################',
  '################',
  '################',
  '.##############.',
];

/** 32 px pixel map (2 px carets, stepped corners). */
export const MARK_PIXELS_32: readonly string[] = [
  '..############################..',
  '.##############################.',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '########..############..########',
  '#######....##########....#######',
  '######..##..########..##..######',
  '#####..####..######..####..#####',
  '####..######..####..######..####',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '###########..........###########',
  '###########..........###########',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '################################',
  '.##############################.',
  '..############################..',
];

const n = (v: number) => String(Math.round(v * 100) / 100);

function polygonPath(pts: readonly Point[]): string {
  return `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join('L')}Z`;
}

/** Block outline (rounded square) in the 96 grid. */
export function markBlockPath(): string {
  const { x, y, size, radius: r } = MARK_BLOCK;
  const x1 = x + size;
  const y1 = y + size;
  return `M${n(x + r)} ${n(y)}H${n(x1 - r)}A${r} ${r} 0 0 1 ${n(x1)} ${n(y + r)}V${n(y1 - r)}A${r} ${r} 0 0 1 ${n(x1 - r)} ${n(y1)}H${n(x + r)}A${r} ${r} 0 0 1 ${n(x)} ${n(y1 - r)}V${n(y + r)}A${r} ${r} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

/**
 * The face (^ _ ^) as filled shapes. `scale` shrinks it about the centre (48,48):
 * app tiles use 0.84 (full-bleed tile, inset for the iOS corner mask), maskable 0.72.
 */
export function markFacePath(scale = 1): string {
  const s = (p: Point): Point => [48 + (p[0] - 48) * scale, 48 + (p[1] - 48) * scale];
  const [mx0, my0, mx1, my1] = MARK_MOUTH;
  const mouth: Point[] = [[mx0, my0], [mx1, my0], [mx1, my1], [mx0, my1]];
  return [MARK_EYE_LEFT, MARK_EYE_RIGHT, mouth].map(shape => polygonPath(shape.map(s))).join('');
}

/** Knockout mark: block with the face removed. Render with `fill-rule="evenodd"`. */
export function markPath(): string {
  return markBlockPath() + markFacePath();
}

/** Pixel map → one path of 1-unit cells merged per run (render with `crispEdges`). */
export function pixelPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') { x += 1; continue; }
      const start = x;
      while (x < row.length && row[x] === '#') x += 1;
      d += `M${start} ${y}H${x}V${y + 1}H${start}Z`;
    }
  });
  return d;
}

function inPolygon(x: number, y: number, pts: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point (96-grid units) inside the rounded block. */
export function insideMarkBlock(x: number, y: number): boolean {
  const { x: bx, y: by, size, radius: r } = MARK_BLOCK;
  if (x < bx || y < by || x > bx + size || y > by + size) return false;
  const cx = Math.min(Math.max(x, bx + r), bx + size - r);
  const cy = Math.min(Math.max(y, by + r), by + size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Point (96-grid units) inside one of the knocked-out features (^, _, ^). */
export function insideMarkFace(x: number, y: number): boolean {
  const [mx0, my0, mx1, my1] = MARK_MOUTH;
  if (x >= mx0 && x <= mx1 && y >= my0 && y <= my1) return true;
  return inPolygon(x, y, MARK_EYE_LEFT) || inPolygon(x, y, MARK_EYE_RIGHT);
}

export interface MarkMask {
  cols: number;
  rows: number;
  /** Coverage 0–1 per cell, row-major: the solid block (B-720 gathers characters into this). */
  block: Float32Array;
  /** Coverage 0–1 per cell of the ^_^ cut-outs (cleared to reveal the face). */
  face: Float32Array;
  /** Final logo = block minus face. */
  mark: Float32Array;
}

/**
 * Rasterise the mark onto a `cols × rows` cell grid (B-720 landing: the AsciiField
 * gathers into the block, then knocks out ^_^). The 96-unit square is stretched to
 * the grid, so pick cols/rows that are square in pixels (e.g. rows ≈ cols × cellW / cellH).
 * `samples` is the per-axis supersampling used for anti-aliased coverage.
 */
export function markMask(cols: number, rows: number, samples = 4): MarkMask {
  const total = cols * rows;
  const block = new Float32Array(total);
  const face = new Float32Array(total);
  const mark = new Float32Array(total);
  const step = 1 / samples;
  const area = samples * samples;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let b = 0;
      let f = 0;
      let m = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((c + (sx + 0.5) * step) / cols) * MARK_GRID;
          const y = ((r + (sy + 0.5) * step) / rows) * MARK_GRID;
          const inBlock = insideMarkBlock(x, y);
          const inFace = insideMarkFace(x, y);
          if (inBlock) b += 1;
          if (inFace) f += 1;
          if (inBlock && !inFace) m += 1;
        }
      }
      const i = r * cols + c;
      block[i] = b / area;
      face[i] = f / area;
      mark[i] = m / area;
    }
  }
  return { cols, rows, block, face, mark };
}
