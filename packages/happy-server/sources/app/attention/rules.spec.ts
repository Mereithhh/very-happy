import { describe, expect, it } from 'vitest';
import type { TeamState, TeamTask } from '@slopus/happy-wire';
import { capAnswered, ownerRepliedTarget, planPost, postKey, pushPresentation, replyTargetState, rootTaskTransitions, teamSubmitItem } from './rules';

const task = (over: Partial<TeamTask>): TeamTask => ({
    id: 't1', parentTaskId: null, goal: 'Ship the notes\nmore', acceptance: ['a'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'lead',
    status: 'running', attempts: [{ id: 'a1', botId: 'lead', generation: 1, goalVersion: 1, status: 'running', result: null }], currentAttemptId: 'a1', cleanup: 'none', ...over,
});
const team = (tasks: TeamTask[]): TeamState => ({ id: 'team', name: 'Team', machineId: 'm', version: 1, bots: [], tasks, messages: [], operations: [], createdAt: 1 });

describe('briefing board rules', () => {
    it('keys: explicit key wins, otherwise the request id', () => {
        expect(postKey({ key: 'k', requestId: 'r' })).toBe('k');
        expect(postKey({ requestId: 'r' })).toBe('req:r');
        expect(postKey({})).toBeNull();
    });

    it('plans a post against the row holding its key', () => {
        expect(planPost(null, { kind: 'decision' })).toEqual({ action: 'create' });
        expect(planPost({ kind: 'decision', state: 'open', lastRequestId: 'r1' }, { kind: 'decision', requestId: 'r1' })).toEqual({ action: 'noop' });
        expect(planPost({ kind: 'decision', state: 'in_progress', lastRequestId: 'r1' }, { kind: 'decision', requestId: 'r2' })).toEqual({ action: 'repost', reopened: false });
        expect(planPost({ kind: 'decision', state: 'resolved', lastRequestId: 'r1' }, { kind: 'decision', requestId: 'r2' })).toEqual({ action: 'repost', reopened: true });
        expect(planPost({ kind: 'decision', state: 'dismissed', lastRequestId: null }, { kind: 'decision' })).toEqual({ action: 'repost', reopened: true });
        expect(planPost({ kind: 'question', state: 'answered', lastRequestId: null }, { kind: 'question' })).toEqual({ action: 'repost', reopened: false });
        expect(() => planPost({ kind: 'decision', state: 'open', lastRequestId: null }, { kind: 'report' })).toThrow('attention_key_kind_mismatch');
    });

    it('reply targets: answer answers, report closes, others leave it', () => {
        expect(replyTargetState('answer')).toEqual({ state: 'answered' });
        expect(replyTargetState('report')).toEqual({ state: 'resolved', resolvedBy: 'lead' });
        expect(replyTargetState('decision')).toBeNull();
    });

    it('root-task transitions: submitted once per attempt, settled when it leaves submitted; bot-owned tasks ignored', () => {
        const running = task({});
        const submitted = task({ status: 'submitted' });
        const child = task({ id: 't2', ownerBotId: 'lead', status: 'submitted' });
        expect(rootTaskTransitions(team([running, task({ id: 't2', ownerBotId: 'lead' })]), team([submitted, child]))).toEqual({ submitted: [submitted], settled: [] });
        expect(rootTaskTransitions(team([submitted]), team([submitted]))).toEqual({ submitted: [], settled: [] });
        const done = task({ status: 'done' });
        expect(rootTaskTransitions(team([submitted]), team([done]))).toEqual({ submitted: [], settled: [done] });
        // Returned then resubmitted between two reads: a new attempt is a new submit.
        const resubmitted = task({ status: 'submitted', currentAttemptId: 'a2', attempts: [{ id: 'a2', botId: 'lead', generation: 1, goalVersion: 1, status: 'submitted', result: 'r' }] });
        expect(rootTaskTransitions(team([submitted]), team([resubmitted])).submitted).toEqual([resubmitted]);
    });

    it('builds the「待你验收」item with accept / return options and a byte-capped body', () => {
        const big = task({ status: 'submitted', attempts: [{ id: 'a1', botId: 'lead', generation: 1, goalVersion: 1, status: 'submitted', result: '汇'.repeat(5000) }] });
        const item = teamSubmitItem({ id: 'team', name: 'Team' }, big);
        expect(item).toMatchObject({ source: 'team', kind: 'decision', key: 'team-submit:t1', title: '根目标已提交，等你验收 · Ship the notes' });
        expect(item.options.map(o => o.id)).toEqual(['accept', 'return']);
        expect(new TextEncoder().encode(item.bodyMd!).length).toBeLessThanOrEqual(8 * 1024);
        expect(item.bodyMd!.endsWith('…')).toBe(true);
        expect(teamSubmitItem({ id: 'team', name: 'Team' }, task({ goal: 'x'.repeat(300) })).title).toHaveLength(120);
    });

    it('owner reply settles only an unambiguous, non-team decision', () => {
        const d = (id: string, over = {}) => ({ id, kind: 'decision', source: 'lead', state: 'open', ...over });
        expect(ownerRepliedTarget([d('a'), { id: 'b', kind: 'blocked', source: 'agent', state: 'open' }])).toBe('a');
        expect(ownerRepliedTarget([d('a'), d('b')])).toBeNull();
        expect(ownerRepliedTarget([d('a', { source: 'team' })])).toBeNull();
        expect(ownerRepliedTarget([d('a', { state: 'resolved' }), d('b', { state: 'in_progress' })])).toBe('b');
    });

    it('push text per kind', () => {
        expect(pushPresentation({ kind: 'decision', title: 'Pick', replyToId: null })).toEqual({ kind: 'attention', title: '等你决定 · Pick', body: 'Pick' });
        expect(pushPresentation({ kind: 'blocked', title: 'Login', replyToId: null })?.title).toBe('需要你 · Login');
        expect(pushPresentation({ kind: 'answer', title: 'Dev-A', replyToId: 'q' })).toEqual({ kind: 'question', title: '负责人回答了你的问题', body: 'Dev-A' });
        expect(pushPresentation({ kind: 'answer', title: 'x', replyToId: null })).toBeNull();
        expect(pushPresentation({ kind: 'report', title: 'x', replyToId: null })).toBeNull();
    });

    it('caps answered items at two per session, keeping everything else', () => {
        const rows = [
            { id: 1, sessionId: 's', state: 'answered' }, { id: 2, sessionId: 's', state: 'open' }, { id: 3, sessionId: 's', state: 'answered' },
            { id: 4, sessionId: 'o', state: 'answered' }, { id: 5, sessionId: 's', state: 'answered' },
        ];
        expect(capAnswered(rows).map(r => r.id)).toEqual([1, 2, 3, 4]);
    });
});
