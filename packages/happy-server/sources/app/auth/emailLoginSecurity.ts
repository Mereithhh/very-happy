import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

const MAX_ATTEMPTS = 3;

type TransactionClient = Prisma.TransactionClient;

export class EmailLoginChallengeCapacityError extends Error {
    constructor() {
        super('email-login-challenge-capacity');
        this.name = 'EmailLoginChallengeCapacityError';
    }
}

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function generateEmailLoginCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashEmailLoginCode(
    challengeId: string,
    email: string,
    code: string,
    masterSecret = process.env.HANDY_MASTER_SECRET ?? '',
): string {
    if (!masterSecret) throw new Error('HANDY_MASTER_SECRET is required for Email OTP');
    return createHmac('sha256', masterSecret)
        .update('very-happy/email-login-code/v1\0')
        .update(challengeId)
        .update('\0')
        .update(normalizeEmail(email))
        .update('\0')
        .update(code)
        .digest('hex');
}

function hashesEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function createEmailLoginChallenge(
    emailInput: string,
    ttlMinutes: number,
    options: { nowMs?: number; code?: string; maxPendingChallenges?: number } = {},
): Promise<{ id: string; email: string; code: string; expiresAt: Date }> {
    const email = normalizeEmail(emailInput);
    const code = options.code ?? generateEmailLoginCode();
    const id = randomUUID();
    const now = new Date(options.nowMs ?? Date.now());
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const codeHash = hashEmailLoginCode(id, email, code);
    const maxPending = options.maxPendingChallenges ?? 10_000;

    await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            'INSERT INTO "SignupCapacity" ("id", "updatedAt") VALUES (1, now()) ON CONFLICT ("id") DO NOTHING',
        );
        await tx.$queryRawUnsafe('SELECT "id" FROM "SignupCapacity" WHERE "id" = 1 FOR UPDATE');
        await tx.$executeRawUnsafe('DELETE FROM "EmailLoginChallenge" WHERE "expiresAt" <= $1', now);
        const counts = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
            'SELECT COUNT(*)::bigint AS count FROM "EmailLoginChallenge" WHERE "consumedAt" IS NULL AND "expiresAt" > $1',
            now,
        );
        const pending = Number(counts[0]?.count ?? 0);
        if (pending >= maxPending) throw new EmailLoginChallengeCapacityError();
        await tx.$executeRawUnsafe(
            'UPDATE "EmailLoginChallenge" SET "consumedAt" = $1 WHERE "email" = $2 AND "consumedAt" IS NULL',
            now,
            email,
        );
        await tx.$executeRawUnsafe(
            'INSERT INTO "EmailLoginChallenge" ("id", "email", "codeHash", "expiresAt", "createdAt") VALUES ($1, $2, $3, $4, $5)',
            id,
            email,
            codeHash,
            expiresAt,
            now,
        );
    });
    return { id, email, code, expiresAt };
}

export async function deleteEmailLoginChallenge(id: string): Promise<void> {
    await db.$executeRawUnsafe('DELETE FROM "EmailLoginChallenge" WHERE "id" = $1', id);
}

export async function consumeEmailLoginChallenge(
    id: string,
    emailInput: string,
    code: string,
    nowMs = Date.now(),
): Promise<boolean> {
    const email = normalizeEmail(emailInput);
    const now = new Date(nowMs);
    return db.$transaction(async (tx: TransactionClient) => {
        const rows = await tx.$queryRawUnsafe<Array<{
            id: string;
            email: string;
            codeHash: string;
            expiresAt: Date;
            consumedAt: Date | null;
            attempts: number;
        }>>(
            'SELECT "id", "email", "codeHash", "expiresAt", "consumedAt", "attempts" FROM "EmailLoginChallenge" WHERE "id" = $1 FOR UPDATE',
            id,
        );
        const row = rows[0];
        if (!row || row.email !== email || row.consumedAt || row.expiresAt.getTime() <= nowMs || row.attempts >= MAX_ATTEMPTS) {
            return false;
        }
        const candidate = hashEmailLoginCode(id, email, code);
        if (!hashesEqual(candidate, row.codeHash)) {
            const attempts = row.attempts + 1;
            await tx.$executeRawUnsafe(
                'UPDATE "EmailLoginChallenge" SET "attempts" = $1::integer, "consumedAt" = CASE WHEN $1::integer >= $2::integer THEN $3 ELSE "consumedAt" END WHERE "id" = $4',
                attempts,
                MAX_ATTEMPTS,
                now,
                id,
            );
            return false;
        }
        await tx.$executeRawUnsafe('UPDATE "EmailLoginChallenge" SET "consumedAt" = $1 WHERE "id" = $2', now, id);
        return true;
    });
}
