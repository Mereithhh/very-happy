import { describe, expect, it } from 'vitest';
import { resolveGithubWebappUrl, safeJsonParseError } from '../routes/connectRoutes';
import { authCheckLog, safeRequestPath } from './enableAuthentication';
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

    it('removes OAuth code and state from every logged or echoed path', () => {
        const path = safeRequestPath('/v1/connect/github/callback?code=CODE_SENTINEL&state=STATE_SENTINEL');
        expect(path).toBe('/v1/connect/github/callback');
        expect(authCheckLog(path, false)).not.toMatch(/CODE_SENTINEL|STATE_SENTINEL/);
        expect(notFoundLog('GET', path, false)).not.toMatch(/CODE_SENTINEL|STATE_SENTINEL/);
    });

    it('only redirects GitHub OAuth to an explicitly configured safe Web origin', () => {
        const previous = process.env.PUBLIC_WEBAPP_URL;
        process.env.PUBLIC_WEBAPP_URL = 'https://relay.example.com/app';
        expect(resolveGithubWebappUrl()).toBe('https://relay.example.com/');
        process.env.PUBLIC_WEBAPP_URL = 'http://evil.example.com';
        expect(resolveGithubWebappUrl()).toBeNull();
        if (previous === undefined) delete process.env.PUBLIC_WEBAPP_URL;
        else process.env.PUBLIC_WEBAPP_URL = previous;
    });
});
