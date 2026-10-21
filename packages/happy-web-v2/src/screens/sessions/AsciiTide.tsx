/**
 * B-700 — decorative ASCII tide for the empty main area (frame builder in
 * `asciiTide.ts`). Text in a <pre>, so it takes the theme's tokens with no
 * canvas and no dependency. ~8 fps; stops while the tab is hidden; one still
 * frame under prefers-reduced-motion. Width follows the container, so it
 * never widens the page on a phone.
 */
import { useEffect, useRef, useState } from 'react';
import { tideFrame } from './asciiTide';

const FPS = 8;
const MAX_COLS = 72;
const MIN_COLS = 20;

export function AsciiTide({ rows = 10 }: { rows?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  const [cols, setCols] = useState(48);
  const [t, setT] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    node.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 10 || 7;
    probe.remove();
    const measure = () => setCols(Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(node.clientWidth / charWidth))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const start = performance.now();
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const run = () => {
      stop();
      if (document.hidden || reduced?.matches) return;
      timer = window.setInterval(() => setT((performance.now() - start) / 1000), 1000 / FPS);
    };
    run();
    document.addEventListener('visibilitychange', run);
    reduced?.addEventListener?.('change', run);
    return () => { stop(); document.removeEventListener('visibilitychange', run); reduced?.removeEventListener?.('change', run); };
  }, []);

  return <pre ref={ref} className="ascii-tide" aria-hidden="true">{tideFrame(cols, rows, t).join('\n')}</pre>;
}
