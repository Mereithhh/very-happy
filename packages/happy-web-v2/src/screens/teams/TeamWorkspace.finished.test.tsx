// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';

/**
 * B-753 — the Teams page 「已结束」 lane: folded by default into one
 * 「已结束 N 个」 Summary row, the choice remembered per team on this device
 * (sidebarCollapsedGroups `team-finished:<id>`), and when open the most recent
 * 20 cards plus 「显示更多」. The live lanes never fold.
 */
let TeamWorkspace: typeof import('./TeamWorkspace').TeamWorkspace;
let collapsed: typeof import('@/screens/sessions/sidebarCollapsedGroups');
beforeAll(async () => {
  ({ TeamWorkspace } = await import('./TeamWorkspace'));
  collapsed = await import('@/screens/sessions/sidebarCollapsedGroups');
});

const task = (id: string, status: TeamTask['status'], extra: Partial<TeamTask> = {}): TeamTask => ({
  id, parentTaskId: null, ownerBotId: null, goal: `Goal ${id}`, status, cleanup: 'none', assigneeBotId: 'lead',
  goalVersion: 1, currentAttemptId: id, acceptance: [], attempts: [{ id, botId: 'lead', status: 'accepted', goalVersion: 1, generation: 1, result: null }], ...extra,
});
const stop = (taskId: string, createdAt: number): TeamOperation => ({
  id: `stop-${taskId}`, teamId: 'big', machineId: 'm', taskId, botId: 'lead', attemptId: taskId, generation: 1, type: 'stop', status: 'completed',
  claimId: null, claimedAt: null, error: null, sessionId: null, directory: null, assistant: 'claude', prompt: '', createdAt,
});
const FINISHED = 35;
const team = (id = 'big'): TeamState => ({
  id, name: 'Big', machineId: 'm', version: 1, createdAt: 1, messages: [],
  bots: [{ id: 'lead', name: 'Lead', root: true, managed: false, directory: null, sessionId: 's-lead', assistant: 'claude', generation: 1 }],
  tasks: [
    task('live', 'running'), task('review', 'submitted'), task('waiting', 'queued'),
    ...Array.from({ length: FINISHED }, (_, i) => task(`f${i + 1}`, i % 5 === 2 ? 'cancelled' : 'done')),
  ],
  // f1 finished first, f35 last.
  operations: Array.from({ length: FINISHED }, (_, i) => stop(`f${i + 1}`, 1000 + i)),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  collapsed.resetCollapsedGroupsForTest();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (t: TeamState = team()) => act(() => root.render(createElement(MemoryRouter, {}, createElement(TeamWorkspace, { team: t, onTask: () => {} }))));
const lane = () => host.querySelector<HTMLDetailsElement>('details.teams-lane-finished')!;
const cards = () => [...lane().querySelectorAll('.teams-task-preview strong')].map(e => e.textContent);
const more = () => lane().querySelector<HTMLButtonElement>('.teams-lane-more');
/** What the browser does on a Summary click / Enter / Space: flip `open`, fire `toggle`. */
const toggle = () => act(() => { const d = lane(); d.open = !d.open; d.dispatchEvent(new Event('toggle')); });

describe('B-753 「已结束」 lane', () => {
  it('starts folded into one 「Finished · N」 Summary row; live lanes stay open', () => {
    render();
    expect(lane().open).toBe(false);
    const summary = lane().querySelector('summary.vh-summary')!;
    expect(summary.textContent).toBe('Finished · 35');
    expect(summary.querySelector('.vh-summary-chevron')).not.toBeNull();
    expect(cards()).toEqual([]);
    expect(more()).toBeNull();
    for (const goal of ['Goal live', 'Goal review']) expect(host.textContent).toContain(goal);
    expect(host.querySelectorAll('details')).toHaveLength(1);
  });

  it('opens to the 20 most recent finished tasks, then 「Show more」 adds the rest', () => {
    render();
    toggle();
    expect(lane().open).toBe(true);
    expect(cards()).toHaveLength(20);
    expect(cards()[0]).toBe('Goal f35');
    expect(cards()[19]).toBe('Goal f16');
    expect(more()!.textContent).toBe('Show more (15 left)');
    act(() => more()!.click());
    expect(cards()).toHaveLength(35);
    expect(cards()[34]).toBe('Goal f1');
    expect(more()).toBeNull();
  });

  it('remembers the choice per team on this device, across remounts', () => {
    render();
    toggle();
    expect(JSON.parse(localStorage.getItem(collapsed.COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual({ 'team-finished:big': false });
    act(() => root.unmount());
    root = createRoot(host);
    collapsed.resetCollapsedGroupsForTest(); // drop the in-memory copy: reload from localStorage
    render();
    expect(lane().open).toBe(true);
    expect(cards()).toHaveLength(20);
    // Another team keeps its own default.
    render(team('other'));
    expect(lane().open).toBe(false);
    render();
    toggle();
    expect(lane().open).toBe(false);
    expect(collapsed.isGroupCollapsed(JSON.parse(localStorage.getItem(collapsed.COLLAPSED_GROUPS_STORAGE_KEY)!), 'team-finished:big')).toBe(true);
  });

  it('closing resets paging; reopening starts at 20 again', () => {
    render();
    toggle();
    act(() => more()!.click());
    expect(cards()).toHaveLength(35);
    toggle();
    toggle();
    expect(cards()).toHaveLength(20);
  });

  it('a team with no finished work shows a plain empty lane, no disclosure', () => {
    render({ ...team(), tasks: team().tasks.slice(0, 3), operations: [] });
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelectorAll('.teams-lane')).toHaveLength(4);
  });
});
