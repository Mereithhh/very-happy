/** DEV-only (B-766 W-1): the REAL SessionDetailScreen of a lead session with a
 *  seeded 汇报板 — header button, aside tab, phone strip / top sheet and the
 *  in-stream pointers. Route `/dev/board/session/:id` (stripped from prod
 *  builds). Everything is a neutral local example; nothing is sent. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { SessionDetailScreen } from '@/screens/session/SessionDetailScreen';
import { useBoardStore } from '@/screens/session/board/boardStore';
import type { AttentionItem } from '@/screens/session/board/attentionTypes';
import '@/screens/session/session.css';

const SESSION_ID = 'dev-board';
const BASE = Date.now() - 50 * 60_000;
const at = (min: number) => BASE + min * 60_000;
let seq = 0;

function user(text: string, min: number, localId: string): NormalizedMessage {
    seq++;
    return { role: 'user', id: `b-${seq}`, localId, createdAt: at(min), isSidechain: false, seq, content: { type: 'text', text } } as unknown as NormalizedMessage;
}
function agent(text: string, min: number): NormalizedMessage {
    seq++;
    return { role: 'agent', id: `b-${seq}`, localId: null, createdAt: at(min), isSidechain: false, seq,
        content: [{ type: 'text', text, uuid: `u-${seq}`, parentUUID: null }] } as unknown as NormalizedMessage;
}

const T = {
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
};

function messages(): NormalizedMessage[] {
    seq = 0;
    return [
        user(T.q1, 0, 'owner-q1'), agent(T.r1, 1),
        user(T.q4, 11, 'owner-q4'), agent(T.r4, 11.5),
        user(T.q2, 12, 'owner-q2'), agent(T.r2, 12.5),
        agent(T.m1, 34),
        user(T.q3, 39, 'owner-q3'), agent(T.r3, 39.5),
        agent(T.m2, 43),
    ];
}

/** Transcript id of the agent message with this text (the reducer assigns ids). */
function agentId(text: string): string | undefined {
    const list = storage.getState().sessionMessages[SESSION_ID]?.messages ?? [];
    return list.find((m) => m.kind === 'agent-text' && m.text === text)?.id;
}

function items(): AttentionItem[] {
    const m1 = agentId(T.m1), m2 = agentId(T.m2);
    const base = { sessionId: SESSION_ID, repostCount: 0 };
    return [
        { ...base, id: 'd1', source: 'lead', kind: 'decision', key: 'login-release', needsOwner: true, state: 'open', repostCount: 3,
            title: '登录页改版今天发布还是明早发布？', bodyMd: '测试 40/40 已通过，PR 可以合并。发布窗口有两个选择：',
            options: [{ id: 'A', label: '今晚 20:00 发布', detail: '今天就上线；晚间值守需要有人在' }, { id: 'B', label: '明早 10:00 发布', detail: '有完整值守，晚一天', recommended: true }],
            links: [{ type: 'pr', ref: '431', label: 'PR #431' }, { type: 'task', ref: '12', label: '任务 #12' }],
            anchor: { messageId: m1, snippet: T.m1 }, createdAt: at(34), updatedAt: at(34) },
        { ...base, id: 't1', source: 'lead', kind: 'todo', needsOwner: true, state: 'open',
            title: '在手机上看一眼新登录页（预发环境）', bodyMd: '自动化截图只覆盖了模拟器，真机还没人看过。看完回一句「可以」或指出问题。',
            links: [{ type: 'url', ref: 'https://staging.example.com/login', label: '预发链接' }],
            anchor: { messageId: m2, snippet: T.m2 }, createdAt: at(43), updatedAt: at(43) },
        { ...base, id: 'q3', source: 'owner', kind: 'question', needsOwner: false, state: 'in_progress', title: T.q3,
            anchor: { localId: 'owner-q3' }, firstReply: { anchor: { messageId: agentId(T.r3) }, text: T.r3, at: at(39.5) }, createdAt: at(39), updatedAt: at(39.5) },
        { ...base, id: 'q4', source: 'owner', kind: 'request', needsOwner: false, state: 'in_progress', title: '注册页也按同样的样式改，跟登录页一起发',
            links: [{ type: 'task', ref: '16', label: '任务 #16' }],
            anchor: { localId: 'owner-q4' }, firstReply: { anchor: { messageId: agentId(T.r4) }, text: '派给成员 A 做任务 #16，完成后在汇报板上告诉你。', at: at(11.5) }, createdAt: at(11), updatedAt: at(11.5) },
        { ...base, id: 'q1', source: 'owner', kind: 'question', needsOwner: false, state: 'answered', title: T.q1,
            anchor: { localId: 'owner-q1' }, firstReply: { anchor: { messageId: agentId(T.r1) }, text: '前端 PR 已提交，测试在跑，结论出来放到汇报板。', at: at(1) }, createdAt: at(0), updatedAt: at(34), resolvedAt: at(34) },
        { ...base, id: 'q2', source: 'owner', kind: 'question', needsOwner: false, state: 'answered', title: T.q2,
            anchor: { localId: 'owner-q2' }, firstReply: { anchor: { messageId: agentId(T.r2) }, text: '成员 A 在改，已写进任务 #12 的退回意见里。', at: at(12.5), auto: true }, createdAt: at(12), updatedAt: at(12.5), resolvedAt: at(12.5) },
        { ...base, id: 'a1', source: 'lead', kind: 'answer', needsOwner: false, state: 'open', replyToId: 'q1',
            title: '可以今天合：测试 40/40 通过，PR #431 已就绪', bodyMd: '任务 #12 退回一次（暗色对比度），修改后复测全绿。合并后是否今天发布见上方「决定」。',
            links: [{ type: 'pr', ref: '431', label: 'PR #431' }], anchor: { messageId: m1, snippet: T.m1 }, createdAt: at(33.9), updatedAt: at(34) },
        { ...base, id: 'r1', source: 'lead', kind: 'report', needsOwner: false, state: 'resolved', title: '任务 #14 已验收：登录接口限流参数调整',
            bodyMd: '预发环境观察 10 分钟无异常。', links: [{ type: 'task', ref: '14', label: '任务 #14' }], createdAt: at(21), updatedAt: at(22), resolvedAt: at(22) },
    ];
}

export function BoardHarness() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const now = Date.now();
        storage.getState().applySessions([{
            id: SESSION_ID, seq: 1, createdAt: BASE, updatedAt: now, active: true, activeAt: now,
            metadata: { machineId: 'dev-machine', path: '/repo', host: 'dev-box', flavor: 'claude', summary: { text: '网站改版 · 负责人', updatedAt: now },
                capabilities: ['claude-steer-v1', 'claude-live-permission-v1'] },
            metadataVersion: 1,
            agentState: { controlledByUser: false, requests: {} },
            agentStateVersion: 1,
            thinking: false, presence: 'online', modelMode: 'sonnet',
        } as unknown as Session]);
        storage.getState().applyMessages(SESSION_ID, messages());
        storage.getState().applyMessagesLoaded(SESSION_ID);
        const board = useBoardStore.getState();
        board.setItems(SESSION_ID, items());
        board.markSeen('r1');
        setReady(true);
        return () => useBoardStore.getState().clear(SESSION_ID);
    }, []);
    return ready ? <SessionDetailScreen /> : null;
}
