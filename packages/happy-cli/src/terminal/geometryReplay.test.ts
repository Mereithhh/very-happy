/**
 * B-124 regression: why the pane's geometry is authoritative in the v2 channel.
 *
 * The fixture is a REAL recording of Claude Code's TUI (ink renderer) taken
 * from a control-mode client attached to a **100-column** pane — the same bytes
 * a browser receives. Replaying it at different widths is the whole bug in one
 * assertion:
 *
 *   ink repaints its status block by erasing N rows upward, and N is computed
 *   from the width the APPLICATION sees (the tmux pane). A client that wraps
 *   the same bytes at a different width has a different number of rows, the
 *   erase falls short, and the previous status line survives — the user sees
 *   the spinner twice ("Shenaniganing…" ×2, Owner's report 2026-08-17).
 *
 * So this file pins:
 *   1. at the pane's width the footer is never duplicated (the contract);
 *   2. at a NARROWER width it IS duplicated (the bug is real, and this test
 *      would go quiet if the fixture ever stopped exercising it);
 *   3. rendering at the pane's width regardless of the viewport — which is what
 *      adopting the in-band geometry marker achieves — restores (1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';
import { geometryMarker, GEOMETRY_OSC_CODE } from './webTerminal';

const STREAM = readFileSync(fileURLToPath(new URL('./__fixtures__/geometry/claude-tui-100cols.bin', import.meta.url)));
/** The pane the recording was made at. */
const PANE_COLS = 100;
const ROWS = 30;
/** Claude's working footer — one per screen, always. */
const MARKER = 'esc to interrupt';

/** Max number of visible rows carrying MARKER, sampled through the stream. */
async function maxMarkerRows(cols: number): Promise<number> {
    const checkpoints = Array.from({ length: 24 }, (_, i) => Math.floor((STREAM.length * (i + 1)) / 24));
    let max = 0;
    for (const upTo of checkpoints) {
        const term = new Terminal({ cols, rows: ROWS, allowProposedApi: true, scrollback: 5000 });
        await new Promise<void>((resolve) => {
            term.write(new Uint8Array(STREAM.subarray(0, upTo)), () => resolve());
        });
        const buf = term.buffer.active;
        let rows = 0;
        for (let y = buf.viewportY; y < buf.viewportY + ROWS && y < buf.length; y++) {
            if ((buf.getLine(y)?.translateToString(true) ?? '').includes(MARKER)) rows++;
        }
        term.dispose();
        max = Math.max(max, rows);
    }
    return max;
}

describe('B-124: a lines client must wrap at the PANE width', () => {
    it('at the pane width the TUI footer is never duplicated', async () => {
        expect(await maxMarkerRows(PANE_COLS)).toBe(1);
    });

    it('at a narrower width the footer duplicates — this IS the reported bug', async () => {
        // Keeps the fixture honest: if a future recording stopped reproducing
        // the mismatch, assertion 1 would pass vacuously.
        expect(await maxMarkerRows(80)).toBeGreaterThan(1);
        expect(await maxMarkerRows(60)).toBeGreaterThan(1);
    });

    it('the in-band marker makes a mis-sized client adopt the pane width and stop duplicating', async () => {
        // Exactly the client's wiring: start at the container's width (60 —
        // the width that duplicates above), receive OSC 6121 in the stream,
        // resize to it, and render the rest. This is the fix, end to end,
        // minus React.
        const withMarker = Buffer.concat([geometryMarker(PANE_COLS, ROWS), STREAM]);
        const checkpoints = Array.from({ length: 24 }, (_, i) => Math.floor((withMarker.length * (i + 1)) / 24));
        let max = 0;
        let adopted = 0;
        for (const upTo of checkpoints) {
            const term = new Terminal({ cols: 60, rows: ROWS, allowProposedApi: true, scrollback: 5000 });
            term.parser.registerOscHandler(GEOMETRY_OSC_CODE, (payload) => {
                const [c, r] = payload.split(';').map(Number);
                if (Number.isFinite(c) && Number.isFinite(r)) { term.resize(c, r); adopted++; }
                return true;
            });
            await new Promise<void>((resolve) => {
                term.write(new Uint8Array(withMarker.subarray(0, upTo)), () => resolve());
            });
            const buf = term.buffer.active;
            let rows = 0;
            for (let y = buf.viewportY; y < buf.viewportY + ROWS && y < buf.length; y++) {
                if ((buf.getLine(y)?.translateToString(true) ?? '').includes(MARKER)) rows++;
            }
            term.dispose();
            max = Math.max(max, rows);
        }
        expect(adopted).toBeGreaterThan(0);   // the handler really fired
        expect(max).toBe(1);                  // …and the duplicate is gone
    });
});
