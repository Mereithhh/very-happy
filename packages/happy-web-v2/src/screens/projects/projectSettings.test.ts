import { describe, expect, it } from 'vitest';
import { PROJECT_LIMITS } from '@slopus/happy-wire';
import { addFolder, basicsPatch, canRemoveMember, folderError, makePrimary, projectSettingsPath, projectSettingsPolicy, removeFolder, updateFolder } from './projectSettings';

const folders = [
  { machineId: 'm1', path: '/code/a', primary: true },
  { machineId: 'm1', path: '/code/b', primary: false },
  { machineId: 'm2', path: '/code/a', primary: false },
];

describe('B-757 project settings rules', () => {
  it('route and section anchors', () => {
    expect(projectSettingsPath('p 1')).toBe('/projects/p%201/settings');
    expect(projectSettingsPath('p1', 'folders')).toBe('/projects/p1/settings#folders');
  });

  it('archived projects are read-only except unarchive and delete', () => {
    expect(projectSettingsPolicy({ archivedAt: null })).toEqual({ editable: true, canArchive: true, canUnarchive: false, canDelete: true });
    expect(projectSettingsPolicy({ archivedAt: 5 })).toEqual({ editable: false, canArchive: false, canUnarchive: true, canDelete: true });
  });

  it('a team member follows its team; explicit members can be removed while the project is live', () => {
    expect(canRemoveMember({ via: 'explicit' }, { archivedAt: null })).toBe(true);
    expect(canRemoveMember({ via: 'suggested-accepted' }, { archivedAt: null })).toBe(true);
    expect(canRemoveMember({ via: 'team' }, { archivedAt: null })).toBe(false);
    expect(canRemoveMember({ via: 'explicit' }, { archivedAt: 1 })).toBe(false);
  });

  it('folder validation: empty, machine, duplicate (server normalization), limit; an edited folder may keep its path', () => {
    expect(folderError(folders, { machineId: 'm1', path: '  ' })).toBe('empty');
    expect(folderError(folders, { machineId: '', path: '/x' })).toBe('machine');
    expect(folderError(folders, { machineId: 'm1', path: '/code/b/' })).toBe('duplicate');
    expect(folderError(folders, { machineId: 'm1', path: '/code//a' })).toBe('duplicate');
    expect(folderError(folders, { machineId: 'm3', path: '/code/a' })).toBeNull();
    // B-755: a team member's worktree is refused (the repository goes in instead)
    expect(folderError(folders, { machineId: 'm1', path: '/home/u/.happy/teams/worktrees/f0747a90-5f06-4c9c-9f39-a8d3c677ecd8' })).toBe('worktree');
    expect(folderError(folders, { machineId: 'm1', path: '/home/u/.happy/teams/worktrees/f0747a90-5f06-4c9c-9f39-a8d3c677ecd8/pkg' })).toBe('worktree');
    expect(folderError(folders, { machineId: 'm1', path: '/code/a' }, 0)).toBeNull();
    expect(folderError(folders, { machineId: 'm1', path: '/code/b' }, 0)).toBe('duplicate');
    const full = Array.from({ length: PROJECT_LIMITS.folders }, (_, i) => ({ machineId: 'm', path: `/p${i}` }));
    expect(folderError(full, { machineId: 'm', path: '/new' })).toBe('limit');
    expect(folderError(full, { machineId: 'm', path: '/p0' }, 0)).toBeNull();
  });

  it('add / edit / remove / primary keep exactly one primary', () => {
    expect(addFolder([], { machineId: 'm', path: ' /x ' })).toEqual([{ machineId: 'm', path: '/x', primary: true }]);
    expect(addFolder(folders, { machineId: 'm3', path: '/y' }).at(-1)).toEqual({ machineId: 'm3', path: '/y', primary: false });
    expect(updateFolder(folders, 1, { machineId: 'm2', path: '/z' })[1]).toEqual({ machineId: 'm2', path: '/z', primary: false });
    expect(updateFolder(folders, 0, { machineId: 'm1', path: '/q' })[0].primary).toBe(true);
    const removedPrimary = removeFolder(folders, 0);
    expect(removedPrimary.map((f) => f.path)).toEqual(['/code/b', '/code/a']);
    expect(removedPrimary.filter((f) => f.primary)).toEqual([removedPrimary[0]]);
    expect(removeFolder(folders, 1).filter((f) => f.primary).map((f) => f.path)).toEqual(['/code/a']);
    expect(removeFolder([folders[0]], 0)).toEqual([]);
    expect(makePrimary(folders, 2).map((f) => f.primary)).toEqual([false, false, true]);
  });

  it('basics patch: trims, empty description is null, nothing changed / empty name → no write', () => {
    const project = { name: 'Alpha', goal: 'ship' };
    expect(basicsPatch(project, 'Alpha', 'ship')).toBeNull();
    expect(basicsPatch(project, '  ', 'x')).toBeNull();
    expect(basicsPatch(project, ' Beta ', 'ship')).toEqual({ name: 'Beta', goal: 'ship' });
    expect(basicsPatch(project, 'Alpha', '  ')).toEqual({ name: 'Alpha', goal: null });
    expect(basicsPatch({ name: 'A', goal: null }, 'A', '')).toBeNull();
  });
});
