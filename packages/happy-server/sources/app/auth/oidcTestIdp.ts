/**
 * Test-only mock OpenID provider: discovery, JWKS, and a token endpoint that
 * checks PKCE (S256) + client secret and mints an RS256 id_token. Used by the
 * B-620 specs; never imported by runtime code.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

export interface MockIdp {
    issuer: string;
    clientId: string;
    clientSecret: string;
    /** The nonce + PKCE challenge the next token request must match (set from the authorize URL). */
    expect: { nonce: string; codeChallenge: string; redirectUri: string } | null;
    /** Claims merged into the next id_token. */
    claims: Record<string, unknown>;
    /** Override the id_token nonce (for negative tests). */
    nonceOverride: string | null;
    tokenRequests: number;
    close: () => Promise<void>;
    signIdToken: (claims: Record<string, unknown>) => string;
}

function b64url(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
}

export async function startMockIdp(options: { clientId?: string; clientSecret?: string } = {}): Promise<MockIdp> {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'test-key-1';
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };
    const clientId = options.clientId ?? 'very-happy-test';
    const clientSecret = options.clientSecret ?? 'test-client-secret';

    const idp: MockIdp = {
        issuer: '',
        clientId,
        clientSecret,
        expect: null,
        claims: {},
        nonceOverride: null,
        tokenRequests: 0,
        close: async () => {},
        signIdToken: () => '',
    };

    const sign = (claims: Record<string, unknown>, key: KeyObject) => {
        const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
        const payload = b64url(JSON.stringify(claims));
        const signer = createSign('RSA-SHA256');
        signer.update(`${header}.${payload}`);
        return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
    };
    idp.signIdToken = (claims) => sign(claims, privateKey);

    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', idp.issuer);
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (url.pathname === '/.well-known/openid-configuration') {
            return json(200, {
                issuer: idp.issuer,
                authorization_endpoint: `${idp.issuer}/authorize`,
                token_endpoint: `${idp.issuer}/token`,
                jwks_uri: `${idp.issuer}/jwks`,
                token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
                id_token_signing_alg_values_supported: ['RS256'],
            });
        }
        if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
        if (url.pathname === '/token' && req.method === 'POST') {
            let raw = '';
            req.on('data', (chunk) => { raw += chunk; });
            req.on('end', () => {
                idp.tokenRequests += 1;
                const form = new URLSearchParams(raw);
                const expected = idp.expect;
                if (!expected) return json(400, { error: 'invalid_request' });
                if (form.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
                if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
                if (form.get('redirect_uri') !== expected.redirectUri) return json(400, { error: 'invalid_grant', reason: 'redirect_uri' });
                if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', reason: 'code' });
                const verifier = form.get('code_verifier') ?? '';
                if (createHash('sha256').update(verifier).digest('base64url') !== expected.codeChallenge) {
                    return json(400, { error: 'invalid_grant', reason: 'pkce' });
                }
                const now = Math.floor(Date.now() / 1000);
                const idToken = sign({
                    iss: idp.issuer,
                    aud: clientId,
                    sub: 'subject-1',
                    iat: now,
                    exp: now + 300,
                    nonce: idp.nonceOverride ?? expected.nonce,
                    ...idp.claims,
                }, privateKey);
                return json(200, { access_token: 'opaque', token_type: 'Bearer', id_token: idToken });
            });
            return;
        }
        json(404, { error: 'not_found' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    idp.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    return idp;
}
