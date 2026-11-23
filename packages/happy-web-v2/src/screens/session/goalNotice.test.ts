// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { zhHans } from '@/text/translations/zh-Hans';
import { DSH_SESSION_NOTICE, dshKeyHintText, goalNoticeText, isDshRawNoKeyLine, isDshSessionNotice, parseDshKeyHint, parseGoalNotice } from './goalNotice';
import { presentServiceEvent } from './serviceEvent';

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

// B-960: the dsh wrapper's "no key" hint (CLI 0.2.223 dshMissingKeyHint, and the B-952 line of older CLIs).
describe('parseDshKeyHint (B-960)', () => {
    const withAccount = 'DeepSeek Harness has no API key: this session runs on the machine login, which has no DeepSeek key on this machine. Set this machine\'s DeepSeek default to "dsh_coding" under Settings → Models & accounts, or pick it when starting a session.';
    const add = 'DeepSeek Harness has no API key on this machine. Add a DeepSeek account under Settings → Models & accounts, or set DEEPSEEK_API_KEY in the daemon\'s environment.';
    const oldAdd = 'DeepSeek Harness has no API key. Add a DeepSeek account under Settings → Models & accounts on this machine, or set DEEPSEEK_API_KEY in the daemon\'s environment.';
    const raw = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';

    it('reads both hints; the account one carries its label', () => {
        expect(parseDshKeyHint(withAccount)).toEqual({ label: 'dsh_coding' });
        expect(parseDshKeyHint(add)).toEqual({ label: null });
        expect(parseDshKeyHint(oldAdd)).toEqual({ label: null });
        expect(parseDshKeyHint(raw)).toBeNull();
        expect(parseDshKeyHint('some other line')).toBeNull();
    });

    it('shows Chinese in a Chinese interface; names the account instead of asking to add one', () => {
        const zh = zhHans.session.chat;
        expect(zh.dshNoKeyUseAccount({ label: 'dsh_coding' })).toBe('这台机器的 DeepSeek 默认是本机登录，但本机没有 key。在设置 → 模型与账号里把默认改成「dsh_coding」，或新建会话时选它。');
        expect(zh.dshNoKeyUseAccount({ label: 'x' })).not.toContain('添加');
        expect(zh.dshNoKeyAddAccount).toContain('添加一个 DeepSeek 账号');
        const echo = ((key: string, p?: unknown) => p ? `${key}:${JSON.stringify(p)}` : key) as never;
        expect(dshKeyHintText({ label: 'dsh_coding' }, echo)).toBe('session.chat.dshNoKeyUseAccount:{"label":"dsh_coding"}');
        expect(dshKeyHintText({ label: null }, echo)).toBe('session.chat.dshNoKeyAddAccount');
    });

    it('dsh\'s own words are hidden (the hint says it once): `dsh error: …` and the bare turn-end reason', () => {
        expect(isDshRawNoKeyLine(`dsh error: ${raw}`)).toBe(true);
        expect(isDshRawNoKeyLine(raw)).toBe(true);
        expect(isDshRawNoKeyLine(add)).toBe(false);
        expect(isDshRawNoKeyLine(withAccount)).toBe(false);
        expect(presentServiceEvent(`dsh error: ${raw}`)).toEqual({ kind: 'hidden' });
        expect(presentServiceEvent(raw)).toEqual({ kind: 'hidden' });
        expect(presentServiceEvent('dsh error: something else')).toMatchObject({ kind: 'subtle' });
    });
});
