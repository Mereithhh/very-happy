// @vitest-environment happy-dom
/**
 * B-766 W-fix (QA5 F1): a real lead's board items carry only the CLI's
 * `this_turn` anchor — `{ localId, snippet? }` (leadBoard.ts `thisTurnAnchor`:
 * the turn's prompt localId, and the latest reply text when the tool ran,
 * whitespace-collapsed and clipped to 200 chars with `…`). No `messageId`.
 * Pointer, 「只看我和负责人」 keep and 「在消息流中定位」 all resolve through
 * `resolveBoardAnchor`, so they land on the same message.
 */
import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows } from '../chatTurns';
import { leadViewEntries, turnOpenerIds, turnOrigin } from '../leadView';
import { findJumpMessage } from '@/screens/search/chatJump';
import { locateJumpTarget } from '@/screens/search/useChatJump';
import { boardAnchors, resolveBoardAnchor, rowMessageIds } from './boardAnchor';

/** leadBoard.ts `clip`, as the CLI applies it to `snippet`. */
const clip = (text: string, max = 200) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const TASK = '11111111-2222-4333-8444-555555555555';
const LONG = `发版窗口有两个选择：\n\n- **A. 今晚**：风险是回滚窗口短；\n- **B. 明早**：多一轮回归。\n\n${'细节说明。'.repeat(60)}`;

let seq = 0;
const user = (id: string, localId: string, text: string, sentFrom = 'web') =>
    ({ kind: 'user-text', id, localId, createdAt: ++seq * 1000, seq, text, meta: { sentFrom } }) as Message;
const agent = (id: string, text: string, isThinking = false) =>
    ({ kind: 'agent-text', id, localId: null, createdAt: ++seq * 1000, seq, text, ...(isThinking ? { isThinking } : {}) }) as Message;
const tool = (id: string, name: string) =>
    ({ kind: 'tool-call', id, localId: null, createdAt: ++seq * 1000, seq, children: [],
        tool: { name, state: 'completed', input: {}, createdAt: seq * 1000, startedAt: seq * 1000, completedAt: seq * 1000 + 500, description: null, result: 'ok' } }) as unknown as Message;
const teamPrompt = (id: string, tm: string, body: string) =>
    user(id, `teams-message-${tm}-1`, `[Very Happy team message ${tm}; task ${TASK}; from 成员 A]\n${body}\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`, 'team');

// Owner turn: text → owner_board_post (snippet = that text) → closing line.
// Member turn: the member's submit wakes the lead; the report tool ran before any text (no snippet).
const transcript: Message[] = [
    user('u1', 'web-owner-1', '发版窗口选哪个？给我个决定。'),
    agent('a1-think', '先想想', true),
    agent('a1', LONG),
    tool('t1', 'mcp__happy__owner_board_post'),
    agent('a1-end', '已放到汇报板，等你选。'),
    teamPrompt('u2', 'tm-7', '提交：PR 已开，CI 全绿，附截图。'),
    tool('t2', 'mcp__happy__team_inspect'),
    tool('t3', 'mcp__happy__owner_board_post'),
    agent('a2', '成员 A 的 PR 已验收，汇报已上板。'),
    teamPrompt('u3', 'tm-8', '进度：发布说明草稿写好了。'),
    agent('a3-mid', '收到，我先看一下草稿。'),
    tool('t4', 'mcp__happy__owner_board_post'),
    agent('a3', '草稿没问题，继续。'),
    user('u4', 'web-owner-2', '/compact'),
];

let n = 0;
function item(over: Partial<AttentionItem>): AttentionItem {
    n++;
    return {
        id: `i${n}`, sessionId: 's', teamId: null, projectId: null, source: 'lead', kind: 'report', key: null, title: `item ${n}`, bodyMd: null,
        options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: false, state: 'open',
        ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0,
        createdAt: n * 1000, updatedAt: n * 1000, resolvedAt: null, pushedAt: null, version: 1, ...over,
    };
}

// Exactly what the CLI writes (no messageId anywhere).
const decision = item({ kind: 'decision', needsOwner: true, anchor: { localId: 'web-owner-1', snippet: clip(LONG) } });
const memberReport = item({ kind: 'report', anchor: { localId: 'teams-message-tm-7-1' } });
const midReport = item({ kind: 'report', anchor: { localId: 'teams-message-tm-8-1', snippet: clip('收到，我先看一下草稿。') } });
const ownerQuestion = item({ kind: 'question', source: 'owner', anchor: { localId: 'web-owner-1' } });

describe('resolveBoardAnchor — the CLI this_turn shape', () => {
    it('Owner turn: the snippet (clipped, whitespace-collapsed) picks the reply it was taken from', () => {
        expect(clip(LONG).endsWith('…')).toBe(true);
        expect(resolveBoardAnchor(transcript, decision.anchor)).toBe('a1');
    });

    it('member turn without a snippet lands on the turn’s last agent text, not the team prompt', () => {
        expect(resolveBoardAnchor(transcript, memberReport.anchor)).toBe('a2');
    });

    it('member turn with a mid-turn snippet picks that reply', () => {
        expect(resolveBoardAnchor(transcript, midReport.anchor)).toBe('a3-mid');
    });

    it('a snippet matching nothing falls back to the last agent text; no agent text → the prompt', () => {
        expect(resolveBoardAnchor(transcript, { localId: 'web-owner-1', snippet: 'something else' })).toBe('a1-end');
        expect(resolveBoardAnchor(transcript, { localId: 'web-owner-2', snippet: 'x' })).toBe('u4');
    });

    it('a loaded messageId still wins; an unloaded anchor resolves to nothing', () => {
        expect(resolveBoardAnchor(transcript, { localId: 'web-owner-1', messageId: 'a2' })).toBe('a2');
        expect(resolveBoardAnchor(transcript, { localId: 'web-owner-1', messageId: 'gone', snippet: clip(LONG) })).toBe('a1');
        expect(resolveBoardAnchor(transcript, { localId: 'older-page' })).toBeNull();
        expect(resolveBoardAnchor(transcript, null)).toBeNull();
    });
});

describe('rowMessageIds', () => {
    it('a turn opened by a background-task notification with no reply puts the pointer under its activity row', () => {
        const notified: Message[] = [
            user('n0', 'web-owner-9', 'go'),
            agent('n0a', 'started'),
            user('n1', 'cli-notify-1', '<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>', 'cli'),
            tool('n1t', 'mcp__happy__owner_board_post'),
        ];
        expect(resolveBoardAnchor(notified, { localId: 'cli-notify-1' })).toBe('n1');
        const holder = buildChatRows(notified, false).find((row) => rowMessageIds(row).includes('n1'));
        expect(holder?.type).toBe('activity');
    });
});

describe('pointer, keep and locate agree', () => {
    const items = [decision, memberReport, midReport, ownerQuestion];
    const anchors = boardAnchors(transcript, items);

    it('pointers: agent-side items only, each under its resolved message', () => {
        expect([...anchors.entries()].map(([id, list]) => [id, list.map((i) => i.id)])).toEqual([
            ['a1', [decision.id]], ['a2', [memberReport.id]], ['a3-mid', [midReport.id]],
        ]);
    });

    it('every pointer has a row to sit under — a folded mid-turn reply puts it under its activity row', () => {
        const rows = buildChatRows(transcript, false);
        const placed = new Set(rows.flatMap((row) => rowMessageIds(row).filter((id) => anchors.has(id))));
        expect([...placed].sort()).toEqual(['a1', 'a2', 'a3-mid']);
        const holder = rows.find((row) => rowMessageIds(row).includes('a3-mid'));
        expect(holder?.type).toBe('activity');
    });

    it('「只看我和负责人」 keeps the pointed rows of member turns out of the fold', () => {
        const rows = buildChatRows(transcript, false);
        const entries = leadViewEntries(rows, turnOpenerIds(transcript), (m) => turnOrigin(m, undefined), (row) => rowMessageIds(row).some((id) => anchors.has(id)));
        const visible = entries.flatMap((e) => (e.type === 'row' ? rowMessageIds(e.row) : []));
        expect(visible).toContain('a2');
        expect(visible).toContain('a3-mid');
        // The rest of the member turns still folds.
        expect(entries.some((e) => e.type === 'fold')).toBe(true);
        expect(visible).not.toContain('u2');
    });

    it('「在消息流中定位」 resolves to the same message and lands on the reply or its pointer', () => {
        for (const it of [decision, memberReport, midReport]) {
            expect(findJumpMessage(transcript, { terms: [], anchor: it.anchor!, flash: true })).toBe(resolveBoardAnchor(transcript, it.anchor));
        }
        const root = document.createElement('div');
        root.innerHTML = `
            <div class="msg msg--agent" data-message-id="a2"><p>成员 A 的 PR 已验收</p></div>
            <div class="activity">collapsed</div>
            <div class="brf-ptrs" data-board-for="a3-mid"><button class="brf-ptr">已上板</button></div>`;
        expect(locateJumpTarget(root, transcript, 'a2', { terms: [], anchor: memberReport.anchor! })?.el.getAttribute('data-message-id')).toBe('a2');
        expect(locateJumpTarget(root, transcript, 'a3-mid', { terms: [], anchor: midReport.anchor! })?.el.className).toBe('brf-ptrs');
    });
});
