import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { attentionBoardLocalId } from '@slopus/happy-wire';

/**
 * B-766 end to end through the production `startApi()` (real route
 * registration, auth, socket ingress) on PGlite — not the store directly.
 * Pins the wiring a store-level test cannot see: `attentionRoutes` is
 * registered in api.ts, the archive route and both message ingresses
 * (socket `message`, `POST /v3/sessions/:id/messages`) call the hooks.
 */

const { pushed, shutdown } = vi.hoisted(() => ({ pushed: [] as unknown[], shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({
    dispatchSessionEventPush: vi.fn(async (p: unknown) => { pushed.push(p); }),
    dispatchDeviceEventPush: vi.fn(),
    sendTestWebPush: vi.fn(),
}));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

const options = [{ id: 'A', label: 'Ship now' }, { id: 'B', label: 'Wait' }];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await read();
        if (ok(value)) return value;
        if (Date.now() - started > timeoutMs) throw new Error(`condition not reached: ${JSON.stringify(value)}`);
        await sleep(25);
    }
}
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise(resolve => server.close(resolve));
    return port;
}

describe('attention REST + hooks through startApi (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/attention-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'api-'));
    let db: PrismaClient; let base: string;
    let accountId: string; let token: string; let otherToken: string; let machineTokens: Record<string, string>;
    const sockets: ClientSocket[] = [];

    const call = async (method: string, path: string, body?: unknown, bearer = token) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const newSession = async (owner = accountId) => (await db.session.create({ data: { accountId: owner, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
    const item = (id: string) => db.attentionItem.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'attention-api-test-only';
        delete process.env.VH_OWNER_BOARD_ENABLED;
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        const { auth } = await import('@/app/auth/auth'); await auth.init();
        const { startApi } = await import('@/app/api/api');
        const port = await freePort();
        await startApi({ port, host: '127.0.0.1' });
        base = `http://127.0.0.1:${port}`;
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        const otherId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        // The owner's Web login (a login session) vs every machine token this account can hold (authRoutes / migrationRoutes).
        token = (await auth.createLoginToken(accountId)).token;
        otherToken = (await auth.createLoginToken(otherId)).token;
        machineTokens = {
            terminalPairing: await auth.createToken(accountId, { session: 'pairing-1' }),
            accountDevicePairing: await auth.createToken(accountId),
            legacyPublicKeyAuth: await auth.createToken(accountId),
            daemonMigration: await auth.createToken(accountId),
        };
    }, 60000);
    afterAll(async () => {
        for (const s of sockets) s.close();
        for (const fn of shutdown.reverse()) await fn().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it('answers 404 owner_board_disabled with the switch off (route registered, gated)', async () => {
        const sessionId = await newSession();
        expect(await call('GET', '/v1/attention-items')).toEqual({ status: 404, body: { error: 'owner_board_disabled' } });
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'blocked', title: 'x' })).body).toEqual({ error: 'owner_board_disabled' });
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
    });

    it('B-921: only a signed-in login answers as the owner; machine tokens get owner_login_required', async () => {
        const sessionId = await newSession();
        for (const [kind, machine] of Object.entries(machineTokens)) {
            const posted = await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'decision', title: `approve? ${kind}`, options, key: `t:${kind}` }, machine);
            expect(posted.status, kind).toBe(200);
            const id = posted.body.item.id;
            for (const body of [{ action: 'choose', choice: 'A' }, { action: 'resolve' }, { action: 'reopen' }]) {
                expect(await call('POST', `/v1/attention-items/${id}/owner-respond`, body, machine), `${kind} ${body.action}`).toEqual({ status: 403, body: { error: 'owner_login_required' } });
            }
            // The agent-side close is the lead's, never the owner's; `by` cannot claim owner.
            expect((await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'done', by: 'owner' }, machine)).status).toBe(400);
            expect((await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'done' }, machine)).body.item).toMatchObject({ resolvedBy: 'lead', ownerChoice: null });
            expect(await item(id)).toMatchObject({ resolvedBy: 'lead', ownerChoice: null });
        }
        const fresh = await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'decision', title: 'approve?', options, key: 't:web' }, machineTokens.terminalPairing!);
        expect((await call('POST', `/v1/attention-items/${fresh.body.item.id}/owner-respond`, { action: 'choose', choice: 'A' })).body.item).toMatchObject({ resolvedBy: 'owner', ownerChoice: 'A' });
    });

    it('POST upsert / PATCH / resolve / owner-respond / GET over HTTP, with validation and auth', async () => {
        const sessionId = await newSession();
        expect((await call('GET', '/v1/attention-items', undefined, 'not-a-token')).status).toBe(401);
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'no options' })).status).toBe(400);

        const created = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, key: 'k', requestId: 'r1' });
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ created: true, item: { title: 'Pick', state: 'open', needsOwner: true, inferred: false } });
        const id = created.body.item.id as string;
        const repost = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick again', options, key: 'k', requestId: 'r2' });
        expect(repost.body).toMatchObject({ created: false, item: { id, repostCount: 1 } });

        expect((await call('PATCH', `/v1/attention-items/${id}`, { appendMd: 'context' })).body.item).toMatchObject({ bodyMd: 'context' });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'choose', choice: 'B' })).body.item).toMatchObject({ state: 'resolved', ownerChoice: 'B', resolvedBy: 'owner' });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'choose', choice: 'A' }))).toMatchObject({ status: 409, body: { error: 'attention_item_closed' } });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'reopen' })).body.item.state).toBe('open');
        expect((await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'dropped', note: 'n' })).body.item).toMatchObject({ state: 'dismissed', resolveNote: 'n' });

        const report = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'report', title: 'Merged', requestId: 'r3' });
        const listed = await call('GET', `/v1/attention-items?sessionId=${sessionId}&state=all&limit=10`);
        expect(listed.status).toBe(200);
        expect(listed.body.items.map((i: { id: string }) => i.id).sort()).toEqual([id, report.body.item.id].sort());
        expect((await call('GET', `/v1/attention-items?sessionId=${sessionId}`)).body.items.map((i: { id: string }) => i.id)).toEqual([report.body.item.id]);

        // Another account: cannot post into the session, read or touch the item.
        expect(await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'report', title: 'x' }, otherToken)).toEqual({ status: 404, body: { error: 'session_not_found' } });
        expect((await call('PATCH', `/v1/attention-items/${id}`, { title: 'x' }, otherToken))).toEqual({ status: 404, body: { error: 'attention_item_not_found' } });
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'resolve' }, otherToken)).status).toBe(404);
        expect((await call('GET', `/v1/attention-items?sessionId=${sessionId}&state=all`, undefined, otherToken)).body.items).toEqual([]);
    });

    it('a repost keeps the fields it omits (active and reopened) and overwrites the ones it carries (S-1c)', async () => {
        const sessionId = await newSession();
        const post = (body: Record<string, unknown>) => call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'todo', key: 'keep', ...body });
        const anchor = { localId: 'l1', snippet: 'first' };
        const links = [{ type: 'pr', ref: '713' }];
        const first = await post({ title: 'T1', bodyMd: 'body 1', anchor, links, replyToId: 'q-none', requestId: 'p1' });
        const id = first.body.item.id as string;

        const bare = await post({ title: 'T2', requestId: 'p2' });
        expect(bare.body.item).toMatchObject({ id, title: 'T2', bodyMd: 'body 1', anchor, links, replyToId: 'q-none', repostCount: 1 });

        await call('POST', `/v1/attention-items/${id}/resolve`, { outcome: 'done' });
        const reopened = await post({ title: 'T3', requestId: 'p3' });
        expect(reopened.body.item).toMatchObject({ id, state: 'open', title: 'T3', bodyMd: 'body 1', anchor, links, replyToId: 'q-none' });

        const anchor2 = { messageId: 'm2' };
        const fresh = await post({ title: 'T4', bodyMd: 'body 2', anchor: anchor2, requestId: 'p4' });
        expect(fresh.body.item).toMatchObject({ title: 'T4', bodyMd: 'body 2', anchor: anchor2, links, replyToId: 'q-none' });
        expect(await item(id)).toMatchObject({ bodyMd: 'body 2', anchor: anchor2 });
    });

    it('POST /v1/sessions/:id/archive dismisses the session’s open items', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'blocked', title: 'login', requestId: 'a1' });
        expect((await call('POST', `/v1/sessions/${sessionId}/archive`)).status).toBe(200);
        expect(await until(() => item(body.item.id), r => r.state !== 'open')).toMatchObject({ state: 'dismissed', resolvedBy: 'session-archived' });
    });

    // B-915: wrap-up cards — running (shown, not waiting on the owner) → done (waits, never pushes), owner ticks, archive dismisses.
    it('wrapup: payload round-trip, needsOwner follows status, no push, check action, archive dismisses', async () => {
        const sessionId = await newSession();
        const post = (payload: Record<string, unknown>, requestId: string) =>
            call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'wrapup', key: 'wrapup', title: 'Wrap-up', payload, requestId });
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'agent', kind: 'wrapup', title: 'no payload' })).status).toBe(400);
        expect((await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'report', title: 'x', payload: { v: 1, mode: 'wrapup', status: 'done' } })).status).toBe(400);

        const pushesBefore = pushed.length;
        const running = await post({ v: 1, mode: 'wrapup', status: 'running', localId: 'wrapup-n1', startedAt: 1 }, 'w1');
        expect(running.status).toBe(200);
        expect(running.body.item).toMatchObject({ kind: 'wrapup', needsOwner: false, payload: { status: 'running', localId: 'wrapup-n1' } });
        const id = running.body.item.id as string;

        const result = { v: 1, mode: 'wrapup', status: 'done', summary: 'Did X', files: ['a.ts'], commits: [{ sha: 'abc1234', subject: 'fix' }],
            pending: [{ id: 'p1', label: 'Release?', checked: false }, { id: 'p2', label: 'Docs?', checked: false }], canClose: false };
        const done = await post(result, 'w2');
        expect(done.body.item).toMatchObject({ id, needsOwner: true, state: 'open', repostCount: 1, payload: result });
        expect((await call('GET', `/v1/attention-items?needsOwner=1&sessionId=${sessionId}`)).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
        await sleep(100);
        expect(pushed.length).toBe(pushesBefore);

        const checked = await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'check', checkId: 'p2', checked: true });
        expect(checked.status).toBe(200);
        expect(checked.body.item.state).toBe('open');
        expect(checked.body.item.payload.pending).toEqual([{ id: 'p1', label: 'Release?', checked: false }, { id: 'p2', label: 'Docs?', checked: true }]);
        const version = checked.body.item.version as number;
        // Same tick again: unchanged (idempotent retry, no version bump).
        expect((await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'check', checkId: 'p2', checked: true })).body.item.version).toBe(version);
        expect(await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'check', checkId: 'nope', checked: true })).toEqual({ status: 400, body: { error: 'attention_check_unknown' } });
        expect((await item(id)).payload).toMatchObject({ pending: [{ checked: false }, { checked: true }] });

        const decision = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 'w3' });
        expect(await call('POST', `/v1/attention-items/${decision.body.item.id}/owner-respond`, { action: 'check', checkId: 'p1', checked: true })).toMatchObject({ status: 409, body: { error: 'attention_check_unsupported' } });
        expect(await call('POST', `/v1/attention-items/${id}/owner-respond`, { action: 'check', checkId: 'p1', checked: true }, otherToken)).toMatchObject({ status: 404 });

        expect((await call('POST', `/v1/sessions/${sessionId}/archive`)).status).toBe(200);
        expect(await until(() => item(id), r => r.state !== 'open')).toMatchObject({ state: 'dismissed', resolvedBy: 'session-archived' });
        // A new run on the archived-then-restored session reopens the same card as running (no owner wait).
        const again = await post({ v: 1, mode: 'wrapup', status: 'running', startedAt: 2 }, 'w4');
        expect(again.body.item).toMatchObject({ id, state: 'open', needsOwner: false });
    });

    // S-1d: the owner's ordinary chat never closes a decision (it used to settle the only open one as `owner-replied`,
    // silently, with the lead unaware). Only the board choice (owner-respond) or the lead's resolve closes it.
    const ownerSocket = async () => {
        const socket = connect(base, { path: '/v1/updates', transports: ['websocket'], auth: { token, clientType: 'user-scoped' }, reconnection: false });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
        return socket;
    };
    const messageCount = (sessionId: string) => db.sessionMessage.count({ where: { sessionId } });

    it('an owner message (v3 HTTP or socket) leaves the only open decision open; the board choice closes it', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 'v1' });
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: 'owner-1', content: 'enc' }] })).status).toBe(200);
        const socket = await ownerSocket();
        socket.emit('message', { sid: sessionId, message: 'enc', localId: 'owner-socket-1' });
        // Both messages landed (the ingress ran) and the decision is untouched.
        await until(() => messageCount(sessionId), n => n === 2);
        await sleep(300);
        expect(await item(body.item.id)).toMatchObject({ state: 'open', resolvedBy: null, ownerChoice: null });
        expect((await call('POST', `/v1/attention-items/${body.item.id}/owner-respond`, { action: 'choose', choice: 'B' })).body.item)
            .toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'B' });
        // The board's own follow-up chat line changes nothing either.
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: attentionBoardLocalId(body.item.id, 'n1'), content: 'enc' }] })).status).toBe(200);
        await sleep(300);
        expect(await item(body.item.id)).toMatchObject({ state: 'resolved', resolvedBy: 'owner', ownerChoice: 'B' });
    });

    it('an owner message leaves the decision open until the lead resolves it', async () => {
        const sessionId = await newSession();
        const { body } = await call('POST', '/v1/attention-items', { sessionId, source: 'lead', kind: 'decision', title: 'Pick', options, requestId: 'l1' });
        expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: 'owner-l1', content: 'enc' }] })).status).toBe(200);
        await until(() => messageCount(sessionId), n => n === 1);
        await sleep(300);
        expect((await item(body.item.id)).state).toBe('open');
        expect((await call('POST', `/v1/attention-items/${body.item.id}/resolve`, { outcome: 'done', note: 'went with A' })).body.item)
            .toMatchObject({ state: 'resolved', resolvedBy: 'lead', resolveNote: 'went with A' });
    });

    describe('root-task「等你验收」through the team routes', () => {
        let machineId: string;
        beforeAll(async () => {
            process.env.VH_AGENT_TEAMS_ENABLED = 'true';
            machineId = crypto.randomUUID();
            await db.machine.create({ data: { id: machineId, accountId, metadata: 'm' } });
        });
        const act = async (teamId: string, requestId: string, action: Record<string, unknown>) => {
            const res = await call('POST', `/v1/teams/${teamId}/actions`, { requestId, action });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            return res.body.team as { tasks: { id: string; status: string; currentAttemptId: string; goalVersion: number }[]; messages: { taskId: string; recipientBotId: string; body: string }[]; operations: { id: string; taskId: string; type: string; claimId?: string }[] };
        };
        const startRootTask = async (name: string, goal: string) => {
            const sessionId = await newSession();
            const created = await call('POST', '/v1/teams', { name, machineId });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            const teamId = created.body.team.id as string;
            const delegated = await call('POST', `/v1/teams/${teamId}/actions`, { requestId: `${name}-delegate`, action: { type: 'delegate', goal, acceptance: ['done'] } });
            const taskId = delegated.body.taskId as string;
            const operationId = delegated.body.team.operations.find((o: { taskId: string; type: string }) => o.taskId === taskId && o.type === 'spawn').id as string;
            const claimed = await act(teamId, `${name}-claim`, { type: 'claim-operation', operationId, machineId, teamLaunchVersion: 1 });
            const claimId = claimed.operations.find(o => o.id === operationId)!.claimId!;
            const started = await act(teamId, `${name}-complete`, { type: 'complete-operation', operationId, machineId, claimId, sessionId });
            const task = started.tasks.find(t => t.id === taskId)!;
            const submit = (t: typeof task, requestId: string) =>
                act(teamId, requestId, { type: 'submit', taskId, attemptId: t.currentAttemptId, goalVersion: t.goalVersion, result: 'PR #1 merged.' });
            return { sessionId, teamId, taskId, task, submit };
        };
        const submitItem = async (sessionId: string, taskId: string) =>
            (await call('GET', `/v1/attention-items?sessionId=${sessionId}&state=all`)).body.items.find((i: { key: string }) => i.key === `team-submit:${taskId}`);

        it('writes a word-safe title, readable labels and no recommended option', async () => {
            const goal = 'Rewrite the attention briefing board so that every decision the lead posts survives casual owner chat and gets resolved explicitly';
            const { sessionId, taskId, task, submit } = await startRootTask('root-title', goal);
            await submit(task, 'root-title-submit');
            const row = await submitItem(sessionId, taskId);
            expect(row.title.length).toBeLessThanOrEqual(120);
            expect(row.title).toMatch(/^根目标已提交，等你验收 · Rewrite the attention/);
            expect(row.title.endsWith('…')).toBe(true);
            // Cut between words: the text before「…」is a whole-word prefix of the goal.
            const kept = row.title.slice('根目标已提交，等你验收 · '.length, -1);
            expect(goal.startsWith(kept) && /^\s/.test(goal.slice(kept.length))).toBe(true);
            expect(row.options).toEqual([{ id: 'accept', label: '验收' }, { id: 'return', label: '退回' }]);
        });

        it('a board「退回」notifies the lead once (its chat line); a team-page return still sends the team message', async () => {
            const { sessionId, teamId, taskId, task, submit } = await startRootTask('root-return', 'Ship the notes');
            await submit(task, 'root-return-submit-1');
            const row = await submitItem(sessionId, taskId);
            expect((await call('POST', `/v1/attention-items/${row.id}/owner-respond`, { action: 'choose', choice: 'return' })).body.item)
                .toMatchObject({ state: 'resolved', ownerChoice: 'return' });
            // What the web board sends next: the owner's chat line, the lead's one notice.
            expect((await call('POST', `/v3/sessions/${sessionId}/messages`, { messages: [{ localId: attentionBoardLocalId(row.id, 'n1'), content: 'enc' }] })).status).toBe(200);
            const revisions = (team: Awaited<ReturnType<typeof act>>) => team.messages.filter(m => m.taskId === taskId && m.body.startsWith('Revision requested'));
            let team = (await call('GET', `/v1/teams/${teamId}`)).body.team as Awaited<ReturnType<typeof act>>;
            expect(team.tasks.find(t => t.id === taskId)!.status).toBe('running');
            expect(revisions(team)).toHaveLength(0);
            expect(await messageCount(sessionId)).toBe(1);

            const returned = team.tasks.find(t => t.id === taskId)!;
            await submit(returned, 'root-return-submit-2');
            team = await act(teamId, 'root-return-team-page', { type: 'return', taskId, attemptId: returned.currentAttemptId, goalVersion: returned.goalVersion, reason: 'from the team page' });
            expect(revisions(team)).toHaveLength(1);
        });

        it('B-850d: a member refused for its account → a 「需要我决策」 item in the lead\'s session; the owner retry closes it', async () => {
            const leadSession = await newSession();
            const created = await call('POST', '/v1/teams', { name: 'acct-team', machineId });
            const teamId = created.body.team.id as string;
            await act(teamId, 'acct-join', { type: 'join', name: 'Lead', sessionId: leadSession });
            const delegated = await call('POST', `/v1/teams/${teamId}/actions`, { requestId: 'acct-delegate', action: { type: 'delegate', goal: 'Build it', acceptance: ['done'], botName: 'Builder', agentProfile: { id: 'org-a', label: 'Org A' } } });
            expect(delegated.status, JSON.stringify(delegated.body)).toBe(200);
            const op = delegated.body.team.operations.find((o: { type: string }) => o.type === 'spawn');
            expect(op.agentProfile).toEqual({ id: 'org-a', label: 'Org A' });
            const claimed = await act(teamId, 'acct-claim', { type: 'claim-operation', operationId: op.id, machineId, teamLaunchVersion: 1 });
            const claimId = claimed.operations.find(o => o.id === op.id)!.claimId!;
            await act(teamId, 'acct-fail', { type: 'fail-operation', operationId: op.id, machineId, claimId, error: 'agent-profile-unavailable:expired: account "Org A" — sign in again' });
            const items = async () => (await call('GET', `/v1/attention-items?sessionId=${leadSession}&state=all`)).body.items as { key: string; state: string; title: string; kind: string; source: string; needsOwner: boolean; teamId: string | null }[];
            const row = (await items()).find(i => i.key === `team-account:${op.id}`)!;
            expect(row).toMatchObject({ kind: 'blocked', source: 'team', state: 'open', needsOwner: true, teamId, title: '成员 Builder 的账号「Org A」登录已过期，这一轮没有启动 · acct-team' });
            await act(teamId, 'acct-retry', { type: 'retry-operation', operationId: op.id, claimId });
            expect((await items()).find(i => i.key === `team-account:${op.id}`)!.state).toBe('resolved');
            // Refused again after the retry (still expired) → the same item reopens.
            await act(teamId, 'acct-fail-2', { type: 'fail-operation', operationId: op.id, machineId, claimId, error: 'agent-profile-unavailable:expired: account "Org A" — sign in again' });
            expect((await items()).filter(i => i.key === `team-account:${op.id}`).map(i => i.state)).toEqual(['open']);
            // An ordinary startup failure is not an account item (and settles it).
            await act(teamId, 'acct-fail-3', { type: 'fail-operation', operationId: op.id, machineId, claimId, error: 'Agent process exited during startup' });
            expect((await items()).filter(i => i.key.startsWith('team-account:') && i.state === 'open')).toHaveLength(0);
        });
    });
});
