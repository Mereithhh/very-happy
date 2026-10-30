import fastify from 'fastify';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { BUNDLED_LATEST_MODELS } from '@slopus/happy-wire';
import { createLatestModelsSource, modelRoutes } from './modelRoutes';
import type { Fastify } from '../types';

async function serve(source: ReturnType<typeof createLatestModelsSource>) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    modelRoutes(app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify, source);
    return app;
}

const opus6 = {
    version: 2,
    agents: { claude: { tier: 'opus', pattern: '^claude-opus-(\\d+)(?:-(\\d{1,2}))?$', models: [{ model: 'claude-opus-6', requires: { capability: 'claude-opus-6-v1' } }] } },
};

describe('GET /v1/models/latest', () => {
    it('is anonymous, cacheable and serves the bundled table by default', async () => {
        const app = await serve(createLatestModelsSource({ file: null }));
        const response = await app.inject({ method: 'GET', url: '/v1/models/latest' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=300');
        expect(response.json()).toEqual({ table: BUNDLED_LATEST_MODELS, source: 'bundled' });
        await app.close();
    });

    it('serves an operator file and picks up edits without a restart', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vh-models-'));
        const file = join(dir, 'latest.json');
        writeFileSync(file, JSON.stringify(BUNDLED_LATEST_MODELS));
        let clock = 0;
        const app = await serve(createLatestModelsSource({ file, now: () => clock, warn: () => {} }));
        expect((await app.inject({ method: 'GET', url: '/v1/models/latest' })).json().source).toBe('configured');

        writeFileSync(file, JSON.stringify(opus6));
        utimesSync(file, new Date(), new Date(Date.now() + 5_000));
        // Within the recheck window the cached copy is served.
        clock = 10_000;
        expect((await app.inject({ method: 'GET', url: '/v1/models/latest' })).json().table.version).toBe(BUNDLED_LATEST_MODELS.version);
        clock = 31_000;
        const body = (await app.inject({ method: 'GET', url: '/v1/models/latest' })).json();
        expect(body).toMatchObject({ source: 'configured', table: { version: 2 } });
        expect(body.table.agents.claude.models[0].model).toBe('claude-opus-6');
        await app.close();
    });

    it('an invalid or missing file falls back to the bundled table and warns', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'vh-models-'));
        const file = join(dir, 'latest.json');
        writeFileSync(file, JSON.stringify({ version: 1, agents: { codex: { tier: 'sol', pattern: '(', models: [] } } }));
        const warnings: string[] = [];
        const app = await serve(createLatestModelsSource({ file, warn: (m) => warnings.push(m) }));
        expect((await app.inject({ method: 'GET', url: '/v1/models/latest' })).json()).toEqual({ table: BUNDLED_LATEST_MODELS, source: 'bundled' });
        expect(warnings).toHaveLength(1);
        await app.close();

        const missing = await serve(createLatestModelsSource({ file: join(dir, 'nope.json'), warn: (m) => warnings.push(m) }));
        expect((await missing.inject({ method: 'GET', url: '/v1/models/latest' })).json().source).toBe('bundled');
        expect(warnings).toHaveLength(2);
        await missing.close();
    });
});
