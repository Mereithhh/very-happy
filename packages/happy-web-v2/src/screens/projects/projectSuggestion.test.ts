import { describe, expect, it } from 'vitest';
import type { ProjectView } from '@slopus/happy-wire';
import { readDismissed, suggestProjectFor, writeDismissed } from './projectSuggestion';

const p = (id: string, folders: { machineId: string; path: string }[], extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: folders.map(f => ({ ...f, primary: false })), defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });

describe('directory suggestion (suggest only, never auto-join)', () => {
  it('matches a folder on the same machine, the deepest one wins', () => {
    const projects = [p('repo', [{ machineId: 'm', path: '/code/app' }]), p('sub', [{ machineId: 'm', path: '/code/app/pkg/' }])];
    expect(suggestProjectFor({ machineId: 'm', path: '/code/app/pkg/x' }, projects)?.id).toBe('sub');
    expect(suggestProjectFor({ machineId: 'm', path: '/code/app' }, projects)?.id).toBe('repo');
  });
  it('no match: other machine, sibling prefix, missing path, archived project', () => {
    const projects = [p('a', [{ machineId: 'm', path: '/code/app' }]), p('z', [{ machineId: 'm', path: '/code/other' }], { archivedAt: 5 })];
    expect(suggestProjectFor({ machineId: 'n', path: '/code/app/x' }, projects)).toBeNull();
    expect(suggestProjectFor({ machineId: 'm', path: '/code/app-old' }, projects)).toBeNull();
    expect(suggestProjectFor({ machineId: 'm', path: null }, projects)).toBeNull();
    expect(suggestProjectFor({ machineId: 'm', path: '/code/other/x' }, projects)).toBeNull();
  });
  it('B-755: a folder inside a team worktree suggests nothing; a session inside one is never asked', () => {
    const wt = '/home/u/.happy/teams/worktrees/wt-0001';
    const projects = [p('governance', [{ machineId: 'm', path: wt }]), p('skills', [{ machineId: 'm', path: '/home/u' }])];
    expect(suggestProjectFor({ machineId: 'm', path: wt }, projects)).toBeNull();
    expect(suggestProjectFor({ machineId: 'm', path: `${wt}/docs` }, projects)).toBeNull();
    // The worktree folder no longer shadows a real folder for sessions outside worktrees.
    expect(suggestProjectFor({ machineId: 'm', path: '/home/u/code' }, projects)?.id).toBe('skills');
  });
  it('dismissals persist per session and survive broken storage', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    writeDismissed('s1', storage);
    expect(readDismissed(storage).has('s1')).toBe(true);
    map.set('vh:project-suggestion-dismissed:v1', '{bad');
    expect(readDismissed(storage).size).toBe(0);
  });
});
