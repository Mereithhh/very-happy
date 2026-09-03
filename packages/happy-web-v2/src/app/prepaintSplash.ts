import { markProgrammaticReload } from '@/app/programmaticReload';
import {
  decideSplashStall,
  serializeSplashStallGuard,
  SPLASH_STALL_MS,
} from '@/app/splashStallPolicy';

/**
 * Fade the HTML pre-paint splash once the selected React root is ready.
 * The loader preview query deliberately keeps it mounted for visual QA.
 */
export function dismissPrepaintSplash(
  doc: Pick<Document, 'getElementById'> = document,
  schedule: (callback: () => void, delay: number) => unknown = setTimeout,
  search: string = window.location.search,
): boolean {
  if (new URLSearchParams(search).has('vh-loader-preview')) return false;

  const splash = doc.getElementById('vh-splash');
  if (!splash || splash.dataset.dismissing === 'true') return false;

  splash.dataset.dismissing = 'true';
  splash.style.opacity = '0';
  schedule(() => splash.remove(), 340);
  return true;
}

export const REACT_ROUTE_LOADING_SELECTOR = '[data-vh-route-loading="true"]';

/**
 * Keep the single HTML loader alive while the first authenticated route is
 * still suspended or restoring its snapshot. Otherwise its fade briefly
 * reveals a second, independently animated React loader underneath.
 */
export function dismissPrepaintSplashWhenRouteReady(
  root: Element | null = document.getElementById('root'),
  createObserver: (callback: MutationCallback) => Pick<MutationObserver, 'observe' | 'disconnect'> =
    (callback) => new MutationObserver(callback),
  dismiss: () => boolean = () => dismissPrepaintSplash(),
  onStall: () => void = defaultSplashStall,
  schedule: (callback: () => void, delay: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): () => void {
  if (!root) {
    dismiss();
    return () => {};
  }

  let observer: Pick<MutationObserver, 'observe' | 'disconnect'> | null = null;
  let stallTimer: unknown = null;
  const stopWaiting = () => {
    observer?.disconnect();
    if (stallTimer !== null) { cancel(stallTimer); stallTimer = null; }
  };
  const releaseIfReady = () => {
    if (root.querySelector(REACT_ROUTE_LOADING_SELECTOR)) return false;
    stopWaiting();
    dismiss();
    return true;
  };

  if (releaseIfReady()) return () => {};

  observer = createObserver(releaseIfReady);
  observer.observe(root, { childList: true, subtree: true });
  // Close the small race between the initial query and observer attachment.
  if (releaseIfReady()) return () => {};

  // B-315: the observer alone can wait forever. A route whose lazy chunk 404s
  // after a redeploy never stops rendering its loading marker, and the splash
  // sat on top of it until the viewer hard-refreshed by hand.
  stallTimer = schedule(() => {
    stallTimer = null;
    stopWaiting();
    onStall();
  }, SPLASH_STALL_MS);

  return stopWaiting;
}

/** Reload once to pick up the current shell; if that already happened, show
 *  whatever rendered instead of holding the splash up a second time. */
function defaultSplashStall(): void {
  const KEY = 'vh-splash-stall-v1';
  let stored: string | null = null;
  try { stored = sessionStorage.getItem(KEY); } catch { /* private mode */ }
  if (decideSplashStall(stored).action === 'reveal') {
    dismissPrepaintSplash();
    return;
  }
  try { sessionStorage.setItem(KEY, serializeSplashStallGuard({ attemptedAt: Date.now() })); } catch { /* ignore */ }
  markProgrammaticReload();
  window.location.reload();
}
