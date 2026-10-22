// B-775 — a member whose cleanup failed while still holding its session cannot
// start new work (server claim `bot_cleanup_pending`). The board used to show
// such a task as「启动中」for hours (Dev-N1, Dev-M1, QA5 O4) with nothing to act on.
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import type { TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';
import { teamCleanupBlockingLaunch, teamTaskNeedsOwner, teamTaskState, teamTaskTone } from './teamTaskState';
import { en } from '@/text/_default';
import { zhHans as zh } from '@/text/translations/zh-Hans';

const ERROR = 'Original worktree ownership is unknown; manual reconciliation required';
const queued: TeamTask = { id: 'next', parentTaskId: null, goal: 'next task', acceptance: [], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'w', status: 'queued', attempts: [{ id: 'a2', botId: 'w', generation: 2, goalVersion: 1, status: 'pending', result: null }], currentAttemptId: 'a2', cleanup: 'none' };
const done: TeamTask = { ...queued, id: 'prev', goal: 'previous task', status: 'done', currentAttemptId: 'a1', attempts: [{ id: 'a1', botId: 'w', generation: 1, goalVersion: 1, status: 'accepted', result: 'ok' }], cleanup: 'failed' };
const operation = (extra: Partial<TeamOperation>): TeamOperation => ({ id: 'op', teamId: 'team', machineId: 'm', taskId: 'next', botId: 'w', attemptId: 'a2', generation: 2, type: 'spawn', status: 'pending', claimId: null, claimedAt: null, error: null, sessionId: null, directory: '/repo', assistant: 'claude', prompt: '', createdAt: 2, ...extra });
const launch = operation({});
const stop = (status: TeamOperation['status'], sessionId = 'old'): TeamOperation => operation({ id: 'stop', taskId: 'prev', attemptId: 'a1', generation: 1, type: 'stop', status, claimId: status === 'pending' ? null : 'c', error: status === 'failed' ? ERROR : null, sessionId, createdAt: 1 });
const team = (botSession: string | null, stopOp: TeamOperation): TeamState => ({
    id: 'team', name: 'T', machineId: 'm', version: 1, createdAt: 1, messages: [], tasks: [done, queued], operations: [stopOp, launch],
    bots: [{ id: 'lead', name: 'Lead', root: true, managed: true, assistant: 'claude', directory: '/repo', sessionId: 'lead-s', generation: 1 }, { id: 'w', name: 'Worker', root: false, managed: true, assistant: 'claude', directory: '/repo', sessionId: botSession, generation: 2 }],
});
const none = () => undefined;

describe('B-775 teamTaskState — a launch held by a failed cleanup', () => {
    it('is「等待清理处理」, needs the owner, and is red', () => {
        const blocked = team('old', stop('failed'));
        expect(teamCleanupBlockingLaunch(blocked, queued)?.id).toBe('stop');
        expect(teamTaskState(blocked, queued, none)).toBe('cleanupBlocked');
        expect(teamTaskNeedsOwner('cleanupBlocked')).toBe(true);
        expect(teamTaskTone('cleanupBlocked')).toBe('danger');
        expect(zh.teams.taskState.cleanupBlocked).toBe('等待清理处理');
        expect(en.teams.taskStateHint.cleanupBlocked).toContain('Execution needs attention');
    });
    it('a cleanup still running, or one whose session the daemon already stopped (unbound), is just starting', () => {
        expect(teamTaskState(team('old', stop('claimed')), queued, none)).toBe('starting');
        expect(teamTaskState(team(null, stop('failed')), queued, none)).toBe('starting');
        expect(teamCleanupBlockingLaunch(team(null, stop('failed')), queued)).toBeUndefined();
    });
});

describe('B-775 the team page says what the failed cleanup holds up', () => {
    let mods: { TeamTaskSummary: typeof import('./TeamTaskDetail').TeamTaskSummary; TeamWorkspace: typeof import('./TeamWorkspace').TeamWorkspace; OperationResolution: typeof import('./TeamsScreen').OperationResolution };
    beforeAll(async () => {
        installBrowserTestGlobals();
        mods = { TeamTaskSummary: (await import('./TeamTaskDetail')).TeamTaskSummary, TeamWorkspace: (await import('./TeamWorkspace')).TeamWorkspace, OperationResolution: (await import('./TeamsScreen')).OperationResolution };
    });
    const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, {}, el));
    it('task detail explains the wait and shows the cleanup error', () => {
        const out = html(createElement(mods.TeamTaskSummary, { team: team('old', stop('failed')), task: queued, execution: none }));
        expect(out).toContain('Waiting for cleanup');
        expect(out).toContain('retry the cleanup or mark it as handled');
        expect(out).toContain('role="alert"');
        expect(out).toContain('It is not clear which worktree this member owned');
    });
    it('member card and the attention entry name the consequence', () => {
        const blocked = team('old', stop('failed'));
        const board = html(createElement(mods.TeamWorkspace, { team: blocked, onTask: () => {}, execution: none }));
        expect(board).toContain('New tasks for this member cannot start until this is handled.');
        const entry = html(createElement(mods.OperationResolution, { team: blocked, operation: stop('failed'), retrySupported: true, cleanupRetrySupported: true, disabled: false, act: async () => {} }));
        expect(entry).toContain('New tasks for this member cannot start until this is handled. 1 queued task is waiting for it.');
        const released = team(null, stop('failed'));
        const retained = html(createElement(mods.OperationResolution, { team: released, operation: stop('failed'), retrySupported: true, cleanupRetrySupported: true, disabled: false, act: async () => {} }));
        expect(retained).toContain('new tasks start in a fresh worktree');
    });
});
