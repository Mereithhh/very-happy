import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { startMockIdp, type MockIdp } from '@/app/auth/oidcTestIdp';

/**
 * B-620 end-to-end on PGlite: start → (mock IdP) → callback → complete, with the
 * real challenge/handoff tables, the real signup gate and real login sessions.
 */
describe('B-620 generic OIDC login routes (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/oidc-login-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient;
    let idp: MockIdp;
    let app: FastifyInstance;

    beforeAll(async () => {
        idp = await startMockIdp();
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'oidc-login-integration-test-only';
        process.env.OIDC_ISSUER = idp.issuer;
        process.env.OIDC_CLIENT_ID = idp.clientId;
        process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
        process.env.OIDC_DISPLAY_NAME = 'Test SSO';
        process.env.PUBLIC_URL = 'https://api.test';
        process.env.OIDC_WEB_RETURN_URL = 'https://web.test';
        process.env.SIGNUP_MODE = 'open';
        process.env.OIDC_LINK_BY_EMAIL = 'verified';
        process.env.MIGRATION_HANDOFF_SECRET = 'migration-handoff-secret-for-tests-0123456789';
        const { runMigrations } = await import('../../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        await (await import('@/app/auth/auth')).auth.init();
        ({ db } = await import('@/storage/db'));
        const { oidcAuthRoutes } = await import('./oidcAuthRoutes');
        app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        oidcAuthRoutes(app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
        await app.ready();
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        await idp?.close();
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    beforeEach(() => {
        idp.claims = {};
        idp.nonceOverride = null;
        idp.expect = null;
        process.env.SIGNUP_MODE = 'open';
        delete process.env.SIGNUP_INVITE_CODES;
        delete process.env.OIDC_SIGNUP_MODE;
    });

    async function start(inviteCode?: string) {
        const response = await app.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: inviteCode ? { inviteCode } : {} });
        expect(response.statusCode).toBe(200);
        const url = new URL(response.json().authorizationUrl);
        const params = Object.fromEntries(url.searchParams);
        idp.expect = { nonce: params.nonce, codeChallenge: params.code_challenge, redirectUri: params.redirect_uri };
        return { url, params };
    }

    function callback(query: Record<string, string>) {
        return app.inject({ method: 'GET', url: '/v1/auth/oidc/callback', query });
    }

    function returned(location: string | undefined) {
        const url = new URL(location ?? '');
        return { base: `${url.origin}${url.pathname}`, handoff: url.searchParams.get('handoff'), error: url.searchParams.get('error') };
    }

    it('creates the account on first login, hands the session off once, and reuses the account next time', async () => {
        idp.claims = { email: 'jo@apodex.com', email_verified: true, name: 'Jo Doe', preferred_username: 'JoDoe' };
        const { params } = await start();
        expect(params.redirect_uri).toBe('https://api.test/v1/auth/oidc/callback');
        expect(params.code_challenge_method).toBe('S256');

        const cb = await callback({ code: 'good-code', state: params.state });
        expect(cb.statusCode).toBe(302);
        const first = returned(cb.headers.location as string);
        expect(first.base).toBe('https://web.test/login/oidc');
        expect(first.error).toBeNull();
        expect(first.handoff).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(idp.tokenRequests).toBe(1);

        const complete = await app.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: first.handoff } });
        expect(complete.statusCode).toBe(200);
        const body = complete.json();
        expect(body.token).toMatch(/\S+/);
        expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(complete.headers['cache-control']).toBe('no-store');

        // Handoff is single-use; a replayed state is dead too.
        const again = await app.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: first.handoff } });
        expect(again.statusCode).toBe(401);
        const replay = await callback({ code: 'good-code', state: params.state });
        expect(returned(replay.headers.location as string).error).toBe('invalid_state');

        const accounts = await db.account.findMany({ include: { AccountIdentity: true } });
        expect(accounts).toHaveLength(1);
        expect(accounts[0].username).toBe('jodoe');
        expect(accounts[0]).toMatchObject({ firstName: 'Jo', lastName: 'Doe' });
        expect(accounts[0].AccountIdentity[0]).toMatchObject({ provider: `oidc:${idp.issuer}`, providerSubject: 'subject-1', email: 'jo@apodex.com' });
        expect(await db.oidcLoginChallenge.count()).toBe(0);
        expect(await db.oidcLoginHandoff.count()).toBe(0);

        // Second login with the same subject: no new account even when signup is closed.
        process.env.SIGNUP_MODE = 'closed';
        idp.claims = { email: 'jo.new@apodex.com', name: 'Jo Doe' };
        const second = await start();
        const cb2 = await callback({ code: 'good-code', state: second.params.state });
        const outcome = returned(cb2.headers.location as string);
        expect(outcome.error).toBeNull();
        const complete2 = await app.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: outcome.handoff } });
        expect(complete2.statusCode).toBe(200);
        expect(complete2.json().secret).toBe(body.secret);
        expect(await db.account.count()).toBe(1);
        expect((await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-1' } }))?.email).toBe('jo.new@apodex.com');
        expect(await db.accountLoginSession.count({ where: { accountId: accounts[0].id } })).toBe(2);
    });

    it('refuses a new account when signup is closed or invite-only without the code, and admits it with the code', async () => {
        idp.claims = { sub: 'subject-closed', email: 'new@apodex.com' };
        process.env.SIGNUP_MODE = 'closed';
        const closed = await start();
        expect(returned((await callback({ code: 'good-code', state: closed.params.state })).headers.location as string).error).toBe('signup-closed');
        expect(await db.account.count()).toBe(1);

        process.env.SIGNUP_MODE = 'invite';
        process.env.SIGNUP_INVITE_CODES = 'team-2026';
        const noCode = await start();
        expect(returned((await callback({ code: 'good-code', state: noCode.params.state })).headers.location as string).error).toBe('invite-required');
        const withCode = await start('team-2026');
        expect(returned((await callback({ code: 'good-code', state: withCode.params.state })).headers.location as string).handoff).toBeTruthy();
        expect(await db.account.count()).toBe(2);
    });

    it('OIDC_SIGNUP_MODE admits IdP-vouched first logins on an invite-only relay without a code, and can close OIDC alone', async () => {
        process.env.SIGNUP_MODE = 'invite';
        process.env.SIGNUP_INVITE_CODES = 'team-2026';
        process.env.OIDC_SIGNUP_MODE = 'open';
        idp.claims = { sub: 'subject-selfserve', email: 'self@apodex.com', name: 'Alex Rivera' };
        const before = await db.account.count();
        const selfServe = await start();
        expect(returned((await callback({ code: 'good-code', state: selfServe.params.state })).headers.location as string).handoff).toBeTruthy();
        expect(await db.account.count()).toBe(before + 1);
        const created = await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-selfserve' }, include: { account: true } });
        expect(created?.account).toMatchObject({ firstName: 'Alex', lastName: 'Rivera' });

        process.env.SIGNUP_MODE = 'open';
        process.env.OIDC_SIGNUP_MODE = 'closed';
        idp.claims = { sub: 'subject-oidc-closed', email: 'late@apodex.com' };
        const closed = await start();
        expect(returned((await callback({ code: 'good-code', state: closed.params.state })).headers.location as string).error).toBe('signup-closed');
        expect(await db.account.count()).toBe(before + 1);
        // Existing OIDC identities keep logging in while OIDC signup is closed.
        idp.claims = { sub: 'subject-selfserve', email: 'self@apodex.com' };
        const again = await start();
        expect(returned((await callback({ code: 'good-code', state: again.params.state })).headers.location as string).handoff).toBeTruthy();
    });

    it('rejects state mismatch, provider errors, a nonce that does not match, and a disallowed email domain', async () => {
        const { params } = await start();
        expect(returned((await callback({ code: 'good-code', state: 'forged-state' })).headers.location as string).error).toBe('invalid_state');
        expect(returned((await callback({ error: 'access_denied', state: params.state })).headers.location as string).error).toBe('provider_error');
        // The real state is still unconsumed after a provider error → a wrong-code exchange is attempted and fails.
        expect(returned((await callback({ code: 'bad-code', state: params.state })).headers.location as string).error).toBe('exchange_failed');

        const nonce = await start();
        idp.nonceOverride = 'someone-elses-nonce';
        expect(returned((await callback({ code: 'good-code', state: nonce.params.state })).headers.location as string).error).toBe('invalid_id_token');
        idp.nonceOverride = null;

        process.env.OIDC_ALLOWED_EMAIL_DOMAINS = 'apodex.com';
        const { oidcAuthRoutes } = await import('./oidcAuthRoutes');
        const strict = fastify();
        strict.setValidatorCompiler(validatorCompiler);
        strict.setSerializerCompiler(serializerCompiler);
        oidcAuthRoutes(strict.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
        await strict.ready();
        try {
            const startRes = await strict.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: {} });
            const p = Object.fromEntries(new URL(startRes.json().authorizationUrl).searchParams);
            idp.expect = { nonce: p.nonce, codeChallenge: p.code_challenge, redirectUri: p.redirect_uri };
            idp.claims = { sub: 'outsider', email: 'x@gmail.com', email_verified: true };
            const res = await strict.inject({ method: 'GET', url: '/v1/auth/oidc/callback', query: { code: 'good-code', state: p.state } });
            expect(returned(res.headers.location as string).error).toBe('email_domain_not_allowed');
        } finally {
            delete process.env.OIDC_ALLOWED_EMAIL_DOMAINS;
            await strict.close();
        }
        expect(await db.account.findFirst({ where: { AccountIdentity: { some: { providerSubject: 'outsider' } } } })).toBeNull();
    });

    async function seedAccount(key: string, identity: { provider: 'email' | 'google'; email: string }, secret: string | null) {
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        const account = await db.account.create({ data: { publicKey: `pk-${key}` } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: identity.provider, providerSubject: `${identity.provider}-${key}`, email: identity.email } });
        if (secret) await upsertAccountSecret(db, account.id, secret);
        return account.id;
    }

    async function login(claims: Record<string, unknown>, via: FastifyInstance = app) {
        const started = await via.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: {} });
        const params = Object.fromEntries(new URL(started.json().authorizationUrl).searchParams);
        idp.expect = { nonce: params.nonce, codeChallenge: params.code_challenge, redirectUri: params.redirect_uri };
        idp.claims = claims;
        const cb = await via.inject({ method: 'GET', url: '/v1/auth/oidc/callback', query: { code: 'good-code', state: params.state } });
        const outcome = returned(cb.headers.location as string);
        if (outcome.error) return { error: outcome.error, secret: null };
        const complete = await via.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: outcome.handoff } });
        expect(complete.statusCode).toBe(200);
        return { error: null, secret: complete.json().secret as string };
    }

    it('B-626: a verified SSO email claims the Email/Google account that owns it, once; unverified or ambiguous emails do not', async () => {
        const before = await db.account.count();
        const seededSecret = Buffer.alloc(32, 7).toString('base64url');
        const owner = await seedAccount('link', { provider: 'email', email: 'lin@apodex.com' }, seededSecret);

        // Verified + unique owner → same account, same secret, one new oidc identity, no signup needed.
        process.env.SIGNUP_MODE = 'closed';
        const first = await login({ sub: 'subject-link', email: 'Lin@Apodex.com', email_verified: true, name: 'Lin Den' });
        expect(first.error).toBeNull();
        expect(first.secret).toBe(seededSecret);
        expect(await db.account.count()).toBe(before + 1);
        const linked = await db.accountIdentity.findMany({ where: { accountId: owner }, orderBy: { provider: 'asc' } });
        expect(linked.map((row) => [row.provider, row.providerSubject])).toEqual([['email', 'email-link'], [`oidc:${idp.issuer}`, 'subject-link']]);

        // Next login resolves by subject, not by email: no second identity row.
        const again = await login({ sub: 'subject-link', email: 'lin@apodex.com', email_verified: true });
        expect(again.secret).toBe(seededSecret);
        expect(await db.accountIdentity.count({ where: { accountId: owner } })).toBe(2);

        // Unverified email never links: a fresh account instead (signup open), owner untouched.
        process.env.SIGNUP_MODE = 'open';
        const googleOwner = await seedAccount('unverified', { provider: 'google', email: 'g@apodex.com' }, Buffer.alloc(32, 8).toString('base64url'));
        const unverified = await login({ sub: 'subject-unverified', email: 'g@apodex.com', email_verified: false });
        expect(unverified.error).toBeNull();
        expect(await db.accountIdentity.count({ where: { accountId: googleOwner } })).toBe(1);
        expect(await db.account.count()).toBe(before + 3);

        // Two accounts own the email → refused, nothing created.
        await seedAccount('dup-a', { provider: 'email', email: 'dup@apodex.com' }, Buffer.alloc(32, 9).toString('base64url'));
        await seedAccount('dup-b', { provider: 'google', email: 'dup@apodex.com' }, Buffer.alloc(32, 10).toString('base64url'));
        const ambiguous = await login({ sub: 'subject-dup', email: 'dup@apodex.com', email_verified: true });
        expect(ambiguous.error).toBe('account_link_ambiguous');
        expect(await db.account.count()).toBe(before + 5);
        expect(await db.accountIdentity.count({ where: { providerSubject: 'subject-dup' } })).toBe(0);

        // A key-only owner (no stored secret) cannot be signed into from the Web: fresh account.
        const keyOnly = await seedAccount('key-only', { provider: 'email', email: 'key@apodex.com' }, null);
        const fallback = await login({ sub: 'subject-key', email: 'key@apodex.com', email_verified: true });
        expect(fallback.error).toBeNull();
        expect(await db.accountIdentity.count({ where: { accountId: keyOnly } })).toBe(1);
        expect(await db.account.count()).toBe(before + 7);

        // With the switch off (default), a verified email still creates a separate account.
        delete process.env.OIDC_LINK_BY_EMAIL;
        const { oidcAuthRoutes } = await import('./oidcAuthRoutes');
        const off = fastify();
        off.setValidatorCompiler(validatorCompiler);
        off.setSerializerCompiler(serializerCompiler);
        oidcAuthRoutes(off.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
        await off.ready();
        try {
            const offOwner = await seedAccount('off', { provider: 'email', email: 'off@apodex.com' }, Buffer.alloc(32, 11).toString('base64url'));
            const separate = await login({ sub: 'subject-off', email: 'off@apodex.com', email_verified: true }, off);
            expect(separate.error).toBeNull();
            expect(await db.accountIdentity.count({ where: { accountId: offOwner } })).toBe(1);
            expect(await db.account.count()).toBe(before + 9);
        } finally {
            process.env.OIDC_LINK_BY_EMAIL = 'verified';
            await off.close();
        }
    });

    it('B-627: an SSO login carrying a relay-migration handoff claims the migrated account, folds in an empty stray account, and refuses a busy one', async () => {
        const { issueMigrationHandoff } = await import('@/app/migration/handoff');
        const secret = process.env.MIGRATION_HANDOFF_SECRET!;
        const before = await db.account.count();
        const migratedSecret = Buffer.alloc(32, 21).toString('base64url');
        const migrated = await seedAccount('migrated', { provider: 'google', email: 'moved@gmail.com' }, migratedSecret);

        // Start refuses a forged or daemon-kind ticket outright.
        expect((await app.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: { migrationHandoff: 'vh1.forged.signature' } })).statusCode).toBe(401);
        const daemonTicket = issueMigrationHandoff(secret, { kind: 'daemon', accountId: migrated, machineId: 'm' });
        expect((await app.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: { migrationHandoff: daemonTicket } })).statusCode).toBe(401);

        async function loginWithHandoff(handoff: string, claims: Record<string, unknown>) {
            const started = await app.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: { migrationHandoff: handoff } });
            expect(started.statusCode).toBe(200);
            const params = Object.fromEntries(new URL(started.json().authorizationUrl).searchParams);
            idp.expect = { nonce: params.nonce, codeChallenge: params.code_challenge, redirectUri: params.redirect_uri };
            idp.claims = claims;
            const cb = await callback({ code: 'good-code', state: params.state });
            const outcome = returned(cb.headers.location as string);
            if (outcome.error) return { error: outcome.error, secret: null };
            const complete = await app.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: outcome.handoff } });
            return { error: null, secret: complete.json().secret as string };
        }

        // Fresh subject + valid ticket → the migrated account, even with signup closed and a non-matching email.
        process.env.SIGNUP_MODE = 'closed';
        const ticket = issueMigrationHandoff(secret, { kind: 'web', accountId: migrated });
        const claimed = await loginWithHandoff(ticket, { sub: 'subject-mig', email: 'moved@apodex.com', email_verified: true, name: 'Moved Person' });
        expect(claimed.error).toBeNull();
        expect(claimed.secret).toBe(migratedSecret);
        expect(await db.account.count()).toBe(before + 1);
        expect((await db.accountIdentity.findMany({ where: { accountId: migrated } })).map((row) => row.provider).sort()).toEqual(['google', `oidc:${idp.issuer}`]);
        // The ticket is spent: the same one cannot be used for a second SSO round trip.
        expect((await loginWithHandoff(ticket, { sub: 'subject-mig' })).error).toBe('invalid_migration_handoff');

        // A subject that already made an EMPTY account here is folded into the migrated one.
        process.env.SIGNUP_MODE = 'open';
        const stray = await login({ sub: 'subject-stray', email: 'stray@apodex.com', email_verified: false });
        expect(stray.error).toBeNull();
        const strayAccount = (await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-stray' } }))!.accountId;
        const migrated2 = await seedAccount('migrated-2', { provider: 'email', email: 'two@gmail.com' }, Buffer.alloc(32, 22).toString('base64url'));
        const folded = await loginWithHandoff(issueMigrationHandoff(secret, { kind: 'web', accountId: migrated2 }), { sub: 'subject-stray', email: 'stray@apodex.com' });
        expect(folded.error).toBeNull();
        expect(folded.secret).toBe(Buffer.alloc(32, 22).toString('base64url'));
        expect((await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-stray' } }))!.accountId).toBe(migrated2);
        expect(await db.accountIdentity.count({ where: { accountId: strayAccount } })).toBe(0);

        // A subject whose account here already has a machine is a conflict; nothing moves.
        const busy = await login({ sub: 'subject-busy', email: 'busy@apodex.com', email_verified: false });
        expect(busy.error).toBeNull();
        const busyAccount = (await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-busy' } }))!.accountId;
        await db.machine.create({ data: { id: 'busy-machine', accountId: busyAccount, metadata: '' } });
        const migrated3 = await seedAccount('migrated-3', { provider: 'email', email: 'three@gmail.com' }, Buffer.alloc(32, 23).toString('base64url'));
        const conflict = await loginWithHandoff(issueMigrationHandoff(secret, { kind: 'web', accountId: migrated3 }), { sub: 'subject-busy' });
        expect(conflict.error).toBe('migration_conflict');
        expect((await db.accountIdentity.findFirst({ where: { providerSubject: 'subject-busy' } }))!.accountId).toBe(busyAccount);
        expect(await db.accountIdentity.count({ where: { accountId: migrated3 } })).toBe(1);
    });

    it('reports 501 everywhere when OIDC is not configured and never reads an id_token from the query', async () => {
        const saved = process.env.OIDC_ISSUER;
        delete process.env.OIDC_ISSUER;
        const { oidcAuthRoutes } = await import('./oidcAuthRoutes');
        const off = fastify();
        off.setValidatorCompiler(validatorCompiler);
        off.setSerializerCompiler(serializerCompiler);
        oidcAuthRoutes(off.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
        await off.ready();
        try {
            expect((await off.inject({ method: 'POST', url: '/v1/auth/oidc/start', payload: {} })).statusCode).toBe(501);
            expect((await off.inject({ method: 'POST', url: '/v1/auth/oidc/complete', payload: { handoff: 'x'.repeat(20) } })).statusCode).toBe(501);
            expect((await off.inject({ method: 'GET', url: '/v1/auth/oidc/callback', query: { code: 'c', state: 's' } })).statusCode).toBe(501);
        } finally {
            process.env.OIDC_ISSUER = saved;
            await off.close();
        }
        // A forged id_token in the query is ignored: the state is unknown, so nothing is exchanged.
        const forged = idp.signIdToken({ iss: idp.issuer, aud: idp.clientId, sub: 'forged', exp: Math.floor(Date.now() / 1000) + 60 });
        const res = await callback({ code: 'good-code', state: 'nope', id_token: forged });
        expect(returned(res.headers.location as string).error).toBe('invalid_state');
    });
});
