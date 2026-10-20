import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTS rule 12: project writes run in SERIALIZABLE `inTx`, which must retry
 * both Prisma P2034 and raw-query P2010 + SQLSTATE 40001; exhausting the
 * retries must surface as a retryable 409, never a 500.
 */
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { $transaction: transaction } }));
vi.mock('@/utils/delay', () => ({ delay: async () => undefined }));

const p2034 = () => new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
const p2010 = () => new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: '40001', message: 'could not serialize access' } });
const emptyTx = {
    project: { findMany: async () => [] },
    agentTeam: { findMany: async () => [] },
    automation: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
};

describe('projects store transaction retries', () => {
    beforeEach(() => { transaction.mockReset(); delete process.env.VH_PROJECTS_ENABLED; });

    it('retries P2034 then P2010/40001 and succeeds', async () => {
        transaction
            .mockRejectedValueOnce(p2034())
            .mockRejectedValueOnce(p2010())
            .mockImplementationOnce(async (fn: any) => fn(emptyTx));
        const { listProjects } = await import('./store');
        await expect(listProjects('acct')).resolves.toEqual({ projects: [], members: [] });
        expect(transaction).toHaveBeenCalledTimes(3);
        expect(transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' });
    });

    it('maps exhausted retries to 409 transaction_conflict', async () => {
        transaction.mockRejectedValue(p2010());
        const { listProjects } = await import('./store');
        await expect(listProjects('acct')).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
        expect(transaction).toHaveBeenCalledTimes(4);
    });

    it('does not retry an unrelated failure', async () => {
        transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }));
        const { listProjects } = await import('./store');
        await expect(listProjects('acct')).rejects.toMatchObject({ code: 'P2002' });
        expect(transaction).toHaveBeenCalledTimes(1);
    });
});
