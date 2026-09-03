import { describe, expect, it } from 'vitest';
import type { SessionStreamFrame } from '@slopus/happy-wire';
import { PROGRESS_FLUSH_MS, StreamRelay, STREAM_FLUSH_MAX_BYTES, STREAM_FLUSH_MS } from './streamRelay';

/** Deterministic clock + timer queue so coalescing windows are exact. */
function harness() {
    const sent: SessionStreamFrame[] = [];
    let now = 1_000;
    let nextId = 1;
    const timers = new Map<number, { fire: () => void; at: number }>();
    const relay = new StreamRelay({
        send: (frame) => sent.push(frame),
        setTimer: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { fire: fn, at: now + ms });
            return id;
        },
        clearTimer: (handle) => { timers.delete(handle as number); },
        now: () => now,
    });
    const advance = (ms: number) => {
        now += ms;
        for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
            if (timer.at <= now) {
                timers.delete(id);
                timer.fire();
            }
        }
    };
    return { relay, sent, advance, setNow: (value: number) => { now = value; } };
}

const messageStart = (id: string) => ({ type: 'stream_event' as const, event: { type: 'message_start', message: { id } } });
const blockStart = (index: number, type: 'text' | 'thinking' | 'tool_use') =>
    ({ type: 'stream_event' as const, event: { type: 'content_block_start', index, content_block: { type } } });
const textDelta = (index: number, text: string) =>
    ({ type: 'stream_event' as const, event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
const thinkingDelta = (index: number, thinking: string) =>
    ({ type: 'stream_event' as const, event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } });
const blockStop = (index: number) =>
    ({ type: 'stream_event' as const, event: { type: 'content_block_stop', index } });

describe('StreamRelay', () => {
    it('coalesces a burst of deltas into one frame per window', () => {
        const { relay, sent, advance } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'text'));
        for (const chunk of ['Hel', 'lo', ' wo', 'rld']) relay.ingest(textDelta(0, chunk));

        // Nothing but the lifecycle frame before the window closes: this is the
        // whole point — one socket event per 80ms, not per token.
        expect(sent).toEqual([{ t: 'block-start', mid: 'msg_1', idx: 0, kind: 'text' }]);

        advance(STREAM_FLUSH_MS);
        expect(sent[1]).toEqual({ t: 'block-delta', mid: 'msg_1', idx: 0, text: 'Hello world' });
        expect(sent).toHaveLength(2);
    });

    it('streams thinking deltas, not just text — the whole reason for the channel', () => {
        const { relay, sent, advance } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'thinking'));
        relay.ingest(thinkingDelta(0, 'Let me check '));
        relay.ingest(thinkingDelta(0, 'the config.'));
        advance(STREAM_FLUSH_MS);

        expect(sent).toEqual([
            { t: 'block-start', mid: 'msg_1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'msg_1', idx: 0, text: 'Let me check the config.' },
        ]);
    });

    it('flushes pending text BEFORE the block-end that follows it', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'text'));
        relay.ingest(textDelta(0, 'tail'));
        relay.ingest(blockStop(0));

        expect(sent.map((f) => f.t)).toEqual(['block-start', 'block-delta', 'block-end']);
        expect(sent[1]).toMatchObject({ text: 'tail' });
    });

    it('flushes the previous block before opening another', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'thinking'));
        relay.ingest(thinkingDelta(0, 'pondering'));
        relay.ingest(blockStart(1, 'text'));

        expect(sent.map((f) => f.t)).toEqual(['block-start', 'block-delta', 'block-start']);
        expect(sent[1]).toMatchObject({ idx: 0, text: 'pondering' });
    });

    it('ignores tool_use blocks (they already render as real tool cards)', () => {
        const { relay, sent, advance } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'tool_use'));
        relay.ingest({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } } });
        advance(STREAM_FLUSH_MS);

        expect(sent).toEqual([]);
    });

    it('drops deltas for a block it never saw start, and before any message_start', () => {
        const { relay, sent, advance } = harness();
        relay.ingest(textDelta(0, 'orphan'));
        relay.ingest(messageStart('msg_1'));
        relay.ingest(textDelta(7, 'unopened'));
        advance(STREAM_FLUSH_MS);

        expect(sent).toEqual([]);
    });

    it('closes blocks the SDK never stopped when a new message starts', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'thinking'));
        relay.ingest(messageStart('msg_2'));

        expect(sent).toEqual([
            { t: 'block-start', mid: 'msg_1', idx: 0, kind: 'thinking' },
            { t: 'block-end', mid: 'msg_1', idx: 0 },
        ]);
    });

    it('reports thinking tokens, output tokens and phase on the progress cadence', () => {
        const { relay, sent, advance } = harness();
        relay.ingest({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 128 });
        relay.ingest({ type: 'system', subtype: 'status', status: 'requesting' });
        relay.ingest({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 42 } } });

        expect(sent).toEqual([]);
        advance(PROGRESS_FLUSH_MS);
        expect(sent).toEqual([{ t: 'progress', thinkingTokens: 128, status: 'requesting', outputTokens: 42 }]);
    });

    it('clears a phase when the SDK reports status null instead of leaving it stuck', () => {
        const { relay, sent, advance } = harness();
        relay.ingest({ type: 'system', subtype: 'status', status: 'compacting' });
        advance(PROGRESS_FLUSH_MS);
        relay.ingest({ type: 'system', subtype: 'status', status: null });
        advance(PROGRESS_FLUSH_MS);

        expect(sent).toEqual([
            { t: 'progress', status: 'compacting' },
            { t: 'progress' },
        ]);
    });

    it('endTurn flushes everything, closes open blocks, then sweeps', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'text'));
        relay.ingest(textDelta(0, 'partial'));
        relay.ingest({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 });
        relay.endTurn();

        expect(sent.map((f) => f.t)).toEqual(['block-start', 'block-delta', 'block-end', 'progress', 'turn-end']);
    });

    it('never throws on malformed input', () => {
        const { relay, sent } = harness();
        expect(() => {
            relay.ingest({ type: 'stream_event', event: null });
            relay.ingest({ type: 'stream_event', event: { type: 'content_block_start' } });
            relay.ingest({ type: 'stream_event', event: { type: 'message_start', message: {} } });
            relay.ingest({ type: 'system', subtype: 'thinking_tokens' });
        }).not.toThrow();
        expect(sent).toEqual([]);
    });

    it('dispose drops pending work without emitting', () => {
        const { relay, sent, advance } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'text'));
        relay.ingest(textDelta(0, 'lost'));
        const before = sent.length;
        relay.dispose();
        advance(STREAM_FLUSH_MS * 4);

        expect(sent).toHaveLength(before);
    });
});

describe('StreamRelay turn sweep', () => {
    it('sweeps once even though both the result frame and the launcher finally call endTurn', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.endTurn();
        relay.endTurn();

        expect(sent.filter((f) => f.t === 'turn-end')).toHaveLength(1);
    });

    it('stays silent when a turn produced no stream activity at all', () => {
        const { relay, sent } = harness();
        relay.endTurn();

        expect(sent).toEqual([]);
    });

    it('sweeps again after a new turn starts streaming', () => {
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.endTurn();
        relay.ingest(messageStart('msg_2'));
        relay.endTurn();

        expect(sent.filter((f) => f.t === 'turn-end')).toHaveLength(2);
    });
});

describe('StreamRelay frame size', () => {
    it('flushes on ENCODED bytes, so multibyte text cannot build a frame the relay drops', () => {
        // The schema counts characters, the relay counts bytes. 3-byte CJK
        // would let a "valid" 32K-character frame encode past the 64KB relay
        // ceiling and be discarded server-side with no error anywhere.
        const { relay, sent } = harness();
        relay.ingest(messageStart('msg_1'));
        relay.ingest(blockStart(0, 'text'));

        const chunk = '中'.repeat(1024); // 3KB of UTF-8 per chunk
        for (let i = 0; i < 6; i += 1) relay.ingest(textDelta(0, chunk));

        const deltas = sent.filter((f) => f.t === 'block-delta');
        expect(deltas.length).toBeGreaterThan(0);
        for (const delta of deltas) {
            expect(Buffer.byteLength((delta as { text: string }).text, 'utf8'))
                .toBeLessThanOrEqual(STREAM_FLUSH_MAX_BYTES + Buffer.byteLength(chunk, 'utf8'));
        }
    });
});
