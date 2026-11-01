import { describe, expect, it } from 'vitest';
import { AttentionItemPostSchema, type TeamOperation, type TeamState, type TeamTask } from '@slopus/happy-wire';
import { capAnswered, planPost, postKey, pushPresentation, replyTargetState, rootTaskTransitions, teamAccountItem, teamAccountKey, teamAccountTransitions, teamSubmitItem, truncateTitle } from './rules';

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
        // Machine ids, readable labels, and no system「recommended」(S-1d).
        expect(item.options).toEqual([{ id: 'accept', label: '验收' }, { id: 'return', label: '退回' }]);
        expect(new TextEncoder().encode(item.bodyMd!).length).toBeLessThanOrEqual(8 * 1024);
        expect(item.bodyMd!.endsWith('…')).toBe(true);
        const long = teamSubmitItem({ id: 'team', name: 'Team' }, task({ goal: 'Rewrite the release pipeline so '.repeat(8) })).title;
        expect(long.length).toBeLessThanOrEqual(120);
        expect(long).toMatch(/ so…$|pipeline…$|release…$|Rewrite…$|the…$/);
    });

    it('truncates titles between words or CJK characters, never mid-word, ending in …', () => {
        expect(truncateTitle('  short  ', 10)).toBe('short');
        expect(truncateTitle('hello world', 11)).toBe('hello world');
        expect(truncateTitle('the quick brown fox jumps', 19)).toBe('the quick brown…');
        expect(truncateTitle('the quick, brownie', 16)).toBe('the quick,…');
        expect(truncateTitle('汇报板上线前的验收条目', 6)).toBe('汇报板上线…');
        expect(truncateTitle('验收 · deploy now please', 15)).toBe('验收 · deploy…');
        // One word longer than half the title is the only mid-word cut.
        expect(truncateTitle('x'.repeat(300), 120)).toBe(`${'x'.repeat(119)}…`);
        // A surrogate pair is never split; the cap counts UTF-16 units like the wire schema.
        const emoji = truncateTitle('😀'.repeat(10), 6);
        expect(emoji).toBe('😀😀…');
        expect(emoji.length).toBeLessThanOrEqual(6);
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

describe('B-850d team account refusals', () => {
    const op = (over: Partial<TeamOperation>): TeamOperation => ({ id: 'op1', teamId: 'team', machineId: 'm', taskId: 't1', botId: 'b1', attemptId: 'a1', generation: 1, type: 'spawn', status: 'claimed', claimId: 'c', claimedAt: 1, error: null, sessionId: null, directory: '/r', assistant: 'claude', prompt: 'p', createdAt: 1, ...over });
    const withOps = (operations: TeamOperation[]): TeamState => ({ ...team([]), name: 'Release', bots: [{ id: 'b1', name: 'Builder', sessionId: null, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r' }], operations });
    const refused = op({ status: 'failed', failedAt: 5, error: 'agent-profile-unavailable:expired: account "Org A" — sign in again…', agentProfile: { id: 'org-a', label: 'Org A' } });

    it('a spawn that just failed for its account is refused once; other failures and stop ops are not', () => {
        expect(teamAccountTransitions(withOps([op({})]), withOps([refused]))).toEqual({ refused: [refused], cleared: [] });
        expect(teamAccountTransitions(withOps([refused]), withOps([refused]))).toEqual({ refused: [], cleared: [] });
        expect(teamAccountTransitions(withOps([op({})]), withOps([op({ status: 'failed', error: 'Agent process exited' })])).refused).toEqual([]);
        expect(teamAccountTransitions(withOps([]), withOps([{ ...refused, type: 'stop' }])).refused).toEqual([]);
    });

    it('retried / launched afterwards → cleared', () => {
        // 「重试启动」only stamps retryRequestedAt: the item closes; the same refusal again (new failedAt) reopens it.
        const retried = { ...refused, retryRequestedAt: 9 };
        expect(teamAccountTransitions(withOps([refused]), withOps([{ ...refused, status: 'completed' }])).cleared).toHaveLength(1);
        expect(teamAccountTransitions(withOps([refused]), withOps([retried]))).toEqual({ refused: [], cleared: [retried] });
        const again = { ...retried, failedAt: 12 };
        expect(teamAccountTransitions(withOps([retried]), withOps([again]))).toEqual({ refused: [again], cleared: [] });
    });

    it('the item names member, account and reason, gives both ways out, and is a valid post', () => {
        const item = teamAccountItem(withOps([refused]), refused);
        expect(item.key).toBe(teamAccountKey('op1'));
        expect(item.kind).toBe('blocked');
        expect(item.title).toBe('成员 Builder 的账号「Org A」登录已过期，这一轮没有启动 · Release');
        expect(item.bodyMd).toContain('没有改用本机登录');
        expect(item.bodyMd).toContain('重新登录');
        expect(item.bodyMd).toContain('换账号');
        expect(item.bodyMd).toContain('重试启动');
        expect(() => AttentionItemPostSchema.parse({ sessionId: 's', ...item })).not.toThrow();
        expect(teamAccountItem(withOps([]), { ...refused, agentProfile: undefined, error: 'agent-profile-unavailable:missing: x' }).title).toContain('「机器默认账号」在这台电脑上不存在');
    });
});
