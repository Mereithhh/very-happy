import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';

// B-289: warm the terminal's monospace face at boot so that by the time any web
// terminal opens, xterm measures its cell width from the real font (not a
// fallback) — otherwise the first size sent to the daemon is wrong and Claude
// boots at a width that freezes narrow content into scrollback. Best-effort;
// the terminal open also waits on it (awaitTerminalFont) as the real guarantee.
try { (document as unknown as { fonts?: { load?: (q: string) => unknown } }).fonts?.load?.("13px 'IBM Plex Mono'"); } catch { /* no-op */ }

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

// The generated registerSW.js does not reload an already-open page after an
// update. The update-aware client does. Keep autoUpdate during the migration:
// its skipWaiting + clientsClaim settings also let already-installed, older
// versions move to this worker without user intervention.
navigator.serviceWorker?.addEventListener('controllerchange', () => markProgrammaticReload());
registerSW({
  immediate: true,
  onRegisteredSW: (_swUrl, registration) => {
    if (registration?.waiting) markProgrammaticReload();
    registration?.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        // Mark before activation: Workbox's autoUpdate listener reloads on
        // `activated`, which can precede controllerchange in some WebKit runs.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          markProgrammaticReload();
        }
      });
    });
    // A cold PWA launch should check now, not at the browser's unspecified
    // update cadence. Best-effort and intentionally not awaited by bootstrap.
    void registration?.update().catch(() => {});
  },
  onRegisterError: (error) => {
    console.warn('[pwa] service worker registration failed', error);
  },
});

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
