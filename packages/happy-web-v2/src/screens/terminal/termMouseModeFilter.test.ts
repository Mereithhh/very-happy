/**
 * Tests for the DECSET/DECRST mouse-tracking filter — run against a REAL
 * @xterm/xterm 5.5 Terminal (its core parser works headless, no DOM needed),
 * so the partial-swallow replay through `_core._inputHandler` is exercised
 * against the exact private API surface the app ships with.
 *
 * Regression story: Claude Code's TUI (≥2.1.226) enables mouse reporting;
 * tmux (mouse off) passes the DECSET through, xterm enters mouse-tracking and
 * native drag-selection dies ("按住拖动选择没有任何反应").
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
    MOUSE_TRACKING_DEC_MODES,
    splitMouseModeParams,
    installMouseModeFilter,
} from './termMouseModeFilter';

const write = (term: Terminal, data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));

function makeTerm(): Terminal {
    const term = new Terminal({ allowProposedApi: true });
    installMouseModeFilter(term);
    return term;
}

describe('splitMouseModeParams', () => {
    it('separates mouse modes from the rest, preserving order of the rest', () => {
        expect(splitMouseModeParams([1049, 1002, 25, 1006])).toEqual({
            mouse: [1002, 1006],
            rest: [1049, 25],
        });
    });

    it('all-mouse and no-mouse extremes', () => {
        expect(splitMouseModeParams([1000, 1006])).toEqual({ mouse: [1000, 1006], rest: [] });
        expect(splitMouseModeParams([25, 2004])).toEqual({ mouse: [], rest: [25, 2004] });
    });

    it('sub-params (number[]) are never mouse modes', () => {
        expect(splitMouseModeParams([[1000], 1002])).toEqual({ mouse: [1002], rest: [[1000]] });
    });

    it('the filtered set is exactly the tracking protocols + encodings', () => {
        expect([...MOUSE_TRACKING_DEC_MODES].sort((a, b) => a - b)).toEqual([
            9, 1000, 1002, 1003, 1005, 1006, 1015, 1016,
        ]);
    });
});

describe('installMouseModeFilter (real xterm 5.5 Terminal)', () => {
    it('swallows pure mouse-tracking DECSETs — the Claude Code TUI handshake', async () => {
        const term = makeTerm();
        await write(term, '\x1b[?1000h\x1b[?1002h\x1b[?1006h');
        expect(term.modes.mouseTrackingMode).toBe('none'); // selection stays native
        term.dispose();
    });

    it('exposes swallowed protocol state for realtime touch-wheel forwarding', async () => {
        const term = new Terminal({ allowProposedApi: true });
        const filter = installMouseModeFilter(term);
        expect(filter.sgrWheelRequested()).toBe(false);
        await write(term, '\x1b[?1002h\x1b[?1006h');
        expect(filter.sgrWheelRequested()).toBe(true);
        expect(term.modes.mouseTrackingMode).toBe('none');
        await write(term, '\x1b[?1006l');
        expect(filter.sgrWheelRequested()).toBe(false);
        await write(term, '\x1b[?1002l');
        filter.dispose();
        term.dispose();
    });

    it('does not claim non-SGR mouse protocols for the direct wheel path', async () => {
        const term = new Terminal({ allowProposedApi: true });
        const filter = installMouseModeFilter(term);
        await write(term, '\x1b[?1000h\x1b[?1005h');
        expect(filter.sgrWheelRequested()).toBe(false);
        filter.dispose();
        term.dispose();
    });

    it('passes unrelated private modes through untouched (return-false path)', async () => {
        const term = makeTerm();
        await write(term, '\x1b[?1049h\x1b[?2004h');
        expect(term.buffer.active.type).toBe('alternate');
        expect(term.modes.bracketedPasteMode).toBe(true);
        await write(term, '\x1b[?2004l\x1b[?1049l');
        expect(term.buffer.active.type).toBe('normal');
        expect(term.modes.bracketedPasteMode).toBe(false);
        term.dispose();
    });

    it('MIXED set: swallows the mouse params, still applies the rest of the SAME sequence', async () => {
        const term = makeTerm();
        await write(term, '\x1b[?1049;1002;2004;1006h');
        expect(term.modes.mouseTrackingMode).toBe('none');
        expect(term.buffer.active.type).toBe('alternate'); // 1049 replayed
        expect(term.modes.bracketedPasteMode).toBe(true); // 2004 replayed
        term.dispose();
    });

    it('MIXED reset: swallows the mouse params, still resets the rest', async () => {
        const term = makeTerm();
        await write(term, '\x1b[?1049h\x1b[?2004h');
        await write(term, '\x1b[?1006;1049;2004l');
        expect(term.buffer.active.type).toBe('normal'); // 1049 reset replayed
        expect(term.modes.bracketedPasteMode).toBe(false); // 2004 reset replayed
        term.dispose();
    });

    it('replayed params apply IN ORDER with the rest of the chunk (synchronous, not re-queued)', async () => {
        const term = makeTerm();
        // Enter alt screen in a mixed sequence, then draw in the SAME chunk:
        // if the replay were queued via term.write, "X" would land on the
        // normal screen before the switch.
        await write(term, '\x1b[?1002;1049h\x1b[HX');
        expect(term.buffer.active.type).toBe('alternate');
        const line = term.buffer.active.getLine(0)?.translateToString(true);
        expect(line).toBe('X');
        term.dispose();
    });

    it('X10 / any-motion / legacy encodings are filtered too', async () => {
        const term = makeTerm();
        await write(term, '\x1b[?9h\x1b[?1003h\x1b[?1005h\x1b[?1015h\x1b[?1016h');
        expect(term.modes.mouseTrackingMode).toBe('none');
        term.dispose();
    });

    it('dispose() restores default behavior', async () => {
        const term = new Terminal({ allowProposedApi: true });
        const filter = installMouseModeFilter(term);
        filter.dispose();
        await write(term, '\x1b[?1002h');
        expect(term.modes.mouseTrackingMode).toBe('drag'); // back to xterm default
        term.dispose();
    });
});
