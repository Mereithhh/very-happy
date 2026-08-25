import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { GoogleIdentityClaims } from './googleOidc';
import { consumeGoogleLoginChallenge } from './googleLoginSecurity';

export class GoogleIdentityInUseError extends Error {
    constructor() {
        super('Google login identity is already linked to another account');
        this.name = 'GoogleIdentityInUseError';
    }
}

export interface VerifiedGoogleIdentityInput {
    nonce: string;
    claims: GoogleIdentityClaims;
}

export async function linkVerifiedGoogleIdentity(
    db: PrismaClient,
    accountId: string,
    input: VerifiedGoogleIdentityInput,
): Promise<'linked' | 'invalid-challenge'> {
    try {
        return await db.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
                accountId,
            );
            if (!(await consumeGoogleLoginChallenge(tx, input.nonce))) {
                return 'invalid-challenge' as const;
            }

            const existingSubject = await tx.$queryRawUnsafe<Array<{ accountId: string }>>(
                `SELECT "accountId" FROM "AccountIdentity"
                 WHERE "provider" = 'google' AND "providerSubject" = $1
                 LIMIT 1`,
                input.claims.sub,
            );
            if (existingSubject[0] && existingSubject[0].accountId !== accountId) {
                throw new GoogleIdentityInUseError();
            }

            const accountGoogle = await tx.$queryRawUnsafe<Array<{ providerSubject: string }>>(
                `SELECT "providerSubject" FROM "AccountIdentity"
                 WHERE "provider" = 'google' AND "accountId" = $1
                 LIMIT 1`,
                accountId,
            );
            if (accountGoogle[0] && accountGoogle[0].providerSubject !== input.claims.sub) {
                throw new GoogleIdentityInUseError();
            }

            if (!existingSubject[0]) {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "AccountIdentity"
                     ("id", "accountId", "provider", "providerSubject", "email", "updatedAt")
                     VALUES ($1, $2, 'google', $3, $4, now())`,
                    randomUUID(),
                    accountId,
                    input.claims.sub,
                    input.claims.email ?? null,
                );
            }
            return 'linked' as const;
        });
    } catch (error) {
        if (error instanceof GoogleIdentityInUseError ||
            (error as { code?: string }).code === 'P2002' ||
            /unique constraint/i.test(String(error))) {
            throw new GoogleIdentityInUseError();
        }
        throw error;
    }
}
