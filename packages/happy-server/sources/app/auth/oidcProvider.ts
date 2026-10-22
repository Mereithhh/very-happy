/**
 * B-620: generic OpenID Connect login (authorization code + PKCE).
 *
 * One issuer per server, configured through `OIDC_*` environment variables.
 * Identity rows use provider key `oidc:<issuer>` so a later multi-issuer
 * setup needs no migration. Everything that leaves this process is either a
 * hash (state/nonce/handoff lookups) or encrypted under the server master key
 * (PKCE verifier, handoff payload); the browser only ever carries opaque codes.
 *
 * Token verification uses Node `crypto` only (RS256/ES256 via the issuer's
 * JWKS), mirroring `googleOidc.ts`. Discovery and JWKS are cached in memory;
 * an unknown `kid` forces one JWKS refresh (rate-limited) before failing.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { decryptString, encryptString } from '@/modules/encrypt';

const OIDC_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const OIDC_HANDOFF_TTL_MS = 2 * 60 * 1000;
const OIDC_CHALLENGE_CREATE_LOCK_KEY = 'oidc-login-challenge-create-cap';
const DEFAULT_MAX_PENDING_OIDC_LOGIN_CHALLENGES = 10_000;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,64}$/;

type SqlClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

export class OidcLoginChallengeCapacityError extends Error {
    constructor() {
        super('oidc-login-challenge-capacity');
        this.name = 'OidcLoginChallengeCapacityError';
    }
}

export class OidcProtocolError extends Error {
    constructor(readonly code: 'exchange_failed' | 'invalid_id_token' | 'discovery_failed') {
        super(code);
        this.name = 'OidcProtocolError';
    }
}

export interface OidcConfig {
    issuer: string;
    clientId: string;
    clientSecret: string | null;
    displayName: string;
    scopes: string;
    /** Explicit callback URL; null → derived from PUBLIC_URL / the request. */
    redirectUrl: string | null;
    /** Explicit Web origin to send the browser back to; null → derived. */
    webReturnUrl: string | null;
    allowedEmailDomains: ReadonlySet<string>;
    /**
     * B-626: a first SSO login whose token carries `email_verified: true` may
     * attach itself to the existing account that already owns that email
     * through an Email-OTP or Google identity (both provider-verified), instead
     * of creating a second account. Off by default: a provider that does not
     * verify emails would otherwise let anyone claim a colleague's account.
     */
    linkByEmail: boolean;
}

function normalizeIssuer(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('OIDC_ISSUER must be an http(s) URL');
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (parsed.protocol === 'http:' && !loopback) throw new Error('OIDC_ISSUER must use https except for loopback development issuers');
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('OIDC_ISSUER must not carry credentials, query, or fragment');
    return parsed.toString().replace(/\/$/, '');
}

/** Returns null when `OIDC_ISSUER` is unset; throws on an inconsistent configuration. */
export function resolveOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
    const issuerRaw = env.OIDC_ISSUER?.trim();
    if (!issuerRaw) return null;
    const issuer = normalizeIssuer(issuerRaw);
    const clientId = env.OIDC_CLIENT_ID?.trim();
    if (!clientId) throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is configured');
    const redirectUrl = env.OIDC_REDIRECT_URL?.trim() || null;
    if (redirectUrl) new URL(redirectUrl);
    const webReturnUrl = env.OIDC_WEB_RETURN_URL?.trim() || null;
    if (webReturnUrl) new URL(webReturnUrl);
    const scopes = (env.OIDC_SCOPES?.trim() || 'openid profile email').split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) scopes.unshift('openid');
    const allowedEmailDomains = new Set((env.OIDC_ALLOWED_EMAIL_DOMAINS ?? '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean));
    return {
        issuer,
        clientId,
        clientSecret: env.OIDC_CLIENT_SECRET?.trim() || null,
        displayName: (env.OIDC_DISPLAY_NAME?.trim() || 'SSO').slice(0, 64),
        scopes: scopes.join(' '),
        redirectUrl,
        webReturnUrl,
        allowedEmailDomains,
        linkByEmail: parseLinkByEmail(env.OIDC_LINK_BY_EMAIL),
    };
}

function parseLinkByEmail(raw: string | undefined): boolean {
    const value = raw?.trim().toLowerCase();
    if (!value || value === 'off') return false;
    if (value === 'verified') return true;
    throw new Error('OIDC_LINK_BY_EMAIL must be "verified" or "off"');
}

export function oidcPublicConfig(
    config: OidcConfig | null,
    signupMode: 'open' | 'invite' | 'closed',
): { displayName: string; signupMode: 'open' | 'invite' | 'closed' } | undefined {
    return config ? { displayName: config.displayName, signupMode } : undefined;
}

/** "Alex Rivera" → first/last; a single token (e.g. a CJK full name) stays in firstName. */
export function splitDisplayName(name: string | undefined): { firstName: string | null; lastName: string | null } {
    const trimmed = name?.trim();
    if (!trimmed) return { firstName: null, lastName: null };
    const space = trimmed.search(/\s/);
    if (space < 0) return { firstName: trimmed, lastName: null };
    return { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space).trim() || null };
}

export function maxPendingOidcLoginChallenges(): number {
    const raw = process.env.MAX_PENDING_OIDC_LOGIN_CHALLENGES;
    if (!raw) return DEFAULT_MAX_PENDING_OIDC_LOGIN_CHALLENGES;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1_000_000
        ? parsed
        : DEFAULT_MAX_PENDING_OIDC_LOGIN_CHALLENGES;
}

export function isEmailDomainAllowed(email: string | undefined, config: OidcConfig): boolean {
    if (config.allowedEmailDomains.size === 0) return true;
    if (!email) return false;
    const at = email.lastIndexOf('@');
    if (at < 0) return false;
    return config.allowedEmailDomains.has(email.slice(at + 1).toLowerCase());
}

/** Same resolution as attachment download URLs: PUBLIC_URL, then proxy headers, then Host. */
export function resolvePublicBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
    const xfHost = request.headers['x-forwarded-host'];
    const xfProto = request.headers['x-forwarded-proto'];
    const host = (Array.isArray(xfHost) ? xfHost[0] : xfHost) ?? request.headers.host;
    const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) ?? 'http';
    if (typeof host === 'string' && host.length > 0) {
        return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}

export function resolveRedirectUri(config: OidcConfig, request: { headers: Record<string, string | string[] | undefined> }): string {
    return config.redirectUrl ?? `${resolvePublicBaseUrl(request)}/v1/auth/oidc/callback`;
}

/** Where the browser lands after the callback: `<web origin>/login/oidc`. */
export function resolveWebReturnBase(config: OidcConfig, request: { headers: Record<string, string | string[] | undefined> }): string {
    const explicit = config.webReturnUrl ?? process.env.PUBLIC_WEBAPP_URL ?? process.env.HAPPY_WEB_URL;
    return (explicit?.trim() || resolvePublicBaseUrl(request)).replace(/\/$/, '');
}

//
// Discovery + JWKS
//

export interface OidcDiscovery {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    token_endpoint_auth_methods_supported?: string[];
}

interface Jwk extends Record<string, unknown> {
    kid?: string;
    kty?: string;
    alg?: string;
    use?: string;
    crv?: string;
}

interface FetchOptions {
    fetchImpl?: typeof fetch;
    nowMs?: number;
}

const discoveryCache = new Map<string, { doc: OidcDiscovery; expiresAt: number }>();
const jwksCache = new Map<string, { keys: Jwk[]; expiresAt: number; fetchedAt: number }>();

async function fetchJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
}

export async function loadOidcDiscovery(issuer: string, options: FetchOptions = {}): Promise<OidcDiscovery> {
    const nowMs = options.nowMs ?? Date.now();
    const cached = discoveryCache.get(issuer);
    if (cached && cached.expiresAt > nowMs) return cached.doc;
    const fetchImpl = options.fetchImpl ?? fetch;
    let result;
    try {
        result = await fetchJson(fetchImpl, `${issuer}/.well-known/openid-configuration`);
    } catch {
        throw new OidcProtocolError('discovery_failed');
    }
    const doc = result.body as Partial<OidcDiscovery> | null;
    if (!result.ok || !doc || typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string' || typeof doc.jwks_uri !== 'string' || typeof doc.issuer !== 'string') {
        throw new OidcProtocolError('discovery_failed');
    }
    if (doc.issuer.replace(/\/$/, '') !== issuer) throw new OidcProtocolError('discovery_failed');
    const validated: OidcDiscovery = {
        issuer: doc.issuer,
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        jwks_uri: doc.jwks_uri,
        token_endpoint_auth_methods_supported: Array.isArray(doc.token_endpoint_auth_methods_supported)
            ? doc.token_endpoint_auth_methods_supported.filter((value): value is string => typeof value === 'string')
            : undefined,
    };
    discoveryCache.set(issuer, { doc: validated, expiresAt: nowMs + DISCOVERY_TTL_MS });
    return validated;
}

async function loadJwks(jwksUri: string, options: FetchOptions & { forceRefresh?: boolean } = {}): Promise<Jwk[]> {
    const nowMs = options.nowMs ?? Date.now();
    const cached = jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > nowMs && !options.forceRefresh) return cached.keys;
    if (cached && options.forceRefresh && nowMs - cached.fetchedAt < JWKS_REFRESH_MIN_INTERVAL_MS) return cached.keys;
    const fetchImpl = options.fetchImpl ?? fetch;
    let result;
    try {
        result = await fetchJson(fetchImpl, jwksUri);
    } catch {
        throw new OidcProtocolError('invalid_id_token');
    }
    const keys = result.ok && result.body && Array.isArray((result.body as { keys?: unknown }).keys)
        ? (result.body as { keys: Jwk[] }).keys
        : [];
    if (keys.length === 0) throw new OidcProtocolError('invalid_id_token');
    jwksCache.set(jwksUri, { keys, expiresAt: nowMs + JWKS_TTL_MS, fetchedAt: nowMs });
    return keys;
}

export function resetOidcCachesForTests(): void {
    discoveryCache.clear();
    jwksCache.clear();
}

//
// ID token verification
//

export interface OidcIdentityClaims {
    sub: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
    picture?: string;
    preferredUsername?: string;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const SUPPORTED_ALGS: Record<string, { kty: string; crv?: string; hash: string; dsa?: 'ieee-p1363' }> = {
    RS256: { kty: 'RSA', hash: 'sha256' },
    RS384: { kty: 'RSA', hash: 'sha384' },
    RS512: { kty: 'RSA', hash: 'sha512' },
    ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', dsa: 'ieee-p1363' },
    ES384: { kty: 'EC', crv: 'P-384', hash: 'sha384', dsa: 'ieee-p1363' },
};

export function hashOidcValue(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export async function verifyOidcIdToken(
    token: string,
    options: {
        issuer: string;
        clientId: string;
        jwksUri: string;
        /** sha256 hex of the nonce we issued; compared against the token's `nonce`. */
        expectedNonceHash: string;
        fetchImpl?: typeof fetch;
        nowMs?: number;
    },
): Promise<OidcIdentityClaims> {
    const fail = () => new OidcProtocolError('invalid_id_token');
    const parts = token.split('.');
    if (parts.length !== 3) throw fail();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
        header = decodeJsonSegment(encodedHeader);
        payload = decodeJsonSegment(encodedPayload);
    } catch {
        throw fail();
    }
    const alg = typeof header.alg === 'string' ? SUPPORTED_ALGS[header.alg] : undefined;
    if (!alg) throw fail();
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const nowMs = options.nowMs ?? Date.now();

    const pick = (keys: Jwk[]) => keys.find((candidate) =>
        candidate.kty === alg.kty
        && (kid === undefined ? keys.length === 1 : candidate.kid === kid)
        && (alg.crv === undefined || candidate.crv === alg.crv)
        && (candidate.alg === undefined || candidate.alg === header.alg)
        && (candidate.use === undefined || candidate.use === 'sig'));
    let jwk = pick(await loadJwks(options.jwksUri, { fetchImpl: options.fetchImpl, nowMs }));
    if (!jwk) jwk = pick(await loadJwks(options.jwksUri, { fetchImpl: options.fetchImpl, nowMs, forceRefresh: true }));
    if (!jwk) throw fail();

    let validSignature = false;
    try {
        const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
        validSignature = verifySignature(
            alg.hash,
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            alg.dsa ? { key: publicKey, dsaEncoding: alg.dsa } : publicKey,
            Buffer.from(encodedSignature, 'base64url'),
        );
    } catch {
        validSignature = false;
    }
    if (!validSignature) throw fail();

    if (typeof payload.iss !== 'string' || payload.iss.replace(/\/$/, '') !== options.issuer) throw fail();
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.clientId)) throw fail();
    if (audiences.length > 1 && payload.azp !== options.clientId) throw fail();
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) throw fail();
    if (typeof payload.iat === 'number' && payload.iat * 1000 > nowMs + 5 * 60 * 1000) throw fail();
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) throw fail();
    if (typeof payload.nonce !== 'string' || hashOidcValue(payload.nonce) !== options.expectedNonceHash) throw fail();

    // Enterprise IdPs often omit `email_verified`; only an explicit `false` hides the address.
    const emailVerified = payload.email_verified !== false && payload.email_verified !== 'false';
    const email = emailVerified && typeof payload.email === 'string' && payload.email.includes('@')
        ? payload.email.trim().toLowerCase().slice(0, 254)
        : undefined;
    const name = typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 128)
        : typeof payload.given_name === 'string' && payload.given_name.trim()
            ? payload.given_name.trim().slice(0, 128)
            : undefined;
    const preferredUsername = typeof payload.preferred_username === 'string'
        ? payload.preferred_username.trim().toLowerCase()
        : undefined;
    return {
        sub: payload.sub,
        email,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name,
        picture: typeof payload.picture === 'string' ? payload.picture.slice(0, 1024) : undefined,
        preferredUsername: preferredUsername && USERNAME_PATTERN.test(preferredUsername) ? preferredUsername : undefined,
    };
}

//
// Authorization request + code exchange
//

export function buildAuthorizationUrl(
    discovery: OidcDiscovery,
    config: OidcConfig,
    params: { state: string; nonce: string; codeChallenge: string; redirectUri: string },
): string {
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

export async function exchangeAuthorizationCode(
    discovery: OidcDiscovery,
    config: OidcConfig,
    params: { code: string; codeVerifier: string; redirectUri: string },
    fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string }> {
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', params.code);
    form.set('redirect_uri', params.redirectUri);
    form.set('code_verifier', params.codeVerifier);
    form.set('client_id', config.clientId);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (config.clientSecret) {
        const methods = discovery.token_endpoint_auth_methods_supported;
        if (methods && methods.includes('client_secret_basic') && !methods.includes('client_secret_post')) {
            headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`;
        } else {
            form.set('client_secret', config.clientSecret);
        }
    }
    let result;
    try {
        result = await fetchJson(fetchImpl, discovery.token_endpoint, { method: 'POST', headers, body: form.toString() });
    } catch {
        throw new OidcProtocolError('exchange_failed');
    }
    const body = result.body as { id_token?: unknown } | null;
    if (!result.ok || !body || typeof body.id_token !== 'string' || body.id_token.length === 0 || body.id_token.length > 16_384) {
        throw new OidcProtocolError('exchange_failed');
    }
    return { idToken: body.id_token };
}

//
// Server-side state: pending challenge + one-time handoff
//

function toStored(encrypted: Uint8Array): string {
    return Buffer.from(encrypted).toString('base64url');
}

function fromStored(stored: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(stored, 'base64url'));
}

export interface IssuedOidcChallenge {
    state: string;
    nonce: string;
    codeChallenge: string;
    expiresAt: Date;
}

export async function issueOidcLoginChallenge(
    params: { redirectUri: string; inviteCode?: string; migrationHandoff?: string },
    client?: SqlClient,
    nowMs = Date.now(),
): Promise<IssuedOidcChallenge> {
    if (!client) {
        return db.$transaction((tx) => issueOidcLoginChallenge(params, tx, nowMs));
    }
    const id = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const expiresAt = new Date(nowMs + OIDC_CHALLENGE_TTL_MS);

    await client.$executeRawUnsafe(
        `INSERT INTO "GlobalLock" ("key", "value", "updatedAt", "expiresAt")
         VALUES ($1, $1, $2, $3)
         ON CONFLICT ("key") DO NOTHING`,
        OIDC_CHALLENGE_CREATE_LOCK_KEY,
        new Date(nowMs),
        new Date('9999-12-31T23:59:59.999Z'),
    );
    await client.$queryRawUnsafe('SELECT "key" FROM "GlobalLock" WHERE "key" = $1 FOR UPDATE', OIDC_CHALLENGE_CREATE_LOCK_KEY);
    await client.$executeRawUnsafe('DELETE FROM "OidcLoginChallenge" WHERE "expiresAt" <= now()');
    await client.$executeRawUnsafe('DELETE FROM "OidcLoginHandoff" WHERE "expiresAt" <= now()');
    const counts = await client.$queryRawUnsafe<Array<{ count: bigint | number | string }>>(
        'SELECT COUNT(*) AS "count" FROM "OidcLoginChallenge"',
    );
    if (Number(counts[0]?.count ?? 0) >= maxPendingOidcLoginChallenges()) {
        throw new OidcLoginChallengeCapacityError();
    }
    await client.$executeRawUnsafe(
        `INSERT INTO "OidcLoginChallenge"
         ("id", "stateHash", "nonceHash", "codeVerifierEnc", "redirectUri", "inviteCode", "migrationHandoffEnc", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        id,
        hashOidcValue(state),
        hashOidcValue(nonce),
        toStored(encryptString(['oidc', 'challenge', id], codeVerifier)),
        params.redirectUri,
        params.inviteCode?.trim() || null,
        params.migrationHandoff ? toStored(encryptString(['oidc', 'challenge', id, 'migration'], params.migrationHandoff)) : null,
        expiresAt,
    );
    return { state, nonce, codeChallenge, expiresAt };
}

export interface ConsumedOidcChallenge {
    nonceHash: string;
    codeVerifier: string;
    redirectUri: string;
    inviteCode?: string;
    /** B-627: relay-migration handoff to claim the old account with. */
    migrationHandoff?: string;
}

/** Deletes and returns the unexpired challenge for `state`; exactly one caller wins. */
export async function consumeOidcLoginChallenge(state: string, client: SqlClient = db): Promise<ConsumedOidcChallenge | null> {
    if (!state || state.length > 256) return null;
    const rows = await client.$queryRawUnsafe<Array<{ id: string; nonceHash: string; codeVerifierEnc: string; redirectUri: string; inviteCode: string | null; migrationHandoffEnc: string | null }>>(
        `DELETE FROM "OidcLoginChallenge"
         WHERE "stateHash" = $1 AND "expiresAt" > now()
         RETURNING "id", "nonceHash", "codeVerifierEnc", "redirectUri", "inviteCode", "migrationHandoffEnc"`,
        hashOidcValue(state),
    );
    const row = rows[0];
    if (!row) return null;
    return {
        nonceHash: row.nonceHash,
        codeVerifier: decryptString(['oidc', 'challenge', row.id], fromStored(row.codeVerifierEnc)),
        redirectUri: row.redirectUri,
        inviteCode: row.inviteCode ?? undefined,
        migrationHandoff: row.migrationHandoffEnc ? decryptString(['oidc', 'challenge', row.id, 'migration'], fromStored(row.migrationHandoffEnc)) : undefined,
    };
}

export interface OidcHandoffPayload {
    accountId: string;
    token: string;
    secret: string;
    expiresAt: string;
}

export async function createOidcLoginHandoff(payload: OidcHandoffPayload, client: SqlClient = db, nowMs = Date.now()): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const codeHash = hashOidcValue(code);
    await client.$executeRawUnsafe(
        `INSERT INTO "OidcLoginHandoff" ("codeHash", "payloadEnc", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, now())`,
        codeHash,
        toStored(encryptString(['oidc', 'handoff', codeHash], JSON.stringify(payload))),
        new Date(nowMs + OIDC_HANDOFF_TTL_MS),
    );
    return code;
}

/** Deletes and returns the unexpired handoff for `code`; the second caller gets null. */
export async function consumeOidcLoginHandoff(code: string, client: SqlClient = db): Promise<OidcHandoffPayload | null> {
    if (!code || code.length > 256) return null;
    const codeHash = hashOidcValue(code);
    const rows = await client.$queryRawUnsafe<Array<{ payloadEnc: string }>>(
        `DELETE FROM "OidcLoginHandoff"
         WHERE "codeHash" = $1 AND "expiresAt" > now()
         RETURNING "payloadEnc"`,
        codeHash,
    );
    const row = rows[0];
    if (!row) return null;
    try {
        const parsed = JSON.parse(decryptString(['oidc', 'handoff', codeHash], fromStored(row.payloadEnc))) as OidcHandoffPayload;
        if (typeof parsed.token !== 'string' || typeof parsed.secret !== 'string' || typeof parsed.accountId !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function oidcProviderKey(issuer: string): string {
    return `oidc:${issuer}`;
}

export function isUsernameCandidate(value: string | undefined): value is string {
    return typeof value === 'string' && USERNAME_PATTERN.test(value);
}
