import { isInsideTeamWorktree } from '@/utils/teamWorktree';
import type { FsMkdirResult } from '@/sync/fsOps';

/**
 * B-755 (Owner 10-22): a new project always has a folder — either an existing
 * one on a machine, or a new working folder the daemon creates (`fs-mkdir`,
 * home-only). Pure rules behind ProjectFolderPicker / NewProjectDialog.
 */
export type ProjectFolderMode = 'existing' | 'new';
export type ProjectFolderDraft = { machineId: string; mode: ProjectFolderMode; path: string; gitInit: boolean };
export type FolderProblem = 'machine' | 'path' | 'worktree' | 'dotdot' | 'outside-home' | 'new-offline' | 'new-unsupported';

type MachineLike = { id: string; active?: boolean; metadata?: { homeDir?: string; fsMkdirVersion?: number } | null };

/** `~/projects/<name>`, keeping letters/digits of any script; empty names fall back to `project`. */
export function defaultNewFolder(name: string): string {
  const slug = name.trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `~/projects/${slug || 'project'}`;
}

/** Why 「新建工作目录」 is unavailable on this machine, or null when it is. */
export function newFolderBlocker(machine: MachineLike | undefined, online: boolean): 'new-offline' | 'new-unsupported' | null {
  if (!machine || !online) return 'new-offline';
  return (machine.metadata?.fsMkdirVersion ?? 0) >= 1 ? null : 'new-unsupported';
}

/** First problem that blocks submitting the draft (mirrors the daemon's checks for a new folder). */
export function folderProblem(draft: ProjectFolderDraft, machine: MachineLike | undefined, online: boolean): FolderProblem | null {
  if (!draft.machineId || !machine) return 'machine';
  const path = draft.path.trim();
  if (!path) return 'path';
  if (isInsideTeamWorktree(path)) return 'worktree';
  if (draft.mode === 'existing') return null;
  const blocker = newFolderBlocker(machine, online);
  if (blocker) return blocker;
  if (path.split(/[\\/]+/).includes('..')) return 'dotdot';
  const home = machine.metadata?.homeDir?.replace(/\/+$/, '');
  const underHome = path.startsWith('~/') && path.length > 2 || (!!home && path.startsWith(`${home}/`) && path.length > home.length + 1);
  return underHome ? null : 'outside-home';
}

/** `~` expanded against the machine's home, for the stored project folder. */
export function expandHome(path: string, homeDir: string | undefined): string {
  const p = path.trim();
  if (!homeDir) return p;
  const home = homeDir.replace(/\/+$/, '');
  return p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p;
}

export type ResolvedFolder = { ok: true; folder: { machineId: string; path: string }; git: boolean | null } | { ok: false; code: string };

/** The folder to store: an existing path as typed (home-expanded), or the folder the daemon just created. */
export async function resolveProjectFolderDraft(
  draft: ProjectFolderDraft,
  homeDir: string | undefined,
  mkdir: (machineId: string, path: string, options: { gitInit?: boolean }) => Promise<FsMkdirResult>,
): Promise<ResolvedFolder> {
  if (draft.mode === 'existing') return { ok: true, folder: { machineId: draft.machineId, path: expandHome(draft.path, homeDir) }, git: null };
  const made = await mkdir(draft.machineId, draft.path.trim(), { gitInit: draft.gitInit });
  return made.ok ? { ok: true, folder: { machineId: draft.machineId, path: made.path }, git: draft.gitInit ? made.git : null } : { ok: false, code: made.code };
}
