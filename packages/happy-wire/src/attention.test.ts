import { describe, expect, it } from 'vitest';
import {
    ATTENTION_KINDS,
    AttentionItemListQuerySchema,
    AttentionItemOwnerRespondSchema,
    AttentionItemPatchSchema,
    AttentionItemPostSchema,
    AttentionItemSchema,
    OwnerBoardListInputSchema,
    OwnerBoardPostInputSchema,
    OwnerBoardResolveInputSchema,
    OwnerBoardUpdateInputSchema,
    UpdateAttentionItemBodySchema,
    attentionBoardLocalId,
    attentionKindNeedsOwner,
    isAttentionBoardLocalId,
    attentionPushKind,
    attentionResolveState,
    isAttentionActive,
    ownerBoardPostToRest,
} from './attention';

const twoOptions = [{ id: 'A', label: 'Ship now', recommended: true }, { id: 'B', label: 'Wait a day' }];

const item = {
    id: 'i1', sessionId: 's1', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: 'release-window',
    title: 'Pick the release window', bodyMd: null, options: twoOptions, links: null, anchor: { localId: 'l1' }, firstReply: null,
    replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0,
    createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
};

describe('attention item wire schemas', () => {
    it('derives needsOwner and push kind from the kind', () => {
        expect(ATTENTION_KINDS.filter(attentionKindNeedsOwner)).toEqual(['decision', 'todo', 'blocked']);
        expect(attentionPushKind({ kind: 'blocked' })).toBe('attention');
        expect(attentionPushKind({ kind: 'answer', replyToId: 'q1' })).toBe('question');
        expect(attentionPushKind({ kind: 'answer', replyToId: null })).toBeNull();
        expect(attentionPushKind({ kind: 'report' })).toBeNull();
        expect(attentionPushKind({ kind: 'pin' })).toBeNull();
        expect(attentionPushKind({ kind: 'future-kind' })).toBeNull();
        // D5 drafts stay silent until the lead confirms them.
        expect(attentionPushKind({ kind: 'decision', inferred: true })).toBeNull();
        expect(attentionPushKind({ kind: 'answer', replyToId: 'q1', inferred: true })).toBeNull();
        expect(attentionPushKind({ kind: 'decision', inferred: false })).toBe('attention');
    });

    it('tags board-sent owner messages by localId', () => {
        const localId = attentionBoardLocalId('i1', 'n1');
        expect(localId).toBe('board-i1-n1');
        expect(isAttentionBoardLocalId(localId)).toBe(true);
        expect(isAttentionBoardLocalId('l-123')).toBe(false);
        expect(isAttentionBoardLocalId(null)).toBe(false);
    });

    it('maps resolve outcomes to states', () => {
        expect(attentionResolveState('done')).toBe('resolved');
        expect(attentionResolveState('answered')).toBe('answered');
        expect(attentionResolveState('dropped')).toBe('dismissed');
        expect(attentionResolveState('superseded')).toBe('dismissed');
        expect(isAttentionActive('in_progress')).toBe(true);
        expect(isAttentionActive('answered')).toBe(false);
    });

    it('requires 2-4 unique options for a decision', () => {
        const base = { sessionId: 's1', source: 'lead', kind: 'decision', title: 'Pick one' } as const;
        expect(AttentionItemPostSchema.safeParse(base).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, options: [twoOptions[0]] }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, options: [twoOptions[0], twoOptions[0]] }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, options: twoOptions }).success).toBe(true);
        expect(AttentionItemPostSchema.safeParse({ ...base, kind: 'report' }).success).toBe(true);
        expect(AttentionItemPostSchema.parse({ ...base, options: twoOptions }).inferred).toBe(false);
        expect(AttentionItemPostSchema.parse({ ...base, options: twoOptions, inferred: true }).inferred).toBe(true);
    });

    it('bounds title, body bytes and anchors', () => {
        const base = { sessionId: 's1', source: 'agent', kind: 'blocked' } as const;
        expect(AttentionItemPostSchema.safeParse({ ...base, title: 'x'.repeat(121) }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
        // 3-byte CJK: 2731 chars = 8193 bytes > 8KB.
        expect(AttentionItemPostSchema.safeParse({ ...base, title: 't', bodyMd: '汇'.repeat(2731) }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, title: 't', bodyMd: '汇'.repeat(2730) }).success).toBe(true);
        expect(AttentionItemPostSchema.safeParse({ ...base, title: 't', anchor: {} }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...base, title: 't', anchor: { messageId: 'm1', snippet: 'hi' } }).success).toBe(true);
        expect(AttentionItemPostSchema.safeParse({ ...base, source: 'nobody', title: 't' }).success).toBe(false);
    });

    it('patch: body xor append, kind only to request, no closing states', () => {
        expect(AttentionItemPatchSchema.safeParse({ bodyMd: 'a', appendMd: 'b' }).success).toBe(false);
        expect(AttentionItemPatchSchema.safeParse({ appendMd: 'b', state: 'in_progress' }).success).toBe(true);
        expect(AttentionItemPatchSchema.safeParse({ kind: 'request' }).success).toBe(true);
        expect(AttentionItemPatchSchema.safeParse({ kind: 'decision' }).success).toBe(false);
        expect(AttentionItemPatchSchema.safeParse({ state: 'resolved' }).success).toBe(false);
        expect(AttentionItemPatchSchema.safeParse({ firstReply: { messageId: 'm2' }, state: 'answered' }).success).toBe(true);
    });

    it('owner-respond actions', () => {
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'choose', choice: 'B' }).success).toBe(true);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'choose' }).success).toBe(false);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'resolve', note: 'ok' }).success).toBe(true);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'reopen' }).success).toBe(true);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'delete' }).success).toBe(false);
    });

    it('list query coerces numbers from the query string', () => {
        expect(AttentionItemListQuerySchema.parse({ since: '1700000000000', limit: '50', state: 'active' })).toEqual({ since: 1700000000000, limit: 50, state: 'active' });
        expect(AttentionItemListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    });

    it('item and update payload tolerate values from newer servers', () => {
        const newer = { ...item, kind: 'escalation', state: 'snoozed', resolvedBy: 'robot', extra: 1, options: [{ ...twoOptions[0], icon: 'x' }, twoOptions[1]] };
        const parsed = AttentionItemSchema.parse(newer);
        expect(parsed.kind).toBe('escalation');
        expect(parsed.options?.[0]).toMatchObject({ icon: 'x' });
        expect(UpdateAttentionItemBodySchema.parse({ t: 'attention-item', item }).item.id).toBe('i1');
        const { inferred: _omit, ...olderServer } = item;
        expect(AttentionItemSchema.parse(olderServer).inferred).toBe(false);
    });
});

describe('owner_board_* tool schemas', () => {
    it('post: lead kinds only, decision needs options, request_id required', () => {
        const base = { title: 'Pick one', request_id: 'r1' };
        expect(OwnerBoardPostInputSchema.safeParse({ ...base, kind: 'decision', options: twoOptions, anchor: 'this_turn' }).success).toBe(true);
        expect(OwnerBoardPostInputSchema.safeParse({ ...base, kind: 'decision' }).success).toBe(false);
        expect(OwnerBoardPostInputSchema.safeParse({ ...base, kind: 'blocked' }).success).toBe(false);
        expect(OwnerBoardPostInputSchema.safeParse({ ...base, kind: 'question' }).success).toBe(false);
        expect(OwnerBoardPostInputSchema.safeParse({ kind: 'report', title: 'Merged' }).success).toBe(false);
        expect(OwnerBoardPostInputSchema.safeParse({ ...base, kind: 'answer', reply_to: 'q1', anchor: { localId: 'l9' } }).success).toBe(true);
        // The tool never marks its own posts as drafts.
        expect('inferred' in OwnerBoardPostInputSchema.parse({ ...base, kind: 'report', inferred: true })).toBe(false);
    });

    it('update / resolve / list', () => {
        expect(OwnerBoardUpdateInputSchema.safeParse({ id: 'i1', state: 'in_progress', request_id: 'r2' }).success).toBe(true);
        expect(OwnerBoardUpdateInputSchema.safeParse({ id: 'i1', state: 'resolved', request_id: 'r2' }).success).toBe(false);
        expect(OwnerBoardUpdateInputSchema.safeParse({ id: 'i1', body_md: 'a', append_md: 'b', request_id: 'r2' }).success).toBe(false);
        expect(OwnerBoardResolveInputSchema.safeParse({ id: 'i1', outcome: 'superseded', request_id: 'r3' }).success).toBe(true);
        expect(OwnerBoardResolveInputSchema.safeParse({ id: 'i1', outcome: 'closed', request_id: 'r3' }).success).toBe(false);
        expect(OwnerBoardListInputSchema.safeParse({}).success).toBe(true);
        expect(OwnerBoardListInputSchema.safeParse({ state: 'active' }).success).toBe(false);
    });

    it('maps a post tool call to a valid REST body', () => {
        const input = OwnerBoardPostInputSchema.parse({ kind: 'decision', title: 'Pick one', options: twoOptions, key: 'k', reply_to: 'q1', links: [{ type: 'pr', ref: '701' }], request_id: 'r1' });
        const rest = ownerBoardPostToRest('s1', input, { messageId: 'm1' });
        expect(rest).toEqual({ sessionId: 's1', source: 'lead', kind: 'decision', title: 'Pick one', options: twoOptions, links: [{ type: 'pr', ref: '701' }], anchor: { messageId: 'm1' }, replyToId: 'q1', key: 'k', requestId: 'r1', inferred: false });
        expect(AttentionItemPostSchema.safeParse(rest).success).toBe(true);
    });
});
