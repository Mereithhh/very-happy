import { PassThrough } from 'node:stream';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelayServer } from '@/relay';
import { enableMonitoring } from './enableMonitoring';

vi.mock('@/storage/db', () => ({ db: { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) } }));

// B-827: probe traffic was nearly all of relay-us's 5.6 GB container log.
function capture() {
    const stream = new PassThrough();
    const lines: Array<{ msg?: string; req?: { url?: string }; level?: number }> = [];
    stream.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(JSON.parse(line));
    });
    return { stream, lines };
}

const opened: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
    for (const app of opened.splice(0)) await app.close();
});

describe('health routes stay out of the access log', () => {
    it('server /health logs no info request lines while other routes still do', async () => {
        const { stream, lines } = capture();
        const app = fastify({ logger: { stream } });
        opened.push(app);
        enableMonitoring(app as never);
        app.get('/v1/other', async () => ({ ok: true }));
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/v1/other' })).statusCode).toBe(200);
        await new Promise((resolve) => setImmediate(resolve));
        const incoming = lines.filter((line) => line.msg === 'incoming request').map((line) => line.req?.url);
        expect(incoming).toEqual(['/v1/other']);
        expect(lines.filter((line) => line.msg === 'request completed')).toHaveLength(1);
    });

    it('relay /health logs no info request lines while other routes still do', async () => {
        const { stream, lines } = capture();
        const relay = await startRelayServer({
            RELAY_ID: 'sin', RELAY_REGION: 'Singapore', RELAY_TOKEN_SECRET: 'regional-relay-integration-secret',
            HOST: '127.0.0.1', PORT: '0',
        } as NodeJS.ProcessEnv, { logStream: stream });
        opened.push({ close: async () => { relay.io.close(); await relay.app.close(); } });
        expect((await relay.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        expect((await relay.app.inject({ method: 'GET', url: '/missing' })).statusCode).toBe(404);
        await new Promise((resolve) => setImmediate(resolve));
        const incoming = lines.filter((line) => line.msg === 'incoming request').map((line) => line.req?.url);
        expect(incoming).toEqual(['/missing']);
    });
});
