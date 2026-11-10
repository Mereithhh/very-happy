import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { teamRequest, teamRetryDelayMs, TEAM_RATE_LIMIT_BUDGET_MS } from './client';
import { registerTeamsTools, TEAM_FIELD_FIXES, TEAM_SUBMIT_RESULT_MISSING } from './tools';

/** B-912: the 59 team_* argument refusals in 30 days, the 10-25 429 storm, and member-to-member messages (B-786). */
describe('team tool arguments through the real MCP SDK validation', () => {
    const connect = async () => {
        const action = vi.fn().mockResolvedValue({ team: { id: 't', name: 'T', version: 1, tasks: [], bots: [], messages: [], operations: [] } });
        const server = new McpServer({ name: 'test', version: '1' });
        registerTeamsTools(server, 's', { initialize: vi.fn(), inspect: vi.fn(), action } as any);
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'c', version: '1' });
        await Promise.all([server.connect(a), client.connect(b)]);
        const call = async (name: string, args: Record<string, unknown>) => {
            const result: any = await client.callTool({ name, arguments: args }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
            return { isError: !!result.isError, text: String(result.content?.[0]?.text ?? '') };
        };
        return { call, action, client };
    };
    const current = { taskId: 'task', attemptId: 'attempt', goalVersion: 1 };

    it('team_submit accepts `summary` as an alias of `result` (27 of 59 refusals)', async () => {
        const { call, action } = await connect();
        expect((await call('team_submit', { requestId: 'r1', ...current, summary: 'PR #1 green' })).isError).toBe(false);
        expect(action).toHaveBeenLastCalledWith({ type: 'submit', ...current, result: 'PR #1 green' }, 'r1');
        expect((await call('team_submit', { requestId: 'r2', ...current, result: 'canonical', summary: 'ignored' })).isError).toBe(false);
        expect(action).toHaveBeenLastCalledWith({ type: 'submit', ...current, result: 'canonical' }, 'r2');
        const missing = await call('team_submit', { requestId: 'r3', ...current });
        expect(missing).toEqual({ isError: true, text: TEAM_SUBMIT_RESULT_MISSING });
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('team_message accepts `message` / `to` aliases', async () => {
        const { call, action } = await connect();
        expect((await call('team_message', { requestId: 'm1', taskId: 'task', message: 'hello', to: 'lead' })).isError).toBe(false);
        expect(action).toHaveBeenLastCalledWith({ type: 'message', taskId: 'task', body: 'hello', recipientBotId: 'lead' }, 'm1');
        expect((await call('team_message', { requestId: 'm2', taskId: 'task' })).text).toContain('Missing body');
    });

    it('missing or mistyped fields say exactly what to pass (requestId, taskId, attemptId, goalVersion, acceptance)', async () => {
        const { call, action } = await connect();
        const noRequest = await call('team_message', { taskId: 'task', body: 'b', recipientBotId: 'lead' });
        expect(noRequest.isError).toBe(true);
        expect(noRequest.text).toContain(`${TEAM_FIELD_FIXES.requestId} at requestId`);
        expect((await call('team_message', { requestId: 'r', body: 'b' })).text).toContain(TEAM_FIELD_FIXES.taskId);
        expect((await call('team_accept', { taskId: 'task', attemptId: 'a', goalVersion: 1 })).text).toContain(TEAM_FIELD_FIXES.requestId);
        expect((await call('team_submit', { requestId: 'r', taskId: 'task', goalVersion: 1, result: 'x' })).text).toContain(TEAM_FIELD_FIXES.attemptId);
        expect((await call('team_submit', { requestId: 'r', taskId: 'task', attemptId: 'a', goalVersion: '1', result: 'x' })).text).toContain('goalVersion must be a number, not a string (pass 1 without quotes)');
        expect((await call('team_delegate', { requestId: 'r', goal: 'g' })).text).toContain(TEAM_FIELD_FIXES.acceptance);
        expect((await call('team_delegate', { requestId: 'r', goal: 'g', acceptance: 'tests pass' })).text).toContain('wrap a single criterion as ["…"]');
        expect(action).not.toHaveBeenCalled();
    });

    it('the published schema still lists the aliases and marks result/body as required in their descriptions', async () => {
        const { client } = await connect();
        const tools = (await client.listTools()).tools;
        const submit = tools.find(t => t.name === 'team_submit')!.inputSchema as any;
        expect(Object.keys(submit.properties)).toEqual(expect.arrayContaining(['result', 'summary', 'requestId', 'taskId', 'attemptId', 'goalVersion']));
        expect(submit.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'attemptId', 'goalVersion']));
        expect(submit.properties.result.description).toMatch(/^Required/);
        expect(submit.properties.goalVersion.type).toBe('integer');
    });
});

describe('teamRequest refusals and 429 backoff', () => {
    afterEach(() => vi.unstubAllGlobals());
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
    const clock = () => {
        let t = 0; const sleeps: number[] = [];
        return { sleeps, timing: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, random: () => 0.5 } };
    };
    const submit = { requestId: 'same-id', action: { type: 'submit', taskId: 'x', attemptId: 'a', goalVersion: 1, result: 'r' } };

    it('retries a 429 with the same body (same requestId) and succeeds', async () => {
        const fetch = vi.fn().mockResolvedValueOnce(reply(429, {})).mockResolvedValueOnce(reply(429, {}, { 'retry-after': '3' })).mockResolvedValueOnce(reply(200, { ok: true }));
        vi.stubGlobal('fetch', fetch);
        const { sleeps, timing } = clock();
        expect(await teamRequest('/v1/teams/t/agent', 'POST', 'tok', true, submit, timing)).toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(new Set(fetch.mock.calls.map(c => c[1].body))).toEqual(new Set([JSON.stringify(submit)]));
        expect(sleeps).toEqual([1000, 3000]); // backoff 1 s, then the server's Retry-After
    });

    it('gives up after 3 retries with one short hint to retry later with the same requestId', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply(429, {}));
        vi.stubGlobal('fetch', fetch);
        const { sleeps, timing } = clock();
        const error = await teamRequest('/p', 'POST', 'tok', true, submit, timing).catch(e => e as Error);
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(sleeps).toEqual([1000, 2000, 4000]);
        expect(error.message).toMatch(/^Teams is rate limiting this session \(HTTP 429\); retried 3 times over 7 s with the same requestId\./);
        expect(error.message.length).toBeLessThan(400);
    });

    it('never waits past the 30 s budget', async () => {
        const fetch = vi.fn().mockImplementation(async () => reply(429, {}, { 'retry-after': '20' }));
        vi.stubGlobal('fetch', fetch);
        const { sleeps, timing } = clock();
        const error = await teamRequest('/p', 'POST', 'tok', true, submit, timing).catch(e => e as Error);
        expect(sleeps).toEqual([20_000]);
        expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEAM_RATE_LIMIT_BUDGET_MS);
        expect(error.message).toContain('retried 1 time over 20 s');
        expect(error.message).toContain('The server asked to wait 20 s');
    });

    it('does not retry a capacity or quota 429 (waiting will not heal it)', async () => {
        for (const code of ['team_message_limit', 'message_quota_exceeded']) {
            const fetch = vi.fn().mockImplementation(async () => reply(429, { error: code }));
            vi.stubGlobal('fetch', fetch);
            const { sleeps, timing } = clock();
            const error = await teamRequest('/p', 'POST', 'tok', true, submit, timing).catch(e => e as Error);
            expect(fetch, code).toHaveBeenCalledTimes(1);
            expect(sleeps, code).toEqual([]);
            expect(error.message).toContain(code);
        }
    });

    it('a member messaging another member is told to go through the lead', async () => {
        const message = { requestId: 'm', action: { type: 'message', taskId: 'x', body: 'b', recipientBotId: 'other-member' } };
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { error: 'recipient_outside_task', ownerBotId: 'lead-bot' })));
        const outside = await teamRequest('/p', 'POST', 'tok', true, message).catch(e => e as Error);
        expect(outside.message).toContain('Members do not message each other directly');
        expect(outside.message).toContain('recipientBotId "lead-bot"');
        expect(outside.message).toContain('请经 Lead 转达');
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(404, { error: 'task_not_found' })));
        const hidden = await teamRequest('/p', 'POST', 'tok', true, message).catch(e => e as Error);
        expect(hidden.message).toContain('请经 Lead 转达');
        expect(hidden.message).toContain("the task's ownerBotId from team_inspect");
        // Other actions keep the plain refusal.
        const other = await teamRequest('/p', 'POST', 'tok', true, submit).catch(e => e as Error);
        expect(other.message).toBe('Teams request failed (HTTP 404: task_not_found)');
    });

    it('parses Retry-After as seconds or an HTTP date', () => {
        expect(teamRetryDelayMs('2', 0, 0)).toBe(2000);
        expect(teamRetryDelayMs('0', 0, 0)).toBe(250);
        expect(teamRetryDelayMs(new Date(10_000).toUTCString(), 0, 4000)).toBe(6000);
        expect(teamRetryDelayMs(null, 2, 0, () => 0.5)).toBe(4000);
    });
});
