import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './terminalShares';
import type * as Broker from './terminalShareBroker';
import type * as Crypto from '@/app/session/sessionCrypto';

const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));
vi.mock('@/utils/log', () => ({ log: (...args: unknown[]) => { logged.push(args); }, warn: (...args: unknown[]) => { logged.push(args); } }));
const { audited } = vi.hoisted(() => ({ audited: [] as Array<{ kind: string; payload?: Record<string, unknown> }> }));
vi.mock('@/app/audit/producer', () => ({ businessAuditEnabled: () => true, publishAudit: (input: { kind: string; payload?: Record<string, unknown> }) => { audited.push(input); } }));

/**
 * B-878 terminal sharing end-to-end through the broker with REAL account
 * secrets, a REAL machine key and a REAL per-grant stream key, against a fake
 * owner daemon that decrypts what it is sent exactly like the CLI does.
 * Proves: a viewer's attach is view-only (never the viewer's size), a viewer
 * cannot type / resize / scroll / paste, an operator can, the grantee only
 * ever sees stream-key ciphertext, revoke cuts the stream at once without
 * killing the owner's terminal, and no plaintext reaches a log line.
 */
describe('B-878 terminal share broker (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-share-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'terminal-share-'));
    let db: PrismaClient; let store: typeof Store; let broker: typeof Broker; let crypto: typeof Crypto;
    let ownerId: string; let viewerId: string; let operatorId: string; let strangerId: string;
    let viewerSecret: Uint8Array; let operatorSecret: Uint8Array;
    let machineKey: Uint8Array;
    const machineId = 'machine-owner-ts';
    const terminalId = 'term0001';
    const SECRET_MARK = 'PLAINTEXT-MARK-b878';

    // ---- fake io + owner daemon
    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const daemonCalls: Array<{ method: string; params: any }> = [];
    let daemonOpenResult: ((params: any) => unknown) | null = null;
    const daemonSocket = {
        id: 'daemon-socket', data: {}, handshake: { issued: 1 },
        timeout: () => ({
            emitWithAck: async (_event: string, req: { method: string; params: string }) => {
                const params = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(req.params, 'base64')), machineKey) as any;
                const method = req.method.slice(req.method.indexOf(':') + 1);
                daemonCalls.push({ method, params });
                let result: unknown = { type: 'success' };
                if (method === 'open-terminal') {
                    result = daemonOpenResult ? daemonOpenResult(params) : {
                        type: 'success', terminalId: params.terminalId, mode: 'snapshot', seq: 5,
                        data: Buffer.from(crypto.encryptWithDataKey(Buffer.from(`${SECRET_MARK} screen`).toString('base64'), machineKey)).toString('base64'),
                        encStream: !!params.encStream,
                        ...(params.viewOnly ? { viewOnly: true, paneCols: 132, paneRows: 40 } : {}),
                    };
                }
                return Buffer.from(crypto.encryptWithDataKey(result, machineKey)).toString('base64');
            },
        }),
    };
    const io: any = {
        in: (room: string) => ({ timeout: () => ({ fetchSockets: async () => (room.startsWith(`rpc:${ownerId}:${machineId}:`) ? [daemonSocket] : []) }) }),
        to: (room: string) => ({ emit: (event: string, payload: any) => { emitted.push({ room, event, payload }); } }),
        on: () => undefined,
        serverSideEmit: () => undefined,
    };
    const sealMachine = (v: unknown) => Buffer.from(crypto.encryptWithDataKey(v, machineKey)).toString('base64');
    const openWith = (v: string, key: Uint8Array) => crypto.decryptWithDataKey(new Uint8Array(Buffer.from(v, 'base64')), key);
    const room = (id: string) => `user:${id}:user-scoped`;

    async function createAccount(username: string) {
        const secretBytes = randomBytes(32);
        const account = await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username, firstName: username } });
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        await upsertAccountSecret(db, account.id, secretBytes.toString('base64url'));
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: `${username}@example.com`, email: `${username}@example.com` } });
        return { id: account.id, secret: new Uint8Array(secretBytes) };
    }
    /** What the grantee's web does: open the boxed stream key with its own content key. */
    async function streamKeyOf(grantId: string, secret: Uint8Array) {
        const row = await db.terminalGrant.findUniqueOrThrow({ where: { id: grantId } });
        return crypto.unwrapDataEncryptionKey(new Uint8Array(row.granteeKey), crypto.contentKeyPairFromSecret(secret))!;
    }
    async function setDaemonState(state: Record<string, unknown>) {
        await db.machine.update({ where: { id: machineId }, data: { daemonState: sealMachine(state) } });
    }
    const baseState = (extra: Record<string, unknown> = {}, terminals = [{ id: terminalId, title: 'build', cwd: '/home/owner/repo', paneCols: 132, paneRows: 40 }]) => ({
        status: 'running', startedAt: 1000, webTerminals: { updatedAt: 2000, terminals }, terminalViewOnly: { rpcAvailable: true, detectedAt: 2000 }, ...extra,
    });

    async function share(granteeId: string, role: 'viewer' | 'operator', extra: Record<string, unknown> = {}) {
        const grant = await store.createTerminalGrant({ ownerId, machineId, terminalId, title: 'build', granteeAccountId: granteeId, role, ...(role === 'operator' ? { confirmOperator: true } : {}), ...extra });
        await store.respondToTerminalGrant(granteeId, grant.id, true);
        return grant;
    }
    const rpc = (userId: string, grantId: string, op: string, params: unknown, key: Uint8Array) =>
        broker.handleTerminalShareRpc(io, userId, { grantId, op, params: Buffer.from(crypto.encryptWithDataKey(params, key)).toString('base64') });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'terminal-share-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        store = await import('./terminalShares');
        broker = await import('./terminalShareBroker');
        crypto = await import('@/app/session/sessionCrypto');
        broker.__setTerminalShareIoForTests(io);
        const owner = await createAccount('owner');
        ownerId = owner.id;
        const viewer = await createAccount('vera'); viewerId = viewer.id; viewerSecret = viewer.secret;
        const operator = await createAccount('otto'); operatorId = operator.id; operatorSecret = operator.secret;
        strangerId = (await createAccount('stan')).id;
        machineKey = new Uint8Array(randomBytes(32));
        const ownerKeys = crypto.contentKeyPairFromSecret(owner.secret);
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: 'x', dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(machineKey, ownerKeys.publicKey)) } });
        await setDaemonState(baseState());
    }, 60000);
    afterAll(async () => { broker.__setTerminalShareIoForTests(null); await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => { emitted.length = 0; daemonCalls.length = 0; audited.length = 0; daemonOpenResult = null; broker.__setTerminalShareIoForTests(io); });

    it('every tier expires; operator needs confirmation; only the owner\'s machine; pending until accepted', async () => {
        await expect(store.createTerminalGrant({ ownerId, machineId, terminalId, granteeAccountId: viewerId, role: 'viewer', expiresInDays: null })).rejects.toMatchObject({ code: 'bad_expiry' });
        await expect(store.createTerminalGrant({ ownerId, machineId, terminalId, granteeAccountId: operatorId, role: 'operator' })).rejects.toMatchObject({ code: 'operator_requires_confirm' });
        await expect(store.createTerminalGrant({ ownerId: strangerId, machineId, terminalId, granteeAccountId: viewerId, role: 'viewer' })).rejects.toMatchObject({ code: 'machine_not_found' });
        await expect(store.createTerminalGrant({ ownerId, machineId, terminalId, granteeAccountId: ownerId, role: 'viewer' })).rejects.toMatchObject({ code: 'cannot_share_with_self' });
        const pending = await store.createTerminalGrant({ ownerId, machineId, terminalId, granteeAccountId: viewerId, role: 'viewer' });
        expect(pending.status).toBe('pending');
        // Default viewer expiry is 7 days.
        expect(Math.round((pending.expiresAt - Date.now()) / 86_400_000)).toBe(7);
        const key = await streamKeyOf(pending.id, viewerSecret);
        expect(await rpc(viewerId, pending.id, 'attach', {}, key)).toEqual({ ok: false, error: 'not_shared' });
        expect(daemonCalls).toHaveLength(0);
        await store.respondToTerminalGrant(viewerId, pending.id, true);
        expect((await store.listIncomingTerminalShares(viewerId))[0]).toMatchObject({ id: pending.id, status: 'active', role: 'viewer', title: 'build', cwd: 'repo', alive: true, viewOnlySupported: true });
        // A stranger cannot use someone else's grant id.
        expect(await rpc(strangerId, pending.id, 'attach', {}, key)).toEqual({ ok: false, error: 'not_shared' });
        await store.revokeTerminalGrant(ownerId, pending.id);
    });

    it('viewer attach is view-only at the OWNER\'s pane size, whatever the viewer asks; result only opens with the stream key', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        const ack = await rpc(viewerId, grant.id, 'attach', { terminalId: 'someone-elses', cols: 30, rows: 10, startupCommand: 'rm -rf /', attachTmux: { id: '$1', name: 'x' } }, key);
        expect(ack.ok).toBe(true);
        expect(daemonCalls).toEqual([{ method: 'open-terminal', params: { terminalId, encStream: true, attachOnly: true, shareGrantId: grant.id, viewOnly: true, cols: 132, rows: 40 } }]);
        const result = openWith((ack as any).result, key) as any;
        expect(result).toMatchObject({ terminalId, role: 'viewer', viewOnly: true, geometry: { cols: 132, rows: 40 }, encStream: false });
        expect(Buffer.from(result.data, 'base64').toString()).toBe(`${SECRET_MARK} screen`);
        expect(openWith((ack as any).result, machineKey)).toBeNull();
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('a daemon without terminalViewOnly is refused for viewers BEFORE anything reaches it (it would resize the pane)', async () => {
        await setDaemonState(baseState({ terminalViewOnly: undefined }));
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        expect(await rpc(viewerId, grant.id, 'attach', { cols: 30, rows: 10 }, key)).toEqual({ ok: false, error: 'cli_upgrade_required' });
        // A flag from a previous daemon run (detectedAt < startedAt) does not count either.
        await setDaemonState(baseState({ startedAt: 5000, terminalViewOnly: { rpcAvailable: true, detectedAt: 4000 }, webTerminals: { updatedAt: 6000, terminals: [{ id: terminalId, paneCols: 132, paneRows: 40 }] } }));
        expect(await rpc(viewerId, grant.id, 'attach', {}, key)).toEqual({ ok: false, error: 'cli_upgrade_required' });
        expect(daemonCalls).toHaveLength(0);
        await setDaemonState(baseState());
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('viewer: no input, resize, scroll or paste reach the daemon; history is allowed; close only unsubscribes', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        await rpc(viewerId, grant.id, 'attach', {}, key);
        emitted.length = 0; daemonCalls.length = 0;
        expect(await rpc(viewerId, grant.id, 'scroll', { lines: -10 }, key)).toEqual({ ok: false, error: 'share_method_denied' });
        expect(await rpc(viewerId, grant.id, 'paste', { text: 'echo hi\r' }, key)).toEqual({ ok: false, error: 'share_method_denied' });
        for (const op of ['kill', 'open', 'list']) expect(await rpc(viewerId, grant.id, op, {}, key)).toEqual({ ok: false, error: 'share_method_denied' });
        await broker.__forwardTerminalEventForTests(viewerId, 'input', { grantId: grant.id, data: Buffer.from(crypto.encryptWithDataKey(Buffer.from('ls\r').toString('base64'), key)).toString('base64') });
        await broker.__forwardTerminalEventForTests(viewerId, 'resize', { grantId: grant.id, cols: 30, rows: 10 });
        expect(emitted.filter((e) => e.room === `user:${ownerId}:machine:${machineId}`)).toHaveLength(0);
        expect(daemonCalls).toHaveLength(0);
        expect((await rpc(viewerId, grant.id, 'history', { snapshotId: 's1', page: 0 }, key)).ok).toBe(true);
        expect(daemonCalls).toEqual([{ method: 'terminal-history', params: { terminalId, snapshotId: 's1', page: 0 } }]);
        await broker.__forwardTerminalEventForTests(viewerId, 'close', { grantId: grant.id });
        expect(emitted).toContainEqual({ room: `user:${ownerId}:machine:${machineId}`, event: 'terminal-close', payload: { terminalId } });
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('live output of the shared terminal is re-keyed to the grantee; other terminals are never tapped', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        await rpc(viewerId, grant.id, 'attach', {}, key);
        await broker.__refreshTerminalShareIndexForTests();
        emitted.length = 0;
        const frame = (id: string, seq: number) => ({ terminalId: id, seq, enc: true, data: sealMachine(Buffer.from(`${SECRET_MARK} out ${seq}`).toString('base64')) });
        broker.terminalShareTap(ownerId, machineId, 'terminal-output', frame('other-term', 1));
        broker.terminalShareTap(ownerId, machineId, 'terminal-output', frame(terminalId, 7));
        await vi.waitFor(() => expect(emitted.some((e) => e.event === 'share-terminal-output')).toBe(true));
        const outs = emitted.filter((e) => e.event === 'share-terminal-output');
        expect(outs).toHaveLength(1);
        expect(outs[0].room).toBe(room(viewerId));
        expect(outs[0].payload.grantId).toBe(grant.id);
        expect(Buffer.from(openWith(outs[0].payload.data, key) as string, 'base64').toString()).toBe(`${SECRET_MARK} out 7`);
        expect(openWith(outs[0].payload.data, machineKey)).toBeNull();
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('operator: input is re-sealed with the machine key, resize / paste / scroll pass, no kill, own size on attach', async () => {
        const grant = await share(operatorId, 'operator');
        expect(Math.round((grant.expiresAt - Date.now()) / 86_400_000)).toBe(1);
        const key = await streamKeyOf(grant.id, operatorSecret);
        expect((await rpc(operatorId, grant.id, 'attach', { cols: 100, rows: 30 }, key)).ok).toBe(true);
        expect(daemonCalls[0]).toEqual({ method: 'open-terminal', params: { terminalId, encStream: true, attachOnly: true, shareGrantId: grant.id, cols: 100, rows: 30 } });
        emitted.length = 0;
        await broker.__forwardTerminalEventForTests(operatorId, 'input', { grantId: grant.id, data: Buffer.from(crypto.encryptWithDataKey(Buffer.from('echo hi\r').toString('base64'), key)).toString('base64') });
        const input = emitted.find((e) => e.event === 'terminal-input')!;
        expect(input.room).toBe(`user:${ownerId}:machine:${machineId}`);
        expect(input.payload).toMatchObject({ terminalId, enc: true, shareGrantId: grant.id });
        expect(Buffer.from(openWith(input.payload.data, machineKey) as string, 'base64').toString()).toBe('echo hi\r');
        await broker.__forwardTerminalEventForTests(operatorId, 'resize', { grantId: grant.id, cols: 90, rows: 20 });
        expect(emitted).toContainEqual({ room: `user:${ownerId}:machine:${machineId}`, event: 'terminal-resize', payload: { terminalId, cols: 90, rows: 20, shareGrantId: grant.id } });
        expect((await rpc(operatorId, grant.id, 'paste', { text: 'pwd' }, key)).ok).toBe(true);
        expect((await rpc(operatorId, grant.id, 'scroll', { lines: -5 }, key)).ok).toBe(true);
        expect(await rpc(operatorId, grant.id, 'kill', {}, key)).toEqual({ ok: false, error: 'share_method_denied' });
        expect(daemonCalls.map((c) => c.method)).not.toContain('kill-terminal');
        await broker.__flushTerminalShareInputForTests();
        const inputEvent = await db.shareAuditEvent.findFirst({ where: { grantId: grant.id, kind: 'terminal.input' } });
        expect(inputEvent?.detail).toEqual({ bytes: 8, enters: 1 });
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('revoke: grantee told at once, stream and input stop, daemon subscriptions released, the terminal is NOT killed', async () => {
        const grant = await share(operatorId, 'operator');
        const key = await streamKeyOf(grant.id, operatorSecret);
        await rpc(operatorId, grant.id, 'attach', {}, key);
        await rpc(operatorId, grant.id, 'attach', {}, key); // second pane: 2 subscriptions
        await broker.__refreshTerminalShareIndexForTests();
        emitted.length = 0; daemonCalls.length = 0;
        const started = Date.now();
        await store.revokeTerminalGrant(ownerId, grant.id);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(emitted).toContainEqual({ room: room(operatorId), event: 'share-terminal-revoked', payload: { grantId: grant.id, reason: 'revoked' } });
        expect(emitted.filter((e) => e.event === 'terminal-close' && e.room === `user:${ownerId}:machine:${machineId}`)).toHaveLength(2);
        expect(daemonCalls).toHaveLength(0); // no kill-terminal, nothing
        emitted.length = 0;
        broker.terminalShareTap(ownerId, machineId, 'terminal-output', { terminalId, seq: 9, enc: true, data: sealMachine('eA==') });
        await broker.__forwardTerminalEventForTests(operatorId, 'input', { grantId: grant.id, data: Buffer.from(crypto.encryptWithDataKey('eA==', key)).toString('base64') });
        await new Promise((r) => setTimeout(r, 50));
        // (the owner's "stopped watching" activity notice may still land; no bytes either way)
        expect(emitted.filter((e) => e.event !== 'terminal-share-activity')).toEqual([]);
        expect(await rpc(operatorId, grant.id, 'attach', {}, key)).toEqual({ ok: false, error: 'not_shared' });
        expect(audited.some((a) => a.kind === 'terminal.share.ended')).toBe(true);
    });

    it('expiry ends an attached grant through the sweep within a tick', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        await rpc(viewerId, grant.id, 'attach', {}, key);
        await db.terminalGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        emitted.length = 0;
        await broker.sweepTerminalShares();
        expect(emitted).toContainEqual({ room: room(viewerId), event: 'share-terminal-revoked', payload: { grantId: grant.id, reason: 'expired' } });
        expect(await rpc(viewerId, grant.id, 'attach', {}, key)).toEqual({ ok: false, error: 'not_shared' });
    });

    it('owner closes the terminal → viewers get exit; a new pane size → viewers get geometry', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        await rpc(viewerId, grant.id, 'attach', {}, key);
        await broker.__refreshTerminalShareIndexForTests();
        emitted.length = 0;
        await broker.noteTerminalShareMachineState(ownerId, machineId, sealMachine(baseState({}, [{ id: terminalId, title: 'build', cwd: '/x', paneCols: 150, paneRows: 50 }])));
        expect(emitted).toContainEqual({ room: room(viewerId), event: 'share-terminal-geometry', payload: { grantId: grant.id, cols: 150, rows: 50 } });
        // The attachment is young (grace window): pretend it is older.
        await db.shareTerminalAttachment.updateMany({ where: { grantId: grant.id }, data: { openedAt: new Date(Date.now() - 60_000) } });
        await broker.__refreshTerminalShareIndexForTests();
        emitted.length = 0;
        await broker.noteTerminalShareMachineState(ownerId, machineId, sealMachine(baseState({}, [])));
        expect(emitted).toContainEqual({ room: room(viewerId), event: 'share-terminal-exit', payload: { grantId: grant.id, exitCode: -1, reason: 'closed_on_machine' } });
        // The grant itself survives (a restore with the same id brings access back).
        expect((await db.terminalGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe('active');
        await store.revokeTerminalGrant(ownerId, grant.id);
    });

    it('downgrading operator → viewer ends the operator panes; leaving ends the grant', async () => {
        const grant = await share(operatorId, 'operator');
        const key = await streamKeyOf(grant.id, operatorSecret);
        await rpc(operatorId, grant.id, 'attach', {}, key);
        emitted.length = 0;
        await store.updateTerminalGrant(ownerId, grant.id, { role: 'viewer', expiresInDays: 7 });
        expect(emitted).toContainEqual({ room: room(operatorId), event: 'share-terminal-revoked', payload: { grantId: grant.id, reason: 'downgraded' } });
        await broker.__forwardTerminalEventForTests(operatorId, 'input', { grantId: grant.id, data: Buffer.from(crypto.encryptWithDataKey('eA==', key)).toString('base64') });
        expect(emitted.some((e) => e.event === 'terminal-input')).toBe(false);
        // Raising back needs confirmation again.
        await expect(store.updateTerminalGrant(ownerId, grant.id, { role: 'operator' })).rejects.toMatchObject({ code: 'operator_requires_confirm' });
        await store.respondToTerminalGrant(operatorId, grant.id, false);
        expect((await db.terminalGrant.findUniqueOrThrow({ where: { id: grant.id } })).endedReason).toBe('left');
        expect(await store.listIncomingTerminalShares(operatorId)).toEqual([]);
    });

    it('re-share after a revoke: a new stream key, and the server seals with the new one (no stale cache)', async () => {
        const first = await share(viewerId, 'viewer');
        const oldKey = await streamKeyOf(first.id, viewerSecret);
        expect((await rpc(viewerId, first.id, 'attach', {}, oldKey)).ok).toBe(true); // server caches the key
        await store.revokeTerminalGrant(ownerId, first.id);
        const again = await share(viewerId, 'viewer');
        expect(again.id).toBe(first.id); // same row
        const newKey = await streamKeyOf(again.id, viewerSecret);
        expect(Buffer.from(newKey).equals(Buffer.from(oldKey))).toBe(false);
        expect(await rpc(viewerId, again.id, 'attach', {}, oldKey)).toEqual({ ok: false, error: 'bad_params' });
        const ack = await rpc(viewerId, again.id, 'attach', {}, newKey);
        expect(ack.ok).toBe(true);
        expect((openWith((ack as any).result, newKey) as any).terminalId).toBe(terminalId);
        await store.revokeTerminalGrant(ownerId, again.id);
    });

    it('a dropped socket releases the subscriptions it held; a revoked grant releases nothing twice', async () => {
        const grant = await share(viewerId, 'viewer');
        const key = await streamKeyOf(grant.id, viewerSecret);
        const held = new Map<string, number>();
        const onSubscribed = (id: string) => held.set(id, (held.get(id) ?? 0) + 1);
        const seal = (v: unknown) => Buffer.from(crypto.encryptWithDataKey(v, key)).toString('base64');
        await broker.handleTerminalShareRpc(io, viewerId, { grantId: grant.id, op: 'attach', params: seal({}) }, {}, onSubscribed);
        await broker.handleTerminalShareRpc(io, viewerId, { grantId: grant.id, op: 'attach', params: seal({}) }, {}, onSubscribed);
        await broker.handleTerminalShareRpc(io, viewerId, { grantId: grant.id, op: 'attach', params: seal({ resub: true }) }, {}, onSubscribed);
        expect(held.get(grant.id)).toBe(2); // a catch-up holds no new subscription
        emitted.length = 0;
        await broker.releaseHeldSubscriptions(viewerId, held);
        expect(emitted.filter((e) => e.event === 'terminal-close')).toHaveLength(2);
        const row = await db.shareTerminalAttachment.findFirstOrThrow({ where: { grantId: grant.id } });
        expect(row).toMatchObject({ subscribers: 0, closeReason: 'detached' });
        expect(row.closedAt).not.toBeNull();
        emitted.length = 0;
        await store.revokeTerminalGrant(ownerId, grant.id);
        expect(emitted.filter((e) => e.event === 'terminal-close')).toHaveLength(0);
    });

    it('real routes: create → incoming → accept → events → revoke; strict bodies; viewer has no "forever"', async () => {
        const fastify = (await import('fastify')).default;
        const { serializerCompiler, validatorCompiler } = await import('fastify-type-provider-zod');
        const { terminalShareRoutes } = await import('@/app/api/routes/terminalShareRoutes');
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: any) => { request.userId = request.headers['x-user']; });
        terminalShareRoutes(app as any);
        await app.ready();
        const as = (userId: string) => ({ 'x-user': userId });
        const bad = await app.inject({ method: 'POST', url: '/v1/terminal-shares', headers: as(ownerId), payload: { machineId, terminalId, accountId: viewerId, role: 'viewer', expiresInDays: null } });
        expect(bad.statusCode).toBe(400);
        const extra = await app.inject({ method: 'POST', url: '/v1/terminal-shares', headers: as(ownerId), payload: { machineId, terminalId, accountId: viewerId, role: 'viewer', startupCommand: 'x' } });
        expect(extra.statusCode).toBe(400);
        const noConfirm = await app.inject({ method: 'POST', url: '/v1/terminal-shares', headers: as(ownerId), payload: { machineId, terminalId, accountId: operatorId, role: 'operator' } });
        expect(noConfirm.json()).toEqual({ error: 'operator_requires_confirm' });
        const created = await app.inject({ method: 'POST', url: '/v1/terminal-shares', headers: as(ownerId), payload: { machineId, terminalId, target: 'vera', role: 'viewer', expiresInDays: 1, title: 'build' } });
        expect(created.statusCode).toBe(200);
        const grantId = created.json().grant.id;
        expect((await app.inject({ method: 'GET', url: `/v1/terminal-shares?machineId=${machineId}&terminalId=${terminalId}`, headers: as(ownerId) })).json().grants.map((g: any) => g.id)).toEqual([grantId]);
        expect((await app.inject({ method: 'GET', url: `/v1/terminal-shares?machineId=${machineId}&terminalId=${terminalId}`, headers: as(strangerId) })).json().grants).toEqual([]);
        const incoming = (await app.inject({ method: 'GET', url: '/v1/terminal-shares/incoming', headers: as(viewerId) })).json().shares;
        expect(incoming[0]).toMatchObject({ id: grantId, status: 'pending', role: 'viewer', title: 'build' });
        expect(typeof incoming[0].granteeKey).toBe('string');
        expect((await app.inject({ method: 'POST', url: `/v1/terminal-shares/${grantId}/respond`, headers: as(strangerId), payload: { accept: true } })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: `/v1/terminal-shares/${grantId}/respond`, headers: as(viewerId), payload: { accept: true } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: `/v1/terminal-shares/${grantId}/events`, headers: as(viewerId) })).statusCode).toBe(404);
        const events = (await app.inject({ method: 'GET', url: `/v1/terminal-shares/${grantId}/events`, headers: as(ownerId) })).json().events.map((e: any) => e.kind);
        expect(events).toEqual(expect.arrayContaining(['grant.create', 'grant.accept']));
        expect((await app.inject({ method: 'GET', url: '/v1/terminal-shares/outgoing', headers: as(ownerId) })).json().grants.some((g: any) => g.id === grantId)).toBe(true);
        expect((await app.inject({ method: 'DELETE', url: `/v1/terminal-shares/${grantId}`, headers: as(strangerId) })).statusCode).toBe(404);
        expect((await app.inject({ method: 'DELETE', url: `/v1/terminal-shares/${grantId}`, headers: as(ownerId) })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/v1/terminal-shares/incoming', headers: as(viewerId) })).json().shares).toEqual([]);
        await app.close();
    });

    it('no terminal bytes, keystrokes or titles in any log line or business audit', () => {
        const text = JSON.stringify(logged) + JSON.stringify(audited);
        expect(text).not.toContain(SECRET_MARK);
        expect(text).not.toContain('echo hi');
        expect(text).not.toContain(Buffer.from('echo hi\r').toString('base64'));
    });
});
