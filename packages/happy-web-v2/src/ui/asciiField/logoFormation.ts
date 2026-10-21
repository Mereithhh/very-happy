/**
 * B-720 × B-724 — draws the landing's "focus into form" moment over the hero
 * (see logoFormationModel.ts for the timeline). Loaded lazily after idle; the
 * static SVG mark is on screen from first paint and is the final frame, so this
 * is purely an enhancement: it ghosts the SVG, flies characters into the mark's
 * block, clears ^_^, hands back to the SVG within 2.5 s and removes itself.
 * One canvas, glyphs stamped from small pre-blurred atlases (no per-frame blur).
 */
import { markMask } from '@/ui/veryHappyMarkGeometry';
import { FIELD_RAMP } from './asciiFieldModel';
import { FORMATION_TOTAL, buildParticles, formationGrid, particleAt, svgOpacityAt, type FormationMask } from './logoFormationModel';

export interface LogoFormationOptions {
  /** Replaceable mask source; defaults to the B-724 geometry. */
  mask?: (cols: number, rows: number) => FormationMask;
  onDone?: () => void;
  now?: () => number;
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface LogoFormationController {
  stop(): void;
  done(): boolean;
}

const BLUR_PX = [0, 1.2, 2.6];
const COLS = 30;
/** Hand back to the static mark after this much wall time whatever happens. */
const WALL_CAP_MS = 6000;

export function startLogoFormation(mark: HTMLElement, stage: HTMLElement, opts: LogoFormationOptions = {}): LogoFormationController {
  const now = opts.now ?? (() => performance.now());
  const raf = opts.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const caf = opts.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  let finished = false;
  let frame: number | null = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const finish = () => {
    if (finished) return;
    finished = true;
    if (frame !== null) caf(frame);
    canvas.remove();
    mark.style.opacity = '';
    document.removeEventListener('visibilitychange', onHide);
    opts.onDone?.();
  };
  const onHide = () => { if (document.hidden) finish(); };
  const controller = { stop: finish, done: () => finished };
  if (!ctx) { finish(); return controller; }

  const stageBox = stage.getBoundingClientRect();
  const markBox = mark.getBoundingClientRect();
  const box = Math.min(markBox.width, markBox.height);
  if (!box || !stageBox.width) { finish(); return controller; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cellW = box / COLS;
  const { cols, rows } = formationGrid(box, cellW, cellW * 2);
  const cellH = box / rows;
  const mask = (opts.mask ?? ((c, r) => markMask(c, r, 3)))(cols, rows);
  // Particles start anywhere in the hero (in mark-box coordinates).
  const ox = markBox.left - stageBox.left;
  const oy = markBox.top - stageBox.top;
  const particles = buildParticles(mask, cellW, cellH, { x: -ox, y: -oy, w: stageBox.width, h: stageBox.height });

  canvas.className = 'ascii-formation';
  canvas.width = Math.round(stageBox.width * dpr);
  canvas.height = Math.round(stageBox.height * dpr);
  canvas.style.width = `${stageBox.width}px`;
  canvas.style.height = `${stageBox.height}px`;
  stage.appendChild(canvas);

  // Glyph atlases: ink colour, three focus levels.
  const ink = getComputedStyle(mark).color || getComputedStyle(stage).color;
  const family = getComputedStyle(stage).getPropertyValue('--font-mono').trim() || 'monospace';
  const fontPx = cellH * 0.95 * dpr;
  const pad = Math.ceil(BLUR_PX[2] * 2 * dpr) + 1;
  const gw = Math.ceil(cellW * dpr) + 2 * pad;
  const gh = Math.ceil(cellH * dpr) + 2 * pad;
  const atlas = new Map<string, HTMLCanvasElement>();
  for (let level = 0; level < BLUR_PX.length; level++) {
    for (const ch of FIELD_RAMP) {
      const g = document.createElement('canvas');
      g.width = gw;
      g.height = gh;
      const gc = g.getContext('2d');
      if (!gc) continue;
      gc.font = `${fontPx}px ${family}`;
      gc.textBaseline = 'middle';
      gc.textAlign = 'center';
      gc.fillStyle = ink;
      if (BLUR_PX[level] && 'filter' in gc) gc.filter = `blur(${BLUR_PX[level] * dpr}px)`;
      gc.fillText(ch, gw / 2, gh / 2);
      atlas.set(`${level}${ch}`, g);
    }
  }

  // Animation time advances with frames, at most 1/15 s per frame: if the page is
  // busy right after load the moment slows down instead of skipping to the end.
  // A wall-clock cap still hands back to the static mark on a stalled page.
  const wallStart = now();
  let last = wallStart;
  let t = 0;
  document.addEventListener('visibilitychange', onHide);
  const tick = () => {
    frame = null;
    if (finished) return;
    const at = now();
    t += Math.min(1 / 15, (at - last) / 1000);
    last = at;
    if (t >= FORMATION_TOTAL || at - wallStart > WALL_CAP_MS) { finish(); return; }
    mark.style.opacity = String(svgOpacityAt(t));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      const f = particleAt(p, t);
      if (!f) continue;
      const g = atlas.get(`${f.blur}${f.glyph}`);
      if (!g) continue;
      ctx.globalAlpha = f.alpha;
      ctx.drawImage(g, Math.round((ox + f.x) * dpr - gw / 2), Math.round((oy + f.y) * dpr - gh / 2));
    }
    ctx.globalAlpha = 1;
    frame = raf(tick);
  };
  mark.style.opacity = String(svgOpacityAt(0));
  frame = raf(tick);
  return controller;
}
