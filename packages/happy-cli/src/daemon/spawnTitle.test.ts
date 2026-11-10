import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-916b (project log #13): a spawned session can be given its title. The
 * client sends it twice — `importTitle` (this daemon) and HAPPY_IMPORT_TITLE
 * (an older daemon strips the key but passes env through) — and the daemon's
 * real `/spawn-session` route hands it to spawnSession as `importTitle`,
 * which run.ts turns into metadata.summary (B-294 path).
 */
const mocks = vi.hoisted(() => ({ readDaemonState: vi.fn(), clearDaemonState: vi.fn() }));
vi.mock('@/persistence', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/persistence')>()), readDaemonState: mocks.readDaemonState, clearDaemonState: mocks.clearDaemonState }));

import { spawnDaemonSession } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { parseSpawnArgs } from '@/commands/spawn';

describe('spawnDaemonSession title', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.readDaemonState.mockReset(); });
    const bodyOf = async (opts: Parameters<typeof spawnDaemonSession>[2]) => {
        mocks.readDaemonState.mockResolvedValue({ pid: 4242, httpPort: 9999, startTime: 'now', startedWithCliVersion: '1', controlToken: 't' });
        vi.spyOn(process, 'kill').mockImplementation(() => true);
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, sessionId: 's' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        await spawnDaemonSession('/repo', undefined, opts);
        return JSON.parse(fetchMock.mock.calls[0][1].body);
    };

    it('sends importTitle and the HAPPY_IMPORT_TITLE fallback, sanitized for env expansion', async () => {
        const body = await bodyOf({ title: '  Fix ${HOME}\nlogin  ', environmentVariables: { A: '1' } });
        expect(body.importTitle).toBe('Fix $ {HOME} login');
        expect(body.environmentVariables).toEqual({ HAPPY_IMPORT_TITLE: 'Fix $ {HOME} login', A: '1' });
    });

    it('lets a caller\'s own HAPPY_IMPORT_TITLE win and sends nothing without a title', async () => {
        expect((await bodyOf({ title: 'T', environmentVariables: { HAPPY_IMPORT_TITLE: 'mine' } })).environmentVariables).toEqual({ HAPPY_IMPORT_TITLE: 'mine' });
        const none = await bodyOf({ environmentVariables: { A: '1' } });
        expect(none.importTitle).toBeUndefined();
        expect(none.environmentVariables).toEqual({ A: '1' });
        expect((await bodyOf({ title: '   ' })).importTitle).toBeUndefined();
    });
});

describe('/spawn-session importTitle', () => {
    const controlToken = 'test-control-token-with-at-least-256-bits-of-material';
    const spawnSession = vi.fn(async (_options: any) => ({ type: 'success' as const, sessionId: 'new' }));
    let port: number;
    let stop: () => Promise<void>;
    beforeAll(async () => {
        const server = await startDaemonControlServer({
            controlToken, getChildren: () => [], stopSession: () => false, spawnSession: spawnSession as any,
            requestShutdown: () => { }, onHappySessionWebhook: () => { }, pushClipboard: () => ({ delivered: false, truncated: false, totalBytes: 0 }),
        } as any);
        port = server.port; stop = server.stop;
    });
    afterAll(async () => { await stop(); });
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/spawn-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` }, body: JSON.stringify(body) });

    it('hands the title to spawnSession and leaves it out when absent', async () => {
        expect((await post({ directory: '/repo', importTitle: 'Do Y' })).status).toBe(200);
        expect(spawnSession.mock.calls[0][0]).toMatchObject({ directory: '/repo', importTitle: 'Do Y' });
        expect((await post({ directory: '/repo' })).status).toBe(200);
        expect('importTitle' in spawnSession.mock.calls[1][0]).toBe(false);
    });
});

describe('very-happy spawn --title', () => {
    it('parses a title and rejects an empty one', () => {
        expect(parseSpawnArgs(['--dir', '/x', '--title', 'Release notes']).title).toBe('Release notes');
        expect(parseSpawnArgs(['--dir', '/x']).title).toBeUndefined();
        expect(() => parseSpawnArgs(['--dir', '/x', '--title'])).toThrow('--title requires a value');
        expect(() => parseSpawnArgs(['--dir', '/x', '--title', '  '])).toThrow('--title must contain visible text');
    });
});
