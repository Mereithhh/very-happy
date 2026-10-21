/**
 * B-720 × B-724 — the landing hero's Very Happy mark. The static SVG is in the
 * first paint (it is also the final frame), so LCP never waits for script. When
 * background motion is on and the system does not ask for reduced motion, the
 * "focus into form" enhancement loads after idle and plays once (≤ 2.5 s):
 * characters gather from the depth field into the block, then ^_^ clears.
 */
import { useEffect, useRef } from 'react';
import { markPath } from '@/ui/veryHappyMarkGeometry';
import { useAsciiMotion } from '@/ui/asciiField/asciiMotionPreference';
import { whenIdle } from '@/ui/asciiField/AsciiField';

const MARK_D = markPath();

type FormationModule = typeof import('@/ui/asciiField/logoFormation');
const loadFormationDefault = () => import('@/ui/asciiField/logoFormation');

export function HeroMark({ label, loadFormation = loadFormationDefault, defer = whenIdle }: { label: string; loadFormation?: () => Promise<FormationModule>; defer?: (fn: () => void) => () => void }) {
  const [motion] = useAsciiMotion();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = ref.current;
    const stage = mark?.closest<HTMLElement>('.pub-hero');
    if (!motion || !mark || !stage) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    const cancel = defer(() => {
      void loadFormation().then(({ startLogoFormation }) => {
        if (disposed) return;
        stop = startLogoFormation(mark, stage).stop;
      }).catch(() => { /* enhancement only: the static mark stays */ });
    });
    return () => { disposed = true; cancel(); stop?.(); };
  }, [motion, loadFormation, defer]);
  return (
    <div ref={ref} className="pub-hero-mark" data-hero-mark>
      <svg viewBox="0 0 96 96" role="img" aria-label={label}><path fill="currentColor" fillRule="evenodd" d={MARK_D} /></svg>
    </div>
  );
}
