// @vitest-environment happy-dom
/**
 * B-759: a click on a sidebar team row opens the team page (B-721 sent it to
 * the lead, duplicating the expanded 「负责人」 row). The chevron only folds;
 * the lead and team settings live in the context menu; no hover board button.
 * B-762: a one-line tree node — 需要你 badge (else 「N 人」), a spinner while a
 * member runs, 「未放进项目」 outside every project; ←/→ belong to the tree.
 * B-798: a ⋯ at the row's end opens the same menu, so long-press is not the only way in.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { teamLeadSessionId, teamRowTarget } from './teamNavigation';

const { SidebarTeamRow } = await import('./SidebarTeamRow');
const { setProjectsDevOverride } = await import('@/sync/projects');

const copy = { expand: 'Expand team', collapse: 'Collapse team', openBoard: 'Open team page', openTeam: 'Open team', openLead: 'Chat with the lead', settings: 'Team settings', running: 'A member is running', actions: 'Team actions' };
const team = (sessionIds: (string | null)[], rootIndex = 0): TeamState => ({
  id: 'team-1', name: 'VeryHappy', machineId: 'm', version: 1, createdAt: 1, tasks: [], operations: [], messages: [],
  bots: sessionIds.map((sessionId, i) => ({ id: `bot-${i}`, sessionId, name: i === rootIndex ? 'Lead' : `Member ${i}`, generation: 1, root: i === rootIndex, managed: true, assistant: 'claude', directory: null })),
} as TeamState);

describe('team row target (B-759)', () => {
  it('the row opens the team page; the lead link is the root bot’s conversation, not the first member’s', () => {
    expect(teamRowTarget(team(['member', 'lead'], 1))).toEqual({ href: '/teams/team-1', leadHref: '/session/lead', leadSessionId: 'lead', settingsHref: '/teams/team-1?view=settings' });
  });
  it('no lead link while the lead has no session yet (or there is no lead)', () => {
    expect(teamRowTarget(team([null, 'member'])).leadHref).toBeNull();
    expect(teamRowTarget(team([])).leadHref).toBeNull();
    expect(teamRowTarget(team([])).href).toBe('/teams/team-1');
  });
  it('a retired lead still opens its last conversation (spawn receipt)', () => {
    const t = team([null]);
    t.operations = [{ id: 'op', teamId: t.id, machineId: 'm', taskId: 'task', botId: 'bot-0', attemptId: 'a', generation: 1, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: 1, error: null, sessionId: 'old-lead', directory: '/repo', assistant: 'claude', prompt: 'goal', createdAt: 1 }] as TeamState['operations'];
    expect(teamLeadSessionId(t)).toBe('old-lead');
    expect(teamRowTarget(t).leadHref).toBe('/session/old-lead');
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  setProjectsDevOverride(null);
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(t: TeamState, extra: Partial<Parameters<typeof SidebarTeamRow>[0]> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const onNavigate = vi.fn();
  const onToggle = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<SidebarTeamRow team={t} open={false} pathname="/" depth={1} attention={0} countLabel="2 members" running={false} copy={copy} onNavigate={onNavigate} onToggle={onToggle} {...extra} />));
  return { el: host, onNavigate, onToggle };
}

describe('SidebarTeamRow (B-759)', () => {
  it('clicking the row opens the team page, even when the lead has a conversation', async () => {
    const { el, onNavigate, onToggle } = await render(team(['lead', 'member']));
    const main = el.querySelector<HTMLButtonElement>('.sb-team-main')!;
    expect(main.title).toBe('Open team · VeryHappy');
    await act(async () => main.click());
    expect(onNavigate).toHaveBeenCalledWith('/teams/team-1');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('Enter is left to the native button (→ the same click as the team page), not swallowed or turned into a fold', async () => {
    const { el, onToggle } = await render(team(['lead']));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { el.querySelector('.sb-team-main')!.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    expect(onToggle).not.toHaveBeenCalled();
    expect(el.querySelector('.sb-team-main')!.tagName).toBe('BUTTON');
  });

  it('the chevron only folds — no navigation', async () => {
    const { el, onNavigate, onToggle } = await render(team(['lead']));
    await act(async () => el.querySelector<HTMLButtonElement>('.sb-team-toggle')!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('no hover-only board button: the row has the chevron, the main button and the ⋯', async () => {
    const { el } = await render(team(['lead']));
    expect(el.querySelector('.sb-team-board')).toBeNull();
    expect([...el.querySelectorAll('.sb-team-row > button')].map(b => b.className)).toEqual(['sb-tree-chevron sb-team-toggle', 'sb-team-main']);
    expect([...el.querySelectorAll('.sb-team-row > .sb-tree-acts > button')].map(b => b.getAttribute('aria-label'))).toEqual(['Team actions: VeryHappy']);
  });

  it('B-798: the row’s ⋯ opens the same items as long-press / right-click', async () => {
    const { el, onNavigate } = await render(team(['lead']));
    const more = el.querySelector<HTMLButtonElement>('.sb-team-menu')!;
    await act(async () => { more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(i => i.textContent?.trim())).toEqual(['Open team page', 'Chat with the lead', 'Team settings', 'Expand team']);
    await act(async () => items[2].click());
    expect(onNavigate).toHaveBeenLastCalledWith('/teams/team-1?view=settings');
  });

  it('the context menu offers team page, lead, settings and fold — in that order', async () => {
    const { el, onNavigate } = await render(team(['lead']));
    await act(async () => { el.querySelector('.sb-team-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(i => i.textContent?.trim())).toEqual(['Open team page', 'Chat with the lead', 'Team settings', 'Expand team']);
    await act(async () => items[1].click());
    expect(onNavigate).toHaveBeenLastCalledWith('/session/lead');
  });

  it('without a lead conversation the menu skips 「和负责人对话」', async () => {
    const { el } = await render(team([null]));
    await act(async () => { el.querySelector('.sb-team-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    expect([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(i => i.textContent?.trim())).toEqual(['Open team page', 'Team settings', 'Expand team']);
  });

  it('B-762: arrows are left to the tree (one handler in Sidebar) — the row itself never folds on a key', async () => {
    const { el, onToggle } = await render(team(['lead']));
    for (const k of ['ArrowRight', 'ArrowLeft']) {
      const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      await act(async () => { el.querySelector('.sb-team-main')!.dispatchEvent(ev); });
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onToggle).not.toHaveBeenCalled();
    const node = el.querySelector<HTMLElement>('[data-tree-node]')!;
    expect(node.dataset.depth).toBe('1');
    expect(node.querySelector('[data-tree-item]')).toBe(el.querySelector('.sb-team-main'));
    expect(node.querySelector('[data-tree-toggle]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('B-762: the 需要你 badge replaces the head count; a running member adds a spinner', async () => {
    const quiet = await render(team(['lead']));
    expect(quiet.el.querySelector('.sb-tree-count')!.textContent).toBe('2 members');
    expect(quiet.el.querySelector('.sb-tree-badge')).toBeNull();
    expect(quiet.el.querySelector('.sb-row-status--running')).toBeNull();
    await act(async () => root!.unmount()); root = null; host!.remove();
    const busy = await render(team(['lead']), { attention: 2, attentionLabel: '2 need you', running: true });
    expect(busy.el.querySelector('.sb-tree-badge')!.textContent).toBe('2');
    expect(busy.el.querySelector('.sb-tree-badge')!.getAttribute('aria-label')).toBe('2 need you');
    expect(busy.el.querySelector('.sb-tree-count')).toBeNull();
    expect(busy.el.querySelector('.sb-row-status--running')!.getAttribute('aria-label')).toBe('A member is running');
  });

  it('B-762: an old team outside every project says so', async () => {
    const { el } = await render(team(['lead']), { unplacedLabel: 'Not in a project' });
    expect(el.querySelector('.sb-team-unplaced')!.textContent).toBe('Not in a project');
  });

  it('selected on the team page, and on the lead’s page while folded', async () => {
    const onBoard = await render(team(['lead']), { pathname: '/teams/team-1' });
    expect(onBoard.el.querySelector('.sb-team-row')!.classList.contains('is-selected')).toBe(true);
    await act(async () => root!.unmount()); root = null; host!.remove();
    const onLeadOpen = await render(team(['lead']), { pathname: '/session/lead', open: true });
    expect(onLeadOpen.el.querySelector('.sb-team-row')!.classList.contains('is-selected')).toBe(false);
  });

  it('B-763: with projects loaded the menu adds 换项目… after settings, and it opens the team project dialog', async () => {
    setProjectsDevOverride({ status: 'ready', members: [], projects: [{ id: 'p', name: 'Demo project', goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: ['team-1'], automationIds: [] }] });
    const { el } = await render(team(['lead']));
    await act(async () => { el.querySelector('.sb-team-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(i => i.textContent?.trim())).toEqual(['Open team page', 'Chat with the lead', 'Team settings', 'Move to another project…', 'Expand team']);
    await act(async () => items[3].click());
    expect(document.querySelector('[role="dialog"][aria-labelledby="ctp-dialog-title"]')).not.toBeNull();
  });
});
