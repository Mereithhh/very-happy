import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    inspect: vi.fn(), remove: vi.fn(), confirm: vi.fn(), alert: vi.fn(), archive: vi.fn(), toast: vi.fn(), sessions: {} as Record<string, unknown>,
}));
vi.mock('@/sync/worktreeOps', () => ({ worktreeInspect: mocks.inspect, worktreeRemove: mocks.remove }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm, alert: mocks.alert } }));
vi.mock('./rowActions', () => ({ archiveSessionNow: mocks.archive }));
vi.mock('@/ui/Toast', () => ({ toast: { show: mocks.toast } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: mocks.sessions }) } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
import { archiveAndDeleteWorktree, canArchiveAndDeleteWorktree, otherSessionsInWorktree } from './worktreeArchive';
import type { Session } from '@/sync/storageTypes';

const session = (id: string, extra: Record<string, unknown> = {}) => ({
    id, archivedAt: null, metadata: { machineId: 'm', path: '/wt/a', host: 'h', worktree: { branch: 'vh/a', root: '/wt/a' } }, ...extra,
}) as unknown as Session;

beforeEach(() => {
    for (const fn of [mocks.inspect, mocks.remove, mocks.confirm, mocks.alert, mocks.archive, mocks.toast]) fn.mockReset();
    mocks.sessions = {};
    mocks.archive.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue({ ok: true, data: { removed: true, branch: 'vh/a' } });
});

describe('B-586 archive + delete worktree', () => {
    it('only for a live worktree session on a capable daemon', () => {
        const capable = { metadata: { worktreeVersion: 1 } };
        expect(canArchiveAndDeleteWorktree(session('s'), capable)).toBe(true);
        expect(canArchiveAndDeleteWorktree(session('s'), { metadata: {} })).toBe(false);
        expect(canArchiveAndDeleteWorktree(session('s', { archivedAt: 1 }), capable)).toBe(false);
        expect(canArchiveAndDeleteWorktree(session('s', { metadata: { machineId: 'm', path: '/x', host: 'h' } }), capable)).toBe(false);
    });

    it('counts other live sessions in the same worktree', () => {
        const all = [session('a'), session('b'), session('c', { archivedAt: 5 }), session('d', { metadata: { machineId: 'm', path: '/wt/a/sub', host: 'h' } }), session('e', { metadata: { machineId: 'other', path: '/wt/a', host: 'h' } })];
        expect(otherSessionsInWorktree(all[0], all)).toBe(2);
    });

    it('clean worktree: one confirm, archive BEFORE remove, no discard', async () => {
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: true, dirty: [], dirtyCount: 0, branch: 'vh/a' } });
        mocks.confirm.mockResolvedValue(true);
        const order: string[] = [];
        mocks.archive.mockImplementation(async () => { order.push('archive'); });
        mocks.remove.mockImplementation(async () => { order.push('remove'); return { ok: true, data: { removed: true } }; });
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(true);
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.confirm.mock.calls[0][2]).toMatchObject({ destructive: true });
        expect(order).toEqual(['archive', 'remove']);
        expect(mocks.remove).toHaveBeenCalledWith('m', '/wt/a', false, undefined);
    });

    it('dirty worktree: second destructive confirm; declining it changes nothing', async () => {
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: true, dirty: ['a.ts', 'b.ts'], dirtyCount: 2, branch: 'vh/a' } });
        mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(false);
        expect(mocks.confirm).toHaveBeenCalledTimes(2);
        expect(mocks.confirm.mock.calls[1][1]).toContain('a.ts, b.ts');
        expect(mocks.archive).not.toHaveBeenCalled();
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it('dirty worktree confirmed twice → remove with discardChanges', async () => {
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: true, dirty: ['a.ts'], dirtyCount: 1, branch: 'vh/a' } });
        mocks.confirm.mockResolvedValue(true);
        await archiveAndDeleteWorktree(session('s'));
        expect(mocks.remove).toHaveBeenCalledWith('m', '/wt/a', true, undefined);
    });

    it('not removable / old daemon / failed archive: explain, delete nothing', async () => {
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: false, reason: 'owned-by-teams', dirty: [], dirtyCount: 0, branch: null } });
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(false);
        expect(mocks.alert.mock.calls[0][1]).toContain('team');
        mocks.inspect.mockResolvedValue({ ok: false, error: 'Method not found', unsupported: true });
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(false);
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: true, dirty: [], dirtyCount: 0, branch: 'vh/a' } });
        mocks.confirm.mockResolvedValue(true);
        mocks.archive.mockRejectedValue(new Error('offline'));
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(false);
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it('低7: changes moved after the confirm → asks again (no archive, no delete until re-confirmed)', async () => {
        const dirty = (fp: string) => ({ ok: true, data: { removable: true, dirty: ['a.ts'], dirtyCount: 1, dirtyFingerprint: fp, branch: 'vh/a' } });
        mocks.inspect.mockResolvedValueOnce(dirty('f1')).mockResolvedValueOnce(dirty('f2')).mockResolvedValueOnce(dirty('f2')).mockResolvedValueOnce(dirty('f2'));
        mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect(await archiveAndDeleteWorktree(session('s'))).toBe(false);
        expect(mocks.confirm.mock.calls[2][1]).toContain('changed after you confirmed');
        expect(mocks.archive).not.toHaveBeenCalled();
        expect(mocks.remove).not.toHaveBeenCalled();
    });

    it('passes the confirmed fingerprint to the daemon as the final guard', async () => {
        mocks.inspect.mockResolvedValue({ ok: true, data: { removable: true, dirty: ['a.ts'], dirtyCount: 1, dirtyFingerprint: 'f1', branch: 'vh/a' } });
        mocks.confirm.mockResolvedValue(true);
        await archiveAndDeleteWorktree(session('s'));
        expect(mocks.remove).toHaveBeenCalledWith('m', '/wt/a', true, 'f1');
    });
});
