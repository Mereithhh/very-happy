import { describe, expect, it } from 'vitest';
import { paletteNavigationActions } from './navigationActions';
import { filterPaletteItems } from './paletteModel';

const all = { issuesVisible: true, projectsVisible: true, automationsVisible: true, teamsVisible: true };
const rows = (zh: boolean) => paletteNavigationActions({ zh, ...all }).map((a) => ({ ...a, group: 'actions' as const }));
const find = (zh: boolean, q: string) => filterPaletteItems(rows(zh), q).map((h) => h.it.key);

describe('⌘K reaches every sidebar entry (B-896)', () => {
  it.each([
    ['Issues', 'action:go-issues'], ['运行中', 'action:go-board'], ['项目', 'action:go-projects'], ['自动化', 'action:go-automations'],
    ['联系人', 'action:go-people'], ['新建项目', 'action:go-new-project'], ['新建团队', 'action:go-new-team'],
    ['running', 'action:go-board'], ['projects', 'action:go-projects'], ['automations', 'action:go-automations'], ['contacts', 'action:go-people'], ['new project', 'action:go-new-project'], ['new team', 'action:go-new-team'],
  ])('%s → %s ranks first, in either UI language', (q, key) => {
    expect(find(true, q)[0]).toBe(key);
    expect(find(false, q)[0]).toBe(key);
  });
  it('B-895 rule: the other language matches as a hidden keyword, never as the shown reason', () => {
    const [hit] = filterPaletteItems(rows(false), '项目');
    expect(hit.it.key).toBe('action:go-projects');
    expect(hit.match?.reasons ?? []).toEqual([]);
  });
  it('targets: pages by path, 新建项目 through the sidebar dialog, 新建团队 straight into the create dialog', () => {
    const byKey = Object.fromEntries(paletteNavigationActions({ zh: false, ...all }).map((a) => [a.key, a.target]));
    expect(byKey['action:go-issues']).toEqual({ kind: 'path', path: '/issues' });
    expect(byKey['action:go-board']).toEqual({ kind: 'path', path: '/board' });
    expect(byKey['action:go-new-project']).toEqual({ kind: 'new-project' });
    expect(byKey['action:go-new-team']).toEqual({ kind: 'path', path: '/teams?new=1' });
  });
  it('same gates as the sidebar', () => {
    const keys = paletteNavigationActions({ zh: true, issuesVisible: false, projectsVisible: false, automationsVisible: false, teamsVisible: false }).map((a) => a.key);
    expect(keys).toEqual(['action:go-people']);
  });
});
