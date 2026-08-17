/**
 * ControlModeDecoder tests — B-121 Phase 0a.
 *
 * Two halves:
 *
 *  1. **Golden replay** over the real recordings in `__fixtures__/controlmode`
 *     (recorded by `scripts/probe/tmux-control-golden.mjs` against an isolated
 *     `tmux -L b121-p0a` server). Each fixture is replayed whole, one byte at a
 *     time, and at deterministic pseudo-random split points; all three must
 *     produce an identical event summary, and that summary must match the
 *     committed `.expected.json`. The `.truth.json` assertions (bytes actually
 *     fed into the pane, markers, greeting shape…) are re-checked here with the
 *     same checker the recorder uses, so the goldens can never rot into
 *     "whatever the decoder happens to do today".
 *
 *  2. **Branch coverage** on hand-built streams: octal boundaries, backslash,
 *     malformed escapes, unknown notifications, error blocks, look-alike
 *     terminators inside a block body, over-long lines, and the protocol-error
 *     paths.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ControlModeDecoder,
    unescapeOctal,
    type ControlModeBlockEvent,
    type ControlModeEvent,
    type ControlModeOutputEvent,
} from '@/terminal/controlModeDecoder';

// The recorder owns the summary + independent-truth checkers; importing them
// keeps exactly one implementation of "what a golden means".
// @ts-expect-error -- plain .mjs probe script, no types
import { checkTruth, summarize } from '../../../../scripts/probe/tmux-control-golden.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__', 'controlmode');

/** Deterministic 32-bit LCG — reproducible "random" split points. */
function* splits(seed: number, total: number, maxStep: number): Generator<number> {
    let s = seed >>> 0;
    let at = 0;
    while (at < total) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const step = 1 + (s % maxStep);
        at += step;
        yield Math.min(step, total);
    }
}

function feed(stream: Buffer, chunkSizes: number[] | null): ControlModeEvent[] {
    const dec = new ControlModeDecoder();
    const events: ControlModeEvent[] = [];
    let i = 0;
    let k = 0;
    while (i < stream.length) {
        const size = chunkSizes ? chunkSizes[k++ % chunkSizes.length]! : stream.length;
        events.push(...dec.push(stream.subarray(i, Math.min(stream.length, i + size))));
        i += size;
    }
    events.push(...dec.flush());
    return events;
}

/** Concatenated decoded output of every pane, in stream order. */
function outputBytes(events: ControlModeEvent[]): Buffer {
    return Buffer.concat(events.filter((e): e is ControlModeOutputEvent => e.type === 'output').map((e) => e.data));
}

function blocks(events: ControlModeEvent[]): ControlModeBlockEvent[] {
    return events.filter((e): e is ControlModeBlockEvent => e.type === 'block');
}

/** Chunk-boundary-independent view of a run (output events may split differently). */
function stable(events: ControlModeEvent[]) {
    return {
        output: outputBytes(events).toString('base64'),
        panes: events
            .filter((e): e is ControlModeOutputEvent => e.type === 'output')
            .map((e) => `${e.pane}:${e.data.length}`)
            .join(''),
        rest: events
            .filter((e) => e.type !== 'output')
            .map((e) => JSON.stringify(e, (_k, v) => (v?.type === 'Buffer' ? Buffer.from(v.data).toString('base64') : v)))
            .join('\n'),
    };
}

// ── 1. golden replay ────────────────────────────────────────────────────────

const scenarios = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.truth.json'))
    .map((f) => f.replace('.truth.json', ''))
    .sort();

describe('golden samples', () => {
    it('there are goldens to replay', () => {
        expect(scenarios.length).toBeGreaterThanOrEqual(6);
    });

    for (const name of scenarios) {
        describe(name, () => {
            const stream = readFileSync(join(FIXTURES, `${name}.bin`));
            const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8'));
            const truth = JSON.parse(readFileSync(join(FIXTURES, `${name}.truth.json`), 'utf8'));

            it('matches the committed expectation when fed whole', () => {
                const result = summarize(ControlModeDecoder, stream, null);
                expect({ scenario: name, streamBytes: stream.length, streamSha256: truth.streamSha256, ...result.summary })
                    .toEqual(expected);
            });

            it('satisfies the decoder-independent truth assertions', () => {
                const result = summarize(ControlModeDecoder, stream, null);
                expect(() => checkTruth(truth, result, FIXTURES)).not.toThrow();
            });

            it('is byte-split invariant (whole / 1-byte / seeded random)', () => {
                const whole = stable(feed(stream, null));
                expect(stable(feed(stream, [1]))).toEqual(whole);
                expect(stable(feed(stream, [7]))).toEqual(whole);
                expect(stable(feed(stream, [4096]))).toEqual(whole);
                for (const seed of [1, 42, 1337, 90210]) {
                    const sizes = [...splits(seed, stream.length, 37)];
                    expect(stable(feed(stream, sizes)), `seed ${seed}`).toEqual(whole);
                }
            });

            it('ends cleanly: no protocol errors, no dangling state', () => {
                const dec = new ControlModeDecoder();
                const events = [...dec.push(stream), ...dec.flush()];
                expect(events.filter((e) => e.type === 'protocol-error')).toEqual([]);
                expect(dec.inBlock).toBe(false);
                expect(dec.pendingBytes).toBe(0);
            });

            it('block bodies are exact (no truncation)', () => {
                expect(blocks(feed(stream, null)).some((b) => b.truncated)).toBe(false);
            });
        });
    }
});

describe('golden: cross-scenario invariants', () => {
    it('the attach greeting is an unsolicited empty first block everywhere', () => {
        for (const name of scenarios) {
            const evs = feed(readFileSync(join(FIXTURES, `${name}.bin`)), null);
            const first = blocks(evs)[0]!;
            expect(first.solicited, name).toBe(false);
            expect(first.flags & 1, name).toBe(0);
            expect(first.body.length, name).toBe(0);
        }
    });

    it('commands golden: exact-match pairing keeps a look-alike %end inside the body', () => {
        const evs = feed(readFileSync(join(FIXTURES, 'commands.bin')), null);
        const faked = blocks(evs).find((b) => b.body.includes('%end 1 2 3'));
        expect(faked).toBeDefined();
        expect(faked!.body.toString('utf8')).toContain('after');
        expect(faked!.error).toBe(false);
    });

    it('commands golden: a bogus command yields an %error block', () => {
        const evs = feed(readFileSync(join(FIXTURES, 'commands.bin')), null);
        const err = blocks(evs).find((b) => b.error);
        expect(err).toBeDefined();
        expect(err!.solicited).toBe(true);
        expect(err!.body.toString('utf8')).toContain('unknown command');
    });

    it('commands golden: block bodies carry RAW ESC (unlike %output payloads)', () => {
        const evs = feed(readFileSync(join(FIXTURES, 'commands.bin')), null);
        expect(blocks(evs).some((b) => b.body.includes(0x1b))).toBe(true);
    });

    it('altscreen golden: 1049h/1049l survive as raw bytes', () => {
        const out = outputBytes(feed(readFileSync(join(FIXTURES, 'altscreen.bin')), null));
        expect(out.includes(Buffer.from('\x1b[?1049h'))).toBe(true);
        expect(out.includes(Buffer.from('\x1b[?1049l'))).toBe(true);
    });

    it('binary golden: the 2048 urandom bytes come back byte-identical', () => {
        const embedded = readFileSync(join(FIXTURES, 'binary.embedded.bin'));
        const out = outputBytes(feed(readFileSync(join(FIXTURES, 'binary.bin')), null));
        expect(out.includes(embedded)).toBe(true);
    });

    it('cjk golden: multi-byte UTF-8 survives even when tmux splits it across %output lines', () => {
        const embedded = readFileSync(join(FIXTURES, 'cjk.embedded.bin'));
        const out = outputBytes(feed(readFileSync(join(FIXTURES, 'cjk.bin')), null));
        expect(out.includes(embedded)).toBe(true);
    });
});

// ── 2. branch coverage on hand-built streams ────────────────────────────────

const S = (s: string) => Buffer.from(s, 'latin1');

/** Every 2-way split of a stream must yield the same result as feeding it whole. */
function expectSplitInvariant(stream: Buffer) {
    const whole = stable(feed(stream, null));
    for (let cut = 0; cut <= stream.length; cut++) {
        const dec = new ControlModeDecoder();
        const events = [
            ...dec.push(stream.subarray(0, cut)),
            ...dec.push(stream.subarray(cut)),
            ...dec.flush(),
        ];
        expect(stable(events), `cut at ${cut}`).toEqual(whole);
    }
}

describe('%output octal unescaping', () => {
    it('decodes the full escapable range and leaves >=0x80 alone', () => {
        // tmux escapes exactly `byte < 0x20 || byte == 0x5c`.
        const escaped = Array.from({ length: 0x20 }, (_, i) => `\\${i.toString(8).padStart(3, '0')}`).join('');
        const evs = feed(S(`%output %0 ${escaped}\\134\xe4\xb8\xad\xff\n`), null);
        const out = outputBytes(evs);
        expect(out).toEqual(Buffer.concat([
            Buffer.from(Array.from({ length: 0x20 }, (_, i) => i)),
            Buffer.from([0x5c, 0xe4, 0xb8, 0xad, 0xff]),
        ]));
    });

    it('handles the \\000 and \\377 boundaries', () => {
        expect(outputBytes(feed(S('%output %0 \\000\\377\n'), null))).toEqual(Buffer.from([0x00, 0xff]));
    });

    it('survives a cut anywhere inside an escape', () => {
        expectSplitInvariant(S('%output %0 a\\015\\012b\\134c\n%output %0 tail\n'));
    });

    it('recovers a malformed short escape without losing bytes', () => {
        expect(outputBytes(feed(S('%output %0 a\\12xb\n'), null))).toEqual(Buffer.from('a\\12xb'));
        expect(outputBytes(feed(S('%output %0 a\\9b\n'), null))).toEqual(Buffer.from('a\\9b'));
    });

    it('recovers a dangling escape at end of line and end of stream', () => {
        expect(outputBytes(feed(S('%output %0 ab\\01\n'), null))).toEqual(Buffer.from('ab\\01'));
        const dec = new ControlModeDecoder();
        const evs = [...dec.push(S('%output %0 ab\\0')), ...dec.flush()];
        expect(outputBytes(evs)).toEqual(Buffer.from('ab\\0'));
        expect(evs.some((e) => e.type === 'protocol-error' && e.reason === 'unterminated-line')).toBe(true);
    });

    it('an empty payload emits nothing (but does not wedge the parser)', () => {
        const evs = feed(S('%output %0 \n%output %0 x\n'), null);
        expect(outputBytes(evs)).toEqual(Buffer.from('x'));
    });

    it('routes per pane id', () => {
        const evs = feed(S('%output %0 aa\n%output %13 bb\n'), null);
        const outs = evs.filter((e): e is ControlModeOutputEvent => e.type === 'output');
        expect(outs.map((e) => [e.pane, e.data.toString()])).toEqual([['%0', 'aa'], ['%13', 'bb']]);
    });

    it('decodes %extended-output and carries the age', () => {
        const evs = feed(S('%extended-output %2 4321 : hi\\012\n'), null);
        const out = evs.find((e): e is ControlModeOutputEvent => e.type === 'output')!;
        expect(out.pane).toBe('%2');
        expect(out.age).toBe(4321);
        expect(out.data).toEqual(Buffer.from('hi\n'));
        expectSplitInvariant(S('%extended-output %2 4321 : hi\\012\n'));
    });
});

describe('over-long %output lines', () => {
    it('splits into consecutive chunks without losing or reordering a byte', () => {
        const payload = 'abcdefghij'.repeat(1000); // 10 000 bytes
        const dec = new ControlModeDecoder({ maxOutputChunkBytes: 64 });
        const evs = [...dec.push(S(`%output %0 ${payload}\n`)), ...dec.flush()];
        const outs = evs.filter((e): e is ControlModeOutputEvent => e.type === 'output');
        expect(outs.length).toBe(Math.ceil(payload.length / 64));
        expect(outs.every((e) => e.pane === '%0')).toBe(true);
        expect(Buffer.concat(outs.map((e) => e.data)).toString()).toBe(payload);
    });

    it('never splits in the middle of a decoded escape', () => {
        // 4 escapes per 1-byte-of-output; a chunk cap of 1 forces a flush after
        // every decoded byte, which is the worst case for escape carry.
        const dec = new ControlModeDecoder({ maxOutputChunkBytes: 1 });
        const evs = [...dec.push(S('%output %0 \\033\\133\\063\\061\\155\n')), ...dec.flush()];
        expect(Buffer.concat(evs.filter((e): e is ControlModeOutputEvent => e.type === 'output').map((e) => e.data)))
            .toEqual(Buffer.from('\x1b[31m'));
    });

    it('a giant line arriving in tiny chunks still yields the exact payload', () => {
        const payload = Buffer.from(Array.from({ length: 20000 }, (_, i) => (i * 7) % 256));
        const escaped = Array.from(payload)
            .map((b) => (b < 0x20 || b === 0x5c ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)))
            .join('');
        const stream = S(`%output %0 ${escaped}\n`);
        const dec = new ControlModeDecoder({ maxOutputChunkBytes: 97 });
        const evs: ControlModeEvent[] = [];
        for (let i = 0; i < stream.length; i += 13) evs.push(...dec.push(stream.subarray(i, i + 13)));
        evs.push(...dec.flush());
        expect(outputBytes(evs)).toEqual(payload);
    });
});

describe('%begin/%end blocks', () => {
    it('pairs on exact (epoch, cmdNum) and keeps look-alike guards as body', () => {
        const evs = feed(S('%begin 100 7 1\nbefore\n%end 100 8 1\n%end 99 7 1\nafter\n%end 100 7 1\n'), null);
        const b = blocks(evs);
        expect(b.length).toBe(1);
        expect(b[0]!.body.toString()).toBe('before\n%end 100 8 1\n%end 99 7 1\nafter\n');
        expect(b[0]!.error).toBe(false);
    });

    it('flags bit 0 = solicited (greeting and hook blocks are 0)', () => {
        const evs = feed(S('%begin 1 2 0\n%end 1 2 0\n%begin 1 3 1\nx\n%end 1 3 1\n'), null);
        const b = blocks(evs);
        expect(b.map((x) => [x.flags, x.solicited, x.body.length])).toEqual([[0, false, 0], [1, true, 2]]);
    });

    it('%error closes the block and is reported as an error', () => {
        const evs = feed(S('%begin 5 6 1\nparse error: nope\n%error 5 6 1\n'), null);
        expect(blocks(evs)[0]).toMatchObject({ error: true, solicited: true });
        expect(blocks(evs)[0]!.body.toString()).toBe('parse error: nope\n');
    });

    it('carries raw bytes verbatim, ESC and backslash included', () => {
        const evs = feed(S('%begin 1 1 1\n\x1b[31mRED\x1b[0m a\\134b\n%end 1 1 1\n'), null);
        expect(blocks(evs)[0]!.body).toEqual(Buffer.from('\x1b[31mRED\x1b[0m a\\134b\n', 'latin1'));
    });

    it('is split invariant across the whole block', () => {
        expectSplitInvariant(S('%begin 100 7 1\nline1\n%end 100 8 1\n%end 100 7 1\n%output %0 z\n'));
    });

    it('truncates at a LINE boundary when maxBlockBytes is exceeded', () => {
        const dec = new ControlModeDecoder({ maxBlockBytes: 12 });
        const evs = [...dec.push(S('%begin 1 1 1\naaaa\nbbbb\ncccccccccc\ndddd\n%end 1 1 1\n')), ...dec.flush()];
        const b = blocks(evs)[0]!;
        expect(b.truncated).toBe(true);
        expect(b.body.toString()).toBe('aaaa\nbbbb\n'); // whole lines only, never a partial one
    });

    it('an unterminated block at EOF is reported, not swallowed', () => {
        const dec = new ControlModeDecoder();
        const evs = [...dec.push(S('%begin 1 1 1\nhalf\n')), ...dec.flush()];
        expect(blocks(evs)).toEqual([]);
        expect(evs.some((e) => e.type === 'protocol-error' && e.reason === 'unterminated-block')).toBe(true);
    });
});

describe('notifications and malformed input', () => {
    it('reports any notification generically, unknown ones included', () => {
        const evs = feed(S('%layout-change @0 abc,80x24 *\n%exit\n%future-thing a b c\n%pause %3\n'), null);
        expect(evs.filter((e) => e.type === 'notification')).toEqual([
            { type: 'notification', name: 'layout-change', args: '@0 abc,80x24 *' },
            { type: 'notification', name: 'exit', args: '' },
            { type: 'notification', name: 'future-thing', args: 'a b c' },
            { type: 'notification', name: 'pause', args: '%3' },
        ]);
    });

    it('an unknown notification does not swallow what follows', () => {
        const evs = feed(S('%totally-new x\n%output %0 still-here\n'), null);
        expect(outputBytes(evs).toString()).toBe('still-here');
    });

    it('flags a stray %end and keeps parsing', () => {
        const evs = feed(S('%end 1 2 3\n%output %0 ok\n'), null);
        expect(evs.filter((e) => e.type === 'protocol-error').map((e) => e.reason)).toEqual(['stray-end']);
        expect(outputBytes(evs).toString()).toBe('ok');
    });

    it('flags a %begin with non-numeric args and keeps parsing', () => {
        const evs = feed(S('%begin nope\n%output %0 ok\n'), null);
        expect(evs.filter((e) => e.type === 'protocol-error').map((e) => e.reason)).toEqual(['bad-begin']);
        expect(outputBytes(evs).toString()).toBe('ok');
    });

    it('flags a non-% line outside a block and keeps parsing', () => {
        const evs = feed(S('garbage line\n%output %0 ok\n'), null);
        expect(evs.filter((e) => e.type === 'protocol-error').map((e) => e.reason)).toEqual(['stray-line']);
        expect(outputBytes(evs).toString()).toBe('ok');
    });

    it('tolerates CRLF line endings on control lines and payloads', () => {
        const stream = S('%begin 1 2 1\r\nbody\r\n%end 1 2 1\r\n%output %0 a\\015b\r\n');
        const evs = feed(stream, null);
        expect(blocks(evs).length).toBe(1);
        // A raw CR inside a %output payload can only arrive escaped (\015), so a
        // trailing raw CR is a line terminator, never payload.
        expect(outputBytes(evs)).toEqual(Buffer.from('a\rb'));
        // …including when the chunk boundary falls between the CR and the LF.
        expectSplitInvariant(stream);
    });

    it('resyncs after an absurdly long line instead of growing without bound', () => {
        const dec = new ControlModeDecoder({ maxLineBytes: 64 });
        const evs = [
            ...dec.push(S(`%weird ${'x'.repeat(500)}`)),
            ...dec.push(S('\n%output %0 back\n')),
            ...dec.flush(),
        ];
        expect(evs.some((e) => e.type === 'protocol-error' && e.reason === 'line-too-long')).toBe(true);
        expect(outputBytes(evs).toString()).toBe('back');
    });

    it('an empty line is ignored (tmux never sends one; we must not crash)', () => {
        const evs = feed(S('\n%output %0 ok\n'), null);
        expect(outputBytes(evs).toString()).toBe('ok');
        expect(evs.filter((e) => e.type === 'protocol-error')).toEqual([]);
    });
});

describe('decoder state accessors', () => {
    it('reports inBlock and pendingBytes', () => {
        const dec = new ControlModeDecoder();
        expect(dec.inBlock).toBe(false);
        dec.push(S('%begin 1 1 1\nabc\n'));
        expect(dec.inBlock).toBe(true);
        expect(dec.pendingBytes).toBe(4); // 'abc\n'
        dec.push(S('%end 1 1 1\n'));
        expect(dec.inBlock).toBe(false);
        expect(dec.pendingBytes).toBe(0);
    });
});

// ── unescapeOctal (shared primitive, also used by capture-pane -C) ──────────

describe('unescapeOctal', () => {
    it('decodes three-digit octal escapes', () => {
        expect(unescapeOctal(Buffer.from('a\\033[31mb'))).toEqual(Buffer.from('a\x1b[31mb'));
    });

    it('decodes an escaped backslash (\\134) — the rule capture-pane -C shares with %output', () => {
        expect(unescapeOctal(Buffer.from('a\\134\\134b'))).toEqual(Buffer.from('a\\\\b'));
    });

    it('covers the boundaries \\000 and \\377', () => {
        expect(unescapeOctal(Buffer.from('\\000\\037\\040\\377'))).toEqual(Buffer.from([0x00, 0x1f, 0x20, 0xff]));
    });

    it('passes >=0x80 through untouched', () => {
        const cjk = Buffer.from('中文 🌏', 'utf8');
        expect(unescapeOctal(cjk)).toEqual(cjk);
    });

    it('is binary safe (no string round-trip)', () => {
        const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const escaped = Buffer.from(Array.from(raw)
            .map((b) => (b < 0x20 || b === 0x5c ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)))
            .join(''), 'latin1');
        expect(unescapeOctal(escaped)).toEqual(raw);
    });

    it('returns empty for empty input', () => {
        expect(unescapeOctal(Buffer.alloc(0))).toEqual(Buffer.alloc(0));
    });

    it('leaves a buffer with no backslash untouched', () => {
        const b = Buffer.from('plain text');
        expect(unescapeOctal(b)).toEqual(b);
    });

    it('recovers malformed escapes verbatim rather than dropping bytes', () => {
        expect(unescapeOctal(Buffer.from('a\\12xb'))).toEqual(Buffer.from('a\\12xb'));
        expect(unescapeOctal(Buffer.from('a\\9b'))).toEqual(Buffer.from('a\\9b'));
        expect(unescapeOctal(Buffer.from('a\\'))).toEqual(Buffer.from('a\\'));
        expect(unescapeOctal(Buffer.from('a\\01'))).toEqual(Buffer.from('a\\01'));
    });

    it('agrees byte-for-byte with the %output path of the decoder', () => {
        const raw = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 31 + 7) % 256));
        const escaped = Buffer.from(Array.from(raw)
            .map((b) => (b < 0x20 || b === 0x5c ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)))
            .join(''), 'latin1');
        const viaDecoder = outputBytes(feed(Buffer.concat([S('%output %0 '), escaped, S('\n')]), null));
        expect(unescapeOctal(escaped)).toEqual(viaDecoder);
    });
});
