// B-687 — team / cross-session text keeps the line breaks its author wrote.
// Upstream (CLI formatSessionPeerMessage, daemon team worker, server team
// store) only trims; the newlines were lost in CSS (`white-space: normal`).
// Each surface below renders the text into an element whose class is pinned
// here, and the stylesheet must give that class a newline-preserving
// white-space. Intentional one-line previews (sidebar/board rows, the team
// message summary, the team list card) are left alone on purpose.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { TeamState } from '@slopus/happy-wire';

const MULTILINE: Array<[css: string, selector: string]> = [
  ['screens/session/teamMessage.css', '.team-message-goal'],
  ['screens/session/teamMessage.css', '.team-message-result-text'],
  ['screens/session/sessionPeerMessage.css', '.peer-message-body'],
  ['screens/teams/teams.css', '.teams-task-goal'],
  ['screens/teams/teams.css', '.teams-result-preview'],
  ['screens/teams/teams.css', '.teams-multiline'],
  ['screens/teams/teams.css', '.team-goal p'],
  ['screens/automations/automations.css', '.au-attn-reason'],
];

const srcRoot = new URL('../../', import.meta.url);
/** white-space of the last rule whose selector list contains `selector` exactly. */
function whiteSpaceOf(css: string, selector: string): string | null {
  let value: string | null = null;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    const ws = /(?:^|;)\s*white-space:\s*([^;]+)/.exec(rule[2])?.[1].trim();
    if (ws) value = ws;
  }
  return value;
}

describe('multi-line team text keeps its line breaks (B-687)', () => {
  it.each(MULTILINE)('%s %s preserves newlines', (css, selector) => {
    const source = readFileSync(new URL(css, srcRoot), 'utf8');
    expect(['pre-wrap', 'pre-line']).toContain(whiteSpaceOf(source, selector));
  });

  it('reads the last matching rule, so a later override is what counts', () => {
    expect(whiteSpaceOf('.a { white-space: pre-wrap; } .b, .a { white-space: nowrap; }', '.a')).toBe('nowrap');
    expect(whiteSpaceOf('.a b { white-space: pre-wrap; }', '.a')).toBeNull();
  });
});

const GOAL = '子任务第一行\n子任务第二行\n子任务第三行';
const RESULT = '结果第一行\n结果第二行';
const team = {
  id: 'team', name: 'Team', machineId: 'machine', version: 1, createdAt: 1,
  bots: [
    { id: 'lead', name: 'Lead', root: true, managed: true, directory: null, sessionId: 'lead-s', assistant: 'claude', generation: 1 },
    { id: 'w', name: 'Worker', root: false, managed: true, directory: null, sessionId: 'w-s', assistant: 'claude', generation: 1 },
  ],
  messages: [{ id: 'm1', taskId: 'child', senderBotId: 'lead', recipientBotId: 'w', body: '提醒第一行\n提醒第二行', deliveredAt: 1, createdAt: 1, source: 'agent' }],
  operations: [],
  schedules: [{ id: 's1', name: '巡检', botId: 'lead', body: '巡检第一行\n巡检第二行', status: 'active', nextRunAt: null, version: 1 }],
  tasks: [{
    id: 'child', parentTaskId: null, ownerBotId: 'lead', goal: GOAL, status: 'submitted', cleanup: 'none',
    assigneeBotId: 'w', goalVersion: 1, currentAttemptId: 'a1', acceptance: ['验收第一行\n验收第二行'],
    attempts: [{ id: 'a1', botId: 'w', status: 'submitted', goalVersion: 1, generation: 1, result: RESULT }],
  }],
} as unknown as TeamState;

describe('surfaces put multi-line text into the pinned classes', () => {
  let mods: {
    TeamMessageCardView: typeof import('@/screens/session/TeamMessageCard').TeamMessageCardView;
    TeamWorkspace: typeof import('./TeamWorkspace').TeamWorkspace;
    TeamSchedules: typeof import('./TeamSchedules').TeamSchedules;
    TeamTaskSummary: typeof import('./TeamTaskDetail').TeamTaskSummary;
    TeamTaskMessages: typeof import('./TeamTaskDetail').TeamTaskMessages;
  };
  beforeAll(async () => {
    installBrowserTestGlobals();
    mods = {
      TeamMessageCardView: (await import('@/screens/session/TeamMessageCard')).TeamMessageCardView,
      TeamWorkspace: (await import('./TeamWorkspace')).TeamWorkspace,
      TeamSchedules: (await import('./TeamSchedules')).TeamSchedules,
      TeamTaskSummary: (await import('./TeamTaskDetail')).TeamTaskSummary,
      TeamTaskMessages: (await import('./TeamTaskDetail')).TeamTaskMessages,
    };
  });
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, {}, el));

  it('chat team card: task goal and result', () => {
    const out = html(createElement(mods.TeamMessageCardView, { content: { preview: 'p', raw: 'r' }, team, localId: 'teams-message-m1-1' }));
    expect(out).toContain(`<strong class="team-message-goal">${GOAL}</strong>`);
    expect(out).toContain(`<span class="team-message-result-text">${RESULT}</span>`);
  });

  it('team board card: task goal (result preview already pre-line)', () => {
    const out = html(createElement(mods.TeamWorkspace, { team, onTask: () => {} }));
    expect(out).toContain(`<strong class="teams-task-goal">${GOAL}</strong>`);
    expect(out).toContain(`<span class="teams-result-preview">${RESULT}</span>`);
  });

  it('task detail: goal, acceptance and messages', () => {
    const out = html(createElement(mods.TeamTaskSummary, { team, task: team.tasks[0] })) + html(createElement(mods.TeamTaskMessages, { team, task: team.tasks[0] }));
    expect(out).toContain(`<strong class="teams-multiline">${GOAL}</strong>`);
    expect(out).toContain('<li class="teams-multiline">验收第一行\n验收第二行</li>');
    expect(out).toContain('<span class="teams-multiline">提醒第一行\n提醒第二行</span>');
  });

  it('schedule body', () => {
    const out = html(createElement(mods.TeamSchedules, { team, disabled: false, act: async () => {} }));
    expect(out).toContain('<p class="teams-multiline">巡检第一行\n巡检第二行</p>');
  });
});
