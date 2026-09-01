import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { row, dbMock, emitArchived, emitEphemeral, emitUpdate, discardPending } = vi.hoisted(() => {
    const row = {
        id: 'session-1',
        accountId: 'account-1',
        seq: 42,
        createdAt: new Date(1000),
        updatedAt: new Date(2000),
        metadata: 'enc-meta',
        metadataVersion: 3,
        agentState: null as string | null,
        agentStateVersion: 0,
        dataEncryptionKey: null as Buffer | null,
        active: true,
        archivedAt: null as Date | null,
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
                findFirst: vi.fn(async ({ where }: any) => (
                    where.id === row.id && where.accountId === row.accountId ? { ...row } : null
                )),
            },
        },
        emitArchived: vi.fn(),
        emitEphemeral: vi.fn(),
        emitUpdate: vi.fn(),
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
            emitUpdate,
        },
    };
});
vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { discardSessionUpdate: discardPending },
}));
let userSeq = 100;
vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn(async () => ++userSeq),
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
        emitUpdate.mockClear();
        discardPending.mockClear();
    });

    // B-265: `archivedAt` is the only way to tell "archived" from "offline"
    // (both are active=false); other tabs learn it from a user-level update.
    it('broadcasts archivedAt on both transitions as a metadata-less update-session', async () => {
        const app = await createApp();
        await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/archive` });
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        const archived = emitUpdate.mock.calls[0][0];
        expect(archived.recipientFilter).toEqual({ type: 'user-scoped-only' });
        expect(archived.payload.body).toEqual({ t: 'update-session', id: row.id, archivedAt: row.archivedAt!.getTime() });
        expect(archived.payload.seq).toBe(101);

        await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/unarchive` });
        expect(emitUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate.mock.calls[1][0].payload.body).toEqual({ t: 'update-session', id: row.id, archivedAt: null });
        expect(emitUpdate.mock.calls[1][0].payload.seq).toBe(102);
        await app.close();
    });

    it('projects archivedAt + seq on the list and the by-id read; by-id is account-scoped', async () => {
        const app = await createApp();
        dbMock.session.findMany.mockImplementationOnce(async () => [{ ...row }]);
        const list = await app.inject({ method: 'GET', url: '/v1/sessions' });
        expect(list.json().sessions[0]).toMatchObject({ id: row.id, seq: 42, active: true, archivedAt: null, activeAt: 0 });

        await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/archive` });
        const one = await app.inject({ method: 'GET', url: `/v1/sessions/${row.id}` });
        expect(one.statusCode).toBe(200);
        expect(one.json().session).toMatchObject({ id: row.id, seq: 42, active: false, archivedAt: row.archivedAt!.getTime(), metadata: 'enc-meta', metadataVersion: 3 });

        const missing = await app.inject({ method: 'GET', url: '/v1/sessions/someone-elses' });
        expect(missing.statusCode).toBe(404);
        await app.close();
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
