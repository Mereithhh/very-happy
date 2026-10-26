/**
 * B-823: the sidebar's 「大版本更新」 entry reads every release's notes
 * (changelogRelease.ts, ~86KB); it joins the sidebar after the first screen
 * (afterFirstScreen.ts) instead of riding the startup chunk.
 */
import { lazy, Suspense } from 'react';
import { useAfterFirstScreen } from './afterFirstScreen';

const MajorUpdateEntry = lazy(() => import('./MajorUpdateEntry').then((m) => ({ default: m.MajorUpdateEntry })));

export function DeferredMajorUpdateEntry({ compact = false }: { compact?: boolean }) {
  if (!useAfterFirstScreen()) return null;
  return <Suspense fallback={null}><MajorUpdateEntry compact={compact} /></Suspense>;
}
