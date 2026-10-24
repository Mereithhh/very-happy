import { RouteError } from './RouteError';
import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { syncRestore } from '@/sync/sync';
import { ThemeProvider, ToastProvider, useToast } from '@/ui';
import { UPDATED_NOTICE_KEY } from '@/app/staleBundleReload';
import { UpdatePrompt } from '@/app/UpdatePrompt';
import { Modal, ModalProvider } from '@/modal';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { AppLayout } from '@/screens/AppLayout';
import { EmptyDetail } from '@/screens/sessions/EmptyDetail';
import { HelpScreen } from '@/screens/help/HelpScreen';
import { useAllMachines, useIsDataReady, useLocalSetting, useSessions } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useGlobalBackNav } from '@/app/appBack';
import { FirstRunScreen } from '@/screens/onboarding/FirstRunScreen';
import { useSessionInvites } from '@/sync/sessionSharesStore';
import { shouldShowFirstRun } from '@/screens/onboarding/firstRun';
import { subscribeFirstMachineConnected } from '@/screens/onboarding/firstMachineWelcome';
import { PrivacyScreen, TermsScreen } from '@/screens/legal/PublicLegalScreen';
import { TerminalConnectScreen } from '@/screens/auth/TerminalConnectScreen';
import { LandingScreen } from '@/screens/public/LandingScreen';
import { BRAND } from './brand';
import { DocsScreen } from '@/screens/public/DocsScreen';
import { PwaInstallPrompt } from './PwaInstallPrompt';
import { CliUpdateBanner } from './CliUpdateBanner';
import { MigrationBanner } from './MigrationBanner';
import { useTranslation } from '@/i18n/useTranslation';
import { RouteLoading } from './RouteLoading';
import { dismissPrepaintSplashWhenRouteReady } from './prepaintSplash';
import { ChangelogNotice } from './ChangelogNotice';
import { AuthExpiredNotice } from './AuthExpiredNotice';
import { installAuthGuards } from './authGuards';
import './appFonts';
import { initVhDiagFlagFromUrl, subscribeVhDiagFlag } from '@/diag/vhDiagFlag';

// B-490: before any sync starts — a rejected token must stop every loop.
installAuthGuards();

// Heavy screens are code-split so the initial bundle stays lean (chat pulls the
// markdown renderer, terminal pulls xterm, settings is large).
const SignupScreen = lazy(() => import('@/screens/auth/SignupScreen').then((m) => ({ default: m.SignupScreen })));
const OidcReturnScreen = lazy(() => import('@/screens/auth/OidcReturnScreen').then((m) => ({ default: m.OidcReturnScreen })));
const MigrateLoginScreen = lazy(() => import('@/screens/auth/MigrateLoginScreen').then((m) => ({ default: m.MigrateLoginScreen })));
const SessionDetailScreen = lazy(() => import('@/screens/session/SessionDetailScreen').then((m) => ({ default: m.SessionDetailScreen })));
const SettingsRoutes = lazy(() => import('@/screens/settings/SettingsRoutes').then((m) => ({ default: m.SettingsRoutes })));
const WebTerminalRoute = lazy(() => import('@/screens/terminal/WebTerminalRoute').then((m) => ({ default: m.WebTerminalRoute })));
const TerminalPickerScreen = lazy(() => import('@/screens/terminal/TerminalPickerScreen').then((m) => ({ default: m.TerminalPickerScreen })));
const MachineScreen = lazy(() => import('@/screens/machine/MachineScreen').then((m) => ({ default: m.MachineScreen })));
const MachinePanelScreen = lazy(() => import('@/screens/machine/MachinePanelScreen').then((m) => ({ default: m.MachinePanelScreen })));
const ConnectMachineScreen = lazy(() => import('@/screens/onboarding/ConnectMachineScreen').then((m) => ({ default: m.ConnectMachineScreen })));
const ProjectScreen = lazy(() => import('@/screens/projects/ProjectScreen').then(m => ({ default: m.ProjectScreen })));
const ProjectSettingsScreen = lazy(() => import('@/screens/projects/ProjectSettingsScreen').then(m => ({ default: m.ProjectSettingsScreen })));
const ProjectsListScreen = lazy(() => import('@/screens/projects/ProjectsListScreen').then(m => ({ default: m.ProjectsListScreen })));
const TeamsScreen = lazy(() => import('@/screens/teams/TeamsScreen').then(m => ({ default: m.TeamsScreen })));
const TaskBoardScreen = lazy(() => import('@/screens/board/TaskBoardScreen').then((m) => ({ default: m.TaskBoardScreen })));
const AutomationsScreen = lazy(() => import('@/screens/automations/AutomationsScreen').then((m) => ({ default: m.AutomationsScreen })));
const AutomationDetailScreen = lazy(() => import('@/screens/automations/AutomationDetailScreen').then((m) => ({ default: m.AutomationDetailScreen })));
const AutomationFormScreen = lazy(() => import('@/screens/automations/AutomationFormScreen').then((m) => ({ default: m.AutomationFormScreen })));
const AssistantScreen = lazy(() => import('@/screens/assistant/AssistantScreen').then((m) => ({ default: m.AssistantScreen })));
const NotesScreen = lazy(() => import('@/screens/notes/NotesScreen').then((m) => ({ default: m.NotesScreen })));
const TodosScreen = lazy(() => import('@/screens/todos/TodosScreen').then((m) => ({ default: m.TodosScreen })));
// B-621: people directory (friends) — the share picker and later Spaces build on it.
const PeopleScreen = lazy(() => import('@/screens/people/PeopleScreen').then((m) => ({ default: m.PeopleScreen })));
const ChangelogScreen = lazy(() => import('@/screens/changelog/ChangelogScreen').then((m) => ({ default: m.ChangelogScreen })));
const WhatsNewScreen = lazy(() => import('@/screens/whatsnew/WhatsNewScreen').then((m) => ({ default: m.WhatsNewScreen })));
// B-599: iOS standalone viewport diagnostics — no auth, reached from 设置 → 诊断.
const ViewportDiagScreen = lazy(() => import('@/diag/ViewportDiagScreen').then((m) => ({ default: m.ViewportDiagScreen })));
const SafeAreaDiagScreen = lazy(() => import('@/diag/SafeAreaDiagScreen').then((m) => ({ default: m.SafeAreaDiagScreen })));
const VhDiagOverlay = lazy(() => import('@/diag/VhDiagOverlay').then((m) => ({ default: m.VhDiagOverlay })));

function Lazy({ children, fullViewport = true, centered = false }: { children: ReactNode; fullViewport?: boolean; centered?: boolean }) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={<RouteLoading fullViewport={fullViewport} centered={centered} label={t('common.loadingWorkspace')} />}
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
  return <><Outlet /><CliUpdateBanner /><MigrationBanner /><FirstMachineWelcome /><ChangelogNotice /><BundleUpdatedNotice /><UpdatePrompt /><AuthExpiredNotice /></>;
}

function RootGate() {
  const { isAuthenticated } = useAuth();
  useGlobalBackNav();
  // B-624: a white-labelled relay has no marketing page — straight to login.
  if (!isAuthenticated) return BRAND.landingEnabled ? <LandingScreen /> : <Navigate to="/login" replace />;
  return <><AppLayout /><CliUpdateBanner /><MigrationBanner /><FirstMachineWelcome /><ChangelogNotice /><BundleUpdatedNotice /><UpdatePrompt /><AuthExpiredNotice /></>;
}

/** B-315: the auto-update reload is silent by design — it must not ask
 *  permission, because a viewer who declines keeps speaking an old protocol
 *  dialect (see staleBundleReload). Silent is not the same as unexplained, so
 *  say it happened once the new shell is up. */
function BundleUpdatedNotice() {
  const toast = useToast();
  const { t } = useTranslation();
  useEffect(() => {
    let updated = false;
    try {
      updated = sessionStorage.getItem(UPDATED_NOTICE_KEY) === '1';
      if (updated) sessionStorage.removeItem(UPDATED_NOTICE_KEY);
    } catch { /* private mode: skip the notice rather than fail the boot */ }
    if (updated) toast.success(t('changelog.bundleUpdated'));
  }, [toast, t]);
  return null;
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
  // B-619: sessions shared with me / invitations count as a reason to show the list.
  const inviteCount = useSessionInvites().length;
  if (!dataReady) {
    return <RouteLoading fullViewport label={t('common.loading')} />;
  }
  if (shouldShowFirstRun(dataReady, machines.length, (sessions?.length ?? 0) + inviteCount)) return <FirstRunScreen />;
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

function LegacyAutomationRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/automations/${encodeURIComponent(id)}`} replace />;
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
const PickerHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/PickerHarness').then((m) => ({ default: m.PickerHarness })))
  : null;
const WorkspaceDesignHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/WorkspaceDesignHarness').then((m) => ({ default: m.WorkspaceDesignHarness })))
  : null;
const WorkspaceNotesHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/WorkspaceFilesHarness').then((m) => ({ default: m.WorkspaceNotesHarness })))
  : null;
const ComposerFeedbackHarness = import.meta.env.DEV ? lazy(() => import('@/dev/ComposerFeedbackHarness').then(m => ({ default: m.ComposerFeedbackHarness }))) : null;
const MediaPreviewHarness = import.meta.env.DEV ? lazy(() => import('@/dev/MediaPreviewHarness').then(m => ({ default: m.MediaPreviewHarness }))) : null;
const FilePreviewHarness = import.meta.env.DEV ? lazy(() => import('@/dev/FilePreviewHarness').then(m => ({ default: m.FilePreviewHarness }))) : null;
const WorkspaceFilesHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/WorkspaceFilesHarness').then((m) => ({ default: m.WorkspaceFilesHarness })))
  : null;
const MobileChatHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/MobileChatHarness').then((m) => ({ default: m.MobileChatHarness })))
  : null;
const ComposerUxHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ComposerUxHarness').then((m) => ({ default: m.ComposerUxHarness })))
  : null;
const DiffViewHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/DiffViewHarness').then((m) => ({ default: m.DiffViewHarness })))
  : null;
const ChatScrollHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ChatScrollHarness').then((m) => ({ default: m.ChatScrollHarness })))
  : null;
const ChangelogHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ChangelogHarness').then((m) => ({ default: m.ChangelogHarness })))
  : null;
const ToolHistoryHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ToolHistoryHarness').then(m => ({default:m.ToolHistoryHarness})))
  : null;
const SubagentHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/SubagentHarness').then((m) => ({ default: m.SubagentHarness })))
  : null;
const MultiAgentHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/MultiAgentHarness').then((m) => ({ default: m.MultiAgentHarness })))
  : null;
const DepthHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/DepthHarness').then((m) => ({ default: m.DepthHarness })))
  : null;
const LeadViewHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/LeadViewHarness').then((m) => ({ default: m.LeadViewHarness })))
  : null;
const BoardHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/BoardHarness').then((m) => ({ default: m.BoardHarness })))
  : null;
const MultiAgentTeamsHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/MultiAgentHarness').then((m) => ({ default: m.MultiAgentTeamsHarness })))
  : null;
const BuiltinToolsHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/BuiltinToolsHarness').then((m) => ({ default: m.BuiltinToolsHarness })))
  : null;
const ToolCardsHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/ToolCardsHarness').then((m) => ({ default: m.ToolCardsHarness })))
  : null;
const RobustnessHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/RobustnessHarness').then((m) => ({ default: m.RobustnessHarness })))
  : null;
const TeamsQaHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/TeamsQaHarness').then((m) => ({ default: m.TeamsQaHarness })))
  : null;
const LocationTrailHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/LocationTrailHarness').then((m) => ({ default: m.LocationTrailHarness })))
  : null;
const DeviceShellHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/DeviceShellHarness').then((m) => ({ default: m.DeviceShellHarness })))
  : null;
const TerminalKeyboardHarness = import.meta.env.DEV
  ? lazy(() => import('@/dev/TerminalKeyboardHarness').then((m) => ({ default: m.TerminalKeyboardHarness })))
  : null;

const router = createBrowserRouter(
  [{ errorElement: <RouteError />, children: [
    ...(SidebarHarness
      ? [
          { path: '/dev/sidebar', element: <Lazy><SidebarHarness /></Lazy> },
          { path: '/dev/settings/*', element: <Lazy><SettingsRoutes basePath="/dev/settings" /></Lazy> },
          // Real post-connect home content without auth/store seeding. This is
          // DEV-only like the sidebar harness and is stripped from prod builds.
          { path: '/dev/workspace-guide', element: <HelpScreen /> },
        ]
      : []),
    ...(OrbitLoaderHarness
      ? [{ path: '/dev/orbit-loader', element: <Lazy><OrbitLoaderHarness /></Lazy> }]
      : []),
    ...(PickerHarness ? [{ path: '/dev/picker', element: <Lazy><PickerHarness /></Lazy> }] : []),
    ...(WorkspaceDesignHarness
      ? [{ path: '/dev/workspace-design', element: <Lazy><WorkspaceDesignHarness /></Lazy> }]
      : []),
    ...(WorkspaceNotesHarness ? [{ path: '/dev/workspace-notes', element: <Lazy><WorkspaceNotesHarness /></Lazy> }] : []),
    ...(ComposerFeedbackHarness ? [{ path: '/dev/composer-feedback', element: <Lazy><ComposerFeedbackHarness /></Lazy> }] : []),
    ...(MediaPreviewHarness ? [{ path: '/dev/media-preview', element: <Lazy><MediaPreviewHarness /></Lazy> }] : []),
    ...(FilePreviewHarness ? [{ path: '/dev/file-preview', element: <Lazy><FilePreviewHarness /></Lazy> }] : []),
    ...(WorkspaceFilesHarness ? [{ path: '/dev/workspace-files', element: <Lazy><WorkspaceFilesHarness /></Lazy> }] : []),
    ...(MobileChatHarness
      ? [{ path: '/dev/mobile-chat', element: <Lazy><MobileChatHarness /></Lazy> }]
      : []),
    ...(ComposerUxHarness
      ? [{ path: '/dev/composer-ux', element: <Lazy><ComposerUxHarness /></Lazy> }]
      : []),
    ...(ChatScrollHarness
      ? [
          { path: '/dev/chat-scroll', element: <Lazy><ChatScrollHarness /></Lazy> },
          // ?full=1: the real SessionDetailScreen reads `:id` from the route.
          { path: '/dev/chat-scroll/session/:id', element: <Lazy><ChatScrollHarness /></Lazy> },
        ]
      : []),
    ...(ChangelogHarness
      ? [
          { path: '/dev/changelog', element: <Lazy><ChangelogHarness /></Lazy> },
          { path: '/dev/changelog-history', element: <Lazy><ChangelogScreen /></Lazy> },
        ]
      : []),
    ...(DiffViewHarness ? [{ path: '/dev/diff-view', element: <Lazy><DiffViewHarness /></Lazy> }] : []),
    ...(ToolHistoryHarness ? [{path:'/dev/tool-history',element:<Lazy><ToolHistoryHarness /></Lazy>}] : []),
    ...(SubagentHarness
      ? [{ path: '/dev/subagent/:id', element: <Lazy><SubagentHarness /></Lazy> }]
      : []),
    ...(MultiAgentHarness && MultiAgentTeamsHarness
      ? [
          { path: '/dev/multi-agent/:id', element: <Lazy><MultiAgentHarness /></Lazy> },
          { path: '/dev/multi-agent-teams', element: <Lazy><MultiAgentTeamsHarness /></Lazy> },
          ...(DepthHarness ? [{ path: '/dev/depth/session/:id', element: <Lazy><DepthHarness /></Lazy> }] : []),
          ...(LeadViewHarness ? [{ path: '/dev/lead-view/session/:id', element: <Lazy><LeadViewHarness /></Lazy> }] : []),
          ...(BoardHarness ? [{ path: '/dev/board/session/:id', element: <Lazy><BoardHarness /></Lazy> }] : []),
        ]
      : []),
    ...(BuiltinToolsHarness
      ? [{ path: '/dev/builtin-tools/:id', element: <Lazy><BuiltinToolsHarness /></Lazy> }]
      : []),
    ...(ToolCardsHarness
      ? [{ path: '/dev/tool-cards/:id', element: <Lazy><ToolCardsHarness /></Lazy> }]
      : []),
    ...(TeamsQaHarness ? [{ path: '/dev/teams-qa', element: <Lazy><TeamsQaHarness /></Lazy> }] : []),
    ...(LocationTrailHarness ? ['session/:sessionId', 'team/:teamId', 'project/:projectId'].map((path) => ({ path: `/dev/location-trail/${path}`, element: <Lazy><LocationTrailHarness /></Lazy> })) : []),
    ...(RobustnessHarness ? [{ path: '/dev/robustness', element: <Lazy><RobustnessHarness /></Lazy> }] : []),
    // B-795: the real AppLayout (sidebar / rail / single-pane) around real screens, for device captures.
    // Settings is single-pane in the app (no sidebar), so captures use `/dev/settings` above.
    ...(DeviceShellHarness
      ? [{
          path: '/dev/device',
          element: <Lazy><DeviceShellHarness /></Lazy>,
          children: [
            // B-798 P2-12: the root detail pane (wide shells), as in the app.
            { index: true, element: <EmptyDetail /> },
            { path: 'session/:id', element: <Lazy><SessionDetailScreen /></Lazy> },
            { path: 'teams/:teamId', element: <Lazy><TeamsScreen /></Lazy> },
            { path: 'projects/:projectId', element: <Lazy><ProjectScreen /></Lazy> },
            // B-796: every secondary page, for the phone back-button / side-inset sweep.
            { path: 'teams', element: <Lazy><TeamsScreen /></Lazy> },
            { path: 'projects', element: <Lazy><ProjectsListScreen /></Lazy> },
            { path: 'projects/:projectId/settings', element: <Lazy><ProjectSettingsScreen /></Lazy> },
            { path: 'automations', element: <Lazy><AutomationsScreen /></Lazy> },
            { path: 'automations/new', element: <Lazy><AutomationFormScreen /></Lazy> },
            { path: 'todos', element: <Lazy><TodosScreen /></Lazy> },
            { path: 'people', element: <Lazy><PeopleScreen /></Lazy> },
            { path: 'notes', element: <Lazy><NotesScreen /></Lazy> },
            { path: 'board', element: <Lazy><TaskBoardScreen /></Lazy> },
            { path: 'help', element: <HelpScreen /> },
            { path: 'terminal', element: <Lazy><TerminalPickerScreen /></Lazy> },
            { path: 'machine/connect', element: <Lazy><ConnectMachineScreen /></Lazy> },
            { path: 'machine/:id', element: <Lazy><MachineScreen /></Lazy> },
            { path: 'settings/*', element: <Lazy><SettingsRoutes basePath="/dev/device/settings" /></Lazy> },
          ],
        }]
      : []),
    ...(TerminalKeyboardHarness
      ? [{ path: '/dev/terminal-keyboard', element: <Lazy><TerminalKeyboardHarness /></Lazy> }]
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
    // B-620: the identity provider sends the browser back here with a one-time
    // handoff; not wrapped in RedirectIfAuthed so a stale session cannot swallow it.
    { path: '/login/oidc', element: <Lazy><OidcReturnScreen /></Lazy> },
    // B-627: arrival from a retiring relay's move banner, ticket in the query.
    { path: '/login/migrate', element: <Lazy><MigrateLoginScreen /></Lazy> },
    { path: '/privacy', element: <PrivacyScreen /> },
    { path: '/terms', element: <TermsScreen /> },
    { path: '/changelog', element: <Lazy><ChangelogScreen /></Lazy> },
    { path: '/whats-new', element: <Lazy><WhatsNewScreen /></Lazy> },
    { path: '/diag/viewport', element: <Lazy><ViewportDiagScreen /></Lazy> },
    // B-796: in production too (not DEV-gated) — the Owner opens it on the device from 设置 → 诊断.
    { path: '/dev/safe-area', element: <Lazy><SafeAreaDiagScreen /></Lazy> },
    { path: '/welcome', element: BRAND.landingEnabled ? <LandingScreen /> : <Navigate to="/login" replace /> },
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
            { path: 'teams', element: <Lazy><TeamsScreen /></Lazy> },
            { path: 'teams/:teamId', element: <Lazy><TeamsScreen /></Lazy> },
            // B-648: project page
            { path: 'projects/:projectId', element: <Lazy><ProjectScreen /></Lazy> },
            // B-757: project settings (the team settings tab's counterpart); #section anchors deep-link.
            { path: 'projects/:projectId/settings', element: <Lazy><ProjectSettingsScreen /></Lazy> },
            // B-756: project list (sidebar capability entry)
            { path: 'projects', element: <Lazy><ProjectsListScreen /></Lazy> },
            { path: 'board', element: <Lazy><TaskBoardScreen /></Lazy> },
            // B-498: automations — sidebar entry + board band; the first cut lived
            // under /board/automations, keep those URLs working.
            { path: 'automations', element: <Lazy><AutomationsScreen /></Lazy> },
            { path: 'automations/new', element: <Lazy><AutomationFormScreen /></Lazy> },
            { path: 'automations/:id', element: <Lazy><AutomationDetailScreen /></Lazy> },
            { path: 'automations/:id/edit', element: <Lazy><AutomationFormScreen /></Lazy> },
            { path: 'board/automations', element: <Navigate to="/automations" replace /> },
            { path: 'board/automations/:id', element: <LegacyAutomationRedirect /> },
            { path: 'notes', element: <Lazy><NotesScreen /></Lazy> },
            { path: 'todos', element: <Lazy><TodosScreen /></Lazy> },
            { path: 'people', element: <Lazy><PeopleScreen /></Lazy> },
            { path: 'session/:id', element: <Lazy><SessionDetailScreen /></Lazy> },
            { path: 'terminal', element: <Lazy><TerminalPickerScreen /></Lazy> },
            { path: 'terminal/:machineId', element: <Lazy fullViewport={false} centered><WebTerminalRoute /></Lazy> },
            // B-296: static segment, so it outranks `machine/:id` in the router.
            { path: 'machine/connect', element: <Lazy><ConnectMachineScreen /></Lazy> },
            { path: 'machine/:id', element: <Lazy><MachineScreen /></Lazy> },
            // B-510: a machine web panel full screen (push click target).
            { path: 'machine/:machineId/panel/:panelId', element: <Lazy fullViewport={false}><MachinePanelScreen /></Lazy> },
            { path: 'settings/*', element: <Lazy><SettingsRoutes /></Lazy> },
          ],
        },
      ],
    },
  ] }],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);

/** B-599: `?vhdiag=1` (or the toggle on /diag/viewport) outlines the real
 *  layout; the chunk only loads when the device flag is on. */
function VhDiagGate() {
  const [on, setOn] = useState(() => initVhDiagFlagFromUrl(window.location.search));
  useEffect(() => subscribeVhDiagFlag(setOn), []);
  if (!on) return null;
  return <Suspense fallback={null}><VhDiagOverlay /></Suspense>;
}

function Splash() {
  const { t } = useTranslation();
  return <RouteLoading fullViewport label={t('common.loadingWorkspace')} />;
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
    if (!booting) return dismissPrepaintSplashWhenRouteReady();
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
          <VhDiagGate />
        </ModalProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
