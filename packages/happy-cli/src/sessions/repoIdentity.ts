/**
 * Which repository a working directory belongs to (B-497 `session_peers`).
 *
 * Pure filesystem walk, no `git` subprocess: climb from `cwd` until a `.git`
 * entry is found. A `.git` DIRECTORY is a main checkout (root = that dir,
 * common = its `.git`); a `.git` FILE is a linked worktree whose single line
 * `gitdir: <main>/.git/worktrees/<name>` names the main repository — its
 * common dir is `<main>/.git`, so a main checkout and every worktree of it
 * share one `common` and count as the same repo, while `root` (the
 * toplevel) still tells them apart.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface RepoIdentity {
    /** Toplevel of this checkout / worktree, or null outside any repo. */
    root: string | null
    /** The `.git` directory shared by the main checkout and its worktrees, or null. */
    common: string | null
}

export interface RepoFs {
    existsSync: (path: string) => boolean
    isDirectory: (path: string) => boolean
    readFileSync: (path: string) => string
}

const realFs: RepoFs = {
    existsSync,
    isDirectory: (path) => { try { return statSync(path).isDirectory() } catch { return false } },
    readFileSync: (path) => readFileSync(path, 'utf8'),
}

export function resolveRepoIdentity(cwd: string, fs: RepoFs = realFs): RepoIdentity {
    let dir = resolve(cwd)
    for (let depth = 0; depth < 64; depth++) {
        const dotGit = resolve(dir, '.git')
        try {
            if (fs.existsSync(dotGit)) {
                if (fs.isDirectory(dotGit)) return { root: dir, common: dotGit }
                const gitdir = fs.readFileSync(dotGit).match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
                if (gitdir) {
                    const absolute = isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir)
                    // <main>/.git/worktrees/<name> → <main>/.git ; anything else is its own common dir.
                    const worktree = absolute.match(/^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+[\\/]?$/)
                    return { root: dir, common: worktree ? worktree[1] : absolute }
                }
                return { root: dir, common: dotGit }
            }
        } catch {
            // unreadable entry: keep climbing
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    return { root: null, common: null }
}

export type PeerScope = 'repo' | 'cwd' | 'machine'

export const PEER_SCOPES: readonly PeerScope[] = ['repo', 'cwd', 'machine']

/** Does `other` fall inside `scope` relative to `self`? Pure. */
export function isPeerInScope(
    scope: PeerScope,
    self: { cwd: string; repo: RepoIdentity },
    other: { cwd: string; repo: RepoIdentity },
): boolean {
    if (scope === 'machine') return true
    if (scope === 'cwd') return resolve(self.cwd) === resolve(other.cwd)
    if (self.repo.common && other.repo.common) return self.repo.common === other.repo.common
    // Outside any repo, "same repo" degrades to "same directory".
    return resolve(self.cwd) === resolve(other.cwd)
}
