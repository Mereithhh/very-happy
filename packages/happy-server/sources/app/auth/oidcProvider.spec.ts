import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockIdp, type MockIdp } from './oidcTestIdp';

vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/modules/encrypt', () => ({
    encryptString: (_path: string[], value: string) => new TextEncoder().encode(value),
    decryptString: (_path: string[], bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));

import {
    buildAuthorizationUrl,
    hashOidcValue,
    isEmailDomainAllowed,
    loadOidcDiscovery,
    OidcProtocolError,
    resetOidcCachesForTests,
    resolveOidcConfig,
    resolveRedirectUri,
    resolveWebReturnBase,
    verifyOidcIdToken, splitDisplayName,
} from './oidcProvider';

describe('B-620 OIDC provider (discovery, JWKS, id_token)', () => {
    let idp: MockIdp;
    beforeAll(async () => { idp = await startMockIdp(); });
    afterAll(async () => { await idp.close(); });
    beforeEach(() => resetOidcCachesForTests());

    const env = () => ({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_DISPLAY_NAME: 'Apodex SSO', OIDC_ALLOWED_EMAIL_DOMAINS: 'apodex.com, Tanka.ai' } as NodeJS.ProcessEnv);

    it('is disabled without OIDC_ISSUER and rejects an issuer without a client id', () => {
        expect(resolveOidcConfig({} as NodeJS.ProcessEnv)).toBeNull();
        expect(() => resolveOidcConfig({ OIDC_ISSUER: 'https://sso.example.com' } as NodeJS.ProcessEnv)).toThrow(/OIDC_CLIENT_ID/);
        expect(() => resolveOidcConfig({ OIDC_ISSUER: 'http://sso.example.com', OIDC_CLIENT_ID: 'x' } as NodeJS.ProcessEnv)).toThrow(/https/);
    });

    it('normalises the configuration (trailing slash, scopes, domains, display name)', () => {
        const config = resolveOidcConfig({ ...env(), OIDC_ISSUER: `${idp.issuer}/`, OIDC_SCOPES: 'profile email' })!;
        expect(config.issuer).toBe(idp.issuer);
        expect(config.scopes).toBe('openid profile email');
        expect(config.displayName).toBe('Apodex SSO');
        expect([...config.allowedEmailDomains]).toEqual(['apodex.com', 'tanka.ai']);
        expect(isEmailDomainAllowed('Someone@Apodex.com', config)).toBe(true);
        expect(isEmailDomainAllowed('someone@gmail.com', config)).toBe(false);
        expect(isEmailDomainAllowed(undefined, config)).toBe(false);
        expect(isEmailDomainAllowed(undefined, { ...config, allowedEmailDomains: new Set() })).toBe(true);
    });

    it('B-626: OIDC_LINK_BY_EMAIL is off unless set to "verified"', () => {
        expect(resolveOidcConfig(env())!.linkByEmail).toBe(false);
        expect(resolveOidcConfig({ ...env(), OIDC_LINK_BY_EMAIL: 'off' })!.linkByEmail).toBe(false);
        expect(resolveOidcConfig({ ...env(), OIDC_LINK_BY_EMAIL: ' Verified ' })!.linkByEmail).toBe(true);
        expect(() => resolveOidcConfig({ ...env(), OIDC_LINK_BY_EMAIL: 'on' })).toThrow(/OIDC_LINK_BY_EMAIL/);
    });

    it('derives redirect and return URLs from PUBLIC_URL, proxy headers, or explicit overrides', () => {
        const config = resolveOidcConfig(env())!;
        const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'vibe-test.apodex.site', host: '10.0.0.5:3005' };
        delete process.env.PUBLIC_URL;
        expect(resolveRedirectUri(config, { headers })).toBe('https://vibe-test.apodex.site/v1/auth/oidc/callback');
        expect(resolveWebReturnBase(config, { headers })).toBe('https://vibe-test.apodex.site');
        process.env.PUBLIC_URL = 'https://api.example.com/';
        expect(resolveRedirectUri(config, { headers })).toBe('https://api.example.com/v1/auth/oidc/callback');
        delete process.env.PUBLIC_URL;
        const explicit = resolveOidcConfig({ ...env(), OIDC_REDIRECT_URL: 'https://x.example.com/cb', OIDC_WEB_RETURN_URL: 'https://web.example.com/' })!;
        expect(resolveRedirectUri(explicit, { headers })).toBe('https://x.example.com/cb');
        expect(resolveWebReturnBase(explicit, { headers })).toBe('https://web.example.com');
    });

    it('loads discovery once, builds a PKCE authorization URL, and verifies a signed id_token', async () => {
        const config = resolveOidcConfig(env())!;
        const fetchImpl = vi.fn(fetch);
        const discovery = await loadOidcDiscovery(config.issuer, { fetchImpl });
        await loadOidcDiscovery(config.issuer, { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(discovery.jwks_uri).toBe(`${idp.issuer}/jwks`);

        const url = new URL(buildAuthorizationUrl(discovery, config, { state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'https://a/cb' }));
        expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: idp.clientId, scope: 'openid profile email', state: 's', nonce: 'n', code_challenge: 'c', code_challenge_method: 'S256', redirect_uri: 'https://a/cb' });

        const now = Math.floor(Date.now() / 1000);
        const token = idp.signIdToken({ iss: idp.issuer, aud: idp.clientId, sub: 'u1', iat: now, exp: now + 60, nonce: 'nonce-1', email: 'Jo@Apodex.com', name: 'Jo', preferred_username: 'Jo.Doe' });
        const claims = await verifyOidcIdToken(token, { issuer: config.issuer, clientId: config.clientId, jwksUri: discovery.jwks_uri, expectedNonceHash: hashOidcValue('nonce-1'), fetchImpl });
        expect(claims).toEqual({ sub: 'u1', email: 'jo@apodex.com', emailVerified: false, name: 'Jo', picture: undefined, preferredUsername: 'jo.doe' });
    });

    it('rejects wrong nonce, audience, issuer, expiry, and tampered signatures', async () => {
        const config = resolveOidcConfig(env())!;
        const discovery = await loadOidcDiscovery(config.issuer);
        const now = Math.floor(Date.now() / 1000);
        const base = { iss: idp.issuer, aud: idp.clientId, sub: 'u1', iat: now, exp: now + 60, nonce: 'nonce-1' };
        const verify = (token: string) => verifyOidcIdToken(token, { issuer: config.issuer, clientId: config.clientId, jwksUri: discovery.jwks_uri, expectedNonceHash: hashOidcValue('nonce-1') });
        await expect(verify(idp.signIdToken({ ...base, nonce: 'other' }))).rejects.toBeInstanceOf(OidcProtocolError);
        await expect(verify(idp.signIdToken({ ...base, aud: 'someone-else' }))).rejects.toThrow('invalid_id_token');
        await expect(verify(idp.signIdToken({ ...base, iss: 'https://evil.example.com' }))).rejects.toThrow('invalid_id_token');
        await expect(verify(idp.signIdToken({ ...base, exp: now - 1 }))).rejects.toThrow('invalid_id_token');
        const good = idp.signIdToken(base);
        const [h, p, s] = good.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ ...base, sub: 'u2' })).toString('base64url');
        await expect(verify(`${h}.${tamperedPayload}.${s}`)).rejects.toThrow('invalid_id_token');
        await expect(verify('not-a-jwt')).rejects.toThrow('invalid_id_token');
        // `alg: none` style header is refused before any key lookup.
        const noneHeader = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
        await expect(verify(`${noneHeader}.${p}.`)).rejects.toThrow('invalid_id_token');
    });

    it('fails closed when discovery is unreachable or inconsistent', async () => {
        await expect(loadOidcDiscovery('http://127.0.0.1:9', { fetchImpl: fetch })).rejects.toThrow('discovery_failed');
        const lying = vi.fn(async () => new Response(JSON.stringify({ issuer: 'https://other', authorization_endpoint: 'a', token_endpoint: 'b', jwks_uri: 'c' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        await expect(loadOidcDiscovery(idp.issuer, { fetchImpl: lying as unknown as typeof fetch })).rejects.toThrow('discovery_failed');
    });

    it('splits an IdP display name into first/last and keeps single-token names whole', () => {
        expect(splitDisplayName('Alex Rivera')).toEqual({ firstName: 'Alex', lastName: 'Rivera' });
        expect(splitDisplayName('  Mary Ann  Lee ')).toEqual({ firstName: 'Mary', lastName: 'Ann  Lee' });
        expect(splitDisplayName('魏晨')).toEqual({ firstName: '魏晨', lastName: null });
        expect(splitDisplayName('   ')).toEqual({ firstName: null, lastName: null });
        expect(splitDisplayName(undefined)).toEqual({ firstName: null, lastName: null });
    });
});
