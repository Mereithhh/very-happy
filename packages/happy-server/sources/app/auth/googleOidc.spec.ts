import { generateKeyPairSync, sign } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetGoogleJwksCacheForTests, verifyGoogleIdToken } from './googleOidc';

const clientId = 'client.apps.googleusercontent.com';
const nowMs = Date.UTC(2026, 7, 23, 0, 0, 0);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256', use: 'sig' };

function token(payloadOverrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT', ...headerOverrides })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: clientId,
        exp: Math.floor(nowMs / 1000) + 300,
        sub: 'google-user-1',
        email: 'user@example.com',
        email_verified: true,
        ...payloadOverrides,
    })).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
}

function fetchJwks(): typeof fetch {
    return (async () => new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
    })) as typeof fetch;
}

describe('Google OIDC verification', () => {
    beforeEach(() => resetGoogleJwksCacheForTests());

    it('verifies signature and required identity claims', async () => {
        await expect(verifyGoogleIdToken(token(), clientId, { fetchImpl: fetchJwks(), nowMs })).resolves.toMatchObject({
            sub: 'google-user-1',
            email: 'user@example.com',
            emailVerified: true,
        });
    });

    it.each([
        ['issuer', { iss: 'https://evil.example' }, 'google-token-issuer'],
        ['audience', { aud: 'another-client' }, 'google-token-audience'],
        ['expiry', { exp: Math.floor(nowMs / 1000) - 1 }, 'google-token-expired'],
        ['subject', { sub: '' }, 'google-token-subject'],
    ])('rejects invalid %s', async (_label, overrides, error) => {
        await expect(verifyGoogleIdToken(token(overrides), clientId, { fetchImpl: fetchJwks(), nowMs })).rejects.toThrow(error);
    });

    it('rejects an invalid signature and non-RS256 token', async () => {
        const parts = token().split('.');
        const signature = parts[2];
        // Change a significant base64url sextet. Mutating the final character can
        // touch only unused padding bits and decode to the same signature bytes.
        const tampered = `${parts[0]}.${parts[1]}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
        await expect(verifyGoogleIdToken(tampered, clientId, { fetchImpl: fetchJwks(), nowMs })).rejects.toThrow();
        await expect(verifyGoogleIdToken(token({}, { alg: 'HS256' }), clientId, { fetchImpl: fetchJwks(), nowMs }))
            .rejects.toThrow('google-token-algorithm');
    });

    it('does not trust an unverified email claim', async () => {
        await expect(verifyGoogleIdToken(token({ email_verified: false }), clientId, { fetchImpl: fetchJwks(), nowMs }))
            .resolves.toMatchObject({ email: undefined, emailVerified: false });
    });

    it('requires this client to be the authorized party for multi-audience tokens', async () => {
        await expect(verifyGoogleIdToken(
            token({ aud: [clientId, 'another-client'], azp: 'another-client' }),
            clientId,
            { fetchImpl: fetchJwks(), nowMs },
        )).rejects.toThrow('google-token-authorized-party');
        await expect(verifyGoogleIdToken(
            token({ aud: [clientId, 'another-client'], azp: clientId }),
            clientId,
            { fetchImpl: fetchJwks(), nowMs },
        )).resolves.toMatchObject({ sub: 'google-user-1' });
    });

    it('requires the signed nonce claim to match the issued challenge', async () => {
        await expect(verifyGoogleIdToken(
            token({ nonce: 'issued-nonce' }),
            clientId,
            { fetchImpl: fetchJwks(), nowMs, expectedNonce: 'issued-nonce' },
        )).resolves.toMatchObject({ sub: 'google-user-1' });
        await expect(verifyGoogleIdToken(
            token({ nonce: 'different-nonce' }),
            clientId,
            { fetchImpl: fetchJwks(), nowMs, expectedNonce: 'issued-nonce' },
        )).rejects.toThrow('google-token-nonce');
        await expect(verifyGoogleIdToken(
            token(),
            clientId,
            { fetchImpl: fetchJwks(), nowMs, expectedNonce: 'issued-nonce' },
        )).rejects.toThrow('google-token-nonce');
    });
});
