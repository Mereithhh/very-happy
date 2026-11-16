import { describe, expect, it } from 'vitest';
import { isSessionPeerPrompt, promptIdentity, shouldHoldNonUser } from './nonUserPrompt';

describe('nonUserPrompt (B-940)', () => {
    it('only a session-peer message is another session\'s', () => {
        expect(isSessionPeerPrompt({ sentFrom: 'session-peer' })).toBe(true);
        for (const sentFrom of ['web', 'mobile', 'cli', 'team', 'automation', 'issue', undefined]) {
            expect(isSessionPeerPrompt({ sentFrom })).toBe(false);
        }
        expect(isSessionPeerPrompt(undefined)).toBe(false);
    });

    it('the owner\'s prompts stay human; another session\'s are synthetic with no origin', () => {
        expect(promptIdentity(false)).toEqual({ origin: { kind: 'human' } });
        expect(promptIdentity(undefined)).toEqual({ origin: { kind: 'human' } });
        expect(promptIdentity(true)).toEqual({ isSynthetic: true });
    });

    it('holds only another session\'s message, and only while a turn is open', () => {
        expect(shouldHoldNonUser({ synthetic: true, turnOpen: true })).toBe(true);
        expect(shouldHoldNonUser({ synthetic: true, turnOpen: false })).toBe(false);
        expect(shouldHoldNonUser({ synthetic: false, turnOpen: true })).toBe(false);
        expect(shouldHoldNonUser({ turnOpen: true })).toBe(false);
    });
});
