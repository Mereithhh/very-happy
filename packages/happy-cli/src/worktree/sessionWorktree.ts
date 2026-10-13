/**
 * B-586: `metadata.worktree` — set when a session starts inside a LINKED git
 * worktree (its toplevel `.git` is a file pointing at `<common>/worktrees/<n>`).
 * Pure FS, no `git` subprocess (wrapper start must stay fast); a snapshot at
 * start — a later `git switch` is not reflected. Main checkouts get nothing.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { RepoFs } from '@/sessions/repoIdentity';

export interface SessionWorktree { branch: string | null; root: string }

const realFs: RepoFs = {
    existsSync,
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    readFileSync: (path) => readFileSync(path, 'utf8'),
};

export function resolveSessionWorktree(cwd: string, fs: RepoFs = realFs): SessionWorktree | null {
    let dir = resolve(cwd);
    for (let depth = 0; depth < 64; depth++) {
        const dotGit = resolve(dir, '.git');
        try {
            if (fs.existsSync(dotGit)) {
                if (fs.isDirectory(dotGit)) return null; // main checkout
                const gitdir = fs.readFileSync(dotGit).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
                if (!gitdir) return null;
                const absolute = isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir);
                if (!/[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(absolute)) return null; // submodule etc.
                let branch: string | null = null;
                try {
                    const head = fs.readFileSync(resolve(absolute, 'HEAD')).trim();
                    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
                    branch = ref ?? null;
                } catch { /* unreadable HEAD → branch unknown */ }
                return { branch, root: dir };
            }
        } catch {
            return null;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** Spread into session metadata: `{ worktree }` only for linked worktrees. */
export function sessionWorktreeMetadata(cwd: string): { worktree?: SessionWorktree } {
    try {
        const worktree = resolveSessionWorktree(cwd);
        return worktree ? { worktree } : {};
    } catch {
        return {};
    }
}
