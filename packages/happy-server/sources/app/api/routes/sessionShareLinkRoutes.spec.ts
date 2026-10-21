import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const { buckets, resolvePublicLink, recordShareLinkAccess, verifyToken } = vi.hoisted(() => ({
    buckets: new Map<string, number>(),
    resolvePublicLink: vi.fn(),
    recordShareLinkAccess: vi.fn(async () => undefined),
    verifyToken: vi.fn(async (token: string) => (token === 'good' ? { userId: 'viewer-1' } : null)),
}));

vi.mock('@/app/auth/authRateLimiter', () => ({
    allowAuthRequest: vi.fn(async (key: string, options: { max: number }) => {
        const next = (buckets.get(key) ?? 0) + 1;
        if (next > options.max) return false;
        buckets.set(key, next);
        return true;
    }),
}));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken } }));
vi.mock('@/app/session/shareLinks', async () => {
    const { SessionShareError } = await import('@/app/session/sessionShares');
    resolvePublicLink.mockImplementation(async ({ linkId, secret }: { linkId: string; secret: string }) => {
        if (linkId !== 'link-1' || secret !== 'S'.repeat(43)) throw new SessionShareError('link_not_found', 404);
        return { id: 'link-1', revoked: false };
    });
    return {
        resolvePublicLink,
        recordShareLinkAccess,
        publicLinkInfo: vi.fn(async () => ({ linkId: 'link-1', scope: 'live' })),
        publicLinkMessages: vi.fn(async () => ({ messages: [], hasMore: false, lastSeq: 0 })),
        createShareLink: vi.fn(), listShareLinks: vi.fn(), updateShareLink: vi.fn(), rotateShareLink: vi.fn(),
        revokeShareLink: vi.fn(), listShareLinkAccesses: vi.fn(), listOutgoingShares: vi.fn(),
    };
});
vi.mock('@/storage/db', () => ({ db: {} }));

import { sessionShareLinkRoutes } from './sessionShareLinkRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'owner-1'; });
    sessionShareLinkRoutes(typed);
    await typed.ready();
    return typed;
}

const SECRET = 'S'.repeat(43);

describe('B-701 public share-link routes', () => {
    beforeEach(() => { buckets.clear(); recordShareLinkAccess.mockClear(); });

    it('sets noindex / no-referrer / no-store on hits and misses alike', async () => {
        const app = await createApp();
        for (const headers of [{ 'x-share-secret': SECRET }, { 'x-share-secret': 'x'.repeat(43) }, {}]) {
            const res = await app.inject({ method: 'GET', url: '/v1/public/share-links/link-1', headers });
            expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
            expect(res.headers['referrer-policy']).toBe('no-referrer');
            expect(res.headers['cache-control']).toBe('no-store');
        }
    });

    it('missing secret, wrong secret and unknown id all answer the same 404', async () => {
        const app = await createApp();
        const bodies = await Promise.all([
            app.inject({ method: 'GET', url: '/v1/public/share-links/link-1' }),
            app.inject({ method: 'GET', url: '/v1/public/share-links/link-1', headers: { 'x-share-secret': 'x'.repeat(43) } }),
            app.inject({ method: 'GET', url: '/v1/public/share-links/other/messages', headers: { 'x-share-secret': SECRET } }),
        ]);
        for (const res of bodies) {
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ error: 'link_not_found' });
        }
        expect(recordShareLinkAccess).not.toHaveBeenCalled();
    });

    it('rate-limits misses per IP (enumeration guard) without blocking a valid holder', async () => {
        const app = await createApp();
        let last = 0;
        for (let i = 0; i < 21; i++) {
            last = (await app.inject({ method: 'GET', url: `/v1/public/share-links/guess-${i}`, headers: { 'x-share-secret': SECRET } })).statusCode;
        }
        expect(last).toBe(429);
        const ok = await app.inject({ method: 'GET', url: '/v1/public/share-links/link-1', headers: { 'x-share-secret': SECRET } });
        expect(ok.statusCode).toBe(200);
    });

    it('records an open with the logged-in viewer when a valid Bearer token rides along', async () => {
        const app = await createApp();
        await app.inject({ method: 'GET', url: '/v1/public/share-links/link-1', headers: { 'x-share-secret': SECRET, authorization: 'Bearer good', 'user-agent': 'Mozilla/5.0' } });
        await app.inject({ method: 'GET', url: '/v1/public/share-links/link-1', headers: { 'x-share-secret': SECRET, authorization: 'Bearer bad' } });
        expect(recordShareLinkAccess).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ accountId: 'viewer-1', userAgent: 'Mozilla/5.0' }));
        expect(recordShareLinkAccess).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ accountId: null }));
    });

    it('polling messages does not count as an open', async () => {
        const app = await createApp();
        const res = await app.inject({ method: 'GET', url: '/v1/public/share-links/link-1/messages?after_seq=3', headers: { 'x-share-secret': SECRET } });
        expect(res.statusCode).toBe(200);
        expect(recordShareLinkAccess).not.toHaveBeenCalled();
    });
});
