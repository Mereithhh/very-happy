import { describe, expect, it } from 'vitest';
import { wrapperSupportsSteer } from './steerSupport';

describe('wrapperSupportsSteer (B-628)', () => {
    it('Claude: by claude-steer-v1, as before', () => {
        expect(wrapperSupportsSteer('claude', ['claude-steer-v1'])).toBe(true);
        expect(wrapperSupportsSteer(undefined, ['claude-steer-v1'])).toBe(true);
        expect(wrapperSupportsSteer('claude', ['prompt-queue-v1'])).toBe(false);
    });

    it('Codex: only a wrapper advertising codex-steer-v1 — an older CLI shows no Steer', () => {
        expect(wrapperSupportsSteer('codex', ['prompt-queue-v1', 'codex-steer-v1'])).toBe(true);
        expect(wrapperSupportsSteer('codex', ['prompt-queue-v1'])).toBe(false);
        expect(wrapperSupportsSteer('codex', undefined)).toBe(false);
        // The capabilities are not interchangeable across agents.
        expect(wrapperSupportsSteer('codex', ['claude-steer-v1'])).toBe(false);
        expect(wrapperSupportsSteer('claude', ['codex-steer-v1'])).toBe(false);
    });

    it('other agents never steer', () => {
        expect(wrapperSupportsSteer('gemini', ['codex-steer-v1', 'claude-steer-v1'])).toBe(false);
        expect(wrapperSupportsSteer('acp', ['claude-steer-v1'])).toBe(false);
    });
});
