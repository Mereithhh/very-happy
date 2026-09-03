import { describe, it, expect } from 'vitest';
import {
    createOutputCoalescer,
    OUTPUT_COALESCE_MAX_BYTES,
    OUTPUT_COALESCE_MS,
} from './outputCoalescer';

const b = (s: string) => Buffer.from(s, 'ascii');
const opts = { maxDelayMs: 16, maxBytes: 64 };

describe('outputCoalescer', () => {
    it('sends the first chunk after an idle window immediately', () => {
        const c = createOutputCoalescer(opts);
        expect(c.push(b('x'), 1000)?.toString()).toBe('x');
        expect(c.pendingBytes()).toBe(0);
        expect(c.dueAt()).toBeNull();
    });

    it('keeps interactive echo at zero added latency', () => {
        const c = createOutputCoalescer(opts);
        // Typing at ~30 keys/s: every chunk lands more than a window after the
        // previous emit, so none of them is ever buffered.
        for (let t = 0; t < 10; t += 1) {
            expect(c.push(b('k'), 1000 + t * 33)?.toString()).toBe('k');
        }
        expect(c.pendingBytes()).toBe(0);
    });

    it('merges a burst into one byte-identical frame', () => {
        const c = createOutputCoalescer(opts);
        expect(c.push(b('a'), 1000)?.toString()).toBe('a'); // idle → immediate
        expect(c.push(b('b'), 1002)).toBeNull();
        expect(c.push(b('c'), 1004)).toBeNull();
        expect(c.dueAt()).toBe(1002 + 16);
        expect(c.flush(1018)?.toString()).toBe('bc');
        expect(c.pendingBytes()).toBe(0);
        expect(c.dueAt()).toBeNull();
    });

    it('never reorders or drops: the merged stream equals plain concatenation', () => {
        const c = createOutputCoalescer(opts);
        const source = ['\x1b[', '2', 'J', '\x1b[H', 'hello', ' ', 'world'];
        const out: Buffer[] = [];
        source.forEach((part, i) => {
            const ready = c.push(b(part), 1000 + i); // 1ms apart ⇒ one burst
            if (ready) out.push(ready);
        });
        const tail = c.flush(2000);
        if (tail) out.push(tail);
        expect(Buffer.concat(out).toString()).toBe(source.join(''));
    });

    it('bounds every byte by one window, not by the last emit', () => {
        const c = createOutputCoalescer(opts);
        c.push(b('a'), 1000);          // immediate
        c.push(b('b'), 1001);          // buffered, due 1017
        c.push(b('c'), 1015);          // still the same window
        // A chunk arriving late in the window must not push the deadline out.
        expect(c.dueAt()).toBe(1017);
    });

    it('flushes early once the byte cap is reached', () => {
        const c = createOutputCoalescer({ maxDelayMs: 16, maxBytes: 4 });
        c.push(b('a'), 1000);                       // immediate
        expect(c.push(b('bb'), 1001)).toBeNull();
        const ready = c.push(b('cc'), 1002);        // 2 + 2 >= 4
        expect(ready?.toString()).toBe('bbcc');
        expect(c.pendingBytes()).toBe(0);
    });

    it('ignores empty chunks so they can never take a seq', () => {
        const c = createOutputCoalescer(opts);
        expect(c.push(Buffer.alloc(0), 1000)).toBeNull();
        expect(c.pendingBytes()).toBe(0);
        expect(c.dueAt()).toBeNull();
        // and the real first chunk still counts as idle-immediate
        expect(c.push(b('x'), 1001)?.toString()).toBe('x');
    });

    it('flush on an empty buffer is a no-op', () => {
        const c = createOutputCoalescer(opts);
        expect(c.flush(1000)).toBeNull();
    });

    it('a flush restarts the idle clock, so the next chunk waits at most one window', () => {
        const c = createOutputCoalescer(opts);
        c.push(b('a'), 1000);
        c.push(b('b'), 1001);
        expect(c.flush(1017)?.toString()).toBe('b');
        // Right after a flush we are inside the window → buffered, but bounded.
        expect(c.push(b('c'), 1018)).toBeNull();
        expect(c.dueAt()).toBe(1018 + 16);
        // Past the window → immediate again.
        expect(c.flush(1034)?.toString()).toBe('c');
        expect(c.push(b('d'), 1060)?.toString()).toBe('d');
    });

    it('collapses a measured pi-style startup burst by an order of magnitude', () => {
        // Shape taken from the 2026-09-03 measurement: 1029 chunks, median 9B,
        // spread over 712ms (≈0.7ms apart). See the module header.
        const c = createOutputCoalescer({ maxDelayMs: OUTPUT_COALESCE_MS, maxBytes: OUTPUT_COALESCE_MAX_BYTES });
        const chunk = b('x'.repeat(9));
        const frames: Buffer[] = [];
        for (let i = 0; i < 1029; i += 1) {
            const now = 1000 + Math.round(i * 0.692);
            const ready = c.push(chunk, now);
            if (ready) frames.push(ready);
            const due = c.dueAt();
            if (due !== null && due <= now) {
                const late = c.flush(now);
                if (late) frames.push(late);
            }
        }
        const tail = c.flush(2000);
        if (tail) frames.push(tail);
        expect(Buffer.concat(frames).length).toBe(1029 * 9);
        expect(frames.length).toBeLessThan(60);
        expect(frames.length).toBeGreaterThan(30);
    });

    it('defaults to one 60Hz frame and a 64KB cap', () => {
        expect(OUTPUT_COALESCE_MS).toBe(16);
        expect(OUTPUT_COALESCE_MAX_BYTES).toBe(64 * 1024);
        const c = createOutputCoalescer();
        c.push(b('a'), 1000);
        c.push(b('b'), 1001);
        expect(c.dueAt()).toBe(1001 + OUTPUT_COALESCE_MS);
    });
});
