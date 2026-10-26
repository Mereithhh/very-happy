import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({ db: { $queryRaw: async () => 1, $metrics: { prometheus: async () => '' } } }));

import { enableMonitoring } from './utils/enableMonitoring';
import { versionRoutes } from './routes/versionRoutes';
import { enableResponseCompression } from './responseCompression';
import { createMetricsServer } from '@/app/monitoring/metrics';
import type { Fastify } from './types';

// B-820: the image now ships the locked fastify (5.8.5) instead of whatever
// `pnpm deploy --legacy` re-resolved. On that version an async handler that
// calls reply.send() without returning it, behind two async onSend hooks (the
// HTML/manifest injector and B-818 compression), writes headers twice and
// throws ERR_HTTP_HEADERS_SENT out of the request, killing the process on the
// first /health probe. app.inject() does not reproduce it; a real socket does.

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function listen(app: ReturnType<typeof fastify>) {
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
}

function apiLikeApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    process.env.HTTP_COMPRESSION = 'on';
    enableResponseCompression(app);
    // Stands in for api.ts's HTML/manifest injection hook: async, passthrough for JSON.
    app.addHook('onSend', async (_request, _reply, payload) => payload);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    enableMonitoring(typed);
    versionRoutes(typed);
    return app;
}

async function hitTwice(url: string, init?: RequestInit) {
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) {
        const response = await fetch(url, init);
        await response.text();
        statuses.push(response.status);
    }
    // Give a second, late header write the chance to throw.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return statuses;
}

describe('async handlers behind async onSend hooks (locked fastify)', () => {
    it('API /health, /v1/version/cli and POST /v1/version answer without a double write', async () => {
        const base = await listen(apiLikeApp());
        expect(await hitTwice(`${base}/health`)).toEqual([200, 200]);
        expect(await hitTwice(`${base}/v1/version/cli`)).toEqual([200, 200]);
        for (const platform of ['ios', 'android', 'web']) {
            expect(await hitTwice(`${base}/v1/version`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ platform, version: '1.0.0', app_id: 'x' }),
            })).toEqual([200, 200]);
        }
    });

    it('metrics server /health and /metrics answer without a double write', async () => {
        const app = await createMetricsServer();
        app.addHook('onSend', async (_request, _reply, payload) => payload);
        app.addHook('onSend', async (_request, _reply, payload) => payload);
        const base = await listen(app);
        expect(await hitTwice(`${base}/health`)).toEqual([200, 200]);
        expect(await hitTwice(`${base}/metrics`)).toEqual([200, 200]);
    });
});
