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

/** desktop = two-pane layout (sidebar + detail); below this it's single-pane. */
export function useIsDesktop() {
  return useMediaQuery('(min-width: 980px)');
}

export function useIsTablet() {
  return useMediaQuery('(min-width: 600px)');
}
