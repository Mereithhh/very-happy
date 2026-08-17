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
        expect(keys).toContain('normalFull');
        expect(keys).toContain('altHistory');
        expect(keys).toContain('altSaved');
        expect(keys).toContain('visible');
        expect(keys).toContain('normalSmall');
        expect(keys).toContain('panes');
    });

    it('uses the verified capture flags for each shape', () => {
        expect(cmd('normalFull')).toBe('capture-pane -peqJN -t %7 -S -5000');
        expect(cmd('altHistory')).toBe('capture-pane -peqJN -t %7 -S -5000 -E -1'); // history ONLY
        expect(cmd('altSaved')).toBe('capture-pane -peqJN -t %7 -a');               // saved normal screen
        expect(cmd('visible')).toBe('capture-pane -peqJN -t %7');                   // no range = visible
        expect(cmd('normalSmall')).toBe('capture-pane -peqJN -t %7 -S -300');
        expect(cmd('tail')).toBe('capture-pane -p -P -C -t %7');
        expect(cmd('panes')).toBe(`list-panes -t %7 -F "${PANE_STATE_FORMAT}"`);
    });

    it('no command is blank (a bare newline on the control stdin = detach)', () => {
        for (const c of batch) expect(c.command.trim().length).toBeGreaterThan(0);
    });

    it('clamps absurd geometry / depths instead of emitting nonsense', () => {
        const b = buildCaptureBatch({ paneTarget: '%1', historyLines: 0, smallLines: -5, cols: 0, rows: 1 });
        const find = (k: CaptureKey) => b.find((c) => c.key === k)!.command;
        expect(find('normalFull')).toContain('-S -1');
        expect(find('normalSmall')).toContain('-S -1');
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
    const paneNormal = { paneId: '%0', alternateOn: false, cursorX: 0, cursorY: 0, width: 80, height: 24 };
    const paneAlt = { ...paneNormal, alternateOn: true };

    it('normal screen: the single full capture IS the restore', () => {
        const r = assembleRestore(
            { normalFull: buf('hist1\nhist2\nprompt$ \n'), normalSmall: buf('prompt$ \n'), tail: buf('') },
            paneNormal,
        );
        expect(r.alternateOn).toBe(false);
        expect(str(r.full)).toBe('hist1\r\nhist2\r\nprompt$ ');
        expect(str(r.small)).toBe('prompt$ ');
        expect(str(r.full)).not.toContain('\x1b[?1049h');
    });

    it('alt screen: history + saved normal screen, THEN 1049h + the alt frame', () => {
        const r = assembleRestore(
            {
                altHistory: buf('h1\nh2\n'),
                altSaved: buf('s1\ns2\n'),
                visible: buf('TUI-FRAME\n'),
                normalFull: buf('MUST NOT BE USED\n'),
                tail: buf(''),
            },
            paneAlt,
        );
        expect(r.alternateOn).toBe(true);
        expect(str(r.full)).toBe('h1\r\nh2\r\ns1\r\ns2\r\n\x1b[?1049h\x1b[HTUI-FRAME');
        // The命门: the fullscreen frame must sit AFTER the alt switch, never in
        // the scrollback part.
        const idx = str(r.full).indexOf('\x1b[?1049h');
        expect(str(r.full).indexOf('TUI-FRAME')).toBeGreaterThan(idx);
        expect(str(r.full)).not.toContain('MUST NOT BE USED');
    });

    it('alt small snapshot carries the 1049h prefix (web picks the alt lane immediately)', () => {
        const r = assembleRestore({ visible: buf('FRAME\n'), tail: buf('') }, paneAlt);
        expect(str(r.small)).toBe('\x1b[?1049h\x1b[HFRAME');
    });

    it('unknown pane state falls back to the normal assembly', () => {
        const r = assembleRestore({ normalFull: buf('a\n'), normalSmall: buf('a\n') }, undefined);
        expect(r.alternateOn).toBe(false);
        expect(str(r.full)).toBe('a');
    });

    it('appends the unfinished-escape tail to both payloads', () => {
        const r = assembleRestore(
            { normalFull: buf('a\n'), normalSmall: buf('a\n'), tail: Buffer.from('\x1b[3', 'ascii') },
            paneNormal,
        );
        expect(str(r.full)).toBe('a\x1b[3');
        expect(str(r.small)).toBe('a\x1b[3');
    });

    it('missing responses degrade instead of throwing', () => {
        expect(() => assembleRestore({}, paneNormal)).not.toThrow();
        expect(assembleRestore({}, paneNormal).full.length).toBe(0);
        const alt = assembleRestore({}, paneAlt);
        expect(str(alt.full)).toBe('\x1b[?1049h\x1b[H'); // still a valid (empty) alt frame
    });

    it('applies the byte budget to the full payload only', () => {
        const big = buf(`${'l'.repeat(50)}\n`.repeat(100));
        const r = assembleRestore({ normalFull: big, normalSmall: buf('now\n') }, paneNormal, 200);
        expect(r.full.length).toBeLessThanOrEqual(220);
        expect(str(r.small)).toBe('now');
        // Suffix-preserving: the NEWEST lines survive.
        expect(str(r.full).endsWith('l'.repeat(50))).toBe(true);
    });
});
