import { backgroundTaskCount, heartbeatLastHeardAt, isHeartbeatFresh, useHeartbeatLeaseBump } from '@/sync/heartbeatLease';
import { isTerminalStatusFresh } from '@/sync/terminalAgentState';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import { runningSubagentsInCurrentTurn } from '@/screens/session/transcriptMessages';
/**
 * Store-facing hooks for the Task Board. The mapping itself lives in
 * boardItems.ts (pure, unit-tested); these hooks only wire the existing
 * stores in — no new data source, no polling (the singleton terminal sync
 * in AppLayout keeps terminal state fresh for every consumer).
 */
import { useEffect, useMemo, useState } from 'react';
import { useAllSessions, useAllMachines } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { useActivityOverlay } from '@/sync/activityOverlayStore';
import { useBoardTasks } from '@/sync/boardTasks';
import { visibleTasks } from '@/sync/boardTaskOps';
import { buildBoardItems, buildCompletedEntries, type BoardItem, type CompletedEntry } from './boardItems';
import { sessionPreview, type SessionPreview } from './sessionPreview';

/** re-derive "waiting 4m" / the 24h ended cutoff even with no store activity */
const TICK_MS = 30_000;
const backgroundCounts = new WeakMap<object, number>();
/** Exported for the B-561 regression test only. */
export function runningBackgroundCounts(state: ReturnType<typeof storage.getState>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [id, entry] of Object.entries(state.sessionMessages)) {
    let count = backgroundCounts.get(entry);
    if (count === undefined) {
      // B-561: entry.messages is newest-first; the helper reverses it into the
      // transcript's oldest-first view before cutting the current turn.
      count = runningSubagentsInCurrentTurn(entry.messages);
      backgroundCounts.set(entry, count);
    }
    if (count > 0) result[id] = count;
  }
  return result;
}

/** B-553: preview per messages array — the store replaces the array on every
 *  change, so a hit means nothing changed and the selector returns the SAME
 *  object (no re-render). Not part of useBoardItems: the sidebar consumes that
 *  hook too, and streaming deltas must not rebuild the whole sidebar. */
const previews = new WeakMap<object, SessionPreview | null>();

/** Latest-round preview from messages this tab already holds — never fetches. */
export function useSessionPreview(sessionId: string | null): SessionPreview | null {
  return storage((state) => {
    const messages = sessionId ? state.sessionMessages[sessionId]?.messages : undefined;
    if (!messages) return null;
    let preview = previews.get(messages);
    if (preview === undefined) {
      preview = sessionPreview(messages);
      previews.set(messages, preview);
    }
    return preview;
  });
}

export function useBoardItems(): BoardItem[] {
  const sessions = useAllSessions();
  const leaseBump = useHeartbeatLeaseBump(s => s.bump);
  // Text deltas must not rebuild the whole sidebar when the live subagent count is unchanged.
  const runningSubagents = storage(useShallow(runningBackgroundCounts));
  const terminals = useTerminalSessions((s) => s.terminals);
  const agentStates = useTerminalAgentStates((s) => s.states);
  // B-465: realtime activity for the legacy-daemon estimate (remote lane only —
  // local stamps are this browser's own actions, not the agent's).
  const remoteActivity = useActivityOverlay((s) => s.remote);
  const machines = useAllMachines({ includeOffline: true });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(
    () => buildBoardItems({ sessions, terminals, agentStates, machines, now,
      sessionFresh:Object.fromEntries(sessions.map(s=>[s.id,isHeartbeatFresh(s.id)])),
      terminalFresh:Object.fromEntries(terminals.map(t=>[t.id,isTerminalStatusFresh(t.id,agentStates[t.id])])),
      runningSubagents,
      // B-507: heartbeat-reported background tasks; leaseBump re-derives on a
      // count change and on lease expiry (both tick the same store).
      backgroundTasks:Object.fromEntries(sessions.flatMap(s=>{ const n=backgroundTaskCount(s.id); return n>0 ? [[s.id,n]] : []; })),
      // B-558: display-only start of "no update for N" (never judges liveness).
      lastHeardAt:Object.fromEntries(sessions.flatMap(s=>{ const at=heartbeatLastHeardAt(s.id); return at!==undefined ? [[s.id,at]] : []; })),
      terminalActivity:Object.fromEntries(terminals.flatMap(t=>{ const at=remoteActivity[`t:${t.id}`]; return typeof at==='number' ? [[t.id,at]] : []; })),
    }),
    [sessions, terminals, agentStates, machines, now, leaseBump, runningSubagents, remoteActivity],
  );
}

/** Done-column records: sessions completed via ✓ (metadata.completedAt) +
 *  board tasks marked done, both within the 24h window, newest first. Uses
 *  state the board already syncs — no new data source. */
export function useBoardCompleted(now: number): CompletedEntry[] {
  const sessions = useAllSessions();
  const tasks = useBoardTasks((s) => s.tasks);
  return useMemo(
    () => buildCompletedEntries(sessions, visibleTasks(tasks), now),
    [sessions, tasks, now],
  );
}
