import { RouteError } from './RouteError';
/**
 * Lightweight anonymous shell.
 *
 * Visitors to `/welcome` — including returning users with stored credentials —
 * and fresh visitors to `/`, docs, and legal pages must not pay for account
 * crypto, sync, realtime, or the authenticated application. Auth links use
 * normal navigation so the next load selects AppRoot.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { ThemeProvider } from '@/ui/theme';
import { PwaInstallPrompt } from './PwaInstallPrompt';

// B-701: the share-link viewer pulls in the transcript renderer; keep it out of the landing chunk.
const SharedLinkScreen = lazy(() => import('@/screens/public/SharedLinkScreen').then((m) => ({ default: m.SharedLinkScreen })));

const publicRouter = createBrowserRouter(
  [{ errorElement: <RouteError />, children: [
    { path: '/', element: <LandingScreen /> },
    { path: '/welcome', element: <LandingScreen /> },
    { path: '/docs', element: <DocsScreen /> },
    { path: '/docs/:slug', element: <DocsScreen /> },
    { path: '/privacy', element: <PrivacyScreen /> },
    { path: '/terms', element: <TermsScreen /> },
    { path: '/s/:linkId', element: <Suspense fallback={null}><SharedLinkScreen /></Suspense> },
  ] }],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);

export function PublicRoot() {
  return (
    <ThemeProvider>
      <RouterProvider router={publicRouter} />
      {/* B-701: a share-link viewer came to read one conversation, not to install the app. */}
      {!/^\/s\//.test(window.location.pathname) && <PwaInstallPrompt />}
    </ThemeProvider>
  );
}
