import { isHeartbeatFresh, useHeartbeatLeaseBump } from '@/sync/heartbeatLease';
import { isTerminalStatusFresh } from '@/sync/terminalAgentState';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import { currentTurnMessages } from '@/sync/agentLiveness';
import { countRunningSubagentCards } from '@/screens/session/subagentPills';
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
import { useBoardTasks } from '@/sync/boardTasks';
import { visibleTasks } from '@/sync/boardTaskOps';
import { buildBoardItems, buildCompletedEntries, type BoardItem, type CompletedEntry } from './boardItems';

/** re-derive "waiting 4m" / the 24h ended cutoff even with no store activity */
const TICK_MS = 30_000;
const backgroundCounts = new WeakMap<object, number>();
function runningBackgroundCounts(state: ReturnType<typeof storage.getState>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [id, entry] of Object.entries(state.sessionMessages)) {
    let count = backgroundCounts.get(entry);
    if (count === undefined) {
      count = countRunningSubagentCards(currentTurnMessages(entry.messages));
      backgroundCounts.set(entry, count);
    }
    if (count > 0) result[id] = count;
  }
  return result;
}

export function useBoardItems(): BoardItem[] {
  const sessions = useAllSessions();
  const leaseBump = useHeartbeatLeaseBump(s => s.bump);
  // Text deltas must not rebuild the whole sidebar when the live subagent count is unchanged.
  const runningSubagents = storage(useShallow(runningBackgroundCounts));
  const terminals = useTerminalSessions((s) => s.terminals);
  const agentStates = useTerminalAgentStates((s) => s.states);
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
    }),
    [sessions, terminals, agentStates, machines, now, leaseBump, runningSubagents],
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
