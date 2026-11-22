// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { zhHans } from '@/text/translations/zh-Hans';
import { DSH_SESSION_NOTICE, goalNoticeText, isDshSessionNotice, parseGoalNotice } from './goalNotice';

// The exact lines CLI 0.2.220 sends (packages/happy-cli/src/codex/codexGoal.ts, agent/acp/dshRunner.ts).
describe('parseGoalNotice (B-954)', () => {
    it('reads the status line with and without usage', () => {
        expect(parseGoalNotice('Goal paused: write three files · 1.9k tokens')).toEqual({ type: 'status', status: 'paused', objective: 'write three files', usage: '1.9k' });
        expect(parseGoalNotice('Goal active: a · b · 12k / 50k tokens')).toEqual({ type: 'status', status: 'active', objective: 'a · b', usage: '12k / 50k' });
        expect(parseGoalNotice('Goal stopped: token budget reached: ship it')).toEqual({ type: 'status', status: 'budgetLimited', objective: 'ship it', usage: null });
        expect(parseGoalNotice('Goal stalled: x · 120 tokens')).toMatchObject({ status: 'blocked', usage: '120' });
    });

    it('reads every receipt runCodexGoal sends', () => {
        expect(parseGoalNotice('Goal token budget set to 5k')).toEqual({ type: 'budget-set', tokens: '5k' });
        expect(parseGoalNotice('Goal token budget removed')).toEqual({ type: 'budget-removed' });
        expect(parseGoalNotice('Goal paused — send /goal resume to continue')).toEqual({ type: 'paused-on-stop' });
        expect(parseGoalNotice('Goal cleared')).toEqual({ type: 'cleared' });
        expect(parseGoalNotice('There was no goal to clear')).toEqual({ type: 'nothing-to-clear' });
        expect(parseGoalNotice('No goal set. Usage: /goal <objective> · /goal (show) · /goal pause · /goal resume · /goal clear · /goal budget <tokens|off> (e.g. /goal budget 50000)')).toEqual({ type: 'none-set' });
        expect(parseGoalNotice('There is no goal on this conversation. Set one with /goal <objective>.')).toEqual({ type: 'no-goal' });
        expect(parseGoalNotice('There is no goal on this conversation. Set one with /goal <objective>, then its budget.')).toEqual({ type: 'no-goal-budget' });
        expect(parseGoalNotice('/goal needs Codex 0.133.0 or newer (this machine runs 0.120.0). Update Codex on that machine (npm install -g @openai/codex), then send /goal again. The message was not sent to the model.'))
            .toEqual({ type: 'needs-codex', minimum: '0.133.0', version: '0.120.0' });
        expect(parseGoalNotice('/goal needs Codex 0.133.0 or newer (this machine runs an unknown version). Update Codex on that machine (npm install -g @openai/codex), then send /goal again. The message was not sent to the model.'))
            .toMatchObject({ version: null });
        expect(parseGoalNotice('Goal command failed: boom')).toEqual({ type: 'failed', error: 'boom' });
        expect(parseGoalNotice("Goals are turned off in this machine's Codex config. Remove `goals = false` …")).toEqual({ type: 'disabled' });
    });

    it('leaves other lines alone', () => {
        expect(parseGoalNotice('Goal: something else')).toBeNull();
        expect(parseGoalNotice('Codex error: boom')).toBeNull();
        expect(parseGoalNotice('')).toBeNull();
    });

    it('renders through the text table (English default keeps the CLI wording)', () => {
        expect(goalNoticeText({ type: 'status', status: 'paused', objective: 'write three files', usage: '1.9k' }, t)).toBe('Goal paused: write three files · 1.9k tokens');
        expect(goalNoticeText({ type: 'budget-set', tokens: '5k' }, t)).toBe('Goal token budget set to 5k');
        expect(goalNoticeText({ type: 'paused-on-stop' }, t)).toBe('Goal paused — send /goal resume to continue');
        expect(isDshSessionNotice(` ${DSH_SESSION_NOTICE}\n`)).toBe(true);
        expect(t('session.chat.dshSessionNotice')).toBe(DSH_SESSION_NOTICE);
    });

    it('has Chinese for every receipt', () => {
        const zh = zhHans.session.chat.goalNotice;
        expect(zh.line({ label: zh.status.paused, objective: '写三个文件' })).toBe('目标已暂停：写三个文件');
        expect(zh.budgetSet({ tokens: '5k' })).toBe('目标的 token 预算已设为 5k');
        expect(zh.pausedOnStop).toBe('目标已暂停，发送 /goal resume 继续');
        expect(zhHans.session.chat.dshSessionNotice).toMatch(/^DeepSeek Harness 会话：回复按条显示/);
    });
});
