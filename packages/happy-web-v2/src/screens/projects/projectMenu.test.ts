import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildProjectMenu, projectPath, projectPrimaryFolder, projectSettingsPath } from './projectMenu';
import { projectListModel } from './projectList';
import type { ProjectView } from '@slopus/happy-wire';

const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const member = (projectId: string, sessionId: string) => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: 1 });

describe('project menu (B-756)', () => {
  const handlers = () => ({ onNewSession: vi.fn(), onSettings: vi.fn(), onRename: vi.fn(), onArchive: vi.fn() });
  it('new session · settings · rename · archive, each wired to its own handler', () => {
    const h = handlers();
    const items = buildProjectMenu({ zh: true, ...h });
    expect(items.map((i) => [i.key, i.label])).toEqual([['new-session', '新建会话'], ['settings', '项目设置'], ['rename', '重命名'], ['archive', '归档项目']]);
    for (const item of items) item.onSelect();
    expect([h.onNewSession, h.onSettings, h.onRename, h.onArchive].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(items.find((i) => i.key === 'archive')!.danger).toBe(true);
  });
  it('an archived project offers unarchive and no new session', () => {
    const items = buildProjectMenu({ zh: false, archived: true, ...handlers() });
    expect(items.find((i) => i.key === 'archive')!.label).toBe('Unarchive');
    expect(items.find((i) => i.key === 'new-session')!.disabled).toBe(true);
  });
  it('routes: page and settings deep link (B-757 owns the settings page)', () => {
    expect(projectPath('a b')).toBe('/projects/a%20b');
    expect(projectSettingsPath('p1')).toBe('/projects/p1/settings');
  });
  it('new session lands in the primary folder, else the first, else nowhere', () => {
    expect(projectPrimaryFolder({ folders: [{ machineId: 'm', path: '/a', primary: false }, { machineId: 'm', path: '/b', primary: true }] })).toEqual({ machineId: 'm', path: '/b' });
    expect(projectPrimaryFolder({ folders: [{ machineId: 'm', path: '/a', primary: false }] })).toEqual({ machineId: 'm', path: '/a' });
    expect(projectPrimaryFolder({ folders: [] })).toBeNull();
  });
});

describe('projectListModel (/projects)', () => {
  it('counts sessions, teams and 等你处理; waiting projects first, then most recently updated', () => {
    const rows = projectListModel(
      [project('old', { updatedAt: 1 }), project('new', { updatedAt: 9, teamIds: ['t'] }), project('busy', { updatedAt: 2 }), project('gone', { archivedAt: 5 })],
      [member('busy', 's1'), member('busy', 's2'), member('new', 's3')],
      new Set(['s2']),
    );
    expect(rows.map((r) => [r.project.id, r.sessions, r.teams, r.attention])).toEqual([['busy', 2, 0, 1], ['new', 1, 1, 0], ['old', 0, 0, 0]]);
  });
  it('the archived list holds only archived projects, latest first', () => {
    const rows = projectListModel([project('a', { archivedAt: 1 }), project('b', { archivedAt: 3 }), project('live')], [], new Set(), { archived: true });
    expect(rows.map((r) => r.project.id)).toEqual(['b', 'a']);
  });
});

describe('links resolve to real routes', () => {
  const appRoot = readFileSync(new URL('../../app/AppRoot.tsx', import.meta.url), 'utf8');
  it('⚙ → B-757’s settings page, 项目 entry → the /projects list', () => {
    expect(projectSettingsPath('p1')).toBe('/projects/p1/settings');
    expect(appRoot).toContain("{ path: 'projects/:projectId/settings', element: <Lazy><ProjectSettingsScreen /></Lazy> }");
    expect(appRoot).toContain("{ path: 'projects', element: <Lazy><ProjectsListScreen /></Lazy> }");
  });
});
