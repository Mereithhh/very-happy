import { isInsideTeamWorktree, rebaseTeamWorktreePath, teamWorktreeId, type TeamState } from '@slopus/happy-wire';

export { isInsideTeamWorktree, teamWorktreeId };

/** Remembered directories minus team worktrees (B-755: they fed quick chat, new team and automations). */
export function withoutTeamWorktrees<T extends { path: string }>(list: readonly T[]): T[] {
  return list.filter(entry => !isInsideTeamWorktree(entry.path));
}

/**
 * B-755: the repository a team worktree was cut from — the spawn operation
 * whose id names the worktree recorded it — following worktrees cut from
 * other worktrees. A subfolder keeps its place. `null` when no loaded team on
 * that machine knows the worktree; a path outside any worktree is returned as is.
 */
export function teamWorktreeRepository(teams: readonly TeamState[], machineId: string, path: string): string | null {
  const ops = teams.filter(team => team.machineId === machineId).flatMap(team => team.operations);
  let current = path;
  for (let hop = 0; hop < 8; hop++) {
    const id = teamWorktreeId(current);
    if (!id) return current;
    const source = ops.find(op => op.id === id && op.type === 'spawn' && op.directory)?.directory;
    if (!source) return null;
    current = rebaseTeamWorktreePath(current, source);
  }
  return null;
}

/**
 * B-755 / B-740: a new chat started from a team worktree's context (the
 * session being viewed, a folder group) starts in the repository instead; a
 * worktree no loaded team knows keeps the machine but asks for the folder.
 */
export function redirectFromTeamWorktree<T extends { machineId: string; path: string }>(target: T | undefined, teams: readonly TeamState[]): T | undefined {
  if (!target || !isInsideTeamWorktree(target.path)) return target;
  return { ...target, path: teamWorktreeRepository(teams, target.machineId, target.path) ?? '' };
}
