import { apiSocket } from '@/sync/apiSocket';
import { machineSpawnNewSession } from '@/sync/ops';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { startCodexHandoff, type HandoffDeps, type HandoffLabels, type HandoffResult } from './codexHandoff';

const deps: HandoffDeps = {
    rpc: (machineId, method, args) => apiSocket.machineRPC<unknown, Record<string, string>>(machineId, method, args, { timeoutMs: 30_000 }),
    spawn: machineSpawnNewSession,
    loadedMessages: (sessionId) => storage.getState().sessionMessages[sessionId]?.messages ?? [],
    setDraft: (sessionId, draft) => storage.getState().updateSessionDraft(sessionId, draft),
    refresh: () => sync.refreshSessions(),
};

/** B-901: 「新开 Codex 会话（带上摘要）」 with the live store and machine RPC. */
export function runCodexHandoff(session: Session, labels: HandoffLabels): Promise<HandoffResult> {
    return startCodexHandoff(session, labels, deps);
}
