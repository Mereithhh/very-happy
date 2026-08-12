/**
 * TTS status classification (B-051 review W3).
 *
 * The server normalizes upstream (ElevenLabs) failures to 502/429; only 404
 * (old server, route missing) and 501 (voice not configured) may trigger the
 * STICKY pure-text degrade. A transient upstream error must never permanently
 * mute the assistant.
 */
import { describe, it, expect } from 'vitest';
import { classifyTtsErrorStatus } from './ttsStatus';

describe('classifyTtsErrorStatus', () => {
    it('404 (route missing = old server) → unsupported (sticky degrade)', () => {
        expect(classifyTtsErrorStatus(404)).toBe('unsupported');
    });

    it('501 (voice not configured) → unsupported (sticky degrade)', () => {
        expect(classifyTtsErrorStatus(501)).toBe('unsupported');
    });

    it('429 (rate limited) → rate-limited, NOT unsupported', () => {
        expect(classifyTtsErrorStatus(429)).toBe('rate-limited');
    });

    it('502 (normalized upstream failure) is transient, never unsupported', () => {
        expect(classifyTtsErrorStatus(502)).toBe('error');
    });

    it.each([400, 401, 403, 500, 503])('%i is transient error (skip utterance, keep voice mode)', (status) => {
        expect(classifyTtsErrorStatus(status)).toBe('error');
    });
});
