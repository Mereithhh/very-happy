// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isAttentionBoardLocalId, type AttentionItem } from '@slopus/happy-wire';
import { mergeItem } from '@/sync/attentionStore';
import { boardCopy } from './boardCopy';
import { choiceMessage, isReloginRequired } from './boardActions';
import { AttentionApiError } from '@/sync/apiAttention';

const base = {
    sessionId: 's', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: null, title: '今天发还是明早发？', bodyMd: null,
    options: [{ id: 'A', label: '今晚' }, { id: 'B', label: '明早' }], links: null, anchor: null, firstReply: null, replyToId: null,
    inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null,
    repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
} satisfies Omit<AttentionItem, 'id'>;

describe('board actions (B-766)', () => {
    it('B-916c (QA80 P3): a main agent dispatch card choice names the approval and the card', () => {
        const card = { ...base, id: 'card-1', source: 'agent', key: 'main-agent-dispatch:6b1767e6-9190-442c-b32e-bcc7ae7deeac', title: '主 agent 想派活（external）：私信 A',
            options: [{ id: 'approve', label: '批准执行' }, { id: 'draft', label: '只出草稿' }, { id: 'drop', label: '放弃' }] };
        expect(choiceMessage(card, 'approve', boardCopy(true))).toBe('［汇报板 · 决定］主 agent 想派活（external）：私信 A → 批准执行 (dispatch_approved approvalId=6b1767e6-9190-442c-b32e-bcc7ae7deeac boardItemId=card-1)');
        // B-920: a settings card names the card id for --approved
        const settings = { ...base, id: 'card-9', source: 'agent', key: 'settings-change:abc', title: '要改设置：defaults.permissionMode（project）', options: [{ id: 'approve', label: '批准写入' }, { id: 'drop', label: '放弃' }] };
        expect(choiceMessage(settings, 'approve', boardCopy(true))).toBe('［汇报板 · 决定］要改设置：defaults.permissionMode（project） → 批准写入 (very-happy settings set … --approved card-9)');
        // other cards are unchanged
        expect(choiceMessage({ ...base, id: 'd1', key: 'issue-review:1' }, 'B', boardCopy(true))).toBe('［汇报板 · 决定］今天发还是明早发？ → B. 明早');
    });

    it('a choice is sent as an Owner message naming the option', () => {
        expect(choiceMessage({ ...base, id: 'd1' }, 'B', boardCopy(true))).toBe('［汇报板 · 决定］今天发还是明早发？ → B. 明早');
        expect(choiceMessage({ ...base, id: 'd1' }, 'B', boardCopy(false))).toBe('[Briefing · decision] 今天发还是明早发？ → B. 明早');
        expect(isAttentionBoardLocalId('board-d1-x')).toBe(true);
        // QA5 O1: an internal id (team submit) is not spelled out to the lead.
        const submit = { ...base, id: 's1', source: 'team', options: [{ id: 'accept', label: '验收 / Accept', recommended: true }, { id: 'return', label: '退回 / Return' }] };
        expect(choiceMessage(submit, 'return', boardCopy(true))).toBe('［汇报板 · 决定］今天发还是明早发？ → 退回 / Return');
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

    it('B-921: owner_login_required is told apart from other failures', () => {
        expect(isReloginRequired(new AttentionApiError(403, 'owner_login_required'))).toBe(true);
        expect(isReloginRequired(new AttentionApiError(403, 'forbidden'))).toBe(false);
        expect(isReloginRequired(new AttentionApiError(409, 'attention_item_closed'))).toBe(false);
        expect(isReloginRequired(new Error('owner_login_required'))).toBe(false);
    });
});
