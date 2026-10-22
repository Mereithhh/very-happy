import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';
import { pointedMessageIds, sessionHasBoard, boardCounts, boardGroup, buildBoard, followUpQuote, isUnread, itemStatus, pointersAt, repliesTo, resolveAction, RECENT_ANSWERED } from './boardModel';

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

describe('pointersAt / repliesTo / followUpQuote', () => {
    it('pointers are agent-side items anchored at that message, oldest first; Owner items never point', () => {
        const late = item({ kind: 'decision', needsOwner: true, anchor: { messageId: 'm1' }, createdAt: 20 });
        const early = item({ kind: 'answer', anchor: { messageId: 'm1' }, createdAt: 10 });
        const owner = item({ kind: 'pin', source: 'owner', anchor: { messageId: 'm1' } });
        const other = item({ kind: 'report', anchor: { messageId: 'm2' } });
        expect(pointersAt([late, early, owner, other], 'm1').map((i) => i.id)).toEqual([early.id, late.id]);
        expect(pointersAt([late], 'nope')).toEqual([]);
    });

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

describe('pointedMessageIds', () => {
    it('agent-side anchors only — those rows stay unfolded in 「只看我和负责人」', () => {
        const ids = pointedMessageIds([
            item({ kind: 'decision', needsOwner: true, anchor: { messageId: 'm1' } }),
            item({ kind: 'question', source: 'owner', anchor: { localId: 'l1', messageId: 'm2' } }),
            item({ kind: 'report', anchor: { localId: 'l3' } }),
        ]);
        expect([...ids]).toEqual(['m1']);
    });
});
