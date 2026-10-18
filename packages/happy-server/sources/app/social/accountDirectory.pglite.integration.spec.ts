import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Directory from './accountDirectory';

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate, emitToRooms: vi.fn(), setSessionFanout: vi.fn() } };
});

/**
 * B-621 account directory + friends on PGlite: password accounts (login
 * username only), email accounts, profile handle edits, search, and the
 * relationship verbs with their socket events.
 */
describe('B-621 account directory (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/account-directory-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let dir: typeof Directory;
    let aliceId: string; let bobId: string; let carolId: string;
    const hex = () => randomBytes(16).toString('hex');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'account-directory-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        dir = await import('./accountDirectory');
        // alice: password sign-up BEFORE the backfill style — login username only, no profile handle.
        aliceId = (await db.account.create({ data: { publicKey: hex() } })).id;
        await db.accountCredential.create({ data: { username: 'alice', accountId: aliceId, passwordHash: 'x', secretEnc: 'x' } });
        // bob: email sign-up with a profile name and handle.
        bobId = (await db.account.create({ data: { publicKey: hex(), firstName: 'Bob', lastName: 'Builder', username: 'bobby' } })).id;
        await db.accountIdentity.create({ data: { accountId: bobId, provider: 'email', providerSubject: 'Bob@Example.com', email: 'Bob@Example.com' } });
        // carol: nothing but an email.
        carolId = (await db.account.create({ data: { publicKey: hex() } })).id;
        await db.accountIdentity.create({ data: { accountId: carolId, provider: 'google', providerSubject: 'g-1', email: 'carol@example.com' } });
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => emitUpdate.mockClear());

    it('resolves by login username, profile handle and exact email (case-insensitive), never by prefix', async () => {
        expect((await dir.resolveAccountByHandle('Alice'))?.id).toBe(aliceId);
        expect((await dir.resolveAccountByHandle('BOBBY'))?.id).toBe(bobId);
        expect((await dir.resolveAccountByHandle('bob@example.com'))?.id).toBe(bobId);
        expect(await dir.resolveAccountByHandle('ali')).toBeNull();
        expect(await dir.resolveAccountByHandle('nobody@example.com')).toBeNull();
    });

    it('search finds password accounts by login username prefix and excludes the viewer; email only matches exactly', async () => {
        const byPrefix = await dir.searchAccounts(bobId, 'al');
        expect(byPrefix.map((p) => p.id)).toEqual([aliceId]);
        expect(byPrefix[0].displayName).toBe('alice');
        expect(byPrefix[0].username).toBe('alice');
        expect((await dir.searchAccounts(aliceId, 'bo')).map((p) => p.id)).toEqual([bobId]);
        expect(await dir.searchAccounts(aliceId, 'bob')).toHaveLength(1);
        expect(await dir.searchAccounts(aliceId, 'bobby')).toHaveLength(1);
        expect(await dir.searchAccounts(bobId, 'bo')).toEqual([]);
        expect((await dir.searchAccounts(aliceId, 'CAROL@example.com')).map((p) => p.id)).toEqual([carolId]);
        expect(await dir.searchAccounts(aliceId, 'carol@')).toEqual([]);
    });

    it('display name falls back: full name → handle → login username → email local part', async () => {
        const bob = await dir.directoryProfileOf((await db.account.findUniqueOrThrow({ where: { id: bobId }, include: dir.profileInclude })), 'none');
        expect(bob.displayName).toBe('Bob Builder');
        const carol = await dir.directoryProfileOf((await db.account.findUniqueOrThrow({ where: { id: carolId }, include: dir.profileInclude })), 'none');
        expect(carol.displayName).toBe('carol');
        expect(carol.email).toBe('carol@example.com');
    });

    it('profile update: handle is validated, unique across handles AND login usernames, and clearable', async () => {
        const updated = await dir.updateAccountProfile(carolId, { firstName: ' Carol ', username: 'Carol.C' });
        expect(updated.firstName).toBe('Carol');
        expect(updated.username).toBe('carol.c');
        await expect(dir.updateAccountProfile(carolId, { username: 'alice' })).rejects.toBeInstanceOf(dir.ProfileUsernameTakenError);
        await expect(dir.updateAccountProfile(carolId, { username: 'BOBBY' })).rejects.toBeInstanceOf(dir.ProfileUsernameTakenError);
        expect(() => dir.profileUsernameSchema.parse('ab')).toThrow();
        expect(() => dir.profileUsernameSchema.parse('has space')).toThrow();
        await dir.updateAccountProfile(carolId, { username: 'carol.c' }); // own handle again is fine
        expect((await dir.updateAccountProfile(carolId, { username: null })).username).toBeNull();
    });

    it('seedProfileUsername claims a free handle and silently skips a taken one', async () => {
        await db.$transaction(async (tx) => dir.seedProfileUsername(tx, aliceId, 'alice'));
        expect((await db.account.findUniqueOrThrow({ where: { id: aliceId } })).username).toBe('alice');
        const dupe = (await db.account.create({ data: { publicKey: hex() } })).id;
        await db.$transaction(async (tx) => dir.seedProfileUsername(tx, dupe, 'alice'));
        expect((await db.account.findUniqueOrThrow({ where: { id: dupe } })).username).toBeNull();
    });

    it('friend request → accept → unfriend, with a relationship-updated event for both sides each time', async () => {
        const { friendAdd } = await import('./friendAdd');
        const { friendRemove } = await import('./friendRemove');
        const { Context } = await import('@/context');
        const flush = () => new Promise((r) => setTimeout(r, 50));

        expect((await friendAdd(Context.create(aliceId), bobId))?.status).toBe('requested');
        await flush();
        expect(await dir.relationshipStatusBetween(bobId, aliceId)).toBe('pending');
        let bodies = emitUpdate.mock.calls.map((c) => [c[0].userId, c[0].payload.body.t, c[0].payload.body.status]);
        expect(bodies).toEqual(expect.arrayContaining([[aliceId, 'relationship-updated', 'requested'], [bobId, 'relationship-updated', 'pending']]));

        emitUpdate.mockClear();
        expect((await friendAdd(Context.create(bobId), aliceId))?.status).toBe('friend');
        await flush();
        expect(await dir.relationshipStatusBetween(aliceId, bobId)).toBe('friend');
        bodies = emitUpdate.mock.calls.map((c) => [c[0].userId, c[0].payload.body.status]);
        expect(bodies).toEqual(expect.arrayContaining([[aliceId, 'friend'], [bobId, 'friend']]));

        emitUpdate.mockClear();
        expect((await friendRemove(Context.create(aliceId), bobId))?.status).toBe('none');
        await flush();
        expect(await dir.relationshipStatusBetween(aliceId, bobId)).toBe('none');
        expect(await dir.relationshipStatusBetween(bobId, aliceId)).toBe('none');
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it('declining an incoming request leaves `rejected` on my side so a repeat request stays silent; forgetting it clears', async () => {
        const { friendAdd } = await import('./friendAdd');
        const { friendRemove } = await import('./friendRemove');
        const { Context } = await import('@/context');
        await friendAdd(Context.create(carolId), aliceId);
        expect((await friendRemove(Context.create(aliceId), carolId))?.status).toBe('rejected');
        expect(await dir.relationshipStatusBetween(carolId, aliceId)).toBe('none');
        await friendAdd(Context.create(carolId), aliceId); // repeat
        expect(await dir.relationshipStatusBetween(aliceId, carolId)).toBe('rejected');
        expect((await friendRemove(Context.create(aliceId), carolId))?.status).toBe('none');
        // and alice can now accept a fresh request
        expect((await friendAdd(Context.create(aliceId), carolId))?.status).toBe('friend');
    });

    it('the backfill migration seeded handles for legacy password accounts (SQL applied by runMigrations)', async () => {
        const legacy = (await db.account.create({ data: { publicKey: hex() } })).id;
        await db.accountCredential.create({ data: { username: 'legacy_user', accountId: legacy, passwordHash: 'x', secretEnc: 'x' } });
        const { readFileSync } = await import('node:fs');
        const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261018100000_profile_username_backfill/migration.sql'), 'utf8');
        await db.$executeRawUnsafe(sql);
        expect((await db.account.findUniqueOrThrow({ where: { id: legacy } })).username).toBe('legacy_user');
    });
});
