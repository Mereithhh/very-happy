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
        expect(mod.addDiffComment('s1', 'a.ts', anchor, 'note', 5)).toBe(true);
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
});
