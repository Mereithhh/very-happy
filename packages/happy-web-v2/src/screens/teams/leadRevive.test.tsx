// @vitest-environment happy-dom
/**
 * B-945 — the team page after the owner accepted a root task while its lead still
 * owned open tasks (the lead was stopped, its worktree removed): a notice with
 * the counts and「接回负责人」, the reasons it is off, the accept guard on the
 * task detail and board card, and the restore banner's pointer to the team page.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';

const lang = vi.hoisted(() => ({ value: 'en' }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: lang.value }) }));
vi.mock('@/sync/storage', () => ({ useMessage: () => undefined, useSession: () => undefined }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: ({ text }: { text: string }) => createElement('div', null, text) }));
vi.mock('./useMemberExecution', () => ({ useMemberExecution: () => () => undefined }));
vi.mock('../session/Markdown', () => ({ Markdown: ({ text }: { text: string }) => createElement('div', null, text) }));

const { LeadReviveNotice } = await import('./LeadReviveNotice');
const { LEAD_REVIVE_COPY, leadReviveView, ownedTasksRefusalCount, acceptBlockedByOpenTasks } = await import('./leadRevive');
const { teamLaunchPhase } = await import('./teamPresentation');
const { revivableLeadTeam } = await import('@/screens/session/SessionArchivedBanner');
const { teamSubmitOpenTasks } = await import('@/screens/session/board/teamSubmitGuard');

const task = (id: string, status: TeamTask['status'], extra: Partial<TeamTask> = {}): TeamTask => ({ id, parentTaskId: null, goal: id, acceptance: ['a'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: `w-${id}`, status, attempts: [{ id: `a-${id}`, botId: `w-${id}`, generation: 1, goalVersion: 1, status: status === 'done' ? 'accepted' : status === 'submitted' ? 'submitted' : 'running', result: null }], currentAttemptId: `a-${id}`, cleanup: 'none', ...extra });
const op = (extra: Partial<TeamOperation>): TeamOperation => ({ id: 'spawn-lead', teamId: 'team', machineId: 'm', taskId: 'root', botId: 'lead', attemptId: 'a-root', generation: 1, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: 1, error: null, sessionId: 'lead-1', directory: '/repo', assistant: 'claude', prompt: '', createdAt: 1, ...extra });
/** The user's state: root task done, the lead's stop completed (no session), worktree gone, 2 submitted + 1 queued + 1 running. */
function incident(): TeamState {
    return {
        id: 'team', name: 'Ship it', machineId: 'm', version: 9, createdAt: 1, messages: [],
        bots: [{ id: 'lead', name: 'Lead', root: true, managed: true, assistant: 'claude', directory: '/wt/lead-1', sessionId: null, generation: 1, previousSessionIds: ['lead-1'] }],
        tasks: [task('root', 'done', { ownerBotId: null, assigneeBotId: 'lead', cleanup: 'done' }), task('s1', 'submitted'), task('s2', 'submitted'), task('q1', 'queued'), task('r1', 'running')],
        operations: [op({}), op({ id: 'stop-lead', type: 'stop', status: 'completed' })],
    };
}
const machine = (extra: Record<string, unknown> = {}) => ({ metadata: { teamLaunchVersion: 1 }, active: true, ...extra });

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); lang.value = 'en'; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ''; });
async function render(el: ReturnType<typeof createElement>) {
    const host = document.createElement('div'); document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(MemoryRouter, null, el)));
    return host;
}

describe('B-945 「接回负责人」 on the team page', () => {
    it.each(['en', 'zh-Hans'])('shows the counts and a working button on the incident state (%s)', async (l) => {
        lang.value = l;
        const copy = l === 'en' ? LEAD_REVIVE_COPY.en : LEAD_REVIVE_COPY.zh;
        const act$ = vi.fn(async () => true);
        const host = await render(createElement(LeadReviveNotice, { team: incident(), machine: machine(), disabled: false, act: act$ }));
        const notice = host.querySelector('[data-testid="team-lead-revive"]')!;
        expect(notice.getAttribute('role')).toBe('alert');
        expect(notice.textContent).toContain(copy.title(4));
        expect(notice.textContent).toContain(copy.counts({ total: 4, submitted: 2, queued: 1, running: 1, taskIds: [] }));
        expect(l === 'en' ? copy.title(4) : copy.title(4)).toBe(l === 'en' ? 'The lead has stopped with 4 tasks still open' : '负责人已停止，还有 4 个任务没收尾');
        const button = notice.querySelector('button')!;
        expect(button.textContent).toBe(copy.button);
        expect(button.disabled).toBe(false);
        await act(async () => { button.click(); });
        expect(act$).toHaveBeenCalledWith({ type: 'revive-lead', botId: 'lead' });
    });

    it('says why the button is off: computer offline, CLI too old, still loading; never a silent failure', async () => {
        for (const [m, key] of [[machine({ active: false }), 'offline'], [machine({ metadata: { teamsVersion: 1 } }), 'upgrade'], [undefined, 'loading']] as const) {
            const host = await render(createElement(LeadReviveNotice, { team: incident(), machine: m, disabled: false, act: vi.fn() }));
            expect(host.querySelector('button')!.disabled).toBe(true);
            expect(host.textContent).toContain(LEAD_REVIVE_COPY.en[key]);
            await act(async () => root!.unmount()); root = null; document.body.innerHTML = '';
        }
    });

    it('is not shown while the lead runs, has nothing open, is starting again, or the team is archived', () => {
        const online = incident(); online.bots[0].sessionId = 'lead-2';
        const nothing = incident(); for (const t of nothing.tasks) if (t.ownerBotId === 'lead') t.status = 'cancelled';
        const starting = incident(); starting.tasks.push(task('revive', 'queued', { ownerBotId: null, assigneeBotId: 'lead' }));
        const archived = { ...incident(), archivedAt: 5 };
        for (const t of [online, nothing, starting, archived]) expect(leadReviveView(t, machine())).toBeNull();
        expect(leadReviveView(incident(), machine())?.availability).toBe('ready');
    });

    it('narrates the relaunch as the lead preparing, not the old finished goal', () => {
        const t = incident();
        expect(teamLaunchPhase(t)).toBe('finished');
        t.tasks.push(task('revive', 'queued', { ownerBotId: null, assigneeBotId: 'lead', currentAttemptId: 'a-rv' }));
        t.operations.push(op({ id: 'spawn-2', taskId: 'revive', attemptId: 'a-rv', status: 'pending', claimId: null, sessionId: null, generation: 2 }));
        expect(teamLaunchPhase(t)).toBe('preparing');
    });
});

describe('B-945 「负责人还有 N 个任务没收尾」 where the owner accepts', () => {
    const legacy = () => { const t = incident(); const r = t.tasks[0]; r.status = 'submitted'; r.attempts[0].status = 'submitted'; t.bots[0].sessionId = 'lead-1'; return t; };

    it.each(['en', 'zh-Hans'])('task detail names the open tasks and why accepting waits (%s)', async (l) => {
        lang.value = l;
        const copy = l === 'en' ? LEAD_REVIVE_COPY.en : LEAD_REVIVE_COPY.zh;
        const { TeamTaskSummary } = await import('./TeamTaskDetail');
        const t = legacy();
        const host = await render(createElement(TeamTaskSummary, { team: t, task: t.tasks[0], execution: () => undefined }));
        const block = host.querySelector('[data-testid="team-accept-blocked"]')!;
        expect(block.textContent).toContain(copy.openTasks(4));
        expect(block.textContent).toContain(copy.openTasksHint);
        expect(l === 'en' ? copy.openTasks(4) : copy.openTasks(4)).toBe(l === 'en' ? 'The lead still has 4 open tasks' : '负责人还有 4 个任务没收尾');
        // A member's submitted task (it owns nothing) shows no guard.
        expect(acceptBlockedByOpenTasks(t, t.tasks[1])).toBeNull();
    });

    it('the board card turns off 验收 (not 退回) and says why', async () => {
        const { BoardCard } = await import('@/screens/session/board/BoardCard');
        const { boardCopy } = await import('@/screens/session/board/boardCopy');
        const nav = await import('@/screens/sessions/useTeamNavigation');
        nav.setTeamNavigationDevOverride([legacy()]);
        try {
            const item: AttentionItem = { id: 'i', sessionId: 'lead-1', teamId: 'team', projectId: null, source: 'team', kind: 'decision', key: 'team-submit:root', title: '根目标已提交，等你验收 · root', bodyMd: null, options: [{ id: 'accept', label: '验收' }, { id: 'return', label: '退回' }], links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1 };
            expect(teamSubmitOpenTasks(item, [legacy()])?.total).toBe(4);
            const noop = { onToggle: () => {}, onChoose: () => {}, onResolve: () => {}, onLocate: () => {}, onFollowUp: () => {} };
            const host = await render(createElement(BoardCard, { item, all: [item], copy: boardCopy(true), expanded: true, selected: false, unread: false, actions: noop }));
            expect(host.querySelector('[data-testid="board-lead-open-tasks"]')!.textContent).toBe(boardCopy(true).leadOpenTasks(4));
            const [accept, ret] = Array.from(host.querySelectorAll<HTMLButtonElement>('.brf-opt'));
            expect(accept.disabled).toBe(true);
            expect(ret.disabled).toBe(false);
            expect(boardCopy(false).leadOpenTasks(1)).toContain('1 open task;');
        } finally { nav.setTeamNavigationDevOverride(null); }
    });

    it('reads a refusal\'s count; any other refusal is not this one', () => {
        expect(ownedTasksRefusalCount({ code: 'owned_tasks_unfinished', details: { openTasks: 31 } })).toBe(31);
        expect(ownedTasksRefusalCount({ code: 'owned_tasks_unfinished', details: {} })).toBe(0);
        expect(ownedTasksRefusalCount({ code: 'stale_attempt', details: { openTasks: 3 } })).toBeNull();
    });
});

describe('B-945 the old lead conversation points at the team page', () => {
    it('finds the team for the stopped lead\'s past session only while it can be brought back', () => {
        expect(revivableLeadTeam([incident()], 'lead-1')?.team.id).toBe('team');
        expect(revivableLeadTeam([incident()], 'other')).toBeNull();
        const back = incident(); back.bots[0].sessionId = 'lead-2';
        expect(revivableLeadTeam([back], 'lead-1')).toBeNull();
        expect(revivableLeadTeam([{ ...incident(), archivedAt: 3 }], 'lead-1')).toBeNull();
        expect(LEAD_REVIVE_COPY.zh.session('Ship it', 4)).toContain('在团队页接回负责人');
        expect(LEAD_REVIVE_COPY.en.sessionLink).toBe('Open the team to bring it back');
    });
});
