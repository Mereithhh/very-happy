/**
 * earcons — short WebAudio-synthesized feedback tones for push-to-talk (B-092).
 *
 * Three one-shot cues, all synthesized (chimes.ts precedent — zero assets):
 *  - start:  ~80ms rising two-tone, played the moment recording actually
 *    begins (getUserMedia succeeded). Capture is already running by then, so
 *    the tone CAN leak into the first ~80ms of the clip — accepted trade-off
 *    (spec'd), and the master gain is deliberately low to keep the leak
 *    negligible for ASR.
 *  - stop:   short falling two-tone on release (clip is being sent);
 *  - cancel: low muted thud (mis-tap / pointercancel / mic error — discarded).
 *
 * Plays through the assistant's SHARED AudioContext (iosAudioUnlock) but on an
 * independent per-call GainNode with one-shot sources: it never touches the
 * TTS queue and can never interrupt (or be interrupted by) reply playback.
 * Everything is best-effort — a failed earcon must never break recording.
 */

import { getAssistantAudioContext } from './iosAudioUnlock';

export type EarconKind = 'start' | 'stop' | 'cancel';

export interface EarconTone {
    /** Hz */
    freq: number;
    /** seconds from cue start */
    at: number;
    /** envelope length in seconds */
    dur: number;
    type?: OscillatorType;
    /** relative gain inside the cue (0..1) */
    gain?: number;
    /** exponential pitch glide target (Hz) over the tone's duration */
    glideTo?: number;
}

/**
 * Restrained ceiling: earcons are UI feedback next to an OPEN MICROPHONE.
 * (chimes.ts uses 0.5 for notifications; these stay far quieter.)
 */
export const EARCON_MASTER_GAIN = 0.14;

/** Pure tone tables — exported for unit tests. */
export const EARCONS: Record<EarconKind, EarconTone[]> = {
    // rising two-tone (E5 → A5), total ≈ 80ms
    start: [
        { freq: 659.26, at: 0, dur: 0.04, type: 'sine' },
        { freq: 880.0, at: 0.04, dur: 0.045, type: 'sine' },
    ],
    // falling two-tone (A5 → E5) — "sent"
    stop: [
        { freq: 880.0, at: 0, dur: 0.05, type: 'sine' },
        { freq: 659.26, at: 0.05, dur: 0.07, type: 'sine' },
    ],
    // low muted thud with a quick downward glide — "discarded"
    cancel: [{ freq: 240, at: 0, dur: 0.09, type: 'triangle', glideTo: 150, gain: 0.8 }],
};

/** Total length of a cue in seconds (pure; unit-tested). */
export function earconDuration(kind: EarconKind): number {
    return EARCONS[kind].reduce((max, t) => Math.max(max, t.at + t.dur), 0);
}

/**
 * Best-effort resume of the shared context from INSIDE a user gesture
 * (pointerdown), so the start cue — which fires asynchronously once the mic
 * is ready — finds a running context even before the user tapped the
 * "enable spoken replies" unlock. Safe no-op everywhere else; it does NOT
 * flip the store's audioUnlocked gate (TTS keeps its explicit unlock button).
 */
export function primeEarcons(): void {
    try {
        const ctx = getAssistantAudioContext();
        if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
        // best-effort
    }
}

/**
 * Play a cue through the shared assistant AudioContext. Silent no-op when
 * WebAudio is unavailable or the context is not running (autoplay policy).
 * Uses a dedicated GainNode + one-shot oscillators per call — independent of
 * the TTS player's source nodes and queue.
 */
export function playEarcon(kind: EarconKind): void {
    try {
        const ctx = getAssistantAudioContext();
        if (!ctx || ctx.state !== 'running') return;
        const master = ctx.createGain();
        master.gain.value = EARCON_MASTER_GAIN;
        master.connect(ctx.destination);
        const t0 = ctx.currentTime + 0.005;
        for (const tone of EARCONS[kind]) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            const start = t0 + tone.at;
            const end = start + tone.dur;
            osc.type = tone.type ?? 'sine';
            osc.frequency.setValueAtTime(tone.freq, start);
            if (tone.glideTo) osc.frequency.exponentialRampToValueAtTime(tone.glideTo, end);
            g.gain.setValueAtTime(0.0001, start);
            g.gain.exponentialRampToValueAtTime(tone.gain ?? 1, start + 0.006);
            g.gain.exponentialRampToValueAtTime(0.0001, end);
            osc.connect(g);
            g.connect(master);
            osc.start(start);
            osc.stop(end + 0.03);
        }
    } catch {
        // a failed earcon must never break the recording flow
    }
}

/**
 * Haptic tap. Android Chrome honors navigator.vibrate; iOS Safari does NOT
 * implement it — there this is a documented no-op (no fallback exists on the
 * web platform). Never throws.
 */
export function vibrateSafe(ms: number): void {
    try {
        navigator.vibrate?.(ms);
    } catch {
        // unsupported / blocked — nothing to do
    }
}
