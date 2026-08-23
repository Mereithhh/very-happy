import { beforeAll, describe, expect, it, vi } from 'vitest';

const { sessions, dbMock } = vi.hoisted(() => {
    const sessions = new Map<string, {
        accountId: string;
        tokenHash: string;
        expiresAt: Date;
        revokedAt: Date | null;
    }>();
    const dbMock = {
        $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
            if (sql.includes('INSERT INTO "AccountLoginSession"')) {
                sessions.set(values[0] as string, {
                    accountId: values[1] as string,
                    tokenHash: values[2] as string,
                    expiresAt: values[3] as Date,
                    revokedAt: null,
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
        $queryRawUnsafe: vi.fn(async (_sql: string, id: string) => {
            const row = sessions.get(id);
            return row ? [row] : [];
        }),
    };
    return { sessions, dbMock };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));

import { auth } from './auth';

describe('persistent Cloud login session', () => {
    beforeAll(async () => {
        process.env.HANDY_MASTER_SECRET = 'login-session-integration-master';
        await auth.init();
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
        const transactionWriter = { $executeRawUnsafe: vi.fn(async () => { throw new Error('transaction aborted'); }) };
        await expect(auth.createLoginToken('account-rollback', transactionWriter as any, { cache: false }))
            .rejects.toThrow('transaction aborted');
        expect(transactionWriter.$executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(sessions.size).toBe(before);
    });
});
