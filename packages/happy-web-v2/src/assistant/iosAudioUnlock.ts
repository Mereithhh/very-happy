/**
 * iOS/Safari audio unlock for the assistant (B-051).
 *
 * Two locks exist on iOS:
 *  1. autoplay policy — an AudioContext starts 'suspended' and `<audio>.play()`
 *     rejects until BOTH are exercised inside a user gesture;
 *  2. the hardware mute switch silences Web Audio output — UNLESS an HTML
 *     `<audio>` element is (or was) playing, which promotes the page's audio
 *     session to "playback" (the unmute-ios-audio trick): we keep a silent
 *     looping element alive for the whole assistant visit.
 *
 * Unlock state lives in memory only (assistantStore) — every page load needs
 * a fresh gesture by platform rule.
 */

// B-058: the keep-alive element must loop a REAL length of silence. A
// 1-sample WAV loops every ~23µs and thrashes the media stack hard enough to
// freeze the whole page. We synthesize ~1s of silence at runtime instead
// (8kHz mono 16-bit ≈ 16KB) and hand it over as a blob URL.
export function buildSilentWavBuffer(seconds = 1): ArrayBuffer {
    const sampleRate = 8000;
    const numSamples = Math.max(1, Math.round(seconds * sampleRate));
    const dataBytes = numSamples * 2; // 16-bit mono
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true); // PCM chunk size
    v.setUint16(20, 1, true); // PCM format
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    v.setUint32(40, dataBytes, true);
    // sample data is already zeroed (silence)
    return buf;
}

export function buildSilentWavBlobUrl(seconds = 1): string {
    return URL.createObjectURL(new Blob([buildSilentWavBuffer(seconds)], { type: 'audio/wav' }));
}

let sharedCtx: AudioContext | null = null;
let keepAliveEl: HTMLAudioElement | null = null;
let keepAliveUrl: string | null = null;

/** Lazily create the module-wide AudioContext used for TTS playback. */
export function getAssistantAudioContext(): AudioContext | null {
    if (sharedCtx) return sharedCtx;
    const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
        sharedCtx = new Ctor();
    } catch {
        return null;
    }
    return sharedCtx;
}

/**
 * MUST be called synchronously inside a click/pointer gesture.
 * Performs the double unlock (silent `<audio>` play + ctx.resume()) and
 * starts the mute-switch keep-alive loop. Returns whether the context ended
 * up running.
 */
export async function unlockAudioPlayback(): Promise<boolean> {
    const ctx = getAssistantAudioContext();

    // 1) HTML audio unlock + mute-switch keep-alive (looping silent element).
    try {
        if (!keepAliveEl) {
            keepAliveEl = document.createElement('audio');
            keepAliveUrl = buildSilentWavBlobUrl();
            keepAliveEl.src = keepAliveUrl;
            keepAliveEl.loop = true;
            // keep it out of the way; never added to layout flow visibly
            keepAliveEl.setAttribute('aria-hidden', 'true');
            keepAliveEl.style.display = 'none';
            document.body.appendChild(keepAliveEl);
        }
        await keepAliveEl.play();
    } catch {
        // element unlock failing is non-fatal — Web Audio may still resume
    }

    // 2) Web Audio unlock.
    if (ctx) {
        try {
            await ctx.resume();
        } catch {
            // fall through; state check below decides
        }
        return ctx.state === 'running';
    }
    return false;
}

/** Stop the keep-alive loop (leaving the assistant screen). */
export function releaseAudioKeepAlive(): void {
    if (keepAliveEl) {
        try {
            keepAliveEl.pause();
        } catch {
            // ignore
        }
        keepAliveEl.remove();
        keepAliveEl = null;
    }
    if (keepAliveUrl) {
        URL.revokeObjectURL(keepAliveUrl);
        keepAliveUrl = null;
    }
}
