// @vitest-environment happy-dom
/**
 * B-759: a click on a sidebar team row opens the team page (B-721 sent it to
 * the lead, duplicating the expanded 「负责人」 row). The chevron only folds;
 * the lead and team settings live in the context menu; no hover board button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { teamLeadSessionId, teamRowTarget } from './teamNavigation';

const { SidebarTeamRow } = await import('./SidebarTeamRow');

const copy = { expand: 'Expand team', collapse: 'Collapse team', openBoard: 'Open team page', openTeam: 'Open team', openLead: 'Chat with the lead', settings: 'Team settings', leadStatus: 'Lead' };
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
  await act(async () => root!.render(<SidebarTeamRow team={t} open={false} pathname="/" subtitle="2 members" leadStatus={null} copy={copy} onNavigate={onNavigate} onToggle={onToggle} {...extra} />));
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

  it('no hover-only board button: the row has just the chevron and the main button', async () => {
    const { el } = await render(team(['lead']));
    expect(el.querySelector('.sb-team-board')).toBeNull();
    expect([...el.querySelectorAll('.sb-team-row > button')].map(b => b.className)).toEqual(['sb-team-toggle', 'sb-team-main']);
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

  it('keyboard: → expands, ← collapses, the other direction does nothing', async () => {
    const closed = await render(team(['lead']));
    const key = (el: HTMLElement, k: string) => act(async () => { el.querySelector('.sb-team-main')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    await key(closed.el, 'ArrowLeft');
    expect(closed.onToggle).not.toHaveBeenCalled();
    await key(closed.el, 'ArrowRight');
    expect(closed.onToggle).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount()); root = null; host!.remove();
    const opened = await render(team(['lead']), { open: true });
    await key(opened.el, 'ArrowRight');
    expect(opened.onToggle).not.toHaveBeenCalled();
    await key(opened.el, 'ArrowLeft');
    expect(opened.onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the lead’s status with the session-row classes; idle shows nothing', async () => {
    const running = await render(team(['lead']), { leadStatus: 'input', leadStatusLabel: 'Needs you' });
    const slot = running.el.querySelector('.sb-team-lead-status')!;
    expect(slot.classList.contains('sb-row-status--input')).toBe(true);
    expect(slot.getAttribute('aria-label')).toBe('Lead · Needs you');
    await act(async () => root!.unmount()); root = null; host!.remove();
    const idle = await render(team(['lead']), { leadStatus: 'idle' });
    expect(idle.el.querySelector('.sb-team-lead-status')).toBeNull();
  });

  it('selected on the team page, and on the lead’s page while folded', async () => {
    const onBoard = await render(team(['lead']), { pathname: '/teams/team-1' });
    expect(onBoard.el.querySelector('.sb-team-row')!.classList.contains('is-selected')).toBe(true);
    await act(async () => root!.unmount()); root = null; host!.remove();
    const onLeadOpen = await render(team(['lead']), { pathname: '/session/lead', open: true });
    expect(onLeadOpen.el.querySelector('.sb-team-row')!.classList.contains('is-selected')).toBe(false);
  });
});
