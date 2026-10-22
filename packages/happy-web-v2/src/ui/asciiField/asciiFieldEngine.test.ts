// @vitest-environment happy-dom
/**
 * B-720 — AsciiField engine timing rules, driven through a fake environment:
 * reduced motion draws one still and never schedules a frame; a hidden tab or
 * an off-screen host pauses the loop and resumes it; frames are capped at 30
 * fps; re-rendering stays inside the per-frame budget shared by every field.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { STATIC_T, spendFrameBudget, startAsciiField, takeFrameBudget, type AsciiFieldController, type AsciiFieldEnv } from './asciiFieldEngine';

type Listener = () => void;

function fakeCtx() {
  const calls = { put: 0, fillText: 0 };
  const ctx = {
    calls,
    font: '', textBaseline: 'top', fillStyle: '#000',
    clearRect() {}, fillRect() {}, setTransform() {},
    fillText() { calls.fillText++; },
    // A glyph cell that is half ink, so stamping writes alpha.
    getImageData(_x: number, _y: number, w: number, h: number) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 3; i < data.length; i += 8) data[i] = 255;
      return { width: w, height: h, data };
    },
    createImageData(w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() { calls.put++; },
    drawImage() {},
  };
  return ctx;
}

interface Harness {
  env: AsciiFieldEnv;
  host: HTMLElement;
  clock: { t: number; step: number };
  /** Run pending rAF callbacks `n` times at `hz`. */
  frames(n: number, hz?: number): number;
  pending(): number;
  setHidden(hidden: boolean): void;
  setIntersecting(v: boolean): void;
  ctxs: ReturnType<typeof fakeCtx>[];
}

function harness({ reduced = false, width = 800, height = 400 } = {}): Harness {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: width });
  Object.defineProperty(host, 'clientHeight', { value: height });
  document.body.append(host);
  const clock = { t: 1000, step: 0 };
  const queue = new Map<number, (t: number) => void>();
  let nextId = 1;
  const docListeners = new Map<string, Set<Listener>>();
  let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  const doc = {
    hidden: false,
    addEventListener: (t: string, fn: Listener) => { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t)!.add(fn); },
    removeEventListener: (t: string, fn: Listener) => { docListeners.get(t)?.delete(fn); },
    documentElement: document.documentElement,
    createElement: (tag: string) => document.createElement(tag),
  };
  const ctxs: ReturnType<typeof fakeCtx>[] = [];
  const env: AsciiFieldEnv = {
    now: () => clock.t,
    requestFrame: (cb) => { const id = nextId++; queue.set(id, cb); return id; },
    cancelFrame: (id) => { queue.delete(id); },
    matchMedia: (q) => ({ matches: q.includes('reduced-motion') ? reduced : false }),
    doc,
    win: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    getContext: () => { const c = fakeCtx(); ctxs.push(c); return c as unknown as CanvasRenderingContext2D; },
    cssVar: (_el, name) => (name === '--font-mono' ? 'monospace' : '#ecede8'),
    IntersectionObserver: class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { ioCallback = cb; }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver,
    tierSignals: () => ({ coarsePointer: false, narrow: false }),
  };
  return {
    env, host, clock, ctxs,
    frames(n, hz = 60) {
      let ran = 0;
      for (let i = 0; i < n; i++) {
        clock.t += 1000 / hz;
        const cbs = [...queue.entries()];
        queue.clear();
        for (const [, cb] of cbs) { cb(clock.t); ran++; }
      }
      return ran;
    },
    pending: () => queue.size,
    setHidden(hidden) { doc.hidden = hidden; docListeners.get('visibilitychange')?.forEach((fn) => fn()); },
    setIntersecting(v) { ioCallback?.([{ isIntersecting: v }]); },
  };
}

let controller: AsciiFieldController | null = null;
afterEach(() => { controller?.stop(); controller = null; document.body.innerHTML = ''; });

describe('B-720 AsciiField engine', () => {
  it('prefers-reduced-motion: draws one complete still frame and never schedules a frame', () => {
    const h = harness({ reduced: true });
    let first = 0;
    controller = startAsciiField(h.host, { preset: 'empty', tier: 'full', mark: true, onFirstFrame: () => first++ }, h.env);
    expect(controller.reducedMotion()).toBe(true);
    expect(controller.running()).toBe(false);
    expect(h.pending()).toBe(0);
    expect(controller.stats.frames).toBe(1);
    expect(controller.stats.layerRefreshes).toBe(3);
    expect(first).toBe(1);
    // Every layer's front plane is visible at its alpha; the still carries one creature.
    const planes = [...h.host.querySelectorAll('canvas')];
    expect(planes).toHaveLength(6);
    expect(planes.filter((c) => Number((c as HTMLElement).style.opacity) > 0)).toHaveLength(3);
    expect(h.host.querySelectorAll('pre.ascii-field__creature')).toHaveLength(1);
    expect(STATIC_T).toBeGreaterThan(0);
    // Nothing moves afterwards.
    expect(h.frames(30)).toBe(0);
  });

  it('animates while visible, pauses while the tab is hidden, and resumes', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'band', tier: 'full' }, h.env);
    expect(controller.running()).toBe(true);
    h.frames(10);
    const drawn = controller.stats.frames;
    expect(drawn).toBeGreaterThan(0);
    h.setHidden(true);
    expect(controller.running()).toBe(false);
    expect(h.pending()).toBe(0);
    expect(h.frames(20)).toBe(0);
    expect(controller.stats.frames).toBe(drawn);
    h.setHidden(false);
    expect(controller.running()).toBe(true);
    h.frames(10);
    expect(controller.stats.frames).toBeGreaterThan(drawn);
  });

  it('pauses while the host is off-screen (IntersectionObserver) and resumes on re-entry', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'band', tier: 'full' }, h.env);
    h.frames(4);
    h.setIntersecting(false);
    expect(controller.running()).toBe(false);
    const drawn = controller.stats.frames;
    expect(h.frames(20)).toBe(0);
    expect(controller.stats.frames).toBe(drawn);
    h.setIntersecting(true);
    expect(controller.running()).toBe(true);
  });

  it('caps at 30 fps even when the display runs at 120 Hz', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'hero', tier: 'full' }, h.env);
    h.frames(240, 120); // two seconds
    expect(controller.stats.frames).toBeLessThanOrEqual(61);
    expect(controller.stats.frames).toBeGreaterThanOrEqual(55);
  });

  it('re-renders incrementally inside the frame budget, then cross-fades every layer in', () => {
    const h = harness({ width: 1440, height: 800 });
    // Every row costs 0.4 ms of fake time: a 1 ms budget allows ~3 rows a frame.
    const realNow = h.env.now;
    let calls = 0;
    h.env.now = () => realNow() + (calls++) * 0.4;
    controller = startAsciiField(h.host, { preset: 'hero', tier: 'full', budgetMs: 1 }, h.env);
    h.frames(2, 30);
    expect(controller.stats.rows).toBeLessThanOrEqual(2 * 5);
    let guard = 0;
    while (controller.stats.layerRefreshes < 3 && guard++ < 2000) h.frames(1, 30);
    expect(controller.stats.layerRefreshes).toBeGreaterThanOrEqual(3);
    // Text is never drawn per frame: only the 7-glyph atlas per layer uses fillText.
    const fillTexts = h.ctxs.reduce((s, c) => s + c.calls.fillText, 0);
    expect(fillTexts).toBeLessThanOrEqual(3 * 7);
  });

  it('shares one budget between all fields in the same animation frame', () => {
    expect(takeFrameBudget(5000, 1)).toBe(1);
    spendFrameBudget(0.7);
    expect(takeFrameBudget(5000, 1)).toBeCloseTo(0.3);
    spendFrameBudget(5);
    expect(takeFrameBudget(5000, 1)).toBe(0);
    expect(takeFrameBudget(5016, 1)).toBe(1);
  });

  it('stop() cancels the loop and removes its canvases and creatures', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'hero', tier: 'full', mark: true }, h.env);
    h.frames(5);
    controller.stop();
    expect(controller.running()).toBe(false);
    expect(h.pending()).toBe(0);
    expect(h.host.querySelectorAll('canvas, pre')).toHaveLength(0);
  });

  it('B-752 setPace: 0 pauses the loop (frame stays), n caps the rate, null restores the preset', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'chat', tier: 'full' }, h.env);
    expect(controller.layers).toBe(2);
    h.frames(60); // 1 s at the preset's 15 fps
    const atPreset = controller.stats.frames;
    expect(atPreset).toBeGreaterThanOrEqual(14);
    controller.setPace(0);
    expect(controller.running()).toBe(false);
    expect(h.pending()).toBe(0);
    expect(h.frames(60)).toBe(0);
    expect(controller.stats.frames).toBe(atPreset);
    // Planes are not torn down while paused.
    expect(h.host.querySelectorAll('canvas')).toHaveLength(4);
    controller.setPace(8);
    expect(controller.running()).toBe(true);
    h.frames(120); // 2 s
    const atEight = controller.stats.frames - atPreset;
    expect(atEight).toBeLessThanOrEqual(17);
    expect(atEight).toBeGreaterThanOrEqual(14);
    controller.setPace(null);
    const before = controller.stats.frames;
    h.frames(60);
    expect(controller.stats.frames - before).toBeGreaterThanOrEqual(14);
    // A hidden tab still wins over a non-zero pace.
    h.setHidden(true);
    controller.setPace(8);
    expect(controller.running()).toBe(false);
  });

  it('B-752 originX shifts the world, so sibling fields show different patterns', () => {
    const a = harness();
    const b = harness();
    const left = startAsciiField(a.host, { preset: 'chat', tier: 'full', budgetMs: 1000 }, a.env);
    const right = startAsciiField(b.host, { preset: 'chat', tier: 'full', budgetMs: 1000, originX: 4096 }, b.env);
    a.frames(1); b.frames(1);
    const ix = (h: Harness) => Number(/translate3d\((-?[\d.]+)px/.exec((h.host.querySelector('canvas[style*="translate3d"]') as HTMLElement).style.transform)![1]);
    // Same camera drift, different world origin: the far plane sits at a different world cell.
    expect(ix(a)).not.toBe(ix(b));
    left.stop(); right.stop();
  });

  it('the lite tier (phones / low-end) runs two layers', () => {
    const h = harness();
    controller = startAsciiField(h.host, { preset: 'hero', tier: 'lite' }, h.env);
    expect(controller.layers).toBe(2);
    expect(h.host.querySelectorAll('canvas')).toHaveLength(4);
  });
});
