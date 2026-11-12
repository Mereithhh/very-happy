import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '@/app/api/types';
import { sanitizeLogValue } from '@/utils/logSafety';
import { stableLogRef } from '@/utils/logSafety';

/**
 * B-933: the archive / unarchive routes say who did it. Drives the REAL
 * `sessionRoutes` through fastify inject; only the DB, event fan-out and the
 * sinks are stubbed. The log record is checked AFTER the real sanitizer.
 */
const { row, dbMock, logged, audited } = vi.hoisted(() => {
    const row = { id: 'session-audit-1', accountId: 'account-1', archivedAt: null as Date | null, active: true, lastActiveAt: new Date(0) };
    return {
        row,
        logged: [] as Array<{ src: unknown; msg: unknown }>,
        audited: [] as unknown[],
        dbMock: {
            session: {
                updateMany: vi.fn(async ({ where, data }: any) => {
                    if (where.id !== row.id || where.accountId !== row.accountId) return { count: 0 };
                    Object.assign(row, data);
                    return { count: 1 };
                }),
                findFirst: vi.fn(async ({ where }: any) => (where.id === row.id && where.accountId === row.accountId ? { ...row } : null)),
                findMany: vi.fn(async () => []),
            },
            sessionGrant: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
            projectGrant: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
        },
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/events/eventRouter', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/app/events/eventRouter')>()),
    eventRouter: { emitSessionArchived: vi.fn(), emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
}));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: { discardSessionUpdate: vi.fn() } }));
vi.mock('@/app/automations/attentionLifecycle', () => ({ noteSessionArchived: vi.fn(async () => []) }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/utils/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/log')>();
    // Same path as the real `log`: structured args go through the sanitizer.
    return { ...actual, log: (src: unknown, msg?: unknown) => { logged.push({ src: sanitizeLogValue(src), msg }); } };
});
vi.mock('@/app/audit/producer', () => ({
    businessAuditEnabled: () => true,
    publishAudit: (input: unknown) => { audited.push(input); },
}));

import { sessionRoutes } from '@/app/api/routes/sessionRoutes';
import { archiveSourceHeader, userAgentFamily } from './sessionArchiveAudit';

const SECRET = 'Bearer super-secret-token-value-123456';

async function createApp(human: boolean) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account-1';
        if (human) request.authLoginSessionId = 'login-1';
    });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}
const auditLines = () => logged.filter((l) => (l.src as { module?: string }).module === 'session-archive-audit').map((l) => l.src as Record<string, unknown>);

describe('B-933 archive audit through the real routes', () => {
    beforeEach(() => {
        row.archivedAt = null;
        logged.length = 0;
        audited.length = 0;
    });

    it('a Web archive records human token, client, UA family and time — never the token', async () => {
        const app = await createApp(true);
        const before = Date.now();
        const res = await app.inject({
            method: 'POST', url: `/v1/sessions/${row.id}/archive`,
            headers: { authorization: SECRET, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
        });
        expect(res.statusCode).toBe(200);
        const [line] = auditLines();
        expect(line).toMatchObject({
            operation: 'archive', status: 200, alreadyArchived: false, tokenKind: 'human', uaFamily: 'chrome/131 macos',
            sessionId: stableLogRef('sessionId', row.id),
        });
        expect(line.client).toBeUndefined();
        expect(line.source).toBeUndefined();
        expect(line.atMs as number).toBeGreaterThanOrEqual(before);
        expect(audited).toEqual([expect.objectContaining({ kind: 'session.archived', sessionId: row.id, accountId: 'account-1', payload: expect.objectContaining({ tokenKind: 'human' }) })]);
        expect(JSON.stringify([logged, audited])).not.toContain('super-secret');
        await app.close();
    });

    it('a team cleanup re-archive is told apart: machine token, declared source, already archived', async () => {
        row.archivedAt = new Date(1_000);
        const app = await createApp(false);
        await app.inject({
            method: 'POST', url: `/v1/sessions/${row.id}/archive`,
            headers: { authorization: SECRET, 'x-happy-client': 'cli-session-ops/0.2.212', 'x-happy-archive-source': 'team-cleanup', 'user-agent': 'axios/1.7.9' },
        });
        expect(auditLines()[0]).toMatchObject({ tokenKind: 'machine', client: 'cli-session-ops/0.2.212', source: 'team-cleanup', uaFamily: 'axios/1', alreadyArchived: true });
        await app.close();
    });

    it('unarchive and a 404 are audited too', async () => {
        const app = await createApp(true);
        await app.inject({ method: 'POST', url: `/v1/sessions/${row.id}/unarchive` });
        await app.inject({ method: 'POST', url: '/v1/sessions/nope/archive' });
        expect(auditLines().map((l) => [l.operation, l.status])).toEqual([['unarchive', 200], ['archive', 404]]);
        expect(audited.map((a) => (a as { kind: string }).kind)).toEqual(['session.unarchived', 'session.archived']);
        await app.close();
    });

    it('malformed headers are bounded, not logged raw', async () => {
        const app = await createApp(false);
        await app.inject({
            method: 'POST', url: `/v1/sessions/${row.id}/archive`,
            headers: { 'x-happy-client': 'x'.repeat(500), 'x-happy-archive-source': 'Robert"); drop', 'user-agent': 'weird thing' },
        });
        expect(auditLines()[0]).toMatchObject({ client: 'invalid', source: 'invalid', uaFamily: 'other' });
        await app.close();
    });
});

describe('B-933 header helpers', () => {
    it('user-agent families', () => {
        expect(userAgentFamily(undefined)).toBe('none');
        expect(userAgentFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('safari/18 ios');
        expect(userAgentFamily('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('firefox/133 linux');
        expect(userAgentFamily('curl/8.5.0')).toBe('curl/8');
        expect(userAgentFamily('node')).toBe('node');
    });
    it('archive source header', () => {
        expect(archiveSourceHeader(undefined)).toBeUndefined();
        expect(archiveSourceHeader('gc')).toBe('gc');
        expect(archiveSourceHeader('GC!')).toBe('invalid');
    });
});
