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

// Minimal valid silent WAV (1 sample, 44.1kHz mono 16-bit) as a data URL —
// no network fetch, allowed as a media source everywhere.
const SILENT_WAV =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

let sharedCtx: AudioContext | null = null;
let keepAliveEl: HTMLAudioElement | null = null;

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
            keepAliveEl.src = SILENT_WAV;
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
}
