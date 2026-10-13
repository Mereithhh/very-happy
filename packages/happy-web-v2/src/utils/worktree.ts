/**
 * B-586 worktree helpers (pure). Replaces the old unused `machineBash`-based
 * create/list/remove (shell-interpolated user input): every operation now goes
 * through the daemon's `worktree-*` RPCs (sync/worktreeOps.ts), and this file
 * only holds the rules the UI needs. Spec: specs/2026-10-worktree-sessions-and-setup.md.
 */

/** Machine-level capability (铁律 14, machine form): the daemon serves `worktree-*`. */
export function machineSupportsWorktrees(machine: { metadata?: { worktreeVersion?: number } | null } | null | undefined): boolean {
    return (machine?.metadata?.worktreeVersion ?? 0) >= 1;
}

/** An old daemon answers unknown methods with a normal `{error:'Method not found'}`. */
export function isUnsupportedRpcError(error: string | undefined | null): boolean {
    return !!error && /method not found|unknown method|not supported/i.test(error);
}

const adjectives = ['clever', 'happy', 'swift', 'bright', 'calm', 'bold', 'quiet', 'brave', 'wise', 'eager', 'gentle', 'quick', 'sharp', 'smooth', 'fresh'];
const nouns = ['ocean', 'forest', 'cloud', 'star', 'river', 'mountain', 'valley', 'bridge', 'beacon', 'harbor', 'garden', 'meadow', 'canyon', 'island', 'desert'];

/** `vh/<adjective>-<noun>`; `random` injectable for tests. */
export function generateWorktreeBranch(random: () => number = Math.random): string {
    const pick = (list: string[]) => list[Math.floor(random() * list.length) % list.length];
    return `vh/${pick(adjectives)}-${pick(nouns)}`;
}

/** Same rule as the daemon (`defaultWorktreeLocation`): `<defaultParent>/<branch with / → ->`. */
export function worktreeLocationFor(defaultParent: string, branch: string): string {
    const slug = branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    const sep = defaultParent.includes('\\') && !defaultParent.includes('/') ? '\\' : '/';
    return `${defaultParent.replace(/[\\/]+$/, '')}${sep}${slug}`;
}

/**
 * A cheap client-side pre-check mirroring the obvious `git check-ref-format`
 * failures (the daemon has the final say).
 */
export function isPlausibleBranchName(name: string): boolean {
    const value = name.trim();
    if (!value || value.length > 200 || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
    if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock(\/|$)/.test(value)) return false;
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x1f\x7f]/.test(value);
}

export type WorktreeSetupState = 'none' | 'needs-approval' | 'declined' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'interrupted' | 'unsupported';

export type SetupBannerKind = 'approve' | 'running' | 'failed' | 'succeeded' | 'declined' | null;

/** Which strip a session shows for its worktree setup state (unknown states → none). */
export function setupBannerKind(state: string | undefined | null): SetupBannerKind {
    switch (state) {
        case 'needs-approval': return 'approve';
        case 'running': return 'running';
        case 'failed': case 'timed-out': case 'interrupted': case 'unsupported': return 'failed';
        case 'succeeded': return 'succeeded';
        case 'declined': return 'declined';
        default: return null;
    }
}

/** Session list subtitle suffix for a worktree session. */
export function worktreeBranchLabel(metadata: { worktree?: { branch?: string | null } | null } | null | undefined): string | null {
    const branch = metadata?.worktree?.branch;
    return typeof branch === 'string' && branch ? `⎇ ${branch}` : null;
}

/** POSIX `/…` or Windows `C:\…` / `C:/…` (the daemon requires absolute paths). */
export function isAbsoluteMachinePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}
