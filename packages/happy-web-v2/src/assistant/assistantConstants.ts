/**
 * Assistant (B-051) release knobs — kept in their own file so a CLI release
 * only has to touch this one constant.
 */

/** Minimum happy-cli version whose daemon understands the assistant variant
 *  (spawn dedupe tag + self-managed cwd). Bump on CLI releases. */
export const ASSISTANT_MIN_CLI_VERSION = '0.2.34';

/** Compatibility placeholder — new daemons pick their own cwd for assistant
 *  sessions; this only satisfies the spawn RPC's required `directory`. */
export const ASSISTANT_DIRECTORY = '~/.happy/assistant';

/** Server contract: POST /v1/voice/tts rejects text > 2000 chars (400), so
 *  the sentence-boundary truncation MUST happen client-side before the call. */
export const TTS_MAX_CHARS = 2000;

/** Press-and-hold shorter than this is treated as an accidental tap and the
 *  recording is discarded without transcription. */
export const MIN_HOLD_MS = 500;
