import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

describe('session message storage on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-message-store-'));
    const pgliteDir = join(root, 'db');
    let db: PrismaClient;
    let storeSessionMessages: typeof import('../app/api/sessionMessageStore').storeSessionMessages;
    let accountId: string;
    let sessionId: string;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        delete process.env.MAX_MESSAGES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGE_BYTES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE;

        const { runMigrations } = await import('../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ db } = await import('./db'));
        ({ storeSessionMessages } = await import('../app/api/sessionMessageStore'));
    });

    beforeEach(async () => {
        delete process.env.MAX_MESSAGES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGE_BYTES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE;
        const account = await db.account.create({
            data: { publicKey: `message-store-${crypto.randomUUID()}` },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `message-store-${crypto.randomUUID()}`,
                metadata: 'encrypted-metadata',
            },
        });
        accountId = account.id;
        sessionId = session.id;
    });

    afterAll(async () => {
        delete process.env.MAX_MESSAGES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGE_BYTES_PER_ACCOUNT;
        delete process.env.MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE;
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    it('stores messages without transaction re-entry and keeps retries idempotent', async () => {
        const writes = [
            { localId: 'local-one', content: 'abc' },
            { localId: 'local-two', content: 'four' },
        ];
        const startedAt = performance.now();
        const stored = await storeSessionMessages({ accountId, sessionId, messages: writes });

        expect(performance.now() - startedAt).toBeLessThan(2_000);
        expect(stored.createdMessages).toHaveLength(2);
        await expect(db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { messageCount: true, messageBytes: true, seq: true },
        })).resolves.toEqual({ messageCount: 2n, messageBytes: 7n, seq: 2 });

        const bucketBeforeRetry = await db.authRateLimitBucket.findUniqueOrThrow({
            where: { key: `resource-write:message:${accountId}` },
            select: { count: true },
        });
        const replayed = await storeSessionMessages({ accountId, sessionId, messages: writes });
        const bucketAfterRetry = await db.authRateLimitBucket.findUniqueOrThrow({
            where: { key: `resource-write:message:${accountId}` },
            select: { count: true },
        });

        expect(replayed.createdMessages).toHaveLength(0);
        expect(bucketAfterRetry.count).toBe(bucketBeforeRetry.count);
        await expect(db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { messageCount: true, messageBytes: true, seq: true },
        })).resolves.toEqual({ messageCount: 2n, messageBytes: 7n, seq: 2 });
    });

    it('maintains counters for old binaries and bulk deletion through database triggers', async () => {
        await storeSessionMessages({
            accountId,
            sessionId,
            messages: [
                { localId: 'existing-one', content: 'abc' },
                { localId: 'existing-two', content: 'four' },
            ],
        });
        const legacy = await db.sessionMessage.create({
            data: {
                sessionId,
                localId: 'legacy-direct-write',
                seq: 3,
                content: { t: 'encrypted', c: 'xy' },
            },
        });
        await expect(accountCounters()).resolves.toEqual({ messageCount: 3n, messageBytes: 9n });

        await db.sessionMessage.update({
            where: { id: legacy.id },
            data: { content: { t: 'encrypted', c: '12345' } },
        });
        await expect(accountCounters()).resolves.toEqual({ messageCount: 3n, messageBytes: 12n });

        await db.sessionMessage.delete({ where: { id: legacy.id } });
        await expect(accountCounters()).resolves.toEqual({ messageCount: 2n, messageBytes: 7n });

        await db.sessionMessage.deleteMany({ where: { sessionId } });
        await expect(accountCounters()).resolves.toEqual({ messageCount: 0n, messageBytes: 0n });
    });

    it('rejects writes beyond the configured stored-message quota', async () => {
        process.env.MAX_MESSAGES_PER_ACCOUNT = '2';
        await storeSessionMessages({
            accountId,
            sessionId,
            messages: [
                { localId: 'quota-one', content: 'a' },
                { localId: 'quota-two', content: 'b' },
            ],
        });

        await expect(storeSessionMessages({
            accountId,
            sessionId,
            messages: [{ localId: 'quota-three', content: 'c' }],
        })).rejects.toMatchObject({ code: 'message_count_quota_exceeded', statusCode: 429 });
        await expect(accountCounters()).resolves.toEqual({ messageCount: 2n, messageBytes: 2n });
    });

    function accountCounters() {
        return db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: { messageCount: true, messageBytes: true },
        });
    }
});
