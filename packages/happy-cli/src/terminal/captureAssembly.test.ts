import { describe, it, expect } from 'vitest';
import {
    buildCaptureBatch,
    parsePaneState,
    normalizeCaptureLines,
    truncateToBudget,
    assembleRestore,
    PANE_STATE_FORMAT,
    type CaptureKey,
} from './captureAssembly';

const buf = (s: string) => Buffer.from(s, 'utf8');
const str = (b: Buffer) => b.toString('utf8');

describe('buildCaptureBatch', () => {
    const batch = buildCaptureBatch({ paneTarget: '%7', historyLines: 5000, smallLines: 300, cols: 100, rows: 30 });
    const cmd = (k: CaptureKey) => batch.find((c) => c.key === k)!.command;

    it('is one atomic batch whose LAST command is the anchor', () => {
        expect(batch[batch.length - 1].key).toBe('anchor');
        expect(cmd('anchor')).toBe('refresh-client -C 100x30');
    });

    it('sends BOTH screen shapes plus the pane state (双份全发)', () => {
        const keys = batch.map((c) => c.key);
        expect(keys).toContain('history');
        expect(keys).toContain('smallHistory');
        expect(keys).toContain('altSaved');
        expect(keys).toContain('visible');
        expect(keys).toContain('panes');
    });

    it('captures history as LOGICAL lines and the screen as PHYSICAL rows', () => {
        // The split is the whole point: scrollback is free-flowing text the
        // client re-wraps at its own width (-J), while the screen is what the
        // application addresses with cursor moves and must come back row for
        // row (no -J) or every later repaint lands on the wrong row.
        expect(cmd('history')).toBe('capture-pane -peqJN -t %7 -S -5000 -E -1');
        expect(cmd('smallHistory')).toBe('capture-pane -peqJN -t %7 -S -300 -E -1');
        expect(cmd('altSaved')).toBe('capture-pane -peqJN -t %7 -a');
        expect(cmd('visible')).toBe('capture-pane -peqN -t %7');
        expect(cmd('visible')).not.toContain('J');
        expect(cmd('tail')).toBe('capture-pane -p -P -C -t %7');
        expect(cmd('panes')).toBe(`list-panes -t %7 -F "${PANE_STATE_FORMAT}"`);
    });

    it('no command is blank (a bare newline on the control stdin = detach)', () => {
        for (const c of batch) expect(c.command.trim().length).toBeGreaterThan(0);
    });

    it('clamps absurd geometry / depths instead of emitting nonsense', () => {
        const b = buildCaptureBatch({ paneTarget: '%1', historyLines: 0, smallLines: -5, cols: 0, rows: 1 });
        const find = (k: CaptureKey) => b.find((c) => c.key === k)!.command;
        expect(find('history')).toContain('-S -1');
        expect(find('smallHistory')).toContain('-S -1');
        expect(find('anchor')).toBe('refresh-client -C 2x2');
    });
});

describe('parsePaneState', () => {
    it('parses the state line', () => {
        expect(parsePaneState('%7|1|33|9|120|40')).toEqual({
            paneId: '%7', alternateOn: true, cursorX: 33, cursorY: 9, width: 120, height: 40,
        });
        expect(parsePaneState('%0|0|0|0|80|24\n')!.alternateOn).toBe(false);
    });

    it('takes the FIRST pane when the window is split (single-pane declaration)', () => {
        const twoPanes = '%3|0|1|2|80|24\n%4|1|0|0|80|24\n';
        expect(parsePaneState(twoPanes)!.paneId).toBe('%3');
        expect(parsePaneState(twoPanes)!.alternateOn).toBe(false); // %4's alt must not leak
    });

    it('returns undefined (→ normal-screen default) for garbage', () => {
        expect(parsePaneState('')).toBeUndefined();
        expect(parsePaneState('%1|2|3')).toBeUndefined();
        expect(parsePaneState('%1|x|1|2|3|4')).toBeUndefined();
        expect(parsePaneState('%1|1|a|2|3|4')).toBeUndefined();
        expect(parsePaneState('7|1|0|0|80|24')).toBeUndefined(); // pane id must carry its %
    });
});

describe('normalizeCaptureLines', () => {
    it('turns LF seams into CRLF and drops the trailing newline', () => {
        expect(str(normalizeCaptureLines(buf('a\nb\nc\n')))).toBe('a\r\nb\r\nc');
    });

    it('does not double a pre-existing CR', () => {
        expect(str(normalizeCaptureLines(buf('a\r\nb\n')))).toBe('a\r\nb');
    });

    it('keeps an unterminated last line', () => {
        expect(str(normalizeCaptureLines(buf('a\nb')))).toBe('a\r\nb');
    });

    it('empty stays empty; blank lines survive', () => {
        expect(normalizeCaptureLines(buf('')).length).toBe(0);
        expect(str(normalizeCaptureLines(buf('a\n\nb\n')))).toBe('a\r\n\r\nb');
    });

    it('is byte-exact for invalid UTF-8 (a pane can print anything)', () => {
        const raw = Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from([0x80, 0x81])]);
        const out = normalizeCaptureLines(raw);
        expect([...out]).toEqual([0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x81]);
    });

    it('leaves a -J joined long line intact (no re-wrapping here)', () => {
        const long = 'x'.repeat(5000);
        expect(str(normalizeCaptureLines(buf(`${long}\n`)))).toBe(long);
    });
});

describe('truncateToBudget', () => {
    it('is a no-op under budget', () => {
        const b = buf('a\nb\n');
        expect(truncateToBudget(b, 100)).toBe(b);
    });

    it('drops the OLDEST lines and always cuts on a line boundary', () => {
        const blob = buf('old1\nold2\nnew1\nnew2\n');
        const out = str(truncateToBudget(blob, 11));
        expect(out.startsWith('old')).toBe(false);
        expect(out).toBe('new1\nnew2\n');
        expect(blob.toString().endsWith(out)).toBe(true); // suffix, nothing rewritten
    });

    it('never cuts mid-line even when that means keeping less than the budget', () => {
        const blob = buf('aaaaaaaaaa\nbb\n');
        const out = str(truncateToBudget(blob, 12));
        expect(out).toBe('bb\n');
    });

    it('one huge line with no newline after the cut: keeps the newest bytes', () => {
        const out = truncateToBudget(buf('y'.repeat(100)), 10);
        expect(out.length).toBe(10);
    });
});

describe('assembleRestore', () => {
    const pane = (over: Partial<{ alternateOn: boolean; cursorX: number; cursorY: number; height: number }> = {}) => ({
        paneId: '%0', alternateOn: false, cursorX: 0, cursorY: 0, width: 80, height: 4, ...over,
    });
    const CUP = (y: number, x: number) => `\x1b[${y + 1};${x + 1}H`;

    it('normal: scrollback + a FULL-height screen + the cursor where the app left it', () => {
        const r = assembleRestore(
            {
                history: buf('hist1\nhist2\n'),
                smallHistory: buf('hist2\n'),
                visible: buf('prompt$ typed\n\n'),   // 2 rows captured, pane is 4 tall
                tail: buf(''),
            },
            pane({ cursorX: 13, cursorY: 0 }),
        );
        expect(r.alternateOn).toBe(false);
        // screen padded to the pane's height so CUP rows mean what tmux meant
        expect(str(r.full)).toBe(`hist1\r\nhist2\r\nprompt$ typed\r\n\r\n\r\n${CUP(0, 13)}`);
        expect(str(r.small)).toBe(`hist2\r\nprompt$ typed\r\n\r\n\r\n${CUP(0, 13)}`);
    });

    it('a screen taller than the pane keeps the LAST rows (never the first)', () => {
        const r = assembleRestore(
            { visible: buf('a\nb\nc\nd\ne\nf\n'), tail: buf('') },
            pane({ height: 3, cursorY: 2, cursorX: 0 }),
        );
        expect(str(r.full)).toBe(`d\r\ne\r\nf${CUP(2, 0)}`);
    });

    it('alt: scrollback + saved normal screen, THEN 1049h + the alt frame + cursor', () => {
        const r = assembleRestore(
            {
                history: buf('h1\n'),
                altSaved: buf('s1\n'),
                visible: buf('TUI\n'),
                tail: buf(''),
            },
            pane({ alternateOn: true, height: 2, cursorX: 3, cursorY: 1 }),
        );
        expect(r.alternateOn).toBe(true);
        expect(str(r.full)).toBe(`h1\r\ns1\r\n\x1b[?1049h\x1b[HTUI\r\n${CUP(1, 3)}`);
        // The命门: the fullscreen frame sits AFTER the alt switch, never in the
        // scrollback part.
        expect(str(r.full).indexOf('TUI')).toBeGreaterThan(str(r.full).indexOf('\x1b[?1049h'));
        expect(str(r.small)).toBe(`\x1b[?1049h\x1b[HTUI\r\n${CUP(1, 3)}`);
    });

    it('unknown pane state: no padding, no cursor — degrade instead of guessing', () => {
        const r = assembleRestore({ history: buf('a\n'), visible: buf('b\n') }, undefined);
        expect(r.alternateOn).toBe(false);
        expect(str(r.full)).toBe('a\r\nb');
        expect(str(r.full)).not.toContain('\x1b[');
    });

    it('appends the unfinished-escape tail before the cursor move', () => {
        const r = assembleRestore(
            { visible: buf('a\n'), tail: Buffer.from('\x1b[3', 'ascii') },
            pane({ height: 1, cursorX: 1, cursorY: 0 }),
        );
        expect(str(r.full)).toBe(`a\x1b[3${CUP(0, 1)}`);
    });

    it('missing responses degrade instead of throwing', () => {
        expect(() => assembleRestore({}, pane())).not.toThrow();
        const alt = assembleRestore({}, pane({ alternateOn: true, height: 2 }));
        expect(str(alt.full)).toContain('\x1b[?1049h');
    });

    it('applies the byte budget to the scrollback, never to the screen', () => {
        const big = buf(`${'l'.repeat(50)}\n`.repeat(100));
        const r = assembleRestore({ history: big, visible: buf('now\n'), smallHistory: buf('') }, pane({ height: 1 }), 200);
        expect(r.full.length).toBeLessThanOrEqual(260);
        expect(str(r.full)).toContain('now');            // the screen always survives
        expect(str(r.full)).toContain(CUP(0, 0));
    });
});
