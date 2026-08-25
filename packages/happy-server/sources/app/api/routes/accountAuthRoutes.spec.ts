import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const {
    dbMock,
    authMock,
    accountSecretsMock,
    allowAuthRequestMock,
    createEmailChallengeMock,
    consumeEmailChallengeMock,
    sendLoginCodeMock,
    getAccountLoginMethodsMock,
    linkVerifiedEmailIdentityMock,
    verifyGoogleIdTokenMock,
    linkVerifiedGoogleIdentityMock,
} = vi.hoisted(() => {
    const dbMock: any = {
        account: { findUnique: vi.fn(), create: vi.fn(), count: vi.fn(async () => 0) },
        accountLoginSession: { findFirst: vi.fn() },
        $queryRawUnsafe: vi.fn(),
        $executeRawUnsafe: vi.fn(),
    };
    dbMock.$transaction = vi.fn(async (fn: (tx: any) => unknown) => fn(dbMock));
    return {
        dbMock,
        authMock: {
            createLoginToken: vi.fn(async () => ({ token: 'login-token', expiresAt: new Date('2030-01-01T00:00:00.000Z') })),
            invalidateUserTokens: vi.fn(),
        },
        accountSecretsMock: {
            loadAccountSecret: vi.fn(),
            upsertAccountSecret: vi.fn(async () => 'encrypted-secret'),
        },
        allowAuthRequestMock: vi.fn(async (_key: string, _options: unknown) => true),
        createEmailChallengeMock: vi.fn(),
        consumeEmailChallengeMock: vi.fn(),
        sendLoginCodeMock: vi.fn(),
        getAccountLoginMethodsMock: vi.fn(),
        linkVerifiedEmailIdentityMock: vi.fn(),
        verifyGoogleIdTokenMock: vi.fn(),
        linkVerifiedGoogleIdentityMock: vi.fn(),
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/auth/auth', () => ({ auth: authMock }));
vi.mock('@/app/auth/accountSecrets', () => accountSecretsMock);
vi.mock('@/app/auth/authRateLimiter', () => ({ allowAuthRequest: allowAuthRequestMock }));
vi.mock('@/app/auth/emailLoginSecurity', () => ({
    normalizeEmail: (email: string) => email.trim().toLowerCase(),
    createEmailLoginChallenge: createEmailChallengeMock,
    deleteEmailLoginChallenge: vi.fn(),
    consumeEmailLoginChallenge: consumeEmailChallengeMock,
    EmailLoginChallengeCapacityError: class EmailLoginChallengeCapacityError extends Error {},
}));
vi.mock('@/app/auth/emailSender', () => ({
    sendLoginCode: sendLoginCodeMock,
    EmailDeliveryError: class EmailDeliveryError extends Error {},
}));
vi.mock('@/app/auth/emailIdentityLink', () => ({
    getAccountLoginMethods: getAccountLoginMethodsMock,
    linkVerifiedEmailIdentity: linkVerifiedEmailIdentityMock,
    EmailIdentityInUseError: class EmailIdentityInUseError extends Error {},
}));
vi.mock('@/app/auth/googleOidc', () => ({ verifyGoogleIdToken: verifyGoogleIdTokenMock }));
vi.mock('@/app/auth/googleIdentityLink', () => ({
    linkVerifiedGoogleIdentity: linkVerifiedGoogleIdentityMock,
    GoogleIdentityInUseError: class GoogleIdentityInUseError extends Error {},
}));

import {
    accountAuthRoutes,
    accountPublicKeyFromSecret,
    consumeRateBucketsSequentially,
    emailCodeRateBuckets,
    emailVerifyRateBuckets,
    enabledReplacementIdentityProviders,
    googleChallengeRateBucket,
    googleLoginRateBucket,
    hashPassword,
    passwordLoginRateBuckets,
    verifyPassword,
} from './accountAuthRoutes';

async function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account-1';
        request.authLoginSessionId = 'login-session-1';
    });
    accountAuthRoutes(typed);
    await app.ready();
    return app;
}

const credentialSecret = Buffer.alloc(32, 7).toString('base64url');
const credentialPublicKey = accountPublicKeyFromSecret(credentialSecret)!;

beforeEach(() => {
    delete process.env.AUTH_EMAIL_PROVIDER;
    delete process.env.AUTH_EMAIL_FROM;
    delete process.env.RESEND_API_KEY;
    delete process.env.AUTH_PASSWORD_LOGIN_DISABLED;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_ALLOWED_ORIGINS;
    delete process.env.SIGNUP_MODE;
    vi.clearAllMocks();
    dbMock.account.findUnique.mockResolvedValue({ publicKey: credentialPublicKey, AccountIdentity: [] });
    dbMock.accountLoginSession.findFirst.mockResolvedValue({ createdAt: new Date() });
    dbMock.$queryRawUnsafe.mockResolvedValue([]);
    dbMock.$executeRawUnsafe.mockResolvedValue(1);
    dbMock.$transaction.mockImplementation(async (fn: (tx: any) => unknown) => fn(dbMock));
    authMock.createLoginToken.mockResolvedValue({ token: 'login-token', expiresAt: new Date('2030-01-01T00:00:00.000Z') });
    accountSecretsMock.upsertAccountSecret.mockResolvedValue('encrypted-secret');
    allowAuthRequestMock.mockResolvedValue(true);
    createEmailChallengeMock.mockResolvedValue({
        id: '37ac495d-799b-4290-9048-fcf4ee37c0f0',
        email: 'person@example.com',
        code: '123456',
        expiresAt: new Date('2030-01-01T00:10:00.000Z'),
    });
    consumeEmailChallengeMock.mockResolvedValue(true);
    sendLoginCodeMock.mockResolvedValue(undefined);
    getAccountLoginMethodsMock.mockResolvedValue({
        email: null,
        google: { connected: false, email: null },
        passwordConfigured: true,
    });
    linkVerifiedEmailIdentityMock.mockResolvedValue('linked');
    verifyGoogleIdTokenMock.mockResolvedValue({
        sub: 'google-subject', email: 'owner@example.com', emailVerified: true,
        name: 'Owner', picture: 'https://example.com/avatar.png',
    });
    linkVerifiedGoogleIdentityMock.mockResolvedValue('linked');
});

describe('public Email OTP and password policy', () => {
    function enableEmail() {
        process.env.AUTH_EMAIL_PROVIDER = 'resend';
        process.env.AUTH_EMAIL_FROM = 'login@veryhappy.dev';
        process.env.RESEND_API_KEY = 'test-key';
    }

    it('advertises Email OTP as the default-capable method while preserving password by default', async () => {
        enableEmail();
        const app = await buildApp();
        const response = await app.inject({ method: 'GET', url: '/v1/auth/config' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ emailOtpEnabled: true, passwordLoginEnabled: true });
        await app.close();
    });

    it('uses long-window email, IP, and global delivery budgets', () => {
        const send = emailCodeRateBuckets('203.0.113.1', 'person@example.com', {
            globalDailySendLimit: 200,
            globalMonthlySendLimit: 3_000,
        });
        expect(send).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: expect.stringContaining('email:'), max: 3, windowMs: 24 * 60 * 60_000 }),
            expect.objectContaining({ key: 'email-code:global:day', max: 200 }),
            expect.objectContaining({ key: 'email-code:global:month', max: 3_000 }),
        ]));
        const verify = emailVerifyRateBuckets('203.0.113.1', 'person@example.com', 'challenge');
        expect(verify).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: expect.stringContaining('email:'), max: 9, windowMs: 24 * 60 * 60_000 }),
            expect.objectContaining({ key: expect.stringContaining('challenge:'), max: 4 }),
        ]));
    });

    it('never persists a raw client IP in Google limiter keys', () => {
        const challenge = googleChallengeRateBucket('203.0.113.42');
        const login = googleLoginRateBucket('203.0.113.42');
        expect(challenge).toMatchObject({ max: 60, windowMs: 60_000 });
        expect(login).toMatchObject({ max: 60, windowMs: 60_000 });
        expect(challenge.key).toMatch(/^google-challenge:ip:[a-f0-9]{32}$/);
        expect(login.key).toMatch(/^google-login:ip:[a-f0-9]{32}$/);
        expect(`${challenge.key}${login.key}`).not.toContain('203.0.113.42');
    });

    it('refuses password shutdown while a password-only account remains', async () => {
        enableEmail();
        process.env.AUTH_PASSWORD_LOGIN_DISABLED = 'true';
        dbMock.$queryRawUnsafe.mockResolvedValueOnce([{ count: 1n }]);
        await expect(buildApp()).rejects.toThrow('password-only accounts exist');
    });

    it('counts legacy credentials and only accepts currently configured replacement providers', () => {
        expect(enabledReplacementIdentityProviders(true, false)).toEqual(['email']);
        expect(enabledReplacementIdentityProviders(false, true)).toEqual(['google']);
        expect(enabledReplacementIdentityProviders(true, true)).toEqual(['email', 'google']);
    });

    it('does not treat a disabled Google identity as a usable replacement', async () => {
        enableEmail();
        process.env.AUTH_PASSWORD_LOGIN_DISABLED = 'true';
        dbMock.$queryRawUnsafe.mockResolvedValueOnce([{ count: 0n }]);
        const app = await buildApp();
        expect(dbMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringMatching(/IN \('email'\)/));
        expect(dbMock.$queryRawUnsafe.mock.calls[0][0]).not.toContain("'google'");
        await app.close();
    });

    it('does not treat a disabled Email identity as a usable replacement', async () => {
        process.env.GOOGLE_CLIENT_ID = 'google-client';
        process.env.GOOGLE_ALLOWED_ORIGINS = 'https://veryhappy.dev';
        process.env.AUTH_PASSWORD_LOGIN_DISABLED = 'true';
        dbMock.$queryRawUnsafe.mockResolvedValueOnce([{ count: 0n }]);
        const app = await buildApp();
        expect(dbMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringMatching(/IN \('google'\)/));
        expect(dbMock.$queryRawUnsafe.mock.calls[0][0]).not.toContain("'email'");
        await app.close();
    });

    it('sends a normalized code without exposing it in the API response', async () => {
        enableEmail();
        const challengeId = '37ac495d-799b-4290-9048-fcf4ee37c0f0';
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST', url: '/v1/auth/email/code', payload: { email: ' Person@Example.com ' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            challengeId,
            expiresAt: '2030-01-01T00:10:00.000Z',
        });
        expect(sendLoginCodeMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'resend' }), {
            to: 'person@example.com', code: '123456', expiresInMinutes: 10,
            idempotencyKey: challengeId,
        });
        expect(response.body).not.toContain('123456');
        await app.close();
    });

    it('logs in an existing email identity only after consuming the matching challenge', async () => {
        enableEmail();
        process.env.SIGNUP_MODE = 'closed';
        dbMock.$queryRawUnsafe.mockImplementation(async (sql: string) => {
            if (sql.includes('"provider" = \'email\'')) return [{ accountId: 'email-account' }];
            return [{ id: 1 }];
        });
        accountSecretsMock.loadAccountSecret.mockResolvedValue('account-secret');
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST', url: '/v1/account/login/email',
            payload: {
                email: 'person@example.com',
                challengeId: '37ac495d-799b-4290-9048-fcf4ee37c0f0',
                code: '123456',
            },
        });
        expect(response.statusCode).toBe(200);
        expect(consumeEmailChallengeMock).toHaveBeenCalledWith(
            '37ac495d-799b-4290-9048-fcf4ee37c0f0', 'person@example.com', '123456',
        );
        expect(response.json()).toMatchObject({ token: 'login-token', secret: 'account-secret' });
        await app.close();
    });

    it('enforces password disablement at the server boundary, not only in Web UI', async () => {
        enableEmail();
        process.env.AUTH_PASSWORD_LOGIN_DISABLED = 'true';
        const app = await buildApp();
        const config = await app.inject({ method: 'GET', url: '/v1/auth/config' });
        expect(config.json()).toMatchObject({ emailOtpEnabled: true, passwordLoginEnabled: false });
        const login = await app.inject({
            method: 'POST', url: '/v1/account/login', payload: { username: 'alice', password: 'password' },
        });
        const signup = await app.inject({
            method: 'POST', url: '/v1/account/signup/password',
            payload: { username: 'alice', password: 'password', secret: credentialSecret },
        });
        expect(login.statusCode).toBe(403);
        expect(signup.statusCode).toBe(403);
        expect(login.json()).toEqual({ error: 'password_login_disabled' });
        expect(signup.json()).toEqual({ error: 'password_login_disabled' });
        expect(dbMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        expect(dbMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('AccountCredential'));
        await app.close();
    });
});

describe('password credential hashing', () => {
    it('stores a salted scrypt hash and verifies only the matching password', async () => {
        const first = await hashPassword('correct horse battery staple');
        const second = await hashPassword('correct horse battery staple');
        expect(first).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
        expect(first).not.toBe(second);
        await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
        await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
    });

    it('fails closed for malformed stored values', async () => {
        await expect(verifyPassword('password', 'plaintext')).resolves.toBe(false);
        await expect(verifyPassword('password', 'scrypt$not-hex$also-not-hex')).resolves.toBe(false);
    });
});

describe('password signup secret validation', () => {
    it('derives a stable account key only from a 32-byte secret', () => {
        const secret = Buffer.alloc(32, 7).toString('base64url');
        expect(accountPublicKeyFromSecret(secret)).toMatch(/^[a-f0-9]{64}$/);
        expect(accountPublicKeyFromSecret(secret)).toBe(accountPublicKeyFromSecret(secret));
        expect(accountPublicKeyFromSecret(Buffer.alloc(31, 7).toString('base64url'))).toBeNull();
        expect(accountPublicKeyFromSecret('not-base64')).toBeNull();
    });
});

describe('authenticated account credential secret validation', () => {
    const payload = {
        username: 'alice',
        password: 'correct horse battery staple',
        secret: credentialSecret,
    };

    it('rejects a value that is not a 32-byte seed before touching account credentials', async () => {
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload: { ...payload, secret: Buffer.alloc(31, 7).toString('base64url') },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_secret' });
        expect(dbMock.account.findUnique).not.toHaveBeenCalled();
        expect(accountSecretsMock.upsertAccountSecret).not.toHaveBeenCalled();
        await app.close();
    });

    it('rejects a valid seed whose derived key does not match Account.publicKey', async () => {
        dbMock.account.findUnique.mockResolvedValue({
            publicKey: accountPublicKeyFromSecret(Buffer.alloc(32, 8).toString('base64url')),
            AccountIdentity: [],
        });
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_secret' });
        expect(accountSecretsMock.upsertAccountSecret).not.toHaveBeenCalled();
        expect(dbMock.$queryRawUnsafe).not.toHaveBeenCalled();
        await app.close();
    });

    it('accepts only the seed anchored to the authenticated account public key', async () => {
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ success: true, token: 'login-token', secret: credentialSecret });
        expect(dbMock.account.findUnique).toHaveBeenCalledWith({
            where: { id: 'account-1' },
            select: {
                publicKey: true,
                AccountIdentity: { select: { provider: true } },
            },
        });
        expect(accountSecretsMock.upsertAccountSecret).toHaveBeenCalledWith(dbMock, 'account-1', credentialSecret);
        await app.close();
    });

    it('requires a recent login session before changing an established login identity', async () => {
        dbMock.account.findUnique.mockResolvedValue({
            publicKey: credentialPublicKey,
            AccountIdentity: [{ provider: 'google' }],
        });
        dbMock.accountLoginSession.findFirst.mockResolvedValue({
            createdAt: new Date(Date.now() - 11 * 60 * 1000),
        });
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload,
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'reauth_required' });
        expect(accountSecretsMock.upsertAccountSecret).not.toHaveBeenCalled();
        await app.close();
    });

    it('revokes other login sessions after recent step-up and returns a replacement', async () => {
        dbMock.account.findUnique.mockResolvedValue({
            publicKey: credentialPublicKey,
            AccountIdentity: [{ provider: 'password' }],
        });
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload,
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.accountLoginSession.findFirst).toHaveBeenCalledWith({
            where: { id: 'login-session-1', accountId: 'account-1', revokedAt: null },
            select: { createdAt: true },
        });
        expect(dbMock.$executeRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE "AccountLoginSession"'),
            'account-1',
        );
        expect(authMock.createLoginToken).toHaveBeenCalledWith('account-1', dbMock, { cache: false });
        expect(authMock.invalidateUserTokens).toHaveBeenCalledWith('account-1');
        await app.close();
    });

    it('rate-limits credential changes before password hashing and writes', async () => {
        allowAuthRequestMock.mockResolvedValue(false);
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload,
        });

        expect(response.statusCode).toBe(429);
        expect(response.json()).toEqual({ error: 'too_many_requests' });
        expect(allowAuthRequestMock).toHaveBeenCalledWith(
            'credential-change:account-1',
            { max: 5, windowMs: 60_000 },
        );
        expect(dbMock.$transaction).not.toHaveBeenCalled();
        await app.close();
    });

    it('serializes concurrent changes and retains only the latest password identity', async () => {
        dbMock.account.findUnique.mockResolvedValue({
            publicKey: credentialPublicKey,
            AccountIdentity: [{ provider: 'password' }, { provider: 'google' }],
        });
        const identities = [
            { provider: 'password', providerSubject: 'old-name' },
            { provider: 'google', providerSubject: 'google-subject' },
        ];
        let credentialUsername = 'old-name';
        let tail = Promise.resolve();
        dbMock.$transaction.mockImplementation((fn: (tx: any) => unknown) => {
            const result = tail.then(() => fn(dbMock));
            tail = result.then(() => undefined, () => undefined);
            return result;
        });
        dbMock.$queryRawUnsafe.mockImplementation(async (sql: string, value?: string) => {
            if (sql.includes('FROM "AccountCredential"')) {
                return credentialUsername === value ? [{ accountId: 'account-1' }] : [];
            }
            return [{ id: 'account-1' }];
        });
        dbMock.$executeRawUnsafe.mockImplementation(async (sql: string, ...values: unknown[]) => {
            if (sql.startsWith('DELETE FROM "AccountCredential"')) credentialUsername = '';
            if (sql.includes('INSERT INTO "AccountCredential"')) credentialUsername = values[0] as string;
            if (sql.includes('DELETE FROM "AccountIdentity"')) {
                for (let index = identities.length - 1; index >= 0; index -= 1) {
                    if (identities[index].provider === 'password') identities.splice(index, 1);
                }
            }
            if (sql.includes('INSERT INTO "AccountIdentity"')) {
                identities.push({ provider: 'password', providerSubject: values[2] as string });
            }
            return 1;
        });

        const app = await buildApp();
        const change = (username: string) => app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload: { ...payload, username },
        });
        const responses = await Promise.all([change('alice-one'), change('alice-two')]);

        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        const passwordIdentities = identities.filter((identity) => identity.provider === 'password');
        expect(passwordIdentities).toHaveLength(1);
        expect(['alice-one', 'alice-two']).toContain(passwordIdentities[0].providerSubject);
        expect(passwordIdentities[0].providerSubject).toBe(credentialUsername);
        expect(identities).toContainEqual({ provider: 'google', providerSubject: 'google-subject' });
        expect(dbMock.$queryRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining('FOR UPDATE'),
            'account-1',
        );
        await app.close();
    });
});

describe('authenticated Email identity linking', () => {
    const linkPayload = {
        email: ' Owner@Example.com ',
        challengeId: '37ac495d-799b-4290-9048-fcf4ee37c0f0',
        code: '123456',
        secret: credentialSecret,
    };

    function enableEmail() {
        process.env.AUTH_EMAIL_PROVIDER = 'resend';
        process.env.AUTH_EMAIL_FROM = 'login@veryhappy.dev';
        process.env.RESEND_API_KEY = 'test-key';
    }

    it('reports only the current account login methods without exposing provider subjects', async () => {
        getAccountLoginMethodsMock.mockResolvedValue({
            email: 'owner@example.com',
            google: { connected: true, email: 'owner@example.com' },
            passwordConfigured: true,
        });
        const app = await buildApp();
        const response = await app.inject({ method: 'GET', url: '/v1/account/identities' });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            email: 'owner@example.com',
            google: { connected: true, email: 'owner@example.com' },
            passwordConfigured: true,
        });
        expect(getAccountLoginMethodsMock).toHaveBeenCalledWith(dbMock, 'account-1');
        await app.close();
    });

    it('binds a verified normalized email to the authenticated account anchored by its secret', async () => {
        enableEmail();
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, email: 'owner@example.com' });
        expect(linkVerifiedEmailIdentityMock).toHaveBeenCalledWith(dbMock, 'account-1', {
            email: 'owner@example.com',
            challengeId: linkPayload.challengeId,
            code: linkPayload.code,
        });
        await app.close();
    });

    it('rejects the wrong account secret before consuming the email challenge', async () => {
        enableEmail();
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/identities/email',
            payload: { ...linkPayload, secret: Buffer.alloc(32, 9).toString('base64url') },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_secret' });
        expect(linkVerifiedEmailIdentityMock).not.toHaveBeenCalled();
        await app.close();
    });

    it('requires a fresh, unrevoked login session before checking the account secret or OTP', async () => {
        enableEmail();
        dbMock.accountLoginSession.findFirst.mockResolvedValue({
            createdAt: new Date(Date.now() - 11 * 60_000),
        });
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'reauth_required' });
        expect(dbMock.accountLoginSession.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'login-session-1',
                accountId: 'account-1',
                revokedAt: null,
                expiresAt: { gt: expect.any(Date) },
            },
            select: { createdAt: true },
        });
        expect(dbMock.account.findUnique).not.toHaveBeenCalled();
        expect(linkVerifiedEmailIdentityMock).not.toHaveBeenCalled();
        await app.close();
    });

    it('maps a consumed, expired, mismatched, or wrong Email OTP to one generic response', async () => {
        enableEmail();
        linkVerifiedEmailIdentityMock.mockResolvedValue('invalid-code');
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'invalid_email_code' });
        await app.close();
    });

    it('adds per-account hour/day budgets to the shared Email verification buckets', async () => {
        enableEmail();
        allowAuthRequestMock.mockImplementation(async (key: string) => !key.includes('email-link:account:'));
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(429);
        expect(allowAuthRequestMock).toHaveBeenCalledWith(
            expect.stringMatching(/^email-link:account:[a-f0-9]+:hour$/),
            { max: 5, windowMs: 60 * 60_000 },
        );
        expect(linkVerifiedEmailIdentityMock).not.toHaveBeenCalled();
        await app.close();
    });

    it('does not merge an email identity that already belongs to another account', async () => {
        enableEmail();
        const { EmailIdentityInUseError } = await import('@/app/auth/emailIdentityLink');
        linkVerifiedEmailIdentityMock.mockRejectedValue(new EmailIdentityInUseError());
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'email_identity_in_use' });
        expect(linkVerifiedEmailIdentityMock).toHaveBeenCalledOnce();
        await app.close();
    });

    it('is idempotent when the verified email is already linked to this account', async () => {
        enableEmail();
        const app = await buildApp();
        const response = await app.inject({ method: 'POST', url: '/v1/account/identities/email', payload: linkPayload });

        expect(response.statusCode).toBe(200);
        expect(linkVerifiedEmailIdentityMock).toHaveBeenCalledOnce();
        await app.close();
    });
});

describe('authenticated Google identity linking', () => {
    const nonce = 'n'.repeat(43);
    const payload = { credential: 'google-id-token', nonce, secret: credentialSecret };

    function enableGoogle() {
        process.env.GOOGLE_CLIENT_ID = 'google-client';
        process.env.GOOGLE_ALLOWED_ORIGINS = 'https://veryhappy.dev';
    }

    async function inject(payloadOverride: Record<string, unknown> = {}, origin = 'https://veryhappy.dev') {
        enableGoogle();
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/identities/google',
            headers: { origin },
            payload: { ...payload, ...payloadOverride },
        });
        await app.close();
        return response;
    }

    it('links a nonce-bound verified Google identity to the authenticated account', async () => {
        const response = await inject();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true, email: 'owner@example.com' });
        expect(verifyGoogleIdTokenMock).toHaveBeenCalledWith('google-id-token', 'google-client', {
            expectedNonce: nonce,
        });
        expect(linkVerifiedGoogleIdentityMock).toHaveBeenCalledWith(dbMock, 'account-1', {
            nonce,
            claims: expect.objectContaining({ sub: 'google-subject' }),
        });
    });

    it('requires an allowed browser origin', async () => {
        const response = await inject({}, 'https://attacker.example');
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'origin_not_allowed' });
        expect(verifyGoogleIdTokenMock).not.toHaveBeenCalled();
    });

    it('requires a fresh login session and the current account secret', async () => {
        dbMock.accountLoginSession.findFirst.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 11 * 60_000) });
        const stale = await inject();
        expect(stale.statusCode).toBe(403);
        expect(stale.json()).toEqual({ error: 'reauth_required' });
        expect(verifyGoogleIdTokenMock).not.toHaveBeenCalled();

        vi.clearAllMocks();
        dbMock.accountLoginSession.findFirst.mockResolvedValue({ createdAt: new Date() });
        dbMock.account.findUnique.mockResolvedValue({ publicKey: credentialPublicKey });
        allowAuthRequestMock.mockResolvedValue(true);
        const wrongSecret = await inject({ secret: Buffer.alloc(32, 9).toString('base64url') });
        expect(wrongSecret.statusCode).toBe(400);
        expect(wrongSecret.json()).toEqual({ error: 'invalid_secret' });
        expect(verifyGoogleIdTokenMock).not.toHaveBeenCalled();
    });

    it('returns one generic credential error for invalid tokens and consumed challenges', async () => {
        verifyGoogleIdTokenMock.mockRejectedValueOnce(new Error('bad-token'));
        const badToken = await inject();
        expect(badToken.statusCode).toBe(401);
        expect(badToken.json()).toEqual({ error: 'invalid_google_credential' });

        linkVerifiedGoogleIdentityMock.mockResolvedValueOnce('invalid-challenge');
        const consumed = await inject();
        expect(consumed.statusCode).toBe(401);
        expect(consumed.json()).toEqual({ error: 'invalid_google_credential' });
    });

    it('never moves a Google identity between accounts', async () => {
        const { GoogleIdentityInUseError } = await import('@/app/auth/googleIdentityLink');
        linkVerifiedGoogleIdentityMock.mockRejectedValueOnce(new GoogleIdentityInUseError());
        const response = await inject();
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'google_identity_in_use' });
    });
});

describe('password login abuse buckets', () => {
    it('shares IP and global limits even when an attacker rotates usernames', () => {
        const first = passwordLoginRateBuckets('203.0.113.7', 'alice');
        const second = passwordLoginRateBuckets('203.0.113.7', 'bob');
        expect(first[0]).toEqual(second[0]);
        expect(first[1].key).not.toBe(second[1].key);
        expect(first[2]).toEqual(second[2]);
        expect(JSON.stringify(first)).not.toMatch(/203\.0\.113\.7|alice/);
    });

    it('stops at the rejected IP bucket without consuming the global bucket', async () => {
        const calls: string[] = [];
        const consume = async (key: string) => {
            calls.push(key);
            return !key.includes(':ip:');
        };
        const buckets = passwordLoginRateBuckets('203.0.113.7', 'rotating-user');
        await expect(consumeRateBucketsSequentially(buckets, consume)).resolves.toBe(false);
        expect(calls).toEqual([buckets[0].key]);
        expect(calls).not.toContain('password-login:global');
    });
});
