/**
 * ttsStream unit tests (B-069): sentence splitter, per-sentence chunk
 * assembler, and the WS client state machine against an injected fake socket.
 */
import { describe, it, expect } from 'vitest';
import {
    splitIntoSentences,
    assemblerFeed,
    assemblerFinish,
    assemblerInitial,
    base64ToBytes,
    buildTtsStreamUrl,
    startTtsStream,
    type WsLike,
} from './ttsStream';

// ── splitIntoSentences ──────────────────────────────────────────────────────

describe('splitIntoSentences', () => {
    it('splits on CJK enders', () => {
        expect(splitIntoSentences('今天天气很好，适合出门活动。我们一起去公园散步好吗！走吧现在就出发出发！')).toEqual([
            '今天天气很好，适合出门活动。',
            '我们一起去公园散步好吗！',
            '走吧现在就出发出发！',
        ]);
    });

    it('splits on latin enders', () => {
        expect(
            splitIntoSentences('This is the first sentence. And here is the second one! A third?'),
        ).toEqual(['This is the first sentence.', 'And here is the second one!', 'A third?']);
    });

    it('does not split decimal numbers or version strings', () => {
        expect(splitIntoSentences('圆周率约等于 3.14159，模型版本是 v2.5,大家记住了吗？')).toEqual([
            '圆周率约等于 3.14159，模型版本是 v2.5,大家记住了吗？',
        ]);
    });

    it('merges short sentences into the next one (minChars)', () => {
        expect(splitIntoSentences('好的。我现在就去把那个部署脚本跑起来。')).toEqual([
            '好的。我现在就去把那个部署脚本跑起来。',
        ]);
    });

    it('keeps a trailing short remainder as its own chunk', () => {
        const out = splitIntoSentences('这是一个足够长的完整句子，没有问题。收到。');
        expect(out).toEqual(['这是一个足够长的完整句子，没有问题。', '收到。']);
    });

    it('carries trailing closing quotes with the sentence', () => {
        expect(splitIntoSentences('他说：「明白了，我马上开始处理这个任务。」然后就挂了电话哦。')).toEqual([
            '他说：「明白了，我马上开始处理这个任务。」',
            '然后就挂了电话哦。',
        ]);
    });

    it('hard-splits punctuation-less runs at maxChars', () => {
        const run = '字'.repeat(25);
        expect(splitIntoSentences(run, { maxChars: 10 })).toEqual([
            '字'.repeat(10),
            '字'.repeat(10),
            '字'.repeat(5),
        ]);
    });

    it('splits on newlines', () => {
        expect(splitIntoSentences('第一行是完整独立的一句话\n第二行也是完整独立的一句话')).toEqual([
            '第一行是完整独立的一句话',
            '第二行也是完整独立的一句话',
        ]);
    });

    it('drops whitespace-only input', () => {
        expect(splitIntoSentences('   \n  ')).toEqual([]);
        expect(splitIntoSentences('')).toEqual([]);
    });
});

// ── assembler ───────────────────────────────────────────────────────────────

const bytes = (...v: number[]) => new Uint8Array(v);

describe('assembler', () => {
    // sentences of sent-length 5 and 4 → cumulative ends [5, 9]
    const ends = [5, 9];

    it('completes a sentence when aligned chars reach its end', () => {
        const a = assemblerFeed(assemblerInitial, ends, { audio: bytes(1, 2), alignedChars: 3 });
        expect(a.completed).toEqual([]);
        const b = assemblerFeed(a.state, ends, { audio: bytes(3), alignedChars: 2 });
        expect(b.completed).toHaveLength(1);
        expect(b.completed[0].index).toBe(0);
        expect(Array.from(b.completed[0].audio)).toEqual([1, 2, 3]);
    });

    it('one chunk can complete multiple short sentences', () => {
        const a = assemblerFeed(assemblerInitial, ends, { audio: bytes(9), alignedChars: 9 });
        expect(a.completed.map((c) => c.index)).toEqual([0, 1]);
        expect(Array.from(a.completed[0].audio)).toEqual([9]);
        expect(Array.from(a.completed[1].audio)).toEqual([]);
    });

    it('without alignment (0 chars) nothing completes until finish', () => {
        const a = assemblerFeed(assemblerInitial, ends, { audio: bytes(1), alignedChars: 0 });
        const b = assemblerFeed(a.state, ends, { audio: bytes(2), alignedChars: 0 });
        expect(a.completed).toEqual([]);
        expect(b.completed).toEqual([]);
        const done = assemblerFinish(b.state, 2);
        expect(done).toHaveLength(1);
        expect(done[0].index).toBe(0);
        expect(Array.from(done[0].audio)).toEqual([1, 2]);
    });

    it('finish with nothing pending yields nothing', () => {
        expect(assemblerFinish(assemblerInitial, 2)).toEqual([]);
    });
});

describe('base64ToBytes', () => {
    it('decodes base64', () => {
        // "abc" = YWJj
        expect(Array.from(base64ToBytes('YWJj'))).toEqual([97, 98, 99]);
    });
});

// ── WS client ───────────────────────────────────────────────────────────────

function toB64(...v: number[]): string {
    return btoa(String.fromCharCode(...v));
}

class FakeWs implements WsLike {
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(data: string) {
        this.sent.push(data);
    }
    close() {
        this.closed = true;
    }
}

describe('buildTtsStreamUrl', () => {
    it('puts the single-use token and model into the query', () => {
        const url = buildTtsStreamUrl({ voiceId: 'v1', modelId: 'm1', token: 'sutkn_x' });
        expect(url).toContain('wss://api.elevenlabs.io/v1/text-to-speech/v1/stream-input?');
        expect(url).toContain('single_use_token=sutkn_x');
        expect(url).toContain('model_id=m1');
    });
});

describe('startTtsStream', () => {
    function start(sentences: string[]) {
        const ws = new FakeWs();
        const handle = startTtsStream({
            token: 'sutkn_t',
            sentences,
            wsFactory: () => ws,
        });
        return { ws, handle };
    }

    it('sends init, one flushed message per sentence, then the close message', () => {
        const { ws } = start(['你好世界。', 'Second one.']);
        ws.onopen?.();
        expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
            { text: ' ' },
            { text: '你好世界。 ', flush: true },
            { text: 'Second one. ', flush: true },
            { text: '' },
        ]);
    });

    it('resolves per-sentence audio using alignment counts', async () => {
        const { ws, handle } = start(['abcd。', 'efg。']); // sent lengths 6 and 5 → ends [6, 11]
        ws.onopen?.();
        ws.onmessage?.({
            data: JSON.stringify({ audio: toB64(1, 2), alignment: { chars: new Array(6).fill('x') } }),
        });
        expect(Array.from((await handle.sentenceAudio[0])!)).toEqual([1, 2]);
        ws.onmessage?.({
            data: JSON.stringify({ audio: toB64(3), alignment: { chars: new Array(5).fill('x') } }),
        });
        ws.onmessage?.({ data: JSON.stringify({ isFinal: true }) });
        expect(Array.from((await handle.sentenceAudio[1])!)).toEqual([3]);
        expect(await handle.outcome).toEqual({ kind: 'complete' });
        expect(ws.closed).toBe(true);
    });

    it('without alignment, all audio lands on sentence 0 at isFinal and the rest resolve EMPTY (not null)', async () => {
        const { ws, handle } = start(['abcd。', 'efg。']);
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ audio: toB64(1) }) });
        ws.onmessage?.({ data: JSON.stringify({ audio: toB64(2) }) });
        ws.onmessage?.({ data: JSON.stringify({ isFinal: true }) });
        expect(Array.from((await handle.sentenceAudio[0])!)).toEqual([1, 2]);
        const second = await handle.sentenceAudio[1];
        expect(second).not.toBeNull();
        expect(second!.length).toBe(0);
        expect(await handle.outcome).toEqual({ kind: 'complete' });
    });

    it('socket error resolves undelivered sentences to null and reports failed', async () => {
        const { ws, handle } = start(['abcd。', 'efg。']);
        ws.onopen?.();
        ws.onmessage?.({
            data: JSON.stringify({ audio: toB64(7), alignment: { chars: new Array(6).fill('x') } }),
        });
        ws.onerror?.();
        expect(Array.from((await handle.sentenceAudio[0])!)).toEqual([7]);
        expect(await handle.sentenceAudio[1]).toBeNull();
        expect(await handle.outcome).toEqual({ kind: 'failed', failedAt: 1 });
    });

    it('abort() resolves everything to null and closes the socket', async () => {
        const { ws, handle } = start(['abcd。']);
        ws.onopen?.();
        handle.abort();
        expect(await handle.sentenceAudio[0]).toBeNull();
        expect(await handle.outcome).toEqual({ kind: 'aborted' });
        expect(ws.closed).toBe(true);
    });

    it('a clean close without isFinal still flushes pending audio', async () => {
        const { ws, handle } = start(['abcd。']);
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ audio: toB64(5) }) });
        ws.onclose?.();
        expect(Array.from((await handle.sentenceAudio[0])!)).toEqual([5]);
        expect(await handle.outcome).toEqual({ kind: 'complete' });
    });

    it('a throwing factory fails without throwing to the caller', async () => {
        const handle = startTtsStream({
            token: 't',
            sentences: ['abcd。'],
            wsFactory: () => {
                throw new Error('no ws');
            },
        });
        expect(await handle.sentenceAudio[0]).toBeNull();
        expect(await handle.outcome).toEqual({ kind: 'failed', failedAt: 0 });
    });

    it('ignores garbage messages', async () => {
        const { ws, handle } = start(['abcd。']);
        ws.onopen?.();
        ws.onmessage?.({ data: 'not json' });
        ws.onmessage?.({ data: JSON.stringify({ audio: 42 }) });
        ws.onmessage?.({ data: JSON.stringify({ audio: toB64(1), alignment: { chars: new Array(6).fill('x') } }) });
        ws.onmessage?.({ data: JSON.stringify({ isFinal: true }) });
        expect(Array.from((await handle.sentenceAudio[0])!)).toEqual([1]);
        expect(await handle.outcome).toEqual({ kind: 'complete' });
    });
});
