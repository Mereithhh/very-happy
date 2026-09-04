import { describe, expect, it } from 'vitest';
import { extractOptions, splitOptionSegments } from './optionsBlock';

describe('splitOptionSegments', () => {
    it('canonical block at the end', () => {
        expect(splitOptionSegments('选哪个？\n<options>\n<option>甲</option>\n<option>乙</option>\n</options>'))
            .toEqual([
                { kind: 'text', text: '选哪个？' },
                { kind: 'options', items: ['甲', '乙'] },
            ]);
    });

    it('several options on one line (the old global-regex bug kept only the first)', () => {
        expect(splitOptionSegments('A?\n<options><option>x</option><option>y</option></options>'))
            .toEqual([
                { kind: 'text', text: 'A?' },
                { kind: 'options', items: ['x', 'y'] },
            ]);
    });

    it('tolerates an unterminated block (streaming draft mid-flight)', () => {
        expect(splitOptionSegments('pick\n<options>\n<option>a</option>'))
            .toEqual([
                { kind: 'text', text: 'pick' },
                { kind: 'options', items: ['a'] },
            ]);
    });

    it('leaves a fenced example alone — the system prompt says models write it that way', () => {
        const src = '像这样：\n```\n<options>\n<option>a</option>\n</options>\n```\n懂了吗';
        expect(splitOptionSegments(src)).toEqual([{ kind: 'text', text: src }]);
    });

    it('handles two blocks with prose in between', () => {
        expect(splitOptionSegments('A?\n<options>\n<option>x</option>\n</options>\nB?\n<options>\n<option>y</option>\n</options>'))
            .toEqual([
                { kind: 'text', text: 'A?' },
                { kind: 'options', items: ['x'] },
                { kind: 'text', text: 'B?' },
                { kind: 'options', items: ['y'] },
            ]);
    });

    it('drops empty options and an empty block', () => {
        expect(splitOptionSegments('q\n<options>\n<option> </option>\n</options>'))
            .toEqual([{ kind: 'text', text: 'q' }]);
    });

    it('is a pass-through when there is no block at all', () => {
        expect(splitOptionSegments('just text\nwith lines')).toEqual([{ kind: 'text', text: 'just text\nwith lines' }]);
    });

    it('keeps an inline (non-line-leading) <options> as text, matching the renderer today', () => {
        expect(splitOptionSegments('inline <options><option>a</option></options> tail'))
            .toEqual([{ kind: 'text', text: 'inline <options><option>a</option></options> tail' }]);
    });
});

describe('extractOptions (assistant/TTS shape)', () => {
    it('returns prose without the block, plus flat options', () => {
        expect(extractOptions('接下来做哪个？\n<options>\n<option>先派 B-051</option>\n<option>先做三件套</option>\n</options>'))
            .toEqual({ text: '接下来做哪个？', options: ['先派 B-051', '先做三件套'] });
    });

    it('never speaks a fenced example as options', () => {
        const src = '协议长这样：\n```\n<options>\n<option>a</option>\n</options>\n```';
        expect(extractOptions(src)).toEqual({ text: src.trim(), options: [] });
    });
});

describe('splitOptionSegments — closing tag on the same line', () => {
    it('keeps the prose that follows a single-line block (data loss regression)', () => {
        expect(splitOptionSegments('Pick\n<options><option>A</option></options>\n\nreal trailing prose'))
            .toEqual([
                { kind: 'text', text: 'Pick' },
                { kind: 'options', items: ['A'] },
                { kind: 'text', text: '\nreal trailing prose' },
            ]);
    });

    it('keeps trailing content on the same line as the closing tag', () => {
        expect(splitOptionSegments('<options><option>A</option></options> tail words'))
            .toEqual([
                { kind: 'options', items: ['A'] },
                { kind: 'text', text: ' tail words' },
            ]);
    });

    it('extractOptions keeps that prose too (the TTS path shares this parser)', () => {
        expect(extractOptions('Pick\n<options><option>A</option></options>\n\nreal trailing prose'))
            .toEqual({ text: 'Pick\n\nreal trailing prose', options: ['A'] });
    });
});

describe('inline (mid-line) blocks: rendered as text, never spoken', () => {
    const src = 'inline <options><option>a</option></options> tail';

    it('splitOptionSegments leaves it in the prose so the paragraph is not torn in half', () => {
        expect(splitOptionSegments(src)).toEqual([{ kind: 'text', text: src }]);
    });

    it('extractOptions sweeps it out of the spoken text and still offers the buttons', () => {
        expect(extractOptions(src)).toEqual({ text: 'inline  tail', options: ['a'] });
    });
});
