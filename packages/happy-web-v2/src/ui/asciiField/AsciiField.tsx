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

/** Run `fn` once the browser is idle (after load), with a timeout so it always runs. */
export function whenIdle(fn: () => void): () => void {
  const w = window as IdleWindow;
  let cancelled = false;
  let idleId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const go = () => {
    if (cancelled) return;
    if (w.requestIdleCallback) idleId = w.requestIdleCallback(() => { if (!cancelled) fn(); }, { timeout: 1500 });
    else timer = setTimeout(() => { if (!cancelled) fn(); }, 200);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener('load', go);
    if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
    if (timer !== undefined) clearTimeout(timer);
  };
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
