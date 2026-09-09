import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
const mocks = vi.hoisted(() => ({
    transaction: vi.fn(), publish: vi.fn(), tx: {} as any, committed: false,
}));
vi.mock('@/storage/db', () => ({ db: { $transaction: mocks.transaction } }));
vi.mock('./producer', () => ({ businessAuditEnabled: () => true, publishAudit: mocks.publish }));
vi.mock('@/utils/delay', () => ({ delay: async () => {} }));
vi.mock('@/app/api/resourceLimits', () => ({
    lockAccountResources: async () => {}, enforceAccountWriteRate: async () => {},
    reserveAccountMessages: async (_tx: unknown, _id: unknown, input: { count: number }) => Array.from({ length: input.count }, (_, i) => i + 1),
    configuredResourceLimit: (_name: string, fallback: number) => fallback,
    assertAccountResourceQuota: () => {},
}));
vi.mock('@/storage/seq', () => ({ allocateSessionSeqBatch: async (_id: string, count: number) => Array.from({ length: count }, (_, i) => i + 1), allocateUserSeq: async () => 1 }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitUpdate: vi.fn() }, buildDeleteSessionUpdate: () => ({}) }));
vi.mock('@/storage/files', () => ({ deleteSessionAttachments: async () => {} }));
vi.mock('@/utils/log', () => ({ log: () => {} }));
import { storeSessionMessages } from '@/app/api/sessionMessageStore';
import { createSessionWithQuota } from '@/app/state/accountStateStore';
import { sessionDelete } from '@/app/session/sessionDelete';

const snapshot = { id: 'session', accountId: 'account', metadata: 'cipher-metadata', dataEncryptionKey: Buffer.from([1, 2, 3]) };
beforeEach(() => {
    vi.clearAllMocks(); mocks.committed = false;
    mocks.tx = {
        $queryRawUnsafe: vi.fn(async (query: string) => query.includes('FOR UPDATE') ? [snapshot] : [{ bytes: 0n }]),
        sessionMessage: {
            findMany: vi.fn(async () => []),
            create: vi.fn(async ({ data }: any) => ({ ...data, id: 'message', createdAt: new Date(), updatedAt: new Date() })),
            deleteMany: vi.fn(async () => ({ count: 2 })),
        },
        session: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0), create: vi.fn(async () => snapshot), delete: vi.fn(async () => snapshot) },
        usageReport: { deleteMany: async () => ({ count: 0 }) }, accessKey: { deleteMany: async () => ({ count: 0 }) }, uploadedFile: { deleteMany: async () => ({ count: 0 }) },
    };
    mocks.transaction.mockImplementation(async (fn: any) => { const result = await fn(mocks.tx); mocks.committed = true; return result; });
    mocks.publish.mockImplementation(() => { expect(mocks.committed).toBe(true); });
});

describe('business audit commits', () => {
    it('publishes only new messages after commit with independent encryption snapshot', async () => {
        await storeSessionMessages({ accountId: 'account', sessionId: 'session', messages: [{ content: 'cipher-message', localId: 'local' }] });
        expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message.stored', messageId: 'message', payload: {
            content: 'cipher-message', metadata: 'cipher-metadata', dataEncryptionKey: 'AQID',
        } }));
        mocks.publish.mockClear();
        mocks.tx.sessionMessage.findMany.mockResolvedValue([{ id: 'existing', localId: 'local', seq: 1 }]);
        await storeSessionMessages({ accountId: 'account', sessionId: 'session', messages: [{ content: 'cipher-message', localId: 'local' }] });
        expect(mocks.publish).not.toHaveBeenCalled();
    });
    it('does not publish rolled back transactions or duplicate serialization retries', async () => {
        const write = () => storeSessionMessages({ accountId: 'account', sessionId: 'session', messages: [{ content: 'cipher', localId: 'local' }] });
        mocks.transaction.mockImplementationOnce(async (fn: any) => { await fn(mocks.tx); throw new Error('rollback'); });
        await expect(write()).rejects.toThrow('rollback');
        expect(mocks.publish).not.toHaveBeenCalled();
        mocks.transaction.mockImplementationOnce(async (fn: any) => { await fn(mocks.tx); throw new Prisma.PrismaClientKnownRequestError('retry', { code: 'P2034', clientVersion: 'test' }); });
        await write();
        expect(mocks.publish).toHaveBeenCalledTimes(1);
    });
    it('publishes creation once, excludes existing sessions, preserves deletion snapshot', async () => {
        const input = { accountId: 'account', tag: 'tag', metadata: 'cipher-metadata', dataEncryptionKey: 'AQID' };
        await createSessionWithQuota(input);
        expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session.created' }));
        mocks.publish.mockClear();
        mocks.tx.session.findFirst.mockResolvedValue(snapshot);
        await createSessionWithQuota(input);
        expect(mocks.publish).not.toHaveBeenCalled();
        await sessionDelete({ uid: 'account' } as any, 'session');
        expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session.deleted', payload: {
            metadata: 'cipher-metadata', dataEncryptionKey: 'AQID', deletedMessages: 2,
        } }));
    });
});
