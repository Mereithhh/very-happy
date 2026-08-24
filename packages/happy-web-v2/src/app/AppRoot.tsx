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
import { useAllMachines, useIsDataReady, useLocalSetting } from '@/sync/storage';
import { useGlobalBackNav } from '@/app/appBack';
import { FirstRunScreen } from '@/screens/onboarding/FirstRunScreen';
import { shouldShowFirstRun } from '@/screens/onboarding/firstRun';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { TerminalConnectScreen } from '@/screens/auth/TerminalConnectScreen';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PwaInstallPrompt } from './PwaInstallPrompt';
import './appFonts';

// Heavy screens are code-split so the initial bundle stays lean (chat pulls the
// markdown renderer, terminal pulls xterm, settings is large).
const SignupScreen = lazy(() => import('@/screens/auth/SignupScreen').then((m) => ({ default: m.SignupScreen })));
const SessionDetailScreen = lazy(() => import('@/screens/session/SessionDetailScreen').then((m) => ({ default: m.SessionDetailScreen })));
const SettingsRoutes = lazy(() => import('@/screens/settings/SettingsRoutes').then((m) => ({ default: m.SettingsRoutes })));
const WebTerminalScreen = lazy(() => import('@/screens/terminal/WebTerminalScreen').then((m) => ({ default: m.WebTerminalScreen })));
const TerminalPickerScreen = lazy(() => import('@/screens/terminal/TerminalPickerScreen').then((m) => ({ default: m.TerminalPickerScreen })));
const MachineScreen = lazy(() => import('@/screens/machine/MachineScreen').then((m) => ({ default: m.MachineScreen })));
const TaskBoardScreen = lazy(() => import('@/screens/board/TaskBoardScreen').then((m) => ({ default: m.TaskBoardScreen })));
const AssistantScreen = lazy(() => import('@/screens/assistant/AssistantScreen').then((m) => ({ default: m.AssistantScreen })));
const NotesScreen = lazy(() => import('@/screens/notes/NotesScreen').then((m) => ({ default: m.NotesScreen })));
const TodosScreen = lazy(() => import('@/screens/todos/TodosScreen').then((m) => ({ default: m.TodosScreen })));

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
  // Global back lives HERE, not in AppLayout: it must also cover /assistant,
  // which is a sibling of the layout tree. Installs the in-app history tracker
  // plus the ⌘[ / Alt+← chord and the left-edge swipe.
  useGlobalBackNav();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

function RootGate() {
  const { isAuthenticated } = useAuth();
  useGlobalBackNav();
  if (!isAuthenticated) return <LandingScreen />;
  return <AppLayout />;
}

/** `/` home: the classic empty-detail placeholder, or the Task Board when the
 *  device-local homeView preference says so (Settings → Appearance). */
function HomeGate() {
  const homeView = useLocalSetting('homeView');
  const dataReady = useIsDataReady();
  const machines = useAllMachines({ includeOffline: true });
  if (shouldShowFirstRun(dataReady, machines.length)) return <FirstRunScreen />;
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

// DEV-ONLY sidebar harness (real <Sidebar/> on seeded stores, no login) —
// import.meta.env.DEV means vite strips both route and chunk from prod builds.
const SidebarHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/SidebarHarness').then((m) => ({ default: m.SidebarHarness })))
  : null;

const router = createBrowserRouter(
  [
    ...(SidebarHarness
      ? [{ path: '/dev/sidebar', element: <Lazy><SidebarHarness /></Lazy> }]
      : []),
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
    { path: '/privacy', element: <PrivacyScreen /> },
    { path: '/terms', element: <TermsScreen /> },
    { path: '/welcome', element: <LandingScreen /> },
    { path: '/docs', element: <DocsScreen /> },
    { path: '/docs/:slug', element: <DocsScreen /> },
    {
      path: '/',
      element: <RootGate />,
      children: [{ index: true, element: <HomeGate /> }],
    },
    {
      element: <RequireAuth />,
      children: [
        { path: 'terminal/connect', element: <TerminalConnectScreen /> },
        // Full-screen voice form — a SIBLING of the AppLayout tree on purpose:
        // AppLayout always renders the sidebar/rail chrome on desktop, and the
        // assistant is designed as a chromeless second form (mobile-first,
        // logo-centered). Sits inside RequireAuth so sync is restored.
        { path: '/assistant', element: <Lazy><AssistantScreen /></Lazy> },
        {
          element: <AppLayout />,
          children: [
            { path: 'board', element: <Lazy><TaskBoardScreen /></Lazy> },
            { path: 'notes', element: <Lazy><NotesScreen /></Lazy> },
            { path: 'todos', element: <Lazy><TodosScreen /></Lazy> },
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
          <PwaInstallPrompt />
        </ModalProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
