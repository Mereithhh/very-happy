import { createPublicKey, verify as verifySignature } from 'crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;

interface GoogleJwk extends Record<string, unknown> {
    kid?: string;
    kty?: string;
    alg?: string;
}

interface GoogleJwksResponse {
    keys?: GoogleJwk[];
}

export interface GoogleIdentityClaims {
    sub: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
    picture?: string;
}

interface VerifyOptions {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    expectedNonce?: string;
}

let jwksCache: { keys: GoogleJwk[]; expiresAt: number } | null = null;

function decodeJsonSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function loadJwks(fetchImpl: typeof fetch, nowMs: number): Promise<GoogleJwk[]> {
    if (jwksCache && jwksCache.expiresAt > nowMs) return jwksCache.keys;
    const response = await fetchImpl(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('google-jwks-unavailable');
    const body = await response.json() as GoogleJwksResponse;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) throw new Error('google-jwks-empty');
    const cacheControl = response.headers.get('cache-control') ?? '';
    const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const ttlMs = maxAgeMatch ? Math.max(1, Number(maxAgeMatch[1])) * 1000 : DEFAULT_JWKS_TTL_MS;
    jwksCache = { keys, expiresAt: nowMs + ttlMs };
    return keys;
}

export async function verifyGoogleIdToken(
    token: string,
    clientId: string,
    options: VerifyOptions = {},
): Promise<GoogleIdentityClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('google-token-malformed');
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJsonSegment(encodedHeader);
    const payload = decodeJsonSegment(encodedPayload);

    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
        throw new Error('google-token-algorithm');
    }
    const nowMs = options.nowMs ?? Date.now();
    const keys = await loadJwks(options.fetchImpl ?? fetch, nowMs);
    const jwk = keys.find((candidate) =>
        candidate.kid === header.kid &&
        candidate.kty === 'RSA' &&
        (candidate.alg === undefined || candidate.alg === 'RS256') &&
        (candidate.use === undefined || candidate.use === 'sig'),
    );
    if (!jwk) throw new Error('google-token-key');

    const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
    const validSignature = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
    );
    if (!validSignature) throw new Error('google-token-signature');

    if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.has(payload.iss)) {
        throw new Error('google-token-issuer');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(clientId)) throw new Error('google-token-audience');
    if (audiences.length > 1 && payload.azp !== clientId) throw new Error('google-token-authorized-party');
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) {
        throw new Error('google-token-expired');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
        throw new Error('google-token-subject');
    }
    if (options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
        throw new Error('google-token-nonce');
    }

    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    return {
        sub: payload.sub,
        email: emailVerified && typeof payload.email === 'string' ? payload.email : undefined,
        emailVerified,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
}

export function resetGoogleJwksCacheForTests(): void {
    jwksCache = null;
}
