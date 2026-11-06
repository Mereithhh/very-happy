import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Shares from '@/app/session/sessionShares';
import type * as ProjectShares from './projectShares';
import type * as Store from '@/app/projects/store';
import type * as Broker from './terminalShareBroker';
import type * as Crypto from '@/app/session/sessionCrypto';

vi.mock('@/utils/log', () => ({ log: () => undefined, warn: () => undefined }));
vi.mock('@/app/audit/producer', () => ({ businessAuditEnabled: () => false, publishAudit: () => undefined }));
const { emitUpdate, emitToRooms } = vi.hoisted(() => ({ emitUpdate: vi.fn(), emitToRooms: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate, emitToRooms, setSessionFanout: vi.fn() } };
});

/**
 * B-878 PR-B project sharing on PGlite with REAL keys. Derived access is read
 * from current membership: a session added later is visible, a session moved
 * out is not; a project share never operates; revoking it leaves a direct
 * session share of the same session alone; project terminals are view only
 * and end when the terminal leaves the project.
 */
describe('B-878 project shares (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-share-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'project-share-'));
    let db: PrismaClient; let shares: typeof Shares; let ps: typeof ProjectShares; let store: typeof Store; let broker: typeof Broker; let crypto: typeof Crypto;
    let ownerId: string; let bobId: string; let carolId: string; let ownerSecret: Uint8Array; let bobSecret: Uint8Array;
    let projectId: string; let otherProjectId: string;
    let machineKey: Uint8Array;
    const machineId = 'machine-owner-ps';
    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const daemonCalls: Array<{ method: string; params: any }> = [];
    const daemonSocket = {
        id: 'daemon', data: {}, handshake: { issued: 1 },
        timeout: () => ({
            emitWithAck: async (_e: string, req: { method: string; params: string }) => {
                const params = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(req.params, 'base64')), machineKey) as any;
                daemonCalls.push({ method: req.method.slice(req.method.indexOf(':') + 1), params });
                const data = Buffer.from(crypto.encryptWithDataKey(Buffer.from('screen').toString('base64'), machineKey)).toString('base64');
                return Buffer.from(crypto.encryptWithDataKey({ type: 'success', terminalId: params.terminalId, mode: 'snapshot', seq: 1, data, encStream: true, viewOnly: true, paneCols: 100, paneRows: 30 }, machineKey)).toString('base64');
            },
        }),
    };
    const io: any = {
        in: (room: string) => ({ timeout: () => ({ fetchSockets: async () => (room.startsWith(`rpc:${ownerId}:${machineId}:`) ? [daemonSocket] : []) }) }),
        to: (room: string) => ({ emit: (event: string, payload: any) => { emitted.push({ room, event, payload }); } }),
        on: () => undefined,
        serverSideEmit: () => undefined,
    };
    const select = { id: true, accountId: true, metadata: true, dataEncryptionKey: true } as const;
    const sessions: Record<string, string> = {};

    async function createAccount(username: string) {
        const secretBytes = randomBytes(32);
        const account = await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username, firstName: username } });
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        await upsertAccountSecret(db, account.id, secretBytes.toString('base64url'));
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: `${username}@example.com`, email: `${username}@example.com` } });
        return { id: account.id, secret: new Uint8Array(secretBytes) };
    }
    async function createSession(name: string) {
        const dek = new Uint8Array(randomBytes(32));
        const keys = crypto.contentKeyPairFromSecret(ownerSecret);
        const row = await db.session.create({ data: {
            accountId: ownerId, tag: randomBytes(8).toString('hex'),
            metadata: Buffer.from(crypto.encryptWithDataKey({ path: `/home/owner/${name}`, homeDir: '/home/owner', machineId, summary: { text: name } }, dek)).toString('base64'),
            dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, keys.publicKey)),
        } });
        sessions[name] = row.id;
        return row.id;
    }
    const sealMachine = (v: unknown) => Buffer.from(crypto.encryptWithDataKey(v, machineKey)).toString('base64');
    async function setTerminals(list: Array<{ id: string; projectId?: string | null }>) {
        await db.machine.update({ where: { id: machineId }, data: { daemonState: sealMachine({ startedAt: 1, terminalViewOnly: { rpcAvailable: true, detectedAt: 2 }, webTerminals: { updatedAt: 2, terminals: list.map((t) => ({ ...t, title: t.id, cwd: '/home/owner/repo', paneCols: 100, paneRows: 30 })) } }) } });
    }
    const listFor = async (userId: string) => (await shares.listSharedSessionRows<any>(userId, select, { projects: true })).map((e) => ({ id: e.row.id, via: e.share.via, role: e.share.role }));
    const revokedUpdates = (userId: string) => emitUpdate.mock.calls.map((c) => c[0]).filter((u: any) => u.userId === userId && u.payload.body.t === 'session-share-revoked').map((u: any) => u.payload.body.sessionId);

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'project-share-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        shares = await import('@/app/session/sessionShares');
        ps = await import('./projectShares');
        store = await import('@/app/projects/store');
        broker = await import('./terminalShareBroker');
        crypto = await import('@/app/session/sessionCrypto');
        shares.installSessionShareFanout();
        broker.__setTerminalShareIoForTests(io);
        const owner = await createAccount('olga'); ownerId = owner.id; ownerSecret = owner.secret;
        const bob = await createAccount('bobby'); bobId = bob.id; bobSecret = bob.secret;
        carolId = (await createAccount('carol')).id;
        machineKey = new Uint8Array(randomBytes(32));
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: 'x', dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(machineKey, crypto.contentKeyPairFromSecret(ownerSecret).publicKey)) } });
        await createSession('alpha'); await createSession('beta'); await createSession('gamma');
        projectId = (await store.createProject(ownerId, { name: 'shared-proj', folders: [{ machineId, path: '/home/owner/repo' }], sessionIds: [sessions.alpha] })).id;
        otherProjectId = (await store.createProject(ownerId, { name: 'private-proj', folders: [{ machineId, path: '/home/owner/x' }], sessionIds: [sessions.gamma] })).id;
        await store.putInstructions(ownerId, projectId, { instructions: 'Use pnpm.', ifVersion: 0 });
        await store.createLogEntry(ownerId, projectId, { kind: 'decision', title: 'Ship on Friday', body: 'agreed' });
    }, 60000);
    afterAll(async () => { broker.__setTerminalShareIoForTests(null); await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => { emitted.length = 0; daemonCalls.length = 0; emitUpdate.mockClear(); });

    it('a project share never operates; only the owner shares; pending until accepted', async () => {
        await expect(ps.createProjectGrant({ ownerId, projectId, granteeAccountId: bobId, role: 'operator' as any }, shares.granteeContentPublicKey)).rejects.toThrow();
        await expect(ps.createProjectGrant({ ownerId: carolId, projectId, granteeAccountId: bobId, role: 'viewer' }, shares.granteeContentPublicKey)).rejects.toMatchObject({ code: 'project_not_found' });
        const g = await ps.createProjectGrant({ ownerId, projectId, granteeAccountId: bobId, role: 'viewer' }, shares.granteeContentPublicKey);
        expect(g).toMatchObject({ status: 'pending', role: 'viewer', expiresAt: null });
        expect(await listFor(bobId)).toEqual([]);
        expect(await shares.resolveSessionAccess(bobId, sessions.alpha)).toBeNull();
        await ps.respondToProjectGrant(bobId, g.id, true);
        expect(await listFor(bobId)).toEqual([{ id: sessions.alpha, via: 'project', role: 'viewer' }]);
        expect(await shares.resolveSessionAccess(bobId, sessions.alpha)).toMatchObject({ kind: 'project', role: 'viewer', projectId });
        expect(await shares.resolveSessionAccess(bobId, sessions.gamma)).toBeNull(); // another project of the same owner
        expect(await shares.resolveSessionAccess(carolId, sessions.alpha)).toBeNull();
    });

    it('the grantee gets the session key boxed to them and redacted metadata; old clients (no projectShares) see nothing', async () => {
        const [entry] = await shares.listSharedSessionRows<any>(bobId, select, { projects: true });
        const dek = crypto.unwrapDataEncryptionKey(new Uint8Array(entry.dataEncryptionKey), crypto.contentKeyPairFromSecret(bobSecret))!;
        const meta = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(entry.metadata, 'base64')), dek) as any;
        expect(meta.summary.text).toBe('alpha');
        expect(meta.homeDir).toBeUndefined();
        expect(await shares.listSharedSessionRows<any>(bobId, select)).toEqual([]);
        expect(await shares.sharedSessionRowFor<any>(bobId, sessions.alpha, select)).not.toBeNull();
        expect(await db.shareAuditEvent.count({ where: { kind: 'project.derive.open', resourceId: sessions.alpha } })).toBe(1);
    });

    it('a session added later is visible at once; moving one out withdraws it (revoked update) and fan-out stops', async () => {
        await store.addMembers(ownerId, projectId, { sessionIds: [sessions.beta] });
        expect((await listFor(bobId)).map((r) => r.id).sort()).toEqual([sessions.alpha, sessions.beta].sort());
        expect(await shares.activeGranteeIds(sessions.beta)).toContain(bobId);
        expect(emitted.some((e) => e.room === `user:${bobId}:user-scoped` && e.event === 'project-share-changed')).toBe(true);
        emitUpdate.mockClear();
        await store.removeMember(ownerId, projectId, sessions.beta);
        expect(revokedUpdates(bobId)).toEqual([sessions.beta]);
        expect(await shares.resolveSessionAccess(bobId, sessions.beta)).toBeNull();
        expect(await shares.activeGranteeIds(sessions.beta)).not.toContain(bobId);
        // Moved into ANOTHER project: same — the derived access follows membership.
        await store.addMembers(ownerId, projectId, { sessionIds: [sessions.beta] });
        emitUpdate.mockClear();
        await store.addMembers(ownerId, otherProjectId, { sessionIds: [sessions.beta] });
        expect(revokedUpdates(bobId)).toEqual([sessions.beta]);
        expect(await shares.resolveSessionAccess(bobId, sessions.beta)).toBeNull();
    });

    it('can send through the project: driver messages work; viewers cannot; direct and project roles combine to the higher', async () => {
        await expect(shares.postSharedMessage({ granteeAccountId: bobId, sessionId: sessions.alpha, text: 'hi', localId: 'l1' })).rejects.toMatchObject({ code: 'driver_only' });
        await ps.updateProjectGrant(ownerId, projectId, bobId, { role: 'driver' });
        const message = await shares.postSharedMessage({ granteeAccountId: bobId, sessionId: sessions.alpha, text: 'hi', localId: 'l2' });
        expect(message.localId).toBe('l2');
        // A direct viewer share of the same session: project "can send" wins.
        const direct = await shares.createSessionGrant({ ownerId, sessionId: sessions.alpha, granteeAccountId: bobId, role: 'viewer' });
        await shares.respondToSessionGrant(bobId, direct.id, true);
        expect(await shares.resolveSessionAccess(bobId, sessions.alpha)).toMatchObject({ kind: 'project', role: 'driver' });
        expect((await listFor(bobId)).find((r) => r.id === sessions.alpha)).toMatchObject({ via: 'both', role: 'driver' });
    });

    it('revoking the project share keeps the direct session share; only derived-only sessions are withdrawn', async () => {
        await store.addMembers(ownerId, projectId, { sessionIds: [sessions.beta] });
        emitUpdate.mockClear();
        await ps.revokeProjectGrant(ownerId, projectId, bobId);
        expect(revokedUpdates(bobId)).toEqual([sessions.beta]); // alpha stays: direct share
        expect(await listFor(bobId)).toEqual([{ id: sessions.alpha, via: undefined, role: 'viewer' }]);
        expect(await shares.resolveSessionAccess(bobId, sessions.alpha)).toMatchObject({ kind: 'grant', role: 'viewer' });
        expect(await shares.resolveSessionAccess(bobId, sessions.beta)).toBeNull();
        expect(emitted.some((e) => e.room === `user:${bobId}:user-scoped` && e.event === 'project-share-revoked')).toBe(true);
    });

    it('read-only project page: instructions and log, no presence / messages / paths; strangers 404', async () => {
        const g = await ps.createProjectGrant({ ownerId, projectId, granteeAccountId: bobId, role: 'viewer', expiresInDays: 7 }, shares.granteeContentPublicKey);
        await ps.respondToProjectGrant(bobId, g.id, true);
        const view = await ps.sharedProjectView(bobId, g.id);
        expect(view.project).toMatchObject({ name: 'shared-proj', instructions: 'Use pnpm.', folders: [{ machineId, name: 'repo', primary: true }] });
        expect(JSON.stringify(view)).not.toContain('/home/owner');
        expect(view.log.map((e) => e.title)).toContain('Ship on Friday');
        expect(view.sessionIds.sort()).toEqual([sessions.alpha, sessions.beta].sort());
        await expect(ps.sharedProjectView(carolId, g.id)).rejects.toMatchObject({ code: 'grant_not_found' });
    });

    it('project terminals: listed while in the project, view only, cut when the terminal leaves the project or the share ends', async () => {
        const g = (await ps.listIncomingProjectShares(bobId)).find((s) => s.status === 'active')!;
        await setTerminals([{ id: 'pt1', projectId }, { id: 'pt2', projectId: otherProjectId }, { id: 'pt3' }]);
        const terms = await broker.listProjectTerminals(bobId, g.id);
        expect(terms.map((t) => t.terminalId)).toEqual(['pt1']);
        expect(terms[0]).toMatchObject({ cwd: 'repo', viewOnlySupported: true });
        expect(await broker.listProjectTerminals(carolId, g.id)).toEqual([]);
        const key = crypto.unwrapDataEncryptionKey(new Uint8Array(Buffer.from(g.granteeKey, 'base64')), crypto.contentKeyPairFromSecret(bobSecret))!;
        const rpc = (shareId: string, op: string, params: unknown) => broker.handleTerminalShareRpc(io, bobId, { grantId: shareId, op, params: Buffer.from(crypto.encryptWithDataKey(params, key)).toString('base64') });
        // A terminal of another project, forged into a project share id: refused before the daemon is asked.
        expect(await rpc(broker.projectTerminalShareId(g.id, machineId, 'pt2'), 'attach', {})).toEqual({ ok: false, error: 'not_shared' });
        expect(daemonCalls).toHaveLength(0);
        const ack = await rpc(terms[0].shareId, 'attach', { viewOnly: false, cols: 10, rows: 2 });
        expect(ack.ok).toBe(true);
        expect(daemonCalls[0].params).toMatchObject({ terminalId: 'pt1', viewOnly: true, cols: 100, rows: 30, attachOnly: true });
        // Even a "can send" project share never types into a terminal.
        await ps.updateProjectGrant(ownerId, projectId, bobId, { role: 'driver' });
        expect(await rpc(terms[0].shareId, 'paste', { text: 'ls' })).toEqual({ ok: false, error: 'share_method_denied' });
        emitted.length = 0;
        await broker.__forwardTerminalEventForTests(bobId, 'input', { grantId: terms[0].shareId, data: Buffer.from(crypto.encryptWithDataKey('eA==', key)).toString('base64') });
        expect(emitted.filter((e) => e.event === 'terminal-input')).toEqual([]);
        // The terminal leaves the project: the state hook ends the share at once.
        await broker.__refreshTerminalShareIndexForTests();
        emitted.length = 0;
        await broker.noteTerminalShareMachineState(ownerId, machineId, sealMachine({ startedAt: 1, webTerminals: { updatedAt: 2, terminals: [{ id: 'pt1', projectId: null, paneCols: 100, paneRows: 30 }] } }));
        expect(emitted).toContainEqual({ room: `user:${bobId}:user-scoped`, event: 'share-terminal-revoked', payload: { grantId: terms[0].shareId, reason: 'moved' } });
        await setTerminals([{ id: 'pt1', projectId: null }]);
        await new Promise((r) => setTimeout(r, 1100)); // resolver cache
        expect(await rpc(terms[0].shareId, 'attach', {})).toEqual({ ok: false, error: 'not_shared' });
        // Back in the project, attached again; then the project share is revoked → detached, terminal not killed.
        await setTerminals([{ id: 'pt1', projectId }]);
        await new Promise((r) => setTimeout(r, 1100));
        expect((await rpc(terms[0].shareId, 'attach', {})).ok).toBe(true);
        emitted.length = 0; daemonCalls.length = 0;
        await ps.revokeProjectGrant(ownerId, projectId, bobId);
        expect(emitted).toContainEqual({ room: `user:${bobId}:user-scoped`, event: 'share-terminal-revoked', payload: { grantId: terms[0].shareId, reason: 'revoked' } });
        expect(emitted.filter((e) => e.event === 'terminal-close')).toHaveLength(1);
        expect(daemonCalls).toHaveLength(0);
    });

    it('B-899 effective = max(direct, project): only the grantee\'s own live direct grant upgrades a project terminal row; the p: path never types', async () => {
        const { createTerminalGrant, respondToTerminalGrant, revokeTerminalGrant, listIncomingTerminalShares } = await import('./terminalShares');
        const dave = await createAccount('davey'); const erin = await createAccount('erinn');
        const g = await ps.createProjectGrant({ ownerId, projectId, granteeAccountId: dave.id, role: 'driver', expiresInDays: null }, shares.granteeContentPublicKey);
        await ps.respondToProjectGrant(dave.id, g.id, true);
        await setTerminals([{ id: 'dt1', projectId }, { id: 'dt2', projectId }]);
        const row = async (id: string) => (await broker.listProjectTerminals(dave.id, g.id)).find((t) => t.terminalId === id)!;
        // No direct grant: the row is the view-only project share, as before.
        expect((await row('dt1')).direct).toBeUndefined();
        expect((await row('dt1')).shareId).toBe(broker.projectTerminalShareId(g.id, machineId, 'dt1'));
        // Someone else's operator grant on the same terminal changes nothing for dave.
        const forErin = await createTerminalGrant({ ownerId, machineId, terminalId: 'dt1', granteeAccountId: erin.id, role: 'operator', expiresInDays: 1, confirmOperator: true });
        await respondToTerminalGrant(erin.id, forErin.id, true);
        expect((await row('dt1')).direct).toBeUndefined();
        // Dave's own operator grant: pending first (the row leads to the accept page), then active.
        const direct = await createTerminalGrant({ ownerId, machineId, terminalId: 'dt1', granteeAccountId: dave.id, role: 'operator', expiresInDays: 1, confirmOperator: true });
        expect((await row('dt1')).direct).toMatchObject({ grantId: direct.id, role: 'operator', status: 'pending' });
        await respondToTerminalGrant(dave.id, direct.id, true);
        expect((await row('dt1')).direct).toMatchObject({ grantId: direct.id, role: 'operator', status: 'active' });
        expect((await row('dt2')).direct).toBeUndefined(); // per terminal, not per project
        // The direct id operates; the project id of the same terminal still never types.
        const inc = (await listIncomingTerminalShares(dave.id)).find((s) => s.id === direct.id)!;
        const directKey = crypto.unwrapDataEncryptionKey(new Uint8Array(Buffer.from(inc.granteeKey, 'base64')), crypto.contentKeyPairFromSecret(dave.secret))!;
        const projectKey = crypto.unwrapDataEncryptionKey(new Uint8Array(Buffer.from((await ps.listIncomingProjectShares(dave.id)).find((s) => s.id === g.id)!.granteeKey, 'base64')), crypto.contentKeyPairFromSecret(dave.secret))!;
        const sealed = (v: unknown, k: Uint8Array) => Buffer.from(crypto.encryptWithDataKey(v, k)).toString('base64');
        const rpc = (shareId: string, k: Uint8Array, op: string, params: unknown) => broker.handleTerminalShareRpc(io, dave.id, { grantId: shareId, op, params: sealed(params, k) });
        const pShare = broker.projectTerminalShareId(g.id, machineId, 'dt1');
        expect((await rpc(direct.id, directKey, 'attach', { cols: 80, rows: 24 })).ok).toBe(true);
        expect(daemonCalls.at(-1)!.params).not.toMatchObject({ viewOnly: true });
        expect((await rpc(direct.id, directKey, 'paste', { text: 'echo hi' })).ok).toBe(true);
        expect((await rpc(pShare, projectKey, 'attach', { viewOnly: false, cols: 10, rows: 2 })).ok).toBe(true);
        expect(daemonCalls.at(-1)!.params).toMatchObject({ terminalId: 'dt1', viewOnly: true });
        expect(await rpc(pShare, projectKey, 'paste', { text: 'ls' })).toEqual({ ok: false, error: 'share_method_denied' });
        emitted.length = 0;
        await broker.__forwardTerminalEventForTests(dave.id, 'input', { grantId: pShare, data: sealed('eA==', projectKey) });
        expect(emitted.filter((e) => e.event === 'terminal-input')).toEqual([]);
        await broker.__forwardTerminalEventForTests(dave.id, 'input', { grantId: direct.id, data: sealed('eA==', directKey) });
        expect(emitted.filter((e) => e.event === 'terminal-input')).toHaveLength(1);
        // Keystrokes reach the shell in typing order even when the first one misses every cache (socket path).
        const handlers = new Map<string, (data: unknown) => void>();
        broker.terminalShareHandler(dave.id, { on: (name: string, fn: (data: unknown) => void) => { handlers.set(name, fn); }, nsp: { server: io } } as any, { connectionType: 'user-scoped' }, {});
        broker.__setTerminalShareIoForTests(io);
        emitted.length = 0;
        // Only the first keystroke's grant lookup is slow (a cold cache / slow query): it must still land first.
        const realFindFirst = db.terminalGrant.findFirst.bind(db.terminalGrant);
        let calls = 0;
        (db.terminalGrant as any).findFirst = (args: any) => (calls++ === 0 ? new Promise((r) => setTimeout(r, 60)).then(() => realFindFirst(args)) : realFindFirst(args));
        const typed = 'echo hi\r'.split('');
        for (const ch of typed) handlers.get('share-terminal-input')!({ grantId: direct.id, data: sealed(Buffer.from(ch).toString('base64'), directKey) });
        for (let i = 0; i < 100 && emitted.filter((e) => e.event === 'terminal-input').length < typed.length; i++) await new Promise((r) => setTimeout(r, 20));
        const arrived = emitted.filter((e) => e.event === 'terminal-input')
            .map((e) => Buffer.from(crypto.decryptWithDataKey(new Uint8Array(Buffer.from(e.payload.data, 'base64')), machineKey) as string, 'base64').toString());
        (db.terminalGrant as any).findFirst = realFindFirst;
        expect(arrived.join('')).toBe(typed.join(''));
        // Revoked: back to the view-only project row. Re-shared and then expired: back again.
        await revokeTerminalGrant(ownerId, direct.id);
        expect((await row('dt1')).direct).toBeUndefined();
        const again = await createTerminalGrant({ ownerId, machineId, terminalId: 'dt1', granteeAccountId: dave.id, role: 'operator', expiresInDays: 1, confirmOperator: true });
        await respondToTerminalGrant(dave.id, again.id, true);
        expect((await row('dt1')).direct?.grantId).toBe(again.id);
        await db.terminalGrant.update({ where: { id: again.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await row('dt1')).direct).toBeUndefined();
        // A stranger with the project grant id sees nothing at all.
        expect(await broker.listProjectTerminals(erin.id, g.id)).toEqual([]);
        await ps.revokeProjectGrant(ownerId, projectId, dave.id);
        expect(await broker.listProjectTerminals(dave.id, g.id)).toEqual([]);
    });

    it('B-899 team-derived sessions (no ProjectMember rows): "can send" lists them as driver and the message posts, signed as the grantee', async () => {
        const lead = await createSession('team-lead'); const member = await createSession('team-member');
        const teamProject = (await store.createProject(ownerId, { name: 'team-proj', folders: [{ machineId, path: '/home/owner/team' }] })).id;
        await db.agentTeam.create({ data: { id: 'team-b899', accountId: ownerId, machineId, projectId: teamProject, state: { name: 'T', bots: [{ id: 'b1', sessionId: lead, root: true }, { id: 'b2', sessionId: member }] } } });
        expect(await db.projectMember.count({ where: { projectId: teamProject } })).toBe(0);
        const frank = await createAccount('franky');
        const g = await ps.createProjectGrant({ ownerId, projectId: teamProject, granteeAccountId: frank.id, role: 'driver', expiresInDays: null }, shares.granteeContentPublicKey);
        await ps.respondToProjectGrant(frank.id, g.id, true);
        expect((await ps.sharedProjectView(frank.id, g.id)).sessionIds.sort()).toEqual([lead, member].sort());
        for (const id of [lead, member]) {
            expect(await shares.resolveSessionAccess(frank.id, id)).toMatchObject({ kind: 'project', role: 'driver', projectId: teamProject });
            expect((await listFor(frank.id)).find((r) => r.id === id)).toMatchObject({ via: 'project', role: 'driver' });
            const sent = await shares.postSharedMessage({ granteeAccountId: frank.id, sessionId: id, text: 'hello team', localId: `t-${id}` });
            expect(sent.localId).toBe(`t-${id}`);
            const row = await db.sessionMessage.findFirstOrThrow({ where: { sessionId: id, localId: `t-${id}` } });
            const sessionRow = await db.session.findUniqueOrThrow({ where: { id }, select: { dataEncryptionKey: true } });
            const dek = crypto.unwrapDataEncryptionKey(new Uint8Array(sessionRow.dataEncryptionKey!), crypto.contentKeyPairFromSecret(ownerSecret))!;
            const content = row.content as { t: string; c: string };
            const record = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(content.c, 'base64')), dek) as any;
            expect(record.meta.sharedBy).toEqual({ accountId: frank.id, displayName: 'franky' });
        }
        await ps.revokeProjectGrant(ownerId, teamProject, frank.id);
        await expect(shares.postSharedMessage({ granteeAccountId: frank.id, sessionId: lead, text: 'x', localId: 't-x' })).rejects.toBeTruthy();
    });

    it('expiry is enforced on read and announced by the expiry sweep', async () => {
        const g = await ps.createProjectGrant({ ownerId, projectId, granteeAccountId: carolId, role: 'viewer', expiresInDays: 1 }, shares.granteeContentPublicKey);
        await ps.respondToProjectGrant(carolId, g.id, true);
        expect(await shares.resolveSessionAccess(carolId, sessions.alpha)).toMatchObject({ kind: 'project' });
        await db.projectGrant.update({ where: { id: g.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        ps.invalidateProjectShareCaches();
        expect(await shares.resolveSessionAccess(carolId, sessions.alpha)).toBeNull();
        emitUpdate.mockClear();
        await ps.expireProjectGrants();
        expect(revokedUpdates(carolId).sort()).toEqual([sessions.alpha, sessions.beta].sort());
        expect((await db.projectGrant.findUniqueOrThrow({ where: { id: g.id } })).endedReason).toBe('expired');
    });

    it('real routes: strict bodies (no operate), owner-only management, grantee page', async () => {
        const fastify = (await import('fastify')).default;
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { projectShareRoutes } = await import('@/app/api/routes/projectShareRoutes');
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: any) => { request.userId = request.headers['x-user']; });
        projectShareRoutes(app as any);
        await app.ready();
        const as = (u: string) => ({ 'x-user': u });
        for (const payload of [{ accountId: bobId, role: 'operator' }, { accountId: bobId, role: 'driver', operate: true }, { accountId: bobId, role: 'viewer', expiresInDays: 2 }]) {
            expect((await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/shares`, headers: as(ownerId), payload })).statusCode).toBe(400);
        }
        expect((await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/shares`, headers: as(carolId), payload: { accountId: bobId, role: 'viewer' } })).statusCode).toBe(404);
        const created = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/shares`, headers: as(ownerId), payload: { target: 'bobby', role: 'driver', expiresInDays: null } });
        expect(created.statusCode).toBe(200);
        const grantId = created.json().grant.id;
        expect((await app.inject({ method: 'GET', url: '/v1/project-shares/incoming', headers: as(bobId) })).json().shares[0]).toMatchObject({ id: grantId, status: 'pending', name: 'shared-proj', role: 'driver' });
        expect((await app.inject({ method: 'GET', url: `/v1/project-shares/${grantId}`, headers: as(bobId) })).statusCode).toBe(404); // not accepted yet
        expect((await app.inject({ method: 'POST', url: `/v1/project-shares/${grantId}/respond`, headers: as(bobId), payload: { accept: true } })).statusCode).toBe(200);
        const page = (await app.inject({ method: 'GET', url: `/v1/project-shares/${grantId}`, headers: as(bobId) })).json();
        expect(page.project.name).toBe('shared-proj');
        expect(Array.isArray(page.terminals)).toBe(true);
        expect((await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/shares`, headers: as(bobId) })).statusCode).toBe(404);
        expect((await app.inject({ method: 'DELETE', url: `/v1/projects/${projectId}/shares/${bobId}`, headers: as(ownerId) })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/v1/project-shares/incoming', headers: as(bobId) })).json().shares).toEqual([]);
        await app.close();
    });
});
