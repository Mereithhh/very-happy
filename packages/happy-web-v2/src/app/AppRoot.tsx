import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
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
import { ThemeProvider, ToastProvider, Spinner } from '@/ui';
import { ModalProvider } from '@/modal';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { AppLayout } from '@/screens/AppLayout';
import { EmptyDetail } from '@/screens/sessions/EmptyDetail';
import { useLocalSetting } from '@/sync/storage';

// Heavy screens are code-split so the initial bundle stays lean (chat pulls the
// markdown renderer, terminal pulls xterm, settings is large).
const SignupScreen = lazy(() => import('@/screens/auth/SignupScreen').then((m) => ({ default: m.SignupScreen })));
const SessionDetailScreen = lazy(() => import('@/screens/session/SessionDetailScreen').then((m) => ({ default: m.SessionDetailScreen })));
const SettingsRoutes = lazy(() => import('@/screens/settings/SettingsRoutes').then((m) => ({ default: m.SettingsRoutes })));
const WebTerminalScreen = lazy(() => import('@/screens/terminal/WebTerminalScreen').then((m) => ({ default: m.WebTerminalScreen })));
const TerminalPickerScreen = lazy(() => import('@/screens/terminal/TerminalPickerScreen').then((m) => ({ default: m.TerminalPickerScreen })));
const MachineScreen = lazy(() => import('@/screens/machine/MachineScreen').then((m) => ({ default: m.MachineScreen })));
const TaskBoardScreen = lazy(() => import('@/screens/board/TaskBoardScreen').then((m) => ({ default: m.TaskBoardScreen })));

function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={20} color="var(--accent)" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

/** `/` home: the classic empty-detail placeholder, or the Task Board when the
 *  device-local homeView preference says so (Settings → Appearance). */
function HomeGate() {
  const homeView = useLocalSetting('homeView');
  if (homeView === 'board') {
    return (
      <Lazy>
        <TaskBoardScreen />
      </Lazy>
    );
  }
  return <EmptyDetail />;
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
          <Lazy>
            <SignupScreen />
          </Lazy>
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
            { index: true, element: <HomeGate /> },
            { path: 'board', element: <Lazy><TaskBoardScreen /></Lazy> },
            { path: 'session/:id', element: <Lazy><SessionDetailScreen /></Lazy> },
            { path: 'terminal', element: <Lazy><TerminalPickerScreen /></Lazy> },
            { path: 'terminal/:machineId', element: <Lazy><WebTerminalScreen /></Lazy> },
            { path: 'machine/:id', element: <Lazy><MachineScreen /></Lazy> },
            { path: 'settings/*', element: <Lazy><SettingsRoutes /></Lazy> },
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
