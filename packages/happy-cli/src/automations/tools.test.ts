import { describe, expect, it, vi } from 'vitest';
vi.mock('./client', () => ({ authenticatedAutomationsClient: vi.fn(), automationRunIdFromEnv: (env: NodeJS.ProcessEnv) => env.VH_AUTOMATION_RUN_ID }));
import { AUTOMATION_TOOL_NAMES, AUTOMATION_TOOL_SCHEMAS, executeAutomationTool, registerAutomationTools } from './tools';

function fakeClient() {
    return {
        list: vi.fn().mockResolvedValue([{ id: 'a1', name: 'nightly' }]),
        get: vi.fn().mockResolvedValue({ id: 'a1', name: 'nightly', version: 3 }),
        getByName: vi.fn().mockResolvedValue({ id: 'a1', name: 'nightly', version: 3 }),
        create: vi.fn().mockResolvedValue({ id: 'a2' }),
        update: vi.fn().mockResolvedValue({ id: 'a1', version: 4 }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
        pause: vi.fn().mockResolvedValue({ id: 'a1', status: 'paused' }),
        resume: vi.fn().mockResolvedValue({ id: 'a1', status: 'active' }),
        run: vi.fn().mockResolvedValue({ id: 'r1' }),
        fire: vi.fn().mockResolvedValue({ run: { id: 'r2' }, deduplicated: false }),
        runs: vi.fn().mockResolvedValue([]),
        getRun: vi.fn(), cancel: vi.fn(), ack: vi.fn().mockResolvedValue({ id: 'r1', needsAttention: false }),
        report: vi.fn().mockResolvedValue({ id: 'r1', status: 'done' }),
        claim: vi.fn(), stickies: vi.fn(), putSticky: vi.fn(), deleteSticky: vi.fn(),
    };
}

describe('automation_* tools', () => {
    it('registers the full surface with one schema per tool and JSON results', async () => {
        const calls = new Map<string, Function>();
        const specs = new Map<string, any>();
        const execute = vi.fn().mockResolvedValue({ ok: 1 });
        registerAutomationTools({ registerTool: (name: string, spec: any, handler: Function) => { calls.set(name, handler); specs.set(name, spec); } } as any, execute);
        expect([...calls.keys()]).toEqual(AUTOMATION_TOOL_NAMES);
        expect(specs.get('automation_list').annotations.readOnlyHint).toBe(true);
        expect(specs.get('automation_delete').annotations.destructiveHint).toBe(true);
        expect(specs.get('automation_create').annotations.idempotentHint).toBe(false);
        for (const name of AUTOMATION_TOOL_NAMES) expect(Object.keys(AUTOMATION_TOOL_SCHEMAS[name].inputSchema)).toBeDefined();
        const result = await calls.get('automation_fire')!({ name: 'nightly' });
        expect(execute).toHaveBeenCalledWith('automation_fire', { name: 'nightly' });
        expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":1}' }], isError: false });
        execute.mockRejectedValueOnce(new Error('boom'));
        expect(await calls.get('automation_ack')!({ runId: 'r' })).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
    });
    it('defaults the machine to this one and resolves names before mutating', async () => {
        const client = fakeClient();
        const context = { client: client as any, machineId: 'm-this', env: { VH_AUTOMATION_RUN_ID: 'run-env' } };
        await executeAutomationTool('automation_create', { name: 'x', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' }, paused: true }, context);
        expect(client.create).toHaveBeenCalledWith({ name: 'x', machineId: 'm-this', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' }, status: 'paused' });
        await executeAutomationTool('automation_create', { name: 'y', machineId: 'other', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } }, context);
        expect(client.create).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'other' }));
        await expect(executeAutomationTool('automation_create', { name: 'z', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } }, { ...context, machineId: undefined })).rejects.toThrow('not registered');
        await executeAutomationTool('automation_update', { name: 'nightly', version: 3, newName: 'daily', machineId: 'this' }, context);
        expect(client.update).toHaveBeenCalledWith('a1', { version: 3, name: 'daily', machineId: 'm-this' });
        await executeAutomationTool('automation_pause', { id: 'a1' }, context);
        expect(client.get).toHaveBeenCalledWith('a1');
        expect(client.pause).toHaveBeenCalledWith('a1');
        await expect(executeAutomationTool('automation_resume', {}, context)).rejects.toThrow('name or id');
        expect(await executeAutomationTool('automation_delete', { name: 'nightly' }, context)).toEqual({ deleted: true, id: 'a1', name: 'nightly' });
        await executeAutomationTool('automation_runs', { name: 'nightly', attention: true }, context);
        expect(client.runs).toHaveBeenCalledWith({ automationId: 'a1', status: undefined, attention: true, limit: undefined });
        await executeAutomationTool('automation_list', { machineId: 'this' }, context);
        expect(client.list).toHaveBeenCalledWith('m-this');
    });
    it('reports the environment run without a claimId when runId is omitted', async () => {
        const client = fakeClient();
        const context = { client: client as any, machineId: 'm', env: { VH_AUTOMATION_RUN_ID: 'run-env' } };
        await executeAutomationTool('automation_report', { status: 'done', summary: 'ok' }, context);
        expect(client.report).toHaveBeenCalledWith('run-env', { status: 'done', summary: 'ok' });
        await executeAutomationTool('automation_report', { runId: 'explicit', status: 'failed', error: 'e', needsAttention: true, attentionReason: 'r' }, context);
        expect(client.report).toHaveBeenLastCalledWith('explicit', { status: 'failed', error: 'e', needsAttention: true, attentionReason: 'r' });
        await expect(executeAutomationTool('automation_report', { status: 'done' }, { ...context, env: {} })).rejects.toThrow('No run id');
    });
});
