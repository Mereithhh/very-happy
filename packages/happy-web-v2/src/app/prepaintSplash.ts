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
