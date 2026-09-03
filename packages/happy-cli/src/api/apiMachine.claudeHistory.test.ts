import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
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

describe('ApiMachineClient claude-import-session RPC (B-290)', () => {
    let configDir: string;
    let projectDir: string;

    beforeEach(async () => {
        configDir = join(tmpdir(), `vh-claude-import-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        process.env = { ...originalEnv, CLAUDE_CONFIG_DIR: configDir };
        projectDir = join(configDir, 'projects', '-work-app');
        await mkdir(projectDir, { recursive: true });
        await writeFile(
            join(projectDir, `${id}.jsonl`),
            JSON.stringify({ type: 'user', cwd: '/work/app', message: { role: 'user', content: 'hello' } }) + '\n',
        );
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(configDir, { recursive: true, force: true });
    });

    async function transcriptsInProject(): Promise<string[]> {
        return (await readdir(projectDir)).filter((n) => n.endsWith('.jsonl')).sort();
    }

    async function clientWith(spawnSession: any) {
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession, stopSession: vi.fn(), requestShutdown: vi.fn() });
        return handlersFrom(client).get('machine-1:claude-import-session')!;
    }

    it('forks the transcript and spawns a Claude session that resumes the copy', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await clientWith(spawnSession);

        const result = await handler({ directory: '/work/app', claudeSessionId: id, permissionMode: 'plan' });

        expect(result.type).toBe('success');
        expect(result.sessionId).toBe('happy-1');
        expect(result.newClaudeSessionId).not.toBe(id);
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/work/app',
            agent: 'claude',
            resumeClaudeSessionId: result.newClaudeSessionId,
            importedFromClaudeSessionId: id,
            permissionMode: 'plan',
            approvedNewDirectoryCreation: false,
        }));
        // original + copy both on disk; the source is never moved
        expect(await transcriptsInProject()).toHaveLength(2);
    });

    it('discards the copy when the spawn fails, so a retry cannot pile up orphans', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'error', errorMessage: 'boom' });
        const handler = await clientWith(spawnSession);

        const result = await handler({ directory: '/work/app', claudeSessionId: id });

        expect(result).toEqual({ type: 'error', errorMessage: 'boom' });
        expect(await transcriptsInProject()).toEqual([`${id}.jsonl`]);
    });

    it('discards the copy when the spawn throws', async () => {
        const spawnSession = vi.fn().mockRejectedValue(new Error('daemon gone'));
        const handler = await clientWith(spawnSession);

        await expect(handler({ directory: '/work/app', claudeSessionId: id })).rejects.toThrow('daemon gone');
        expect(await transcriptsInProject()).toEqual([`${id}.jsonl`]);
    });

    it('forwards the directory-creation request without keeping the copy, and honours the approval on retry', async () => {
        const spawnSession = vi.fn()
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/work/app' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'happy-2' });
        const handler = await clientWith(spawnSession);

        const first = await handler({ directory: '/work/app', claudeSessionId: id });
        expect(first).toEqual({ type: 'requestToApproveDirectoryCreation', directory: '/work/app' });
        expect(await transcriptsInProject()).toEqual([`${id}.jsonl`]);

        const second = await handler({ directory: '/work/app', claudeSessionId: id, approvedNewDirectoryCreation: true });
        expect(second.type).toBe('success');
        expect(spawnSession).toHaveBeenLastCalledWith(expect.objectContaining({ approvedNewDirectoryCreation: true }));
        expect(await transcriptsInProject()).toHaveLength(2);
    });

    it('validates its parameters and reports a missing source file', async () => {
        const handler = await clientWith(vi.fn());
        await expect(handler({ claudeSessionId: id })).rejects.toThrow(/directory/);
        await expect(handler({ directory: '/work/app', claudeSessionId: 'nope' })).rejects.toThrow(/UUID/);
        await expect(handler({ directory: '/work/app', claudeSessionId: other })).rejects.toThrow(/not found/);
    });
});
