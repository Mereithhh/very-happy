import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

import './styles/tokens.css';
import './styles/base.css';

import { installPwaPromptCapture } from './app/pwaInstallCapture.ts';
import { installStaleBundleReload } from './app/staleBundleReload.ts';
import { markProgrammaticReload } from './app/programmaticReload.ts';
import { shouldUsePublicRoot } from './app/rootSelection.ts';
import { dismissPrepaintSplash } from './app/prepaintSplash.ts';

// Capture Chrome's one-shot install event before the public/authenticated root
// and their lazy chunks load. PwaInstallPrompt consumes the retained event.
installPwaPromptCapture();

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
  markProgrammaticReload(); // recovery reload — the unload guard must stand down
  window.location.reload();
});

installStaleBundleReload();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const hasStoredCredentials = Boolean(localStorage.getItem('auth_credentials'));
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const routePath = basePath && window.location.pathname.startsWith(basePath)
  ? window.location.pathname.slice(basePath.length) || '/'
  : window.location.pathname;
const usePublicRoot = shouldUsePublicRoot(routePath, hasStoredCredentials);

// This boundary is the anonymous performance contract: public visitors never
// import account crypto, sync, realtime, or the authenticated application shell.
const rootModule = usePublicRoot
  ? import('./app/PublicRoot.tsx').then((m) => m.PublicRoot)
  : import('./app/AppRoot.tsx').then((m) => m.AppRoot);

void rootModule.then((RootComponent) => {
  createRoot(root).render(
    <StrictMode>
      <RootComponent />
    </StrictMode>,
  );

  // Public pages have no async account bootstrap. AppRoot owns the
  // authenticated handoff after credentials + persisted sync are restored.
  if (usePublicRoot) dismissPrepaintSplash();
});
