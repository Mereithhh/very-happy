import { describe, expect, it } from 'vitest';
import { authExpiredAction, isCredentialsRemovedEvent, unsentMessagesClipboardText } from './authExpiry';

describe('auth expiry policy (B-825)', () => {
    it('signs out at once only when nothing is waiting to be sent', () => {
        expect(authExpiredAction([])).toBe('sign-out-now');
        expect(authExpiredAction([{ sessionId: 's', localId: 'l', text: null }])).toBe('confirm-unsent');
    });

    it('copies the unsent texts oldest first, skipping attachments', () => {
        expect(unsentMessagesClipboardText([
            { sessionId: 's', localId: 'a', text: ' one ' },
            { sessionId: 's', localId: 'b', text: null },
            { sessionId: 't', localId: 'c', text: 'two\nlines' },
        ])).toBe('one\n\ntwo\nlines');
    });

    it('another tab removing the credentials (or clearing storage) counts; anything else does not', () => {
        expect(isCredentialsRemovedEvent({ key: 'auth_credentials', newValue: null })).toBe(true);
        expect(isCredentialsRemovedEvent({ key: null, newValue: null })).toBe(true);
        expect(isCredentialsRemovedEvent({ key: 'auth_credentials', newValue: '{"token":"new"}' })).toBe(false);
        expect(isCredentialsRemovedEvent({ key: 'vh-theme', newValue: null })).toBe(false);
    });
});
