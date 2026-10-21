/**
 * B-720 — decorative depth-of-field ASCII backdrop. Renders an absolutely
 * positioned, aria-hidden layer stack inside its parent (the parent must be a
 * positioning context). The engine chunk is imported only after the page is
 * idle, so it never competes with first paint / LCP; the canvas fades in once
 * the first frame is drawn. Off (Settings → Appearance → 背景动效) renders
 * nothing at all.
 */
import { useEffect, useRef } from 'react';
import type { AsciiFieldPreset } from './asciiFieldModel';
import type { AsciiFieldController, AsciiFieldEnv, AsciiFieldOptions } from './asciiFieldEngine';
import { useAsciiMotion } from './asciiMotionPreference';
import './asciiField.css';

type EngineModule = { startAsciiField: (host: HTMLElement, options: AsciiFieldOptions, env?: AsciiFieldEnv) => AsciiFieldController };
const loadEngineDefault = () => import('./asciiFieldEngine') as Promise<EngineModule>;

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

/** Settle time after `load` before any decoration work starts (B-720 TBT budget). */
export const START_DELAY_MS = 3000;

/**
 * Run `fn` once the page has settled: `load`, then START_DELAY_MS after it (only
 * right after the document load — SPA routes mounted later start at once), then
 * an idle callback. The first user interaction (pointer, key, scroll, touch) starts it
 * early — by then the page is interactive and the user is looking. Keeps the
 * engine and the logo formation out of the load / TBT window entirely; the
 * static backgrounds and the static mark are what first paint shows.
 */
export function whenIdle(fn: () => void): () => void {
  const w = window as IdleWindow;
  let done = false;
  let idleId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
  const run = () => {
    if (done) return;
    done = true;
    cleanup();
    fn();
  };
  const idle = () => {
    if (done) return;
    if (w.requestIdleCallback) idleId = w.requestIdleCallback(run, { timeout: 2000 });
    else run();
  };
  // Only the first seconds after the document load wait; later mounts (SPA routes) start at once.
  const afterLoad = () => {
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    const since = nav && nav.loadEventEnd > 0 ? performance.now() - nav.loadEventEnd : 0;
    timer = setTimeout(idle, Math.max(0, START_DELAY_MS - since));
  };
  function cleanup() {
    window.removeEventListener('load', afterLoad);
    for (const e of events) window.removeEventListener(e, run, true);
    if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
    if (timer !== undefined) clearTimeout(timer);
  }
  for (const e of events) window.addEventListener(e, run, { capture: true, passive: true, once: true });
  if (document.readyState === 'complete') afterLoad();
  else window.addEventListener('load', afterLoad, { once: true });
  return () => { done = true; cleanup(); };
}

export interface AsciiFieldProps {
  preset: AsciiFieldPreset;
  /** Let the Very Happy mark swim by among the creatures. */
  mark?: boolean;
  className?: string;
  /** Test seams. */
  loadEngine?: () => Promise<EngineModule>;
  env?: AsciiFieldEnv;
  defer?: (fn: () => void) => () => void;
}

export function AsciiField({ preset, mark, className, loadEngine = loadEngineDefault, env, defer = whenIdle }: AsciiFieldProps) {
  const [enabled] = useAsciiMotion();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;
    let controller: AsciiFieldController | null = null;
    let disposed = false;
    const cancelDefer = defer(() => {
      void loadEngine().then(({ startAsciiField }) => {
        if (disposed) return;
        controller = startAsciiField(host, { preset, mark, onFirstFrame: () => host.classList.add('is-ready') }, env);
      }).catch(() => { /* decoration only: a failed chunk load leaves the plain background */ });
    });
    return () => {
      disposed = true;
      cancelDefer();
      controller?.stop();
      host.classList.remove('is-ready');
    };
  }, [enabled, preset, mark, loadEngine, env, defer]);

  if (!enabled) return null;
  return (
    <div ref={hostRef} className={`ascii-field ascii-field--${preset}${className ? ` ${className}` : ''}`} aria-hidden="true" data-ascii-field={preset} />
  );
}
