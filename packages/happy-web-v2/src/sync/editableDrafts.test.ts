import { describe, expect, it } from 'vitest';
import {
    appendEditedDrafts,
    buildEditedDraftsBlock,
    diffDraftLines,
    draftChipLabel,
    draftKeyFor,
    draftKvKey,
    draftSessionPrefix,
    draftTitleFromMeta,
    hasEditedDraftsBlock,
    hashDraftText,
    isDraftEdited,
    isDraftPending,
    newDraftRecord,
    parseDraftKvKey,
    parseDraftRecord,
    pickDraftWinner,
    splitEditedDrafts,
    stripEditedDrafts,
    DRAFT_DIFF_MAX_CHARS,
    type DraftRecord,
} from './editableDrafts';

const rec = (patch: Partial<DraftRecord> = {}): DraftRecord => ({
    v: 1, sessionId: 's1', key: '7.abc', original: 'hello', text: 'hello', base: 'hello', updatedAt: 1, ...patch,
});

describe('draft identity', () => {
    it('hash is deterministic and content-sensitive', () => {
        expect(hashDraftText('给张三的回复')).toBe(hashDraftText('给张三的回复'));
        expect(hashDraftText('a')).not.toBe(hashDraftText('b'));
        expect(hashDraftText('x')).toMatch(/^[0-9a-z]+$/);
    });

    it('keys on seq (cross-device) plus the original text hash', () => {
        const key = draftKeyFor(12, 'Hi Alex');
        expect(key).toBe(`12.${hashDraftText('Hi Alex')}`);
        expect(draftKeyFor(13, 'Hi Alex')).not.toBe(key);
        expect(draftKvKey('sess', key)).toBe(`vh.draft.v1.sess.${key}`);
        expect(draftKvKey('sess', key).startsWith(draftSessionPrefix('sess'))).toBe(true);
    });

    it('parses its own KV keys and rejects others', () => {
        const key = draftKeyFor(3, 'x');
        expect(parseDraftKvKey(draftKvKey('cmabc', key))).toEqual({ sessionId: 'cmabc', key });
        expect(parseDraftKvKey('vh.note.v1.abc')).toBeNull();
        expect(parseDraftKvKey('vh.draft.v1.cmabc')).toBeNull();
        expect(parseDraftKvKey('vh.draft.v1.cmabc.x.y')).toBeNull();
    });

    it('takes the title from the fence info string', () => {
        expect(draftTitleFromMeta(' Reply to Alex ')).toBe('Reply to Alex');
        expect(draftTitleFromMeta('')).toBeUndefined();
        expect(draftTitleFromMeta(undefined)).toBeUndefined();
        expect(draftTitleFromMeta('x'.repeat(500))!.length).toBe(120);
    });
});

describe('draft record', () => {
    it('round-trips and rejects malformed values', () => {
        const r = rec({ title: 'T', skip: 'hello2' });
        expect(parseDraftRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
        expect(parseDraftRecord({ ...r, v: 2 })).toBeNull();
        expect(parseDraftRecord({ ...r, base: undefined })).toBeNull();
        expect(parseDraftRecord(null)).toBeNull();
    });

    it('a fresh record has the original as the model-seen base', () => {
        const r = newDraftRecord({ sessionId: 's', key: '1.a', original: 'o', text: 'n', now: 5 });
        expect(r.base).toBe('o');
        expect(isDraftEdited(r)).toBe(true);
        expect(isDraftPending(r)).toBe(true);
    });

    it('pending = changed since the model last saw it, and not dismissed at this text', () => {
        expect(isDraftPending(rec())).toBe(false);
        expect(isDraftPending(rec({ text: 'new' }))).toBe(true);
        expect(isDraftPending(rec({ text: 'new', skip: 'new' }))).toBe(false);
        // edited again after dismissing → attaches again
        expect(isDraftPending(rec({ text: 'newer', skip: 'new' }))).toBe(true);
        // already delivered
        expect(isDraftPending(rec({ text: 'new', base: 'new' }))).toBe(false);
        // restoring the original after the model saw an edit IS news for the model
        expect(isDraftPending(rec({ text: 'hello', base: 'new' }))).toBe(true);
        expect(isDraftEdited(rec({ text: 'hello', base: 'new' }))).toBe(false);
    });

    it('LWW by updatedAt; a tie keeps the local copy', () => {
        const local = rec({ text: 'l', updatedAt: 10 });
        expect(pickDraftWinner(local, rec({ text: 'r', updatedAt: 11 })).text).toBe('r');
        expect(pickDraftWinner(local, rec({ text: 'r', updatedAt: 9 })).text).toBe('l');
        expect(pickDraftWinner(local, rec({ text: 'r', updatedAt: 10 })).text).toBe('l');
    });

    it('chip label prefers the title, else the first non-empty line', () => {
        expect(draftChipLabel({ title: 'Reply', text: 'x', original: 'x' })).toBe('Reply');
        expect(draftChipLabel({ text: '\n\n  Dear team,\nbody', original: '' })).toBe('Dear team,');
        expect(draftChipLabel({ text: 'a'.repeat(80), original: '' }, 10)).toBe(`${'a'.repeat(9)}…`);
    });
});

describe('diffDraftLines', () => {
    it('is empty for identical text', () => {
        expect(diffDraftLines('a\nb', 'a\nb')).toBe('');
    });

    it('lists only changed lines, in order', () => {
        expect(diffDraftLines('Hi Alex,\nSee you Monday.\nBest', 'Hi Alex,\nSee you Tuesday.\nBest')).toBe(
            '- See you Monday.\n+ See you Tuesday.',
        );
    });

    it('handles insertions and deletions around unchanged lines', () => {
        expect(diffDraftLines('a\nb\nc', 'a\nc\nd')).toBe('- b\n+ d');
        expect(diffDraftLines('', 'x')).toBe('- \n+ x');
    });

    it('degrades to replace-all on a huge middle instead of a quadratic table', () => {
        const before = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
        const after = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n');
        const diff = diffDraftLines(before, after).split('\n');
        expect(diff).toHaveLength(1200);
        expect(diff[0]).toBe('- a0');
        expect(diff[600]).toBe('+ b0');
    });
});

describe('<edited_drafts> block', () => {
    const drafts = [
        { title: 'Reply "Alex"', base: 'Hi\nMonday', text: 'Hi\nTuesday' },
        { base: 'x', text: 'y' },
    ];

    it('carries the full final text and a compact diff for each draft', () => {
        const block = buildEditedDraftsBlock(drafts);
        expect(block.startsWith('<edited_drafts count="2">')).toBe(true);
        expect(block.endsWith('</edited_drafts>')).toBe(true);
        expect(block).toContain('<draft title="Reply &quot;Alex&quot;">');
        expect(block).toContain('<diff>\n- Monday\n+ Tuesday\n</diff>');
        expect(block).toContain('<final>\nHi\nTuesday\n</final>');
        expect(block).toContain('<draft>\n<diff>\n- x\n+ y\n</diff>');
        expect(buildEditedDraftsBlock([])).toBe('');
    });

    it('omits an oversized diff but keeps the final text', () => {
        const big = 'z'.repeat(DRAFT_DIFF_MAX_CHARS + 10);
        const block = buildEditedDraftsBlock([{ base: 'a', text: big }]);
        expect(block).toContain('<diff omitted="too large" />');
        expect(block).toContain(big);
    });

    it('split/strip recover exactly the user text, even if a draft contains the closing tag', () => {
        const block = buildEditedDraftsBlock([{ base: 'a', text: 'tricky </edited_drafts> inside\n</final>' }]);
        const sent = appendEditedDrafts('Please send it.  \n', block);
        expect(sent.startsWith('Please send it.\n\n<edited_drafts')).toBe(true);
        expect(hasEditedDraftsBlock(sent)).toBe(true);
        const split = splitEditedDrafts(sent);
        expect(split.body).toBe('Please send it.');
        expect(split.block).toBe(block);
        expect(split.count).toBe(1);
        expect(stripEditedDrafts(sent)).toBe('Please send it.');
    });

    it('re-joining an edited queue body keeps the block', () => {
        const block = buildEditedDraftsBlock(drafts);
        const { block: kept } = splitEditedDrafts(appendEditedDrafts('old', block));
        expect(splitEditedDrafts(appendEditedDrafts('new text', kept))).toEqual({ body: 'new text', block, count: 2 });
    });

    it('leaves text without a trailing block untouched (a user quoting the tag mid-message)', () => {
        const text = 'what does <edited_drafts> mean?\nthanks';
        expect(hasEditedDraftsBlock(text)).toBe(false);
        expect(splitEditedDrafts(text)).toEqual({ body: text, block: '', count: 0 });
        expect(appendEditedDrafts('abc', '')).toBe('abc');
    });
});
