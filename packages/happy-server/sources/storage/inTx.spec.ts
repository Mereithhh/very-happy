import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isRetryableTransactionConflict } from './inTx';

function prismaError(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError('database error', {
        code,
        clientVersion: 'test',
        meta,
    });
}

describe('isRetryableTransactionConflict', () => {
    it('retries Prisma model serialization conflicts', () => {
        expect(isRetryableTransactionConflict(prismaError('P2034'))).toBe(true);
    });

    it('retries PostgreSQL serialization conflicts wrapped by raw-query P2010', () => {
        expect(isRetryableTransactionConflict(prismaError('P2010', {
            code: '40001',
            message: 'could not serialize access due to concurrent update',
        }))).toBe(true);
    });

    it('recognizes the stable PostgreSQL message when an adapter omits the SQLSTATE', () => {
        expect(isRetryableTransactionConflict(prismaError('P2010', {
            message: 'ERROR: could not serialize access due to concurrent update',
        }))).toBe(true);
    });

    it('does not retry unrelated raw-query or application failures', () => {
        expect(isRetryableTransactionConflict(prismaError('P2010', {
            code: '23505',
            message: 'unique violation',
        }))).toBe(false);
        expect(isRetryableTransactionConflict(new Error('could not serialize access'))).toBe(false);
    });
});
