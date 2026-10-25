/**
 * B-516: the app's pending-session store instance, wired to the real stores,
 * plus the React bindings. The state machine itself lives in
 * ./pendingSessions.ts (dependency-injected, unit-tested without React).
 */
import { dispatchEntryOf, reportProjectUx } from './projectUx';
import { applyLocalMembership, projectsApi, refreshProjects } from './projects';
import { markQuickSession } from '@/screens/projects/newSessionProject';
import { useEffect, useSyncExternalStore } from 'react';
import { randomUUID } from 'expo-crypto';
import { storage } from './storage';
import { sync } from './sync';
import { machineSpawnNewSession, sessionArchive, sessionKill } from './ops';
import { isTabAlive, thisTabId, withTabLock } from './tabLiveness';
import { loadNewChatDraft, loadPendingSessions, loadQueuedMessages, loadSessionDrafts, saveNewChatDraft, savePendingSessions, saveQueuedMessages } from './persistence';
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
const TAB_ID = thisTabId();

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
    async sendMessage(id, text, localId) {
        const receipt = await sync.sendMessage(id, text, { source: 'chat', localId });
        // B-814 §5.5.4: the item leaves this record only once the outbox has it on disk.
        await sync.whenOutboxPersisted(id);
        return receipt;
    },
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
    readDraft,
    stashNewChatDraft: saveNewChatDraft,
    takeNewChatDraft() {
        const text = loadNewChatDraft();
        saveNewChatDraft(null);
        return text;
    },
    writeDraft: (id, text) => storage.getState().updateSessionDraft(id, text),
    killSession(sessionId) {
        void (async () => {
            const killed = await sessionKill(sessionId);
            if (!killed.success) await sessionArchive(sessionId);
        })().catch((error) => console.warn('[pending-session] could not stop a cancelled session', error));
    },
    onSpawned(record, realId) {
        recordRecentMachinePath(record.machineId, record.path);
        // B-757: 快捷新建 opened no dialog — its page says once which project it landed in.
        if (record.source === 'quick') markQuickSession(realId);
        // B-651 ①: where sessions are dispatched from, and whether they land in a project.
        reportProjectUx({ kind: 'dispatch', entry: dispatchEntryOf(record.source), inProject: !!record.onSpawnedProject });
        if (record.onSpawnedTask) useBoardTasks.getState().attachSession(record.onSpawnedTask.taskId, realId);
        // B-648: join the project before the first message goes out (held back by the store).
        if (record.onSpawnedProject) {
            const { projectId } = record.onSpawnedProject;
            applyLocalMembership(projectId, [realId]);
            return projectsApi.addMembers(projectId, [realId]).then(() => { void refreshProjects(); });
        }
    },
    notifyFailure(record) {
        // Not sticky: on a phone a lingering toast covers the header. The
        // sidebar row keeps the failure reachable after it fades.
        toast.show(t('pendingSession.failedToast'), 'error', { onAction: () => navigator?.(`/session/${record.pendingId}`) });
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
