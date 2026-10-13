// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { appendMessageQuote, insertMessageQuoteAt } from './messageActionsModel';
import { fenceCode, normalizeSelectedText, readQuotableSelection } from './selectionQuoteRange';

describe('insertMessageQuoteAt (B-577)', () => {
    it('quotes at the caret with the B-454 format and a blank line on each side', () => {
        expect(insertMessageQuoteAt('', 'a\nb', 0, 0)).toEqual({ text: '> a\n> b\n\n', caret: 9 });
        const mid = insertMessageQuoteAt('hello world', 'q', 5, 5);
        expect(mid.text).toBe('hello\n\n> q\n\n world');
        expect(mid.text.slice(0, mid.caret)).toBe('hello\n\n> q\n\n');
        // replaces selected draft text
        expect(insertMessageQuoteAt('keep DROP tail', 'q', 5, 9).text).toBe('keep \n\n> q\n\n tail');
        // no extra blank lines when the draft already has them
        expect(insertMessageQuoteAt('para\n\n\nnext', 'q', 6, 6).text).toBe('para\n\n> q\n\nnext');
        // caret at the end behaves like the whole-message quote
        expect(insertMessageQuoteAt('draft', 'q', 5, 5).text).toBe(appendMessageQuote('draft', 'q'));
    });
});

describe('selection text rules', () => {
    it('fences code, keeping it verbatim', () => {
        expect(fenceCode('const a = 1;\n  b()\n', 'ts')).toBe('```ts\nconst a = 1;\n  b()\n```');
        expect(fenceCode('x', 'text')).toBe('```\nx\n```');
        expect(fenceCode('has ``` inside', null)).toBe('````\nhas ``` inside\n````');
    });
    it('trims surrounding blank lines only', () => {
        expect(normalizeSelectedText('\n  first\n\nsecond  \n')).toBe('  first\n\nsecond');
    });
});

function transcript(): HTMLElement {
    document.body.innerHTML = `
      <div id="outside">header text</div>
      <div id="root">
        <div class="msg msg--agent"><div class="msg-agent-text"><div class="md" id="m1"><p id="p1">Alpha beta gamma</p>
          <div class="cv"><div class="cv-bar"><span class="cv-lang">ts</span></div><div class="cv-body"><pre id="code">const a = 1;\nconst b = 2;</pre></div></div>
        </div><div class="msg-actions"><span class="msg-time">12:00</span></div></div></div>
        <div class="msg msg--user"><div class="msg-bubble-wrap"><div class="msg-bubble"><div class="msg-bubble-text" id="m2">Second message</div></div></div></div>
        <div class="msg msg--agent"><div class="msg-thinking-body"><div class="md"><p id="think">thinking text</p></div></div></div>
      </div>`;
    return document.getElementById('root')!;
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
}

describe('readQuotableSelection', () => {
    it('takes a selection inside one agent reply', () => {
        const root = transcript();
        const text = document.getElementById('p1')!.firstChild!;
        const result = readQuotableSelection(root, select(text, 6, text, 10));
        expect(result).toMatchObject({ text: 'beta', clipped: false });
        expect(result?.source.id).toBe('m1');
    });

    it('fences a selection that stays inside one code block', () => {
        const root = transcript();
        const code = document.getElementById('code')!.firstChild!;
        const result = readQuotableSelection(root, select(code, 0, code, 12));
        expect(result?.text).toBe('```ts\nconst a = 1;\n```');
    });

    it('clips a selection that runs into the next message to the first one', () => {
        const root = transcript();
        const start = document.getElementById('p1')!.firstChild!;
        const end = document.getElementById('m2')!.firstChild!;
        const result = readQuotableSelection(root, select(start, 6, end, 6));
        expect(result?.clipped).toBe(true);
        expect(result?.source.id).toBe('m1');
        expect(result?.text).toContain('beta gamma');
        expect(result?.text).not.toContain('Second');
        expect(result?.text).not.toContain('12:00');
    });

    it('takes a user bubble, refuses thinking blocks and selections that start outside', () => {
        const root = transcript();
        const bubble = document.getElementById('m2')!.firstChild!;
        expect(readQuotableSelection(root, select(bubble, 0, bubble, 6))?.text).toBe('Second');
        const think = document.getElementById('think')!.firstChild!;
        expect(readQuotableSelection(root, select(think, 0, think, 8))).toBeNull();
        const outside = document.getElementById('outside')!.firstChild!;
        expect(readQuotableSelection(root, select(outside, 0, bubble, 6))).toBeNull();
        expect(readQuotableSelection(root, select(bubble, 2, bubble, 2))).toBeNull();
    });
});
