import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { TeamState } from '@slopus/happy-wire';
let TeamWorkspace: typeof import('./TeamWorkspace').TeamWorkspace;
let TeamProgress: typeof import('./TeamWorkspace').TeamProgress;
let TeamMembers: typeof import('./TeamWorkspace').TeamMembers;
let TeamListCard: typeof import('./TeamWorkspace').TeamListCard;
let collapsed: typeof import('@/screens/sessions/sidebarCollapsedGroups');
beforeAll(async () => { installBrowserTestGlobals(); ({ TeamWorkspace, TeamProgress, TeamMembers, TeamListCard } = await import('./TeamWorkspace')); collapsed = await import('@/screens/sessions/sidebarCollapsedGroups'); });
const team = {
  id: 'team', name: 'Team', machineId: 'machine', version: 1, createdAt: 1,
  bots: [{ id: 'lead', name: 'Lead', lastEvent: 'blocked', lastEventAt: 1, root: true, managed: false, directory: null, sessionId: 'session', assistant: 'pi-acp', generation: 1 }],
  messages: [], operations: [],
  tasks: ['queued', 'running', 'submitted', 'done', 'cancelled'].map((status, index) => ({
    id: status, parentTaskId: null, ownerBotId: null, goal: `Goal ${status}`, status, cleanup: status === 'done' ? 'failed' : 'none',
    assigneeBotId: 'lead', goalVersion: 1, currentAttemptId: status, acceptance: ['Verified'],
    attempts: [{ id: status, botId: 'lead', status: 'submitted', goalVersion: 1, generation: 1, result: index > 1 ? `Evidence ${status}` : null }],
  })),
} as TeamState;
describe('team workspace presentation', () => {
  it('shows every live lane and submitted evidence without opening a disclosure; 「已结束」 starts folded (B-753)', () => {
    collapsed.resetCollapsedGroupsForTest();
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(TeamWorkspace, { team, onTask: () => {} })));
    for (const task of team.tasks.filter(t => !['done', 'cancelled'].includes(t.status))) expect(html).toContain(task.goal);
    expect(html).toContain('Evidence submitted');
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain('<details class="teams-lane teams-lane-finished">');
    expect(html).toContain('Finished · 2');
    expect(html).not.toContain('Goal done');
    expect(html).toContain('/session/session');
    expect(html).toContain('Last event');
    expect(html).toContain('Blocked');
    expect(html).not.toContain('scopeToken');
  });
  it('counts only accepted tasks as progress, excluding submitted and cancelled work', () => {
    const html = renderToStaticMarkup(createElement(TeamProgress, { team }));
    expect(html).toContain('max="5" value="1"');
  });
});

describe('B-690 inactive members on the Teams page', () => {
  const now = 1_000_000_000;
  const members = {
    ...team,
    id: 'fold-team',
    bots: [
      { ...team.bots[0], id: 'busy', name: 'Busy', sessionId: 's-busy', lastEvent: 'idle', lastEventAt: now },
      { ...team.bots[0], id: 'done', name: 'Finished', root: false, sessionId: null, lastEvent: undefined, lastEventAt: undefined },
      { ...team.bots[0], id: 'gone', name: 'Archived', root: false, sessionId: 's-gone', lastEvent: 'idle', lastEventAt: now },
      { ...team.bots[0], id: 'stuck', name: 'Stuck', root: false, sessionId: null },
    ],
    tasks: [{ ...team.tasks[1], assigneeBotId: 'busy' }, { ...team.tasks[3], id: 'finished', assigneeBotId: 'done' }],
    operations: [
      { id: 'op', teamId: 'fold-team', machineId: 'm', taskId: 'finished', botId: 'done', attemptId: 'done', generation: 1, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: 1, sessionId: 's-done', createdAt: 1 },
      { id: 'op2', teamId: 'fold-team', machineId: 'm', taskId: 'finished', botId: 'stuck', attemptId: 'done', generation: 1, type: 'stop', status: 'failed', claimId: 'c', claimedAt: 1, sessionId: null, createdAt: 1 },
    ],
  } as unknown as TeamState;
  const render = () => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(TeamMembers, { team: members, archivedSessionIds: new Set(['s-gone']), now })));
  it('folds stopped and archived members behind 「N inactive」, collapsed by default, history links kept', () => {
    collapsed.resetCollapsedGroupsForTest();
    const html = render();
    const [before, fold] = html.split('<details');
    expect(before).toContain('href="/session/s-busy"');
    expect(before).not.toContain('s-done');
    expect(before).toContain('<small>2</small>');
    expect(before).toContain('Stuck');
    expect(before).toContain('Cleanup needs attention');
    expect(fold).toMatch(/^ class="teams-members-inactive">/);
    expect(fold).toContain('2 inactive');
    expect(fold).toContain('href="/session/s-done"');
    expect(fold).toContain('href="/session/s-gone"');
  });
  it('opens with the same device-local choice the sidebar fold uses', () => {
    collapsed.resetCollapsedGroupsForTest();
    collapsed.setGroupCollapsed('team-archived:fold-team', false);
    expect(render()).toContain('<details class="teams-members-inactive" open=""');
    collapsed.setGroupCollapsed('team-archived:fold-team', true);
  });
});

describe('B-746 task previews never show raw markdown or the protocol header', () => {
  const goal = '[Very Happy team message m1; task t1; from Lead]\nTask 47280515-0e1a-42c8-b8b2-984a6d38af4d\n**[QA] Card task**: edit `README.md`\n\n| a | b |\n|---|---|';
  const raw = { ...team, tasks: team.tasks.map(t => ({ ...t, goal, attempts: t.attempts.map(a => ({ ...a, result: a.result && `## ${a.result}` })) })) } as TeamState;
  const clean = (html: string) => {
    expect(html).not.toMatch(/\*\*|\|---|`|## |Very Happy team message|Task 47280515/);
    expect(html).toContain('[QA] Card task: edit README.md');
  };
  it('list card task rows', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(TeamListCard, { team: raw, machine: 'dev' })));
    expect(html.match(/teams-list-task/g)).toHaveLength(2);
    clean(html);
  });
  it('board cards, results and member cards', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(TeamWorkspace, { team: { ...raw, tasks: raw.tasks.map(t => ({ ...t, id: `x-${t.id}` })) }, onTask: () => {} })));
    clean(html);
    expect(html).toContain('Evidence submitted');
    expect(html).not.toContain('## Evidence');
  });
});
