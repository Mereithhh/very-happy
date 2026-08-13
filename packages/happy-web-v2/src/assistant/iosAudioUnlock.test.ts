// B-058 regression: the keep-alive loop must be REAL-length silence. The
// original 1-sample data-URL WAV looped every ~23µs and froze the page.
import { describe, expect, it } from 'vitest';
import { buildSilentWavBuffer } from './iosAudioUnlock';

describe('buildSilentWavBuffer (B-058)', () => {
    it('produces >= 0.5s of samples by default (never a degenerate loop)', () => {
        const buf = buildSilentWavBuffer();
        const v = new DataView(buf);
        const dataBytes = v.getUint32(40, true);
        const sampleRate = v.getUint32(24, true);
        const seconds = dataBytes / 2 / sampleRate;
        expect(seconds).toBeGreaterThanOrEqual(0.5);
    });

    it('writes a valid RIFF/WAVE header with zeroed (silent) samples', () => {
        const buf = buildSilentWavBuffer(0.1);
        const v = new DataView(buf);
        const str = (off: number, len: number) =>
            String.fromCharCode(...Array.from({ length: len }, (_, i) => v.getUint8(off + i)));
        expect(str(0, 4)).toBe('RIFF');
        expect(str(8, 4)).toBe('WAVE');
        expect(str(36, 4)).toBe('data');
        expect(v.getUint32(4, true)).toBe(buf.byteLength - 8);
        const bytes = new Uint8Array(buf, 44);
        expect(bytes.every((b) => b === 0)).toBe(true);
    });
});
