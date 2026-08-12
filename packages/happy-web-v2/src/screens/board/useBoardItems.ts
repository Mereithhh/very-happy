/**
 * Store-facing hooks for the Task Board. The mapping itself lives in
 * boardItems.ts (pure, unit-tested); these hooks only wire the existing
 * stores in — no new data source, no polling (the singleton terminal sync
 * in AppLayout keeps terminal state fresh for every consumer).
 */
import { useEffect, useMemo, useState } from 'react';
import { useAllSessions, useAllMachines, useAttentionSessions } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { buildBoardItems, type BoardItem } from './boardItems';

/** re-derive "waiting 4m" / the 24h ended cutoff even with no store activity */
const TICK_MS = 30_000;

export function useBoardItems(): BoardItem[] {
  const sessions = useAllSessions();
  const terminals = useTerminalSessions((s) => s.terminals);
  const agentStates = useTerminalAgentStates((s) => s.states);
  const machines = useAllMachines({ includeOffline: true });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(
    () => buildBoardItems({ sessions, terminals, agentStates, machines, now }),
    [sessions, terminals, agentStates, machines, now],
  );
}

/** Cheap attention counter for the sidebar badge: attention chat sessions +
 *  needs_input terminals on ONLINE machines (same offline gate as the board;
 *  counts agent-state entries directly so it doesn't recompute the board). */
export function useBoardAttentionCount(): number {
  const sessionCount = useAttentionSessions().length;
  const onlineMachines = useAllMachines(); // online only by default
  const states = useTerminalAgentStates((s) => s.states);
  return useMemo(() => {
    const online = new Set(onlineMachines.map((m) => m.id));
    const terminalCount = Object.values(states).filter(
      (e) => e.state === 'needs_input' && online.has(e.machineId),
    ).length;
    return sessionCount + terminalCount;
  }, [sessionCount, onlineMachines, states]);
}
