// @vitest-environment happy-dom
/**
 * B-763: 「换项目…」 from the team row / team page menu reuses B-726's team
 * bind — move to another project, create a same-name one, or detach (which
 * warns first and is the destructive button).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView, TeamState } from '@slopus/happy-wire';

const bindTeamProject = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/sync/teams', () => ({ bindTeamProject, TeamsApiError: class extends Error {} }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));

const { setProjectsDevOverride } = await import('@/sync/projects');
const { ChangeTeamProjectModal } = await import('./ChangeTeamProjectModal');

const project = (id: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: `Project ${id}`, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [], ...extra });
const team = { id: 't', name: 'Demo team' } as Pick<TeamState, 'id' | 'name'>;

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); bindTeamProject.mockClear(); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  setProjectsDevOverride(null);
  document.body.innerHTML = '';
});

async function render(projects: ProjectView[]) {
  setProjectsDevOverride({ status: 'ready', projects, members: [] });
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ChangeTeamProjectModal team={team} onClose={onClose} />));
  return { onClose };
}
const applyButton = () => [...document.querySelectorAll<HTMLButtonElement>('.vh-dialog-foot button')].at(-1)!;
async function pick(value: string) {
  const trigger = document.querySelector<HTMLButtonElement>('#ctp-project')!;
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
  const option = document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`missing option ${value}`);
  await act(async () => option.click());
}

describe('ChangeTeamProjectModal (B-763)', () => {
  it('opens on the current project; nothing to apply until the choice changes', async () => {
    await render([project('a', { teamIds: ['t'] }), project('b')]);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Demo team');
    expect(document.querySelector('#ctp-project')!.textContent).toContain('Project a');
    expect(applyButton().disabled).toBe(true);
  });

  it('moving to another project binds it and closes', async () => {
    const { onClose } = await render([project('a', { teamIds: ['t'] }), project('b')]);
    await pick('b');
    expect(applyButton().textContent).toBe('Apply');
    await act(async () => applyButton().click());
    expect(bindTeamProject).toHaveBeenCalledWith('t', { projectId: 'b' });
    expect(onClose).toHaveBeenCalled();
  });

  it('choosing no project warns what members lose and detaches with the destructive button', async () => {
    await render([project('a', { teamIds: ['t'] })]);
    const none = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(none).toEqual([]); // listbox closed until opened
    const trigger = document.querySelector<HTMLButtonElement>('#ctp-project')!;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    const noneOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('No project'))!;
    await act(async () => noneOption.click());
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Project a');
    expect(applyButton().textContent).toBe('Remove');
    expect(applyButton().className).toContain('danger');
    await act(async () => applyButton().click());
    expect(bindTeamProject).toHaveBeenCalledWith('t', { projectId: null });
  });

  it('archived projects are not offered', async () => {
    await render([project('a'), project('old', { archivedAt: 3 })]);
    const trigger = document.querySelector<HTMLButtonElement>('#ctp-project')!;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="option"][data-value="old"]')).toBeNull();
    expect(document.querySelector('[role="option"][data-value="a"]')).not.toBeNull();
  });
});
