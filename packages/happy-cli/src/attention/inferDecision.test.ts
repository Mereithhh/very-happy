import { describe, expect, it } from 'vitest';
import { AttentionItemPostSchema } from '@slopus/happy-wire';
import { inferOwnerDecision, parseOptions } from './inferDecision';

describe('inferOwnerDecision (B-766 D5)', () => {
    it('drafts a decision from a Chinese ask with lettered options, keeping the recommended one', () => {
        const text = '发布前有个点需要你决定：迁移是先上 server 还是一起上？\n\nA. 先上 server，CLI 下周（推荐）\nB. 一起上\nC. 推迟到下个版本';
        const draft = inferOwnerDecision(text)!;
        expect(draft.title).toBe('发布前有个点需要你决定：迁移是先上 server 还是一起上？');
        expect(draft.options).toEqual([
            { id: 'A', label: '先上 server，CLI 下周（推荐）', recommended: true },
            { id: 'B', label: '一起上' },
            { id: 'C', label: '推迟到下个版本' },
        ]);
        expect(draft.key).toMatch(/^inferred-[0-9a-f]{16}$/);
        // The draft is a valid W0 post body.
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'lead', kind: 'decision', inferred: true, title: draft.title, options: draft.options, key: draft.key, bodyMd: draft.bodyMd }).success).toBe(true);
    });

    it('recognises English asks and numbered options', () => {
        const draft = inferOwnerDecision('Both fixes are ready. I need you to decide which one ships:\n1) Patch the reducer\n2) Add a migration\nOtherwise I keep waiting.')!;
        expect(draft.title).toBe('I need you to decide which one ships:');
        expect(draft.options.map(o => o.id)).toEqual(['1', '2']);
    });

    it('reads an <options> block', () => {
        const draft = inferOwnerDecision('Pick one.\n<options><option>Ship now</option><option id="later">Wait for QA (recommended)</option></options>')!;
        expect(draft.options).toEqual([{ id: 'A', label: 'Ship now' }, { id: 'later', label: 'Wait for QA (recommended)', recommended: true }]);
    });

    it('falls back to two generic options in the ask\'s language', () => {
        expect(inferOwnerDecision('这个改名请你拍板。')!.options.map(o => o.label)).toEqual(['同意', '另有安排（回复说明）']);
        expect(inferOwnerDecision('Waiting for your approval on the rename.')!.options.map(o => o.id)).toEqual(['yes', 'other']);
    });

    it('ignores ordinary text and asks quoted in code', () => {
        expect(inferOwnerDecision('PR #12 merged; CI green. Next I will review B-3.')).toBeNull();
        expect(inferOwnerDecision('The test fixture says:\n```\n需要你决定\n```\nand `please decide` is a string literal.')).toBeNull();
    });

    it('keys the same ask identically and a different ask differently', () => {
        const a = inferOwnerDecision('需要你决定：A 还是 B？\nA. 方案甲\nB. 方案乙')!;
        const again = inferOwnerDecision('需要你决定：A 还是 B？\nA. 方案甲\nB. 方案乙')!;
        const other = inferOwnerDecision('需要你决定：A 还是 B？\nA. 方案甲\nB. 方案丙')!;
        expect(again.key).toBe(a.key);
        expect(other.key).not.toBe(a.key);
    });

    it('takes the first run of 2-4 lettered options over a numbered step list', () => {
        expect(parseOptions('Steps:\n1. build\n2. test\n\nA. ship\nB. hold').map(o => o.id)).toEqual(['A', 'B']);
        expect(parseOptions('A. only one')).toEqual([]);
    });
});
