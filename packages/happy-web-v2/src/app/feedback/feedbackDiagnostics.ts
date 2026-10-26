/**
 * B-836: the live inputs of buildFeedbackDiagnostics — current versions,
 * browser and the page the person was on. The form lives at
 * /settings/feedback, so "the page" is the last route outside it, recorded
 * by useRecordFeedbackRoute (mounted once, inside the router).
 */
import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAllMachines } from '@/sync/storage';
import { buildFeedbackDiagnostics, type FeedbackDiagnostics } from './feedbackPolicy';

let lastRoute: string | null = null;

export function isFeedbackRoute(pathname: string): boolean {
  return /^\/(?:settings\/)?feedback(?:\/|$)/.test(pathname);
}

export function useRecordFeedbackRoute(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!isFeedbackRoute(pathname)) lastRoute = pathname;
  }, [pathname]);
}

/** The page before the form; on a cold open of the form itself, the form's own path. */
export function feedbackLastRoute(): string {
  return lastRoute ?? (typeof location === 'undefined' ? '/' : location.pathname);
}

function pointerKind(): 'fine' | 'coarse' | 'none' {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return 'coarse';
    if (window.matchMedia('(pointer: fine)').matches) return 'fine';
  } catch { /* old browsers */ }
  return 'none';
}

/** A fresh snapshot each render the caller asks for (`stamp` changes → new `ts`). */
export function useFeedbackDiagnostics(pathname: string, stamp: number): FeedbackDiagnostics {
  const machines = useAllMachines({ includeOffline: true });
  const cliVersions = useMemo(() => machines.map((m) => m.metadata?.happyCliVersion), [machines]);
  return useMemo(() => buildFeedbackDiagnostics({
    webVersion: __APP_VERSION__,
    cliVersions,
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pointer: pointerKind(),
    pathname,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    now: stamp,
  }), [cliVersions, pathname, stamp]);
}
