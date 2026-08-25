import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { row, dbMock, emitArchived, emitEphemeral, discardPending } = vi.hoisted(() => {
    const row: { id: string; accountId: string; active: boolean; archivedAt: Date | null; lastActiveAt: Date } = {
        id: 'session-1',
        accountId: 'account-1',
        active: true,
        archivedAt: null,
        lastActiveAt: new Date(0),
    };
    return {
        row,
        dbMock: {
            session: {
                updateMany: vi.fn(async ({ where, data }: any) => {
                    if (where.id !== row.id || where.accountId !== row.accountId) return { count: 0 };
                    Object.assign(row, data);
                    return { count: 1 };
                }),
                findMany: vi.fn(async ({ where }: any) => (
                    where.accountId === row.accountId && where.id.in.includes(row.id) && row.archivedAt
                        ? [{ id: row.id }]
                        : []
                )),
            },
        },
        emitArchived: vi.fn(),
        emitEphemeral: vi.fn(),
        discardPending: vi.fn(),
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/app/events/eventRouter')>();
    return {
        ...actual,
        eventRouter: {
            emitSessionArchived: emitArchived,
            emitEphemeral,
            emitUpdate: vi.fn(),
        },
    };
});
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { discardSessionUpdate: discardPending },
}));

import { sessionRoutes } from './sessionRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'account-1'; });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe('server-owned session lifecycle routes', () => {
    beforeEach(() => {
        row.active = true;
        row.archivedAt = null;
        row.lastActiveAt = new Date(0);
        emitArchived.mockClear();
        emitEphemeral.mockClear();
        discardPending.mockClear();
    });

    it('commits the tombstone before driving local process termination', async () => {
        const app = await createApp();
        const response = await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/archive` });
        expect(response.statusCode).toBe(200);
        expect(row.archivedAt).toBeInstanceOf(Date);
        expect(row.active).toBe(false);
        expect(discardPending).toHaveBeenCalledWith(row.id);
        expect(emitArchived).toHaveBeenCalledWith(row.accountId, row.id);
        await app.close();
    });

    it('reports archived ids for daemon reconnect reconciliation and supports explicit resume', async () => {
        const app = await createApp();
        await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/archive` });
        const status = await app.inject({
            method: 'POST',
            url: '/v1/sessions/archive-status',
            payload: { sessionIds: [row.id] },
        });
        expect(status.json()).toEqual({ archivedSessionIds: [row.id] });

        const resume = await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/unarchive` });
        expect(resume.statusCode).toBe(200);
        expect(row.archivedAt).toBeNull();
        expect(row.active).toBe(false);
        await app.close();
    });
});
