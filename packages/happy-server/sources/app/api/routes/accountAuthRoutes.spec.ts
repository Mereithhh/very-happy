import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { dbMock, authMock, accountSecretsMock, allowAuthRequestMock } = vi.hoisted(() => {
    const dbMock: any = {
        account: { findUnique: vi.fn() },
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
        allowAuthRequestMock: vi.fn(async () => true),
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/auth/auth', () => ({ auth: authMock }));
vi.mock('@/app/auth/accountSecrets', () => accountSecretsMock);
vi.mock('@/app/auth/authRateLimiter', () => ({ allowAuthRequest: allowAuthRequestMock }));

import {
    accountAuthRoutes,
    accountPublicKeyFromSecret,
    consumeRateBucketsSequentially,
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
    vi.clearAllMocks();
    delete process.env.E2EE_SIGNUP_ENABLED;
    delete process.env.E2EE_SIGNUP_REQUIRED;
    dbMock.account.findUnique.mockResolvedValue({ publicKey: credentialPublicKey, AccountIdentity: [] });
    dbMock.accountLoginSession.findFirst.mockResolvedValue({ createdAt: new Date() });
    dbMock.$queryRawUnsafe.mockResolvedValue([]);
    dbMock.$executeRawUnsafe.mockResolvedValue(1);
    dbMock.$transaction.mockImplementation(async (fn: (tx: any) => unknown) => fn(dbMock));
    authMock.createLoginToken.mockResolvedValue({ token: 'login-token', expiresAt: new Date('2030-01-01T00:00:00.000Z') });
    accountSecretsMock.upsertAccountSecret.mockResolvedValue('encrypted-secret');
    allowAuthRequestMock.mockResolvedValue(true);
});

describe('E2EE downgrade gates', () => {
    it('blocks trusted-v1 password account creation when E2EE signup is required', async () => {
        process.env.E2EE_SIGNUP_ENABLED = 'true';
        process.env.E2EE_SIGNUP_REQUIRED = 'true';
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/signup/password',
            payload: {
                username: 'alice',
                password: 'correct horse battery staple',
                secret: credentialSecret,
            },
        });
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({ error: 'e2ee_client_required' });
        expect(dbMock.$transaction).not.toHaveBeenCalled();
        await app.close();
    });

    it('cannot write a legacy escrow credential back to an E2EE account', async () => {
        dbMock.account.findUnique.mockResolvedValueOnce({ cryptoMode: 'e2ee-v1' });
        const app = await buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/credentials',
            payload: {
                username: 'alice',
                password: 'correct horse battery staple',
                secret: credentialSecret,
            },
        });
        expect(response.statusCode).toBe(426);
        expect(response.json()).toEqual({ error: 'e2ee_client_required' });
        expect(accountSecretsMock.upsertAccountSecret).not.toHaveBeenCalled();
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
