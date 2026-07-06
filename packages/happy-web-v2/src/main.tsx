import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';

import './styles/tokens.css';
import './styles/base.css';

import { AppRoot } from './app/AppRoot.tsx';

// Stale-deploy recovery: after a redeploy the old hashed lazy chunks are gone,
// so a client still running the previous shell hits "Failed to fetch
// dynamically imported module" on navigation. Vite surfaces that as
// `vite:preloadError` — reload once to pick up the new shell (loop-guarded via
// sessionStorage so a genuinely broken deploy doesn't reload forever).
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'vh-preload-reload-at';
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 30_000) return; // already tried recently — let it throw
  sessionStorage.setItem(KEY, String(Date.now()));
  event.preventDefault(); // suppress the error overlay/throw; we're recovering
  window.location.reload();
});

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);

// remove the pre-paint splash once React has mounted
const splash = document.getElementById('vh-splash');
if (splash) {
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 300);
}
