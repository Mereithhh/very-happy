// @vitest-environment happy-dom
/**
 * B-757: after 快捷新建 the session page says once which project the session
 * is in (or none, with the folder's project one click away); closing it is
 * remembered and also silences the plain folder suggestion.
 */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@slopus/happy-wire';

const snap = vi.hoisted(() => ({ value: { status: 'ready', projects: [] as ProjectView[], members: [] as { sessionId: string; projectId: string; via: string }[] } }));
const meta = vi.hoisted(() => ({ value: { machineId: 'm', path: '/code/repo/web' } as { machineId: string; path: string } | undefined }));
const addMembers = vi.hoisted(() => vi.fn(async () => ({})));
const applyLocalMembership = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'zh-Hans' }) }));
vi.mock('@/sync/projects', () => ({ useProjects: () => snap.value, projectsApi: { addMembers }, applyLocalMembership, refreshProjects: vi.fn(async () => {}) }));
vi.mock('@/sync/storage', () => ({ storage: (select: (s: unknown) => unknown) => select({ sessions: { s1: { metadata: meta.value } } }) }));
vi.mock('./MoveToProjectModal', () => ({ MoveToProjectModal: () => <div data-move-modal /> }));
vi.mock('@/ui/Toast', () => ({ toast: { error: vi.fn() } }));

const { QuickSessionProjectBanner } = await import('./QuickSessionProjectBanner');
const { markQuickSession, isQuickSession } = await import('./newSessionProject');
const { readDismissed } = await import('./projectSuggestion');

const p = (id: string, path: string): ProjectView => ({ id, name: id.toUpperCase(), goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [{ machineId: 'm', path, primary: true }], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [] });

let host: HTMLDivElement;
let root: Root;
async function render() {
  await act(async () => root.render(<MemoryRouter><QuickSessionProjectBanner sessionId="s1" /></MemoryRouter>));
}
const banner = () => host.querySelector<HTMLElement>('[data-testid=quick-session-project-banner]');
const btn = (text: string) => [...host.querySelectorAll<HTMLElement>('button, a')].find((b) => b.textContent === text);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  snap.value = { status: 'ready', projects: [p('repo', '/code/repo')], members: [] };
  meta.value = { machineId: 'm', path: '/code/repo/web' };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('B-757 快捷新建后的项目提示条', () => {
  it('in a project → 属于项目 X with 打开项目', async () => {
    snap.value.members = [{ sessionId: 's1', projectId: 'repo', via: 'explicit' }];
    await render();
    expect(banner()!.dataset.kind).toBe('member');
    expect(banner()!.textContent).toContain('这个会话属于项目「REPO」');
    expect(btn('打开项目')!.getAttribute('href')).toBe('/projects/repo');
  });

  it('not in one but its folder is → 不属于任何项目 · 加入「X」 joins it as an accepted suggestion', async () => {
    await render();
    expect(banner()!.dataset.kind).toBe('suggest');
    expect(banner()!.textContent).toContain('不属于任何项目');
    await act(async () => { btn('加入「REPO」')!.click(); });
    expect(addMembers).toHaveBeenCalledWith('repo', ['s1'], 'suggested-accepted');
    expect(applyLocalMembership).toHaveBeenCalledWith('repo', ['s1']);
  });

  it('no project folder → 不属于任何项目 · 加入项目 opens the project picker dialog', async () => {
    meta.value = { machineId: 'm', path: '/tmp/x' };
    await render();
    expect(banner()!.dataset.kind).toBe('none');
    await act(async () => { btn('加入项目')!.click(); });
    expect(host.querySelector('[data-move-modal]')).not.toBeNull();
  });

  it('no projects at all → just the note, no join action', async () => {
    snap.value.projects = [];
    await render();
    expect(banner()!.dataset.kind).toBe('none');
    expect(btn('加入项目')).toBeUndefined();
  });

  it('closing clears the quick mark and dismisses the folder suggestion for this session', async () => {
    markQuickSession('s1');
    await render();
    await act(async () => { host.querySelector<HTMLButtonElement>('.mrb-dismiss')!.click(); });
    expect(banner()).toBeNull();
    expect(isQuickSession('s1')).toBe(false);
    expect(readDismissed().has('s1')).toBe(true);
  });

  it('nothing while projects load', async () => {
    snap.value = { status: 'loading', projects: [], members: [] };
    await render();
    expect(banner()).toBeNull();
  });
});

describe('B-757 wiring', () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  it('a quick spawn marks its session; the session page swaps the folder suggestion for the quick note', () => {
    expect(src('../../sync/pendingSessionsRuntime.ts')).toMatch(/if \(record\.source === 'quick'\) markQuickSession\(realId\);/);
    const detail = src('../session/SessionDetailScreen.tsx');
    expect(detail).toMatch(/const quickSession = useMemo\(\(\) => !!id && isQuickSession\(id\), \[id\]\);/);
    expect(detail).toMatch(/quickSession\s*\?\s*<QuickSessionProjectBanner key=\{`quick-project:\$\{id\}`\} sessionId=\{id\} \/>\s*:\s*<ProjectSuggestionBanner/);
  });
  it('the new-session dialog derives its project from the one hint (preselect + explanation line)', () => {
    const modal = src('../sessions/NewSessionModal.tsx');
    expect(modal).toMatch(/const projectHint = newSessionProjectHint\(suggestedProject, pickedProject, liveProjects\);/);
    expect(modal).toMatch(/const projectId = projectHint\.kind === 'auto' \|\| projectHint\.kind === 'picked' \? projectHint\.project\.id : null;/);
    expect(modal).toMatch(/data-testid="ns-project-hint"[^>]*>\{projectHintText\(projectHint, /);
  });
});
