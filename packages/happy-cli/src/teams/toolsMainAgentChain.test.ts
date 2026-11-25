import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDispatchGate } from '@/assistant/gates/dispatchGate';
import { withToolOutputCaps } from '@/assistant/toolCaps';
import { withNonOwnerProvenance } from '@/assistant/sendGuard';
import { withOwnerOnlyTools } from '@/assistant/turnOrigin';
import { registerTeamsTools, withRequiredSchema } from './tools';

/**
 * B-972: the wrapper order of startHappyServer for the main agent (server → required schema → caps → provenance →
 * owner-only → dispatch gate), and the bare registrar of `very-happy mcp` / the Codex stdio bridge, over a real MCP client.
 */
async function connect(kind: 'mainAgent' | 'bare') {
    const team = { id: 't', name: 'T', machineId: 'm', version: 1, createdAt: 1, bots: [], messages: [], operations: [], tasks: [] };
    const teamClient = { initialize: vi.fn(), inspect: vi.fn(), action: vi.fn().mockResolvedValue({ team }) };
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const inner = withRequiredSchema(server as any);
    if (kind === 'mainAgent') {
        const gate = createDispatchGate({ pendingDir: mkdtempSync(join(tmpdir(), 'b972-')), board: null, classify: null, approvalLink: (id: string) => id } as any);
        const mcp = withOwnerOnlyTools(withNonOwnerProvenance(withToolOutputCaps(inner), () => true), () => true);
        registerTeamsTools(gate.wrap(mcp), 'test-session', teamClient as any);
    } else registerTeamsTools(inner, 'test-session', teamClient as any);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const schema = async (name: string) => (await client.listTools()).tools.find(t => t.name === name)!.inputSchema as any;
    const call = async (name: string, args: Record<string, unknown>) => {
        const res: any = await client.callTool({ name, arguments: args });
        return { isError: Boolean(res.isError), text: String(res.content?.[0]?.text ?? '') };
    };
    return { teamClient, schema, call };
}
const MESSAGE = { requestId: 'r', taskId: 't1' };
const SUBMIT = { requestId: 'r', taskId: 't1', attemptId: 'a1', goalVersion: 1 };

describe.each(['mainAgent', 'bare'] as const)('B-972: team tools on the %s registrar chain', (kind) => {
    const extra: Record<string, unknown> = kind === 'mainAgent' ? { risk: 'none' } : {};
    it('team_message / team_submit list body / result as required and keep the wrappers\' fields', async () => {
        const { schema } = await connect(kind);
        const message = await schema('team_message');
        expect(message.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'body']));
        expect(message.required).not.toContain('message');
        expect(Object.keys(message.properties)).toEqual(expect.arrayContaining(['body', 'message', 'recipientBotId', 'to']));
        const submit = await schema('team_submit');
        expect(submit.required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'attemptId', 'goalVersion', 'result']));
        expect(submit.required).not.toContain('summary');
        if (kind === 'mainAgent') {
            expect(message.properties.risk).toBeDefined();
            expect(message.required).toContain('risk');
            // team_submit is not a dispatch tool: the gate adds no `risk` to it.
            expect(submit.properties.risk).toBeUndefined();
        } else expect(message.properties.risk).toBeUndefined();
    });
    it('body, the alias alone, and neither', async () => {
        const { call, teamClient } = await connect(kind);
        expect((await call('team_message', { ...MESSAGE, body: 'hi', ...extra })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'message', taskId: 't1', body: 'hi' }), 'r');
        expect((await call('team_message', { ...MESSAGE, message: 'hi', to: 'lead', ...extra })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'message', body: 'hi', recipientBotId: 'lead' }), 'r');
        expect((await call('team_submit', { ...SUBMIT, result: 'done', ...extra })).isError).toBe(false);
        expect((await call('team_submit', { ...SUBMIT, summary: 'done', ...extra })).isError).toBe(false);
        expect(teamClient.action).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'submit', result: 'done' }), 'r');
        const missing = await call('team_message', { ...MESSAGE, ...extra });
        expect(missing.isError).toBe(true);
        expect(missing.text).toContain('Missing body');
        expect(missing.text).toContain('team_message {"requestId"');
    });
    it('a non-string body / result: the SDK refusal the model sees carries the example too', async () => {
        const { call, teamClient } = await connect(kind);
        const before = teamClient.action.mock.calls.length;
        const numeric = await call('team_message', { ...MESSAGE, body: 42, ...extra });
        expect(numeric.isError).toBe(true);
        expect(numeric.text).toContain('body must be a string');
        expect(numeric.text).toContain('team_message {"requestId"');
        const result = await call('team_submit', { ...SUBMIT, result: { a: 1 }, ...extra });
        expect(result.text).toContain('result must be a string');
        expect(result.text).toContain('team_submit {"requestId"');
        expect(teamClient.action.mock.calls.length).toBe(before);
    });
    it('the other team tools keep their schema', async () => {
        const { schema } = await connect(kind);
        expect((await schema('team_accept')).required).toEqual(expect.arrayContaining(['requestId', 'taskId', 'attemptId', 'goalVersion']));
        expect((await schema('team_delegate')).required).toEqual(expect.arrayContaining(['requestId', 'goal', 'acceptance']));
        expect((await schema('team_inspect')).required ?? []).toEqual([]);
    });
});

describe('B-972: every entry point wraps the raw server', () => {
    it('startHappyServer, `very-happy mcp` and the Codex stdio bridge register team tools through withRequiredSchema', async () => {
        const { readFileSync } = await import('node:fs');
        const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
        expect(src('claude/utils/startHappyServer.ts')).toContain('const inner = withRequiredSchema(server);');
        expect(src('commands/mcp.ts')).toContain('registerTeamsTools(withRequiredSchema(server), process.env.HAPPY_SESSION_ID);');
        expect(src('codex/happyMcpStdioBridge.ts')).toContain('registerTeamsTools(withRequiredSchema(server), undefined, {');
    });
});
