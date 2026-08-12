/**
 * chimes — WebAudio-synthesized notification sounds. Zero audio assets, zero
 * dependencies: every voice is a handful of oscillator+gain envelopes.
 *
 * Autoplay policy: an AudioContext only produces sound after a user gesture.
 * installAudioUnlock() registers capture-phase pointerdown/keydown listeners
 * that resume the context on the first interaction; until then playChime is a
 * silent no-op (never throws, never logs an error to the user).
 *
 * The 'melody' voice is an ORIGINAL 5-note jingle written for this app —
 * deliberately not a quote of any existing tune.
 */

export type ChimeVoice = 'ding' | 'duo' | 'woodblock' | 'melody';

export const CHIME_VOICES: readonly ChimeVoice[] = ['ding', 'duo', 'woodblock', 'melody'];

let ctx: AudioContext | null = null;
let unlockInstalled = false;

function getCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
        try {
            ctx = new AC();
        } catch {
            return null;
        }
    }
    return ctx;
}

/**
 * Idempotent: arm one-time global listeners that resume the AudioContext on
 * the first user gesture. Kept installed until the context actually runs
 * (a first gesture can happen before the context exists).
 */
export function installAudioUnlock(): void {
    if (unlockInstalled || typeof window === 'undefined') return;
    unlockInstalled = true;
    const tryUnlock = () => {
        const c = getCtx();
        if (!c) {
            remove();
            return;
        }
        if (c.state === 'suspended') {
            void c.resume().catch(() => {});
        }
        if (c.state === 'running') remove();
    };
    const remove = () => {
        window.removeEventListener('pointerdown', tryUnlock, true);
        window.removeEventListener('keydown', tryUnlock, true);
    };
    window.addEventListener('pointerdown', tryUnlock, true);
    window.addEventListener('keydown', tryUnlock, true);
}

/**
 * Play a chime at `volume` (0..1). Silent no-op when WebAudio is missing or
 * the context is still locked by autoplay policy (a resume is attempted —
 * when called from a user gesture, e.g. the settings preview button, it
 * unlocks and plays in the same call).
 */
export function playChime(voice: ChimeVoice, volume: number): void {
    const c = getCtx();
    if (!c) return;
    const vol = Math.min(1, Math.max(0, volume));
    if (vol <= 0) return;
    if (c.state === 'running') {
        synth(c, voice, vol);
        return;
    }
    // Locked: attempt a resume; succeeds iff we're inside a user gesture.
    void c
        .resume()
        .then(() => {
            if (c.state === 'running') synth(c, voice, vol);
        })
        .catch(() => {});
}

// ---------------------------------------------------------------------------
// synthesis
// ---------------------------------------------------------------------------

interface Tone {
    /** Hz */
    freq: number;
    /** seconds from now */
    at: number;
    /** envelope length in seconds */
    dur: number;
    type?: OscillatorType;
    /** relative gain inside the chime (0..1) */
    gain?: number;
    /** exponential pitch glide target (Hz) over the tone's duration */
    glideTo?: number;
}

function synth(c: AudioContext, voice: ChimeVoice, volume: number): void {
    try {
        const master = c.createGain();
        // Perceptual taper + polite ceiling: full slider ≈ gentle UI chime.
        master.gain.value = volume * volume * 0.5;
        master.connect(c.destination);
        const t0 = c.currentTime + 0.02;
        for (const tone of VOICES[voice]) {
            const osc = c.createOscillator();
            const g = c.createGain();
            const start = t0 + tone.at;
            const end = start + tone.dur;
            osc.type = tone.type ?? 'sine';
            osc.frequency.setValueAtTime(tone.freq, start);
            if (tone.glideTo) osc.frequency.exponentialRampToValueAtTime(tone.glideTo, end);
            g.gain.setValueAtTime(0.0001, start);
            g.gain.exponentialRampToValueAtTime(tone.gain ?? 1, start + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, end);
            osc.connect(g);
            g.connect(master);
            osc.start(start);
            osc.stop(end + 0.05);
        }
    } catch {
        // best-effort — a failed chime must never break the app
    }
}

// note frequencies (Hz), equal temperament
const E5 = 659.26;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const C6 = 1046.5;
const D6 = 1174.66;

const VOICES: Record<ChimeVoice, Tone[]> = {
    // Single clear "ding": B5 with a soft octave partial.
    ding: [
        { freq: B5, at: 0, dur: 0.6 },
        { freq: B5 * 2, at: 0, dur: 0.35, gain: 0.25 },
    ],
    // Two-tone rise (E5 → A5), the classic "attention please".
    duo: [
        { freq: E5, at: 0, dur: 0.28, type: 'triangle' },
        { freq: A5, at: 0.13, dur: 0.4, type: 'triangle' },
    ],
    // Woodblock knock: a fast pitch-drop thock plus a tiny click transient.
    woodblock: [
        { freq: 850, at: 0, dur: 0.09, glideTo: 400 },
        { freq: 2400, at: 0, dur: 0.02, type: 'square', gain: 0.12 },
    ],
    // Original 5-note jingle (playful up-hop, written for very-happy):
    // E5 G5 C6 A5 D6 with a light swing, the last note ringing out.
    melody: [
        { freq: E5, at: 0.0, dur: 0.14, type: 'triangle', gain: 0.8 },
        { freq: G5, at: 0.13, dur: 0.14, type: 'triangle', gain: 0.8 },
        { freq: C6, at: 0.26, dur: 0.14, type: 'triangle', gain: 0.85 },
        { freq: A5, at: 0.39, dur: 0.14, type: 'triangle', gain: 0.8 },
        { freq: D6, at: 0.55, dur: 0.42, type: 'triangle' },
    ],
};
