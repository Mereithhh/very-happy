import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock } = vi.hoisted(() => {
    type Row = { publicKey: string; createdAt: Date };
    const state = {
        terminal: [] as Row[],
        account: [] as Row[],
        tail: Promise.resolve() as Promise<unknown>,
    };
    const client = {
        $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
            if (sql.includes('DELETE FROM "TerminalAuthRequest"')) {
                const cutoff = values[0] as Date;
                state.terminal = state.terminal.filter((row) => row.createdAt > cutoff);
            } else if (sql.includes('DELETE FROM "AccountAuthRequest"')) {
                const cutoff = values[0] as Date;
                state.account = state.account.filter((row) => row.createdAt > cutoff);
            } else if (sql.includes('INSERT INTO "TerminalAuthRequest"')) {
                state.terminal.push({ publicKey: values[1] as string, createdAt: values[4] as Date });
            } else if (sql.includes('INSERT INTO "AccountAuthRequest"')) {
                state.account.push({ publicKey: values[1] as string, createdAt: values[3] as Date });
            }
            return 1;
        }),
        $queryRawUnsafe: vi.fn(async (sql: string) => {
            if (sql.includes('AS "count"')) return [{ count: BigInt(state.terminal.length + state.account.length) }];
            return [{ key: 'auth-pairing-create-cap' }];
        }),
    };
    const dbMock = {
        ...client,
        $transaction: vi.fn((fn: (tx: typeof client) => unknown) => {
            const result = state.tail.then(() => fn(client));
            state.tail = result.then(() => undefined, () => undefined);
            return result;
        }),
    };
    return { state, dbMock };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));

import {
    PAIRING_RESPONSE_MAX_BYTES,
    PairingCapacityError,
    approvePairingRow,
    createPairing,
} from './pairingStore';

const claimSecretHash = '7'.repeat(64);
const key = (index: number) => index.toString(16).padStart(64, '0');

describe('pairingStore growth bounds', () => {
    beforeEach(() => {
        state.terminal = [];
        state.account = [];
        state.tail = Promise.resolve();
        vi.clearAllMocks();
        process.env.AUTH_PAIRING_TTL_MINUTES = '10';
        process.env.MAX_PENDING_AUTH_PAIRINGS = '3';
    });

    afterEach(() => {
        delete process.env.AUTH_PAIRING_TTL_MINUTES;
        delete process.env.MAX_PENDING_AUTH_PAIRINGS;
    });

    it('atomically cleans both tables and caps concurrent random-key creation', async () => {
        const expired = new Date(Date.now() - 11 * 60_000);
        state.terminal.push({ publicKey: key(100), createdAt: expired });
        state.account.push({ publicKey: key(101), createdAt: expired });

        const results = await Promise.allSettled([
            createPairing('terminal', { publicKey: key(1), claimSecretHash, supportsV2: true }),
            createPairing('account', { publicKey: key(2), claimSecretHash }),
            createPairing('terminal', { publicKey: key(3), claimSecretHash, supportsV2: true }),
            createPairing('account', { publicKey: key(4), claimSecretHash }),
            createPairing('terminal', { publicKey: key(5), claimSecretHash, supportsV2: true }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(rejected).toHaveLength(2);
        expect(rejected.every((result) => result.reason instanceof PairingCapacityError)).toBe(true);
        expect(state.terminal.length + state.account.length).toBe(3);
        expect([...state.terminal, ...state.account].some((row) => row.createdAt === expired)).toBe(false);
    });

    it('rejects malformed stored fields and response bytes above the hard cap', async () => {
        await expect(createPairing('terminal', {
            publicKey: 'not-hex',
            claimSecretHash,
        })).rejects.toThrow('32-byte hex');
        await expect(approvePairingRow(
            'terminal',
            'request-1',
            '界'.repeat(PAIRING_RESPONSE_MAX_BYTES),
            'account-1',
            dbMock as any,
        )).rejects.toThrow(`at most ${PAIRING_RESPONSE_MAX_BYTES} bytes`);
    });
});
