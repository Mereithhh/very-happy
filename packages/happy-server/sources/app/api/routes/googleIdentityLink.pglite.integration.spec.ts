import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';

const { verifyGoogleIdTokenMock } = vi.hoisted(() => ({
    verifyGoogleIdTokenMock: vi.fn(),
}));

// Signature/JWKS verification is the only external boundary. Route security,
// sessions, account proof, nonce consumption, and identity writes stay real.
vi.mock('@/app/auth/googleOidc', () => ({ verifyGoogleIdToken: verifyGoogleIdTokenMock }));

describe('Google identity linking HTTP flow on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-google-link-route-'));
    const pgliteDir = join(root, 'db');
    const secret = Buffer.alloc(32, 29).toString('base64url');
    let db: PrismaClient;
    let app: FastifyInstance;
    let accountId: string;
    let otherAccountId: string;
    let activeSessionId: string;
    let requestAccountId: string;
    let requestLoginSessionId: string;
    let issueGoogleLoginChallenge: typeof import('@/app/auth/googleLoginSecurity').issueGoogleLoginChallenge;
    let hashGoogleLoginNonce: typeof import('@/app/auth/googleLoginSecurity').hashGoogleLoginNonce;
    let auth: typeof import('@/app/auth/auth').auth;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'google-link-route-integration-master';
        process.env.GOOGLE_CLIENT_ID = 'google-client';
        process.env.GOOGLE_ALLOWED_ORIGINS = 'https://veryhappy.dev';

        const { runMigrations } = await import('../../../standalone');
        await runMigrations({ pgliteDir, migrationsDir: join(process.cwd(), 'prisma', 'migrations') });
        ({ db } = await import('../../../storage/db'));
        ({ auth } = await import('@/app/auth/auth'));
        ({ issueGoogleLoginChallenge, hashGoogleLoginNonce } = await import('@/app/auth/googleLoginSecurity'));
        const { initEncrypt } = await import('@/modules/encrypt');
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        const { accountAuthRoutes, accountPublicKeyFromSecret } = await import('./accountAuthRoutes');

        await initEncrypt();
        await auth.init();
        const account = await db.account.create({ data: { publicKey: accountPublicKeyFromSecret(secret)! } });
        const other = await db.account.create({ data: { publicKey: 'other-google-route-account' } });
        accountId = account.id;
        otherAccountId = other.id;
        await upsertAccountSecret(db, accountId, secret);
        const issued = await auth.createLoginToken(accountId);
        const verified = await auth.verifyToken(issued.token);
        activeSessionId = verified?.extras?.loginSessionId as string;
        requestAccountId = accountId;
        requestLoginSessionId = activeSessionId;

        const now = new Date();
        const future = new Date(Date.now() + 60 * 60_000);
        await db.accountLoginSession.createMany({ data: [
            { id: 'expired-session', accountId, tokenHash: 'expired-token', expiresAt: new Date(0), createdAt: now },
            { id: 'revoked-session', accountId, tokenHash: 'revoked-token', expiresAt: future, revokedAt: now, createdAt: now },
            { id: 'wrong-account-session', accountId: otherAccountId, tokenHash: 'wrong-account-token', expiresAt: future, createdAt: now },
        ] });

        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        typed.decorate('authenticate', async (request: any) => {
            request.userId = requestAccountId;
            request.authLoginSessionId = requestLoginSessionId;
        });
        accountAuthRoutes(typed);
        await app.ready();
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_ALLOWED_ORIGINS;
        rmSync(root, { recursive: true, force: true });
    });

    async function challenge() {
        return issueGoogleLoginChallenge();
    }

    async function postLink(nonce: string, credential = 'owner-token', accountSecret = secret) {
        return app.inject({
            method: 'POST',
            url: '/v1/account/identities/google',
            headers: { origin: 'https://veryhappy.dev' },
            payload: { credential, nonce, secret: accountSecret },
        });
    }

    async function expectNonceUnconsumed(nonce: string) {
        const row = await db.googleLoginChallenge.findUnique({ where: { nonceHash: hashGoogleLoginNonce(nonce) } });
        expect(row?.consumedAt).toBeNull();
    }

    it.each(['expired-session', 'revoked-session', 'wrong-account-session'])(
        'rejects %s before verification without consuming the nonce',
        async (sessionId) => {
            const issued = await challenge();
            requestLoginSessionId = sessionId;
            const response = await postLink(issued.nonce);
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: 'reauth_required' });
            expect(verifyGoogleIdTokenMock).not.toHaveBeenCalled();
            await expectNonceUnconsumed(issued.nonce);
            requestLoginSessionId = activeSessionId;
        },
    );

    it('rejects the wrong account secret without consuming the nonce', async () => {
        const issued = await challenge();
        const response = await postLink(issued.nonce, 'owner-token', Buffer.alloc(32, 30).toString('base64url'));
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_secret' });
        expect(verifyGoogleIdTokenMock).not.toHaveBeenCalled();
        await expectNonceUnconsumed(issued.nonce);
    });

    it('links through the real route/session/helper/DB and Google login returns the original account', async () => {
        verifyGoogleIdTokenMock.mockResolvedValue({
            sub: 'google-route-subject', email: 'owner@example.com', emailVerified: true,
        });
        const linkChallenge = await challenge();
        const linked = await postLink(linkChallenge.nonce);
        expect(linked.statusCode).toBe(200);
        expect(linked.json()).toEqual({ success: true, email: 'owner@example.com' });
        expect(await db.accountIdentity.count({ where: { accountId, provider: 'google' } })).toBe(1);

        const loginChallenge = await challenge();
        const login = await app.inject({
            method: 'POST',
            url: '/v1/account/login/google',
            headers: { origin: 'https://veryhappy.dev' },
            payload: { credential: 'owner-token', nonce: loginChallenge.nonce },
        });
        expect(login.statusCode).toBe(200);
        expect(login.json()).toMatchObject({ secret });
        await expect(auth.verifyToken(login.json().token)).resolves.toMatchObject({ userId: accountId });
    });
});
