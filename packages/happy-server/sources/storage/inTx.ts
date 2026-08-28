import { Prisma } from "@prisma/client";
import { delay } from "@/utils/delay";
import { db } from "@/storage/db";

export type Tx = Prisma.TransactionClient;

const symbol = Symbol();

/**
 * Prisma reports serialization failures from model operations as P2034, but
 * the same PostgreSQL 40001 raised by a raw query is wrapped as P2010. Both
 * abort the whole SERIALIZABLE transaction and are safe to retry from the
 * beginning.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    if (error.code === 'P2034') return true;
    if (error.code !== 'P2010') return false;

    const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
    return meta?.code === '40001'
        || (typeof meta?.message === 'string' && meta.message.includes('could not serialize access'));
}

export function afterTx(tx: Tx, callback: () => void) {
    let callbacks = (tx as any)[symbol] as (() => void)[];
    callbacks.push(callback);
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        try {
            let result = await db.$transaction(wrapped, { isolationLevel: 'Serializable', timeout: 10000 });
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch { // Ignore errors in callbacks because they are used mostly for notifications
                    console.error('Post-transaction callback failed');
                }
            }
            return result.result;
        } catch (e) {
            if (isRetryableTransactionConflict(e) && counter < 3) {
                counter++;
                await delay(counter * 100);
                continue;
            }
            throw e;
        }
    }
}
