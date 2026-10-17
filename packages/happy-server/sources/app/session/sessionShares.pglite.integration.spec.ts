import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Shares from './sessionShares';
import type * as Crypto from './sessionCrypto';

const { emitUpdate, emitToRooms } = vi.hoisted(() => ({ emitUpdate: vi.fn(), emitToRooms: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate, emitToRooms, setSessionFanout: vi.fn() } };
});

/**
 * B-619 end-to-end on PGlite with REAL account secrets and REAL session keys:
 * the owner's session is created the way the CLI creates it (DEK wrapped to
 * the owner's content public key), then shared, accepted, written to by a
 * driver and revoked. Every assertion that matters for security is here:
 * who can resolve access, what a grantee's metadata still contains, that a
 * driver message carries no mode/model meta, and that revocation closes the door.
 */
describe('B-619 session shares (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-share-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'db-'));
    let db: PrismaClient; let shares: typeof Shares; let crypto: typeof Crypto;
    let ownerId: string; let granteeId: string; let strangerId: string; let sessionId: string; let legacySessionId: string;
    let dek: Uint8Array;
    const metadataPlain = { path: '/home/owner/repo', host: 'owner-box', homeDir: '/home/owner', hostPid: 4242, terminalId: 't1', mcpServers: [{ name: 'x', status: 'ok' }], summary: { text: 'Fix the build', updatedAt: 1 }, machineId: 'm1' };

    async function createAccount(email: string, username: string) {
        const secretBytes = randomBytes(32);
        const secret = secretBytes.toString('base64url');
        const account = await db.account.create({ data: { publicKey: crypto_randomHex(), username, firstName: username } });
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        await upsertAccountSecret(db, account.id, secret);
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: email, email } });
        return { id: account.id, secret: new Uint8Array(secretBytes) };
    }
    const crypto_randomHex = () => randomBytes(16).toString('hex');

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'session-share-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        shares = await import('./sessionShares');
        crypto = await import('./sessionCrypto');
        const owner = await createAccount('owner@example.com', 'owner');
        const grantee = await createAccount('Grantee@Example.com', 'grantee');
        const stranger = await createAccount('stranger@example.com', 'stranger');
        ownerId = owner.id; granteeId = grantee.id; strangerId = stranger.id;
        // Session exactly as the CLI makes it: random DEK, boxed to the owner's content key, metadata AES-GCM under the DEK.
        dek = new Uint8Array(randomBytes(32));
        const ownerKeys = crypto.contentKeyPairFromSecret(owner.secret);
        sessionId = (await db.session.create({ data: {
            accountId: ownerId, tag: crypto_randomHex(),
            metadata: Buffer.from(crypto.encryptWithDataKey(metadataPlain, dek)).toString('base64'),
            dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, ownerKeys.publicKey)),
        } })).id;
        legacySessionId = (await db.session.create({ data: { accountId: ownerId, tag: crypto_randomHex(), metadata: 'legacy' } })).id;
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => { emitUpdate.mockClear(); emitToRooms.mockClear(); });

    it('owner resolves as owner; strangers resolve to nothing', async () => {
        expect(await shares.resolveSessionAccess(ownerId, sessionId)).toEqual({ kind: 'owner', ownerId });
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toBeNull();
        expect(await shares.resolveSessionAccess(strangerId, sessionId)).toBeNull();
    });

    it('refuses to share a legacy (no-DEK) session, self-shares and unknown targets', async () => {
        await expect(shares.createSessionGrant({ ownerId, sessionId: legacySessionId, target: 'grantee', role: 'viewer' })).rejects.toMatchObject({ code: 'session_not_shareable' });
        await expect(shares.createSessionGrant({ ownerId, sessionId, target: 'owner@example.com', role: 'viewer' })).rejects.toMatchObject({ code: 'cannot_share_with_self' });
        await expect(shares.createSessionGrant({ ownerId, sessionId, target: 'nobody@example.com', role: 'viewer' })).rejects.toMatchObject({ code: 'target_not_found' });
        await expect(shares.createSessionGrant({ ownerId: granteeId, sessionId, target: 'stranger', role: 'viewer' })).rejects.toMatchObject({ code: 'session_not_found' });
    });

    it('creates a pending grant (email lookup is case-insensitive); pending grants give no access', async () => {
        const grant = await shares.createSessionGrant({ ownerId, sessionId, target: 'grantee@example.com', role: 'viewer' });
        expect(grant.status).toBe('pending');
        expect(grant.grantee.displayName).toBe('grantee');
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toBeNull();
        expect((await shares.listSharedSessionRows(granteeId, { id: true }))).toHaveLength(0);
        // The grantee was told.
        const invite = emitUpdate.mock.calls.find((c) => c[0].userId === granteeId)?.[0];
        expect(invite.payload.body.t).toBe('session-share');
        expect(invite.payload.body.invite.session.name).toBe('Fix the build');
        expect(invite.payload.body.invite.session.path).toBe('/home/owner/repo');
        // Listed as pending for the grantee, not for a stranger.
        expect((await shares.listPendingSessionInvites(granteeId)).map((i) => i.id)).toEqual([grant.id]);
        expect(await shares.listPendingSessionInvites(strangerId)).toEqual([]);
        // Sharing again while pending is a conflict, not a duplicate row.
        await expect(shares.createSessionGrant({ ownerId, sessionId, target: 'grantee', role: 'driver' })).rejects.toMatchObject({ code: 'already_shared' });
    });

    it('a stranger cannot accept someone else\'s invite', async () => {
        const [invite] = await shares.listPendingSessionInvites(granteeId);
        await expect(shares.respondToSessionGrant(strangerId, invite.id, true)).rejects.toMatchObject({ code: 'grant_not_found' });
    });

    it('accepting makes the grantee a viewer with a key that opens the real DEK and REDACTED metadata', async () => {
        const [invite] = await shares.listPendingSessionInvites(granteeId);
        await shares.respondToSessionGrant(granteeId, invite.id, true);
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toMatchObject({ kind: 'grant', ownerId, role: 'viewer' });
        const rows = await shares.listSharedSessionRows(granteeId, { id: true, metadataVersion: true });
        expect(rows).toHaveLength(1);
        // The grantee opens its wrapped key with ITS content key, gets the owner's DEK...
        const { loadAccountSecret } = await import('@/app/auth/accountSecrets');
        const granteeKeys = crypto.contentKeyPairFromSecret(crypto.decodeAccountSecret((await loadAccountSecret(db, granteeId))!));
        const opened = crypto.unwrapDataEncryptionKey(new Uint8Array(rows[0].dataEncryptionKey), granteeKeys);
        expect(Buffer.from(opened!)).toEqual(Buffer.from(dek));
        // ...and the metadata it is served decrypts to a copy WITHOUT the machine-private fields.
        const served = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(rows[0].metadata, 'base64')), dek) as Record<string, unknown>;
        expect(served.path).toBe('/home/owner/repo');
        expect(served.summary).toEqual(metadataPlain.summary);
        for (const key of ['homeDir', 'hostPid', 'terminalId', 'mcpServers']) expect(served).not.toHaveProperty(key);
        expect(rows[0].share).toMatchObject({ role: 'viewer', owner: { id: ownerId, displayName: 'owner' } });
        // The owner was told the invite was accepted.
        expect(emitUpdate.mock.calls.some((c) => c[0].userId === ownerId && c[0].payload.body.t === 'session-share-updated' && c[0].payload.body.status === 'active')).toBe(true);
    });

    it('viewers cannot post; drivers post a server-encrypted message with a sender header and no mode meta', async () => {
        await expect(shares.postSharedMessage({ granteeAccountId: granteeId, sessionId, text: 'hi', localId: 'l1' })).rejects.toMatchObject({ code: 'driver_only' });
        await shares.updateSessionGrantRole(ownerId, sessionId, granteeId, 'driver');
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toMatchObject({ kind: 'grant', role: 'driver' });
        emitUpdate.mockClear();
        const posted = await shares.postSharedMessage({ granteeAccountId: granteeId, sessionId, text: 'please run the tests', localId: 'shared-1' });
        expect(posted.seq).toBeGreaterThan(0);
        const row = await db.sessionMessage.findFirstOrThrow({ where: { sessionId, localId: 'shared-1' } });
        const content = row.content as { t: string; c: string };
        expect(content.t).toBe('encrypted');
        const record = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(content.c, 'base64')), dek) as any;
        expect(record.role).toBe('user');
        expect(record.content.text).toBe(`[Very Happy shared session message from "grantee" ${granteeId}]\nplease run the tests`);
        expect(record.meta).toEqual({ sentFrom: 'shared', displayText: 'please run the tests', sharedBy: { accountId: granteeId, displayName: 'grantee' } });
        expect(record.meta).not.toHaveProperty('permissionMode');
        expect(record.meta).not.toHaveProperty('delivery');
        // Stored and broadcast as the OWNER's session traffic (daemon-compatible).
        const update = emitUpdate.mock.calls.find((c) => c[0].payload.body.t === 'new-message')?.[0];
        expect(update.userId).toBe(ownerId);
        expect(update.recipientFilter).toEqual({ type: 'all-interested-in-session', sessionId });
        // Idempotent on localId.
        const again = await shares.postSharedMessage({ granteeAccountId: granteeId, sessionId, text: 'please run the tests', localId: 'shared-1' });
        expect(again.id).toBe(posted.id);
        // A stranger cannot post at all.
        await expect(shares.postSharedMessage({ granteeAccountId: strangerId, sessionId, text: 'x', localId: 'l2' })).rejects.toMatchObject({ code: 'session_not_found' });
    });

    it('fan-out mirrors session updates to grantee rooms, redacting metadata on update-session', async () => {
        const payload = { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'new-message', sid: sessionId, message: { id: 'm', seq: 9, content: { t: 'encrypted', c: 'x' }, localId: null, createdAt: 1, updatedAt: 1 } } } as const;
        await shares.fanoutSessionUpdateToGrantees(sessionId, payload as any);
        expect(emitToRooms).toHaveBeenCalledWith([`user:${granteeId}:user-scoped`], 'update', payload);
        emitToRooms.mockClear();
        const meta = { id: 'u2', seq: 2, createdAt: Date.now(), body: { t: 'update-session', id: sessionId, metadata: { value: Buffer.from(crypto.encryptWithDataKey({ ...metadataPlain, homeDir: '/secret' }, dek)).toString('base64'), version: 3 } } };
        await shares.fanoutSessionUpdateToGrantees(sessionId, meta as any);
        const forwarded = emitToRooms.mock.calls[0][2];
        expect(forwarded.body.metadata.version).toBe(3);
        const plain = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(forwarded.body.metadata.value, 'base64')), dek) as Record<string, unknown>;
        expect(plain).not.toHaveProperty('homeDir');
        expect(plain.path).toBe('/home/owner/repo');
        // No grantees on the legacy session → nothing emitted.
        emitToRooms.mockClear();
        await shares.fanoutSessionUpdateToGrantees(legacySessionId, payload as any);
        expect(emitToRooms).not.toHaveBeenCalled();
    });

    it('only the owner can list, re-role or revoke; revocation removes access and tells the grantee', async () => {
        await expect(shares.listSessionGrants(granteeId, sessionId)).rejects.toMatchObject({ code: 'owner_only' });
        await expect(shares.revokeSessionGrant(granteeId, sessionId, ownerId)).rejects.toMatchObject({ code: 'owner_only' });
        expect((await shares.listSessionGrants(ownerId, sessionId)).map((g) => [g.grantee.id, g.role, g.status])).toEqual([[granteeId, 'driver', 'active']]);
        emitUpdate.mockClear();
        await shares.revokeSessionGrant(ownerId, sessionId, granteeId);
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toBeNull();
        expect(await shares.listSharedSessionRows(granteeId, { id: true })).toEqual([]);
        expect(await shares.activeGranteeIds(sessionId)).toEqual([]);
        expect(emitUpdate.mock.calls.some((c) => c[0].userId === granteeId && c[0].payload.body.t === 'session-share-revoked')).toBe(true);
        await expect(shares.postSharedMessage({ granteeAccountId: granteeId, sessionId, text: 'x', localId: 'l3' })).rejects.toMatchObject({ code: 'session_not_found' });
        // Re-sharing after a revoke reuses the row and starts pending again.
        const again = await shares.createSessionGrant({ ownerId, sessionId, target: 'grantee', role: 'viewer' });
        expect(again.status).toBe('pending');
        expect(await db.sessionGrant.count({ where: { sessionId } })).toBe(1);
    });

    it('declining marks the grant revoked and notifies the owner', async () => {
        const [invite] = await shares.listPendingSessionInvites(granteeId);
        emitUpdate.mockClear();
        expect(await shares.respondToSessionGrant(granteeId, invite.id, false)).toBeNull();
        expect(await shares.listPendingSessionInvites(granteeId)).toEqual([]);
        expect(emitUpdate.mock.calls.some((c) => c[0].userId === ownerId && c[0].payload.body.status === 'revoked')).toBe(true);
    });
});
