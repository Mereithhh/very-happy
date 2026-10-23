// @vitest-environment happy-dom
/**
 * B-757 project settings page: every section reads the project and writes
 * through `projectsApi` with the right body; destructive and leaving actions
 * confirm first; an archived project is read-only; a team member cannot be
 * removed one by one.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDetailResponse, ProjectView } from '@slopus/happy-wire';

const api = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(async () => ({})), putInstructions: vi.fn(async () => ({})), history: vi.fn(async () => ({ revisions: [] })),
  removeMember: vi.fn(async () => ({ removed: true })), attachTeam: vi.fn(async () => ({})), detachTeam: vi.fn(async () => ({ detached: true })), remove: vi.fn(async () => ({ ok: true })),
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
const applyLocalMembership = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/projects', () => {
  class ProjectsApiError extends Error {
    constructor(public code: string, public details?: Record<string, unknown>, public unavailable = false) { super(code); }
  }
  return { projectsApi: api, ProjectsApiError, refreshProjects: vi.fn(async () => {}), applyLocalMembership, useProjects: () => ({ status: 'ready', projects: [], members: [] }) };
});
vi.mock('@/sync/storage', () => ({
  useAllMachines: () => [{ id: 'm1', metadata: { displayName: 'dev-sg' } }, { id: 'm2', metadata: { displayName: 'mac' } }],
  useAllSessions: () => [{ id: 's1', metadata: { summary: { text: 'Explicit one' } } }],
  useSetting: () => [],
}));
vi.mock('@/sync/fsOps', () => ({ machineFsMkdir: vi.fn() }));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({
  useTeamNavigation: () => [{ id: 't1', name: 'Core team' }, { id: 't2', name: 'Spare team' }],
}));
vi.mock('@/modal', () => ({ Modal: { confirm } }));
vi.mock('@/ui/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div data-md>{text}</div> }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true, machineLabel: (m: { id: string; metadata?: { displayName?: string } }) => m?.metadata?.displayName ?? m?.id }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (s: { metadata?: { summary?: { text?: string } } }) => s.metadata?.summary?.text ?? '?' }));

const { ProjectSettingsScreen } = await import('./ProjectSettingsScreen');
const { ProjectsApiError } = await import('@/sync/projects');

function project(extra: Partial<ProjectView> = {}): ProjectView {
  return {
    id: 'p1', name: 'Alpha', goal: 'Ship it', instructions: '# Rules\nBe brief', instructionsVersion: 3, instructionsUpdatedBy: null, instructionsUpdatedAt: null,
    folders: [{ machineId: 'm1', path: '/code/alpha', primary: true }, { machineId: 'm2', path: '/code/alpha-mac', primary: false }],
    defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: ['t1'], automationIds: [], ...extra,
  };
}
function detail(extra: Partial<ProjectView> = {}): ProjectDetailResponse {
  return {
    project: project(extra),
    members: [
      { projectId: 'p1', sessionId: 's1', via: 'explicit', machineId: 'm1', createdAt: 1 },
      { projectId: 'p1', sessionId: 's2', via: 'team', teamId: 't1', machineId: 'm1', createdAt: 1 },
    ],
    presence: [{ sessionId: 's2', title: 'Lead', agent: 'claude', machine: 'dev-sg', doing: null, injectedInstructionsVersion: 3 }],
    log: [],
  } as unknown as ProjectDetailResponse;
}

let host: HTMLDivElement;
let root: Root;
let where = '';
function Where() { const l = useLocation(); where = l.pathname + l.hash; return null; }
async function render(d: ProjectDetailResponse, path = '/projects/p1/settings') {
  api.get.mockResolvedValue(d);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/projects/:projectId/settings" element={<ProjectSettingsScreen />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  ));
  await act(async () => {});
}
const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const click = async (el: HTMLElement | undefined | null) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); }); };
const section = (name: string) => $(`#pj-settings-${name}`)!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('B-757 project settings page', () => {
  it('has the six sections, in team-settings order, each anchor-linked', async () => {
    await render(detail());
    expect($$('main[data-testid=project-settings] > section').map((s) => s.id)).toEqual(
      ['pj-settings-basics', 'pj-settings-context', 'pj-settings-folders', 'pj-settings-teams', 'pj-settings-sessions', 'pj-settings-danger']);
    expect($$('.pj-settings-nav a').map((a) => a.getAttribute('href'))).toEqual(['#basics', '#context', '#folders', '#teams', '#sessions', '#danger']);
    // B-796: the shared back arrow (history first, else appBack's parent: /projects/p1 — see appBack.test.ts)
    expect($('.pj-head .vh-back')).not.toBeNull();
  });

  it('basics: save is off until something changed; writes the trimmed name and description', async () => {
    await render(detail());
    const [name, goal] = section('basics').querySelectorAll<HTMLInputElement>('input');
    expect(name.value).toBe('Alpha');
    expect(goal.value).toBe('Ship it');
    expect(button(section('basics'), 'Save')!.disabled).toBe(true);
    await act(async () => { type(name, ' Beta '); type(goal, ''); });
    await click(button(section('basics'), 'Save'));
    expect(api.update).toHaveBeenCalledWith('p1', { name: 'Beta', goal: null });
  });

  it('instructions: preview renders Markdown, write edits, save is a CAS write on the loaded version', async () => {
    await render(detail());
    expect(section('context').querySelector('[data-md]')!.textContent).toBe('# Rules\nBe brief');
    await click(button(section('context'), 'Write'));
    const textarea = section('context').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.value).toBe('# Rules\nBe brief');
    await act(async () => { type(textarea, 'New rules'); });
    await click(button(section('context'), 'Save'));
    expect(api.putInstructions).toHaveBeenCalledWith('p1', { instructions: 'New rules', ifVersion: 3 });
  });

  it('instructions: a version conflict loads the newer text and the next save uses its version', async () => {
    api.putInstructions.mockRejectedValueOnce(new (ProjectsApiError as unknown as new (code: string, details: unknown) => Error)('instructions_version_conflict', { project: { instructions: 'Theirs', instructionsVersion: 5 } }));
    await render(detail());
    await click(button(section('context'), 'Write'));
    await act(async () => { type(section('context').querySelector('textarea')!, 'Mine'); });
    await click(button(section('context'), 'Save'));
    expect(section('context').querySelector('[role=alert]')!.textContent).toContain('v5');
    expect(section('context').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Theirs');
    await act(async () => { type(section('context').querySelector('textarea')!, 'Theirs + mine'); });
    await click(button(section('context'), 'Save'));
    expect(api.putInstructions).toHaveBeenLastCalledWith('p1', { instructions: 'Theirs + mine', ifVersion: 5 });
  });

  it('folders: add (validated), edit in place, make primary, remove after confirming', async () => {
    await render(detail());
    const folders = section('folders');
    expect($$('[data-testid=project-folder]').map((r) => r.textContent)).toEqual([expect.stringContaining('/code/alpha'), expect.stringContaining('/code/alpha-mac')]);
    // add: a duplicate is refused inline, a new path is written
    const addPath = folders.querySelector<HTMLInputElement>('.pj-folder-add .pj-folder-picker input')!;
    await act(async () => { type(addPath, '/code/alpha/'); });
    expect(folders.textContent).toContain('This machine already has this folder');
    await click(button(folders, 'Add folder'));
    expect(api.update).not.toHaveBeenCalled();
    await act(async () => { type(addPath, '/code/beta'); });
    await click(button(folders, 'Add folder'));
    expect(api.update).toHaveBeenLastCalledWith('p1', { folders: [
      { machineId: 'm1', path: '/code/alpha', primary: true }, { machineId: 'm2', path: '/code/alpha-mac', primary: false }, { machineId: 'm1', path: '/code/beta', primary: false },
    ] });
    // edit the second folder's path
    await click(button($$('[data-testid=project-folder]')[1], 'Edit'));
    const editPath = $$('[data-testid=project-folder]')[1].querySelector<HTMLInputElement>('.pj-folder-picker input')!;
    await act(async () => { type(editPath, '/code/alpha-2'); });
    await click(button($$('[data-testid=project-folder]')[1], 'Save'));
    expect(api.update).toHaveBeenLastCalledWith('p1', { folders: [
      { machineId: 'm1', path: '/code/alpha', primary: true }, { machineId: 'm2', path: '/code/alpha-2', primary: false },
    ] });
    // make primary
    await click(button($$('[data-testid=project-folder]')[1], 'Make primary'));
    expect(api.update).toHaveBeenLastCalledWith('p1', { folders: [
      { machineId: 'm1', path: '/code/alpha', primary: false }, { machineId: 'm2', path: '/code/alpha-mac', primary: true },
    ] });
    // remove: cancelled confirm writes nothing; confirmed removes the primary and hands it on
    api.update.mockClear();
    confirm.mockResolvedValueOnce(false);
    await click(button($$('[data-testid=project-folder]')[0], 'Remove'));
    expect(api.update).not.toHaveBeenCalled();
    await click(button($$('[data-testid=project-folder]')[0], 'Remove'));
    expect(confirm).toHaveBeenLastCalledWith('Remove folder?', expect.stringContaining('/code/alpha'), { confirmText: 'Remove', destructive: true });
    expect(api.update).toHaveBeenLastCalledWith('p1', { folders: [{ machineId: 'm2', path: '/code/alpha-mac', primary: true }] });
  });

  it('teams: linked teams listed; unlink confirms; the composer’s 添加目录 deep link lands here focused', async () => {
    await render(detail());
    expect($$('[data-testid=project-team]').map((r) => r.textContent)).toEqual([expect.stringContaining('Core team')]);
    await click(button($$('[data-testid=project-team]')[0], 'Unlink'));
    expect(confirm).toHaveBeenLastCalledWith('Unlink team?', expect.stringContaining('Core team'), { confirmText: 'Unlink' });
    expect(api.detachTeam).toHaveBeenCalledWith('p1', 't1');
  });

  it('member sessions: an explicit member is removed after confirming; a team member follows its team', async () => {
    await render(detail());
    const [explicit, viaTeam] = $$('[data-testid=project-member]');
    expect(explicit.textContent).toContain('Explicit one');
    expect(viaTeam.textContent).toContain('Lead');
    expect(viaTeam.textContent).toContain('Team member · Core team');
    expect(viaTeam.textContent).toContain('Follows team');
    expect(button(viaTeam, 'Remove from project')).toBeUndefined();
    await click(button(explicit, 'Remove from project'));
    expect(api.removeMember).toHaveBeenCalledWith('p1', 's1');
    expect(applyLocalMembership).toHaveBeenCalledWith(null, ['s1']);
  });

  it('danger zone: archive confirms, delete confirms (destructive) and leaves the page', async () => {
    await render(detail());
    await click(button(section('danger'), 'Archive project'));
    expect(confirm).toHaveBeenLastCalledWith('Archive project', expect.any(String), { confirmText: 'Archive project' });
    expect(api.update).toHaveBeenLastCalledWith('p1', { archived: true });
    confirm.mockResolvedValueOnce(false);
    await click(button(section('danger'), 'Delete project'));
    expect(api.remove).not.toHaveBeenCalled();
    await click(button(section('danger'), 'Delete project'));
    expect(confirm).toHaveBeenLastCalledWith('Delete project', expect.any(String), { confirmText: 'Delete project', destructive: true });
    expect(api.remove).toHaveBeenCalledWith('p1');
    expect(where).toBe('/');
  });

  it('an archived project is read-only: no writes offered except unarchive and delete', async () => {
    await render(detail({ archivedAt: 9 }));
    expect($('.pj-archived-note')).not.toBeNull();
    expect(section('basics').querySelectorAll<HTMLInputElement>('input:not([disabled])')).toHaveLength(0);
    expect(button(section('basics'), 'Save')).toBeUndefined();
    expect(section('context').querySelector('textarea')).toBeNull();
    expect(button(section('folders'), 'Add folder')).toBeUndefined();
    expect(button(section('folders'), 'Remove')).toBeUndefined();
    expect(button(section('teams'), 'Unlink')).toBeUndefined();
    expect(button(section('sessions'), 'Remove from project')).toBeUndefined();
    await click(button(section('danger'), 'Unarchive'));
    expect(confirm).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenLastCalledWith('p1', { archived: false });
  });

  it('B-755: a folder that is a team worktree is flagged here (no 打开设置 — this is settings) and cannot be added', async () => {
    const wt = '/home/u/.happy/teams/worktrees/11111111-2222-4333-8444-555555555555';
    await render(detail({ folders: [{ machineId: 'm1', path: wt, primary: true }] }));
    const notice = section('folders').querySelector('[data-testid=project-worktree-folder]')!;
    expect(notice.textContent).toContain(wt);
    expect(button(notice, 'Open settings')).toBeUndefined();
    await act(async () => { type(section('folders').querySelector<HTMLInputElement>('.pj-folder-add .pj-folder-picker input')!, `${wt}/web`); });
    expect(section('folders').textContent).toContain('temporary worktree — choose the repository');
    await click(button(section('folders'), 'Add folder'));
    expect(api.update).not.toHaveBeenCalled();
  });

  it('#folders on a project without folders focuses the path field', async () => {
    await render(detail({ folders: [] }), '/projects/p1/settings#folders');
    expect(document.activeElement?.closest('.pj-folder-add .pj-folder-picker')).not.toBeNull();
  });
});
