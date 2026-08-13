/**
 * asrStream unit tests (B-069): PCM pipeline pure functions and the realtime
 * WS protocol state machine against an injected fake socket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createDownsampler,
    floatToPcm16,
    pcm16ToBase64,
    createPcmPacker,
    buildAsrStreamUrl,
    createAsrSocket,
    ASR_TARGET_SAMPLE_RATE,
} from './asrStream';
import type { WsLike } from './ttsStream';

// ── PCM pipeline ────────────────────────────────────────────────────────────

describe('createDownsampler', () => {
    it('averages windows for an integer ratio (48k → 16k)', () => {
        const down = createDownsampler(48000, 16000);
        const out = down.push(new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6]));
        expect(out.length).toBe(2);
        expect(out[0]).toBeCloseTo(0.3, 5);
        expect(out[1]).toBeCloseTo(0.6, 5);
    });

    it('carries the remainder across pushes (no drift)', () => {
        const down = createDownsampler(48000, 16000);
        const a = down.push(new Float32Array([1, 1])); // 2 samples < ratio 3
        expect(a.length).toBe(0);
        const b = down.push(new Float32Array([1, 4, 4, 4])); // total 6 → 2 out
        expect(b.length).toBe(2);
        expect(b[0]).toBeCloseTo(1, 5);
        expect(b[1]).toBeCloseTo(4, 5);
    });

    it('handles non-integer ratios without losing long-run sample count', () => {
        const down = createDownsampler(44100, 16000);
        let total = 0;
        const pushes = 100;
        const perPush = 441; // 10ms at 44.1k
        for (let i = 0; i < pushes; i++) total += down.push(new Float32Array(perPush)).length;
        // 1s of input → ~16000 output samples (carry keeps it tight)
        expect(total).toBeGreaterThanOrEqual(15990);
        expect(total).toBeLessThanOrEqual(16000);
    });

    it('passes through when rates match', () => {
        const down = createDownsampler(16000, 16000);
        expect(Array.from(down.push(new Float32Array([0.5, -0.5])))).toEqual([0.5, -0.5]);
    });
});

describe('floatToPcm16', () => {
    it('scales and clamps', () => {
        const out = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
        expect(out[0]).toBe(0);
        expect(out[1]).toBe(0x7fff);
        expect(out[2]).toBe(-0x8000);
        expect(out[3]).toBe(0x7fff); // clamped
        expect(out[4]).toBe(-0x8000); // clamped
        expect(out[5]).toBe(Math.round(0.5 * 0x7fff));
    });
});

describe('pcm16ToBase64', () => {
    it('encodes little-endian bytes', () => {
        // 0x0102 → bytes [0x02, 0x01]; 0xFFFE(-2) → [0xFE, 0xFF]
        const b64 = pcm16ToBase64(new Int16Array([0x0102, -2]));
        const bin = atob(b64);
        expect([bin.charCodeAt(0), bin.charCodeAt(1), bin.charCodeAt(2), bin.charCodeAt(3)]).toEqual([
            0x02, 0x01, 0xfe, 0xff,
        ]);
    });
});

describe('createPcmPacker', () => {
    it('cuts fixed frames and flushes the tail', () => {
        const packer = createPcmPacker({ sourceRate: 16000, frameSamples: 4 });
        expect(packer.push(new Float32Array(3))).toEqual([]);
        const frames = packer.push(new Float32Array(6)); // 9 total → 2 frames + 1 tail
        expect(frames.length).toBe(2);
        expect(frames[0].length).toBe(4);
        const tail = packer.flush();
        expect(tail.length).toBe(1);
        expect(packer.flush().length).toBe(0);
    });

    it('downsamples on the way in', () => {
        const packer = createPcmPacker({ sourceRate: 48000, targetRate: 16000, frameSamples: 2 });
        const frames = packer.push(new Float32Array(6).fill(0.5)); // → 2 samples @16k → 1 frame
        expect(frames.length).toBe(1);
        expect(frames[0][0]).toBe(Math.round(0.5 * 0x7fff));
    });
});

// ── WS state machine ────────────────────────────────────────────────────────

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

describe('buildAsrStreamUrl', () => {
    it('carries model, token, pcm format and manual commit strategy', () => {
        const url = buildAsrStreamUrl('sutkn_a');
        expect(url).toContain('wss://api.elevenlabs.io/v1/speech-to-text/realtime?');
        expect(url).toContain('model_id=scribe_v2_realtime');
        expect(url).toContain('token=sutkn_a');
        expect(url).toContain('audio_format=pcm_16000');
        expect(url).toContain('commit_strategy=manual');
        expect(url).not.toContain('language_code');
    });

    it('adds language_code when a language hint is given, omits it for auto', () => {
        expect(buildAsrStreamUrl('t', 'zh')).toContain('language_code=zh');
        expect(buildAsrStreamUrl('t', null)).not.toContain('language_code');
    });
});

describe('createAsrSocket', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function make() {
        const ws = new FakeWs();
        const partials: string[] = [];
        const socket = createAsrSocket({
            token: 't',
            onPartial: (t) => partials.push(t),
            wsFactory: () => ws,
        });
        return { ws, socket, partials };
    }

    it('ready resolves true on open, false on close-before-open', async () => {
        const a = make();
        a.ws.onopen?.();
        await expect(a.socket.ready).resolves.toBe(true);

        const b = make();
        b.ws.onclose?.();
        await expect(b.socket.ready).resolves.toBe(false);
    });

    it('ready resolves false when the factory throws', async () => {
        const socket = createAsrSocket({
            token: 't',
            onPartial: () => {},
            wsFactory: () => {
                throw new Error('no ws');
            },
        });
        await expect(socket.ready).resolves.toBe(false);
        await expect(socket.commit(new Int16Array(0))).resolves.toBeNull();
    });

    it('sends audio frames as input_audio_chunk JSON with sample_rate', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        socket.sendAudio(new Int16Array([1, 2, 3]));
        expect(ws.sent).toHaveLength(1);
        const msg = JSON.parse(ws.sent[0]);
        expect(msg.message_type).toBe('input_audio_chunk');
        expect(msg.commit).toBe(false);
        expect(msg.sample_rate).toBe(ASR_TARGET_SAMPLE_RATE);
        expect(typeof msg.audio_base_64).toBe('string');
    });

    it('drops empty frames', () => {
        const { ws, socket } = make();
        ws.onopen?.();
        socket.sendAudio(new Int16Array(0));
        expect(ws.sent).toHaveLength(0);
    });

    it('forwards partial and final transcripts to onPartial', () => {
        const { ws, partials } = make();
        ws.onopen?.();
        ws.onmessage?.({ data: JSON.stringify({ message_type: 'partial_transcript', text: '你' }) });
        ws.onmessage?.({ data: JSON.stringify({ message_type: 'partial_transcript', text: '你好' }) });
        ws.onmessage?.({ data: JSON.stringify({ message_type: 'final_transcript', text: '你好。' }) });
        expect(partials).toEqual(['你', '你好', '你好。']);
    });

    it('commit sends the tail with commit:true and resolves on committed_transcript', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        const p = socket.commit(new Int16Array([5]));
        const msg = JSON.parse(ws.sent[0]);
        expect(msg.commit).toBe(true);
        ws.onmessage?.({ data: JSON.stringify({ message_type: 'committed_transcript', text: '你好世界' }) });
        await expect(p).resolves.toBe('你好世界');
        expect(ws.closed).toBe(true);
    });

    it('commit with an empty tail still sends a chunk (silence stand-in)', () => {
        const { ws, socket } = make();
        ws.onopen?.();
        void socket.commit(new Int16Array(0));
        const msg = JSON.parse(ws.sent[0]);
        expect(msg.commit).toBe(true);
        expect((msg.audio_base_64 as string).length).toBeGreaterThan(0);
    });

    it('accepts committed_transcript_with_timestamps as the final answer', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        const p = socket.commit(new Int16Array([5]));
        ws.onmessage?.({
            data: JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: 'hello', words: [] }),
        });
        await expect(p).resolves.toBe('hello');
    });

    it('server error messages fail the pending commit', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        const p = socket.commit(new Int16Array([5]));
        ws.onmessage?.({ data: JSON.stringify({ message_type: 'quota_exceeded', error: 'no quota' }) });
        await expect(p).resolves.toBeNull();
    });

    it('commit times out to null', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        const p = socket.commit(new Int16Array([5]));
        vi.advanceTimersByTime(9000);
        await expect(p).resolves.toBeNull();
        expect(ws.closed).toBe(true);
    });

    it('mid-session close fails the pending commit', async () => {
        const { ws, socket } = make();
        ws.onopen?.();
        const p = socket.commit(new Int16Array([5]));
        ws.onclose?.();
        await expect(p).resolves.toBeNull();
    });

    it('cancel closes the socket and later sends are no-ops', () => {
        const { ws, socket } = make();
        ws.onopen?.();
        socket.cancel();
        expect(ws.closed).toBe(true);
        socket.sendAudio(new Int16Array([1]));
        expect(ws.sent).toHaveLength(0);
    });
});
