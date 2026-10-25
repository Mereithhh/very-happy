import { describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import type { Message, UserTextMessage } from '@/sync/typesMessage';
import { buildLeadFixture } from '@/dev/leadSessionFixture';
import { buildChatRows } from './chatTurns';
import { isBottomEdgeChange, unseenRows } from './chatFollow';
import { leadViewEntries, leadViewKeys, ownerAnswers, turnOpenerIds, turnOrigin, type LeadViewEntry } from './leadView';
import { DEFAULT_LEAD_VIEW, LEAD_VIEW_LIMIT, leadViewFor, parseLeadViewPrefs, withLeadView } from './leadViewPrefs';
import { foldSummary, leadViewCopy } from './leadViewCopy';

const TASK = '11111111-2222-4333-8444-555555555555';
const env = (id: string, from: string, body = 'body') => `[Very Happy team message ${id}; task ${TASK}; from ${from}]\n${body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
const team = {
    id: 't', name: 'Team', machineId: 'm', version: 1, createdAt: 0, tasks: [], operations: [],
    bots: [{ id: 'lead', name: 'Lead', root: true }, { id: 'bot-a', name: '成员 A', root: false }],
    messages: [
        { id: 'tm-member', taskId: TASK, senderBotId: 'bot-a', source: 'agent', recipientBotId: 'lead', body: '', deliveredAt: 1, createdAt: 1 },
        { id: 'tm-system', taskId: TASK, senderBotId: null, source: 'system', recipientBotId: 'lead', body: '', deliveredAt: 1, createdAt: 1 },
        { id: 'tm-owner', taskId: TASK, senderBotId: null, source: 'user', recipientBotId: 'lead', body: '', deliveredAt: 1, createdAt: 1 },
    ],
} as unknown as TeamState;
const msg = (text: string, sentFrom?: string): Pick<UserTextMessage, 'text' | 'meta'> => ({ text, meta: sentFrom ? { sentFrom } : undefined });

describe('turnOrigin — transport fields, never prose', () => {
    it('reads the team message record first', () => {
        expect(turnOrigin(msg(env('tm-member', '成员 A'), 'team'), team)).toEqual({ source: 'member', sender: '成员 A' });
        expect(turnOrigin(msg(env('tm-system', 'System'), 'team'), team)).toEqual({ source: 'system' });
        expect(turnOrigin(msg(env('tm-owner', 'Owner'), 'team'), team)).toEqual({ source: 'owner' });
        // The record wins over what the envelope claims.
        expect(turnOrigin(msg(env('tm-member', 'System'), 'team'), team).source).toBe('member');
        expect(turnOrigin(msg(env('tm-system', '成员 A'), 'team'), team).source).toBe('system');
    });
    it('falls back to the daemon-written envelope sender when the record is not in the snapshot', () => {
        expect(turnOrigin(msg(env('tm-gone', 'System'), 'team'), team)).toEqual({ source: 'system' });
        expect(turnOrigin(msg(env('tm-gone', 'Owner'), 'team'), undefined)).toEqual({ source: 'owner' });
        expect(turnOrigin(msg(env('tm-gone', '成员 C'), 'team'), undefined)).toEqual({ source: 'member', sender: '成员 C' });
    });
    it('treats the envelope-less initial assignment of the lead as the owner’s goal', () => {
        expect(turnOrigin(msg('# skill\n\n## Assigned goal\nTask x\nShip it', 'team'), team)).toEqual({ source: 'owner' });
    });
    it('classifies the other sentFrom values', () => {
        expect(turnOrigin(msg('<task-notification><summary>done</summary><status>completed</status></task-notification>', 'cli'), team).source).toBe('system');
        expect(turnOrigin(msg('hi', 'automation'), team).source).toBe('system');
        expect(turnOrigin(msg('hi', 'assistant'), team).source).toBe('system');
        expect(turnOrigin(msg('hi', 'session-peer'), team).source).toBe('member');
        for (const from of [undefined, 'web', 'ios', 'android', 'mac', 'cli', 'shared']) expect(turnOrigin(msg('hi', from), team).source).toBe('owner');
    });
    it('a person pasting an envelope is still the owner (no sentFrom=team)', () => {
        expect(turnOrigin(msg(env('tm-system', 'System'), 'web'), team).source).toBe('owner');
    });
});

function fixtureEntries(extra = 0) {
    const f = buildLeadFixture({ now: 1_800_000_000_000, extra });
    const rows = buildChatRows(f.messages, false, { turnDiffs: true });
    const origin = (m: UserTextMessage) => turnOrigin(m, f.team);
    return { f, rows, origin, entries: leadViewEntries(rows, turnOpenerIds(f.messages), origin) };
}
const rowMessageIds = (entries: LeadViewEntry[]) => entries.flatMap((e) => (e.type === 'row' && e.row.type === 'message' ? [e.row.message.id] : []));

describe('leadViewEntries on a real long lead session (structure of the B-766 sample)', () => {
    it('keeps every owner turn and folds every member / system turn', () => {
        const { f, entries, origin } = fixtureEntries();
        const visible = new Set(rowMessageIds(entries));
        for (const id of f.ownerIds) expect(visible.has(id)).toBe(true);
        for (const m of f.messages) {
            if (m.kind !== 'user-text' || m.meta?.sentFrom !== 'team') continue;
            expect(visible.has(m.id)).toBe(origin(m).source === 'owner');
        }
        // Each owner question's own answer is on screen.
        const answers = ownerAnswers(f.messages, origin);
        for (const id of f.ownerIds) expect(visible.has(answers.get(id)!)).toBe(true);
    });

    it('counts what each fold holds from the openers it swallowed', () => {
        const { f, entries, origin } = fixtureEntries();
        const folds = entries.filter((e) => e.type === 'fold');
        const teamOpeners = f.messages.filter((m): m is UserTextMessage => m.kind === 'user-text' && m.meta?.sentFrom === 'team');
        const sum = (k: 'members' | 'system') => folds.reduce((n, e) => n + (e.type === 'fold' ? e[k] : 0), 0);
        expect(sum('members')).toBe(teamOpeners.filter((m) => origin(m).source === 'member').length);
        // system = idle / queued notices + background-task notifications that opened a turn.
        const openers = turnOpenerIds(f.messages);
        const notifications = f.messages.filter((m) => m.kind === 'user-text' && m.meta?.sentFrom === 'cli' && openers.has(m.id)).length;
        expect(sum('system')).toBe(teamOpeners.filter((m) => origin(m).source === 'system').length + notifications);
        expect(folds.every((e) => e.type === 'fold' && e.rows.length > 0 && e.key === `fold-${e.rows[0].key}`)).toBe(true);
        // Consecutive noise is ONE fold: never two folds side by side.
        entries.forEach((e, i) => { if (e.type === 'fold') expect(entries[i + 1]?.type).not.toBe('fold'); });
        // B-809: what stays on screen outside owner turns is the lead's own text, each with its origin line.
        const replies = entries.filter((e) => e.type === 'row' && e.via);
        expect(replies.length).toBeGreaterThan(20);
        for (const e of replies) expect(e.type === 'row' && e.row.type === 'message' && e.row.message.kind).toBe('agent-text');
        // Most of the transcript still leaves the screen.
        const visibleRows = entries.filter((e) => e.type === 'row').length + folds.length;
        expect(visibleRows / f.messages.length).toBeLessThan(0.45);
    });

    it('a fold row reads 「成员消息 n · 系统通知 n · 负责人处理 n 轮」 with the members who wrote', () => {
        const { entries } = fixtureEntries();
        const fold = entries.find((e) => e.type === 'fold' && e.members > 0 && e.system > 0 && e.leadTurns > 0);
        expect(fold?.type).toBe('fold');
        if (fold?.type !== 'fold') return;
        expect(foldSummary(fold, leadViewCopy(true))).toBe(`成员消息 ${fold.members} · 系统通知 ${fold.system} · 负责人处理 ${fold.leadTurns} 轮`);
        expect(fold.senders.length).toBeGreaterThan(0);
        expect(fold.senders.every((s) => /^成员 [ABC]$/.test(s))).toBe(true);
        expect(foldSummary({ members: 0, system: 1, leadTurns: 0 }, leadViewCopy(true))).toBe('系统通知 1');
    });

    it('a member who wrote several times without a lead reply in between is one chip', () => {
        const tool = (id: string, at: number) => ({ kind: 'tool-call', id, localId: null, createdAt: at, children: [], tool: { name: 'Bash', state: 'completed', input: {}, createdAt: at, startedAt: at, completedAt: at, description: null } });
        const rows = buildChatRows([
            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } }, tool('t1', 2),
            { kind: 'user-text', id: 'm2', localId: null, createdAt: 3, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } }, tool('t2', 4),
            { kind: 'user-text', id: 'm3', localId: null, createdAt: 5, text: env('tm-gone', '成员 C'), meta: { sentFrom: 'team' } },
        ] as Message[], false, { turnDiffs: true });
        const entries = leadViewEntries(rows, new Set(['m1', 'm2', 'm3']), (m) => turnOrigin(m, team));
        expect(entries).toHaveLength(1);
        expect(entries[0].type === 'fold' && [entries[0].senders, entries[0].members, entries[0].leadTurns]).toEqual([['成员 A', '成员 C'], 3, 2]);
    });

    it('counts a lead turn only once, however many rows the lead wrote', () => {
        const rows = buildChatRows([
            { kind: 'user-text', id: 'o', localId: null, createdAt: 1, text: 'q', meta: { sentFrom: 'web' } },
            { kind: 'agent-text', id: 'a', localId: null, createdAt: 2, text: 'answer' },
            { kind: 'user-text', id: 'm', localId: null, createdAt: 3, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } },
            { kind: 'agent-text', id: 'x1', localId: null, createdAt: 4, text: 'one' },
            { kind: 'agent-text', id: 'x2', localId: null, createdAt: 5, text: 'two' },
            { kind: 'user-text', id: 's', localId: null, createdAt: 6, text: env('tm-system', 'System'), meta: { sentFrom: 'team' } },
        ] as Message[], false);
        const all = rows.map((r) => r.key);
        const entries = leadViewEntries(rows, new Set(['o', 'm', 's']), (m) => turnOrigin(m, team));
        // B-809: the member turn's progress line folds, its last text (x2) stays.
        expect(entries.map((e) => (e.type === 'fold' ? 'fold' : e.row.key))).toEqual(['o', 'a', 'fold', 'x2', 'fold']);
        const fold = entries[2];
        expect(fold.type === 'fold' && [fold.members, fold.system, fold.leadTurns]).toEqual([1, 0, 1]);
        expect(fold.type === 'fold' && fold.rows.map((r) => r.key)).toEqual(['m', 'activity-m']);
        expect(all).toEqual(['o', 'a', 'm', 'activity-m', 'x2', 's']);
    });

    it('keep() leaves a row visible inside a folded run (the phase-2 board pointer slot)', () => {
        const { entries: base } = fixtureEntries();
        const fold = base.find((e) => e.type === 'fold' && e.rows.length >= 3);
        if (fold?.type !== 'fold') throw new Error('fixture has no long fold');
        const pinned = fold.rows[1].key;
        const { f, rows, origin } = fixtureEntries();
        const kept = leadViewEntries(rows, turnOpenerIds(f.messages), origin, (row) => row.key === pinned);
        const at = kept.findIndex((e) => e.type === 'row' && e.row.key === pinned);
        expect(at).toBeGreaterThan(0);
        expect(kept[at - 1].type).toBe('fold');
        expect(kept[at + 1].type).toBe('fold');
    });

    it('member traffic flooding in adds only the lead’s replies to the screen', () => {
        const { entries: before } = fixtureEntries(0);
        const { entries: after, rows: afterRows } = fixtureEntries(6);
        const keysBefore = leadViewKeys(before, new Set());
        const keysAfter = leadViewKeys(after, new Set());
        // What was on screen stays put (the trailing fold keeps its key while it grows)…
        expect(keysAfter.slice(0, keysBefore.length)).toEqual(keysBefore);
        // …and each submission adds its fold line and the lead's reply — never the inbound message itself.
        const added = after.slice(before.length);
        expect(added.map((e) => (e.type === 'fold' ? 'fold' : e.via?.source))).toEqual(['member', 'fold', 'member', 'fold', 'member', 'fold', 'member', 'fold', 'member', 'fold', 'member']);
        const newest = keysBefore[keysBefore.length - 1];
        expect(unseenRows(newest, keysAfter)).toBe(added.length);
        // The same transcript rebuilt: nothing moves.
        expect(isBottomEdgeChange({ newestKey: newest, lastContentLen: 0 }, { newestKey: leadViewKeys(fixtureEntries(0).entries, new Set()).at(-1)!, lastContentLen: 0 })).toBe(false);
        // The same flood in 「全部消息」 does add rows at the bottom.
        expect(afterRows.length).toBeGreaterThan(buildChatRows(buildLeadFixture({ now: 1_800_000_000_000 }).messages, false, { turnDiffs: true }).length);
        // An expanded fold shows its rows in the key list.
        const fold = after[after.length - 2];
        expect(fold.type).toBe('fold');
        if (fold.type === 'fold') expect(leadViewKeys(after, new Set([fold.key])).slice(-fold.rows.length - 1, -1)).toEqual(fold.rows.map((r) => r.key));
    });
});

describe('B-809 — the lead’s text never folds, whoever triggered the turn', () => {
    const tool = (id: string, at: number, name = 'Bash', extra: object = {}) => ({ kind: 'tool-call', id, localId: null, createdAt: at, children: [],
        tool: { name, state: 'completed', input: {}, createdAt: at, startedAt: at, completedAt: at, description: null, ...extra } });
    const text = (id: string, at: number, body: string, isThinking = false) => ({ kind: 'agent-text', id, localId: null, createdAt: at, text: body, ...(isThinking ? { isThinking } : {}) });
    const SHIPPED = '已经上线。\n\n## 等你决定\n\n旧入口要不要一起下线？\n\n<options>\n<option>现在下线</option>\n<option>保留一周</option>\n</options>';
    const submitTeam = { ...team, messages: [...team.messages, { id: 'tm-submit', taskId: TASK, senderBotId: 'bot-a', source: 'agent', recipientBotId: 'lead', body: `Task ${TASK} submitted:\nPR green`, deliveredAt: 1, createdAt: 1 }] } as unknown as TeamState;
    const view = (messages: unknown[], t: TeamState = team) => {
        const list = messages as Message[];
        const rows = buildChatRows(list, false, { turnDiffs: true });
        return { rows, entries: leadViewEntries(rows, turnOpenerIds(list), (m) => turnOrigin(m, t)) };
    };
    const shape = (entries: LeadViewEntry[]) => entries.map((e) => (e.type === 'fold' ? `fold:${e.rows.map((r) => r.key).join(',')}` : `${e.via ? `via(${e.via.source})>` : ''}${e.row.key}`));

    it('owner turn: everything stays, no origin line', () => {
        const { rows, entries } = view([
            { kind: 'user-text', id: 'o', localId: null, createdAt: 1, text: 'ship it?', meta: { sentFrom: 'web' } },
            tool('t', 2), text('a', 3, SHIPPED),
        ]);
        expect(shape(entries)).toEqual(rows.map((r) => r.key));
        expect(entries.some((e) => e.type === 'row' && e.via)).toBe(false);
    });

    it('member turn: the inbound submit and the lead’s tools fold, its report (with options) stays under 「回复 成员 A 的提交」', () => {
        const { entries } = view([
            { kind: 'user-text', id: 'm', localId: null, createdAt: 1, text: env('tm-submit', '成员 A', `Task ${TASK} submitted:\nPR green`), meta: { sentFrom: 'team' } },
            text('think', 2, 'checking', true), tool('t1', 3), text('progress', 4, '先合 PR。'), tool('t2', 5), text('a', 6, SHIPPED),
        ], submitTeam);
        expect(shape(entries)).toEqual(['fold:m,activity-m', 'via(member)>a']);
        const reply = entries[1];
        expect(reply.type === 'row' && reply.via).toEqual({ source: 'member', sender: '成员 A', submit: true });
        expect(reply.type === 'row' && reply.row.type === 'message' && reply.row.message.kind === 'agent-text' && reply.row.message.text).toBe(SHIPPED);
        // The options under 「等你决定」 are the live suggestions (clickable), not folded away.
        expect(reply.type === 'row' && reply.row.type === 'message' && reply.row.optionsActive).toBe(true);
        expect(leadViewCopy(true).via(reply.type === 'row' ? reply.via! : { source: 'owner' })).toBe('回复 成员 A 的提交');
        expect(leadViewCopy(false).via({ source: 'member', sender: '成员 A', submit: true })).toBe('Replying to 成员 A’s submission');
    });

    it('system turn: the notice folds, the lead’s text stays under 「回复系统通知」', () => {
        const { entries } = view([
            { kind: 'user-text', id: 's', localId: null, createdAt: 1, text: env('tm-system', 'System', 'Agent 成员 A: idle'), meta: { sentFrom: 'team' } },
            tool('t', 2), text('a', 3, '成员 A 卡住了，我已经接手。'),
            { kind: 'user-text', id: 'n', localId: null, createdAt: 4, text: '<task-notification><summary>done</summary><status>completed</status></task-notification>', meta: { sentFrom: 'cli' } },
            tool('t2', 5), text('b', 6, '后台构建通过。'),
        ]);
        expect(shape(entries)).toEqual(['fold:s,activity-s', 'via(system)>a', 'fold:activity-n', 'via(system)>b']);
        expect(leadViewCopy(true).via({ source: 'system' })).toBe('回复系统通知');
    });

    it('only the first lead text of a turn carries the origin line; trailing work folds after it', () => {
        const { entries } = view([
            { kind: 'user-text', id: 'm', localId: null, createdAt: 1, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } },
            text('a', 2, '收到。'), tool('t', 3, 'mcp__happy__team_message'), text('b', 4, '已经转给成员 B。'),
        ]);
        expect(shape(entries)).toEqual(['fold:m,activity-m', 'via(member)>b']);
        expect(entries[1].type === 'row' && entries[1].via).toEqual({ source: 'member', sender: '成员 A' });
        expect(leadViewCopy(true).via({ source: 'member', sender: '成员 A' })).toBe('回复 成员 A');
        expect(leadViewCopy(true).via({ source: 'member' })).toBe('回复成员消息');
    });

    it('the owner’s answer to the lead’s question in a member turn stays visible', () => {
        const { entries } = view([
            { kind: 'user-text', id: 'm', localId: null, createdAt: 1, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } },
            tool('ask', 2, 'AskUserQuestion', { input: { questions: [{ question: '发吗？', header: '发布', options: [{ label: '发' }, { label: '不发' }], multiSelect: false }] }, result: 'User has answered your questions: "发吗？"="发".' }),
            text('a', 3, '好，发布。'),
        ]);
        expect(shape(entries)).toEqual(['fold:m,activity-m', 'ask:answer', 'via(member)>a']);
    });

    it('a held turn (answer still inside its activity row) stays visible instead of hiding the answer', () => {
        const list = [
            { kind: 'user-text', id: 'm', localId: null, createdAt: 1, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } },
            tool('t', 2), text('a', 3, SHIPPED),
        ] as Message[];
        const rows = buildChatRows(list, false, { turnDiffs: true, keepTurnsOpen: new Set(['m']) });
        const entries = leadViewEntries(rows, turnOpenerIds(list), (m) => turnOrigin(m, team));
        expect(shape(entries)).toEqual(['fold:m', 'via(member)>activity-m']);
    });

    it('reads the submit notice from the envelope when the record is gone', () => {
        expect(turnOrigin(msg(env('tm-gone', '成员 C', `Task ${TASK} submitted:\ndone`), 'team'), team)).toEqual({ source: 'member', sender: '成员 C', submit: true });
        expect(turnOrigin(msg(env('tm-gone', '成员 C', `Task ${TASK} is submitted: not the notice`), 'team'), team)).toEqual({ source: 'member', sender: '成员 C' });
    });
});

describe('ownerAnswers — 「已答」 = lead text after the owner turn (phase 1)', () => {
    it('maps each owner turn to its last lead text and skips unanswered and non-owner turns', () => {
        const messages = [
            { kind: 'user-text', id: 'o1', localId: null, createdAt: 1, text: 'q1', meta: { sentFrom: 'web' } },
            { kind: 'agent-text', id: 'think', localId: null, createdAt: 2, text: 'hmm', isThinking: true },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 3, text: 'first' },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 4, text: 'final' },
            { kind: 'user-text', id: 'o2', localId: null, createdAt: 5, text: 'q2', meta: { sentFrom: 'web' } },
            { kind: 'tool-call', id: 't', localId: null, createdAt: 6, children: [], tool: { name: 'Bash', state: 'completed', input: {}, createdAt: 6, startedAt: 6, completedAt: 6, description: null } },
            { kind: 'user-text', id: 'm', localId: null, createdAt: 7, text: env('tm-member', '成员 A'), meta: { sentFrom: 'team' } },
            { kind: 'agent-text', id: 'a3', localId: null, createdAt: 8, text: 'to the member' },
        ] as Message[];
        const answers = ownerAnswers(messages, (m) => turnOrigin(m, team));
        expect([...answers]).toEqual([['o1', 'a2']]);
    });
    it('answers every owner question of the fixture with that turn’s text', () => {
        const { f, origin } = fixtureEntries();
        const answers = ownerAnswers(f.messages, origin);
        expect(answers.size).toBe(f.ownerIds.length);
        for (const [owner, answer] of answers) {
            const o = f.messages.findIndex((m) => m.id === owner);
            const a = f.messages.findIndex((m) => m.id === answer);
            expect(a).toBeGreaterThan(o);
            expect(f.messages[a].kind).toBe('agent-text');
        }
    });
});

describe('lead view preference (per session, default 「只看我和负责人」)', () => {
    it('defaults to owner and remembers an explicit choice per session', () => {
        expect(DEFAULT_LEAD_VIEW).toBe('owner');
        expect(leadViewFor({}, 's1')).toBe('owner');
        const prefs = withLeadView({}, 's1', 'all');
        expect(leadViewFor(prefs, 's1')).toBe('all');
        expect(leadViewFor(prefs, 's2')).toBe('owner');
    });
    it('parses defensively and trims the oldest choices', () => {
        expect(parseLeadViewPrefs('{"a":"all","b":"bogus","c":"owner"}')).toEqual({ a: 'all', c: 'owner' });
        expect(parseLeadViewPrefs('[1]')).toEqual({});
        expect(parseLeadViewPrefs('nope')).toEqual({});
        let prefs = {};
        for (let i = 0; i <= LEAD_VIEW_LIMIT; i++) prefs = withLeadView(prefs, `s${i}`, 'all');
        expect(Object.keys(prefs)).toHaveLength(LEAD_VIEW_LIMIT);
        expect(leadViewFor(prefs, 's0')).toBe('owner');
        expect(leadViewFor(prefs, `s${LEAD_VIEW_LIMIT}`)).toBe('all');
    });
});
