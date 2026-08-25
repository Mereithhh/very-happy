import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { consumeEmailLoginChallengeWithClient, normalizeEmail } from './emailLoginSecurity';

type Database = PrismaClient | Prisma.TransactionClient;

export class EmailIdentityInUseError extends Error {
    constructor() {
        super('Email login identity is already linked to another account');
        this.name = 'EmailIdentityInUseError';
    }
}

export interface AccountLoginMethods {
    email: string | null;
    google: { connected: boolean; email: string | null };
    passwordConfigured: boolean;
}

export async function getAccountLoginMethods(db: Database, accountId: string): Promise<AccountLoginMethods> {
    const identities = await db.$queryRawUnsafe<Array<{ provider: string; email: string | null; providerSubject: string }>>(
        `SELECT "provider", "email", "providerSubject"
         FROM "AccountIdentity"
         WHERE "accountId" = $1`,
        accountId,
    );
    const credential = await db.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT EXISTS (
             SELECT 1 FROM "AccountCredential" WHERE "accountId" = $1
         ) AS present`,
        accountId,
    );
    const emailIdentity = identities.find((identity) => identity.provider === 'email');
    const googleIdentity = identities.find((identity) => identity.provider === 'google');
    return {
        email: emailIdentity?.email ?? emailIdentity?.providerSubject ?? null,
        google: { connected: !!googleIdentity, email: googleIdentity?.email ?? null },
        passwordConfigured: credential[0]?.present === true,
    };
}

export interface VerifiedEmailIdentityInput {
    email: string;
    challengeId: string;
    code: string;
    nowMs?: number;
}

export async function linkVerifiedEmailIdentity(
    db: PrismaClient,
    accountId: string,
    input: VerifiedEmailIdentityInput,
): Promise<'linked' | 'invalid-code'> {
    const email = normalizeEmail(input.email);
    try {
        return await db.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
                accountId,
            );
            const valid = await consumeEmailLoginChallengeWithClient(
                tx,
                input.challengeId,
                email,
                input.code,
                input.nowMs,
            );
            if (!valid) return 'invalid-code' as const;
            const existing = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                `SELECT "accountId" FROM "AccountIdentity"
                 WHERE "provider" = 'email' AND "providerSubject" = $1
                 LIMIT 1`,
                email,
            );
            if (existing[0] && existing[0].accountId !== accountId) {
                throw new EmailIdentityInUseError();
            }
            const accountEmails = await tx.$queryRawUnsafe<Array<{ providerSubject: string }>>(
                `SELECT "providerSubject" FROM "AccountIdentity"
                 WHERE "provider" = 'email' AND "accountId" = $1
                 LIMIT 1`,
                accountId,
            );
            if (accountEmails[0] && accountEmails[0].providerSubject !== email) {
                throw new EmailIdentityInUseError();
            }
            if (!existing[0]) {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "AccountIdentity"
                     ("id", "accountId", "provider", "providerSubject", "email", "updatedAt")
                     VALUES ($1, $2, 'email', $3, $3, now())`,
                    randomUUID(),
                    accountId,
                    email,
                );
            }
            return 'linked' as const;
        });
    } catch (error) {
        if (error instanceof EmailIdentityInUseError ||
            (error as { code?: string }).code === 'P2002' ||
            /unique constraint/i.test(String(error))) {
            throw new EmailIdentityInUseError();
        }
        throw error;
    }
}
