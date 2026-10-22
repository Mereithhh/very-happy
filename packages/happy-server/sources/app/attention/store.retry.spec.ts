import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two first posts of one `(sessionId, key)` on separate connections: the loser
 * hits the unique index (P2002) — or a 40001 — and must retry the whole
 * transaction, then see the winner's row as a repost. Exhausted retries
 * surface as a retryable 409, never a 500 (AGENTS rule 12).
 */
const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { $transaction: transaction } }));
vi.mock('@/utils/delay', () => ({ delay: async () => undefined }));
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: vi.fn() }));

const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test', meta: { target: ['sessionId', 'key'] } });
const p2010 = () => new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: '40001', message: 'could not serialize access' } });
const now = new Date();
const winner = {
    id: 'i1', accountId: 'acct', sessionId: 's1', teamId: null, projectId: null, source: 'agent', kind: 'blocked', key: 'login', lastRequestId: 'winner',
    title: 'Need a login', bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, needsOwner: true, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: now, updatedAt: now, resolvedAt: null, pushedAt: null, version: 1,
};
const txAfterWinner = {
    session: { findFirst: async () => ({ id: 's1' }) },
    attentionItem: {
        findUnique: async () => winner,
        update: vi.fn(async ({ data }: { data: { title: string } }) => ({ ...winner, title: data.title, repostCount: 1, version: 2, lastRequestId: 'loser' })),
    },
};

describe('attention store transaction retries', () => {
    beforeEach(() => { transaction.mockReset(); txAfterWinner.attentionItem.update.mockClear(); process.env.VH_OWNER_BOARD_ENABLED = 'true'; });
    const post = async () => (await import('./store')).postItem('acct', { sessionId: 's1', source: 'agent', kind: 'blocked', title: 'Need a login', key: 'login', requestId: 'loser' });

    it('retries a lost unique race and folds into the winner as a repost', async () => {
        transaction.mockRejectedValueOnce(p2002()).mockImplementationOnce(async (fn: any) => fn(txAfterWinner));
        await expect(post()).resolves.toMatchObject({ created: false, item: { id: 'i1', repostCount: 1, version: 2 } });
        expect(transaction).toHaveBeenCalledTimes(2);
        expect(transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable' });
        expect(txAfterWinner.attentionItem.update).toHaveBeenCalledTimes(1);
    });

    it('retries 40001 inside inTx, then maps exhausted retries to 409 transaction_conflict', async () => {
        transaction.mockRejectedValue(p2010());
        await expect(post()).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
        // inTx: 4 attempts per run; run(): 40001 is not re-looped.
        expect(transaction).toHaveBeenCalledTimes(4);
    });

    it('gives up on a persistent unique violation with 409', async () => {
        transaction.mockRejectedValue(p2002());
        await expect(post()).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
        expect(transaction).toHaveBeenCalledTimes(4);
    });
});
