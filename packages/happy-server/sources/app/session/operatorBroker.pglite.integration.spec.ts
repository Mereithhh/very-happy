import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as Shares from './sessionShares';
import type * as Broker from './operatorBroker';
import type * as Crypto from './sessionCrypto';

const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));
vi.mock('@/utils/log', () => ({ log: (...args: unknown[]) => { logged.push(args); }, warn: (...args: unknown[]) => { logged.push(args); } }));
const { emitUpdate, emitToRooms } = vi.hoisted(() => ({ emitUpdate: vi.fn(), emitToRooms: vi.fn() }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return { ...actual, eventRouter: { emitUpdate, emitToRooms, setSessionFanout: vi.fn() } };
});

/**
 * B-867 end-to-end through the broker with REAL account secrets, a REAL
 * session DEK and a REAL machine key, against a fake owner daemon that
 * decrypts what it is sent exactly like the CLI does. Proves: who can call,
 * what the daemon actually receives (rewrites), that the operator only ever
 * sees DEK ciphertext, that revoke kills and stops the stream, and that no
 * plaintext reaches a log line.
 */
describe('B-867 operator broker (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/session-share-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'operator-'));
    let db: PrismaClient; let shares: typeof Shares; let broker: typeof Broker; let crypto: typeof Crypto;
    let ownerId: string; let granteeId: string; let driverId: string; let sessionId: string;
    let dek: Uint8Array; let machineKey: Uint8Array;
    const machineId = 'machine-owner-1';
    const SECRET_MARK = 'PLAINTEXT-MARK-7f3a';
    const metadataPlain = { path: '/home/owner/repo', host: 'owner-box', machineId, permissionMode: 'default', terminalId: 'sess-term', summary: { text: 'Fix it' } };

    // ---- fake io + owner daemon
    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const daemonCalls: Array<{ method: string; params: any }> = [];
    let daemonDown = false;
    const daemonSocket = {
        id: 'daemon-socket', data: {}, handshake: { issued: 1 },
        timeout: () => ({
            emitWithAck: async (_event: string, req: { method: string; params: string }) => {
                if (daemonDown) throw new Error('operation has timed out');
                const isMachine = req.method.startsWith(`${machineId}:`);
                const key = isMachine ? machineKey : dek;
                const params = crypto.decryptWithDataKey(new Uint8Array(Buffer.from(req.params, 'base64')), key) as any;
                const method = req.method.slice(req.method.indexOf(':') + 1);
                daemonCalls.push({ method, params });
                let result: unknown = { ok: true };
                // Mode side effects exactly as the CLI applies them (permissionHandler.ts):
                // set-permission-mode switches; an approved ExitPlanMode without a
                // post-plan mode falls back to bypassPermissions.
                if (method === 'set-permission-mode') await setMode(params.mode);
                if (method === 'permission' && params.approved === true) {
                    if (pendingTools[params.id] === 'ExitPlanMode') await setMode(['default', 'acceptEdits', 'bypassPermissions'].includes(params.mode) ? params.mode : 'bypassPermissions');
                    else if (params.mode) await setMode(params.mode);
                }
                if (method === 'open-terminal') {
                    const screen = Buffer.from(`${SECRET_MARK} screen`).toString('base64');
                    result = { type: 'success', terminalId: params.terminalId, mode: 'snapshot', data: params.encStream ? Buffer.from(crypto.encryptWithDataKey(screen, machineKey)).toString('base64') : screen, encStream: !!params.encStream };
                } else if (method === 'kill-terminal') {
                    result = { type: 'success' };
                }
                return Buffer.from(crypto.encryptWithDataKey(result, key)).toString('base64');
            },
        }),
    };
    const io: any = {
        // "Down" = the socket is still listed but never acks (what a dead daemon looks like until presence drops).
        in: (room: string) => ({ timeout: () => ({ fetchSockets: async () => (room.startsWith(`rpc:${ownerId}:`) ? [daemonSocket] : []) }) }),
        to: (room: string) => ({ emit: (event: string, payload: any) => { emitted.push({ room, event, payload }); } }),
        on: () => undefined,
        serverSideEmit: () => undefined,
    };
    let pendingTools: Record<string, string> = {};
    async function setMode(mode: string) {
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        const plain = openWith(session.metadata, dek) as Record<string, unknown>;
        await db.session.update({ where: { id: sessionId }, data: { metadata: sealDek({ ...plain, permissionMode: mode }) } });
    }
    async function currentMode() {
        return (openWith((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).metadata, dek) as any).permissionMode;
    }
    async function setPendingRequests(tools: Record<string, string>) {
        pendingTools = tools;
        const requests = Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, { tool, arguments: {}, createdAt: Date.now() }]));
        await db.session.update({ where: { id: sessionId }, data: { agentState: sealDek({ requests }) } });
    }
    const operatorCap = async () => (await db.sessionGrant.findFirstOrThrow({ where: { sessionId, granteeAccountId: granteeId } })).operateModeCap;
    /** Owner's own client changing the mode: what rpcHandler hands the broker after a routed rpc-call. */
    const ownerRpc = (method: string, params: unknown) => broker.noteOwnerModeRpc(ownerId, `${sessionId}:${method}`, sealDek(params));
    const granteeRoom = () => `user:${granteeId}:user-scoped`;
    const sealDek = (v: unknown) => Buffer.from(crypto.encryptWithDataKey(v, dek)).toString('base64');
    const openWith = (v: string, key: Uint8Array) => crypto.decryptWithDataKey(new Uint8Array(Buffer.from(v, 'base64')), key);
    const rpc = (userId: string, op: string, params?: unknown) => broker.handleOperatorRpc(io, userId, { sessionId, op, params: params === undefined ? undefined : sealDek(params) });

    async function createAccount(username: string) {
        const secretBytes = randomBytes(32);
        const account = await db.account.create({ data: { publicKey: randomBytes(16).toString('hex'), username, firstName: username } });
        const { upsertAccountSecret } = await import('@/app/auth/accountSecrets');
        await upsertAccountSecret(db, account.id, secretBytes.toString('base64url'));
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerSubject: `${username}@example.com`, email: `${username}@example.com` } });
        return { id: account.id, secret: new Uint8Array(secretBytes) };
    }

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'operator-integration-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        await (await import('@/modules/encrypt')).initEncrypt();
        ({ db } = await import('@/storage/db'));
        shares = await import('./sessionShares');
        broker = await import('./operatorBroker');
        crypto = await import('./sessionCrypto');
        broker.__setOperatorIoForTests(io);
        const owner = await createAccount('owner');
        ownerId = owner.id;
        granteeId = (await createAccount('opal')).id;
        driverId = (await createAccount('drew')).id;
        const ownerKeys = crypto.contentKeyPairFromSecret(owner.secret);
        dek = new Uint8Array(randomBytes(32));
        machineKey = new Uint8Array(randomBytes(32));
        await db.machine.create({ data: { id: machineId, accountId: ownerId, metadata: 'x', dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(machineKey, ownerKeys.publicKey)) } });
        sessionId = (await db.session.create({ data: {
            accountId: ownerId, tag: randomBytes(8).toString('hex'),
            metadata: Buffer.from(crypto.encryptWithDataKey(metadataPlain, dek)).toString('base64'),
            dataEncryptionKey: Buffer.from(crypto.wrapDataEncryptionKey(dek, ownerKeys.publicKey)),
        } })).id;
        const driverGrant = await shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: driverId, role: 'driver' });
        await shares.respondToSessionGrant(driverId, driverGrant.id, true);
    }, 60000);
    afterAll(async () => { broker.__setOperatorIoForTests(null); await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });
    beforeEach(() => { emitted.length = 0; daemonCalls.length = 0; daemonDown = false; });

    it('granting operate needs driver + explicit confirmation + a finite expiry', async () => {
        await expect(shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: granteeId, role: 'driver', operate: true, expiresInDays: 1 })).rejects.toMatchObject({ code: 'operator_requires_confirm' });
        await expect(shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: granteeId, role: 'viewer', operate: true, confirmOperator: true, expiresInDays: 1 })).rejects.toMatchObject({ code: 'operator_requires_driver' });
        await expect(shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: granteeId, role: 'driver', operate: true, confirmOperator: true, expiresInDays: null })).rejects.toMatchObject({ code: 'operator_requires_expiry' });
        const view = await shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: granteeId, role: 'driver', operate: true, confirmOperator: true, expiresInDays: 1 });
        expect(view).toMatchObject({ role: 'driver', operate: true, status: 'pending' });
        // The cap is the owner's effective mode at grant time.
        expect(await operatorCap()).toBe('default');
        // Pending is not operating.
        expect(await rpc(granteeId, 'abort', {})).toEqual({ ok: false, error: 'not_operator' });
        await shares.respondToSessionGrant(granteeId, view.id, true);
        // Old webs read role only: it is still 'driver'.
        const rows = await shares.listSharedSessionRows(granteeId, { id: true });
        expect(rows[0].share).toMatchObject({ role: 'driver', operate: true });
    });

    it('a plain driver, a stranger or a link holder gets nothing; nothing reaches the daemon (machine-key gate: operatorBroker.source.spec.ts)', async () => {
        expect(await rpc(driverId, 'terminal.open', { cols: 80, rows: 24 })).toEqual({ ok: false, error: 'not_operator' });
        expect(await rpc(ownerId, 'terminal.open', { cols: 80, rows: 24 })).toEqual({ ok: false, error: 'not_operator' });
        expect(await rpc('no-such-account', 'abort', {})).toEqual({ ok: false, error: 'not_operator' });
        expect(daemonCalls).toEqual([]);
    });

    it('session RPCs: allowlist, allowTools stripped, mode cap, path fence; result is the daemon\'s DEK ciphertext', async () => {
        expect(await rpc(granteeId, 'killSession', {})).toEqual({ ok: false, error: 'operator_method_denied' });
        expect(await rpc(granteeId, 'permission', { id: 'p1', approved: true, mode: 'bypassPermissions' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        expect(await rpc(granteeId, 'readFile', { path: '/home/owner/.happy/accounts/a/secret' })).toEqual({ ok: false, error: 'operator_path_denied' });
        expect(daemonCalls).toEqual([]);
        await setPendingRequests({ p1: 'Bash' });
        const ack = await rpc(granteeId, 'permission', { id: 'p1', approved: true, allowTools: ['Bash(*)'] });
        expect(ack.ok).toBe(true);
        expect(daemonCalls).toEqual([{ method: 'permission', params: { id: 'p1', approved: true } }]);
        expect(openWith((ack as any).result, dek)).toEqual({ ok: true });
        const events = await broker.listOperatorEvents(sessionId, granteeId, 10);
        expect(events.map((e) => e.kind)).toContain('permission');
    });

    it('B-867b QA40 chain: plan → approve ExitPlanMode without mode → bypass is closed; cap never floats with the operator', async () => {
        expect(await currentMode()).toBe('default');
        // 1. Lowering is allowed.
        expect((await rpc(granteeId, 'set-permission-mode', { mode: 'plan' })).ok).toBe(true);
        expect(await currentMode()).toBe('plan');
        // 2–3. The agent asks ExitPlanMode; the operator approves WITHOUT a mode:
        // the broker injects the highest post-plan mode within the cap.
        await setPendingRequests({ exit1: 'ExitPlanMode' });
        expect((await rpc(granteeId, 'permission', { id: 'exit1', approved: true })).ok).toBe(true);
        expect(daemonCalls.at(-1)).toEqual({ method: 'permission', params: { id: 'exit1', approved: true, mode: 'default' } });
        expect(await currentMode()).toBe('default');
        // A non post-plan mode on a plan approval (the CLI would read it as bypass) is rewritten too.
        await setMode('plan');
        expect((await rpc(granteeId, 'permission', { id: 'exit1', approved: true, mode: 'yolo' })).ok).toBe(true);
        expect(daemonCalls.at(-1)?.params.mode).toBe('default');
        // An explicit escalation on the plan card is refused.
        expect(await rpc(granteeId, 'permission', { id: 'exit1', approved: true, mode: 'bypassPermissions' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        // An unknown request id is treated as a plan approval (fail closed).
        await setPendingRequests({});
        expect((await rpc(granteeId, 'permission', { id: 'ghost', approved: true })).ok).toBe(true);
        expect(daemonCalls.at(-1)?.params).toEqual({ id: 'ghost', approved: true, mode: 'default' });
        // 4. The cap did not float: bypass / acceptEdits still refused.
        expect(await rpc(granteeId, 'set-permission-mode', { mode: 'bypassPermissions' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        expect(await rpc(granteeId, 'set-permission-mode', { mode: 'acceptEdits' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        // Session-wide approvals are narrowed to a single approval.
        await setPendingRequests({ p2: 'Edit' });
        expect((await rpc(granteeId, 'permission', { id: 'p2', approved: true, decision: 'approved_for_session', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] })).ok).toBe(true);
        expect(daemonCalls.at(-1)?.params).toEqual({ id: 'p2', approved: true, decision: 'approved' });
        expect(await operatorCap()).toBe('default');
    });

    it('B-867b: down then up stops at the cap; only the owner\'s own mode RPCs move it', async () => {
        expect((await rpc(granteeId, 'set-permission-mode', { mode: 'plan' })).ok).toBe(true);
        expect((await rpc(granteeId, 'set-permission-mode', { mode: 'default' })).ok).toBe(true);
        expect(await rpc(granteeId, 'set-permission-mode', { mode: 'acceptEdits' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        // The owner raises it from their own client: the cap follows.
        emitUpdate.mockClear();
        await ownerRpc('set-permission-mode', { mode: 'bypassPermissions' });
        await setMode('bypassPermissions');
        expect(await operatorCap()).toBe('bypassPermissions');
        // The operator re-reads its row (mode menu follows the cap); the row carries the cap.
        expect(JSON.stringify(emitUpdate.mock.calls)).toContain('session-share-updated');
        expect((await shares.listSharedSessionRows(granteeId, { id: true }))[0].share.modeCap).toBe('bypassPermissions');
        // Same mode again: no write, no event.
        emitUpdate.mockClear();
        await ownerRpc('set-permission-mode', { mode: 'bypassPermissions' });
        expect(emitUpdate).not.toHaveBeenCalled();
        await setPendingRequests({ exit2: 'ExitPlanMode' });
        expect((await rpc(granteeId, 'permission', { id: 'exit2', approved: true })).ok).toBe(true);
        expect(daemonCalls.at(-1)?.params.mode).toBe('bypassPermissions');
        // The owner lowers it (plan-card approval with a mode counts too); a rejected one does not.
        await ownerRpc('permission', { id: 'exit2', approved: false, mode: 'bypassPermissions' });
        expect(await operatorCap()).toBe('bypassPermissions');
        await ownerRpc('permission', { id: 'exit2', approved: true, mode: 'acceptEdits' });
        expect(await operatorCap()).toBe('acceptEdits');
        await ownerRpc('set-permission-mode', { mode: 'plan' });
        expect(await operatorCap()).toBe('plan');
        // Cap plan: no plan approval at all, no way back up.
        await setPendingRequests({ exit3: 'ExitPlanMode' });
        expect(await rpc(granteeId, 'permission', { id: 'exit3', approved: true })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        expect((await rpc(granteeId, 'permission', { id: 'exit3', approved: false })).ok).toBe(true);
        expect(await rpc(granteeId, 'set-permission-mode', { mode: 'default' })).toEqual({ ok: false, error: 'operator_mode_escalation' });
        // Restore for the tests below.
        await ownerRpc('set-permission-mode', { mode: 'default' });
        await setMode('default');
        expect(await operatorCap()).toBe('default');
    });

    it('terminal.open: forced cwd + encStream; operator sees only DEK ciphertext; live output is re-keyed; owner terminals are not tapped', async () => {
        const ack = await rpc(granteeId, 'terminal.open', { cols: 90, rows: 20, cwd: '/', startupCommand: `echo ${SECRET_MARK}` });
        expect(ack.ok).toBe(true);
        const open = daemonCalls.find((c) => c.method === 'open-terminal')!;
        expect(open.params).toMatchObject({ cols: 90, rows: 20, cwd: '/home/owner/repo', encStream: true });
        expect(open.params.startupCommand).toBeUndefined();
        const terminalId = open.params.terminalId as string;
        expect(terminalId).toMatch(/^op-[0-9a-f]{12}$/);
        const result = openWith((ack as any).result, dek) as any;
        expect(result).toMatchObject({ type: 'success', terminalId, encStream: false });
        expect(Buffer.from(result.data, 'base64').toString()).toBe(`${SECRET_MARK} screen`);
        // The owner's terminal list shows it tagged as shared.
        await vi.waitFor(() => expect(daemonCalls.map((c) => c.method)).toEqual(expect.arrayContaining(['set-terminal-title', 'set-terminal-tags'])));

        // Live output: machine-key frame in → DEK frame out, to the operator only.
        emitted.length = 0;
        const bytes = Buffer.from(`${SECRET_MARK} live`).toString('base64');
        broker.operatorTerminalTap(ownerId, machineId, 'terminal-output', { terminalId, seq: 5, enc: true, data: Buffer.from(crypto.encryptWithDataKey(bytes, machineKey)).toString('base64') });
        broker.operatorTerminalTap(ownerId, machineId, 'terminal-output', { terminalId: 'owner-private', seq: 1, enc: true, data: 'x' });
        await vi.waitFor(() => expect(emitted.filter((e) => e.event === 'operator-terminal-output')).toHaveLength(1));
        const frame = emitted.find((e) => e.event === 'operator-terminal-output')!;
        expect(frame.room).toBe(granteeRoom());
        expect(frame.payload).toMatchObject({ sessionId, terminalId, seq: 5 });
        expect(openWith(frame.payload.data, dek)).toBe(bytes);
        expect(openWith(frame.payload.data, machineKey)).toBeNull();
        expect(emitted.some((e) => e.payload?.terminalId === 'owner-private')).toBe(false);

        // Input: DEK in → machine key out, to the owner's machine room.
        emitted.length = 0;
        const handlers = new Map<string, (data: unknown) => void>();
        broker.operatorHandler(granteeId, { on: (event: string, fn: any) => handlers.set(event, fn), nsp: { server: io } } as any, { connectionType: 'user-scoped' }, {});
        const keys = Buffer.from(`ls ${SECRET_MARK}\r`).toString('base64');
        handlers.get('operator-terminal-input')!({ sessionId, terminalId, data: sealDek(keys) });
        await vi.waitFor(() => expect(emitted.some((e) => e.event === 'terminal-input')).toBe(true));
        const input = emitted.find((e) => e.event === 'terminal-input')!;
        expect(input.room).toBe(`user:${ownerId}:machine:${machineId}`);
        expect(input.payload.enc).toBe(true);
        expect(openWith(input.payload.data, machineKey)).toBe(keys);
        // Someone else's terminal id: dropped.
        emitted.length = 0;
        handlers.get('operator-terminal-input')!({ sessionId, terminalId: 'owner-private', data: sealDek(keys) });
        await new Promise((r) => setTimeout(r, 50));
        expect(emitted).toEqual([]);

        await broker.__flushOperatorInputForTests();
        const inputEvent = (await broker.listOperatorEvents(sessionId, granteeId, 50)).find((e) => e.kind === 'terminal.input')!;
        expect(inputEvent.detail).toEqual({ bytes: Buffer.from(keys, 'base64').length, enters: 1 });
        expect(JSON.stringify(inputEvent)).not.toContain(SECRET_MARK);
    });

    it('attach to the session\'s own terminal by role; it is detached, never killed, on teardown', async () => {
        const ack = await rpc(granteeId, 'terminal.attach', { session: true, cols: 80, rows: 24 });
        expect(ack.ok).toBe(true);
        expect(daemonCalls.find((c) => c.method === 'open-terminal')!.params).toMatchObject({ terminalId: 'sess-term', attachOnly: true, encStream: true });
        const list = openWith((await rpc(granteeId, 'terminal.list', {}) as any).result, dek) as any;
        expect(list.sessionTerminal).toBe(true);
        expect(list.terminals.map((t: any) => t.kind).sort()).toEqual(['attached', 'opened']);
        expect(await rpc(granteeId, 'terminal.kill', { terminalId: 'sess-term' })).toEqual({ ok: false, error: 'operator_terminal_denied' });
    });

    it('revoke: operator told first, opened terminal killed, attached one detached, stream and input stop, calls refused', async () => {
        const opened = await db.sessionOperatorTerminal.findFirstOrThrow({ where: { granteeAccountId: granteeId, kind: 'opened', closedAt: null } });
        await shares.revokeSessionGrant(ownerId, sessionId, granteeId);
        expect(emitted.find((e) => e.event === 'operator-revoked')).toMatchObject({ room: granteeRoom(), payload: { sessionId, reason: 'revoked' } });
        expect(daemonCalls).toContainEqual({ method: 'kill-terminal', params: { terminalId: opened.terminalId } });
        expect(daemonCalls.filter((c) => c.method === 'kill-terminal')).toHaveLength(1); // never the session terminal
        expect(await db.sessionOperatorTerminal.count({ where: { granteeAccountId: granteeId, closedAt: null } })).toBe(0);

        emitted.length = 0;
        broker.operatorTerminalTap(ownerId, machineId, 'terminal-output', { terminalId: opened.terminalId, seq: 9, enc: true, data: Buffer.from(crypto.encryptWithDataKey('eA==', machineKey)).toString('base64') });
        await new Promise((r) => setTimeout(r, 50));
        expect(emitted).toEqual([]);
        expect(await rpc(granteeId, 'abort', {})).toEqual({ ok: false, error: 'not_operator' });
        expect((await broker.listOperatorEvents(sessionId, granteeId, 50)).find((e) => e.kind === 'ended')?.detail).toMatchObject({ reason: 'revoked', killed: 1, detached: 1 });
    });

    it('daemon offline at revoke: kill is remembered and delivered when it comes back; expiry ends access via the sweep', async () => {
        const again = await shares.createSessionGrant({ ownerId, sessionId, granteeAccountId: granteeId, role: 'driver', operate: true, confirmOperator: true, expiresInDays: 7 });
        await shares.respondToSessionGrant(granteeId, again.id, true);
        const ack = await rpc(granteeId, 'terminal.open', { cols: 80, rows: 24 });
        expect(ack.ok).toBe(true);
        daemonDown = true;
        await shares.updateSessionGrantRole(ownerId, sessionId, granteeId, undefined, undefined, { operate: false });
        const openedId = (openWith((ack as any).result, dek) as any).terminalId as string;
        const pending = await db.sessionOperatorTerminal.findFirstOrThrow({ where: { grantId: again.id, terminalId: openedId } });
        expect(pending).toMatchObject({ pendingKill: true, closeReason: 'downgraded' });
        expect(emitted.find((e) => e.event === 'operator-revoked')?.payload).toEqual({ sessionId, reason: 'downgraded' });
        daemonDown = false; daemonCalls.length = 0;
        await broker.retryPendingOperatorKills(ownerId, machineId);
        await vi.waitFor(async () => expect((await db.sessionOperatorTerminal.findUniqueOrThrow({ where: { id: pending.id } })).pendingKill).toBe(false));
        expect(daemonCalls).toContainEqual({ method: 'kill-terminal', params: { terminalId: pending.terminalId } });

        // Re-grant, open, then let it expire: the sweep ends it.
        await shares.updateSessionGrantRole(ownerId, sessionId, granteeId, undefined, undefined, { operate: true, confirmOperator: true });
        expect((await rpc(granteeId, 'terminal.open', { cols: 80, rows: 24 })).ok).toBe(true);
        await db.sessionGrant.update({ where: { id: again.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        emitted.length = 0; daemonCalls.length = 0;
        await broker.sweepOperatorTerminals();
        expect(emitted.find((e) => e.event === 'operator-revoked')?.payload).toEqual({ sessionId, reason: 'expired' });
        expect(daemonCalls.some((c) => c.method === 'kill-terminal')).toBe(true);
        expect(await rpc(granteeId, 'abort', {})).toEqual({ ok: false, error: 'not_operator' });
    });

    it('no plaintext (params, terminal bytes, results) ever reached a log line', () => {
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(SECRET_MARK);
        expect(JSON.stringify(logged)).not.toContain('Bash(*)');
    });
});
