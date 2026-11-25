import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTeamsTools, withRequiredSchema, normalizeTeamToolArgs, TEAM_MESSAGE_BODY_MISSING, TEAM_SUBMIT_RESULT_MISSING, TEAM_REPEAT_STOP_AFTER } from './tools';

/** B-972: a real MCP server and client over the in-memory transport, so the schema is what a model actually receives. */
async function connect() {
    const team = { id: 't', name: 'T', machineId: 'm', version: 1, createdAt: 1, bots: [], messages: [], operations: [], tasks: [] };
    const teamClient = { initialize: vi.fn(), inspect: vi.fn(), action: vi.fn().mockResolvedValue({ team }) };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerTeamsTools(withRequiredSchema(server as any), 'normal-session', teamClient as any);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
        const res: any = await client.callTool({ name, arguments: args });
        return { isError: Boolean(res.isError), text: String(res.content?.[0]?.text ?? '') };
    };
    return { client, teamClient, call };
}

const MESSAGE = { requestId: 'r', taskId: 't1' };
const SUBMIT = { requestId: 'r', taskId: 't1', attemptId: 'a1', goalVersion: 1 };

describe('B-972: body / result are required in the schema models receive', () => {
    it('tools/list lists body for team_message and result for team_submit as required, aliases stay optional', async () => {
        const { client } = await connect();
        const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.inputSchema as any]));
        expect(tools.team_message.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'body']));
        expect(tools.team_message.required).not.toContain('message');
        expect(tools.team_message.required).not.toContain('to');
        expect(Object.keys(tools.team_message.properties)).toEqual(expect.arrayContaining(['body', 'message', 'recipientBotId', 'to']));
        expect(tools.team_submit.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'attemptId', 'goalVersion', 'result']));
        expect(tools.team_submit.required).not.toContain('summary');
        expect(Object.keys(tools.team_submit.properties)).toEqual(expect.arrayContaining(['result', 'summary']));
    });

    it('no team tool describes a field as Required while leaving it out of required', async () => {
        const { client } = await connect();
        for (const tool of (await client.listTools()).tools) {
            const schema = tool.inputSchema as any;
            for (const [field, spec] of Object.entries<any>(schema.properties ?? {})) {
                if (/^Required/.test(spec.description ?? '')) expect(schema.required ?? [], `${tool.name}.${field}`).toContain(field);
            }
        }
    });

    it('every write tool except the two alias tools already lists all non-optional fields as required', async () => {
        const { client } = await connect();
        const tools = Object.fromEntries((await client.listTools()).tools.map(t => [t.name, t.inputSchema as any]));
        expect(tools.team_accept.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'attemptId', 'goalVersion']));
        expect(tools.team_return.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'reason', 'attemptId', 'goalVersion']));
        expect(tools.team_cancel.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'reason', 'attemptId', 'goalVersion']));
        expect(tools.team_handoff.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'assigneeBotId', 'attemptId', 'goalVersion']));
        expect(tools.team_delegate.required).toEqual(expect.arrayContaining(['requestId', 'goal', 'acceptance']));
    });
});

describe('B-972: aliases still reach the server', () => {
    it('team_message accepts body, or the message / to aliases', async () => {
        const { call, teamClient } = await connect();
        expect((await call('team_message', { ...MESSAGE, body: 'hi' })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith({ type: 'message', taskId: 't1', body: 'hi' }, 'r');
        expect((await call('team_message', { ...MESSAGE, message: 'hi', to: 'bot-1' })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith({ type: 'message', taskId: 't1', body: 'hi', recipientBotId: 'bot-1' }, 'r');
    });
    it('team_submit accepts result or the summary alias', async () => {
        const { call, teamClient } = await connect();
        expect((await call('team_submit', { ...SUBMIT, result: 'done' })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith({ type: 'submit', taskId: 't1', attemptId: 'a1', goalVersion: 1, result: 'done' }, 'r');
        expect((await call('team_submit', { ...SUBMIT, summary: 'done' })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith({ type: 'submit', taskId: 't1', attemptId: 'a1', goalVersion: 1, result: 'done' }, 'r');
    });
});

describe('B-972: a missing body / result says what was received and gives a call to copy', () => {
    it('team_message without body or message', async () => {
        const { call, teamClient } = await connect();
        const res = await call('team_message', MESSAGE);
        expect(res.isError).toBe(true);
        expect(res.text).toContain(TEAM_MESSAGE_BODY_MISSING);
        expect(res.text).toContain('Fields received: requestId, taskId');
        expect(res.text).toContain('team_message {"requestId":"B-123-msg-1","taskId":"<task id from team_inspect>","body":"<your message text>"}');
        expect(teamClient.action).not.toHaveBeenCalled();
    });
    it('team_message with an empty body or only unknown fields', async () => {
        const { call } = await connect();
        const empty = await call('team_message', { ...MESSAGE, body: '' });
        expect(empty.isError).toBe(true);
        expect(empty.text).toContain('Missing body');
        expect(empty.text).toContain('Fields received: requestId, taskId, body');
        expect((await call('team_submit', { ...SUBMIT, result: '' })).text).toContain('Missing result');
    });
    it('team_submit without result or summary', async () => {
        const { call, teamClient } = await connect();
        const res = await call('team_submit', SUBMIT);
        expect(res.isError).toBe(true);
        expect(res.text).toContain(TEAM_SUBMIT_RESULT_MISSING);
        expect(res.text).toContain('Fields received: requestId, taskId, attemptId, goalVersion');
        expect(res.text).toContain('"result":"<what you did, PR / head SHA, verification>"');
        expect(teamClient.action).not.toHaveBeenCalled();
    });
    it('normalizeTeamToolArgs names the received fields', () => {
        expect(() => normalizeTeamToolArgs('message', { taskId: 't', foo: 1 })).toThrow('Fields received: taskId, foo');
        expect(() => normalizeTeamToolArgs('message', {})).toThrow('Fields received: none besides requestId');
    });
});

describe('B-972: the same refusal repeated tells the model to stop', () => {
    it(`the ${TEAM_REPEAT_STOP_AFTER}rd identical refusal in a row says STOP, the first two do not`, async () => {
        const { call } = await connect();
        const texts: string[] = [];
        for (let i = 0; i < 4; i++) texts.push((await call('team_message', { ...MESSAGE, requestId: `r${i}` })).text);
        expect(texts[0]).not.toContain('STOP');
        expect(texts[1]).not.toContain('STOP');
        expect(texts[2]).toContain('STOP retrying team_message');
        expect(texts[2]).toContain('Refused 3 times in a row');
        expect(texts[3]).toContain('Refused 4 times in a row');
    });
    it('an accepted call resets the count', async () => {
        const { call } = await connect();
        await call('team_message', MESSAGE);
        await call('team_message', MESSAGE);
        expect((await call('team_message', { ...MESSAGE, body: 'ok' })).isError).toBe(false);
        expect((await call('team_message', MESSAGE)).text).not.toContain('STOP');
    });
    it('a refusal of another tool starts its own count', async () => {
        const { call } = await connect();
        await call('team_message', MESSAGE);
        await call('team_message', MESSAGE);
        const other = await call('team_submit', SUBMIT);
        expect(other.text).not.toContain('STOP');
        expect((await call('team_message', MESSAGE)).text).not.toContain('Refused 3 times');
    });
    it('two servers do not share the count', async () => {
        const one = await connect();
        const two = await connect();
        await one.call('team_message', MESSAGE);
        await one.call('team_message', MESSAGE);
        expect((await two.call('team_message', MESSAGE)).text).not.toContain('STOP');
    });
});
