import { useEffect, useState } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useLocation,
} from 'react-router-dom';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { syncRestore } from '@/sync/sync';
import { ThemeProvider, ToastProvider } from '@/ui';
import { ModalProvider } from '@/modal';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { SignupScreen } from '@/screens/auth/SignupScreen';
import { AppLayout } from '@/screens/AppLayout';
import { SessionDetailScreen } from '@/screens/session/SessionDetailScreen';
import { EmptyDetail } from '@/screens/sessions/EmptyDetail';
import { SettingsRoutes } from '@/screens/settings/SettingsRoutes';
import { WebTerminalScreen } from '@/screens/terminal/WebTerminalScreen';
import { TerminalPickerScreen } from '@/screens/terminal/TerminalPickerScreen';
import { MachineScreen } from '@/screens/machine/MachineScreen';
import { useTerminalSessions } from '@/sync/terminalSessions';

function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter(
  [
    {
      path: '/login',
      element: (
        <RedirectIfAuthed>
          <LoginScreen />
        </RedirectIfAuthed>
      ),
    },
    {
      path: '/signup',
      element: (
        <RedirectIfAuthed>
          <SignupScreen />
        </RedirectIfAuthed>
      ),
    },
    {
      element: <RequireAuth />,
      children: [
        {
          path: '/',
          element: <AppLayout />,
          children: [
            { index: true, element: <EmptyDetail /> },
            { path: 'session/:id', element: <SessionDetailScreen /> },
            { path: 'terminal', element: <TerminalPickerScreen /> },
            { path: 'terminal/:machineId', element: <WebTerminalScreen /> },
            { path: 'machine/:id', element: <MachineScreen /> },
            { path: 'settings/*', element: <SettingsRoutes /> },
          ],
        },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);

function Splash() {
  return (
    <div className="auth-page">
      <div style={{ width: 44, height: 44, border: '2px solid var(--accent)', borderRadius: 12 }} />
    </div>
  );
}

export function AppRoot() {
  const [booting, setBooting] = useState(true);
  const [creds, setCreds] = useState<AuthCredentials | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await TokenStorage.getCredentials();
        if (cancelled) return;
        if (stored) {
          await syncRestore(stored);
          if (cancelled) return;
          setCreds(stored);
          // server-backed terminal list (cross-device, unified with chat sessions)
          void useTerminalSessions.getState().initialize();
        }
      } catch (e) {
        console.error('[bootstrap] restore failed', e);
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ThemeProvider>
      <ToastProvider>
        <ModalProvider>
          {booting ? (
            <Splash />
          ) : (
            <AuthProvider initialCredentials={creds}>
              <RouterProvider router={router} />
            </AuthProvider>
          )}
        </ModalProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
