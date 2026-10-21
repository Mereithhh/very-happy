/**
 * B-720 — AsciiField: the shared depth-of-field ASCII backdrop (Landing hero,
 * empty workspace, docs/settings header bands, sidebar). Pure model: presets,
 * the character field, sprites and frame gating. `asciiFieldEngine.ts` owns the
 * canvas, timing and pausing; `AsciiField.tsx` owns lazy loading and the
 * device switch.
 *
 * Original work. The brief pointed at stackedlol/ascii-sharks for the general
 * idea (creatures drawn in characters drifting over a field); that repository
 * has no license, so nothing of its code or artwork is used here.
 */

export type AsciiFieldPreset = 'hero' | 'empty' | 'band' | 'faint' | 'sidebar' | 'divider';
export type AsciiFieldTier = 'full' | 'lite';

export interface AsciiLayerSpec {
  /** 0 = farthest. Far layers are small, dim, blurred and slow. */
  depth: number;
  fontPx: number;
  /** Ink alpha (0..1) multiplied onto the theme's ink colour. */
  alpha: number;
  /** Pre-rendered blur radius in CSS px (applied once per layer refresh, never per frame). */
  blurPx: number;
  /** Drift in cells per second. */
  driftX: number;
  driftY: number;
  /** Fraction of cells that carry a glyph (0..1). */
  density: number;
  /** Mouse parallax: max shift in CSS px at the pointer's extreme. */
  mousePx: number;
  /** Scroll parallax: layer shift per px the host moves in the viewport. */
  scroll: number;
}

export interface AsciiFieldSpec {
  layers: AsciiLayerSpec[];
  /** Creatures (fish, shark, the Very Happy mark) swimming through mid/near layers. */
  creatures: boolean;
  /** Seconds between creature spawns (min, max). */
  creatureEvery: [number, number];
  creatureAlpha: number;
  fps: number;
}

/** Calm → dense. Plain ASCII so every glyph comes from the mono font (no fallback). */
export const FIELD_RAMP = ['.', ':', '-', '=', '+', '*', '#'] as const;

export const MAX_FPS = 30;

const L = (depth: number, fontPx: number, alpha: number, blurPx: number, driftX: number, driftY: number, density: number, mousePx: number, scroll: number): AsciiLayerSpec =>
  ({ depth, fontPx, alpha, blurPx, driftX, driftY, density, mousePx, scroll });

/**
 * Strength, strongest first: hero > empty > divider > band > faint > sidebar.
 * Alphas are tuned against --text on --bg-0 so the copy on top keeps WCAG AA
 * (measured from pixels, see the PR); CSS masks fade the field under copy.
 */
export const PRESETS: Record<AsciiFieldPreset, AsciiFieldSpec> = {
  hero: {
    layers: [
      L(0, 11, 0.4, 1.8, -0.9, 0.12, 0.6, 8, 0.05),
      L(1, 14, 0.5, 0.7, -1.6, 0.2, 0.42, 18, 0.14),
      L(2, 19, 0.7, 0, -2.6, 0.28, 0.22, 34, 0.28),
    ],
    creatures: true, creatureEvery: [3, 7], creatureAlpha: 0.9, fps: 30,
  },
  empty: {
    layers: [
      L(0, 11, 0.28, 1.6, -0.7, 0.1, 0.5, 6, 0),
      L(1, 14, 0.32, 0.6, -1.3, 0.16, 0.32, 14, 0),
      L(2, 18, 0.42, 0, -2.1, 0.22, 0.12, 24, 0),
    ],
    creatures: true, creatureEvery: [5, 10], creatureAlpha: 0.7, fps: 30,
  },
  divider: {
    layers: [
      L(0, 10, 0.14, 1.4, -0.8, 0, 0.42, 0, 0.04),
      L(1, 13, 0.2, 0.5, -1.4, 0, 0.24, 0, 0.1),
      L(2, 16, 0.28, 0, -2.2, 0, 0.08, 0, 0.18),
    ],
    creatures: true, creatureEvery: [6, 12], creatureAlpha: 0.38, fps: 24,
  },
  band: {
    layers: [
      L(0, 10, 0.12, 1.4, -0.6, 0.06, 0.42, 4, 0),
      L(1, 13, 0.17, 0.5, -1.1, 0.1, 0.24, 9, 0),
      L(2, 16, 0.22, 0, -1.8, 0.12, 0.08, 16, 0),
    ],
    creatures: true, creatureEvery: [8, 16], creatureAlpha: 0.3, fps: 24,
  },
  faint: {
    layers: [
      L(0, 10, 0.08, 1.2, -0.5, 0.05, 0.4, 3, 0),
      L(1, 12, 0.11, 0.5, -0.9, 0.08, 0.22, 6, 0),
      L(2, 15, 0.14, 0, -1.4, 0.1, 0.07, 10, 0),
    ],
    creatures: false, creatureEvery: [0, 0], creatureAlpha: 0, fps: 20,
  },
  sidebar: {
    layers: [
      L(0, 9, 0.06, 1, -0.3, 0.04, 0.38, 0, 0),
      L(1, 11, 0.08, 0.4, -0.6, 0.06, 0.2, 0, 0),
      L(2, 13, 0.1, 0, -0.9, 0.08, 0.06, 0, 0),
    ],
    creatures: false, creatureEvery: [0, 0], creatureAlpha: 0, fps: 15,
  },
};

/**
 * Phones / low-end: drop the farthest (blurred) layer, no live blur, no mouse
 * parallax, lower frame rate. Keeps the two sharpest planes so depth still reads.
 */
export function specForTier(preset: AsciiFieldPreset, tier: AsciiFieldTier): AsciiFieldSpec {
  const spec = PRESETS[preset];
  if (tier === 'full') return spec;
  return {
    ...spec,
    layers: spec.layers.slice(1).map((layer) => ({ ...layer, blurPx: 0, mousePx: 0 })),
    fps: Math.min(spec.fps, 24),
  };
}

export interface TierSignals {
  coarsePointer: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  narrow: boolean;
}

export function pickTier(s: TierSignals): AsciiFieldTier {
  if (s.coarsePointer || s.narrow) return 'lite';
  if (s.hardwareConcurrency !== undefined && s.hardwareConcurrency > 0 && s.hardwareConcurrency <= 4) return 'lite';
  if (s.deviceMemory !== undefined && s.deviceMemory > 0 && s.deviceMemory <= 4) return 'lite';
  return 'full';
}

/** Stable per-cell noise in [0, 1). */
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Field value in [0, 1] at world cell (x, y), time t. Slow currents: a warped
 * travelling wave plus a broad swell, so glyphs gather in drifting ribbons
 * instead of uniform static.
 */
export function fieldValue(x: number, y: number, t: number, depth: number): number {
  const k = 1 + depth * 0.35;
  const warp = Math.sin(y * 0.11 * k + t * 0.35 + depth) * 2.2;
  const ribbon = Math.sin(x * 0.07 * k + warp + t * 0.45);
  const swell = Math.sin(x * 0.023 - y * 0.051 + t * 0.18 + depth * 2.1);
  const v = 0.5 + 0.32 * ribbon + 0.18 * swell;
  return Math.max(0, Math.min(1, v));
}

/**
 * One layer row starting at world cell (x0, y). `density` is the fraction of
 * cells that carry a glyph; denser parts of the field get denser characters.
 */
export function layerRow(x0: number, y: number, cols: number, t: number, depth: number, density: number): string {
  let out = '';
  const threshold = 1 - density;
  for (let i = 0; i < cols; i++) {
    const x = x0 + i;
    const v = fieldValue(x, y, t, depth) * 0.78 + hash2(x, y) * 0.22;
    if (v < threshold) { out += ' '; continue; }
    const level = Math.min(FIELD_RAMP.length - 1, Math.floor(((v - threshold) / Math.max(0.0001, density)) * FIELD_RAMP.length));
    out += FIELD_RAMP[level];
  }
  return out;
}

/** True when enough time passed for the next frame under the fps cap (1 ms jitter allowance). */
export function frameDue(now: number, last: number, fps: number): boolean {
  return now - last >= 1000 / Math.min(fps, MAX_FPS) - 1;
}

// ── Creatures ───────────────────────────────────────────────────────────────

/** Very Happy mark (B-724 ^_^) in plain text; the wink variant blinks. */
const MARK_OPEN = ['.---------.', '|  ^   ^  |', '|   ___   |', "'---------'"];
const MARK_WINK = ['.---------.', '|  ^   -  |', '|   ___   |', "'---------'"];

/** Sprites face right; `mirrorSprite` makes the left-swimming version. */
export const SPRITES = {
  fish: ['><(((*>'],
  school: ['><>    ><>', '   ><>    ><>', '><>   ><>'],
  shark: [
    '          __',
    '      ___/ /____',
    '>====(_  o      >',
    '      `--.___.-\'',
  ],
  jelly: [' .-. ', '(   )', ' |:| ', ' : : '],
  mark: MARK_OPEN,
} as const;
export type SpriteName = keyof typeof SPRITES;

const MIRROR: Record<string, string> = { '<': '>', '>': '<', '(': ')', ')': '(', '/': '\\', '\\': '/', '[': ']', ']': '[', '{': '}', '}': '{', '`': '\'', '\'': '`' };

export function mirrorSprite(lines: readonly string[]): string[] {
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => [...l.padEnd(width)].reverse().map((c) => MIRROR[c] ?? c).join('').replace(/\s+$/, ''));
}

/** One blink of ~0.25 s every ~4.5 s. */
export function isWinking(t: number): boolean {
  return t % 4.5 > 4.25;
}

export function spriteLines(name: SpriteName, dir: 1 | -1, age: number): string[] {
  const base: readonly string[] = name === 'mark' && isWinking(age) ? MARK_WINK : SPRITES[name];
  // The mark and the jelly are symmetric-ish and should read the same way round.
  if (dir === 1 || name === 'mark' || name === 'jelly') return [...base];
  return mirrorSprite(base);
}

export interface Creature {
  name: SpriteName;
  /** Layer index the creature swims in (scaled with that layer). */
  layer: number;
  dir: 1 | -1;
  /** 0..1 vertical position of the sprite's top within the host. */
  yFrac: number;
  /** Seconds to cross the host. */
  duration: number;
  born: number;
}

/** Deterministic PRNG (mulberry32) so tests and static frames are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function spawnCreature(rand: () => number, born: number, layerCount: number, allowMark: boolean): Creature {
  const pool: SpriteName[] = allowMark ? ['fish', 'school', 'shark', 'jelly', 'mark', 'fish'] : ['fish', 'school', 'shark', 'jelly', 'fish'];
  const name = pool[Math.floor(rand() * pool.length)];
  const layer = Math.max(0, layerCount - 1 - (rand() < 0.4 ? 1 : 0));
  const dir: 1 | -1 = name === 'jelly' ? -1 : rand() < 0.5 ? 1 : -1;
  return { name, layer, dir, yFrac: 0.12 + rand() * 0.62, duration: name === 'jelly' ? 26 + rand() * 10 : 12 + rand() * 9, born };
}

/**
 * Sprite top-left in CSS px at time `t`, or null once it has crossed. It enters
 * fully off one edge and leaves fully off the other; jellies rise slowly.
 */
export function creaturePosition(c: Creature, t: number, width: number, height: number, spriteW: number, spriteH: number): { x: number; y: number } | null {
  const p = (t - c.born) / c.duration;
  if (p < 0 || p > 1) return null;
  const span = width + spriteW;
  const x = c.dir === 1 ? -spriteW + p * span : width - p * span;
  const bob = Math.sin((t - c.born) * 1.3) * spriteH * 0.12;
  const rise = c.name === 'jelly' ? -p * height * 0.25 : 0;
  return { x, y: c.yFrac * (height - spriteH) + bob + rise };
}
