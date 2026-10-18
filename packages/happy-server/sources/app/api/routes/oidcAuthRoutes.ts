/**
 * B-620: generic OIDC login routes (authorization code + PKCE).
 *
 *   POST /v1/auth/oidc/start     → { authorizationUrl }         (browser navigates there)
 *   GET  /v1/auth/oidc/callback  → 302 <web>/login/oidc?handoff=… | ?error=…
 *   POST /v1/auth/oidc/complete  → { token, secret, expiresAt } (one-time handoff)
 *
 * The callback never reads an `id_token` from the query; the only trusted token
 * is the one the token endpoint returns for our PKCE verifier. Account creation
 * goes through the same signup gate as Google/Email login.
 */
import { randomBytes, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';
import type { Fastify } from '../types';
import { auth } from '@/app/auth/auth';
import { log } from '@/utils/log';
import { auditLogin } from '@/app/audit/requestAudit';
import { clientRateLimitKey } from '@/app/api/clientIp';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { hashPairingValue } from '@/app/auth/pairingSecurity';
import { loadAccountSecret, upsertAccountSecret } from '@/app/auth/accountSecrets';
import { SignupPolicyError, withSignupGate } from '@/app/auth/signupPolicy';
import { signupRejectionsCounter } from '@/app/monitoring/metrics2';
import { verifyMigrationHandoff } from '@/app/migration/handoff';
import { consumeMigrationHandoffNonce } from '@/app/migration/handoffUse';
import { resolveMigrationHandoffSecret } from '@/app/migration/migrationConfig';
import {
    buildAuthorizationUrl,
    consumeOidcLoginChallenge,
    consumeOidcLoginHandoff,
    createOidcLoginHandoff,
    exchangeAuthorizationCode,
    isEmailDomainAllowed,
    issueOidcLoginChallenge,
    isUsernameCandidate,
    loadOidcDiscovery,
    OidcLoginChallengeCapacityError,
    OidcProtocolError,
    oidcProviderKey,
    resolveOidcConfig,
    resolveRedirectUri,
    resolveWebReturnBase,
    verifyOidcIdToken,
    type OidcConfig,
    type OidcIdentityClaims, splitDisplayName } from '@/app/auth/oidcProvider';

export type OidcCallbackError =
    | 'invalid_state'
    | 'exchange_failed'
    | 'invalid_id_token'
    | 'signup-closed'
    | 'invite-required'
    | 'capacity-reached'
    | 'email_domain_not_allowed'
    | 'account_link_ambiguous'
    | 'invalid_migration_handoff'
    | 'migration_conflict'
    | 'provider_error'
    | 'not_configured';

export function oidcStartRateBucket(ip: string): { key: string; max: number; windowMs: number } {
    return { key: `oidc-start:ip:${hashPairingValue(ip).slice(0, 32)}`, max: 30, windowMs: 60_000 };
}

export function oidcCompleteRateBucket(ip: string): { key: string; max: number; windowMs: number } {
    return { key: `oidc-complete:ip:${hashPairingValue(ip).slice(0, 32)}`, max: 60, windowMs: 60_000 };
}

export function oidcReturnUrl(webBase: string, outcome: { handoff: string } | { error: OidcCallbackError }): string {
    const url = new URL(`${webBase}/login/oidc`);
    if ('handoff' in outcome) url.searchParams.set('handoff', outcome.handoff);
    else url.searchParams.set('error', outcome.error);
    return url.toString();
}

/** Picks `preferred_username` as the account handle only when no account or credential already owns it. */
async function freeUsername(tx: { $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown> }, candidate: string | undefined): Promise<string | null> {
    if (!isUsernameCandidate(candidate)) return null;
    const rows = await tx.$queryRawUnsafe(
        `SELECT 1 AS "taken" FROM "Account" WHERE LOWER("username") = $1
         UNION ALL
         SELECT 1 AS "taken" FROM "AccountCredential" WHERE LOWER("username") = $1
         LIMIT 1`,
        candidate,
    ) as unknown[];
    return rows.length === 0 ? candidate : null;
}

type OidcAccount = { accountId: string; secret: string; session: { token: string; expiresAt: Date } };

export class OidcAccountLinkAmbiguousError extends Error {
    constructor() {
        super('More than one account owns this verified email');
        this.name = 'OidcAccountLinkAmbiguousError';
    }
}

/** B-627: the handoff was bad, spent, or the SSO subject already owns a live account. */
export class OidcMigrationError extends Error {
    constructor(readonly code: 'invalid_migration_handoff' | 'migration_conflict') {
        super(code);
        this.name = 'OidcMigrationError';
    }
}

type RawClient = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown> };

/**
 * B-626: the account a verified SSO email already belongs to, through an
 * Email-OTP or Google identity (both are verified by their provider). Password
 * identities carry no email and never match. Returns null when nobody owns the
 * address; throws when two different accounts do, so the person signs in with
 * one of the old methods instead of silently getting a third account.
 */
export async function findAccountByVerifiedEmail(tx: RawClient, email: string): Promise<string | null> {
    const rows = await tx.$queryRawUnsafe(
        `SELECT DISTINCT "accountId" FROM "AccountIdentity"
         WHERE "provider" IN ('email', 'google') AND LOWER("email") = LOWER($1)
         LIMIT 2`,
        email,
    ) as Array<{ accountId: string }>;
    if (rows.length > 1) throw new OidcAccountLinkAmbiguousError();
    return rows[0]?.accountId ?? null;
}

async function findOrCreateOidcAccount(
    config: OidcConfig,
    claims: OidcIdentityClaims,
    inviteCode: string | undefined,
    migration?: { handoff: string; secret: string },
): Promise<{ value: OidcAccount; created: boolean }> {
    const provider = oidcProviderKey(config.issuer);
    const profile = JSON.stringify({ name: claims.name, picture: claims.picture, emailVerified: claims.emailVerified, preferredUsername: claims.preferredUsername });

    // B-627: the person arrived from the old relay with a signed ticket for their
    // account there (same id here, the database was copied). Attach this SSO
    // subject to that account. A subject that already owns an EMPTY account on
    // this relay (signed in before clicking the banner) is moved over; one with
    // sessions or machines is a conflict the person has to resolve by hand.
    const claimByMigrationHandoff = async (tx: Prisma.TransactionClient): Promise<OidcAccount | null> => {
        if (!migration) return null;
        const payload = verifyMigrationHandoff(migration.secret, migration.handoff);
        if (!payload || payload.kind !== 'web') throw new OidcMigrationError('invalid_migration_handoff');
        if (!(await consumeMigrationHandoffNonce(tx, payload.nonce, payload.exp))) throw new OidcMigrationError('invalid_migration_handoff');
        const accountId = payload.accountId;
        const secret = await loadAccountSecret(tx, accountId);
        if (!secret) throw new OidcMigrationError('invalid_migration_handoff');
        const owner = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
            `SELECT "accountId" FROM "AccountIdentity" WHERE "provider" = $1 AND "providerSubject" = $2 LIMIT 1`,
            provider,
            claims.sub,
        );
        if (!owner[0]) {
            await tx.$executeRawUnsafe(
                `INSERT INTO "AccountIdentity"
                 ("id", "accountId", "provider", "providerSubject", "email", "profile", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
                randomUUID(), accountId, provider, claims.sub, claims.email ?? null, profile,
            );
            log({ module: 'oidc-auth', accountId }, 'Migration handoff: linked SSO identity to the migrated account');
        } else if (owner[0].accountId !== accountId) {
            const stray = owner[0].accountId;
            const [sessions, machines] = await Promise.all([
                tx.session.count({ where: { accountId: stray } }),
                tx.machine.count({ where: { accountId: stray } }),
            ]);
            if (sessions > 0 || machines > 0) throw new OidcMigrationError('migration_conflict');
            await tx.$executeRawUnsafe(
                `UPDATE "AccountIdentity" SET "accountId" = $3, "email" = $4, "profile" = $5::jsonb, "updatedAt" = now()
                 WHERE "provider" = $1 AND "providerSubject" = $2`,
                provider, claims.sub, accountId, claims.email ?? null, profile,
            );
            log({ module: 'oidc-auth', accountId, strayAccountId: stray }, 'Migration handoff: moved SSO identity off an empty account');
        }
        const session = await auth.createLoginToken(accountId, tx, { cache: false });
        return { accountId, secret, session };
    };

    // B-626: attach this SSO subject to the account that already owns the verified email.
    const linkByVerifiedEmail = async (tx: Prisma.TransactionClient): Promise<OidcAccount | null> => {
        if (!config.linkByEmail || claims.emailVerified !== true || !claims.email) return null;
        const accountId = await findAccountByVerifiedEmail(tx, claims.email);
        if (!accountId) return null;
        const secret = await loadAccountSecret(tx, accountId);
        if (!secret) {
            // A key-only (legacy pairing) account has nothing the Web can sign in with; fall back to a fresh account.
            log({ module: 'oidc-auth', level: 'warn', accountId }, 'Verified-email account has no stored secret; not linking');
            return null;
        }
        await tx.$executeRawUnsafe(
            `INSERT INTO "AccountIdentity"
             ("id", "accountId", "provider", "providerSubject", "email", "profile", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
            randomUUID(),
            accountId,
            provider,
            claims.sub,
            claims.email,
            profile,
        );
        log({ module: 'oidc-auth', accountId }, 'Linked SSO identity to the account owning the verified email');
        const session = await auth.createLoginToken(accountId, tx, { cache: false });
        return { accountId, secret, session };
    };

    return withSignupGate<OidcAccount>({
        provider: 'oidc',
        inviteCode,
        findExisting: async (tx) => {
            const claimed = await claimByMigrationHandoff(tx);
            if (claimed) return claimed;
            const identities = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                `SELECT "accountId" FROM "AccountIdentity"
                 WHERE "provider" = $1 AND "providerSubject" = $2 LIMIT 1`,
                provider,
                claims.sub,
            );
            if (!identities[0]) return linkByVerifiedEmail(tx);
            const accountId = identities[0].accountId;
            const secret = await loadAccountSecret(tx, accountId);
            if (!secret) throw new Error('oidc-account-secret-missing');
            // Keep the stored email/profile current so share lookups by address follow the IdP.
            await tx.$executeRawUnsafe(
                `UPDATE "AccountIdentity" SET "email" = $3, "profile" = $4::jsonb, "updatedAt" = now()
                 WHERE "provider" = $1 AND "providerSubject" = $2`,
                provider,
                claims.sub,
                claims.email ?? null,
                JSON.stringify({ name: claims.name, picture: claims.picture, emailVerified: claims.emailVerified, preferredUsername: claims.preferredUsername }),
            );
            const session = await auth.createLoginToken(accountId, tx, { cache: false });
            return { accountId, secret, session };
        },
        create: async (tx) => {
            const secretBytes = randomBytes(32);
            const secret = secretBytes.toString('base64url');
            const publicKey = tweetnacl.sign.keyPair.fromSeed(secretBytes).publicKey;
            const username = await freeUsername(tx, claims.preferredUsername);
            const { firstName, lastName } = splitDisplayName(claims.name);
            const account = await tx.account.create({
                data: {
                    publicKey: Buffer.from(publicKey).toString('hex'),
                    firstName,
                    lastName,
                    username,
                },
            });
            await upsertAccountSecret(tx, account.id, secret);
            await tx.$executeRawUnsafe(
                `INSERT INTO "AccountIdentity"
                 ("id", "accountId", "provider", "providerSubject", "email", "profile", "updatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
                randomUUID(),
                account.id,
                provider,
                claims.sub,
                claims.email ?? null,
                JSON.stringify({ name: claims.name, picture: claims.picture, emailVerified: claims.emailVerified, preferredUsername: claims.preferredUsername }),
            );
            const session = await auth.createLoginToken(account.id, tx, { cache: false });
            return { accountId: account.id, secret, session };
        },
        onRejected: (reason, provider) => signupRejectionsCounter.inc({ reason, provider }),
    });
}

export function oidcAuthRoutes(app: Fastify, options: { fetchImpl?: typeof fetch } = {}) {
    const config = resolveOidcConfig();
    const fetchImpl = options.fetchImpl ?? fetch;
    const migrationSecret = resolveMigrationHandoffSecret();

    app.post('/v1/auth/oidc/start', {
        schema: {
            body: z.object({
                inviteCode: z.string().trim().max(256).optional(),
                /** B-627: signed ticket from the old relay; the callback then claims that account. */
                migrationHandoff: z.string().min(16).max(4096).optional(),
            }).strict().optional(),
            response: {
                200: z.object({ authorizationUrl: z.string() }),
                401: z.object({ error: z.literal('invalid_migration_handoff') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('oidc_not_configured') }),
                503: z.object({ error: z.enum(['oidc_challenge_capacity', 'oidc_provider_unavailable']) }),
            },
        },
    }, async (request, reply) => {
        if (!config) return reply.code(501).send({ error: 'oidc_not_configured' as const });
        const bucket = oidcStartRateBucket(clientRateLimitKey(request));
        if (!(await allowAuthRequest(bucket.key, bucket))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        let discovery;
        try {
            discovery = await loadOidcDiscovery(config.issuer, { fetchImpl });
        } catch (error) {
            log({ module: 'oidc-auth', level: 'warn', error }, 'OIDC discovery failed');
            return reply.code(503).send({ error: 'oidc_provider_unavailable' as const });
        }
        const redirectUri = resolveRedirectUri(config, request);
        const migrationHandoff = request.body?.migrationHandoff;
        if (migrationHandoff && (!migrationSecret || verifyMigrationHandoff(migrationSecret, migrationHandoff)?.kind !== 'web')) {
            return reply.code(401).send({ error: 'invalid_migration_handoff' as const });
        }
        let challenge;
        try {
            challenge = await issueOidcLoginChallenge({ redirectUri, inviteCode: request.body?.inviteCode, migrationHandoff });
        } catch (error) {
            if (error instanceof OidcLoginChallengeCapacityError) {
                return reply.code(503).send({ error: 'oidc_challenge_capacity' as const });
            }
            throw error;
        }
        const authorizationUrl = buildAuthorizationUrl(discovery, config, {
            state: challenge.state,
            nonce: challenge.nonce,
            codeChallenge: challenge.codeChallenge,
            redirectUri,
        });
        return reply.send({ authorizationUrl });
    });

    app.get('/v1/auth/oidc/callback', {
        schema: {
            querystring: z.object({
                code: z.string().min(1).max(4096).optional(),
                state: z.string().min(1).max(256).optional(),
                error: z.string().max(256).optional(),
            }).passthrough(),
        },
    }, async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (!config) return reply.code(501).send({ error: 'oidc_not_configured' });
        const webBase = resolveWebReturnBase(config, request);
        const fail = (error: OidcCallbackError) => reply.redirect(oidcReturnUrl(webBase, { error }), 302);

        if (request.query.error) {
            log({ module: 'oidc-auth', level: 'warn', providerError: request.query.error.slice(0, 64) }, 'OIDC provider returned an error');
            return fail('provider_error');
        }
        if (!request.query.state || !request.query.code) return fail('invalid_state');

        const challenge = await consumeOidcLoginChallenge(request.query.state);
        if (!challenge) return fail('invalid_state');

        let claims: OidcIdentityClaims;
        try {
            const discovery = await loadOidcDiscovery(config.issuer, { fetchImpl });
            const { idToken } = await exchangeAuthorizationCode(discovery, config, {
                code: request.query.code,
                codeVerifier: challenge.codeVerifier,
                redirectUri: challenge.redirectUri,
            }, fetchImpl);
            claims = await verifyOidcIdToken(idToken, {
                issuer: config.issuer,
                clientId: config.clientId,
                jwksUri: discovery.jwks_uri,
                expectedNonceHash: challenge.nonceHash,
                fetchImpl,
            });
        } catch (error) {
            const code = error instanceof OidcProtocolError ? error.code : 'exchange_failed';
            log({ module: 'oidc-auth', level: 'warn', code }, 'OIDC code exchange rejected');
            return fail(code === 'discovery_failed' ? 'exchange_failed' : code);
        }
        if (!isEmailDomainAllowed(claims.email, config)) return fail('email_domain_not_allowed');

        let result: { value: OidcAccount; created: boolean };
        try {
            result = await findOrCreateOidcAccount(
                config,
                claims,
                challenge.inviteCode,
                challenge.migrationHandoff && migrationSecret ? { handoff: challenge.migrationHandoff, secret: migrationSecret } : undefined,
            );
        } catch (error) {
            if (error instanceof SignupPolicyError) return fail(error.reason);
            if (error instanceof OidcAccountLinkAmbiguousError) return fail('account_link_ambiguous');
            if (error instanceof OidcMigrationError) return fail(error.code);
            throw error;
        }

        auditLogin(request, result.value.accountId, 'oidc');
        const handoff = await createOidcLoginHandoff({
            accountId: result.value.accountId,
            token: result.value.session.token,
            secret: result.value.secret,
            expiresAt: result.value.session.expiresAt.toISOString(),
        });
        return reply.redirect(oidcReturnUrl(webBase, { handoff }), 302);
    });

    app.post('/v1/auth/oidc/complete', {
        schema: {
            body: z.object({ handoff: z.string().min(16).max(256) }).strict(),
            response: {
                200: z.object({ token: z.string(), secret: z.string(), expiresAt: z.string() }),
                401: z.object({ error: z.literal('invalid_handoff') }),
                429: z.object({ error: z.literal('too_many_requests') }),
                501: z.object({ error: z.literal('oidc_not_configured') }),
            },
        },
    }, async (request, reply) => {
        if (!config) return reply.code(501).send({ error: 'oidc_not_configured' as const });
        const bucket = oidcCompleteRateBucket(clientRateLimitKey(request));
        if (!(await allowAuthRequest(bucket.key, bucket))) {
            return reply.code(429).send({ error: 'too_many_requests' as const });
        }
        const payload = await consumeOidcLoginHandoff(request.body.handoff);
        if (!payload) return reply.code(401).send({ error: 'invalid_handoff' as const });
        reply.header('cache-control', 'no-store');
        return reply.send({ token: payload.token, secret: payload.secret, expiresAt: payload.expiresAt });
    });
}
