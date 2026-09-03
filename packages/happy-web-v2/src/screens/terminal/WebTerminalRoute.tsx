import { lazy, useEffect, useRef } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useLocalSetting } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import {
  isTerminalViewRedirectWindowOpen,
  resolveTerminalOpenPath,
} from '@/sync/terminalViewPref';

// Intentionally nested behind the face resolver: a board/notification link to
// an already-known structured mirror must not download or initialize xterm.
const WebTerminalScreen = lazy(() => import('./WebTerminalScreen').then((m) => ({
  default: m.WebTerminalScreen,
})));

/**
 * Resolve a mirrored terminal's preferred face before mounting either page.
 * The short window preserves the existing no-yank rule: Claude launched much
 * later must not pull somebody out of a terminal they are actively typing in.
 */
export function WebTerminalRoute() {
  const { machineId } = useParams<{ machineId: string }>();
  const [params] = useSearchParams();
  const tid = params.get('tid') ?? undefined;
  const terminals = useTerminalSessions((s) => s.terminals);
  const meta = terminals.find((x) => x.id === tid);
  const viewDefault = useLocalSetting('terminalViewDefault');
  const viewOverrides = useLocalSetting('terminalViewOverrides');
  // B-324: opening a terminal is what clears its 未读 red dot, and registering
  // it as "being viewed" stops a run that finishes under the user's eyes from
  // marking it. Lives here, not in WebTerminalScreen: this component already
  // owns `tid`, it mounts on both faces (it may redirect to the structured
  // mirror), and WebTerminalScreen is a declared conflict hot zone.
  useEffect(() => {
    if (!tid) return;
    const store = useTerminalAgentStates.getState();
    store.setViewingTerminal(tid);
    store.markTerminalRead(tid);
    return () => {
      if (useTerminalAgentStates.getState().viewingTerminalId === tid) {
        useTerminalAgentStates.getState().setViewingTerminal(null);
      }
    };
  }, [tid]);
  const routeWindowRef = useRef({ tid, openedAt: Date.now() });
  if (routeWindowRef.current.tid !== tid) {
    routeWindowRef.current = { tid, openedAt: Date.now() };
  }

  if (machineId && tid && isTerminalViewRedirectWindowOpen(routeWindowRef.current.openedAt, Date.now())) {
    const target = resolveTerminalOpenPath({
      machineId,
      terminalId: tid,
      mirrorSessionId: meta?.mirrorSessionId,
      defaultView: viewDefault,
      overrides: viewOverrides,
    });
    if (target.startsWith('/session/')) return <Navigate to={target} replace />;
  }

  return <WebTerminalScreen />;
}
