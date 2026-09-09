import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { PanelLeft } from 'lucide-react';
import { useIsDesktop } from '@/app/useMediaQuery';
import { useSidebarPrefs, SIDEBAR_MIN, SIDEBAR_MAX } from '@/app/useSidebarPrefs';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { CommandPalette } from '@/screens/command/CommandPalette';
import { ClipboardHistoryPanel } from '@/screens/clipboard/ClipboardHistoryPanel';
import { FsPreviewOverlay } from '@/screens/files/FsPreviewOverlay';
import { NotesDock } from '@/screens/notes/NotesDock';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { useTerminalSync } from '@/sync/terminalSync';
import { useNewTerminalShortcuts } from '@/app/newTerminal';
import { useCloseViewShortcuts, useUnloadGuard } from '@/app/viewShortcuts';
import { useNotificationGenerator } from '@/app/useNotificationGenerator';
import { useSeenTracker } from '@/app/useSeenTracker';
import { useAllMachines, useIsDataReady, useSessions } from '@/sync/storage';
import { shouldShowFirstRun, shouldShowWorkspaceGuide } from '@/screens/onboarding/firstRun';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { AppShell, type AppShellMode } from './AppShell';
import './layout.css';

export function AppLayout() {
  // Singleton terminal sync (daemon pushes + legacy-poll fallback) — lives at
  // layout level so it keeps running with the sidebar collapsed/unmounted
  // (mobile detail, /board).
  useTerminalSync();
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
  const isDesktop = useIsDesktop();
  const location = useLocation();
  const atRoot = location.pathname === '/' || location.pathname === '';
  const dataReady = useIsDataReady();
  const allMachines = useAllMachines({ includeOffline: true });
  const sessions = useSessions();
  const terminalCount = useTerminalSessions((state) => state.terminals.length);
  const firstRun = shouldShowFirstRun(dataReady, allMachines.length);
  const workspaceGuide = shouldShowWorkspaceGuide(dataReady, allMachines.length, sessions?.length ?? 0, terminalCount);
  const { width, collapsed, setWidth, setCollapsed } = useSidebarPrefs();
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
  const mode: AppShellMode = settings ? 'single'
    : isDesktop ? (collapsed ? 'collapsed' : 'expanded')
    : atRoot && !firstRun && !workspaceGuide ? 'list' : 'single';

  return (
    <>
      <AppShell mode={mode} width={width} onResizeStart={onDragStart}
        sidebar={<Sidebar />}
        rail={<>
          <button className="app-rail-btn" onClick={() => setCollapsed(false)} aria-label="expand sidebar" title="Show sidebar">
            <PanelLeft size={18} />
          </button>
          <NotificationBell />
        </>}
        notes={<NotesDock />}
      >
        <Outlet />
      </AppShell>
      <CommandPalette />
      {/* clipboard-push history — singleton like the palette (⌘K / settings open it) */}
      <ClipboardHistoryPanel />
      {/* open_preview pushes — singleton overlay opened by sync/filePreviewPush */}
      <FsPreviewOverlay />
    </>
  );
}
