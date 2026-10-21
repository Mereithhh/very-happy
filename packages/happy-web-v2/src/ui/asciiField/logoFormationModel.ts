/**
 * B-720 × B-724 — the landing's "focus into form" moment: characters scattered
 * through the hero's depth field (small, dim, blurred) fly in, gather into the
 * solid block of the Very Happy mark, then the ^_^ cells clear and the static
 * SVG mark takes over. Pure timeline + particle maths; `logoFormation.ts` draws.
 *
 * Timeline (seconds, all ≤ FORMATION_TOTAL = 2.5):
 *   0 – GATHER_END   particles converge into the block (staggered starts);
 *                    near particles fly in large and shrink onto their cell
 *   GATHER_END ± FLASH   one brightness peak as the block completes
 *   FACE_START – FACE_END   ^_^ cells pop out (block − face = the mark), the mark bumps
 *   HANDOFF_START – TOTAL   the SVG fades back in, characters fade away
 */
import { FIELD_RAMP, rng } from './asciiFieldModel';

export const FORMATION_TOTAL = 2.5;
export const GATHER_END = 1.4;
export const FLASH = 0.22;
export const FACE_START = 1.55;
export const FACE_END = 1.85;
export const HANDOFF_START = 1.8;

/** Coverage grids as produced by `markMask` (ui/veryHappyMarkGeometry.ts) — replaceable source. */
export interface FormationMask {
  cols: number;
  rows: number;
  block: Float32Array;
  face: Float32Array;
}

export interface Particle {
  /** Target cell centre, in mark-box px. */
  tx: number;
  ty: number;
  /** Start position in mark-box px (may lie far outside the box). */
  sx: number;
  sy: number;
  /** 0 = far (blurred, dim), 1 = near. */
  depth: number;
  delay: number;
  duration: number;
  /** Cleared in the face phase (part of ^_^). */
  face: boolean;
  /** Settled glyph (denser for full coverage). */
  glyph: string;
  seed: number;
}

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * One particle per block cell (coverage ≥ 0.35). Starts are spread over
 * `spread` (a rect in mark-box px, usually the hero) and finish by GATHER_END.
 */
export function buildParticles(mask: FormationMask, cellW: number, cellH: number, spread: { x: number; y: number; w: number; h: number }, seed = 724): Particle[] {
  const rand = rng(seed);
  const out: Particle[] = [];
  for (let r = 0; r < mask.rows; r++) {
    for (let c = 0; c < mask.cols; c++) {
      const i = r * mask.cols + c;
      const cover = mask.block[i];
      if (cover < 0.35) continue;
      const delay = rand() * 0.35;
      const duration = Math.min(GATHER_END - delay, 0.8 + rand() * 0.25);
      out.push({
        tx: (c + 0.5) * cellW,
        ty: (r + 0.5) * cellH,
        sx: spread.x + rand() * spread.w,
        sy: spread.y + rand() * spread.h,
        depth: rand(),
        delay,
        duration,
        face: mask.face[i] >= 0.5,
        glyph: cover > 0.85 ? '#' : cover > 0.6 ? '*' : '+',
        seed: Math.floor(rand() * 1e6),
      });
    }
  }
  return out;
}

export interface ParticleFrame {
  x: number;
  y: number;
  alpha: number;
  /** 0 = sharp … 2 = most blurred (index into the blur atlases). */
  blur: 0 | 1 | 2;
  /** Drawn size relative to the cell: near particles fly in large and shrink onto it. */
  scale: number;
  glyph: string;
}

/** Where a particle is at time t (seconds), or null when it is not drawn. */
export function particleAt(p: Particle, t: number): ParticleFrame | null {
  if (t >= FORMATION_TOTAL) return null;
  const k = clamp01((t - p.delay) / p.duration);
  const e = easeOutCubic(k);
  // A slight arc: particles swing in rather than slide on a straight line.
  const arc = Math.sin(e * Math.PI) * 18 * (p.depth - 0.5);
  const x = p.sx + (p.tx - p.sx) * e + arc;
  const y = p.sy + (p.ty - p.sy) * e - arc * 0.6;
  // Focus pull: far particles start blurred and dim, everything is sharp on arrival.
  const focus = Math.max(e, p.depth * 0.6);
  const blur: 0 | 1 | 2 = focus > 0.85 ? 0 : focus > 0.45 ? 1 : 2;
  let alpha = k >= 1 ? 1 : 0.35 + 0.6 * e + 0.15 * p.depth;
  let scale = 1 + (1 - e) * p.depth * 1.8;
  if (p.face) {
    // The ^_^ cells pop: a quick swell, then gone.
    const f = clamp01((t - FACE_START) / (FACE_END - FACE_START));
    alpha *= 1 - f;
    scale *= 1 + 0.9 * f;
  }
  alpha *= 1 - clamp01((t - HANDOFF_START) / (FORMATION_TOTAL - HANDOFF_START));
  if (alpha <= 0.01) return null;
  // In flight the glyph scrambles through the ramp; it settles on arrival.
  const glyph = k >= 1 ? p.glyph : FIELD_RAMP[(p.seed + Math.floor(t * 14)) % FIELD_RAMP.length];
  return { x, y, alpha: Math.min(1, alpha), blur, scale, glyph };
}

/** Brightness peak (0..1) as the block completes: a short bell around GATHER_END. */
export function flashAt(t: number): number {
  const d = (t - GATHER_END) / FLASH;
  return Math.abs(d) >= 1 ? 0 : 0.5 + 0.5 * Math.cos(d * Math.PI);
}

/** Scale bump of the mark when ^_^ is knocked out (1 = rest). */
export function markBumpAt(t: number): number {
  const d = (t - (FACE_START + FACE_END) / 2) / 0.3;
  return Math.abs(d) >= 1 ? 1 : 1 + 0.07 * (0.5 + 0.5 * Math.cos(d * Math.PI));
}

/** Opacity of the static SVG mark during the formation (ghost while forming, then full). */
export function svgOpacityAt(t: number): number {
  if (t >= FORMATION_TOTAL) return 1;
  const ghost = 0.1;
  if (t < HANDOFF_START) return ghost;
  return ghost + (1 - ghost) * clamp01((t - HANDOFF_START) / (FORMATION_TOTAL - HANDOFF_START));
}

/** Grid for the mark box: square in pixels (the 96 grid is stretched to cols × rows). */
export function formationGrid(boxPx: number, cellW: number, cellH: number): { cols: number; rows: number } {
  const cols = Math.max(8, Math.round(boxPx / cellW));
  const rows = Math.max(4, Math.round((cols * cellW) / cellH));
  return { cols, rows };
}
