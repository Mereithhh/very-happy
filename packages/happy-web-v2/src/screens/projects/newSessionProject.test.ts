import { describe, expect, it } from 'vitest';
import type { ProjectView } from '@slopus/happy-wire';
import { clearQuickSession, isQuickSession, markQuickSession, newSessionProjectHint, projectHintText, quickSessionProjectNote, QUICK_NOTE_TTL_MS } from './newSessionProject';
import { suggestProjectFor } from './projectSuggestion';

const p = (id: string, folders: { machineId: string; path: string }[], extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id.toUpperCase(), goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: folders.map(f => ({ ...f, primary: false })), defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const projects = [p('repo', [{ machineId: 'm', path: '/code/repo' }]), p('other', [{ machineId: 'm', path: '/code/other' }])];

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('B-757 新建会话弹窗：所属项目预选与说明', () => {
  it('a folder inside a project preselects it (the same rule as the folder suggestion)', () => {
    const suggested = suggestProjectFor({ machineId: 'm', path: '/code/repo/web' }, projects);
    const hint = newSessionProjectHint(suggested, undefined, projects);
    expect(hint).toEqual({ kind: 'auto', project: projects[0] });
    expect(projectHintText(hint, true)).toBe('目录在「REPO」里，将加入这个项目。');
    expect(projectHintText(hint, false)).toContain('joins it');
  });
  it('no project folder → 不属于任何项目, the picker offers one', () => {
    const hint = newSessionProjectHint(suggestProjectFor({ machineId: 'm', path: '/tmp' }, projects), undefined, projects);
    expect(hint).toEqual({ kind: 'none' });
    expect(projectHintText(hint, true)).toContain('不属于任何项目');
  });
  it('the user’s pick wins: another project, 无项目 against the folder, or re-picking the folder’s project', () => {
    const suggested = projects[0];
    expect(newSessionProjectHint(suggested, 'other', projects)).toEqual({ kind: 'picked', project: projects[1] });
    expect(newSessionProjectHint(null, 'other', projects)).toEqual({ kind: 'picked', project: projects[1] });
    const declined = newSessionProjectHint(suggested, null, projects);
    expect(declined).toEqual({ kind: 'declined', suggested });
    expect(projectHintText(declined, true)).toBe('不加入项目（这个目录属于「REPO」）。');
    expect(newSessionProjectHint(suggested, 'repo', projects).kind).toBe('auto');
    expect(newSessionProjectHint(null, null, projects)).toEqual({ kind: 'none' });
    // a picked project that disappeared (archived elsewhere) is not joined
    expect(newSessionProjectHint(null, 'gone', projects)).toEqual({ kind: 'none' });
  });
});

describe('B-757 快捷新建提示条', () => {
  const snap = (members: { sessionId: string; projectId: string }[] = []) => ({ status: 'ready', projects, members });
  it('member → 属于项目 X; folder in a project → suggest X; otherwise none; loading → nothing yet', () => {
    expect(quickSessionProjectNote('s', { machineId: 'm', path: '/code/repo' }, snap([{ sessionId: 's', projectId: 'other' }]))).toEqual({ kind: 'member', project: projects[1] });
    expect(quickSessionProjectNote('s', { machineId: 'm', path: '/code/repo/x' }, snap())).toEqual({ kind: 'suggest', project: projects[0] });
    expect(quickSessionProjectNote('s', { machineId: 'm', path: '/elsewhere' }, snap())).toEqual({ kind: 'none' });
    expect(quickSessionProjectNote('s', undefined, snap())).toEqual({ kind: 'none' });
    expect(quickSessionProjectNote('s', { machineId: 'm', path: '/code/repo' }, { status: 'loading', projects, members: [] })).toBeNull();
  });
  it('the quick mark lasts a day, survives a reload (storage), clears on dismiss, and ignores broken storage', () => {
    const storage = memoryStorage();
    markQuickSession('s1', 1_000, storage);
    expect(isQuickSession('s1', 1_000 + QUICK_NOTE_TTL_MS - 1, storage)).toBe(true);
    expect(isQuickSession('s1', 1_000 + QUICK_NOTE_TTL_MS, storage)).toBe(false);
    expect(isQuickSession('s2', 1_000, storage)).toBe(false);
    clearQuickSession('s1', storage);
    expect(isQuickSession('s1', 1_001, storage)).toBe(false);
    storage.map.set('vh:quick-session-note:v1', '{bad');
    expect(isQuickSession('s1', 1, storage)).toBe(false);
    expect(() => markQuickSession('s3', 1, storage)).not.toThrow();
    expect(isQuickSession('s3', 2, storage)).toBe(true);
  });
  it('marks are bounded and expired ones are dropped on write', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 80; i++) markQuickSession(`s${i}`, 10_000 + i, storage);
    expect(Object.keys(JSON.parse(storage.map.get('vh:quick-session-note:v1')!))).toHaveLength(50);
    markQuickSession('late', 10_000 + QUICK_NOTE_TTL_MS + 100, storage);
    expect(Object.keys(JSON.parse(storage.map.get('vh:quick-session-note:v1')!))).toEqual(['late']);
  });
});
