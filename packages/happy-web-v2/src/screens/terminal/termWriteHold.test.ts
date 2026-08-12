/**
 * Regression tests for the terminal selection write-hold (termWriteHold.ts).
 *
 * The critical scenarios are the RELEASE paths: the first version of the hold
 * armed on every host mousedown and released only on document mouseup /
 * window blur — on macOS Chrome a right-click opens the native context menu
 * at mousedown and the mouseup never reaches the page, so the hold stuck and
 * all output froze. Typed CJK never echoed (while xterm's local pinyin bubble
 * still worked), which shipped as the "桌面 Chrome 中文输入法没法用" bug.
 */
import { describe, it, expect } from 'vitest';
import { createTermWriteHold, HOLD_MAX_BYTES } from './termWriteHold';

const chunk = (s: string) => new TextEncoder().encode(s);
const text = (chunks: Uint8Array[]) => {
    // Concatenate then decode: chunks may split a multibyte char (the decoder
    // downstream — xterm's — is stateful across writes; order is what matters).
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(buf);
};

function setup(maxBytes?: number) {
    const written: Uint8Array[] = [];
    const hold = createTermWriteHold((d) => written.push(d), maxBytes);
    return { written, hold };
}

describe('termWriteHold', () => {
    it('writes through when no hold is active', () => {
        const { written, hold } = setup();
        hold.gatedWrite(chunk('a'));
        expect(text(written)).toBe('a');
        expect(hold.isHolding()).toBe(false);
    });

    it('buffers during a primary-button gesture and flushes in order on gestureEnd', () => {
        const { written, hold } = setup();
        hold.gestureStart(0);
        hold.gatedWrite(chunk('one '));
        hold.gatedWrite(chunk('two'));
        expect(written).toHaveLength(0);
        expect(hold.isHolding()).toBe(true);
        hold.gestureEnd();
        expect(text(written)).toBe('one two');
        expect(hold.isHolding()).toBe(false);
    });

    it('REGRESSION: a right-click (button 2) never arms the hold — the macOS context menu swallows its mouseup', () => {
        const { written, hold } = setup();
        hold.gestureStart(2); // right-click; no gestureEnd will ever come
        hold.gatedWrite(chunk('echo'));
        expect(text(written)).toBe('echo'); // NOT frozen
        expect(hold.isHolding()).toBe(false);
    });

    it('REGRESSION: user input releases a stuck gesture hold (lost mouseup) so the echo is visible', () => {
        const { written, hold } = setup();
        hold.gestureStart(0);
        hold.gatedWrite(chunk('missed output')); // buffered — mouseup got lost
        hold.noteUserInput(); // user typed / IME committed / pasted
        expect(text(written)).toBe('missed output');
        expect(hold.isHolding()).toBe(false);
        hold.gatedWrite(chunk(' + echo')); // subsequent echo writes live
        expect(text(written)).toBe('missed output + echo');
    });

    it('gestureEnd and noteUserInput are idempotent no-ops without an active gesture', () => {
        const { written, hold } = setup();
        hold.gestureEnd();
        hold.noteUserInput();
        hold.gatedWrite(chunk('ok'));
        expect(text(written)).toBe('ok');
    });

    it('select-mode hold persists across gesture end AND user input; only its toggle releases', () => {
        const { written, hold } = setup();
        hold.setModeHold(true);
        hold.gestureStart(0);
        hold.gatedWrite(chunk('held'));
        hold.gestureEnd(); // gesture over — mode still holds
        expect(written).toHaveLength(0);
        hold.noteUserInput(); // key-bar input during select-mode must not unfreeze
        expect(written).toHaveLength(0);
        hold.setModeHold(false);
        expect(text(written)).toBe('held');
    });

    it('snapshot restore: drops stale held chunks, writes through during restore, re-arms only the mode hold', () => {
        const { written, hold } = setup();
        hold.setModeHold(true);
        hold.gestureStart(0);
        hold.gatedWrite(chunk('stale'));
        hold.beginSnapshotRestore();
        hold.gatedWrite(chunk('SNAPSHOT')); // the restore itself
        expect(text(written)).toBe('SNAPSHOT'); // stale dropped, restore through
        hold.endSnapshotRestore();
        hold.gatedWrite(chunk('post')); // mode hold re-armed → buffered
        expect(text(written)).toBe('SNAPSHOT');
        expect(hold.isGestureHolding()).toBe(false); // gesture NOT re-armed
        hold.setModeHold(false);
        expect(text(written)).toBe('SNAPSHOTpost');
    });

    it('snapshot restore without select-mode leaves everything unfrozen afterwards', () => {
        const { written, hold } = setup();
        hold.gestureStart(0);
        hold.gatedWrite(chunk('stale'));
        hold.beginSnapshotRestore();
        hold.gatedWrite(chunk('SNAP'));
        hold.endSnapshotRestore();
        hold.gatedWrite(chunk('live'));
        expect(text(written)).toBe('SNAPlive');
        expect(hold.isHolding()).toBe(false);
    });

    it('safety cap force-flushes the backlog but keeps holding', () => {
        const { written, hold } = setup(8);
        hold.gestureStart(0);
        hold.gatedWrite(chunk('123456'));
        expect(written).toHaveLength(0);
        hold.gatedWrite(chunk('789')); // 9 > 8 → force flush
        expect(text(written)).toBe('123456789');
        expect(hold.isHolding()).toBe(true); // still armed
        hold.gatedWrite(chunk('x'));
        expect(text(written)).toBe('123456789'); // buffering again
        hold.gestureEnd();
        expect(text(written)).toBe('123456789x');
    });

    it('preserves chunk boundaries and order — a UTF-8 char split across held chunks stays contiguous', () => {
        const { written, hold } = setup();
        const bytes = chunk('中文OK');
        hold.gestureStart(0);
        hold.gatedWrite(bytes.slice(0, 4)); // splits 文 mid-sequence
        hold.gatedWrite(bytes.slice(4));
        hold.gestureEnd();
        expect(written).toHaveLength(2);
        expect(text(written)).toBe('中文OK');
    });

    it('exports a sane default cap', () => {
        expect(HOLD_MAX_BYTES).toBe(1024 * 1024);
    });
});
