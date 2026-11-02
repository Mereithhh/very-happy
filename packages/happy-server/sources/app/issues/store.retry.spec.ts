import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTS rule 12: issue writes run in SERIALIZABLE `inTx`, which retries
 * Prisma P2034 and raw-query P2010 + SQLSTATE 40001; a racing unique insert
 * (P2002) is retried by the issue store; exhausted retries surface as a
 * retryable 409 `transaction_conflict`, never a 500.
 */
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { $transaction: transaction } }));
vi.mock('@/utils/delay', () => ({ delay: async () => undefined }));

const p2034 = () => new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
const p2010 = () => new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: '40001', message: 'could not serialize access' } });
const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
const emptyTx = { issue: { findMany: async () => [] } };

describe('issues store transaction retries', () => {
    beforeEach(() => { transaction.mockReset(); process.env.VH_ISSUES_ENABLED = 'true'; });

    it('retries P2034 then P2010/40001 and succeeds, SERIALIZABLE', async () => {
        transaction.mockRejectedValueOnce(p2034()).mockRejectedValueOnce(p2010()).mockImplementationOnce(async (fn: any) => fn(emptyTx));
        const { listIssues } = await import('./store');
        await expect(listIssues('acct', {})).resolves.toMatchObject({ issues: [], nextCursor: null });
        expect(transaction).toHaveBeenCalledTimes(3);
        expect(transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' });
    });

    it('maps exhausted serialization retries to 409 transaction_conflict', async () => {
        transaction.mockRejectedValue(p2010());
        const { listIssues } = await import('./store');
        await expect(listIssues('acct', {})).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
    });

    it('retries a racing unique insert (P2002), then answers 409', async () => {
        transaction.mockRejectedValueOnce(p2002()).mockImplementationOnce(async (fn: any) => fn(emptyTx));
        const { listIssues } = await import('./store');
        await expect(listIssues('acct', {})).resolves.toMatchObject({ issues: [] });
        transaction.mockReset();
        transaction.mockRejectedValue(p2002());
        await expect(listIssues('acct', {})).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
        expect(transaction).toHaveBeenCalledTimes(4);
    });

    it('switch off: refused before any transaction', async () => {
        delete process.env.VH_ISSUES_ENABLED;
        const { listIssues } = await import('./store');
        await expect(listIssues('acct', {})).rejects.toMatchObject({ code: 'issues_disabled', status: 404 });
        expect(transaction).not.toHaveBeenCalled();
    });
});
