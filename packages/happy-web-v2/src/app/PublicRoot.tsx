/**
 * Lightweight anonymous shell.
 *
 * Visitors to `/welcome` — including returning users with stored credentials —
 * and fresh visitors to `/`, docs, and legal pages must not pay for account
 * crypto, sync, realtime, or the authenticated application. Auth links use
 * normal navigation so the next load selects AppRoot.
 */
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { ThemeProvider } from '@/ui/theme';
import { PwaInstallPrompt } from './PwaInstallPrompt';

const publicRouter = createBrowserRouter(
  [
    { path: '/', element: <LandingScreen /> },
    { path: '/welcome', element: <LandingScreen /> },
    { path: '/docs', element: <DocsScreen /> },
    { path: '/docs/:slug', element: <DocsScreen /> },
    { path: '/privacy', element: <PrivacyScreen /> },
    { path: '/terms', element: <TermsScreen /> },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);

export function PublicRoot() {
  return (
    <ThemeProvider>
      <RouterProvider router={publicRouter} />
      <PwaInstallPrompt />
    </ThemeProvider>
  );
}
