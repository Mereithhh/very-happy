import { describe, expect, it, vi } from 'vitest';
import {
    consumeGoogleLoginChallenge,
    hashGoogleLoginNonce,
    isGoogleOriginAllowed,
    issueGoogleLoginChallenge,
    resolveGoogleLoginConfig,
} from './googleLoginSecurity';

describe('Google login security', () => {
    it('requires an explicit browser origin allowlist with Google login', () => {
        expect(() => resolveGoogleLoginConfig({ GOOGLE_CLIENT_ID: 'client-id' } as NodeJS.ProcessEnv))
            .toThrow('GOOGLE_ALLOWED_ORIGINS');
        const config = resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'https://happy.mereith.com,http://localhost:8082',
        } as NodeJS.ProcessEnv);
        expect(isGoogleOriginAllowed('https://happy.mereith.com', config)).toBe(true);
        expect(isGoogleOriginAllowed('https://evil.example', config)).toBe(false);
        expect(isGoogleOriginAllowed(undefined, config)).toBe(false);
        expect(() => resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'https://user:password@happy.mereith.com',
        } as NodeJS.ProcessEnv)).toThrow('plain origins');
        expect(() => resolveGoogleLoginConfig({
            GOOGLE_CLIENT_ID: 'client-id',
            GOOGLE_ALLOWED_ORIGINS: 'http://happy.example.com',
        } as NodeJS.ProcessEnv)).toThrow('must use https');
    });

    it('stores only a nonce hash with a five-minute expiry', async () => {
        const execute = vi.fn().mockResolvedValue(1);
        const nowMs = Date.UTC(2026, 7, 24, 0, 0, 0);
        const challenge = await issueGoogleLoginChallenge({
            $executeRawUnsafe: execute,
            $queryRawUnsafe: vi.fn(),
        } as any, nowMs);
        expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge.expiresAt.getTime()).toBe(nowMs + 5 * 60 * 1000);
        expect(execute.mock.calls[1][1]).toBe(hashGoogleLoginNonce(challenge.nonce));
        expect(execute.mock.calls[1].join(' ')).not.toContain(challenge.nonce);
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
