import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

describe('Google identity linking invariants on PGlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'very-happy-google-link-'));
    const pgliteDir = join(root, 'db');
    let db: PrismaClient;
    let accountId: string;
    let otherAccountId: string;
    let issueGoogleLoginChallenge: typeof import('./googleLoginSecurity').issueGoogleLoginChallenge;
    let linkVerifiedGoogleIdentity: typeof import('./googleIdentityLink').linkVerifiedGoogleIdentity;
    let GoogleIdentityInUseError: typeof import('./googleIdentityLink').GoogleIdentityInUseError;

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite';
        process.env.PGLITE_DIR = pgliteDir;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({
            pgliteDir,
            migrationsDir: join(process.cwd(), 'prisma', 'migrations'),
        });
        ({ db } = await import('../../storage/db'));
        ({ issueGoogleLoginChallenge } = await import('./googleLoginSecurity'));
        ({ linkVerifiedGoogleIdentity, GoogleIdentityInUseError } = await import('./googleIdentityLink'));
        accountId = (await db.account.create({ data: { publicKey: 'google-link-primary' } })).id;
        otherAccountId = (await db.account.create({ data: { publicKey: 'google-link-other' } })).id;
    });

    afterAll(async () => {
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    async function challenge() {
        return issueGoogleLoginChallenge(undefined, Date.now());
    }

    const claims = {
        sub: 'google-subject-1',
        email: 'owner@example.com',
        emailVerified: true,
        name: 'Owner',
        picture: 'https://example.com/avatar.png',
    };

    it('consumes the nonce transactionally and links idempotently', async () => {
        const first = await challenge();
        await expect(linkVerifiedGoogleIdentity(db, accountId, { nonce: first.nonce, claims }))
            .resolves.toBe('linked');

        const second = await challenge();
        await expect(linkVerifiedGoogleIdentity(db, accountId, { nonce: second.nonce, claims }))
            .resolves.toBe('linked');
        expect(await db.accountIdentity.count({ where: { accountId, provider: 'google' } })).toBe(1);

        await expect(linkVerifiedGoogleIdentity(db, accountId, { nonce: second.nonce, claims }))
            .resolves.toBe('invalid-challenge');
    });

    it('never moves an identity or replaces an account Google identity', async () => {
        const ownerNonce = await challenge();
        const contenderNonce = await challenge();
        const results = await Promise.allSettled([
            linkVerifiedGoogleIdentity(db, accountId, { nonce: ownerNonce.nonce, claims }),
            linkVerifiedGoogleIdentity(db, otherAccountId, { nonce: contenderNonce.nonce, claims }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
            .toBeInstanceOf(GoogleIdentityInUseError);

        // The conflict rolls back nonce consumption, so the losing account can
        // safely retry that provider proof with its own different subject.
        await expect(linkVerifiedGoogleIdentity(db, otherAccountId, {
            nonce: contenderNonce.nonce,
            claims: { ...claims, sub: 'google-subject-other', email: 'other@example.com' },
        })).resolves.toBe('linked');

        const different = await challenge();
        await expect(linkVerifiedGoogleIdentity(db, accountId, {
            nonce: different.nonce,
            claims: { ...claims, sub: 'google-subject-2', email: 'other@example.com' },
        })).rejects.toBeInstanceOf(GoogleIdentityInUseError);
        expect(await db.accountIdentity.count({ where: { accountId, provider: 'google' } })).toBe(1);
    });

    it('enforces one Google identity per account at the database boundary', async () => {
        await expect(db.$executeRawUnsafe(
            `INSERT INTO "AccountIdentity"
             ("id", "accountId", "provider", "providerSubject", "updatedAt")
             VALUES ($1, $2, 'google', $3, now())`,
            'duplicate-google-id', accountId, 'google-subject-direct',
        )).rejects.toThrow(/23505|already exists/i);
    });
});
