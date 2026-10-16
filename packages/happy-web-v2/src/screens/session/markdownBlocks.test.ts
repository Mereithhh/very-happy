/**
 * B-610: top-level block splitter for streaming markdown. The DOM-equivalence
 * guarantee is tested in markdownBlocksRender.test.tsx; these pin WHERE it cuts.
 */
import { describe, expect, it } from 'vitest';
import { hasCrossBlockReferences, splitMarkdownBlocks } from './markdownBlocks';

const split = (s: string) => {
    const blocks = splitMarkdownBlocks(s);
    expect(blocks.join('')).toBe(s); // lossless, always
    return blocks;
};

describe('B-610 splitMarkdownBlocks', () => {
    it('splits paragraphs and headings at blank lines', () => {
        expect(split('# Title\n\npara one\nstill one\n\npara two\n')).toEqual([
            '# Title\n\n', 'para one\nstill one\n\n', 'para two\n',
        ]);
    });

    it('keeps leading blank lines and multiple blank lines inside one block', () => {
        expect(split('\n\na\n\n\n\nb')).toEqual(['\n\na\n\n\n\n', 'b']);
    });

    it('never splits inside a fenced code block, including blank lines', () => {
        const src = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n';
        expect(split(src)).toEqual(['intro\n\n', '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n', 'after\n']);
    });

    it('keeps an UNCLOSED fence at the tail as one growing block', () => {
        const src = 'intro\n\n```\ncode\n\nmore code\n\nstill code';
        expect(split(src)).toEqual(['intro\n\n', '```\ncode\n\nmore code\n\nstill code']);
    });

    it('tilde fences are not closed by backticks and vice versa', () => {
        const src = '~~~\n```\n\nx\n~~~\n\ny';
        expect(split(src)).toEqual(['~~~\n```\n\nx\n~~~\n\n', 'y']);
        expect(split('````\n```\n\nx\n````\n\ny')).toEqual(['````\n```\n\nx\n````\n\n', 'y']);
    });

    it('a closing fence may not carry an info string', () => {
        expect(split('```\n```js\n\nx\n```\n\ny')).toEqual(['```\n```js\n\nx\n```\n\n', 'y']);
    });

    it('```inline``` with backticks in the info string is not a fence', () => {
        expect(split('```a``` b\n\nc')).toEqual(['```a``` b\n\n', 'c']);
    });

    it('keeps a loose list (blank lines between items) in one block', () => {
        const src = '- a\n\n- b\n\n  continued\n\n- c\n\nafter';
        expect(split(src)).toEqual(['- a\n\n- b\n\n  continued\n\n- c\n\n', 'after']);
        expect(split('1. a\n\n2. b\n\n3. c')).toEqual(['1. a\n\n2. b\n\n3. c']);
    });

    it('splits before a list that follows a paragraph', () => {
        expect(split('para\n\n- a\n- b')).toEqual(['para\n\n', '- a\n- b']);
    });

    it('does not split before indented continuation lines', () => {
        expect(split('- item\n\n    indented code or item text\n\nnext')).toEqual([
            '- item\n\n    indented code or item text\n\n', 'next',
        ]);
    });

    it('tracks a fence inside a list item by its column', () => {
        const src = '1. Run:\n   ```bash\n   a\n\n   b\n   ```\n\nafter\n\nend';
        expect(split(src)).toEqual(['1. Run:\n   ```bash\n   a\n\n   b\n   ```\n\n', 'after\n\n', 'end']);
        expect(split('- ```\n  x\n\n  y\n  ```\n\nz')).toEqual(['- ```\n  x\n\n  y\n  ```\n\n', 'z']);
    });

    it('gives up (merges everything after) when a list fence is ambiguous', () => {
        // "  cmd" is less indented than the fence: the item may have ended and
        // the next ``` may OPEN a top-level fence. Don't guess.
        const src = 'p\n\n1. ```\n  cmd\n   ```\n\nx\n\ny';
        expect(split(src)).toEqual(['p\n\n', '1. ```\n  cmd\n   ```\n\nx\n\ny']);
    });

    it('splits tables, blockquotes and setext headings at blank lines', () => {
        const src = '| a |\n| - |\n| 1 |\n\n> quote\nlazy\n\nTitle\n=====\n\ntext';
        expect(split(src)).toEqual(['| a |\n| - |\n| 1 |\n\n', '> quote\nlazy\n\n', 'Title\n=====\n\n', 'text']);
    });

    it('html blocks 1-5 run to their end marker, across blank lines', () => {
        expect(split('<!--\nhidden\n\nstill\n-->\n\nafter')).toEqual(['<!--\nhidden\n\nstill\n-->\n\n', 'after']);
        expect(split('<pre>\na\n\nb\n</pre>\n\nc')).toEqual(['<pre>\na\n\nb\n</pre>\n\n', 'c']);
        expect(split('<!-- one line -->\n\nx')).toEqual(['<!-- one line -->\n\n', 'x']);
    });

    it('type 6/7 html ends at a blank line; a fence inside it gives up', () => {
        expect(split('<div>\nhi\n\nafter')).toEqual(['<div>\nhi\n\n', 'after']);
        expect(split('<div>\n```\n\nx\n\ny')).toEqual(['<div>\n```\n\nx\n\ny']);
    });

    it('falls back to one block for link reference definitions and footnotes', () => {
        expect(split('see [x]\n\n[x]: https://a.b')).toHaveLength(1);
        expect(split('claim[^1]\n\n[^1]: source')).toHaveLength(1);
        expect(hasCrossBlockReferences('> [x]: https://a.b')).toBe(true);
        expect(hasCrossBlockReferences('plain [link](https://a.b)\n\n- [ ] task')).toBe(false);
    });

    it('handles CRLF line endings', () => {
        expect(split('a\r\n\r\nb\r\n')).toEqual(['a\r\n\r\n', 'b\r\n']);
    });

    it('returns no blocks for empty input', () => {
        expect(splitMarkdownBlocks('')).toEqual([]);
    });
});
