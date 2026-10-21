import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Links from './shareLinks';
import type * as Shares from './sessionShares';
import type * as Crypto from './sessionCrypto';

vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate: vi.fn(), emitToRooms: vi.fn(), setSessionFanout: vi.fn() } };
});

/**
 * B-701 on PGlite with real account secrets and real session keys: share
 * links (create / read / revoke / expire / rotate / snapshot ceiling /
 * projection + masking / open audit) and contact-grant expiry. Every
 * rejection the spec promises is asserted here: wrong secret, other owner,
 * revoked, expired, grantee trying owner actions.
 */
describe('B-701 share links and grant expiry (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-share-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'links-'));
    let db: PrismaClient; let links: typeof Links; let shares: typeof Shares; let crypto: typeof Crypto;
    let ownerId: string; let granteeId: string; let strangerId: string; let sessionId: string; let strangerSessionId: string;
    let dek: Uint8Array;
    const metadataPlain = { path: '/home/owner/secret-project', host: 'owner-box', machineId: 'm1', flavor: 'claude', summary: { text: 'Fix the build', updatedAt: 1 } };

    async function createAccount(email: string, username: string) {
        const secretBytes = randomBytes(32);
        const account = await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username, firstName: username } });
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        await upsertAccountSecret(db, account.id, secretBytes.toString('base64url'));
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: email, email } });
        return { id: account.id, secret: new Uint8Array(secretBytes) };
    }

    async function createSession(owner: { id: string; secret: Uint8Array }) {
        const keys = crypto.contentKeyPairFromSecret(owner.secret);
        return (await db.session.create({ data: {
            accountId: owner.id, tag: randomBytes(8).toString('hex'),
            metadata: Buffer.from(crypto.encryptWithDataKey(metadataPlain, dek)).toString('base64'),
            dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, keys.publicKey)),
        } })).id;
    }

    async function addMessage(record: unknown) {
        const session = await db.session.update({ where: { id: sessionId }, data: { seq: { increment: 1 } }, select: { seq: true } });
        await db.sessionMessage.create({ data: {
            sessionId, seq: session.seq,
            content: { t: 'encrypted', c: Buffer.from(crypto.encryptWithDataKey(record, dek)).toString('base64') },
        } });
        return session.seq;
    }

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'share-link-integration-test-only';
        process.env.MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE = '1000';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        links = await import('./shareLinks');
        shares = await import('./sessionShares');
        crypto = await import('./sessionCrypto');
        const owner = await createAccount('owner@example.com', 'owner');
        const grantee = await createAccount('grantee@example.com', 'grantee');
        const stranger = await createAccount('stranger@example.com', 'stranger');
        ownerId = owner.id; granteeId = grantee.id; strangerId = stranger.id;
        dek = new Uint8Array(randomBytes(32));
        sessionId = await createSession(owner);
        strangerSessionId = await createSession(stranger);
        await addMessage({ role: 'user', content: { type: 'text', text: 'please deploy, key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' } });
        await addMessage({ role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { role: 'assistant', model: 'm', content: [
            { type: 'thinking', thinking: 'private chain of thought', signature: 'sig' },
            { type: 'text', text: 'Reading .env' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } },
        ], usage: { input_tokens: 1, output_tokens: 1 } } } } });
        await addMessage({ role: 'agent', content: { type: 'acp', provider: 'x', data: { type: 'reasoning', message: 'hidden reasoning' } } });
        await addMessage({ role: 'agent', content: { type: 'output', data: { type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'DATABASE_URL=postgres://app:hunter22@db/happy\nPORT=3005', permissions: { date: 1, result: 'approved', mode: 'yolo' } },
        ] } } } });
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    it('only the owner can create, list, update, rotate or revoke a link', async () => {
        await expect(links.createShareLink({ ownerId: granteeId, sessionId, scope: 'live', expiresInDays: 7 })).rejects.toMatchObject({ code: 'session_not_found', status: 404 });
        const { link } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 7 });
        await expect(links.listShareLinks(strangerId, sessionId)).rejects.toMatchObject({ status: 404 });
        await expect(links.revokeShareLink(strangerId, sessionId, link.id)).rejects.toMatchObject({ status: 404 });
        await expect(links.rotateShareLink(granteeId, sessionId, link.id)).rejects.toMatchObject({ status: 404 });
        await expect(links.updateShareLink(strangerId, sessionId, link.id, { expiresInDays: null })).rejects.toMatchObject({ status: 404 });
        // A link id paired with a session the caller owns but the link does not belong to.
        await expect(links.revokeShareLink(strangerId, strangerSessionId, link.id)).rejects.toMatchObject({ code: 'link_not_found' });
        await expect(links.listShareLinkAccesses(strangerId, link.id)).rejects.toMatchObject({ status: 404 });
        // Even an accepted driver grantee cannot mint links.
        await shares.createSessionGrant({ ownerId, sessionId, target: 'grantee', role: 'driver' });
        const [invite] = await shares.listPendingSessionInvites(granteeId);
        await shares.respondToSessionGrant(granteeId, invite.id, true);
        await expect(links.createShareLink({ ownerId: granteeId, sessionId, scope: 'snapshot', expiresInDays: 1 })).rejects.toMatchObject({ status: 404 });
        await shares.revokeSessionGrant(ownerId, sessionId, granteeId);
    });

    it('stores only the sha256 of a 256-bit secret; wrong secret / unknown id are indistinguishable 404s', async () => {
        const { link, secret } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: null });
        expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
        const row = await db.sessionShareLink.findUniqueOrThrow({ where: { id: link.id } });
        expect(Buffer.from(row.tokenHash).toString('hex')).toBe(Buffer.from(links.hashShareSecret(secret)).toString('hex'));
        expect(JSON.stringify(row)).not.toContain(secret);
        await expect(links.resolvePublicLink({ linkId: link.id, secret: links.generateShareSecret() })).rejects.toMatchObject({ code: 'link_not_found', status: 404 });
        await expect(links.resolvePublicLink({ linkId: 'nope', secret })).rejects.toMatchObject({ code: 'link_not_found', status: 404 });
        expect((await links.resolvePublicLink({ linkId: link.id, secret })).id).toBe(link.id);
    });

    it('projects records for anonymous viewers: no thinking/reasoning/permissions/usage, secrets masked, no machine metadata', async () => {
        const { link, secret } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 });
        const row = await links.resolvePublicLink({ linkId: link.id, secret });
        const page = await links.publicLinkMessages(row, 0, 100);
        const json = JSON.stringify(page.messages);
        expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 4]); // seq 3 (reasoning) dropped
        expect(json).not.toContain('private chain of thought');
        expect(json).not.toContain('hidden reasoning');
        expect(json).not.toContain('"signature"');
        expect(json).not.toContain('"permissions"');
        expect(json).not.toContain('"usage"');
        expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
        expect(json).not.toContain('hunter22');
        expect(json).toContain('Reading .env');
        expect(json).toContain('PORT=3005');
        const info = await links.publicLinkInfo(row);
        expect(info.session).toMatchObject({ title: 'Fix the build', project: 'secret-project', flavor: 'claude' });
        expect(JSON.stringify(info)).not.toMatch(/owner-box|\/home\/owner|"m1"/);
    });

    it('a snapshot never shows messages after its ceiling until moved to now', async () => {
        const { link, secret } = await links.createShareLink({ ownerId, sessionId, scope: 'snapshot', expiresInDays: 7 });
        const later = await addMessage({ role: 'user', content: { type: 'text', text: 'after the snapshot' } });
        let row = await links.resolvePublicLink({ linkId: link.id, secret });
        expect((await links.publicLinkMessages(row, 0, 100)).messages.some((m) => m.seq === later)).toBe(false);
        await links.updateShareLink(ownerId, sessionId, link.id, { snapshotToNow: true });
        row = await links.resolvePublicLink({ linkId: link.id, secret });
        expect((await links.publicLinkMessages(row, 0, 100)).messages.some((m) => m.seq === later)).toBe(true);
        // A live link has no ceiling.
        await expect(links.updateShareLink(ownerId, sessionId, (await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 })).link.id, { snapshotToNow: true })).rejects.toMatchObject({ code: 'link_not_snapshot' });
    });

    it('revocation is immediate (410 on the next request) and rotation kills the old secret', async () => {
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } }); // reset the 5-link budget
        const { link, secret } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 30 });
        await links.resolvePublicLink({ linkId: link.id, secret });
        await links.revokeShareLink(ownerId, sessionId, link.id);
        await expect(links.resolvePublicLink({ linkId: link.id, secret })).rejects.toMatchObject({ code: 'link_revoked', status: 410 });
        await links.revokeShareLink(ownerId, sessionId, link.id); // idempotent
        await expect(links.updateShareLink(ownerId, sessionId, link.id, { expiresInDays: null })).rejects.toMatchObject({ code: 'link_revoked' });

        const first = await links.createShareLink({ ownerId, sessionId, scope: 'snapshot', expiresInDays: 7 });
        const rotated = await links.rotateShareLink(ownerId, sessionId, first.link.id);
        await expect(links.resolvePublicLink({ linkId: first.link.id, secret: first.secret })).rejects.toMatchObject({ status: 410 });
        await expect(links.resolvePublicLink({ linkId: rotated.link.id, secret: first.secret })).rejects.toMatchObject({ status: 404 });
        expect((await links.resolvePublicLink({ linkId: rotated.link.id, secret: rotated.secret })).scope).toBe('snapshot');
    });

    it('expiry: an expired link answers 410 link_expired; extending it brings it back', async () => {
        const { link, secret } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 });
        expect(link.expiresAt! - Date.now()).toBeGreaterThan(23 * 3600_000);
        await db.sessionShareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        await expect(links.resolvePublicLink({ linkId: link.id, secret })).rejects.toMatchObject({ code: 'link_expired', status: 410 });
        expect((await links.listShareLinks(ownerId, sessionId)).find((l) => l.id === link.id)?.status).toBe('expired');
        await links.updateShareLink(ownerId, sessionId, link.id, { expiresInDays: 7 });
        expect((await links.resolvePublicLink({ linkId: link.id, secret })).id).toBe(link.id);
    });

    it('caps active links per session', async () => {
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
        for (let i = 0; i < 5; i++) await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 });
        await expect(links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 })).rejects.toMatchObject({ code: 'too_many_links' });
    });

    it('open audit: anonymous, deduped per viewer for 10 minutes, bots flagged and not counted', async () => {
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
        const { link } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 });
        const t0 = new Date();
        await links.recordShareLinkAccess(link, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome' }, t0);
        await links.recordShareLinkAccess(link, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome' }, new Date(t0.getTime() + 60_000));
        await links.recordShareLinkAccess(link, { ip: '198.51.100.7', userAgent: 'Slackbot-LinkExpanding 1.0' }, t0);
        await links.recordShareLinkAccess(link, { ip: '198.51.100.8', userAgent: 'Mozilla/5.0 Safari' }, t0);
        await links.recordShareLinkAccess(link, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 Chrome' }, new Date(t0.getTime() + 11 * 60_000));
        const row = await db.sessionShareLink.findUniqueOrThrow({ where: { id: link.id } });
        expect(row.accessCount).toBe(3);
        const accesses = await links.listShareLinkAccesses(ownerId, link.id);
        expect(accesses).toHaveLength(4);
        expect(accesses.filter((a) => a.bot)).toHaveLength(1);
        for (const a of accesses) expect(Object.keys(a).sort()).toEqual(['at', 'bot']);
        const stored = await db.sessionShareLinkAccess.findMany({ where: { linkId: link.id } });
        expect(JSON.stringify(stored)).not.toMatch(/203\.0\.113\.9|Mozilla|Chrome/);
    });

    it('retention: opens older than 90 days are purged by the sweep, newer ones stay', async () => {
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
        const { link } = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: null });
        const day = 24 * 3600_000;
        await links.recordShareLinkAccess(link, { ip: '192.0.2.1', userAgent: null }, new Date(Date.now() - 91 * day));
        await links.recordShareLinkAccess(link, { ip: '192.0.2.2', userAgent: null }, new Date(Date.now() - 89 * day));
        expect(await links.purgeExpiredShareLinkAccesses()).toBeGreaterThanOrEqual(1);
        const left = await db.sessionShareLinkAccess.findMany({ where: { linkId: link.id } });
        expect(left).toHaveLength(1);
        expect(left[0].at.getTime()).toBeGreaterThan(Date.now() - 90 * day);
    });

    it('rotate never revives a revoked or expired link (409) and respects the per-session cap', async () => {
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
        const revoked = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 7 });
        await links.revokeShareLink(ownerId, sessionId, revoked.link.id);
        await expect(links.rotateShareLink(ownerId, sessionId, revoked.link.id)).rejects.toMatchObject({ code: 'link_not_active', status: 409 });
        const expired = await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 });
        await db.sessionShareLink.update({ where: { id: expired.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        await expect(links.rotateShareLink(ownerId, sessionId, expired.link.id)).rejects.toMatchObject({ code: 'link_not_active', status: 409 });
        // Rotating an active link keeps the count (revoke one, create one) — never above the cap.
        await db.sessionShareLink.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
        const five = [];
        for (let i = 0; i < 5; i++) five.push(await links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 }));
        await links.rotateShareLink(ownerId, sessionId, five[0].link.id);
        expect(await db.sessionShareLink.count({ where: { sessionId, revokedAt: null } })).toBe(5);
        // Concurrent creates cannot both slip past the cap.
        await links.revokeShareLink(ownerId, sessionId, five[1].link.id);
        const results = await Promise.allSettled([1, 2, 3].map(() => links.createShareLink({ ownerId, sessionId, scope: 'live', expiresInDays: 1 })));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await db.sessionShareLink.count({ where: { sessionId, revokedAt: null } })).toBe(5);
    });

    it('contact grants: an expired grant gives no access, no fan-out, no pending invite, and can be re-shared', async () => {
        const grant = await shares.createSessionGrant({ ownerId, sessionId, target: 'grantee', role: 'viewer', expiresInDays: 1 });
        expect(grant.expiresAt! - Date.now()).toBeGreaterThan(23 * 3600_000);
        await shares.respondToSessionGrant(granteeId, grant.id, true);
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toMatchObject({ kind: 'grant', role: 'viewer' });
        await db.sessionGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        shares.invalidateGrantees(sessionId);
        expect(await shares.resolveSessionAccess(granteeId, sessionId)).toBeNull();
        expect(await shares.activeGranteeIds(sessionId)).not.toContain(granteeId);
        expect(await shares.listSharedSessionRows(granteeId, { id: true })).toHaveLength(0);
        await expect(shares.requireSessionAccess(granteeId, sessionId, 'viewer')).rejects.toMatchObject({ status: 404 });
        // Owner sees it as expired in the outgoing list; re-sharing an expired grant is allowed.
        const outgoing = await links.listOutgoingShares(ownerId);
        expect(outgoing.sessions.find((s) => s.sessionId === sessionId)?.grants.find((g) => g.id === grant.id)?.status).toBe('expired');
        const again = await shares.createSessionGrant({ ownerId, sessionId, target: 'grantee', role: 'viewer', expiresInDays: null });
        expect(again.expiresAt).toBeNull();
        // An expired pending invite cannot be accepted.
        await db.sessionGrant.update({ where: { id: again.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect(await shares.listPendingSessionInvites(granteeId)).toHaveLength(0);
        await expect(shares.respondToSessionGrant(granteeId, again.id, true)).rejects.toMatchObject({ status: 404 });
        // Extending expiry restores the grant (owner only).
        await expect(shares.updateSessionGrantRole(granteeId, sessionId, granteeId, undefined, 7)).rejects.toMatchObject({ status: 404 });
        await shares.updateSessionGrantRole(ownerId, sessionId, granteeId, undefined, 7);
        expect(await shares.listPendingSessionInvites(granteeId)).toHaveLength(1);
    });
});
