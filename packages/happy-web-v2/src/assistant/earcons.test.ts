import { describe, expect, it } from 'vitest';
import { EARCONS, EARCON_MASTER_GAIN, earconDuration, vibrateSafe } from './earcons';

describe('earcon tone tables', () => {
    it('start is a RISING two-tone that fits in ~100ms (leak budget)', () => {
        const tones = EARCONS.start;
        expect(tones.length).toBeGreaterThanOrEqual(2);
        // strictly ascending pitch
        for (let i = 1; i < tones.length; i++) {
            expect(tones[i].freq).toBeGreaterThan(tones[i - 1].freq);
        }
        // the whole cue must be over almost immediately — it plays while the
        // mic is already capturing, so it may leak at most ~100ms into the clip
        expect(earconDuration('start')).toBeLessThanOrEqual(0.1);
    });

    it('stop is a FALLING two-tone (release/sent)', () => {
        const tones = EARCONS.stop;
        expect(tones.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < tones.length; i++) {
            expect(tones[i].freq).toBeLessThan(tones[i - 1].freq);
        }
    });

    it('cancel is a single low muted tone', () => {
        const tones = EARCONS.cancel;
        for (const tone of tones) {
            expect(tone.freq).toBeLessThan(300);
            if (tone.glideTo !== undefined) expect(tone.glideTo).toBeLessThan(tone.freq);
        }
    });

    it('tones never overlap-gap into a long cue: every earcon is under 250ms', () => {
        for (const kind of ['start', 'stop', 'cancel'] as const) {
            expect(earconDuration(kind)).toBeGreaterThan(0);
            expect(earconDuration(kind)).toBeLessThanOrEqual(0.25);
        }
    });

    it('master gain stays polite next to an open microphone', () => {
        expect(EARCON_MASTER_GAIN).toBeGreaterThan(0);
        expect(EARCON_MASTER_GAIN).toBeLessThanOrEqual(0.2);
        for (const kind of ['start', 'stop', 'cancel'] as const) {
            for (const tone of EARCONS[kind]) {
                if (tone.gain !== undefined) expect(tone.gain).toBeLessThanOrEqual(1);
            }
        }
    });

    it('earconDuration equals the last tone end', () => {
        expect(earconDuration('stop')).toBeCloseTo(
            Math.max(...EARCONS.stop.map((t) => t.at + t.dur)),
            10,
        );
    });
});

describe('vibrateSafe', () => {
    it('is a no-op when navigator.vibrate is missing (iOS Safari)', () => {
        // node/test environment has no navigator.vibrate — must not throw
        expect(() => vibrateSafe(30)).not.toThrow();
    });
});
