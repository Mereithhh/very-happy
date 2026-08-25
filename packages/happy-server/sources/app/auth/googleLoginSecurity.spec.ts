import { describe, expect, it, vi } from 'vitest';
import {
    consumeGoogleLoginChallenge,
    hashGoogleLoginNonce,
    isGoogleOriginAllowed,
    issueGoogleLoginChallenge,
    maxPendingGoogleLoginChallenges,
    resolveGoogleLoginConfig,
} from './googleLoginSecurity';

describe('Google login security', () => {
    it('requires an explicit browser origin allowlist with Google login', () => {
        expect(() => resolveGoogleLoginConfig({ GOOGLE_CLIENT_ID: 'client-id' } as NodeJS.ProcessEnv))
            .toThrow('GOOGLE_ALLOWED_ORIGINS');
        const config = resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'https://veryhappy.dev,http://localhost:8082',
        } as NodeJS.ProcessEnv);
        expect(isGoogleOriginAllowed('https://veryhappy.dev', config)).toBe(true);
        expect(isGoogleOriginAllowed('https://evil.example', config)).toBe(false);
        expect(isGoogleOriginAllowed(undefined, config)).toBe(false);
        expect(() => resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'https://user:password@veryhappy.dev',
        } as NodeJS.ProcessEnv)).toThrow('plain origins');
        expect(() => resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'http://happy.example.com',
        } as NodeJS.ProcessEnv)).toThrow('must use https');
    });

    it('stores only a nonce hash with a five-minute expiry', async () => {
        const execute = vi.fn().mockResolvedValue(1);
        const query = vi.fn()
            .mockResolvedValueOnce([{ key: 'google-login-challenge-create-cap' }])
            .mockResolvedValueOnce([{ count: 0n }]);
        const nowMs = Date.UTC(2026, 7, 24, 0, 0, 0);
        const challenge = await issueGoogleLoginChallenge({
            $executeRawUnsafe: execute,
            $queryRawUnsafe: query,
        } as any, nowMs);
        expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge.expiresAt.getTime()).toBe(nowMs + 5 * 60 * 1000);
        expect(execute.mock.calls[2][1]).toBe(hashGoogleLoginNonce(challenge.nonce));
        expect(execute.mock.calls[2].join(' ')).not.toContain(challenge.nonce);
    });

    it('serializes creation and fails closed at the global outstanding cap', async () => {
        process.env.MAX_PENDING_GOOGLE_LOGIN_CHALLENGES = '1';
        const execute = vi.fn().mockResolvedValue(1);
        const query = vi.fn()
            .mockResolvedValueOnce([{ key: 'google-login-challenge-create-cap' }])
            .mockResolvedValueOnce([{ count: 1n }]);
        await expect(issueGoogleLoginChallenge({
            $executeRawUnsafe: execute,
            $queryRawUnsafe: query,
        } as any)).rejects.toThrow('google-login-challenge-capacity');
        expect(execute).toHaveBeenCalledTimes(2);
        delete process.env.MAX_PENDING_GOOGLE_LOGIN_CHALLENGES;
        expect(maxPendingGoogleLoginChallenges()).toBe(10_000);
    });

    it('accepts only the single successful atomic consume', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([{ nonceHash: hashGoogleLoginNonce('nonce') }])
            .mockResolvedValueOnce([]);
        const client = { $queryRawUnsafe: query, $executeRawUnsafe: vi.fn() } as any;
        await expect(consumeGoogleLoginChallenge(client, 'nonce')).resolves.toBe(true);
        await expect(consumeGoogleLoginChallenge(client, 'nonce')).resolves.toBe(false);
    });
});
