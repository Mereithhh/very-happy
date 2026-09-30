/**
 * B-516: the app's pending-session store instance, wired to the real stores,
 * plus the React bindings. The state machine itself lives in
 * ./pendingSessions.ts (dependency-injected, unit-tested without React).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { randomUUID } from 'expo-crypto';
import { storage } from './storage';
import { sync } from './sync';
import { machineSpawnNewSession, sessionArchive, sessionKill } from './ops';
import { holdTabLiveness, isTabAlive, withTabLock } from './tabLiveness';
import { loadPendingSessions, loadQueuedMessages, loadSessionDrafts, savePendingSessions, saveQueuedMessages } from './persistence';
import { useBoardTasks } from './boardTasks';
import { normalizeAgentKey } from './agentDefaults';
import {
    createPendingSessionStore,
    findAdoptableSession,
    isPendingSessionId,
    migratePendingDraft,
    type PendingSessionRecord,
} from './pendingSessions';
import { hasComposer, mergeRestoredDraft, restoreToComposer } from '@/screens/session/composerRestore';
import { recordRecentMachinePath } from '@/app/recentMachinePath';
import { newSessionTimingCancel, newSessionTimingRpcReturned, newSessionTimingRpcSent } from '@/app/newSessionTiming';
import { toast } from '@/ui/Toast';
import { t } from '@/text';

/** Spawn is ~1 s; a real session that has not reached the store after this goes to its draft. */
const SESSION_WAIT_MS = 30_000;
/** How often a tab looks for pending records whose owner tab has gone away. */
const RECLAIM_INTERVAL_MS = 30_000;
const PENDING_STORAGE_SUFFIX = ':pending-sessions-v1';

/** This page load's identity; records it creates are owned by it. */
const TAB_ID = randomUUID();
holdTabLiveness(TAB_ID);

let navigator: ((to: string) => void) | null = null;

function readDraft(id: string): string {
    return storage.getState().sessions[id]?.draft ?? loadSessionDrafts()[id] ?? '';
}

/** Delete the per-session keys a pending composer may have written (draft, queue, mode). */
export function clearPendingSessionKeys(pendingId: string): void {
    if (!isPendingSessionId(pendingId)) return;
    const state = storage.getState();
    state.updateSessionDraft(pendingId, null);
    state.updateSessionPermissionMode(pendingId, null);
    const queues = loadQueuedMessages();
    if (pendingId in queues) {
        delete queues[pendingId];
        saveQueuedMessages(queues);
    }
}

export const pendingSessions = createPendingSessionStore({
    tabId: TAB_ID,
    isOwnerAlive: isTabAlive,
    withClaimLock: (fn) => withTabLock('vh-pending-sessions-claim', fn),
    async spawn(options) {
        newSessionTimingRpcSent();
        let result = await machineSpawnNewSession(options);
        // 铁律 17: an RPC can resolve with `{ error }` — that is a transport
        // failure (the daemon may still have spawned), not a daemon answer.
        const known = result?.type === 'success' || result?.type === 'error' || result?.type === 'requestToApproveDirectoryCreation';
        if (!known) {
            const raw = result as unknown as { error?: unknown };
            result = { type: 'error', errorMessage: typeof raw?.error === 'string' ? raw.error : 'Failed to spawn session', transport: true };
        }
        if (result.type === 'success') newSessionTimingRpcReturned(result.sessionId);
        else newSessionTimingCancel();
        return result;
    },
    hasSession: (id) => !!storage.getState().sessions[id],
    subscribeSessions: (listener) => storage.subscribe(listener),
    sendMessage: (id, text) => sync.sendMessage(id, text, { source: 'chat' }),
    writePermissionMode: (id, mode) => storage.getState().updateSessionPermissionMode(id, mode),
    writeModelMode: (id, mode) => storage.getState().updateSessionModelMode(id, mode),
    writeEffortLevel: (id, level) => storage.getState().updateSessionEffortLevel(id, level),
    restoreText(id, text, composerId) {
        if (composerId && restoreToComposer(composerId, text)) return;
        if (restoreToComposer(id, text)) return;
        storage.getState().updateSessionDraft(id, mergeRestoredDraft(text, readDraft(id)));
    },
    migrateDraft(pendingId, realId) {
        migratePendingDraft(pendingId, realId, {
            hasComposer,
            readDraft,
            restoreToComposer,
            writeDraft: (id, text) => storage.getState().updateSessionDraft(id, text),
            clearKeys: clearPendingSessionKeys,
        });
    },
    clearKeys: clearPendingSessionKeys,
    killSession(sessionId) {
        void (async () => {
            const killed = await sessionKill(sessionId);
            if (!killed.success) await sessionArchive(sessionId);
        })().catch((error) => console.warn('[pending-session] could not stop a cancelled session', error));
    },
    onSpawned(record, realId) {
        recordRecentMachinePath(record.machineId, record.path);
        if (record.onSpawnedTask) useBoardTasks.getState().attachSession(record.onSpawnedTask.taskId, realId);
    },
    notifyFailure(record) {
        toast.action(t('pendingSession.failedToast'), () => navigator?.(`/session/${record.pendingId}`));
    },
    load: loadPendingSessions,
    save: savePendingSessions,
    now: () => Date.now(),
    newId: () => randomUUID().replace(/-/g, '').slice(0, 16),
    sessionWaitMs: SESSION_WAIT_MS,
});

export { isPendingSessionId };

/** Initial composer text of a pending page (a pending id has no session to carry `draft`). */
export function pendingDraft(pendingId: string): string {
    return readDraft(pendingId);
}

/** The pending record a `/session/:id` route belongs to (pending id or its real id). */
export function usePendingRecord(routeId: string | undefined): PendingSessionRecord | undefined {
    return useSyncExternalStore(pendingSessions.subscribe, () => pendingSessions.forRoute(routeId), () => undefined);
}

let listCache: { version: number; list: PendingSessionRecord[] } | null = null;
function listSnapshot(): PendingSessionRecord[] {
    const version = pendingSessions.version();
    if (!listCache || listCache.version !== version) listCache = { version, list: pendingSessions.list() };
    return listCache.list;
}
export function usePendingList(): PendingSessionRecord[] {
    return useSyncExternalStore(pendingSessions.subscribe, listSnapshot, listSnapshot);
}

/** Lost-ack candidate for a failed record (null when nothing matches). */
export function useAdoptableSession(record: PendingSessionRecord | undefined): string | null {
    return storage((state) => {
        if (!record || record.state !== 'failed') return null;
        const claimed = new Set(pendingSessions.list().flatMap((r) => (r.realId ? [r.realId] : [])));
        return findAdoptableSession(record, Object.values(state.sessions), normalizeAgentKey, claimed);
    });
}

/** Mounted once in AppLayout: gives failure toasts a navigator and resumes records after a reload. */
export function usePendingSessionBridge(navigate: (to: string) => void): void {
    useEffect(() => {
        navigator = navigate;
        return () => { if (navigator === navigate) navigator = null; };
    }, [navigate]);
    useEffect(() => {
        void pendingSessions.resume();
        // Other tabs' writes (create / land / discard) — refresh memory, then
        // pick up anything a closed tab left behind.
        const onStorage = (event: StorageEvent) => {
            if (event.key === null || event.key.endsWith(PENDING_STORAGE_SUFFIX)) pendingSessions.refresh();
        };
        window.addEventListener('storage', onStorage);
        const timer = setInterval(() => { void pendingSessions.resume(); }, RECLAIM_INTERVAL_MS);
        return () => {
            window.removeEventListener('storage', onStorage);
            clearInterval(timer);
        };
    }, []);
}
