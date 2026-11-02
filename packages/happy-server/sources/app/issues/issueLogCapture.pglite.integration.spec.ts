import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { BUILTIN_TODO_PREFIX } from '@slopus/happy-wire';
import { startIssueTestServer } from './issueTestServer';

/**
 * B-872 spec 拍板补充 1: issue content is plaintext server-side, so the logs
 * must never carry it. Runs the whole issue flow through the real server
 * (create + assign, dispatch claim / complete, agent comment + status, human
 * comment, 退回 with a note, search, failure text, a refused request, Todos
 * import) while capturing every line the process logs — the pino logger
 * Fastify and `log()` share, plus console — then searches the capture for
 * marker strings planted in each content field. The capture is checked to be
 * non-empty and to contain the issue routes, so the search is not vacuous.
 */

const { shutdown } = vi.hoisted(() => ({ shutdown: [] as (() => Promise<void>)[] }));
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: vi.fn(async () => undefined), dispatchDeviceEventPush: vi.fn(), sendTestWebPush: vi.fn() }));
vi.mock('@/utils/shutdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/shutdown')>()),
    onShutdown: (_name: string, fn: () => Promise<void>) => { shutdown.push(fn); return () => undefined; },
}));

const MARK = {
    title: 'MARKtitleQ7Z',
    description: 'MARKdescK2V',
    comment: 'MARKcommentP9X',
    agent: 'MARKagentW4N',
    review: 'MARKreviewJ3H',
    returnNote: 'MARKreturnB8D',
    owner: 'MARKownerT1M',
    search: 'MARKtitleQ7Z',
    failure: 'MARKfailureR6C',
    refused: 'MARKrefusedY5L',
    todo: 'MARKtodoE2S',
    todoNote: 'MARKtodonoteF4U',
};

describe('B-872 logs carry no issue content (full flow, captured logs)', () => {
    let s: Awaited<ReturnType<typeof startIssueTestServer>>;
    const captured: string[] = [];
    const updates: { t: string }[] = [];
    let socket: ClientSocket | null = null;
    const restore: (() => void)[] = [];

    beforeAll(async () => {
        process.env.VH_ISSUES_ENABLED = 'true';
        process.env.VH_OWNER_BOARD_ENABLED = 'true';
        const { logger } = await import('@/utils/log');
        const streams = (logger as any)[pino.symbols.streamSym];
        streams.add({ level: 'trace', stream: { write: (line: string) => { captured.push(line); } } });
        for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            const original = console[method];
            const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); original(...args); });
            restore.push(() => spy.mockRestore());
        }
        s = await startIssueTestServer('logs');
        socket = connect(s.base, { path: '/v1/updates', transports: ['websocket'], auth: { token: s.token, clientType: 'user-scoped' }, reconnection: false });
        socket.on('update', (u: { body: { t: string } }) => updates.push(u.body));
        await new Promise<void>((resolve, reject) => { socket!.once('connect', () => resolve()); socket!.once('connect_error', reject); });
    }, 60000);
    afterAll(async () => {
        socket?.close();
        for (const r of restore) r();
        await s.stop(shutdown);
        delete process.env.VH_ISSUES_ENABLED; delete process.env.VH_OWNER_BOARD_ENABLED;
    });

    it('walks the flow and finds no marker in any captured log line', async () => {
        const machineId = await s.newMachine();
        const created = await s.call('POST', '/v1/issues', {
            title: `Fix ${MARK.title}`, description: `Body ${MARK.description}`, labels: ['x'],
            assignee: { kind: 'agent', machineId, agent: 'codex', directory: '/w' },
        });
        expect(created.status).toBe(200);
        const issueId = created.body.issue.id as string;
        const polled = await s.call('GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
        const claim = await s.call('POST', `/v1/issues/dispatch/${polled.body.dispatches[0].id}/claim`, { machineId });
        expect(claim.body.dispatch.spawn.prompt).toContain(MARK.description);
        const sessionId = await s.newSession();
        await s.call('POST', `/v1/issues/dispatch/${polled.body.dispatches[0].id}/complete`, { machineId, claimId: claim.body.dispatch.claimId, sessionId });
        await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_progress', comment: `Starting ${MARK.agent}` });
        await s.call('POST', '/v1/issues/agent/comment', { sessionId, body: `Question ${MARK.owner}`, mentionOwner: true });
        await s.call('POST', `/v1/issues/${issueId}/comments`, { body: `Please ${MARK.comment}` });
        await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'in_review', comment: `Delivered ${MARK.review}` });
        const item = await s.db.attentionItem.findFirstOrThrow({ where: { key: `issue-review:${issueId}` } });
        expect((await s.call('POST', `/v1/attention-items/${item.id}/owner-respond`, { action: 'choose', choice: 'return', note: `Again ${MARK.returnNote}` })).status).toBe(200);
        expect((await s.call('GET', `/v1/issues?q=${MARK.search}`)).body.issues).toHaveLength(1);
        await s.call('PATCH', `/v1/issues/${issueId}`, { description: `Edited ${MARK.description}` });
        // A refused request carrying content (over-long title) and a refused agent write.
        expect((await s.call('POST', '/v1/issues', { title: `${MARK.refused}${'x'.repeat(400)}` })).status).toBe(400);
        expect((await s.call('POST', '/v1/issues/agent/update', { sessionId, status: 'done', comment: MARK.refused })).status).toBe(409);
        // A run failure whose daemon error text is arbitrary.
        const second = await s.call('POST', `/v1/issues/${issueId}/runs`, {});
        const p2 = await s.call('GET', `/v1/issues/dispatch?machineId=${machineId}&workerVersion=1`);
        const d2 = p2.body.dispatches.find((d: { runId: string }) => d.runId === second.body.runs[0].id);
        const c2 = await s.call('POST', `/v1/issues/dispatch/${d2.id}/claim`, { machineId });
        await s.call('POST', `/v1/issues/dispatch/${d2.id}/fail`, { machineId, claimId: c2.body.dispatch.claimId, error: `spawn failed ${MARK.failure}` });
        // Todos import of a record with marked title / note.
        const todoId = crypto.randomUUID();
        await s.db.userKVStore.create({ data: { accountId: s.accountId, key: BUILTIN_TODO_PREFIX + todoId, version: 1, value: Buffer.from(JSON.stringify({ schemaVersion: 1, id: todoId, title: MARK.todo, note: MARK.todoNote, status: 'open', order: 1, createdAt: 1, updatedAt: 2 })) } });
        expect((await s.call('POST', '/v1/issues/import-legacy-todos')).body.imported).toBe(1);
        await s.call('GET', `/v1/issues/${created.body.issue.key}`);
        await s.call('POST', `/v1/sessions/${sessionId}/archive`);
        await expect.poll(() => updates.filter(u => u.t === 'issue-run').length).toBeGreaterThan(0);

        const text = captured.join('\n');
        // Not vacuous: request logs of the issue routes were captured.
        expect(captured.length).toBeGreaterThan(20);
        expect(text).toContain('/v1/issues');
        expect(text).toContain('/v1/issues/agent/update');
        for (const [field, mark] of Object.entries(MARK)) expect(text.includes(mark), `${field} leaked into logs`).toBe(false);
        // The socket carried the three update kinds (content goes to the owner's devices, not the logs).
        for (const t of ['issue', 'issue-comment', 'issue-run', 'attention-item']) expect(updates.some(u => u.t === t), t).toBe(true);
    });
});
