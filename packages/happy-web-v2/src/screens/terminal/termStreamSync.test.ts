import { describe, it, expect } from 'vitest';
import { createTermStreamSync } from './termStreamSync';

describe('termStreamSync', () => {
    it('applies contiguous live chunks and advances the baseline', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(5, 0);
        expect(s.liveChunk(6)).toBe('apply');
        expect(s.liveChunk(7)).toBe('apply');
        expect(s.lastSeq).toBe(7);
    });

    it('drops chunks already covered by the baseline (replay/live overlap)', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(10, 0);
        expect(s.liveChunk(9)).toBe('dup');
        expect(s.liveChunk(10)).toBe('dup');
        expect(s.lastSeq).toBe(10);
    });

    it('flags a non-contiguous chunk as a gap and does NOT advance the baseline', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(10, 0);
        expect(s.liveChunk(13)).toBe('gap');
        // baseline unchanged → the catch-up will ask fromSeq=10 and replay 11-13
        expect(s.lastSeq).toBe(10);
        // the same late chunk keeps reading as a gap until the catch-up lands
        expect(s.liveChunk(14)).toBe('gap');
    });

    it('always applies seq-less chunks (legacy daemon) without moving the baseline', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(10, 0);
        expect(s.liveChunk(undefined)).toBe('apply');
        expect(s.lastSeq).toBe(10);
    });

    // ── The stale-baseline freeze (the "切换后不重绘/打字无回显" root) ──────
    it('REGRESSION: snapshot after a daemon-side seq restart resets the baseline', () => {
        const s = createTermStreamSync();
        // Long-lived view accumulated a high baseline in generation 1.
        s.snapshotApplied(500, 0);
        expect(s.lastSeq).toBe(500);
        // Daemon reaped + recreated the session: new generation, seq restarts.
        // New-generation chunks arriving before the catch-up dedup below the
        // stale baseline (they can't advance it) …
        expect(s.liveChunk(1)).toBe('dup');
        expect(s.liveChunk(2)).toBe('dup');
        // … and the catch-up snapshot (computed at gen-2 seq 3) must ASSIGN,
        // not max — Math.max here kept 500 and froze the terminal for good.
        s.snapshotApplied(3, 500);
        expect(s.lastSeq).toBe(3);
        expect(s.liveChunk(4)).toBe('apply');
    });

    it('keeps chunks accepted while the catch-up RPC was in flight covered', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(100, 0);
        // catch-up issued with seqAtCall=100; live 101/102 arrive during the RPC
        expect(s.liveChunk(101)).toBe('apply');
        expect(s.liveChunk(102)).toBe('apply');
        // snapshot was computed at 100 — must not regress below 102 (their
        // writes land after the restore; re-accepting them would double-write)
        s.snapshotApplied(100, 100);
        expect(s.lastSeq).toBe(102);
        expect(s.liveChunk(102)).toBe('dup');
        expect(s.liveChunk(103)).toBe('apply');
    });

    it('fresh mount snapshot assigns the daemon baseline', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(1234, 0);
        expect(s.lastSeq).toBe(1234);
        expect(s.liveChunk(1235)).toBe('apply');
    });

    it('replay applies only chunks newer than the baseline, then adopts the daemon seq', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(5, 0);
        expect(s.replayChunk(4)).toBe(false);
        expect(s.replayChunk(5)).toBe(false);
        expect(s.replayChunk(6)).toBe(true);
        expect(s.replayChunk(7)).toBe(true);
        s.replayDone(7);
        expect(s.lastSeq).toBe(7);
    });

    it('an empty replay still adopts the daemon baseline (idle since fromSeq)', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(9, 0);
        s.replayDone(9);
        expect(s.lastSeq).toBe(9);
        expect(s.liveChunk(10)).toBe('apply');
    });

    it('replayDone never regresses the baseline', () => {
        const s = createTermStreamSync();
        s.snapshotApplied(20, 0);
        s.replayDone(15);
        expect(s.lastSeq).toBe(20);
    });
});
