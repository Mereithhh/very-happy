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
): () => void {
  if (!root) {
    dismiss();
    return () => {};
  }

  let observer: Pick<MutationObserver, 'observe' | 'disconnect'> | null = null;
  const releaseIfReady = () => {
    if (root.querySelector(REACT_ROUTE_LOADING_SELECTOR)) return false;
    observer?.disconnect();
    dismiss();
    return true;
  };

  if (releaseIfReady()) return () => {};

  observer = createObserver(releaseIfReady);
  observer.observe(root, { childList: true, subtree: true });
  // Close the small race between the initial query and observer attachment.
  releaseIfReady();

  return () => observer?.disconnect();
}
