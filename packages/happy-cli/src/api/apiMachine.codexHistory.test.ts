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
const id = '01a0637d-bfdd-7423-8da5-3eea15ca8dd7';
const other = '01a0637e-5a8e-78a2-986e-d244ae69098f';

function rollout(threadId: string, prompt: string, cwd = '/work/app') {
    return [
        { type: 'session_meta', payload: { id: threadId, timestamp: '2026-09-01T00:00:00Z', cwd, originator: 'codex-tui', source: 'cli', cli_version: '0.154.0' } },
        { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ApiMachineClient codex-list-history RPC (B-464)', () => {
    let codexHome: string;

    beforeEach(async () => {
        codexHome = join(tmpdir(), `vh-codex-history-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        process.env = { ...originalEnv, CODEX_HOME: codexHome };
        const day = join(codexHome, 'sessions', '2026', '09', '01');
        await mkdir(day, { recursive: true });
        await writeFile(join(day, `rollout-2026-09-01T00-00-00-${id}.jsonl`), rollout(id, 'hello'));
        await writeFile(join(day, `rollout-2026-09-01T00-00-01-${other}.jsonl`), rollout(other, 'tracked', '/work/other'));
        await writeFile(join(codexHome, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Hello thread' }) + '\n');
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(codexHome, { recursive: true, force: true });
    });

    it('also excludes threads the daemon itself already drives (sessions.json)', async () => {
        const happyHome = join(codexHome, 'happy-home');
        await mkdir(happyHome, { recursive: true });
        await writeFile(join(happyHome, 'sessions.json'), JSON.stringify({
            sessions: {
                'happy-1': { savedAt: 0, metadata: { codexThreadId: id.toUpperCase() } },
                'happy-2': { savedAt: 0, metadata: { importedFromCodexThreadId: other } },
                'happy-3': { savedAt: 0, metadata: {} },
            },
        }));
        process.env.HAPPY_HOME_DIR = happyHome;
        vi.resetModules();

        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        const handler = handlersFrom(client).get('machine-1:codex-list-history')!;

        const result = await handler({});
        expect(result.entries).toEqual([]);
    });

    it('lists rollouts machine-wide with index names, honours exclude, limit and directory, validates directory', async () => {
        vi.resetModules();
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        const handler = handlersFrom(client).get('machine-1:codex-list-history');
        expect(handler).toBeTypeOf('function');

        const all = await handler!({});
        expect(all.type).toBe('success');
        expect(all.entries.map((e: any) => e.codexThreadId).sort()).toEqual([id, other].sort());
        expect(all.entries.find((e: any) => e.codexThreadId === id)).toMatchObject({ cwd: '/work/app', firstPrompt: 'hello', summary: 'Hello thread', entrypoint: 'cli' });

        const filtered = await handler!({ exclude: [other, 'not-a-uuid'], limit: 5 });
        expect(filtered.entries.map((e: any) => e.codexThreadId)).toEqual([id]);

        const limited = await handler!({ limit: 1 });
        expect(limited.entries).toHaveLength(1);
        expect(limited.truncated).toBe(true);

        const scoped = await handler!({ directory: '/work/other' });
        expect(scoped.entries.map((e: any) => e.codexThreadId)).toEqual([other]);

        const none = await handler!({ directory: '/nowhere' });
        expect(none.entries).toEqual([]);

        await expect(handler!({ directory: '' })).rejects.toThrow(/directory/);
        await expect(handler!({ directory: 42 })).rejects.toThrow(/directory/);
    });
});

describe('ApiMachineClient codex-import-session RPC (B-464)', () => {
    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.resetModules();
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    async function clientWith(spawnSession: any) {
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession, stopSession: vi.fn(), requestShutdown: vi.fn() });
        return handlersFrom(client).get('machine-1:codex-import-session')!;
    }

    it('spawns a Codex session that forks the source thread itself (no daemon-side copy)', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await clientWith(spawnSession);

        const result = await handler({ directory: '/work/app', codexThreadId: id.toUpperCase(), permissionMode: 'plan', title: 'Hello thread' });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/work/app',
            agent: 'codex',
            importCodexThreadId: id,
            permissionMode: 'plan',
            importTitle: 'Hello thread',
            approvedNewDirectoryCreation: false,
        }));
        expect(spawnSession.mock.calls[0][0]).not.toHaveProperty('resumeCodexThreadId');
    });

    it('passes spawn refusals through unchanged so the web can retry with directory approval', async () => {
        const spawnSession = vi.fn()
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/gone' })
            .mockResolvedValueOnce({ type: 'error', errorMessage: 'nope' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'happy-2' });
        const handler = await clientWith(spawnSession);

        expect(await handler({ directory: '/gone', codexThreadId: id })).toEqual({ type: 'requestToApproveDirectoryCreation', directory: '/gone' });
        expect(await handler({ directory: '/gone', codexThreadId: id })).toEqual({ type: 'error', errorMessage: 'nope' });
        expect(await handler({ directory: '/gone', codexThreadId: id, approvedNewDirectoryCreation: true })).toEqual({ type: 'success', sessionId: 'happy-2' });
        expect(spawnSession.mock.calls[2][0]).toMatchObject({ approvedNewDirectoryCreation: true });
    });

    it('validates its parameters before touching the daemon', async () => {
        const spawnSession = vi.fn();
        const handler = await clientWith(spawnSession);
        await expect(handler({ codexThreadId: id })).rejects.toThrow(/directory/);
        await expect(handler({ directory: '/work/app', codexThreadId: 'not-a-uuid' })).rejects.toThrow(/codexThreadId/);
        await expect(handler({ directory: '/work/app' })).rejects.toThrow(/codexThreadId/);
        expect(spawnSession).not.toHaveBeenCalled();
    });
});

describe('daemon spawn env for a Codex import (B-464)', () => {
    it('exports HAPPY_IMPORT_CODEX_THREAD_ID only for a UUID and never together with a resume flag', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8');
        expect(source).toContain('if (options.importCodexThreadId && UUID_RE.test(options.importCodexThreadId)) {');
        expect(source).toContain('extraEnv.HAPPY_IMPORT_CODEX_THREAD_ID = options.importCodexThreadId;');
        // the `--resume` fragment is derived from resumeCodexThreadId alone
        expect(source).not.toMatch(/importCodexThreadId[^\n]*--resume/);
    });
});
