// @vitest-environment happy-dom
/**
 * B-566 review #1: inside the archive undo window the process is still
 * running server-side. Clicking the archived banner's Restore (or sending,
 * which goes through the same restoreSession) must UNDO the pending archive,
 * not spawn a resume that the deferred archive kills 6 s later.
 * Real storage, real banner, real restoreSession; only the network is faked.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ops = vi.hoisted(() => ({
    sessionArchive: vi.fn(async () => ({ success: true })),
    sessionMarkCompleted: vi.fn(async () => {}),
    machineResumeSession: vi.fn(async () => ({ type: 'success' as const })),
}));
vi.mock('@/sync/ops', async (orig) => ({ ...(await orig<typeof import('@/sync/ops')>()), ...ops }));
const toasts = vi.hoisted(() => ({ undoable: vi.fn(), show: vi.fn(), success: vi.fn(), error: vi.fn(), action: vi.fn() }));
vi.mock('@/ui/Toast', async (orig) => ({ ...(await orig<typeof import('@/ui/Toast')>()), toast: toasts }));

import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { markSessionDoneWithUndo, UNDO_WINDOW_MS } from './rowActions';
import { deferredCommits } from './deferredCommit';
import { resetSessionRestoreForTest, restoreSession } from './sessionRestore';
import { SessionArchivedBanner } from '@/screens/session/SessionArchivedBanner';

function seed(id: string, active: boolean): Session {
    const now = Date.now();
    storage.getState().applyMachines([{ id: 'm1', seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { host: 'h' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 } as never]);
    storage.getState().applySessions([{
        id, seq: 1, createdAt: now, updatedAt: now, active, activeAt: now, archivedAt: null,
        metadata: { machineId: 'm1', path: '/repo', host: 'h', flavor: 'claude', claudeSessionId: '11111111-1111-4111-8111-111111111111', summary: { text: 'T', updatedAt: now } },
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence: active ? 'online' : now,
    } as unknown as Session]);
    return storage.getState().sessions[id];
}

describe('undo window × re-using the session (B-566 review)', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(() => {
        vi.useFakeTimers();
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        vi.clearAllMocks();
        resetSessionRestoreForTest();
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        deferredCommits.flushAll('manual');
        vi.useRealTimers();
    });

    it('banner Restore inside the window = undo: no resume RPC, session live again, never archived', async () => {
        const s = seed('live-1', true);
        markSessionDoneWithUndo(s);
        expect(storage.getState().sessions['live-1'].active).toBe(false);
        await act(async () => root.render(<SessionArchivedBanner sessionId="live-1" />));
        const button = host.querySelector('[data-testid="session-archived-banner"] button') as HTMLButtonElement;
        await act(async () => button.click());
        expect(ops.machineResumeSession).not.toHaveBeenCalled();
        expect(storage.getState().sessions['live-1'].active).toBe(true);
        expect(storage.getState().sessions['live-1'].archivedAt).toBeNull();
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        expect(ops.sessionArchive).not.toHaveBeenCalled();
        // the toast's Undo is now a silent no-op (not "too late")
        (toasts.undoable.mock.calls.at(-1)![2] as () => void)();
        expect(toasts.show).not.toHaveBeenCalled();
    });

    it('composer send path (restoreSession) on a pending mark-done: no kill, no completion record', async () => {
        const s = seed('live-2', true);
        markSessionDoneWithUndo(s);
        expect(await restoreSession('live-2')).toBe(true);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        expect(ops.machineResumeSession).not.toHaveBeenCalled();
        expect(ops.sessionArchive).not.toHaveBeenCalled();
        expect(ops.sessionMarkCompleted).not.toHaveBeenCalled();
    });

    it('a session that was merely OFFLINE before the mark-done click still gets its real restore', async () => {
        const s = seed('off-1', false);
        markSessionDoneWithUndo(s);
        await restoreSession('off-1');
        expect(ops.machineResumeSession).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        expect(ops.sessionArchive).not.toHaveBeenCalled();
    });
});
