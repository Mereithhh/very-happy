import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

/** B-636 on PGlite with the real migrations: rekey round-trips every wrapped column; prune walks the real FK graph. */
describe('B-636 rekey + prune-accounts (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/vh-migration-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'rekey-'));
    const oldSecret = 'old-master-secret-for-rekey-tests';
    const newSecret = 'new-master-secret-for-rekey-tests';
    let db: PrismaClient;
    let keep = '';
    let doomed = '';

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = oldSecret;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        await (await import('@/modules/encrypt')).initEncrypt();
        const { auth } = await import('@/app/auth/auth');
        await auth.init();
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        const { encryptString } = await import('@/modules/encrypt');

        const gh = await db.githubUser.create({ data: { id: 'gh-doomed', profile: {} as any, token: Buffer.from('placeholder') } });
        const ghKept = await db.githubUser.create({ data: { id: 'gh-kept', profile: {} as any, token: Buffer.from('placeholder') } });
        keep = (await db.account.create({ data: { publicKey: 'pk-keep', githubUserId: ghKept.id } })).id;
        doomed = (await db.account.create({ data: { publicKey: 'pk-doomed', githubUserId: gh.id } })).id;
        for (const [id, tag] of [[keep, 1], [doomed, 2]] as const) {
            await upsertAccountSecret(db, id, Buffer.alloc(32, tag).toString('base64url'));
            await db.githubUser.update({ where: { id: id === keep ? ghKept.id : gh.id }, data: { token: Buffer.from(encryptString(['user', id, 'github', 'token'], `gh-token-${tag}`)) } });
            await db.serviceAccountToken.create({ data: { accountId: id, vendor: 'openai', token: Buffer.from(encryptString(['user', id, 'vendors', 'openai', 'token'], `vendor-${tag}`)) } });
            await db.accountIdentity.create({ data: { accountId: id, provider: 'email', providerSubject: `${tag}@x.test`, email: `${tag}@x.test` } });
            const session = await db.session.create({ data: { accountId: id, tag: `session-${tag}`, metadata: '', metadataVersion: 1, seq: 0 } });
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, localId: `m-${tag}`, content: { c: '', t: 'encrypted' } } });
            await db.machine.create({ data: { id: `machine-${tag}`, accountId: id, metadata: '' } });
            await auth.createLoginToken(id);
        }
        // A relationship and a share between the two accounts: both must vanish with the doomed one.
        await db.userRelationship.create({ data: { fromUserId: keep, toUserId: doomed, status: 'friend' } });
        const keptSession = await db.session.findFirstOrThrow({ where: { accountId: keep } });
        await db.sessionGrant.create({ data: { sessionId: keptSession.id, granteeAccountId: doomed, grantedByAccountId: keep, role: 'driver', status: 'active', granteeDataEncryptionKey: Buffer.alloc(8) } });
    }, 60_000);

    afterAll(async () => {
        await db?.$disconnect();
        rmSync(root, { recursive: true, force: true });
    });

    it('rekeys every wrapped column so the new secret opens them, and drops the old-secret login sessions', async () => {
        const { rekeyMasterSecret } = await import('./rekey');
        const dry = await rekeyMasterSecret(db, { from: oldSecret, to: newSecret, apply: false });
        expect(dry).toMatchObject({ accountSecrets: 2, githubTokens: 2, vendorTokens: 2, loginSessionsDropped: 2, failed: [] });
        expect(await db.accountLoginSession.count()).toBe(2);

        const report = await rekeyMasterSecret(db, { from: oldSecret, to: newSecret, apply: true });
        expect(report).toMatchObject({ accountSecrets: 2, credentialSecrets: 0, githubTokens: 2, vendorTokens: 2, teamCredentials: 0, loginSessionsDropped: 2, failed: [] });
        expect(await db.accountLoginSession.count()).toBe(0);

        // The old secret can no longer open them; the new one can, through the server's own helpers.
        const { createMasterKeyTree } = await import('./rekey');
        const oldTree = await createMasterKeyTree(oldSecret);
        const stored = (await db.accountSecret.findUniqueOrThrow({ where: { accountId: keep } })).secretEnc;
        expect(() => oldTree.symmetricDecryptString(['account', keep, 'cloud-secret'], new Uint8Array(Buffer.from(stored.slice(4), 'base64url')))).toThrow();
        process.env.HANDY_MASTER_SECRET = newSecret;
        const { initEncrypt, decryptString } = await import('@/modules/encrypt');
        await initEncrypt();
        const { loadAccountSecret } = await import('@/app/auth/accountSecrets');
        expect(await loadAccountSecret(db, keep)).toBe(Buffer.alloc(32, 1).toString('base64url'));
        expect(await loadAccountSecret(db, doomed)).toBe(Buffer.alloc(32, 2).toString('base64url'));
        const gh = (await db.githubUser.findUniqueOrThrow({ where: { id: 'gh-kept' } })).token!;
        expect(decryptString(['user', keep, 'github', 'token'], new Uint8Array(gh))).toBe('gh-token-1');
        const vendor = (await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: doomed } })).token;
        expect(decryptString(['user', doomed, 'vendors', 'openai', 'token'], new Uint8Array(vendor))).toBe('vendor-2');
    });

    it('prunes everything that hangs off the unlisted account and nothing of the kept one', async () => {
        const { pruneAccounts } = await import('./prune');
        await expect(pruneAccounts(db, { keep: [], apply: true })).rejects.toThrow(/empty/);
        await expect(pruneAccounts(db, { keep: [keep, 'ghost'], apply: true })).rejects.toThrow(/ghost/);

        const dry = await pruneAccounts(db, { keep: [keep], apply: false });
        expect(dry.deletedAccounts).toBe(1);
        expect(Object.fromEntries(dry.rows.map((row) => [row.table, row.count]))).toMatchObject({ Account: 1, Session: 1, SessionMessage: 1, Machine: 1, AccountIdentity: 1, ServiceAccountToken: 1, UserRelationship: 1, SessionGrant: 1, GithubUser: 1 });
        expect(await db.account.count()).toBe(2);

        const report = await db.$transaction((tx) => pruneAccounts(tx, { keep: [keep], apply: true }));
        expect(report.deletedAccounts).toBe(1);
        expect(await db.account.findMany({ select: { id: true } })).toEqual([{ id: keep }]);
        expect(await db.session.count()).toBe(1);
        expect(await db.sessionMessage.count()).toBe(1);
        expect(await db.machine.findMany({ select: { id: true } })).toEqual([{ id: 'machine-1' }]);
        expect(await db.userRelationship.count()).toBe(0);
        expect(await db.sessionGrant.count()).toBe(0);
        expect(await db.serviceAccountToken.count({ where: { accountId: keep } })).toBe(1);
        expect((await db.githubUser.findMany({ select: { id: true } })).map((row) => row.id)).toEqual(['gh-kept']);
        expect(await db.accountSecret.count()).toBe(1);
    });
});
