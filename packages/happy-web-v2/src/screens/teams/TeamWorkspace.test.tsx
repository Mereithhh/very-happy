import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { TeamState } from '@slopus/happy-wire';
let TeamWorkspace: typeof import('./TeamWorkspace').TeamWorkspace;
let TeamProgress: typeof import('./TeamWorkspace').TeamProgress;
beforeAll(async () => { installBrowserTestGlobals(); ({ TeamWorkspace, TeamProgress } = await import('./TeamWorkspace')); });
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
  it('shows every lifecycle lane and submitted evidence without opening a disclosure', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(TeamWorkspace, { team, onTask: () => {} })));
    for (const task of team.tasks) expect(html).toContain(task.goal);
    expect(html).toContain('Evidence submitted');
    expect(html).not.toContain('<details');
    expect(html).toContain('/session/session');
    expect(html).toContain('Last event');
    expect(html).toContain('Blocked');
    expect(html).toContain('Cleanup needs attention');
    expect(html).not.toContain('scopeToken');
  });
  it('counts only accepted tasks as progress, excluding submitted and cancelled work', () => {
    const html = renderToStaticMarkup(createElement(TeamProgress, { team }));
    expect(html).toContain('max="5" value="1"');
  });
});
