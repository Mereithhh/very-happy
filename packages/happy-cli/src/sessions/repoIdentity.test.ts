import { describe, expect, it } from 'vitest'
import { isPeerInScope, resolveRepoIdentity, type RepoFs } from './repoIdentity'

function fakeFs(entries: Record<string, 'dir' | string>): RepoFs {
    return {
        existsSync: (p) => p in entries,
        isDirectory: (p) => entries[p] === 'dir',
        readFileSync: (p) => { const v = entries[p]; if (v === undefined || v === 'dir') throw new Error('ENOENT'); return v },
    }
}

describe('resolveRepoIdentity (B-497)', () => {
    it('finds the toplevel of a main checkout from a nested directory', () => {
        const fs = fakeFs({ '/home/me/repo/.git': 'dir' })
        expect(resolveRepoIdentity('/home/me/repo/packages/cli/src', fs)).toEqual({ root: '/home/me/repo', common: '/home/me/repo/.git' })
    })

    it('maps a linked worktree to the main repository common dir', () => {
        const fs = fakeFs({ '/tmp/wt/b497/.git': 'gitdir: /home/me/repo/.git/worktrees/b497\n' })
        expect(resolveRepoIdentity('/tmp/wt/b497/packages', fs)).toEqual({ root: '/tmp/wt/b497', common: '/home/me/repo/.git' })
    })

    it('resolves a relative gitdir and keeps an unfamiliar gitdir as its own common dir', () => {
        const relative = fakeFs({ '/a/b/.git': 'gitdir: ../.gitmeta/worktrees/x' })
        expect(resolveRepoIdentity('/a/b', relative)).toEqual({ root: '/a/b', common: '/a/.gitmeta/worktrees/x' })
    })

    it('returns nulls outside any repository', () => {
        expect(resolveRepoIdentity('/nowhere/at/all', fakeFs({}))).toEqual({ root: null, common: null })
    })
})

describe('isPeerInScope', () => {
    const main = { cwd: '/home/me/repo', repo: { root: '/home/me/repo', common: '/home/me/repo/.git' } }
    const wt = { cwd: '/tmp/wt/b497', repo: { root: '/tmp/wt/b497', common: '/home/me/repo/.git' } }
    const other = { cwd: '/home/me/other', repo: { root: '/home/me/other', common: '/home/me/other/.git' } }
    const loose = { cwd: '/scratch', repo: { root: null, common: null } }

    it('repo scope joins a main checkout with its worktrees but not other repos', () => {
        expect(isPeerInScope('repo', main, wt)).toBe(true)
        expect(isPeerInScope('repo', main, other)).toBe(false)
        expect(isPeerInScope('repo', loose, { ...loose })).toBe(true)
        expect(isPeerInScope('repo', loose, main)).toBe(false)
    })

    it('cwd scope is the exact directory; machine scope is everything', () => {
        expect(isPeerInScope('cwd', main, wt)).toBe(false)
        expect(isPeerInScope('cwd', main, { ...main, cwd: '/home/me/repo/' })).toBe(true)
        expect(isPeerInScope('machine', main, other)).toBe(true)
    })
})
