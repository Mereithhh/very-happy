/**
 * B-720 — AsciiField engine. Loaded lazily by `AsciiField.tsx` once the page is
 * idle, so it never sits on the first-paint path.
 *
 * Cost model (the main thread must stay < 2 ms per frame, also on software
 * canvas): nothing is composited on the main thread.
 *  - Each depth layer is a pair of DOM canvases (front / back). Drift and
 *    parallax move them with a CSS transform, which the compositor applies.
 *  - The slow current re-renders a layer into its hidden back canvas a few rows
 *    per frame under a time budget shared by every field on the page, then the
 *    back canvas cross-fades in (CSS opacity transition) and the pair swaps.
 *  - Rows are stamped from a per-layer glyph atlas (asciiRaster.ts) into a CPU
 *    buffer and uploaded in strips: no fillText / ctx.filter raster per frame.
 *    Far layers use a lower resolution and a blur baked into their atlas.
 *  - Creatures are small `<pre>` elements moved by transform.
 * Timing rules: ≤ preset fps (cap 30) via rAF + `frameDue`; paused while the tab
 * is hidden or the host is off-screen (IntersectionObserver); under
 * prefers-reduced-motion a single still is drawn and no loop runs.
 * Everything browser-shaped comes through `AsciiFieldEnv` so tests can drive it.
 */
import { boxBlurAlpha, packInk, stampGlyph, type GlyphBitmap } from './asciiRaster';
import {
  FIELD_RAMP, creaturePosition, frameDue, layerRow, pickTier, rng, spawnCreature, specForTier, spriteLines,
  type AsciiFieldPreset, type AsciiFieldSpec, type AsciiFieldTier, type AsciiLayerSpec, type Creature, type TierSignals,
} from './asciiFieldModel';

type MQL = { matches: boolean; addEventListener?: (t: 'change', fn: () => void) => void; removeEventListener?: (t: 'change', fn: () => void) => void };
type Ctx = CanvasRenderingContext2D;

export interface AsciiFieldEnv {
  now(): number;
  requestFrame(cb: (time: number) => void): number;
  cancelFrame(id: number): void;
  matchMedia(query: string): MQL | null;
  doc: { hidden: boolean; addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void; documentElement: Element; createElement(tag: string): HTMLElement };
  win: { devicePixelRatio?: number; innerWidth: number; innerHeight: number; addEventListener(t: string, fn: (e: Event) => void, o?: AddEventListenerOptions): void; removeEventListener(t: string, fn: (e: Event) => void, o?: boolean | EventListenerOptions): void };
  getContext(canvas: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): Ctx | null;
  cssVar(el: Element, name: string): string;
  IntersectionObserver?: typeof IntersectionObserver;
  ResizeObserver?: typeof ResizeObserver;
  MutationObserver?: typeof MutationObserver;
  tierSignals(): TierSignals;
}

export function browserEnv(): AsciiFieldEnv {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    now: () => performance.now(),
    requestFrame: (cb) => window.requestAnimationFrame(cb),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    matchMedia: (q) => window.matchMedia?.(q) ?? null,
    doc: document,
    win: window,
    getContext: (c, opts) => c.getContext('2d', opts),
    cssVar: (el, name) => getComputedStyle(el).getPropertyValue(name).trim(),
    IntersectionObserver: window.IntersectionObserver,
    ResizeObserver: window.ResizeObserver,
    MutationObserver: window.MutationObserver,
    tierSignals: () => ({
      coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
      narrow: window.innerWidth < 700,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
    }),
  };
}

export interface AsciiFieldStats {
  frames: number;
  /** Main-thread ms spent in the engine: last / EMA / worst frame (the first frame of a resize/theme rebuild excluded from worst). */
  lastMs: number;
  avgMs: number;
  maxMs: number;
  /** Completed layer re-renders (cross-fades). */
  layerRefreshes: number;
  /** Rows drawn in total (static + incremental). */
  rows: number;
  /** Layer rebuilds caused by a size change. */
  resizes: number;
}

export interface AsciiFieldController {
  readonly tier: AsciiFieldTier;
  readonly layers: number;
  readonly stats: AsciiFieldStats;
  /** True while the rAF loop is scheduled. */
  running(): boolean;
  reducedMotion(): boolean;
  stop(): void;
}

export interface AsciiFieldOptions {
  preset: AsciiFieldPreset;
  /** Let the Very Happy mark swim by (empty workspace / landing). */
  mark?: boolean;
  seed?: number;
  /** Called once when the first layer is on screen. */
  onFirstFrame?: () => void;
  /** Override tier detection (tests, probes). */
  tier?: AsciiFieldTier;
  /** Main-thread ms per frame shared by all fields for incremental re-rendering. */
  budgetMs?: number;
}

interface Plane {
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  /** World cell drawn at the canvas origin. */
  ix: number;
  iy: number;
  ready: boolean;
}

interface Job {
  plane: Plane;
  t: number;
  row: number;
  /** Pixel rows of the plane already cleared for this render. */
  clearedTo: number;
}

interface Layer {
  spec: AsciiLayerSpec;
  /** Backing-store px per CSS px (dpr × the layer's resolution factor). */
  scale: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  /** Spare cells around the viewport (x / y) so drift and parallax never show an edge. */
  pad: number;
  padY: number;
  planes: [Plane, Plane];
  front: 0 | 1;
  /** One alpha bitmap per ramp character at this layer's size, blur baked in. */
  glyphs: Map<string, GlyphBitmap>;
  /** Glyph halo in backing px (room for the baked blur). */
  halo: number;
  /** One glyph row: CPU buffer (RGB = ink, alpha = glyphs) → small canvas → drawImage onto the plane. */
  strip: { canvas: HTMLCanvasElement; ctx: Ctx; image: ImageData; words: Uint32Array } | null;
  /** Max scroll-parallax shift (CSS px) the vertical padding can absorb. */
  scrollRoom: number;
  job: Job | null;
  /** Animation time of the next scheduled re-render. */
  nextAt: number;
  /** Seconds between re-renders (far layers change slower). */
  every: number;
}

/** Backing resolution cap: a background does not need full retina, and memory scales with its square. */
const DPR_CAP: Record<AsciiFieldTier, number> = { full: 1.25, lite: 1.25 };
/** Far layers are drawn at lower resolution: cheaper, and the upscale softens them further. */
const RES_BY_DEPTH = [0.5, 0.75, 1];
/** Seconds of animation time for the reduced-motion still (a creature mid-crossing). */
export const STATIC_T = 7.5;
const FADE_MS = 900;
/** Main-thread ms per animation frame that ALL visible fields share for re-rendering. */
export const FRAME_BUDGET_MS = 1;

// Every field's rAF callback in one frame receives the same timestamp; the
// first one to run refills the shared allowance, so N fields on a page cost
// one budget, not N.
let budgetFrame = -1;
let budgetLeft = 0;
export function takeFrameBudget(frameTs: number, total: number): number {
  if (frameTs !== budgetFrame) { budgetFrame = frameTs; budgetLeft = total; }
  return budgetLeft;
}
export function spendFrameBudget(ms: number): void {
  budgetLeft = Math.max(0, budgetLeft - ms);
}

export function startAsciiField(host: HTMLElement, options: AsciiFieldOptions, env: AsciiFieldEnv = browserEnv()): AsciiFieldController {
  const tier = options.tier ?? pickTier(env.tierSignals());
  const spec: AsciiFieldSpec = specForTier(options.preset, tier);
  const stats: AsciiFieldStats = { frames: 0, lastMs: 0, avgMs: 0, maxMs: 0, layerRefreshes: 0, rows: 0, resizes: 0 };
  const budgetMs = options.budgetMs ?? FRAME_BUDGET_MS;
  const reducedQuery = env.matchMedia('(prefers-reduced-motion: reduce)');
  const schemeQuery = env.matchMedia('(prefers-color-scheme: dark)');
  let reduced = reducedQuery?.matches === true;
  let raf: number | null = null;
  let stopped = false;
  let intersecting = true;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let needsResize = true;
  let forceRebuild = false;
  let rebuilt = false;
  let firstDone = false;
  let ink = '#888';
  let family = 'monospace';
  let clock = 0;
  let lastTick = -Infinity;
  let lastFrameAt = 0;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const rand = rng(options.seed ?? 720);
  let creatures: { c: Creature; el: HTMLElement; text: string }[] = [];
  let nextSpawn = spec.creatures ? 1.5 : Infinity;
  const usesScroll = spec.layers.some((l) => l.scroll > 0);
  const layers: Layer[] = [];

  const controller: AsciiFieldController = {
    tier,
    layers: 0,
    stats,
    running: () => raf !== null,
    reducedMotion: () => reduced,
    stop,
  };

  function makePlane(): Plane | null {
    const canvas = env.doc.createElement('canvas') as HTMLCanvasElement;
    const ctx = env.getContext(canvas);
    if (!ctx) return null;
    canvas.className = 'ascii-field__plane';
    canvas.style.opacity = '0';
    host.appendChild(canvas);
    return { canvas, ctx, ix: 0, iy: 0, ready: false };
  }

  for (const layerSpec of spec.layers) {
    const a = makePlane();
    const b = makePlane();
    if (!a || !b) continue;
    layers.push({
      spec: layerSpec, scale: 1, cellW: 0, cellH: 0, cols: 0, rows: 0, pad: 0, padY: 0, planes: [a, b], front: 0,
      glyphs: new Map(), halo: 0, strip: null, scrollRoom: 0, job: null, nextAt: 0, every: 1.1 + (spec.layers.length - 1 - layerSpec.depth) * 0.6,
    });
  }
  (controller as { layers: number }).layers = layers.length;
  (host as HTMLElement & { __asciiField?: AsciiFieldController }).__asciiField = controller;
  if (!layers.length) return controller;

  // Scratch canvas for the glyph atlas and for resolving the ink colour to RGB.
  const atlas = env.doc.createElement('canvas') as HTMLCanvasElement;
  const atlasCtx = env.getContext(atlas, { willReadFrequently: true });
  let inkPacked = 0;
  /** Per-theme strength (CSS `--ascii-gain`): dark ink on a light canvas needs a little more. */
  let gain = 1;

  function readTheme() {
    ink = env.cssVar(host, '--text') || ink;
    family = env.cssVar(host, '--font-mono') || family;
    gain = Number(env.cssVar(host, '--ascii-gain')) || 1;
    if (!atlasCtx) return;
    atlas.width = 1;
    atlas.height = 1;
    atlasCtx.clearRect(0, 0, 1, 1);
    atlasCtx.fillStyle = ink;
    atlasCtx.fillRect(0, 0, 1, 1);
    const px = atlasCtx.getImageData(0, 0, 1, 1).data;
    inkPacked = packInk(px[0], px[1], px[2]);
  }

  /** Rasterise the ramp once at this layer's size: white glyph → alpha, blur baked in. */
  function buildGlyphs(l: Layer) {
    l.glyphs.clear();
    const blur = l.spec.blurPx * l.scale;
    l.halo = blur > 0 ? Math.ceil(blur * 2) + 1 : 1;
    if (!atlasCtx) return;
    const gw = Math.ceil(l.cellW * l.scale) + 2 * l.halo;
    const gh = Math.ceil(l.cellH * l.scale) + 2 * l.halo;
    atlas.width = gw;
    atlas.height = gh;
    const fontPx = l.spec.fontPx * l.scale;
    for (const ch of FIELD_RAMP) {
      atlasCtx.clearRect(0, 0, gw, gh);
      atlasCtx.font = `${fontPx}px ${family}`;
      atlasCtx.textBaseline = 'top';
      atlasCtx.fillStyle = '#fff';
      atlasCtx.fillText(ch, l.halo, l.halo + (l.cellH * l.scale - fontPx) / 2);
      const rgba = atlasCtx.getImageData(0, 0, gw, gh).data;
      const alpha = new Uint8Array(gw * gh);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      if (blur > 0) {
        boxBlurAlpha(alpha, gw, gh, blur / 2, 2);
        // Blur spreads a glyph thin; lift its peak back so far layers read as soft bokeh, not haze.
        let peak = 1;
        for (let i = 0; i < alpha.length; i++) if (alpha[i] > peak) peak = alpha[i];
        const lift = Math.min(3, 220 / peak);
        for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(255, Math.round(alpha[i] * lift));
      }
      l.glyphs.set(ch, { w: gw, h: gh, alpha });
    }
  }

  function resize() {
    needsResize = false;
    const nextW = Math.max(0, Math.round(host.clientWidth));
    const nextH = Math.max(0, Math.round(host.clientHeight));
    // ResizeObserver also fires for sub-pixel jitter; only a real change (or a re-ink) rebuilds.
    if (!forceRebuild && nextW === width && nextH === height && layers[0].cols > 0) return;
    forceRebuild = false;
    width = nextW;
    height = nextH;
    stats.resizes++;
    dpr = Math.min(env.win.devicePixelRatio || 1, DPR_CAP[tier]);
    for (const l of layers) {
      l.scale = dpr * (tier === 'full' ? RES_BY_DEPTH[Math.min(2, l.spec.depth)] ?? 1 : Math.max(0.75, RES_BY_DEPTH[Math.min(2, l.spec.depth)] ?? 1));
      l.cellW = l.spec.fontPx * 0.6;
      l.cellH = Math.round(l.spec.fontPx * 1.25);
      // Room for one re-render period of drift plus the full parallax swing.
      l.pad = Math.ceil(Math.abs(l.spec.driftX) * l.every * 2.5 + 3 + l.spec.mousePx / l.cellW);
      // Vertical room: drift + mouse, plus at most 4 rows of scroll parallax (the
      // shift is clamped to it; bands and the hero bottom are masked anyway).
      const scrollRows = l.spec.scroll > 0 ? 4 : 0;
      l.padY = Math.ceil(Math.abs(l.spec.driftY) * l.every * 2.5 + 2 + l.spec.mousePx / l.cellH) + scrollRows;
      l.scrollRoom = scrollRows * l.cellH;
      l.cols = Math.ceil(width / l.cellW) + 2 * l.pad;
      l.rows = Math.ceil(height / l.cellH) + 2 * l.padY;
      const w = Math.max(1, Math.ceil(l.cols * l.cellW * l.scale));
      const h = Math.max(1, Math.ceil(l.rows * l.cellH * l.scale));
      for (const p of l.planes) {
        p.canvas.width = w;
        p.canvas.height = h;
        p.canvas.style.width = `${l.cols * l.cellW}px`;
        p.canvas.style.height = `${l.rows * l.cellH}px`;
        p.ready = false;
      }
      // The atlas is built on this layer's first job, so start-up work spreads over frames.
      l.glyphs.clear();
      l.halo = l.spec.blurPx > 0 ? Math.ceil(l.spec.blurPx * l.scale * 2) + 1 : 1;
      const strip = env.doc.createElement('canvas') as HTMLCanvasElement;
      const stripCtx = env.getContext(strip);
      const sh = Math.ceil(l.cellH * l.scale) + 2 * l.halo + 1;
      strip.width = w;
      strip.height = sh;
      const image = stripCtx?.createImageData(w, sh);
      l.strip = stripCtx && image ? { canvas: strip, ctx: stripCtx, image, words: new Uint32Array(image.data.buffer, image.data.byteOffset, w * sh) } : null;
      l.job = null;
      l.nextAt = 0;
    }
    rebuilt = true;
    scrollDirty = true;
  }

  /**
   * Scroll offset of the host in px (0 at rest). The rect is read only after a
   * scroll/resize, at the start of the frame before any style write, so it never
   * forces an extra layout.
   */
  let scrollPx = 0;
  let scrollDirty = true;
  function scrollShift(): number {
    if (!usesScroll || reduced) return 0;
    if (scrollDirty) {
      scrollDirty = false;
      const top = host.getBoundingClientRect().top;
      scrollPx = Math.max(-env.win.innerHeight, Math.min(env.win.innerHeight, -top));
    }
    return scrollPx;
  }
  const onScroll = () => { scrollDirty = true; };

  /**
   * Camera position of a layer in world cells. Scrolling moves nearer layers
   * up faster than the page (larger `scroll`), so depth reads while scrolling.
   */
  function camera(l: Layer, t: number, scroll: number): [number, number] {
    const s = l.spec;
    const cx = -s.driftX * t - (mouse.x * s.mousePx) / l.cellW;
    const shift = Math.max(-l.scrollRoom, Math.min(l.scrollRoom, scroll * s.scroll));
    const cy = -s.driftY * t - (mouse.y * s.mousePx) / l.cellH + shift / l.cellH;
    return [cx, cy];
  }

  function beginJob(l: Layer, t: number, cx: number, cy: number) {
    if (!l.glyphs.size) buildGlyphs(l);
    const plane = l.planes[l.front === 0 ? 1 : 0];
    plane.ix = Math.floor(cx) - l.pad;
    plane.iy = Math.floor(cy) - l.padY;
    plane.ready = false;
    l.job = { plane, t, row: 0, clearedTo: 0 };
  }

  /**
   * Advance a layer's re-render into its hidden back plane until `deadline`;
   * returns true when the plane is complete. Each step stamps one glyph row
   * into the CPU buffer, then the touched pixel strip is uploaded once.
   */
  function stepJob(l: Layer, deadline: number): boolean {
    const job = l.job!;
    const strip = l.strip;
    if (!strip) return true;
    const plane = job.plane;
    const bw = plane.canvas.width;
    const bh = plane.canvas.height;
    const { image, words } = strip;
    const sh = image.height;
    const cellWpx = l.cellW * l.scale;
    const cellHpx = l.cellH * l.scale;
    while (job.row < l.rows) {
      const top = Math.round(job.row * cellHpx) - l.halo;
      // Clear the plane rows this glyph row reaches first (the rows above keep the previous row's halo).
      const reach = Math.min(bh, top + sh);
      if (job.clearedTo < reach) { plane.ctx.clearRect(0, job.clearedTo, bw, reach - job.clearedTo); job.clearedTo = reach; }
      words.fill(inkPacked);
      const row = layerRow(plane.ix, plane.iy + job.row, l.cols, job.t, l.spec.depth, l.spec.density);
      let inked = false;
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === ' ') continue;
        const g = l.glyphs.get(ch);
        if (g) { stampGlyph(image.data, bw, sh, g, Math.round(i * cellWpx) - l.halo, 0); inked = true; }
      }
      if (inked) {
        strip.ctx.putImageData(image, 0, 0);
        plane.ctx.drawImage(strip.canvas, 0, top);
      }
      job.row++;
      stats.rows++;
      if (env.now() > deadline) break;
    }
    if (job.row < l.rows) return false;
    if (job.clearedTo < bh) { plane.ctx.clearRect(0, job.clearedTo, bw, bh - job.clearedTo); job.clearedTo = bh; }
    return true;
  }

  function commit(l: Layer, fade: boolean) {
    const back = l.planes[l.front === 0 ? 1 : 0];
    const front = l.planes[l.front];
    back.ready = true;
    back.canvas.style.transition = fade ? `opacity ${FADE_MS}ms ease` : 'none';
    front.canvas.style.transition = fade ? `opacity ${FADE_MS}ms ease` : 'none';
    back.canvas.style.opacity = String(Math.min(1, l.spec.alpha * gain));
    front.canvas.style.opacity = '0';
    l.front = l.front === 0 ? 1 : 0;
    l.job = null;
    stats.layerRefreshes++;
    if (!firstDone) { firstDone = true; options.onFirstFrame?.(); }
  }

  function place(l: Layer, cx: number, cy: number) {
    for (const p of l.planes) {
      if (!p.ready && p !== l.job?.plane) continue;
      const x = (p.ix - cx) * l.cellW;
      const y = (p.iy - cy) * l.cellH;
      p.canvas.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  function spawn(t: number) {
    const c = spawnCreature(rand, t, layers.length, options.mark === true);
    const el = env.doc.createElement('pre');
    el.className = `ascii-field__creature${c.name === 'mark' ? ' is-mark' : ''}`;
    const l = layers[c.layer];
    el.style.fontSize = `${l.spec.fontPx}px`;
    el.style.lineHeight = `${l.cellH}px`;
    el.style.opacity = String(Math.min(1, spec.creatureAlpha * gain));
    host.appendChild(el);
    creatures.push({ c, el, text: '' });
  }

  function updateCreatures(t: number, scroll: number) {
    if (!spec.creatures) return;
    creatures = creatures.filter((k) => {
      if (t - k.c.born <= k.c.duration) return true;
      k.el.remove();
      return false;
    });
    if (t >= nextSpawn && creatures.length < 3 && width > 0) {
      spawn(t);
      const [lo, hi] = spec.creatureEvery;
      nextSpawn = t + lo + rand() * (hi - lo);
    }
    for (const k of creatures) {
      const l = layers[k.c.layer];
      const lines = spriteLines(k.c.name, k.c.dir, t - k.c.born);
      const text = lines.join('\n');
      if (text !== k.text) { k.el.textContent = text; k.text = text; }
      const pos = creaturePosition(k.c, t, width, height, Math.max(...lines.map((s) => s.length)) * l.cellW, lines.length * l.cellH);
      if (!pos) continue;
      const x = pos.x + mouse.x * l.spec.mousePx;
      const y = pos.y + mouse.y * l.spec.mousePx - Math.max(-l.scrollRoom, Math.min(l.scrollRoom, scroll * l.spec.scroll));
      k.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  function paintStatic() {
    if (needsResize) resize();
    if (!width || !height) return;
    for (const k of creatures) k.el.remove();
    creatures = [];
    mouse.x = mouse.y = 0;
    for (const l of layers) {
      const [cx, cy] = camera(l, STATIC_T, 0);
      beginJob(l, STATIC_T, cx, cy);
      stepJob(l, Infinity);
      commit(l, false);
      place(l, cx, cy);
    }
    if (spec.creatures) {
      const c = spawnCreature(rng(options.seed ?? 720), 0, layers.length, options.mark === true);
      nextSpawn = Infinity;
      spawn(0);
      creatures[0].c = { ...c, born: STATIC_T - c.duration * 0.4 };
      updateCreatures(STATIC_T, 0);
    }
    stats.frames++;
  }

  function frame(t: number, frameTs: number) {
    if (needsResize) resize();
    if (!width || !height) return;
    const scroll = scrollShift();
    const allowance = takeFrameBudget(frameTs, budgetMs);
    const jobStart = env.now();
    const deadline = jobStart + allowance;
    const cams = layers.map((l) => camera(l, t, scroll));
    // Continue the job in flight; otherwise start the most overdue layer. Empty
    // layers (first start / after a resize) go first, far → near.
    let active = allowance > 0.05 ? layers.find((l) => l.job) : undefined;
    if (!active && allowance > 0.05) {
      let best: Layer | null = null;
      let bestScore = 1;
      layers.forEach((l, i) => {
        const front = l.planes[l.front];
        const drift = front.ready ? Math.abs(cams[i][0] - (front.ix + l.pad)) / Math.max(1, l.pad - 2) : Infinity;
        const score = !front.ready ? Infinity : Math.max(drift, t >= l.nextAt ? 1 + (t - l.nextAt) : 0);
        if (score >= bestScore && (!best || score > bestScore)) { best = l; bestScore = score; }
      });
      if (best) {
        const i = layers.indexOf(best);
        beginJob(best, t, cams[i][0], cams[i][1]);
        active = best;
      }
    }
    if (active && stepJob(active, deadline)) {
      const wasEmpty = !active.planes[active.front].ready;
      commit(active, true);
      active.nextAt = t + active.every * (0.8 + rand() * 0.4) + (wasEmpty ? active.spec.depth * 0.3 : 0);
    }
    if (active) spendFrameBudget(env.now() - jobStart);
    layers.forEach((l, i) => place(l, cams[i][0], cams[i][1]));
    updateCreatures(t, scroll);
  }

  function tick(now: number) {
    raf = null;
    if (stopped) return;
    schedule();
    if (!frameDue(now, lastTick, spec.fps)) return;
    const start = env.now();
    const dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0;
    lastFrameAt = now;
    lastTick = now;
    clock += dt;
    mouse.x += (mouse.tx - mouse.x) * 0.08;
    mouse.y += (mouse.ty - mouse.y) * 0.08;
    rebuilt = false;
    frame(clock, now);
    const ms = env.now() - start;
    stats.frames++;
    stats.lastMs = ms;
    stats.avgMs = stats.frames === 1 ? ms : stats.avgMs * 0.9 + ms * 0.1;
    if (!rebuilt) stats.maxMs = Math.max(stats.maxMs, ms);
  }

  function active() {
    return !stopped && !reduced && !env.doc.hidden && intersecting;
  }

  function schedule() {
    if (active()) {
      if (raf === null) raf = env.requestFrame(tick);
    } else if (raf !== null) {
      env.cancelFrame(raf);
      raf = null;
    }
  }

  function onVisibility() {
    // Resuming must not jump: the next frame's dt restarts from zero.
    if (env.doc.hidden) lastFrameAt = 0;
    schedule();
  }

  function onReducedChange() {
    reduced = reducedQuery?.matches === true;
    if (reduced) paintStatic();
    else { nextSpawn = clock + 1; }
    lastFrameAt = 0;
    schedule();
  }

  function onPointer(e: Event) {
    const p = e as PointerEvent;
    if (p.pointerType && p.pointerType !== 'mouse') return;
    mouse.tx = Math.max(-1, Math.min(1, (p.clientX / Math.max(1, env.win.innerWidth)) * 2 - 1));
    mouse.ty = Math.max(-1, Math.min(1, (p.clientY / Math.max(1, env.win.innerHeight)) * 2 - 1));
  }

  function onThemeChange() {
    const before = `${ink}|${gain}`;
    readTheme();
    if (`${ink}|${gain}` === before) return;
    if (reduced) { paintStatic(); return; }
    // Re-ink: every layer re-renders (cross-fading) on the next frames.
    for (const l of layers) { l.job = null; l.nextAt = 0; }
    if (!active()) { needsResize = true; forceRebuild = true; }
  }

  const io = env.IntersectionObserver
    ? new env.IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      intersecting = entry ? entry.isIntersecting : true;
      if (!intersecting) lastFrameAt = 0;
      schedule();
    })
    : null;
  let sized = false;
  const ro = env.ResizeObserver
    ? new env.ResizeObserver(() => {
      // The first callback is the initial size, already handled.
      if (!sized) { sized = true; return; }
      needsResize = true;
      if (reduced) paintStatic();
    })
    : null;
  const mo = env.MutationObserver ? new env.MutationObserver(onThemeChange) : null;
  const wantsMouse = tier === 'full' && spec.layers.some((l) => l.mousePx > 0);

  io?.observe(host);
  ro?.observe(host);
  mo?.observe(env.doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  schemeQuery?.addEventListener?.('change', onThemeChange);
  reducedQuery?.addEventListener?.('change', onReducedChange);
  env.doc.addEventListener('visibilitychange', onVisibility);
  if (wantsMouse) env.win.addEventListener('pointermove', onPointer, { passive: true });
  if (usesScroll) env.win.addEventListener('scroll', onScroll, { passive: true, capture: true });

  readTheme();
  if (reduced) paintStatic();
  else schedule();

  function stop() {
    if (stopped) return;
    stopped = true;
    if (raf !== null) env.cancelFrame(raf);
    raf = null;
    io?.disconnect();
    ro?.disconnect();
    mo?.disconnect();
    schemeQuery?.removeEventListener?.('change', onThemeChange);
    reducedQuery?.removeEventListener?.('change', onReducedChange);
    env.doc.removeEventListener('visibilitychange', onVisibility);
    if (wantsMouse) env.win.removeEventListener('pointermove', onPointer);
    if (usesScroll) env.win.removeEventListener('scroll', onScroll, { capture: true });
    for (const l of layers) for (const p of l.planes) p.canvas.remove();
    for (const k of creatures) k.el.remove();
    creatures = [];
  }

  return controller;
}
