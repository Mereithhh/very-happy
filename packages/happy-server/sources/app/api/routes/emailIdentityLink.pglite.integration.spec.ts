import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';

describe('Email identity linking HTTP flow on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-email-link-route-'));
    const pgliteDir = join(root, 'db');
    const secret = Buffer.alloc(32, 23).toString('base64url');
    let db: PrismaClient;
    let app: FastifyInstance;
    let accountId: string;
    let createEmailLoginChallenge: typeof import('@/app/auth/emailLoginSecurity').createEmailLoginChallenge;
    let auth: typeof import('@/app/auth/auth').auth;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = 'email-link-route-integration-master';
        process.env.AUTH_EMAIL_PROVIDER = 'resend';
        process.env.AUTH_EMAIL_FROM = 'login@example.com';
        process.env.RESEND_API_KEY = 'integration-test-key';

        const { runMigrations } = await import('../../../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ db } = await import('../../../storage/db'));
        ({ auth } = await import('@/app/auth/auth'));
        const { initEncrypt } = await import('@/modules/encrypt');
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        ({ createEmailLoginChallenge } = await import('@/app/auth/emailLoginSecurity'));
        const { accountAuthRoutes, accountPublicKeyFromSecret } = await import('./accountAuthRoutes');

        await initEncrypt();
        await auth.init();
        const account = await db.account.create({
            data: { publicKey: accountPublicKeyFromSecret(secret)! },
        });
        accountId = account.id;
        await upsertAccountSecret(db, accountId, secret);
        const issued = await auth.createLoginToken(accountId);
        const verified = await auth.verifyToken(issued.token);
        const loginSessionId = verified?.extras?.loginSessionId as string;
        expect(loginSessionId).toBeTruthy();

        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        typed.decorate('authenticate', async (request: any) => {
            request.userId = accountId;
            request.authLoginSessionId = loginSessionId;
        });
        accountAuthRoutes(typed);
        await app.ready();
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        delete process.env.AUTH_EMAIL_PROVIDER;
        delete process.env.AUTH_EMAIL_FROM;
        delete process.env.RESEND_API_KEY;
        rmSync(root, { recursive: true, force: true });
    });

    it('links idempotently and Email login returns the original account', async () => {
        const first = await createEmailLoginChallenge('Owner@Example.com', 10, { code: '123456' });
        const firstResponse = await app.inject({
            method: 'POST',
            url: '/v1/account/identities/email',
            payload: {
                email: ' Owner@Example.com ',
                challengeId: first.id,
                code: first.code,
                secret,
            },
        });
        expect(firstResponse.statusCode).toBe(200);

        const second = await createEmailLoginChallenge('owner@example.com', 10, { code: '234567' });
        const secondResponse = await app.inject({
            method: 'POST',
            url: '/v1/account/identities/email',
            payload: { email: second.email, challengeId: second.id, code: second.code, secret },
        });
        expect(secondResponse.statusCode).toBe(200);
        expect(await db.accountIdentity.count({ where: { provider: 'email', accountId } })).toBe(1);

        const login = await createEmailLoginChallenge('owner@example.com', 10, { code: '345678' });
        const loginResponse = await app.inject({
            method: 'POST',
            url: '/v1/account/login/email',
            payload: { email: login.email, challengeId: login.id, code: login.code },
        });
        expect(loginResponse.statusCode).toBe(200);
        expect(loginResponse.json()).toMatchObject({ secret });
        await expect(auth.verifyToken(loginResponse.json().token)).resolves.toMatchObject({ userId: accountId });
    });
});
