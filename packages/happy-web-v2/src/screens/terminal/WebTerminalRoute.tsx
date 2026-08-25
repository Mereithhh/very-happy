import { lazy, useRef } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useLocalSetting } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
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
