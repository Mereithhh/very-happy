import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { storeMock } = vi.hoisted(() => ({
    storeMock: {
        listPromptQueue: vi.fn(),
        enqueuePrompt: vi.fn(),
        updatePromptContent: vi.fn(),
        removePrompt: vi.fn(),
        reorderPromptQueue: vi.fn(),
        dispatchPromptQueueHead: vi.fn(),
    },
}));
vi.mock('@/app/promptQueue/store', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/promptQueue/store')>();
    return { ...actual, ...storeMock };
});

import { PromptQueueError } from '@/app/promptQueue/store';
import { promptQueueRoutes } from './promptQueueRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'account-1'; });
    promptQueueRoutes(typed);
    await typed.ready();
    return typed;
}

describe('B-509 prompt queue routes', () => {
    beforeEach(() => { for (const fn of Object.values(storeMock)) fn.mockReset(); });

    it('routes every verb to the account-scoped store and maps store errors to their status', async () => {
        const app = await createApp();
        storeMock.listPromptQueue.mockResolvedValue([]);
        expect((await app.inject({ method: 'GET', url: '/v1/sessions/s1/prompt-queue' })).json()).toEqual({ items: [] });
        expect(storeMock.listPromptQueue).toHaveBeenCalledWith('account-1', 's1');

        storeMock.enqueuePrompt.mockResolvedValue({ item: { id: 'i1' }, items: [], created: true });
        const post = await app.inject({ method: 'POST', url: '/v1/sessions/s1/prompt-queue', payload: { localId: 'l1', content: 'YQ==' } });
        expect(post.statusCode).toBe(200);
        expect(storeMock.enqueuePrompt).toHaveBeenCalledWith('account-1', 's1', { localId: 'l1', content: 'YQ==' });

        // Static segments win over `:itemId`.
        storeMock.reorderPromptQueue.mockResolvedValue({ items: [] });
        await app.inject({ method: 'PUT', url: '/v1/sessions/s1/prompt-queue/order', payload: { ids: ['b', 'a'] } });
        expect(storeMock.reorderPromptQueue).toHaveBeenCalledWith('account-1', 's1', ['b', 'a']);
        storeMock.dispatchPromptQueueHead.mockResolvedValue({ dispatched: null, remaining: 0 });
        expect((await app.inject({ method: 'POST', url: '/v1/sessions/s1/prompt-queue/dispatch' })).json()).toEqual({ dispatched: null, remaining: 0 });
        expect(storeMock.updatePromptContent).not.toHaveBeenCalled();

        storeMock.updatePromptContent.mockRejectedValue(new PromptQueueError('prompt_queue_item_gone', 404));
        const patch = await app.inject({ method: 'PATCH', url: '/v1/sessions/s1/prompt-queue/i1', payload: { content: 'Yg==' } });
        expect(patch.statusCode).toBe(404);
        expect(patch.json()).toEqual({ error: 'prompt_queue_item_gone' });

        storeMock.removePrompt.mockResolvedValue({ removed: false, items: [] });
        expect((await app.inject({ method: 'DELETE', url: '/v1/sessions/s1/prompt-queue/i1' })).json()).toEqual({ removed: false, items: [] });

        storeMock.enqueuePrompt.mockRejectedValue(new PromptQueueError('prompt_queue_full', 409, { limit: 50, count: 50 }));
        const full = await app.inject({ method: 'POST', url: '/v1/sessions/s1/prompt-queue', payload: { localId: 'l2', content: 'YQ==' } });
        expect(full.statusCode).toBe(409);
        expect(full.json()).toEqual({ error: 'prompt_queue_full', limit: 50, count: 50 });

        // Body validation is strict: an empty content never reaches the store.
        const invalid = await app.inject({ method: 'POST', url: '/v1/sessions/s1/prompt-queue', payload: { localId: 'l3', content: '' } });
        expect(invalid.statusCode).toBe(400);
        await app.close();
    });
});
