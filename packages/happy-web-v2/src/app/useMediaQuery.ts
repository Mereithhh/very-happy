import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/**
 * desktop = two-pane shell (sidebar + detail); below it's single-pane.
 * Two arms (B-112): classic desktop width, OR a tablet/unfolded-foldable
 * (Galaxy Fold open ≈ 800-910px CSS) — the height arm keeps landscape PHONES
 * out (e.g. iPhone Pro Max landscape is 932×430). Keep in sync with the CSS
 * mobile inverse used by the fullscreen panels:
 *   @media (max-width: 799px), (max-width: 979px) and (max-height: 599px)
 */
export const DESKTOP_SHELL_MQ = '(min-width: 980px), (min-width: 800px) and (min-height: 600px)';

export function useIsDesktop() {
  return useMediaQuery(DESKTOP_SHELL_MQ);
}

export function useIsTablet() {
  return useMediaQuery('(min-width: 600px)');
}
