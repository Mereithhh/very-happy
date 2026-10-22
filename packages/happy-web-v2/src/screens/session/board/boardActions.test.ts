// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isAttentionBoardLocalId, type AttentionItem } from '@slopus/happy-wire';
import { mergeItem } from '@/sync/attentionStore';
import { boardCopy } from './boardCopy';
import { choiceMessage } from './boardActions';

const base = {
    sessionId: 's', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: null, title: '今天发还是明早发？', bodyMd: null,
    options: [{ id: 'A', label: '今晚' }, { id: 'B', label: '明早' }], links: null, anchor: null, firstReply: null, replyToId: null,
    inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null,
    repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
} satisfies Omit<AttentionItem, 'id'>;

describe('board actions (B-766)', () => {
    it('a choice is sent as an Owner message naming the option', () => {
        expect(choiceMessage({ ...base, id: 'd1' }, 'B', boardCopy(true))).toBe('［汇报板 · 决定］今天发还是明早发？ → B. 明早');
        expect(choiceMessage({ ...base, id: 'd1' }, 'B', boardCopy(false))).toBe('[Briefing · decision] 今天发还是明早发？ → B. 明早');
        expect(isAttentionBoardLocalId('board-d1-x')).toBe(true);
    });

    it('socket snapshots never go back in version; same version replaces (optimistic undo)', () => {
        const v2 = { ...base, id: 'd1', version: 2, state: 'resolved' };
        const v1 = { ...base, id: 'd1', version: 1 };
        expect(mergeItem([v2], v1)).toEqual([v2]);
        expect(mergeItem([v1], v2)).toEqual([v2]);
        const undo = { ...v2, state: 'open' };
        expect(mergeItem([v2], undo)).toEqual([undo]);
        expect(mergeItem(undefined, v1)).toEqual([v1]);
    });
});
