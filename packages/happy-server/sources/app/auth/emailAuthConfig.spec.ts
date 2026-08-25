import { describe, expect, it } from 'vitest';
import { assertUsableInteractiveAuth, isPasswordLoginEnabled, resolveEmailAuthConfig } from './emailAuthConfig';

describe('email auth config', () => {
    it('keeps password compatibility and email disabled by default', () => {
        expect(isPasswordLoginEnabled({})).toBe(true);
        expect(resolveEmailAuthConfig({})).toBeNull();
    });

    it('resolves Cloudflare and Resend without exposing interchangeable credentials', () => {
        expect(resolveEmailAuthConfig({
            AUTH_EMAIL_PROVIDER: 'cloudflare',
            AUTH_EMAIL_FROM: 'login@veryhappy.dev',
            CLOUDFLARE_EMAIL_ACCOUNT_ID: 'account',
            CLOUDFLARE_EMAIL_API_TOKEN: 'token',
        })).toMatchObject({ provider: 'cloudflare', ttlMinutes: 10, cloudflare: { accountId: 'account' } });
        expect(resolveEmailAuthConfig({
            AUTH_EMAIL_PROVIDER: 'resend',
            AUTH_EMAIL_FROM: 'login@veryhappy.dev',
            RESEND_API_KEY: 'key',
            AUTH_EMAIL_CODE_TTL_MINUTES: '7',
        })).toMatchObject({ provider: 'resend', ttlMinutes: 7, resend: { apiKey: 'key' } });
    });

    it('accepts a display name without allowing header injection', () => {
        expect(resolveEmailAuthConfig({
            AUTH_EMAIL_PROVIDER: 'resend',
            AUTH_EMAIL_FROM: 'Very Happy <login@example.com>',
            RESEND_API_KEY: 'key',
        })?.from).toBe('Very Happy <login@example.com>');
        expect(() => resolveEmailAuthConfig({
            AUTH_EMAIL_PROVIDER: 'resend',
            AUTH_EMAIL_FROM: 'Very Happy <login@example.com>\r\nBcc: attacker@example.com',
            RESEND_API_KEY: 'key',
        })).toThrow('AUTH_EMAIL_FROM');
    });

    it.each([
        [{ AUTH_EMAIL_PROVIDER: 'smtp' }, 'AUTH_EMAIL_PROVIDER'],
        [{ AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'bad', RESEND_API_KEY: 'key' }, 'AUTH_EMAIL_FROM'],
        [{ AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'a@example.com' }, 'RESEND_API_KEY'],
        [{ AUTH_PASSWORD_LOGIN_DISABLED: 'yes' }, 'AUTH_PASSWORD_LOGIN_DISABLED'],
        [{ AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'a@example.com', RESEND_API_KEY: 'key', MAX_PENDING_EMAIL_LOGIN_CHALLENGES: '0' }, 'MAX_PENDING_EMAIL_LOGIN_CHALLENGES'],
        [{ AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'a@example.com', RESEND_API_KEY: 'key', AUTH_EMAIL_GLOBAL_DAILY_SEND_LIMIT: 'nope' }, 'AUTH_EMAIL_GLOBAL_DAILY_SEND_LIMIT'],
    ])('fails closed on invalid configuration %#', (env, message) => {
        expect(() => 'AUTH_PASSWORD_LOGIN_DISABLED' in env
            ? isPasswordLoginEnabled(env)
            : resolveEmailAuthConfig(env)).toThrow(message);
    });

    it('refuses to start with every interactive login mechanism disabled', () => {
        expect(() => assertUsableInteractiveAuth({ email: null, googleClientId: null, passwordLoginEnabled: false }))
            .toThrow('neither Email OTP nor Google');
        expect(() => assertUsableInteractiveAuth({ email: null, googleClientId: 'google', passwordLoginEnabled: false }))
            .not.toThrow();
    });
});
