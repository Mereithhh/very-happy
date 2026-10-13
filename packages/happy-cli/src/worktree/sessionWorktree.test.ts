import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { resolveSessionWorktree } from './sessionWorktree';

function fakeFs(files: Record<string, string>, dirs: string[]) {
    const norm = (p: string) => resolve(p);
    return {
        existsSync: (p: string) => norm(p) in files || dirs.map(norm).includes(norm(p)),
        isDirectory: (p: string) => dirs.map(norm).includes(norm(p)),
        readFileSync: (p: string) => { const v = files[norm(p)]; if (v === undefined) throw new Error('ENOENT'); return v; },
    };
}

describe('B-586 session worktree metadata', () => {
    it('linked worktree → branch from the per-worktree HEAD, found from a subdirectory', () => {
        const fs = fakeFs({
            [resolve('/w/feat/.git')]: 'gitdir: /r/.git/worktrees/feat\n',
            [resolve('/r/.git/worktrees/feat/HEAD')]: 'ref: refs/heads/vh/swift-river\n',
        }, ['/r/.git']);
        expect(resolveSessionWorktree('/w/feat/src/deep', fs)).toEqual({ branch: 'vh/swift-river', root: resolve('/w/feat') });
    });
    it('detached HEAD → branch null', () => {
        const fs = fakeFs({ [resolve('/w/x/.git')]: 'gitdir: /r/.git/worktrees/x', [resolve('/r/.git/worktrees/x/HEAD')]: '0123abcd\n' }, []);
        expect(resolveSessionWorktree('/w/x', fs)).toEqual({ branch: null, root: resolve('/w/x') });
    });
    it('main checkout and submodules are not worktrees', () => {
        expect(resolveSessionWorktree('/r/sub', fakeFs({}, ['/r/.git']))).toBeNull();
        expect(resolveSessionWorktree('/r/mod', fakeFs({ [resolve('/r/mod/.git')]: 'gitdir: ../.git/modules/mod' }, []))).toBeNull();
        expect(resolveSessionWorktree('/tmp/none', fakeFs({}, []))).toBeNull();
    });
});
