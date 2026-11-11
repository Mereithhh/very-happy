import { describe, expect, it } from 'vitest';
import { bareToolName, isGateBlocked, mainAgentToolView, parseIssueLine, toolResultText, type ToolCardView } from './mainAgentToolView';
import { MAIN_AGENT_TOOL_FIXTURE as fx, MAIN_AGENT_TOOL_FIXTURES } from './mainAgentToolFixtures';
import { explain, mainAgentToolCopy } from './mainAgentToolCopy';

const view = (id: string): ToolCardView => {
    const v = mainAgentToolView(fx(id));
    if (!v) throw new Error(`no card for ${id}`);
    return v;
};
const zh = mainAgentToolCopy('zh-Hans');
const en = mainAgentToolCopy('en');

describe('mainAgentToolView (B-923)', () => {
    it('every fixture maps to a card with copy in both languages, raw data kept', () => {
        for (const f of MAIN_AGENT_TOOL_FIXTURES) {
            const v = mainAgentToolView(f.tool);
            expect(v, f.id).not.toBeNull();
            for (const copy of [zh, en]) {
                expect(copy.status[v!.status], `${f.id} status`).toBeTruthy();
                expect(copy.kind[v!.kind], `${f.id} kind`).toBeTruthy();
                for (const field of v!.fields) expect(copy.field[field.key], `${f.id} ${field.key}`).toBeTruthy();
                for (const link of v!.links) expect(copy.link(link)).toBeTruthy();
            }
            expect(v!.raw.input).toBe(f.tool.input ?? null);
        }
    });

    it('unknown tools stay generic (null), odd shapes never throw', () => {
        expect(mainAgentToolView({ name: 'Bash', state: 'completed', input: { command: 'ls' }, result: 'x' })).toBeNull();
        expect(mainAgentToolView({ name: 'mcp__other__lead_delegate', state: 'completed', input: {}, result: '{}' })).toBeNull();
        for (const result of [undefined, null, 42, '', '{', '[]', { content: [{ type: 'text', text: '{"ok":true}' }] }, [{ type: 'image' }]]) {
            for (const input of [undefined, null, 'str', { acceptance: 'not-an-array', options: 3 }]) {
                for (const name of ['lead_delegate', 'session_handoff', 'owner_board_list', 'issue_list', 'dispatch_approved', 'session_peers']) {
                    expect(() => mainAgentToolView({ name: `mcp__happy__${name}`, state: 'completed', input, result })).not.toThrow();
                }
            }
        }
    });

    it('lead_delegate: team, goal, acceptance, Lead link; refusal in plain words', () => {
        const ok = view('lead_delegate-ok');
        expect(ok).toMatchObject({ kind: 'delegate', status: 'delivered', heading: 'Docs crew', links: [{ kind: 'session', sessionId: 'sess-lead-1234', role: 'lead' }] });
        expect(ok.preview).toMatch(/onboarding guide/);
        expect(ok.items).toHaveLength(3);
        expect(view('lead_delegate-running')).toMatchObject({ status: 'running', heading: 'team-docs', links: [] });
        const bad = view('lead_delegate-unreachable');
        expect(bad).toMatchObject({ status: 'failed', errorCode: 'lead_unreachable', links: [] });
        expect(explain(bad, zh)).toMatch(/Lead 不在线/);
        expect(view('lead_message-ok')).toMatchObject({ kind: 'lead-message', status: 'delivered', fields: expect.arrayContaining([{ key: 'task', value: 'task-42', mono: true }]) });
        const missing = view('lead_message-error');
        expect(missing.status).toBe('failed');
        expect(explain(missing, en)).toMatch(/not found/);
    });

    it('sessions: target link + text preview; failures keep the CLI line', () => {
        expect(view('session_spawn-ok')).toMatchObject({ status: 'spawned', heading: 'Build speed', links: [{ kind: 'session', sessionId: 'sess-target-5678' }] });
        const partial = view('session_spawn-partial');
        expect(partial).toMatchObject({ status: 'spawned', errorCode: 'first_prompt_failed' });
        expect(explain(partial, zh)).toMatch(/第一条消息没发出去/);
        expect(view('session_spawn-error')).toMatchObject({ status: 'failed', links: [], errorText: expect.stringMatching(/directory/) });
        expect(view('session_send-ok')).toMatchObject({ status: 'sent', preview: expect.stringMatching(/image pipeline/), links: [{ sessionId: 'sess-target-5678' }] });
        expect(view('session_send-error').status).toBe('failed');
        expect(view('session_message-ok')).toMatchObject({ status: 'sent', links: [{ sessionId: 'sess-target-5678' }] });
        expect(view('session_message-stored').status).toBe('stored');
    });

    it('gate 2: awaiting decision, approved, draft only, declined, still waiting, refusals', () => {
        const parked = view('session_send-awaiting');
        expect(parked).toMatchObject({ kind: 'decision', status: 'awaiting', links: [{ kind: 'board' }], fields: expect.arrayContaining([{ key: 'risk', value: 'external' }]) });
        expect(explain(parked, zh)).toMatch(/汇报板等你决定/);
        expect(view('dispatch_approved-ok')).toMatchObject({ kind: 'decision', status: 'approved', links: [{ kind: 'board' }] });
        expect(view('dispatch_approved-draft').status).toBe('draft-only');
        expect(view('dispatch_approved-dropped').status).toBe('dropped');
        expect(view('dispatch_approved-waiting').status).toBe('awaiting');
        expect(view('dispatch_approved-already').status).toBe('already');
        expect(view('dispatch_approved-not-approved').status).toBe('not-approved');
        const tampered = view('dispatch_approved-tampered');
        expect(tampered).toMatchObject({ status: 'failed', errorCode: 'card_tampered' });
        expect(explain(tampered, en)).toMatch(/changed before approval/);
        expect(explain(view('lead_delegate-risk'), zh)).toMatch(/没有标风险等级/);
        expect(explain(view('session_spawn-board'), en)).toMatch(/board is unavailable/);
    });

    it('gate 1: a stopped call (any tool, result text or permission reason) explains itself and links settings', () => {
        for (const id of ['blocked-third-party', 'blocked-permission', 'blocked-hook-real']) {
            const v = view(id);
            expect(v).toMatchObject({ kind: 'blocked', status: 'blocked', links: [{ kind: 'settings' }] });
            expect(explain(v, zh)).toMatch(/安全阀拦下/);
            expect(explain(v, en)).toMatch(/safety gate/);
        }
        expect(isGateBlocked({ state: 'error', result: 'Failed to send: timeout' })).toBe(false);
        expect(isGateBlocked({ state: 'completed', result: 'mentions 主 agent 不能直接对外发送 in passing' })).toBe(false);
    });

    it('issues / todos / notes / board', () => {
        expect(view('issue_create-ok')).toMatchObject({ kind: 'issue', heading: 'Search misses archived sessions', links: [{ kind: 'issue', ref: 'VH-12' }] });
        expect(view('issue_assign-ok').fields).toContainEqual({ key: 'assignee', value: 'claude' });
        expect(view('issue_comment-ok')).toMatchObject({ status: 'posted', links: [{ ref: 'VH-12' }] });
        expect(view('issue_comment-error')).toMatchObject({ status: 'failed', errorText: expect.stringMatching(/VH-N/) });
        expect(view('todo_add-ok')).toMatchObject({ kind: 'todo', heading: 'Review the onboarding guide draft', fields: expect.arrayContaining([{ key: 'key', value: 'T-7', mono: true }]) });
        expect(view('todo_complete-ok').status).toBe('done');
        expect(view('todo_complete-error').status).toBe('failed');
        expect(view('project_note-ok')).toMatchObject({ kind: 'note', status: 'recorded', fields: expect.arrayContaining([{ key: 'key', value: '#18', mono: true }]) });
        const old = view('project_note-refused');
        expect(old.status).toBe('failed');
        expect(explain(old, zh)).toMatch(/服务器版本太旧/);
        expect(view('owner_board_post-ok')).toMatchObject({ kind: 'board', status: 'posted', items: ['Short flow', 'Guided tour'], links: [{ kind: 'board' }] });
        expect(explain(view('owner_board_post-reserved'), zh)).toMatch(/安全闸发出/);
        expect(view('owner_board_resolve-ok').status).toBe('resolved');
    });

    it('lists: compact rows, header dropped, empty is 0, board list from JSON', () => {
        expect(view('teams_list-ok')).toMatchObject({ kind: 'list', heading: '2', items: [expect.stringMatching(/^team-docs/), expect.stringMatching(/^team-web/)] });
        expect(view('teams_list-empty')).toMatchObject({ heading: '0', items: [] });
        expect(view('todo_list-ok').items).toHaveLength(3);
        expect(view('owner_board_list-ok')).toMatchObject({ heading: '2', items: ['Which onboarding flow ships first? · open', 'Release notes ready for review · open'], links: [{ kind: 'board' }] });
        const many = mainAgentToolView({ name: 'mcp__happy__issue_list', state: 'completed', input: {}, result: Array.from({ length: 9 }, (_, i) => `VH-${i + 1}  [todo]  T${i}  (owner)`).join('\n') })!;
        expect(many).toMatchObject({ heading: '9', more: 3 });
        expect(many.items).toHaveLength(6);
    });

    it('lifecycle receipts (B-919): queued / running / already / scheduled / failed / not available', () => {
        expect(view('session_wrapup-ok')).toMatchObject({ kind: 'lifecycle', status: 'queued', links: [{ sessionId: 'sess-target-5678' }] });
        expect(view('session_wrapup-running').status).toBe('in-progress');
        expect(view('session_wrapup-error')).toMatchObject({ status: 'failed', errorText: 'wrap-up request failed' });
        expect(view('session_wrapup-deduped').status).toBe('already');
        expect(view('session_wrapup-deduped-done').status).toBe('already');
        expect(view('session_handoff-deduped')).toMatchObject({ status: 'already', links: [{ role: 'from' }, { role: 'to', sessionId: 'sess-new-9' }] });
        expect(view('session_handoff-ok')).toMatchObject({ status: 'queued', fields: expect.arrayContaining([{ key: 'to', value: 'new' }]), links: [{ role: 'from' }] });
        expect(view('session_handoff-to')).toMatchObject({ status: 'done', links: [{ role: 'from' }, { role: 'to', sessionId: 'sess-lead-1234' }] });
        expect(view('session_handoff-error')).toMatchObject({ status: 'failed', errorText: 'Could not start the new session: directory missing' });
        expect(view('session_restart-idle')).toMatchObject({ status: 'scheduled-idle', fields: expect.arrayContaining([{ key: 'version', value: '0.2.212', mono: true }]) });
        expect(view('session_restart-now').status).toBe('scheduled-now');
        expect(view('session_restart-already').status).toBe('already');
        expect(view('session_restart-busy')).toMatchObject({ status: 'failed', errorText: expect.stringMatching(/when = idle/) });
        const na = view('session_restart-unavailable');
        expect(na).toMatchObject({ kind: 'unavailable', status: 'not-available' });
        expect(explain(na, zh)).toMatch(/升级 CLI/);
        // B-919 follow-up may name a duplicate request `deduped`: same pill as `already`
        expect(mainAgentToolView({ name: 'mcp__happy__session_wrapup', state: 'completed', input: { sessionId: 's1' }, result: '{"ok":true,"sessionId":"s1","state":"queued","deduped":true}' })!.status).toBe('already');
    });

    it('helpers', () => {
        expect(bareToolName('mcp__happy__todo_add')).toBe('todo_add');
        expect(bareToolName('todo_add')).toBe('todo_add');
        expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
        expect(toolResultText({ content: [{ type: 'text', text: 'x' }] })).toBe('x');
        expect(parseIssueLine('assigned VH-3  [todo]  Fix (a) thing  (claude); run #1 queued on claude')).toEqual({ key: 'VH-3', status: 'todo', title: 'Fix (a) thing' });
    });

    it('QA P3: a Lead named "Lead" is not repeated; a distinct name is shown', () => {
        expect(view('lead_delegate-ok').fields.find((f) => f.key === 'lead')).toBeUndefined();
        const named = mainAgentToolView({ name: 'mcp__happy__lead_delegate', state: 'completed', input: { teamId: 't', goal: 'g', acceptance: ['a'] }, result: '{"ok":true,"team":"T","lead":"Docs Lead","leadSessionId":"s1","state":"delivered"}' })!;
        expect(named.fields).toContainEqual({ key: 'lead', value: 'Docs Lead' });
    });

    it('QA P3: receipt text is in the UI language — known CLI sentences translated, the rest kept with a lead-in', () => {
        const cases: Array<[string, RegExp]> = [
            ['session_restart-busy', /^会话现在不空闲（正在跑一轮对话），请改用「空闲后重启」。$/],
            ['session_restart-not-live', /不在主 agent 这台机器上运行/],
            ['session_wrapup-error', /^收尾请求没有成功。$/],
            ['session_handoff-error', /^新会话没能启动（directory missing）。$/],
            ['session_spawn-error', /^新开会话失败：directory does not exist$/],
            ['lead_message-error', /^找不到团队 team-gone。$/],
            ['todo_complete-error', /^找不到这条待办/],
            ['issue_comment-error', /^没有指定 Issue/],
            ['session_wrapup-unknown', /^回执原文：server answered 502$/],
        ];
        for (const [id, re] of cases) expect(explain(view(id), zh), id).toMatch(re);
        // English keeps the CLI's own words
        expect(explain(view('session_restart-busy'), en)).toMatch(/^it is not idle right now/);
        // codes (when a receipt carries one) map in both languages
        for (const code of ['busy:quiet', 'not-live', 'local-terminal', 'owner_request_required', 'deduped', 'already-queued']) {
            const v = mainAgentToolView({ name: 'mcp__happy__session_restart', state: 'error', input: { sessionId: 's' }, result: JSON.stringify({ ok: false, error: code }) })!;
            expect(v.errorCode, code).toBe(code);
            expect(explain(v, zh), code).toMatch(/[\u4e00-\u9fa5]/);
            expect(explain(v, en), code).toMatch(/[A-Za-z]/);
        }
        expect(zh.error('busy:quiet')).toMatch(/上一轮刚结束/);
    });
});
