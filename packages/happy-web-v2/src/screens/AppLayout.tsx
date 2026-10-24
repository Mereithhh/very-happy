import { AttentionOpenReporter } from '@/screens/projects/AttentionOpenReporter';
import { SessionSearch } from '@/screens/search/SessionSearchPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { useIsDesktop, useMediaQuery } from '@/app/useMediaQuery';
import { appShellMode, nextSidebarParked, TOUCH_DRAWER_MQ } from '@/app/appShellMode';
import { useSidebarPrefs, SIDEBAR_MIN, SIDEBAR_MAX } from '@/app/useSidebarPrefs';
import { useDrawerSwipe } from '@/app/drawerSwipe';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { MajorUpdateEntry } from '@/app/MajorUpdateEntry';
import { CommandPalette } from '@/screens/command/CommandPalette';
import { ClipboardHistoryPanel } from '@/screens/clipboard/ClipboardHistoryPanel';
import { FsPreviewOverlay } from '@/screens/files/FsPreviewOverlay';
import { NotesDock } from '@/screens/notes/NotesDock';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { AppBadgeSync } from '@/screens/notifications/AppBadgeSync';
import { SignInMethodsNudge } from '@/app/SignInMethodsNudge';
import { NotificationOptInCard } from '@/screens/notifications/NotificationOptInCard';
import { FeatureTipHost } from '@/components/featureTips/FeatureTips';
import { useTerminalSync } from '@/sync/terminalSync';
import { useNewTerminalShortcuts } from '@/app/newTerminal';
import { useCloseViewShortcuts, useUnloadGuard } from '@/app/viewShortcuts';
import { useNotificationGenerator } from '@/app/useNotificationGenerator';
import { useSeenTracker } from '@/app/useSeenTracker';
import { usePendingSessionBridge } from '@/sync/pendingSessionsRuntime';
import { prefetchSessionDetailWhenIdle } from '@/app/prefetchSessionDetail';
import { useAllMachines, useIsDataReady, useSessions } from '@/sync/storage';
import { shouldShowFirstRun, shouldShowWorkspaceGuide } from '@/screens/onboarding/firstRun';
import { useSessionInvites } from '@/sync/sessionSharesStore';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { AppShell } from './AppShell';
import './layout.css';
import { RecoverableBoundary } from '@/ui/RecoverableBoundary';
import { useTranslation } from '@/i18n/useTranslation';
import { useRootScrollLock } from '@/app/viewportVars';
import { NetworkBanner } from '@/app/NetworkBanner';

/** `rootPath`: where the phone list lives — `/` in the app; the DEV device harness mounts the shell elsewhere. */
export function AppLayout({ rootPath = '/' }: { rootPath?: string } = {}) {
  const { t } = useTranslation();
  // Singleton terminal sync (daemon pushes + legacy-poll fallback) — lives at
  // layout level so it keeps running with the sidebar collapsed/unmounted
  // (mobile detail, /board).
  useTerminalSync();
  // B-797: the shell never scrolls the document (iPhone Duo cover: 100lvh ran 21px past the web view).
  useRootScrollLock();
  // ⌘N (PWA) / ⌥N (normal tab) → new terminal. Layout level for the same
  // reason: must work with the sidebar collapsed/unmounted.
  useNewTerminalShortcuts();
  useCloseViewShortcuts();
  // Layer 2 of the same guard: in a normal browser tab ⌘W closes the TAB and
  // the page never sees the chord, so the browser's own beforeunload dialog is
  // the only thing that can interrupt it. Armed only on a closable view.
  useUnloadGuard();
  // Notification-center local producer: watches board lifecycle transitions,
  // appends inbox entries + rings the chime. Layout level so it observes
  // everything regardless of which screen is open.
  useNotificationGenerator();
  // Synced read state: watching a session/terminal retires its notifications
  // on every device (writer side; the store owns the KV sync).
  useSeenTracker();
  // B-516: optimistic new sessions — failure toasts get a navigator, records
  // from before a reload resume (landing) or turn interrupted (spawning).
  const navigate = useNavigate();
  usePendingSessionBridge(navigate);
  // …and the session page chunk is warm before the first "new chat".
  useEffect(() => prefetchSessionDetailWhenIdle(), []);
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const atRoot = location.pathname === rootPath || location.pathname === `${rootPath}/` || location.pathname === '';
  const dataReady = useIsDataReady();
  const allMachines = useAllMachines({ includeOffline: true });
  const sessions = useSessions();
  const terminalCount = useTerminalSessions((state) => state.terminals.length);
  // B-619: shared sessions / invitations keep the list reachable on a machine-less account.
  const inviteCount = useSessionInvites().length;
  const firstRun = shouldShowFirstRun(dataReady, allMachines.length, (sessions?.length ?? 0) + inviteCount);
  const workspaceGuide = shouldShowWorkspaceGuide(dataReady, allMachines.length, sessions?.length ?? 0, terminalCount);
  const { width, collapsed, setWidth, setCollapsed, drawerOpen, setDrawer, setDrawerOpen } = useSidebarPrefs();
  const touchDrawer = useMediaQuery(TOUCH_DRAWER_MQ);
  const draggingRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.classList.add('vh-col-resizing');
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      setWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX)));
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('vh-col-resizing');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setWidth]);

  const settings = location.pathname === '/settings' || location.pathname.startsWith('/settings/');
  const mode = appShellMode({ settings, desktop: isDesktop, touchDrawer, collapsed, atRoot, firstRun, workspaceGuide });
  const drawer = mode === 'drawer';
  useEffect(() => setDrawer(drawer), [drawer, setDrawer]);
  // B-800: edge swipe right opens the drawer, swipe left on it closes (follows the finger).
  useDrawerSwipe(drawer);
  // The drawer is a way to pick the next screen: any navigation closes it.
  useEffect(() => setDrawerOpen(false), [location.pathname, setDrawerOpen]);
  useEffect(() => {
    if (!drawer || !drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, drawerOpen, setDrawerOpen]);
  // B-795: a fold that drops the sidebar on the same route parks it (see nextSidebarParked).
  const [parked, setParked] = useState(false);
  const [shellKey, setShellKey] = useState({ mode, pathname: location.pathname });
  if (shellKey.mode !== mode || shellKey.pathname !== location.pathname) {
    const next = { mode, pathname: location.pathname };
    setShellKey(next);
    setParked(nextSidebarParked(parked, shellKey, next));
  }

  return (
    <>
      {/* B-799: 「已离线，正在重连…」 / 「已恢复」 — its own row above the shell */}
      <NetworkBanner />
      <AppShell mode={mode} width={width} onResizeStart={onDragStart} parked={parked}
        drawerOpen={drawerOpen} onDrawerClose={() => setDrawerOpen(false)}
        sidebar={<RecoverableBoundary region="sidebar"><Sidebar /></RecoverableBoundary>}
        rail={<>
          <button className="app-rail-btn" onClick={() => (drawer ? setDrawerOpen(!drawerOpen) : setCollapsed(false))}
            aria-label={t('files.expandSidebar')} title={t('files.expandSidebar')} aria-expanded={drawer ? drawerOpen : undefined}>
            <PanelLeft size={18} />
          </button>
          <NotificationBell />
          <MajorUpdateEntry compact />
        </>}
        notes={<NotesDock />}
      >
        <Outlet />
        {/* B-651 ②: 「等你处理」 → opened latency (renders nothing). */}
        <AttentionOpenReporter />
      </AppShell>
      {/* B-559: inbox unread → PWA app-icon badge (mounted once; the bell is mounted twice) */}
      <AppBadgeSync />
      {/* B-570: non-blocking "turn on notifications" invitation (logged-in app only) */}
      <NotificationOptInCard />
      {/* B-668: email-code-only accounts: add a password or Google (dismissible) */}
      <SignInMethodsNudge />
      {/* B-588: at most one one-time feature tip app-wide */}
      <FeatureTipHost />
      <CommandPalette />
      {/* B-650: cross-session search (sidebar 🔍 / ⌘K / ⌘⇧F) */}
      <SessionSearch />
      {/* clipboard-push history — singleton like the palette (⌘K / settings open it) */}
      <ClipboardHistoryPanel />
      {/* open_preview pushes — singleton overlay opened by sync/filePreviewPush */}
      <FsPreviewOverlay />
    </>
  );
}
