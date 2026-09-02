import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

const originalEnv = { ...process.env };
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('ApiMachineClient claude-list-history RPC (B-290)', () => {
    let configDir: string;

    beforeEach(async () => {
        configDir = join(tmpdir(), `vh-claude-history-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        process.env = { ...originalEnv, CLAUDE_CONFIG_DIR: configDir };
        const dir = join(configDir, 'projects', '-work-app');
        await mkdir(dir, { recursive: true });
        const line = (text: string) => JSON.stringify({ type: 'user', cwd: '/work/app', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
        await writeFile(join(dir, `${id}.jsonl`), line('hello'));
        await writeFile(join(dir, `${other}.jsonl`), line('tracked'));
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(configDir, { recursive: true, force: true });
    });

    it('lists transcripts machine-wide, honours exclude and limit, and validates directory', async () => {
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        const handler = handlersFrom(client).get('machine-1:claude-list-history');
        expect(handler).toBeTypeOf('function');

        const all = await handler!({});
        expect(all.type).toBe('success');
        expect(all.entries.map((e: any) => e.claudeSessionId).sort()).toEqual([id, other].sort());
        expect(all.entries[0]).toMatchObject({ cwd: '/work/app' });

        const filtered = await handler!({ exclude: [other, 'not-a-uuid'], limit: 5 });
        expect(filtered.entries.map((e: any) => e.claudeSessionId)).toEqual([id]);

        const scoped = await handler!({ directory: '/work/app', limit: 1 });
        expect(scoped.entries).toHaveLength(1);
        expect(scoped.truncated).toBe(true);

        const none = await handler!({ directory: '/nowhere' });
        expect(none.entries).toEqual([]);

        await expect(handler!({ directory: '' })).rejects.toThrow(/directory/);
        await expect(handler!({ directory: 42 })).rejects.toThrow(/directory/);
    });
});
