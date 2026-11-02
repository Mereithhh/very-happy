import { describe, expect, it } from 'vitest';
import { acceptLive, applyOpen, b64ToBytes, initialStreamState, isOpenResult, readTerminalList, strToB64 } from './operatorTerminalModel';

describe('B-867 operator terminal stream', () => {
    it('a snapshot resets the screen and sets the baseline', () => {
        const r = applyOpen(initialStreamState(), { terminalId: 't', mode: 'snapshot', data: 'AAA', seq: 7 });
        expect(r).toEqual({ reset: true, writes: ['AAA'], next: { lastSeq: 7 } });
    });
    it('a replay writes only chunks after the baseline, in seq order', () => {
        const r = applyOpen({ lastSeq: 4 }, { terminalId: 't', mode: 'replay', chunks: [{ seq: 6, data: 'b' }, { seq: 3, data: 'old' }, { seq: 5, data: 'a' }] });
        expect(r).toEqual({ reset: false, writes: ['a', 'b'], next: { lastSeq: 6 } });
    });
    it('live frames already covered by the open answer are dropped', () => {
        expect(acceptLive({ lastSeq: 7 }, 7)).toEqual({ write: false, next: { lastSeq: 7 } });
        expect(acceptLive({ lastSeq: 7 }, 8)).toEqual({ write: true, next: { lastSeq: 8 } });
        expect(acceptLive({ lastSeq: 7 }, undefined)).toEqual({ write: true, next: { lastSeq: 7 } });
    });
    it('validates open answers and terminal lists', () => {
        expect(isOpenResult({ terminalId: 't', mode: 'snapshot', data: '' })).toBe(true);
        expect(isOpenResult({ terminalId: 't', mode: 'replay', chunks: [] })).toBe(true);
        expect(isOpenResult({ terminalId: 't', mode: 'other' })).toBe(false);
        expect(isOpenResult({ mode: 'snapshot', data: '' })).toBe(false);
        expect(readTerminalList({ terminals: [{ terminalId: 'a', kind: 'attached', openedAt: 1 }, { terminalId: 'b' }, { kind: 'opened' }] }))
            .toEqual([{ terminalId: 'a', kind: 'attached', openedAt: 1 }, { terminalId: 'b', kind: 'opened', openedAt: 0 }]);
        expect(readTerminalList(null)).toEqual([]);
    });
    it('round-trips UTF-8 input as base64 bytes', () => {
        const b64 = strToB64('ls ✓\r');
        expect(new TextDecoder().decode(b64ToBytes(b64))).toBe('ls ✓\r');
    });
});
