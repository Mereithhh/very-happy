import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import { blockedBanner, choiceLabel, displayTitle, optionMarker, recommendationTag, sessionHasBoard, boardCounts, boardGroup, buildBoard, followUpQuote, isUnread, itemStatus, repliesTo, resolveAction, RECENT_ANSWERED } from './boardModel';

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

describe('boardGroup', () => {
    it('needsOwner wins, Owner items are 「你提的」, the rest are reports', () => {
        expect(boardGroup(item({ kind: 'decision', needsOwner: true }))).toBe('need');
        expect(boardGroup(item({ kind: 'blocked', needsOwner: true, source: 'agent' }))).toBe('need');
        expect(boardGroup(item({ kind: 'question', source: 'owner' }))).toBe('asked');
        expect(boardGroup(item({ kind: 'request', source: 'owner' }))).toBe('asked');
        expect(boardGroup(item({ kind: 'answer' }))).toBe('report');
        expect(boardGroup(item({ kind: 'pin', source: 'owner' }))).toBe('report');
    });
});

describe('buildBoard', () => {
    it('「进行中」: waiting oldest first, asked newest first plus the newest two answered (D2), live reports', () => {
        const d1 = item({ kind: 'decision', needsOwner: true, createdAt: 5000 });
        const d2 = item({ kind: 'todo', needsOwner: true, createdAt: 1000 });
        const qOpen = item({ kind: 'question', source: 'owner', updatedAt: 9000 });
        const qWip = item({ kind: 'request', source: 'owner', state: 'in_progress', updatedAt: 9500 });
        const answered = [1, 2, 3].map((k) => item({ kind: 'question', source: 'owner', state: 'answered', updatedAt: k * 100, resolvedAt: k * 100 }));
        const dropped = item({ kind: 'question', source: 'owner', state: 'dismissed', resolvedAt: 99999 });
        const rep = item({ kind: 'report' });
        const readRep = item({ kind: 'report', state: 'resolved' });
        const [need, asked, report] = buildBoard([d1, d2, qOpen, qWip, ...answered, dropped, rep, readRep], 'open');
        expect(need.items.map((i) => i.id)).toEqual([d2.id, d1.id]);
        expect(need.liveCount).toBe(2);
        expect(asked.items.map((i) => i.id)).toEqual([qWip.id, qOpen.id, answered[2].id, answered[1].id]);
        expect(asked.items).toHaveLength(2 + RECENT_ANSWERED);
        expect(asked.liveCount).toBe(2);
        expect(report.items.map((i) => i.id)).toEqual([rep.id]);
    });

    it('「已处理」: everything no longer live, most recently handled first, nothing live', () => {
        const a = item({ kind: 'decision', needsOwner: true, state: 'resolved', ownerChoice: 'B', resolvedAt: 10 });
        const b = item({ kind: 'decision', needsOwner: true, state: 'resolved', resolvedAt: 20 });
        const live = item({ kind: 'decision', needsOwner: true });
        const q = item({ kind: 'question', source: 'owner', state: 'dismissed', resolvedAt: 5 });
        const [need, asked] = buildBoard([a, b, live, q], 'done');
        expect(need.items.map((i) => i.id)).toEqual([b.id, a.id]);
        expect(asked.items.map((i) => i.id)).toEqual([q.id]);
        expect(need.liveCount).toBe(1);
    });
});

describe('boardCounts / isUnread', () => {
    it('counts only live items; 新汇报 excludes seen ones; 你提的 never shows a dot', () => {
        const need = item({ kind: 'decision', needsOwner: true });
        const doneNeed = item({ kind: 'todo', needsOwner: true, state: 'resolved' });
        const asked = item({ kind: 'question', source: 'owner', state: 'in_progress' });
        const answered = item({ kind: 'question', source: 'owner', state: 'answered' });
        const r1 = item({ kind: 'report' });
        const r2 = item({ kind: 'answer' });
        const seen = new Set([r2.id]);
        expect(boardCounts([need, doneNeed, asked, answered, r1, r2], seen)).toEqual({ need: 1, asked: 1, fresh: 1 });
        expect(isUnread(need, seen)).toBe(true);
        expect(isUnread(r2, seen)).toBe(false);
        expect(isUnread(asked, seen)).toBe(false);
        expect(isUnread(doneNeed, seen)).toBe(false);
    });
});

describe('itemStatus / resolveAction', () => {
    it('maps each kind to the prototype chip and the one resolve action', () => {
        expect(itemStatus(item({ kind: 'question', source: 'owner' }))).toEqual({ tone: 'open', key: 'unanswered' });
        expect(itemStatus(item({ kind: 'question', source: 'owner', firstReply: { messageId: 'm9' } }))?.key).toBe('inProgress');
        expect(itemStatus(item({ kind: 'question', source: 'owner', state: 'answered' }))?.key).toBe('answered');
        expect(itemStatus(item({ kind: 'request', source: 'owner', state: 'in_progress' }))?.key).toBe('working');
        expect(itemStatus(item({ kind: 'decision', needsOwner: true, state: 'resolved', ownerChoice: 'B' }))).toEqual({ tone: 'done', key: 'decided', choice: 'B' });
        expect(itemStatus(item({ kind: 'report' }))).toBeNull();
        expect(itemStatus(item({ kind: 'report', state: 'dismissed' }))?.key).toBe('dismissed');
        expect(resolveAction(item({ kind: 'decision', needsOwner: true }))).toBeNull();
        expect(resolveAction(item({ kind: 'todo', needsOwner: true }))).toBe('done');
        expect(resolveAction(item({ kind: 'answer' }))).toBe('ack');
        expect(resolveAction(item({ kind: 'question', source: 'owner' }))).toBe('answered');
        expect(resolveAction(item({ kind: 'request', source: 'owner' }))).toBe('drop');
        expect(resolveAction(item({ kind: 'todo', needsOwner: true, state: 'resolved' }))).toBeNull();
    });
});

describe('repliesTo / followUpQuote', () => {
    it('replies are linked by replyToId; follow-up quotes the title', () => {
        const q = item({ kind: 'question', source: 'owner', title: '谁来写？' });
        const a = item({ kind: 'answer', replyToId: q.id });
        expect(repliesTo([q, a], q.id)).toEqual([a]);
        expect(followUpQuote(q, '［汇报板］')).toBe('［汇报板］谁来写？');
    });
});

describe('sessionHasBoard / W0 fields', () => {
    it('needs a loaded list, then items or the owner-board-v1 capability', () => {
        expect(sessionHasBoard(undefined, ['owner-board-v1'])).toBe(false);
        expect(sessionHasBoard([], undefined)).toBe(false);
        expect(sessionHasBoard([], ['owner-board-v1'])).toBe(true);
        expect(sessionHasBoard([item({})], [])).toBe(true);
    });

    it('an inferred (自动识别) decision still counts toward 「等你」', () => {
        expect(boardCounts([item({ kind: 'decision', needsOwner: true, inferred: true })]).need).toBe(1);
    });

    it('an unknown kind from a newer server lands in reports, an unknown state is not live', () => {
        expect(boardGroup(item({ kind: 'future-kind' }))).toBe('report');
        expect(buildBoard([item({ kind: 'report', state: 'future-state' })], 'open')[2].items).toEqual([]);
    });
});

describe('blockedBanner (W-2: request_human strip reads items)', () => {
    it('newest open blocked item; panel link → machine panel deep link; closed ones never show', () => {
        const old = item({ kind: 'blocked', needsOwner: true, source: 'agent', title: '扫码登录', updatedAt: 10 });
        const fresh = item({ kind: 'blocked', needsOwner: true, source: 'agent', title: '输入验证码', updatedAt: 20, links: [{ type: 'panel', ref: 'vnc main' }] });
        const done = item({ kind: 'blocked', needsOwner: true, source: 'agent', title: '旧的', updatedAt: 30, state: 'resolved' });
        const decision = item({ kind: 'decision', needsOwner: true, updatedAt: 40 });
        expect(blockedBanner([old, fresh, done, decision], 's 1')).toEqual({ id: fresh.id, reason: '输入验证码', url: '/session/s%201?panel=machine&wp=vnc%20main' });
        expect(blockedBanner([old], 's')?.url).toBeNull();
        expect(blockedBanner([done, decision], 's')).toBeNull();
    });
});

describe('card text (QA5 O1)', () => {
    // The server's team-submit title: `根目标已提交，等你验收 · ${goal}`.slice(0, 120) — cut inside 「short」.
    const cut = `根目标已提交，等你验收 · [QA] Briefing board QA probe. No code work unless the owner asks. Run team_inspect once, reply in one short line.`.slice(0, 120).trim();

    it('a server-clipped title backs off to the last word and says it was cut; short / CJK titles stay', () => {
        expect(cut.endsWith('shor')).toBe(true);
        expect(displayTitle(cut)).toBe('根目标已提交，等你验收 · [QA] Briefing board QA probe. No code work unless the owner asks. Run team_inspect once, reply in one…');
        expect(displayTitle('发版窗口选哪个？')).toBe('发版窗口选哪个？');
        const cjk = '这是一条很长的中文标题'.repeat(12).slice(0, 120);
        expect(displayTitle(cjk)).toBe(`${cjk}…`);
    });

    it('internal option ids stay hidden; one-character markers show; the chosen label reads the same', () => {
        expect(optionMarker({ id: 'accept' })).toBeNull();
        expect(optionMarker({ id: 'return' })).toBeNull();
        expect(optionMarker({ id: 'B' })).toBe('B');
        const submit = item({ kind: 'decision', source: 'team', options: [{ id: 'accept', label: '验收 / Accept', recommended: true }, { id: 'return', label: '退回 / Return' }] });
        expect(choiceLabel(submit, 'accept')).toBe('验收 / Accept');
        expect(choiceLabel(item({ options: [{ id: 'B', label: '明早' }] }), 'B')).toBe('B. 明早');
        expect(choiceLabel(submit, 'gone')).toBe('gone');
    });

    it('a tag only for a recommended option: 「负责人推荐」 from the lead, plain 「推荐」 from anyone else', () => {
        expect(recommendationTag({ source: 'lead' }, { recommended: true })).toBe('lead');
        expect(recommendationTag({ source: 'team' }, { recommended: true })).toBe('plain');
        expect(recommendationTag({ source: 'automation' }, { recommended: true })).toBe('plain');
        expect(recommendationTag({ source: 'lead' }, {})).toBeNull();
        expect(recommendationTag({ source: 'team' }, { recommended: false })).toBeNull();
    });
});
