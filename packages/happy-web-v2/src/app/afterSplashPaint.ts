/**
 * B-823 (QA9 O-2): on a cold start the composer must not wait for the
 * transcript's first render.
 *
 * Since B-819 the URL's session starts its catch-up (and its cache read) in
 * sync #init, so its messages are usually in the store by the time the
 * session list makes the app ready. The session screen's first commit then
 * carried the whole transcript (≈100 rows; 300–550ms on a phone CPU), and the
 * composer — and the splash fade — waited for it (QA9: main's composer
 * appeared 300–550ms after prod's; content at the same time). Prod showed
 * composer first because its messages simply arrived later.
 *
 * Only the commit that lifts the pre-paint splash is split: the shell and the
 * composer go first; the heavy part mounts after the next paint. Every later
 * mount (session switches) renders at once — no empty-frame flicker.
 */
import { startTransition, useEffect, useState } from 'react';

/** The pre-paint splash is still up, i.e. this render is the cold start's first screen. */
export function splashStillUp(doc: Pick<Document, 'getElementById'> | null = typeof document === 'undefined' ? null : document): boolean {
  const splash = doc?.getElementById('vh-splash');
  return !!splash && splash.dataset.dismissing !== 'true';
}

type Scheduler = (fire: () => void) => () => void;

/** After the next paint: rAF runs before it, a task queued from rAF runs after it. */
const afterNextPaint: Scheduler = (fire) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => { timer = setTimeout(fire, 0); });
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
};

/** true right away, except under the splash: false for the first paint, then true. */
export function useAfterSplashPaint(schedule: Scheduler = afterNextPaint, underSplash: () => boolean = splashStillUp): boolean {
  const [ready, setReady] = useState(() => !underSplash());
  useEffect(() => {
    if (ready) return;
    return schedule(() => startTransition(() => setReady(true)));
  }, [ready, schedule]);
  return ready;
}
