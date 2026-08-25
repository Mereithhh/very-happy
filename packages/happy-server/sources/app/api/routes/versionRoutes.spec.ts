import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { versionRoutes } from './versionRoutes';
import type { Fastify } from '../types';

const previousRecommended = process.env.CLI_RECOMMENDED_VERSION;
const previousMinimum = process.env.CLI_MINIMUM_VERSION;

afterEach(() => {
    if (previousRecommended === undefined) delete process.env.CLI_RECOMMENDED_VERSION;
    else process.env.CLI_RECOMMENDED_VERSION = previousRecommended;
    if (previousMinimum === undefined) delete process.env.CLI_MINIMUM_VERSION;
    else process.env.CLI_MINIMUM_VERSION = previousMinimum;
});

describe('GET /v1/version/cli', () => {
    it('is anonymous and returns only inert version policy data', async () => {
        process.env.CLI_RECOMMENDED_VERSION = '0.2.68';
        process.env.CLI_MINIMUM_VERSION = '0.2.34';
        const app = fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        versionRoutes(app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify);
        const response = await app.inject({ method: 'GET', url: '/v1/version/cli' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            recommendedVersion: '0.2.68',
            minimumVersion: '0.2.34',
            source: 'configured',
        });
        expect(response.json()).not.toHaveProperty('installCommand');
        await app.close();
    });
});
