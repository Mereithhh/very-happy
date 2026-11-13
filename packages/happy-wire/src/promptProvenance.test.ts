import { describe, expect, it } from 'vitest';
import {
    isOwnerTypedMessage, nonOwnerRetryLocalId, NON_OWNER_LOCAL_ID_PREFIXES, OWNER_SENT_FROM, retryLocalIdFor, suggestionOptionLocalId,
} from './promptProvenance';

describe('B-924d prompt provenance', () => {
    it('only a client sentFrom without a reserved prefix is the owner typing', () => {
        for (const sentFrom of OWNER_SENT_FROM) expect(isOwnerTypedMessage('c0ffee', sentFrom)).toBe(true);
        for (const prefix of NON_OWNER_LOCAL_ID_PREFIXES) expect(isOwnerTypedMessage(`${prefix}x`, 'web'), prefix).toBe(false);
        expect(isOwnerTypedMessage('c0ffee', 'cli')).toBe(false);
        expect(isOwnerTypedMessage('c0ffee', undefined)).toBe(false);
        expect(isOwnerTypedMessage(null, null)).toBe(false);
    });
    it('chip clicks and non-owner retries get their reserved prefixes, unique per call', () => {
        expect(suggestionOptionLocalId()).toMatch(/^option-[a-z0-9]+$/);
        expect(nonOwnerRetryLocalId()).toMatch(/^retry-[a-z0-9]+$/);
        expect(suggestionOptionLocalId()).not.toBe(suggestionOptionLocalId());
    });
    it('a retry keeps the original\'s provenance', () => {
        expect(retryLocalIdFor({ localId: 'c0ffee', sentFrom: 'web' })).toBeUndefined();
        expect(retryLocalIdFor({ localId: 'remote-send-1', sentFrom: 'web' })).toMatch(/^retry-/);
        expect(retryLocalIdFor({ localId: '3f1c', sentFrom: 'cli' })).toMatch(/^retry-/);
        expect(retryLocalIdFor({ localId: 'option-1', sentFrom: 'web' })).toMatch(/^retry-/);
        expect(retryLocalIdFor({})).toMatch(/^retry-/);
    });
});
