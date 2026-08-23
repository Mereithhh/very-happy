import { describe, expect, it } from 'vitest';
import { safeJsonParseError } from '../routes/connectRoutes';
import { authCheckLog } from './enableAuthentication';
import { notFoundLog } from './enableErrorHandlers';

describe('sensitive request logging', () => {
    it('does not include a malformed raw body sentinel', () => {
        const sentinel = 'RAW_BODY_SENTINEL_password_oauth_code';
        const message = safeJsonParseError('POST', '/v1/connect/github/callback', `{${sentinel}`);
        expect(message).toContain('body bytes:');
        expect(message).not.toContain(sentinel);
    });

    it('never formats bearer or cookie sentinel values', () => {
        const bearer = 'BEARER_SENTINEL_super_secret';
        const cookie = 'COOKIE_SENTINEL_session';
        const output = [authCheckLog('/v1/account', true), notFoundLog('GET', '/missing', true)].join('\n');
        expect(output).not.toContain(bearer);
        expect(output).not.toContain(cookie);
        expect(output).toContain('has authorization: true');
    });
});
