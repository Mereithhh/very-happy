import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { syncRestore } from '@/sync/sync';
import { ThemeProvider, ToastProvider } from '@/ui';
import { Modal, ModalProvider } from '@/modal';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { AppLayout } from '@/screens/AppLayout';
import { EmptyDetail } from '@/screens/sessions/EmptyDetail';
import { HelpScreen } from '@/screens/help/HelpScreen';
import { useAllMachines, useIsDataReady, useLocalSetting, useSessions } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useGlobalBackNav } from '@/app/appBack';
import { FirstRunScreen } from '@/screens/onboarding/FirstRunScreen';
import { shouldShowFirstRun } from '@/screens/onboarding/firstRun';
import { subscribeFirstMachineConnected } from '@/screens/onboarding/firstMachineWelcome';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { TerminalConnectScreen } from '@/screens/auth/TerminalConnectScreen';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PwaInstallPrompt } from './PwaInstallPrompt';
import { CliUpdateBanner } from './CliUpdateBanner';
import { useTranslation } from '@/i18n/useTranslation';
import { RouteLoading } from './RouteLoading';
import { dismissPrepaintSplash } from './prepaintSplash';
import { ChangelogNotice } from './ChangelogNotice';
import './appFonts';

// Heavy screens are code-split so the initial bundle stays lean (chat pulls the
// markdown renderer, terminal pulls xterm, settings is large).
const SignupScreen = lazy(() => import('@/screens/auth/SignupScreen').then((m) => ({ default: m.SignupScreen })));
const SessionDetailScreen = lazy(() => import('@/screens/session/SessionDetailScreen').then((m) => ({ default: m.SessionDetailScreen })));
const SettingsRoutes = lazy(() => import('@/screens/settings/SettingsRoutes').then((m) => ({ default: m.SettingsRoutes })));
const WebTerminalRoute = lazy(() => import('@/screens/terminal/WebTerminalRoute').then((m) => ({ default: m.WebTerminalRoute })));
const TerminalPickerScreen = lazy(() => import('@/screens/terminal/TerminalPickerScreen').then((m) => ({ default: m.TerminalPickerScreen })));
const MachineScreen = lazy(() => import('@/screens/machine/MachineScreen').then((m) => ({ default: m.MachineScreen })));
const TaskBoardScreen = lazy(() => import('@/screens/board/TaskBoardScreen').then((m) => ({ default: m.TaskBoardScreen })));
const AssistantScreen = lazy(() => import('@/screens/assistant/AssistantScreen').then((m) => ({ default: m.AssistantScreen })));
const NotesScreen = lazy(() => import('@/screens/notes/NotesScreen').then((m) => ({ default: m.NotesScreen })));
const TodosScreen = lazy(() => import('@/screens/todos/TodosScreen').then((m) => ({ default: m.TodosScreen })));
const ChangelogScreen = lazy(() => import('@/screens/changelog/ChangelogScreen').then((m) => ({ default: m.ChangelogScreen })));

function Lazy({ children, fullViewport = true }: { children: ReactNode; fullViewport?: boolean }) {
  return (
    <Suspense
      fallback={<RouteLoading fullViewport={fullViewport} />}
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
  return <><Outlet /><CliUpdateBanner /><FirstMachineWelcome /><ChangelogNotice /></>;
}

function RootGate() {
  const { isAuthenticated } = useAuth();
  useGlobalBackNav();
  if (!isAuthenticated) return <LandingScreen />;
  return <><AppLayout /><CliUpdateBanner /><FirstMachineWelcome /><ChangelogNotice /></>;
}

function FirstMachineWelcome() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => subscribeFirstMachineConnected(() => {
    navigate('/', { replace: true });
    Modal.alert(
      t('workspaceGuide.firstMachineConnectedTitle'),
      t('workspaceGuide.firstMachineConnectedDescription'),
      [{ text: t('workspaceGuide.exploreWorkspace') }],
    );
  }), [navigate, t]);

  return null;
}

/** `/` home: the classic empty-detail placeholder, or the Task Board when the
 *  device-local homeView preference says so (Settings → Appearance). */
function HomeGate() {
  const { t } = useTranslation();
  const homeView = useLocalSetting('homeView');
  const dataReady = useIsDataReady();
  const machines = useAllMachines({ includeOffline: true });
  const sessions = useSessions();
  const terminalCount = useTerminalSessions((state) => state.terminals.length);
  if (!dataReady) {
    return <RouteLoading fullViewport label={t('common.loading')} />;
  }
  if (shouldShowFirstRun(dataReady, machines.length)) return <FirstRunScreen />;
  if (dataReady && (sessions?.length ?? 0) === 0 && terminalCount === 0) return <HelpScreen />;
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
const OrbitLoaderHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/OrbitLoaderHarness').then((m) => ({ default: m.OrbitLoaderHarness })))
  : null;
const MobileChatHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/MobileChatHarness').then((m) => ({ default: m.MobileChatHarness })))
  : null;
const ChangelogHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ChangelogHarness').then((m) => ({ default: m.ChangelogHarness })))
  : null;

const router = createBrowserRouter(
  [
    ...(SidebarHarness
      ? [
          { path: '/dev/sidebar', element: <Lazy><SidebarHarness /></Lazy> },
          // Real post-connect home content without auth/store seeding. This is
          // DEV-only like the sidebar harness and is stripped from prod builds.
          { path: '/dev/workspace-guide', element: <HelpScreen /> },
        ]
      : []),
    ...(OrbitLoaderHarness
      ? [{ path: '/dev/orbit-loader', element: <Lazy><OrbitLoaderHarness /></Lazy> }]
      : []),
    ...(MobileChatHarness
      ? [{ path: '/dev/mobile-chat', element: <Lazy><MobileChatHarness /></Lazy> }]
      : []),
    ...(ChangelogHarness
      ? [
          { path: '/dev/changelog', element: <Lazy><ChangelogHarness /></Lazy> },
          { path: '/dev/changelog-history', element: <Lazy><ChangelogScreen /></Lazy> },
        ]
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
    { path: '/changelog', element: <Lazy><ChangelogScreen /></Lazy> },
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
        { path: '/assistant', element: <Lazy fullViewport><AssistantScreen /></Lazy> },
        {
          element: <AppLayout />,
          children: [
            { path: 'help', element: <HelpScreen /> },
            { path: 'board', element: <Lazy><TaskBoardScreen /></Lazy> },
            { path: 'notes', element: <Lazy><NotesScreen /></Lazy> },
            { path: 'todos', element: <Lazy><TodosScreen /></Lazy> },
            { path: 'session/:id', element: <Lazy><SessionDetailScreen /></Lazy> },
            { path: 'terminal', element: <Lazy><TerminalPickerScreen /></Lazy> },
            { path: 'terminal/:machineId', element: <Lazy><WebTerminalRoute /></Lazy> },
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
  return <RouteLoading fullViewport />;
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

  useEffect(() => {
    if (!booting) dismissPrepaintSplash();
  }, [booting]);

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
