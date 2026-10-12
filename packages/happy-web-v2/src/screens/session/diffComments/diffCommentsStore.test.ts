import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

installBrowserTestGlobals();

describe('diffCommentsStore', () => {
    let mod: typeof import('./diffCommentsStore');
    beforeAll(async () => {
        mod = await import('./diffCommentsStore');
    });
    const anchor = { side: 'new' as const, startLine: 1, endLine: 1, lines: ['a'], before: null, after: 'b', hash: 'h' };

    it('persists per session under its own MMKV namespace (survives a reload)', () => {
        expect(mod.addDiffComment('s1', 'a.ts', anchor, 'note', 5)).toBe('ok');
        mod.addDiffComment('s2', 'b.ts', anchor, 'other', 5);
        const raw = localStorage.getItem('mmkv:diff-comments:s.s1');
        expect(JSON.parse(raw!)).toMatchObject([{ filePath: 'a.ts', body: 'note', stale: false }]);
        expect(mod.getDiffComments('s2')).toHaveLength(1);
        // stable snapshot for useSyncExternalStore
        expect(mod.getDiffComments('s1')).toBe(mod.getDiffComments('s1'));
    });

    it('edits, re-anchors, deletes and clears only the given session', () => {
        const [c] = mod.getDiffComments('s1');
        mod.updateDiffComment('s1', c.id, { body: 'edited' }, 9);
        expect(mod.getDiffComments('s1')[0]).toMatchObject({ body: 'edited', updatedAt: 9 });
        mod.applyReanchored('s1', [{ ...mod.getDiffComments('s1')[0], startLine: 4, endLine: 4, stale: true }]);
        expect(mod.getDiffComments('s1')[0]).toMatchObject({ startLine: 4, stale: true, updatedAt: 9 });
        mod.deleteDiffComment('s1', c.id);
        expect(mod.getDiffComments('s1')).toEqual([]);
        expect(localStorage.getItem('mmkv:diff-comments:s.s1')).toBeNull();
        mod.clearDiffComments('s2');
        expect(mod.getDiffComments('s2')).toEqual([]);
    });

    it('reports a write that did not land (quota swallowed by the MMKV shim) and keeps the old list', () => {
        mod.addDiffComment('s3', 'a.ts', anchor, 'kept', 1);
        const ls = localStorage as unknown as { setItem: (k: string, v: string) => void };
        const real = ls.setItem;
        ls.setItem = () => { throw new Error('QuotaExceededError'); };
        try {
            expect(mod.addDiffComment('s3', 'a.ts', anchor, 'lost', 2)).toBe('failed');
        } finally {
            ls.setItem = real;
        }
        expect(mod.getDiffComments('s3').map((c) => c.body)).toEqual(['kept']);
        mod.clearDiffComments('s3');
    });

    it('enforces the whole-namespace budget across sessions', () => {
        const big = 'x'.repeat(mod.DIFF_COMMENTS_TOTAL_MAX_CHARS - 2000);
        localStorage.setItem('mmkv:diff-comments:s.other', big);
        expect(mod.addDiffComment('s4', 'a.ts', anchor, 'y'.repeat(3000), 1)).toBe('quota');
        expect(mod.getDiffComments('s4')).toEqual([]);
        localStorage.removeItem('mmkv:diff-comments:s.other');
        expect(mod.addDiffComment('s4', 'a.ts', anchor, 'fits now', 1)).toBe('ok');
    });

    it('logout (clearPersistence) and session deletion clear the drafts namespace', async () => {
        const { clearPersistence, clearDiffCommentDrafts } = await import('@/sync/persistence');
        mod.addDiffComment('s5', 'a.ts', anchor, 'a', 1);
        mod.addDiffComment('s6', 'a.ts', anchor, 'b', 1);
        expect(localStorage.getItem('mmkv:diff-comments:s.s6')).not.toBeNull();
        clearDiffCommentDrafts('s5');
        expect(mod.getDiffComments('s5')).toEqual([]);
        expect(mod.getDiffComments('s6')).toHaveLength(1);
        clearPersistence();
        const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
        expect(keys.filter((k) => k?.startsWith('mmkv:diff-comments:'))).toEqual([]);
        expect(mod.getDiffComments('s6')).toEqual([]);
        expect(mod.getDiffComments('s4')).toEqual([]);
    });
});
