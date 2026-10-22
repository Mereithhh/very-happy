/**
 * B-755: team daemons put every managed member in a throwaway worktree at
 * `<happy home>/teams/worktrees/<spawn operation id>` (happy-cli
 * daemon/teams/worktree.ts). Such a folder is never a workplace of its own —
 * not a project folder, a remembered directory, or where an unrelated chat
 * starts. The spawn operation with that id records the repository the
 * worktree was cut from (`TeamOperation.directory`). One rule for server,
 * Web and CLI.
 */
const TEAM_WORKTREE = /\/teams\/worktrees\/([^/]+)(?:\/|$)/;

/** The worktree id (= its spawn operation id) when `path` is a team worktree or inside one. */
export function teamWorktreeId(path: string | null | undefined): string | null {
    if (!path) return null;
    return path.replace(/\\/g, '/').match(TEAM_WORKTREE)?.[1] ?? null;
}

/** `path` is a team worktree root or a folder inside one. */
export function isInsideTeamWorktree(path: string | null | undefined): boolean {
    return teamWorktreeId(path) !== null;
}

/** `path` moved from its team worktree to `repository`, keeping a subfolder's place. */
export function rebaseTeamWorktreePath(path: string, repository: string): string {
    const normalized = path.replace(/\\/g, '/');
    const match = normalized.match(TEAM_WORKTREE);
    if (!match || match.index === undefined) return path;
    const rest = normalized.slice(match.index + match[0].length).replace(/\/+$/, '');
    return rest ? `${repository.replace(/\/+$/, '')}/${rest}` : repository;
}

/**
 * Follows a team worktree back to its repository (worktrees cut from other
 * worktrees included, at most 8 hops). `sourceOf(id)` returns the spawn
 * operation's requested directory, or null when unknown. A path outside any
 * team worktree is returned as is; an unknown worktree gives null.
 */
export async function resolveTeamWorktreePath(path: string, sourceOf: (operationId: string) => Promise<string | null> | string | null): Promise<string | null> {
    let current = path;
    for (let hop = 0; hop < 8; hop++) {
        const id = teamWorktreeId(current);
        if (!id) return current;
        const source = await sourceOf(id);
        if (!source) return null;
        current = rebaseTeamWorktreePath(current, source);
    }
    return null;
}
