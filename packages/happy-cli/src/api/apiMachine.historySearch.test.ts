import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

const originalEnv = { ...process.env };
const claudeId = '11111111-2222-4333-8444-555555555555';

describe('ApiMachineClient history-search RPC (B-549)', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'vh-hs-rpc-'));
        const claudeHome = join(root, 'moved-claude');
        const proj = join(claudeHome, 'projects', '-work-app');
        await mkdir(proj, { recursive: true });
        await writeFile(join(proj, `${claudeId}.jsonl`),
            JSON.stringify({ type: 'user', cwd: '/work/app', message: { content: 'where is the relay drain timeout' } }) + '\n');
        process.env = { ...originalEnv, HAPPY_HOME_DIR: join(root, 'happy') };
        vi.resetModules();
        // The roots come from the agent-home resolution (B-478), not from a
        // hard-coded ~/.claude: a moved CLAUDE_CONFIG_DIR is what gets indexed.
        vi.doMock('@/agentHome', async (importOriginal) => ({
            ...(await importOriginal<typeof import('@/agentHome')>()),
            refreshAgentHomes: vi.fn(async () => ({
                claudeConfigDir: { path: claudeHome, source: 'login-shell' },
                codexHome: { path: join(root, 'codex'), source: 'default' },
            })),
        }));
    });

    afterEach(async () => {
        vi.doUnmock('@/agentHome');
        process.env = { ...originalEnv };
        await rm(root, { recursive: true, force: true });
    });

    it('is registered, answers immediately while indexing, then finds the conversation in the resolved agent home', async () => {
        const { ApiMachineClient } = await import('./apiMachine');
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        const handler = (client as any).rpcHandlerManager.handlers.get('machine-1:history-search');
        expect(handler).toBeTypeOf('function');

        const first = await handler({ query: 'drain timeout' });
        expect(first.type).toBe('success');
        expect(['indexing', 'ready']).toContain(first.status.state);

        let out = first;
        for (let i = 0; i < 50 && out.status.state !== 'ready'; i++) {
            await new Promise((r) => setTimeout(r, 20));
            out = await handler({ query: 'drain timeout' });
        }
        expect(out.status.state).toBe('ready');
        expect(out.results).toEqual([expect.objectContaining({ agent: 'claude', id: claudeId, cwd: '/work/app' })]);
        // The index lives under HAPPY_HOME.
        expect((await stat(join(root, 'happy', 'history-search'))).isDirectory()).toBe(true);

        const cleared = await handler({ op: 'clear' });
        expect(cleared.status.state).toBe('idle');
        await expect(stat(join(root, 'happy', 'history-search'))).rejects.toThrow();
    });

    it('stamps the capability flag at connect with the same clock reading as startedAt', async () => {
        const source = await readFile(join(__dirname, 'apiMachine.ts'), 'utf-8');
        const start = source.indexOf('startedAt: now,');
        const restamp = source.slice(start, source.indexOf('closedTerminals: this.webTerminal.getClosedTerminals()', start));
        expect(restamp).toContain('historySearch: { rpcAvailable: true, detectedAt: now },');
    });
});
