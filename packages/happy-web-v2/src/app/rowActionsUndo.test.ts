// @vitest-environment happy-dom
/**
 * B-566: archive / mark-done no longer ask or act at once — the row hides,
 * an Undo toast runs for UNDO_WINDOW_MS, and only then does the server call
 * (archive → kill) go out. Page exit commits immediately with keepalive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ops = vi.hoisted(() => ({
    sessionArchive: vi.fn(async (_id: string, _o?: { keepalive?: boolean }) => ({ success: true })),
    sessionMarkCompleted: vi.fn(async (_id: string) => {}),
}));
vi.mock('@/sync/ops', () => ({
    ...ops,
    sessionUpdateTitleTags: vi.fn(), machineForgetTerminal: vi.fn(), machineKillTerminal: vi.fn(), machineRestoreTerminal: vi.fn(),
}));
const modal = vi.hoisted(() => ({ confirm: vi.fn(async () => true), alert: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: modal }));
const toasts = vi.hoisted(() => ({ undoable: vi.fn(), show: vi.fn(), success: vi.fn(), error: vi.fn(), action: vi.fn() }));
vi.mock('@/ui/Toast', () => ({ toast: toasts }));
const webhook = vi.hoisted(() => ({ notifyWebhook: vi.fn() }));
vi.mock('@/sync/apiWebhook', () => webhook);
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));

type S = { id: string; active: boolean; archivedAt: number | null; metadata: { summary: { text: string } } };
const store = vi.hoisted(() => {
    const sessions: Record<string, S> = {};
    const api = {
        sessions,
        setSessionActiveLocal: vi.fn((id: string, active: boolean) => { if (sessions[id]) sessions[id] = { ...sessions[id], active }; }),
        setSessionArchivedAtLocal: vi.fn((id: string, at: number | null) => { if (sessions[id]) sessions[id] = { ...sessions[id], archivedAt: at }; }),
    };
    return api;
});
vi.mock('@/sync/storage', () => ({ storage: { getState: () => store } }));

import { archiveSessionWithUndo, confirmArchiveSession, markSessionDoneWithUndo, UNDO_WINDOW_MS } from './rowActions';
import { deferredCommits } from './deferredCommit';

const session = (id: string): S => ({ id, active: true, archivedAt: null, metadata: { summary: { text: `title ${id}` } } });
const lastUndo = () => toasts.undoable.mock.calls.at(-1)![2] as () => void;

describe('undoable archive / done (B-566)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const k of Object.keys(store.sessions)) delete store.sessions[k];
        vi.clearAllMocks();
    });
    afterEach(() => {
        deferredCommits.flushAll('manual');
        vi.useRealTimers();
    });

    it('archive: no confirm, row hidden at once, RPC only after the window', async () => {
        const s = session('s1'); store.sessions.s1 = s;
        expect(await confirmArchiveSession(s as never)).toBe(true);
        expect(modal.confirm).not.toHaveBeenCalled();
        expect(store.sessions.s1.active).toBe(false);
        expect(store.sessions.s1.archivedAt).not.toBeNull();
        expect(toasts.undoable).toHaveBeenCalledWith('Archived', 'Undo', expect.any(Function), UNDO_WINDOW_MS);
        vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
        expect(ops.sessionArchive).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        await vi.runAllTicks();
        expect(ops.sessionArchive).toHaveBeenCalledWith('s1', { keepalive: false });
    });

    it('archive: Undo inside the window restores the row and sends nothing', async () => {
        const s = session('s2'); store.sessions.s2 = s;
        archiveSessionWithUndo(s as never);
        vi.advanceTimersByTime(2000);
        lastUndo()();
        expect(store.sessions.s2.active).toBe(true);
        expect(store.sessions.s2.archivedAt).toBeNull();
        vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
        expect(ops.sessionArchive).not.toHaveBeenCalled();
    });

    it('Undo after the commit says it is too late', async () => {
        const s = session('s3'); store.sessions.s3 = s;
        archiveSessionWithUndo(s as never);
        vi.advanceTimersByTime(UNDO_WINDOW_MS);
        lastUndo()();
        expect(toasts.show).toHaveBeenCalledWith(expect.stringContaining('Already applied'));
    });

    it('done: Undo means no completion record, no kill, no webhook', async () => {
        const s = session('s4'); store.sessions.s4 = s;
        markSessionDoneWithUndo(s as never);
        expect(toasts.undoable).toHaveBeenCalledWith('Marked done', 'Undo', expect.any(Function), UNDO_WINDOW_MS);
        lastUndo()();
        vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
        await vi.runAllTicks();
        expect(ops.sessionMarkCompleted).not.toHaveBeenCalled();
        expect(ops.sessionArchive).not.toHaveBeenCalled();
        expect(webhook.notifyWebhook).not.toHaveBeenCalled();
    });

    it('done: after the window — completion record, then archive, then webhook', async () => {
        const s = session('s5'); store.sessions.s5 = s;
        markSessionDoneWithUndo(s as never);
        expect(ops.sessionMarkCompleted).not.toHaveBeenCalled();
        vi.advanceTimersByTime(UNDO_WINDOW_MS);
        await vi.waitFor(() => expect(webhook.notifyWebhook).toHaveBeenCalled());
        expect(ops.sessionMarkCompleted.mock.invocationCallOrder[0]).toBeLessThan(ops.sessionArchive.mock.invocationCallOrder[0]);
        expect(webhook.notifyWebhook.mock.calls[0][1]).toMatchObject({ title: '✅ 已完成 · title s5', sessionId: 's5' });
    });

    it('closing the page inside the window commits immediately with keepalive', async () => {
        const a = session('s6'); store.sessions.s6 = a;
        const b = session('s7'); store.sessions.s7 = b;
        archiveSessionWithUndo(a as never);
        markSessionDoneWithUndo(b as never);
        window.dispatchEvent(new Event('pagehide'));
        await vi.runAllTicks();
        await Promise.resolve();
        expect(ops.sessionArchive).toHaveBeenCalledWith('s6', { keepalive: true });
        // done on unload: archive issued in the same task, completion fired alongside
        expect(ops.sessionArchive).toHaveBeenCalledWith('s7', { keepalive: true });
        expect(ops.sessionMarkCompleted).toHaveBeenCalledWith('s7');
        expect(deferredCommits.pendingKeys()).toEqual([]);
    });

    it('done on page exit: completion record, archive AND webhook all issued synchronously, webhook keepalive', async () => {
        const s = session('s10'); store.sessions.s10 = s;
        // archive never resolves: nothing after an await may be relied on once the page is gone
        ops.sessionArchive.mockImplementationOnce(() => new Promise(() => {}) as never);
        markSessionDoneWithUndo(s as never);
        window.dispatchEvent(new Event('pagehide'));
        await Promise.resolve(); await Promise.resolve();
        expect(ops.sessionMarkCompleted).toHaveBeenCalledWith('s10');
        expect(webhook.notifyWebhook).toHaveBeenCalledWith(expect.anything(), { title: '✅ 已完成 · title s10', sessionId: 's10' }, { keepalive: true });
        expect(ops.sessionArchive).toHaveBeenCalledWith('s10', { keepalive: true });
    });

    it('hidden tab: commits with keepalive, and a failure still rolls the row back and explains why', async () => {
        ops.sessionArchive.mockResolvedValueOnce({ success: false, message: 'Server error: 503' } as never);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const s = session('s11'); store.sessions.s11 = s;
        archiveSessionWithUndo(s as never);
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        expect(ops.sessionArchive).toHaveBeenCalledWith('s11', { keepalive: true });
        await vi.waitFor(() => expect(modal.alert).toHaveBeenCalled());
        expect(String(modal.alert.mock.calls[0][1])).toContain('Server error: 503');
        expect(store.sessions.s11.active).toBe(true);
        expect(store.sessions.s11.archivedAt).toBeNull();
        err.mockRestore();
    });

    it('real teardown (pagehide): failure rolls back silently — nobody left to alert', async () => {
        ops.sessionArchive.mockResolvedValueOnce({ success: false, message: 'x' } as never);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const s = session('s12'); store.sessions.s12 = s;
        archiveSessionWithUndo(s as never);
        window.dispatchEvent(new Event('pagehide'));
        await vi.waitFor(() => expect(err).toHaveBeenCalled());
        expect(modal.alert).not.toHaveBeenCalled();
        err.mockRestore();
    });

    it('switching sessions does not cancel or hurry the window (module-level queue)', async () => {
        const s = session('s8'); store.sessions.s8 = s;
        archiveSessionWithUndo(s as never);
        // "navigate away": nothing in the archive path is tied to a component;
        // only time or page exit commits it.
        window.history.pushState({}, '', '/session/other');
        window.dispatchEvent(new PopStateEvent('popstate'));
        vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
        expect(ops.sessionArchive).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        await vi.runAllTicks();
        expect(ops.sessionArchive).toHaveBeenCalledWith('s8', { keepalive: false });
    });

    it('a failed commit rolls the row back and alerts', async () => {
        ops.sessionArchive.mockResolvedValueOnce({ success: false, message: 'boom' } as never);
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const s = session('s9'); store.sessions.s9 = s;
        archiveSessionWithUndo(s as never);
        vi.advanceTimersByTime(UNDO_WINDOW_MS);
        await vi.waitFor(() => expect(modal.alert).toHaveBeenCalled());
        expect(store.sessions.s9.active).toBe(true);
        expect(store.sessions.s9.archivedAt).toBeNull();
        err.mockRestore();
    });
});
