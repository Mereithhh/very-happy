import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sessions, dbMock } = vi.hoisted(() => {
    let createdCounter = 0;
    const sessions = new Map<string, {
        accountId: string;
        tokenHash: string;
        expiresAt: Date;
        revokedAt: Date | null;
        createdAt: Date;
        deviceId: string | null;
        capabilities: string[];
        e2eeProtocol: string | null;
    }>();
    const dbMock = {
        $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
            if (sql.includes('DELETE FROM "AccountLoginSession"') && sql.includes('"revokedAt" IS NOT NULL')) {
                const accountId = values[0] as string;
                for (const [id, row] of sessions) {
                    if (row.accountId === accountId && (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now())) sessions.delete(id);
                }
                return 1;
            }
            if (sql.includes('DELETE FROM "AccountLoginSession"') && sql.includes('OFFSET')) {
                const accountId = values[0] as string;
                const keep = values[1] as number;
                const rows = [...sessions.entries()]
                    .filter(([, row]) => row.accountId === accountId && row.revokedAt === null && row.expiresAt.getTime() > Date.now())
                    .sort((left, right) => right[1].createdAt.getTime() - left[1].createdAt.getTime());
                for (const [id] of rows.slice(keep)) sessions.delete(id);
                return 1;
            }
            if (sql.includes('INSERT INTO "AccountLoginSession"')) {
                sessions.set(values[0] as string, {
                    accountId: values[1] as string,
                    tokenHash: values[2] as string,
                    deviceId: values[3] as string | null,
                    capabilities: values[4] as string[],
                    e2eeProtocol: values[5] as string | null,
                    expiresAt: values[6] as Date,
                    revokedAt: null,
                    createdAt: new Date(++createdCounter),
                });
                return 1;
            }
            if (sql.includes('UPDATE "AccountLoginSession"')) {
                const accountId = values[0] as string;
                const tokenHash = values[1] as string;
                const row = [...sessions.values()].find((candidate) =>
                    candidate.accountId === accountId && candidate.tokenHash === tokenHash && candidate.revokedAt === null,
                );
                if (!row) return 0;
                row.revokedAt = new Date();
                return 1;
            }
            return 0;
        }),
        $queryRawUnsafe: vi.fn(async (sql: string, id: string) => {
            if (sql.includes('FROM "Account"')) return [{ id }];
            const row = sessions.get(id);
            return row ? [{
                ...row,
                cryptoMode: 'trusted-v1',
                cryptoEpoch: 0,
                cryptoWriteState: 'active',
                deviceStatus: null,
            }] : [];
        }),
    };
    (dbMock as any).$transaction = vi.fn(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
    return { sessions, dbMock };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));

import { auth } from './auth';

describe('persistent Cloud login session', () => {
    beforeAll(async () => {
        process.env.HANDY_MASTER_SECRET = 'login-session-integration-master';
        await auth.init();
    });

    beforeEach(() => {
        sessions.clear();
        (auth as any).tokenCache.clear();
    });

    afterEach(() => {
        delete process.env.MAX_LOGIN_SESSIONS_PER_ACCOUNT;
    });

    it('survives a token-cache miss and becomes invalid after revoke', async () => {
        const issued = await auth.createLoginToken('account-1');
        expect(sessions.size).toBe(1);

        // Force the verifier path used after a server restart rather than the
        // just-issued in-memory cache path.
        (auth as any).tokenCache.clear();
        await expect(auth.verifyToken(issued.token)).resolves.toMatchObject({ userId: 'account-1' });

        await expect(auth.revokeLoginToken(issued.token, 'account-1')).resolves.toBe(true);
        (auth as any).tokenCache.clear();
        await expect(auth.verifyToken(issued.token)).resolves.toBeNull();
    });

    it('writes a signup login session through the caller transaction and propagates failure', async () => {
        const before = sessions.size;
        const transactionWriter = {
            $queryRawUnsafe: vi.fn(async () => [{ id: 'account-rollback' }]),
            $executeRawUnsafe: vi.fn(async () => { throw new Error('transaction aborted'); }),
        };
        await expect(auth.createLoginToken('account-rollback', transactionWriter as any, { cache: false }))
            .rejects.toThrow('transaction aborted');
        expect(transactionWriter.$executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(sessions.size).toBe(before);
    });

    it('prunes old sessions before insert and keeps the newly returned token valid', async () => {
        process.env.MAX_LOGIN_SESSIONS_PER_ACCOUNT = '2';
        const first = await auth.createLoginToken('account-capped');
        const second = await auth.createLoginToken('account-capped');
        const newest = await auth.createLoginToken('account-capped');

        expect(sessions.size).toBe(2);
        (auth as any).tokenCache.clear();
        await expect(auth.verifyToken(first.token)).resolves.toBeNull();
        await expect(auth.verifyToken(second.token)).resolves.toMatchObject({ userId: 'account-capped' });
        await expect(auth.verifyToken(newest.token)).resolves.toMatchObject({ userId: 'account-capped' });
    });
});
