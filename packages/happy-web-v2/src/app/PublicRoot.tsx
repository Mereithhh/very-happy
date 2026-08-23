/**
 * Lightweight anonymous shell.
 *
 * Fresh visitors to `/`, docs, and legal pages must not pay for account crypto,
 * sync, realtime, or the authenticated application. main.tsx chooses this root
 * only when no stored credentials exist and the pathname is public. Auth links
 * intentionally use normal navigation so the next load selects AppRoot.
 */
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { ThemeProvider } from '@/ui/theme';

const publicRouter = createBrowserRouter(
  [
    { path: '/', element: <LandingScreen /> },
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
    </ThemeProvider>
  );
}
