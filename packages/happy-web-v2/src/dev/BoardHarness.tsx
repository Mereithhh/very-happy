/** DEV-only (B-766 W-1): the REAL SessionDetailScreen of a lead session with a
 *  汇报板 — header button, aside tab, phone strip / top sheet and the in-stream
 *  pointers. Route `/dev/board/session/:id` (stripped from prod builds).
 *  `/v1/attention-items` is answered in-page (list + owner-respond, W0 shapes),
 *  so the real load / respond path runs; `?off=1` answers 404
 *  owner_board_disabled instead. Everything is a neutral local example. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { SessionDetailScreen } from '@/screens/session/SessionDetailScreen';
import { setCurrentAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { buildLeadFixture } from './leadSessionFixture';
import { markItemSeen, useAttentionStore } from '@/sync/attentionStore';
import { ATTENTION_SESSION_CAPABILITY, type AttentionItem, type TeamState } from '@slopus/happy-wire';
import '@/screens/session/session.css';

export const BOARD_SESSION_ID = 'dev-board';
const SESSION_ID = BOARD_SESSION_ID;
const BASE = Date.now() - 50 * 60_000;
const at = (min: number) => BASE + min * 60_000;
let seq = 0;

function user(text: string, min: number, localId: string, sentFrom?: string): NormalizedMessage {
    seq++;
    return { role: 'user', id: `b-${seq}`, localId, createdAt: at(min), isSidechain: false, seq, content: { type: 'text', text },
        ...(sentFrom ? { meta: { sentFrom } } : {}) } as unknown as NormalizedMessage;
}
/** A completed Bash call and its result (two transcript events, like the reducer receives them). */
function tool(command: string, min: number): NormalizedMessage[] {
    const id = `b-${++seq}`;
    const callId = `call-${seq}`;
    const input = { command };
    const call = { role: 'agent', id, localId: null, createdAt: at(min), isSidechain: false, seq,
        content: [{ type: 'tool-call', id: callId, name: 'Bash', input, description: null, uuid: `u-${id}`, parentUUID: null }] } as unknown as NormalizedMessage;
    const resultSeq = ++seq;
    const result = { role: 'agent', id: `b-${resultSeq}`, localId: null, createdAt: at(min) + 500, isSidechain: false, seq: resultSeq,
        content: [{ type: 'tool-result', tool_use_id: callId, content: 'ok', is_error: false, uuid: `u-${id}-r`, parentUUID: null }] } as unknown as NormalizedMessage;
    return [call, result];
}

/** B-809 demo: 成员 A submits → the lead accepts, ships and reports to the owner (with a decision). */
const SHIP_TASK = '11111111-2222-4333-8444-555555555555';
const SHIP_MESSAGE_ID = 'tm-ship';
const shipEnvelope = (body: string) => `[Very Happy team message ${SHIP_MESSAGE_ID}; task ${SHIP_TASK}; from 成员 A]\n${body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
function agent(text: string, min: number): NormalizedMessage {
    seq++;
    return { role: 'agent', id: `b-${seq}`, localId: null, createdAt: at(min), isSidechain: false, seq,
        content: [{ type: 'text', text, uuid: `u-${seq}`, parentUUID: null }] } as unknown as NormalizedMessage;
}

/** Fixture language follows the browser locale (captures run zh-CN and en-US). */
const ZH = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
const L = (zh: string, en: string) => (ZH ? zh : en);

const T_ZH = {
    q1: '登录页改版现在到哪一步了？今天能合吗？',
    r1: '前端 PR #431 已提交，回归测试还在跑。能不能今天合要看测试结果，结论出来放到汇报板。',
    q4: '注册页也按同样的样式改一下，跟登录页一起发。',
    r4: '好，派给成员 A 做任务 #16，和登录页同一个 PR 系列。完成后在汇报板上告诉你。',
    q2: '顺便问下，暗色对比度这个问题谁在跟？',
    r2: '成员 A 在改，已经写进任务 #12 的退回意见里，预计 20 分钟。',
    m1: '验收任务 #12，测试全绿。已上板：回答你 09:02 的问题，并请你决定发布时间。',
    q3: '发布说明谁来写？',
    r3: '我先安排一下，稍后回复你。',
    m2: '记录，继续观察。',
    submit: `Task ${SHIP_TASK} submitted:\n注册页改版完成，PR #436 CI 全绿，附亮暗截图。`,
    shipped: '登录页和注册页改版**已经上线**：PR #431、#436 已合入，生产健康检查通过，预发和生产各看了一遍。\n\n## 等你决定\n\n旧登录页的入口要不要现在一起下线？\n\n<options>\n<option>现在一起下线</option>\n<option>保留一周再下线</option>\n</options>',
};
const T_EN: typeof T_ZH = {
    q1: 'Where is the login page redesign at? Can it merge today?',
    r1: 'Frontend PR #431 is up and the regression run is still going. Whether it merges today depends on the result — I will put the answer on the board.',
    q4: 'Restyle the sign-up page the same way and ship it with the login page.',
    r4: 'OK — task #16 goes to member A, in the same PR series as the login page. I will tell you on the board when it is done.',
    q2: 'By the way, who is on the dark-mode contrast issue?',
    r2: 'Member A is fixing it; it is in the revision notes on task #12, about 20 minutes.',
    m1: 'Accepted task #12, tests all green. On the board: an answer to your 09:02 question, and a release-time decision for you.',
    q3: 'Who writes the release notes?',
    r3: 'Let me line that up and get back to you.',
    m2: 'Noted, keeping an eye on it.',
    submit: `Task ${SHIP_TASK} submitted:\nSign-up page redesign done, PR #436 CI green, light and dark captures attached.`,
    shipped: 'The login and sign-up redesign **is live**: PRs #431 and #436 are merged, production health checks pass, and I looked at staging and production.\n\n## Waiting on you\n\nRetire the old login page entry now as well?\n\n<options>\n<option>Retire it now</option>\n<option>Keep it one more week</option>\n</options>',
};
const T = ZH ? T_ZH : T_EN;

function messages(): NormalizedMessage[] {
    seq = 0;
    return [
        user(T.q1, 0, 'owner-q1'), agent(T.r1, 1),
        user(T.q4, 11, 'owner-q4'), agent(T.r4, 11.5),
        user(T.q2, 12, 'owner-q2'), agent(T.r2, 12.5),
        agent(T.m1, 34),
        user(T.q3, 39, 'owner-q3'), agent(T.r3, 39.5),
        agent(T.m2, 43),
        user(shipEnvelope(T.submit), 45, `teams-message-${SHIP_MESSAGE_ID}-1`, 'team'),
        ...tool('gh pr merge 436 --squash', 45.5), ...tool('curl -fsS https://example.com/health', 47),
        agent(T.shipped, 48),
    ];
}

/** Transcript id of the agent message with this text (the reducer assigns ids). */
function agentId(text: string): string | undefined {
    const list = storage.getState().sessionMessages[SESSION_ID]?.messages ?? [];
    return list.find((m) => m.kind === 'agent-text' && m.text === text)?.id;
}

type Draft = Partial<AttentionItem> & Pick<AttentionItem, 'id' | 'source' | 'kind' | 'title' | 'needsOwner' | 'state' | 'createdAt' | 'updatedAt'>;
function wire(d: Draft): AttentionItem {
    return {
        sessionId: SESSION_ID, teamId: null, projectId: null, key: null, bodyMd: null, options: null, links: null, anchor: null,
        firstReply: null, replyToId: null, inferred: false, ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null,
        repostCount: 0, resolvedAt: null, pushedAt: null, version: 1, ...d,
    };
}

function items(): AttentionItem[] {
    const m1 = agentId(T.m1), m2 = agentId(T.m2);
        return ([
        { id: 'd1', source: 'lead', kind: 'decision', key: 'login-release', needsOwner: true, state: 'open', repostCount: 3,
            title: L('登录页改版今天发布还是明早发布？', 'Ship the login redesign tonight or tomorrow morning?'), bodyMd: L('测试 40/40 已通过，PR 可以合并。发布窗口有两个选择：', 'Tests 40/40 passed and the PR can merge. Two release windows:'),
            options: [{ id: 'A', label: L('今晚 20:00 发布', 'Tonight 20:00'), detail: L('今天就上线；晚间值守需要有人在', 'Live today; someone has to be on call tonight') }, { id: 'B', label: L('明早 10:00 发布', 'Tomorrow 10:00'), detail: L('有完整值守，晚一天', 'Full on-call cover, one day later'), recommended: true }],
            links: [{ type: 'pr', ref: '431', label: 'PR #431' }, { type: 'task', ref: '12', label: L('任务 #12', 'Task #12') }],
            anchor: { messageId: m1, snippet: T.m1 }, createdAt: at(34), updatedAt: at(34) },
        { id: 't1', source: 'lead', kind: 'todo', needsOwner: true, state: 'open',
            title: L('在手机上看一眼新登录页（预发环境）', 'Check the new login page on your phone (staging)'), bodyMd: L('自动化截图只覆盖了模拟器，真机还没人看过。看完回一句「可以」或指出问题。', 'Automated captures only covered the simulator; nobody has looked on a real phone. Reply OK or point out what is wrong.'),
            links: [{ type: 'url', ref: 'https://staging.example.com/login', label: L('预发链接', 'Staging link') }],
            anchor: { messageId: m2, snippet: T.m2 }, createdAt: at(43), updatedAt: at(43) },
        { id: 'q3', source: 'owner', kind: 'question', needsOwner: false, state: 'in_progress', title: T.q3,
            anchor: { localId: 'owner-q3' }, firstReply: { messageId: agentId(T.r3), snippet: T.r3 }, createdAt: at(39), updatedAt: at(39.5) },
        { id: 'q4', source: 'owner', kind: 'request', needsOwner: false, state: 'in_progress', title: L('注册页也按同样的样式改，跟登录页一起发', 'Restyle the sign-up page the same way, ship with the login page'),
            links: [{ type: 'task', ref: '16', label: L('任务 #16', 'Task #16') }],
            anchor: { localId: 'owner-q4' }, firstReply: { messageId: agentId(T.r4), snippet: L('派给成员 A 做任务 #16，完成后在汇报板上告诉你。', 'Task #16 goes to member A; I will tell you on the board when done.') }, createdAt: at(11), updatedAt: at(11.5) },
        { id: 'q1', source: 'owner', kind: 'question', needsOwner: false, state: 'answered', title: T.q1,
            anchor: { localId: 'owner-q1' }, firstReply: { messageId: agentId(T.r1), snippet: L('前端 PR 已提交，测试在跑，结论出来放到汇报板。', 'Frontend PR is up, tests running; the answer goes on the board.') }, createdAt: at(0), updatedAt: at(34), resolvedAt: at(34) },
        { id: 'q2', source: 'owner', kind: 'question', needsOwner: false, state: 'answered', title: T.q2,
            anchor: { localId: 'owner-q2' }, firstReply: { messageId: agentId(T.r2), snippet: L('成员 A 在改，已写进任务 #12 的退回意见里。', 'Member A is fixing it; it is in the revision notes on task #12.') }, resolvedBy: 'auto-first-reply', createdAt: at(12), updatedAt: at(12.5), resolvedAt: at(12.5) },
        { id: 'a1', source: 'lead', kind: 'answer', needsOwner: false, state: 'open', replyToId: 'q1',
            title: L('可以今天合：测试 40/40 通过，PR #431 已就绪', 'It can merge today: tests 40/40, PR #431 ready'), bodyMd: L('任务 #12 退回一次（暗色对比度），修改后复测全绿。合并后是否今天发布见上方「决定」。', 'Task #12 went back once (dark-mode contrast); the retest is all green. Whether to ship today is the decision above.'),
            links: [{ type: 'pr', ref: '431', label: 'PR #431' }], anchor: { messageId: m1, snippet: T.m1 }, createdAt: at(33.9), updatedAt: at(34) },
        { id: 'r1', source: 'lead', kind: 'report', needsOwner: false, state: 'resolved', title: L('任务 #14 已验收：登录接口限流参数调整', 'Task #14 accepted: login API rate-limit tuning'),
            bodyMd: L('预发环境观察 10 分钟无异常。', '10 minutes on staging, no anomalies.'), links: [{ type: 'task', ref: '14', label: L('任务 #14', 'Task #14') }], createdAt: at(21), updatedAt: at(22), resolvedAt: at(22) },
        { id: 'd0', source: 'lead', kind: 'decision', needsOwner: true, state: 'dismissed', title: L('限流阈值先放宽到 200 还是保持 100？', 'Raise the rate limit to 200 or keep 100?'),
            options: [{ id: 'A', label: L('放宽到 200', 'Raise to 200') }, { id: 'B', label: L('保持 100', 'Keep 100') }], resolvedBy: 'lead', resolveNote: L('压测结果出来了，保持 100 就够，撤回这条。', 'Load test is in: 100 is enough, withdrawing this.'),
            createdAt: at(15), updatedAt: at(20), resolvedAt: at(20) },
        { id: 'd2', source: 'lead', kind: 'decision', needsOwner: true, state: 'open', inferred: true, title: L('要不要把旧登录页的入口一起下线？', 'Retire the old login page entry at the same time?'),
            options: [{ id: 'A', label: L('一起下线', 'Retire it too') }, { id: 'B', label: L('保留一周', 'Keep it a week') }], key: 'auto:legacy-login', createdAt: at(44), updatedAt: at(44) },
    ] as Draft[]).map(wire);
}

/** In-page `/v1/attention-items` (W0 shapes): list, and owner-respond that settles the item like S-1 does. */
function installAttentionApi(data: Map<string, AttentionItem>, off: boolean): () => void {
    const real = window.fetch;
    window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const parsed = new URL(url, location.href);
        const path = parsed.pathname;
        if (!path.startsWith('/v1/attention-items')) return real(input, init);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (off) return json(404, { error: 'owner_board_disabled' });
        const m = path.match(/^\/v1\/attention-items\/([^/]+)\/owner-respond$/);
        // B-798: only the asked session's items (the device shell also hosts an ordinary session).
        const sid = parsed.searchParams.get('sessionId');
        if (!m) return json(200, { items: [...data.values()].filter((i) => !sid || i.sessionId === sid) });
        const item = data.get(decodeURIComponent(m[1]));
        if (!item) return json(404, { error: 'not_found' });
        const body = JSON.parse(String(init?.body ?? '{}')) as { action: string; choice?: string };
        ((window as unknown as { __boardCalls?: unknown[] }).__boardCalls ??= []).push({ id: item.id, ...body });
        const now = Date.now();
        const next: AttentionItem = body.action === 'reopen'
            ? { ...item, state: 'open', resolvedBy: null, resolvedAt: null, updatedAt: now, version: item.version + 1 }
            : { ...item, state: item.kind === 'question' || item.kind === 'request' ? 'answered' : 'resolved', ownerChoice: body.choice ?? item.ownerChoice,
                resolvedBy: 'owner', resolvedAt: now, updatedAt: now, version: item.version + 1 };
        data.set(next.id, next);
        return json(200, { item: next });
    };
    return () => { window.fetch = real; };
}

/** This session is the team lead (B-1's 「只看我和负责人」 toggle; on phones it sits in the board strip). */
export function boardTeam(now = Date.now()): TeamState {
    const team = buildLeadFixture({ now }).team;
    const ship = { id: SHIP_MESSAGE_ID, taskId: SHIP_TASK, senderBotId: 'bot-a', source: 'agent' as const, recipientBotId: 'bot-lead', body: T.submit, deliveredAt: at(45), createdAt: at(45) };
    return { ...team, name: L(team.name, 'Redesign squad (example)'), bots: team.bots.map((b) => (b.root ? { ...b, sessionId: SESSION_ID } : b)), messages: [...team.messages, ship] };
}

/** Seeds the board session, its transcript and the in-page board API. Returns the
 *  lead's team (the caller installs the team override) and a cleanup. */
export function seedBoardSession(): { team: TeamState; cleanup: () => void } {
    const now = Date.now();
    storage.getState().applySessions([{
        id: SESSION_ID, seq: 1, createdAt: BASE, updatedAt: now, active: true, activeAt: now,
        metadata: { machineId: 'dev-machine', path: '/repo', host: 'dev-box', flavor: 'claude', summary: { text: L('网站改版 · 负责人', 'Website redesign · lead'), updatedAt: now },
            capabilities: ['claude-steer-v1', 'claude-live-permission-v1', ATTENTION_SESSION_CAPABILITY] },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {} },
        agentStateVersion: 1,
        thinking: false, presence: 'online', modelMode: 'sonnet',
    } as unknown as Session]);
    storage.getState().applyMessages(SESSION_ID, messages());
    storage.getState().applyMessagesLoaded(SESSION_ID);
    const data = new Map(items().map((i) => [i.id, i]));
    const restoreFetch = installAttentionApi(data, new URLSearchParams(location.search).has('off'));
    // A local stand-in so the REST client sends (only `/v1/attention-items` is answered).
    setCurrentAuth({ isAuthenticated: true, credentials: { token: 'dev-board', secret: '' }, login: async () => false, logout: async () => {} } as never);
    useAttentionStore.setState({ disabled: false });
    markItemSeen('r1');
    // No sync keys here: record the board's chat message instead of sending it.
    const realSend = sync.sendMessage;
    sync.sendMessage = (async (sid: string, text: string, opts?: { localId?: string }) => {
        ((window as unknown as { __boardSends?: unknown[] }).__boardSends ??= []).push({ sid, text, localId: opts?.localId });
        return opts?.localId;
    }) as typeof sync.sendMessage;
    return {
        team: boardTeam(now),
        cleanup: () => { sync.sendMessage = realSend; restoreFetch(); useAttentionStore.getState().clear(SESSION_ID); },
    };
}

export function BoardHarness() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const { team, cleanup } = seedBoardSession();
        setTeamNavigationDevOverride([team]);
        setReady(true);
        return () => { setTeamNavigationDevOverride(null); cleanup(); };
    }, []);
    return ready ? <SessionDetailScreen /> : null;
}
