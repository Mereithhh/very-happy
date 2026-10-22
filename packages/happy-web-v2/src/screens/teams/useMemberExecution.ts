import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sessionExecution, type AgentExecution } from '@/sync/agentStatus';
import { backgroundTaskCount, isHeartbeatFresh, useHeartbeatLeaseBump } from '@/sync/heartbeatLease';
import { sessionHasPendingRequests } from '@/screens/board/boardItems';
import { runningBackgroundCounts } from '@/screens/board/useBoardItems';
import type { MemberExecution } from './teamTaskState';

/**
 * B-761: a member session's execution by the sidebar / session-board rule
 * (`sessionExecution`), so a team task's「运行中」and the member's own row
 * never disagree. An archived conversation is offline; a session that is not
 * loaded is `undefined` (the caller shows「确认中」, never「运行中」).
 */
export function memberSessionExecution(session: Session | undefined, live: { fresh: boolean; runningSubagents: number; backgroundTasks: number }): AgentExecution | undefined {
    if (!session) return undefined;
    if (session.archivedAt != null) return 'offline';
    return sessionExecution({
        online: session.presence === 'online', active: session.active, fresh: live.fresh, thinking: session.thinking,
        needsInput: sessionHasPendingRequests(session), runningSubagents: live.runningSubagents, backgroundTasks: live.backgroundTasks,
    });
}

/** Store-facing half: re-derives on session changes and heartbeat lease expiry. */
export function useMemberExecution(): MemberExecution {
    const sessions = storage((state) => state.isDataReady ? state.sessions : null);
    const bump = useHeartbeatLeaseBump((s) => s.bump);
    const runningSubagents = storage(useShallow(runningBackgroundCounts));
    return useCallback((sessionId: string) => memberSessionExecution(sessions?.[sessionId], {
        fresh: isHeartbeatFresh(sessionId), runningSubagents: runningSubagents[sessionId] ?? 0, backgroundTasks: backgroundTaskCount(sessionId),
    }), [sessions, runningSubagents, bump]); // `bump`: a lease expiry changes no store state but changes the answer
}
