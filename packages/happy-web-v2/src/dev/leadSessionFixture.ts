/**
 * B-766 B-1 fixture: a team lead's conversation with the STRUCTURE of a real
 * long lead session (200 consecutive events of the B-766 sample, 10-21: who
 * spoke, in which order, seconds apart — `SEQUENCE`), and neutral example
 * text and names. Used by the leadView tests and the dev harness
 * (`/dev/lead-view/session/dev-lead`).
 *
 * Tokens: O owner · M/U/A member progress / submit / ask · S/Q system idle /
 * slot queued · N background-task notification · L lead text · T lead tool
 * call. The number is the gap to the previous event in seconds.
 */
import type { TeamMessage, TeamState } from '@slopus/happy-wire';
import type { Message } from '@/sync/typesMessage';
import type { NormalizedMessage } from '@/sync/typesRaw';

export const SEQUENCE = 'L0 T3 L6 S0 L5 O0 T15 T5 N2 T7 T8 T23 L2 T13 T6 T5 T3 L7 U0 T3 T7 T4 L7 O0 T31 T23 T52 T22 T12 T12 N-1 T9 L3 T10 T10 L11 S0 T6 T9 T7 T9 T3 T6 L6 O0 T26 T7 T4 L9 O79 T13 T9 T17 T42 T22 L18 T3 T9 L12 Q0 T3 T6 L8 O21 T13 T8 T4 T4 T38 L9 T0 T8 T18 T29 T18 T6 L7 T1 T5 L13 M0 T9 T8 T5 L6 O24 T17 N-7 T19 T1 L4 T1 T17 T18 T19 T12 L6 S0 T4 T10 T8 L4 S12 T6 T7 L4 O3 T28 T26 T5 L7 Q0 L3 N589 T7 L5 U106 T16 T4 L7 S0 L3 S73 T3 T4 T6 T5 T6 L4 T1 L7 A4 L5 U4 T12 N-3 T12 T2 T12 T8 T26 L3 T11 T4 T7 L10 S0 T5 L8 S312 T8 L3 S0 L3 N102 T5 T5 T4 T0 M1 T9 T5 L5 U4 T3 T7 L5 O464 T12 T29 T5 L6 S0 T3 L5 U689 T9 T3 L6 S0 L4 O212 T6 T13 T38 T19 T5 L10 Q0 L2 M126 T3 T0 T5 L5 U1 T3 T5 L3 M81';

export const LEAD_SESSION_ID = 'dev-lead';
export const LEAD_TEAM_ID = 'team-example';
const MEMBERS = [
    { id: 'bot-a', name: '成员 A', sessionId: 'dev-member-a' },
    { id: 'bot-b', name: '成员 B', sessionId: 'dev-member-b' },
    { id: 'bot-c', name: '成员 C', sessionId: 'dev-member-c' },
];
const TASK = '11111111-2222-4333-8444-555555555555';

const OWNER_TEXT = [
    '登录页的新样式今天能合吗？',
    '注册页也按同样的样式改一下，跟登录页一起发。',
    '顺便问下，暗色对比度这个问题谁在跟？',
    '发布说明谁来写？',
    '把表单校验的报错文案统一成短句。',
    '移动端的按钮高度先按 44 px 走。',
    '这批改动合完给我一个汇总。',
    '预发环境现在能看了吗？',
    '选 B，先发登录页。',
];
const ANSWER_TEXT = [
    '可以，测试已经全绿，等成员 A 的最后一个修复合入后就合。',
    '好，派给成员 A 做，和登录页同一个 PR 系列，做完告诉你。',
    '成员 B 在改，已经写进任务的退回意见里，预计 20 分钟。',
    '我来写，合完一起发给你看。',
    '收到，交给成员 C，改完我统一验收。',
    '好，已经同步给两位前端成员。',
    '好，全部合完后我发一份汇总。',
    '可以了，预发地址在团队页的任务里。',
    '好，按 B 执行：先发登录页，注册页下一批。',
];
const MEMBER_TEXT: Record<'M' | 'U' | 'A', string[]> = {
    M: ['进度：表单组件改完一半，正在补测试。', '进度：暗色主题的对比度已经调完，等截图。', '进度：发布说明草稿写好了。'],
    U: ['提交：PR 已开，CI 全绿，附截图。', '提交：修复已推送，回归测试通过。', '提交：文案统一完成，改动见 PR。'],
    A: ['求助：注册页要不要保留旧的第三方登录按钮？'],
};
const LEAD_NOISE_TEXT = ['收到，继续观察。', '验收通过，已合入。', '这条 idle 不用处理。', '退回：截图缺暗色版本，补上再提交。', '已转给负责的成员。'];

function envelope(id: string, from: string, body: string): string {
    return `[Very Happy team message ${id}; task ${TASK}; from ${from}]\n${body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
}

export type LeadFixture = {
    messages: Message[];
    normalized: NormalizedMessage[];
    team: TeamState;
    /** Owner message ids in order. */
    ownerIds: string[];
};

/** B-833: a member's long submission, then the lead's turn on it — text, team_message, text, tool, text. */
export const LIVE_TAIL: FixtureToken[] = [
    { kind: 'U', gap: 30, text: '提交：PR 已开，CI 全绿。\n\n改动：\n- 负责人每段文字都直接显示\n- 最新一批成员消息显示 6 行预览\n- 工具仍然折叠\n\n验证：单测、mutation、device-shots 改前改后对比。\n\n风险：只改 Web，没有协议改动。' },
    { kind: 'T', gap: 4 },
    { kind: 'L', gap: 3, text: '部署失败了，同意最小修法。' },
    { kind: 'T', gap: 2 },
    { kind: 'L', gap: 3, text: '已经让成员 A 按最小修法重推。' },
    { kind: 'T', gap: 6 },
    { kind: 'L', gap: 4, text: '重推成功，已经上线。' },
];
export type FixtureToken = { kind: string; gap: number; text?: string };

/**
 * `extra` appends a burst of member traffic (the flood the reader must not be scrolled by);
 * `tail` appends scripted tokens (B-833: `LIVE_TAIL`, one step at a time).
 */
export function buildLeadFixture(opts: { now?: number; extra?: number; tail?: readonly FixtureToken[] } = {}): LeadFixture {
    const tokens: FixtureToken[] = SEQUENCE.split(' ').map((t) => ({ kind: t[0], gap: Math.max(1, Number(t.slice(1))) }));
    for (let i = 0; i < (opts.extra ?? 0); i++) tokens.push({ kind: 'U', gap: 20 }, { kind: 'T', gap: 4 }, { kind: 'L', gap: 5 });
    tokens.push(...(opts.tail ?? []));
    const total = tokens.reduce((sum, t) => sum + t.gap, 0);
    // The last lead text of an owner turn is its visible answer; earlier ones are progress lines.
    const finalLead = new Set<number>();
    let lastLead = -1;
    let owner = false;
    tokens.forEach((t, i) => {
        if (t.kind === 'O' || 'MUASQ'.includes(t.kind)) {
            if (owner && lastLead >= 0) finalLead.add(lastLead);
            owner = t.kind === 'O';
            lastLead = -1;
        } else if (t.kind === 'L') lastLead = i;
    });
    if (owner && lastLead >= 0) finalLead.add(lastLead);
    let at = (opts.now ?? Date.now()) - total * 1000;
    let seq = 0;
    let owners = 0;
    let members = 0;
    let inOwnerTurn = false;
    const messages: Message[] = [];
    const normalized: NormalizedMessage[] = [];
    const records: TeamMessage[] = [];
    const ownerIds: string[] = [];
    const base = { localId: null, isSidechain: false } as const;
    const user = (text: string, sentFrom: string, localId: string | null = null) => {
        const id = `lead-${++seq}`;
        messages.push({ kind: 'user-text', id, localId, createdAt: at, seq, text, meta: { sentFrom } } as Message);
        normalized.push({ ...base, role: 'user', id, localId, createdAt: at, seq, content: { type: 'text', text }, meta: { sentFrom } } as NormalizedMessage);
        return id;
    };
    const teamMessage = (from: 'member' | 'system', body: string) => {
        const id = `tm-${records.length + 1}`;
        const bot = MEMBERS[members++ % MEMBERS.length];
        records.push({ id, taskId: TASK, senderBotId: from === 'member' ? bot.id : null, source: from === 'member' ? 'agent' : 'system', recipientBotId: 'bot-lead', body, deliveredAt: at, createdAt: at });
        user(envelope(id, from === 'member' ? bot.name : 'System', body), 'team', `teams-message-${id}-1`);
    };
    for (const [index, token] of tokens.entries()) {
        at += token.gap * 1000;
        switch (token.kind) {
            case 'O': {
                ownerIds.push(user(OWNER_TEXT[owners % OWNER_TEXT.length], 'web', `web-${seq + 1}`));
                owners++;
                inOwnerTurn = true;
                break;
            }
            case 'M': case 'U': case 'A': {
                const pool = MEMBER_TEXT[token.kind];
                teamMessage('member', token.text ?? pool[members % pool.length]);
                inOwnerTurn = false;
                break;
            }
            case 'S': case 'Q': {
                const name = MEMBERS[members % MEMBERS.length].name;
                teamMessage('system', token.kind === 'S'
                    ? `Agent ${name}: idle. Task ${TASK} still requires a submit.`
                    : `Agent ${name}: queued; the team is at its slot limit.`);
                inOwnerTurn = false;
                break;
            }
            case 'N': {
                user(`<task-notification>\n<task-id>bg-${seq}</task-id>\n<status>completed</status>\n<summary>后台检查已完成</summary>\n</task-notification>`, 'cli');
                break;
            }
            case 'L': {
                const id = `lead-${++seq}`;
                const text = token.text ?? (finalLead.has(index) ? ANSWER_TEXT[(owners - 1) % ANSWER_TEXT.length]
                    : inOwnerTurn ? '先看一下当前状态。' : LEAD_NOISE_TEXT[seq % LEAD_NOISE_TEXT.length]);
                messages.push({ kind: 'agent-text', id, localId: null, createdAt: at, seq, text } as Message);
                normalized.push({ ...base, role: 'agent', id, createdAt: at, seq, content: [{ type: 'text', text, uuid: `u-${id}`, parentUUID: null }] } as unknown as NormalizedMessage);
                break;
            }
            default: {
                const id = `lead-${++seq}`;
                const callId = `call-${seq}`;
                const input = { command: 'git status --short' };
                messages.push({
                    kind: 'tool-call', id, localId: null, createdAt: at, seq, children: [],
                    tool: { name: 'Bash', state: 'completed', input, createdAt: at, startedAt: at, completedAt: at + 500, description: null, result: 'ok' },
                } as unknown as Message);
                normalized.push({ ...base, role: 'agent', id, createdAt: at, seq, content: [{ type: 'tool-call', id: callId, name: 'Bash', input, description: null, uuid: `u-${id}`, parentUUID: null }] } as unknown as NormalizedMessage);
                const resultSeq = ++seq;
                normalized.push({ ...base, role: 'agent', id: `lead-${resultSeq}`, createdAt: at + 500, seq: resultSeq, content: [{ type: 'tool-result', tool_use_id: callId, content: 'ok', is_error: false, uuid: `u-${id}-r`, parentUUID: null }] } as unknown as NormalizedMessage);
            }
        }
    }
    const bot = (id: string, name: string, sessionId: string, root = false) => ({ id, name, sessionId, root, generation: 1, managed: true, assistant: 'claude', directory: null, lastEvent: 'idle', lastEventAt: at }) as TeamState['bots'][number];
    const team: TeamState = {
        id: LEAD_TEAM_ID, name: '改版小队（示例）', machineId: 'dev-machine', version: 1, createdAt: at - total * 1000,
        bots: [bot('bot-lead', 'Lead', LEAD_SESSION_ID, true), ...MEMBERS.map((m) => bot(m.id, m.name, m.sessionId))],
        tasks: [], messages: records, operations: [],
    };
    return { messages, normalized, team, ownerIds };
}
