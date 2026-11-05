// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import {
    ANCHOR_CONTEXT,
    CHAT_ANNOTATION_QUOTE_MAX,
    buildAnchor,
    canAnnotateSession,
    composeAnnotatedMessage,
    excerptPreview,
    locateAnchor,
    parseChatAnnotations,
    type ChatAnnotation,
} from './chatAnnotations';
import { anchorFromSelection, locateInDom, rangeFromOffsets, textOffset } from './chatAnnotationDom';

const note = (over: Partial<ChatAnnotation>): ChatAnnotation => ({
    id: 'a1', messageId: 'm1', quote: 'q', prefix: '', suffix: '', start: 0, excerpt: 'q', body: 'b', createdAt: 1, updatedAt: 1, ...over,
});

describe('anchor + locate (B-891)', () => {
    const text = 'The cache is fine. Then the cache misses again and the cache dies.';

    it('anchors the exact selection with bounded context and finds it at the same offset', () => {
        const start = text.indexOf('cache misses');
        const a = buildAnchor('m1', text, start, start + 'cache misses'.length, 'cache misses')!;
        expect(a).toMatchObject({ messageId: 'm1', quote: 'cache misses', start, prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start) });
        expect(a.suffix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT);
        expect(locateAnchor(text, a)).toEqual({ start, end: start + 12 });
    });

    it('rejects blank, missing-id and over-long selections', () => {
        expect(buildAnchor('m1', 'a   b', 1, 4, '')).toBeNull();
        expect(buildAnchor('', text, 0, 5, 'x')).toBeNull();
        const long = 'x'.repeat(CHAT_ANNOTATION_QUOTE_MAX + 1);
        expect(buildAnchor('m1', long, 0, long.length, long)).toBeNull();
    });

    it('picks the right duplicate by its context after the text above changed', () => {
        // second "the cache" (before "dies")
        const start = text.lastIndexOf('the cache');
        const a = buildAnchor('m1', text, start, start + 9, 'the cache')!;
        const edited = `Intro paragraph added on re-render. ${text}`;
        const at = locateAnchor(edited, a)!;
        expect(edited.slice(at.start, at.end)).toBe('the cache');
        expect(edited.slice(at.end, at.end + 5)).toBe(' dies');
    });

    it('stays put while text streams in after it (no jumping)', () => {
        const start = text.indexOf('fine');
        const a = buildAnchor('m1', text, start, start + 4, 'fine')!;
        expect(locateAnchor(`${text} More text fine fine.`, a)).toEqual({ start, end: start + 4 });
    });

    it('is stale (null) once the quoted text is gone', () => {
        const a = buildAnchor('m1', text, 4, 9, 'cache')!;
        expect(locateAnchor('Completely rewritten.', a)).toBeNull();
    });
});

describe('DOM anchoring (B-891)', () => {
    let root: HTMLElement;
    beforeAll(() => {
        root = document.createElement('div');
        root.innerHTML = '<div data-message-id="m1" class="msg-agent-text"><div class="md"><p>Alpha <b>beta</b> gamma</p><p>delta beta</p></div></div>';
        document.body.appendChild(root);
    });

    it('turns a selection into textContent offsets and back into the same range', () => {
        const source = root.querySelector('.md')!;
        const b = root.querySelector('b')!.firstChild!;
        const range = document.createRange();
        range.setStart(b, 0);
        range.setEnd(b, 4);
        expect(textOffset(source, b, 0)).toBe(6);
        const anchor = anchorFromSelection({ source, range, text: 'beta' })!;
        expect(anchor).toMatchObject({ messageId: 'm1', quote: 'beta', start: 6 });
        const back = rangeFromOffsets(source, anchor.start, anchor.start + anchor.quote.length)!;
        expect(back.toString()).toBe('beta');
        expect(back.startContainer).toBe(b);
    });

    it('spans element boundaries', () => {
        const source = root.querySelector('.md')!;
        const r = rangeFromOffsets(source, 2, 13)!;
        expect(r.toString()).toBe('pha beta ga');
    });

    it('reports absent (not rendered) apart from stale (rendered, text gone)', () => {
        expect(locateInDom(root, note({ messageId: 'nope', quote: 'beta' })).kind).toBe('absent');
        expect(locateInDom(root, note({ messageId: 'm1', quote: 'omega' })).kind).toBe('stale');
        const found = locateInDom(root, note({ messageId: 'm1', quote: 'beta', prefix: 'delta ', start: 0 }));
        expect(found.kind).toBe('found');
        // the prefix picks the second "beta"
        if (found.kind === 'found') expect(found.range.startContainer.textContent).toBe('delta beta');
    });
});

describe('composeAnnotatedMessage (B-891)', () => {
    const list = [
        note({ id: 'a', excerpt: 'first line\nsecond line', body: ' fix this ' }),
        note({ id: 'b', excerpt: 'other', body: 'why?' }),
        note({ id: 'c', excerpt: 'blank note', body: '   ' }),
    ];

    it('numbers comments in order, quotes each excerpt, then the user text', () => {
        expect(composeAnnotatedMessage(list, '  please revise  ', 'zh')).toBe([
            '我对上面对话中的 2 处内容写了批注：',
            '',
            '1.',
            '> first line',
            '> second line',
            '批注: fix this',
            '',
            '2.',
            '> other',
            '批注: why?',
            '',
            'please revise',
        ].join('\n'));
    });

    it('works with comments only, marks stale ones, and is plain text without comments', () => {
        const en = composeAnnotatedMessage([list[1]], '', 'en', new Set(['b']));
        expect(en).toBe('My comment on 1 passage above:\n\n1. (the original has changed; this is the text as it was)\n> other\nComment: why?');
        expect(composeAnnotatedMessage([], ' hi ', 'en')).toBe('hi');
        expect(composeAnnotatedMessage([list[2]], 'hi', 'en')).toBe('hi');
    });

    it('keeps blank lines inside a quoted code excerpt as quote lines', () => {
        const msg = composeAnnotatedMessage([note({ excerpt: '```ts\na\n\nb\n```', body: 'x' })], '', 'en');
        expect(msg).toContain('> ```ts\n> a\n>\n> b\n> ```');
    });

    it('previews an excerpt on one line without fences', () => {
        expect(excerptPreview('```ts\nconst a = 1;\n  b()\n```')).toBe('const a = 1; b()');
        expect(excerptPreview('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    });
});

describe('parseChatAnnotations (storage sanitising, B-891)', () => {
    it('drops malformed, oversized and duplicate records and caps the count', () => {
        const good = note({});
        const raw = JSON.stringify([
            good,
            { ...good },                                  // duplicate id
            { ...good, id: 'x', start: -1 },              // bad offset
            { ...good, id: 'y', quote: '' },              // empty quote
            { ...good, id: 'z', prefix: 'p'.repeat(ANCHOR_CONTEXT + 1) },
            { ...good, id: 'w', body: 5 },
            null,
            ...Array.from({ length: 60 }, (_, i) => ({ ...good, id: `n${i}` })),
        ]);
        const parsed = parseChatAnnotations(raw);
        expect(parsed[0]).toEqual(good);
        expect(parsed.map((a) => a.id)).not.toContain('x');
        expect(parsed).toHaveLength(50);
        expect(parseChatAnnotations('{not json')).toEqual([]);
        expect(parseChatAnnotations('{"a":1}')).toEqual([]);
    });
});

describe('canAnnotateSession (B-891)', () => {
    const base = { id: 's', metadata: { flavor: 'claude' } } as unknown as Session;
    it('owner and driver/operator grantees may; viewers, mirrors and no session may not', () => {
        expect(canAnnotateSession(base)).toBe(true);
        expect(canAnnotateSession({ ...base, share: { role: 'driver' } } as unknown as Session)).toBe(true);
        expect(canAnnotateSession({ ...base, share: { role: 'driver', operate: true } } as unknown as Session)).toBe(true);
        expect(canAnnotateSession({ ...base, share: { role: 'viewer' } } as unknown as Session)).toBe(false);
        expect(canAnnotateSession({ ...base, metadata: { flavor: 'terminal-mirror' } } as unknown as Session)).toBe(false);
        expect(canAnnotateSession(null)).toBe(false);
    });
});
