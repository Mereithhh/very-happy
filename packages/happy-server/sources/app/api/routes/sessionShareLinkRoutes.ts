/**
 * B-701 share-link routes (spec specs/2026-10-session-sharing-tiers.md).
 *
 * Owner:  POST/GET /v1/sessions/:id/share-links, PATCH/DELETE …/:linkId,
 *         POST …/:linkId/rotate, GET /v1/share-links/:linkId/accesses,
 *         GET /v1/shares/outgoing (settings "Shared" page)
 * Public: GET /v1/public/share-links/:linkId (+ /messages) — no account; the
 *         secret from the URL fragment arrives in `x-share-secret`. A logged-in
 *         browser may add its normal Bearer token so the owner sees who opened it.
 */
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { Fastify } from '../types';
import { auth } from '@/app/auth/auth';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { clientIp, clientRateLimitKey } from '../clientIp';
import { isAccountResourceLimitError } from '../resourceLimits';
import { SessionShareError } from '@/app/session/sessionShares';
import {
    createShareLink,
    listOutgoingShares,
    listShareLinkAccesses,
    listShareLinks,
    publicLinkInfo,
    publicLinkMessages,
    recordShareLinkAccess,
    resolvePublicLink,
    revokeShareLink,
    rotateShareLink,
    updateShareLink,
} from '@/app/session/shareLinks';

const sessionParams = z.object({ sessionId: z.string().min(1).max(128) });
const linkParams = sessionParams.extend({ linkId: z.string().min(1).max(128) });
const publicParams = z.object({ linkId: z.string().min(1).max(128) });
const expirySchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]);

/** Every link response: never indexed, never cached, never leaks a Referer. */
export function applyShareLinkHeaders(reply: Pick<FastifyReply, 'header'>): void {
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
}

const PUBLIC_RATE = { max: 240, windowMs: 60_000 };
const PUBLIC_MISS_RATE = { max: 20, windowMs: 10 * 60_000 };

export function sessionShareLinkRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof SessionShareError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: error.code });
            throw error;
        }
    };
    const auth_ = { preHandler: app.authenticate };

    app.post('/v1/sessions/:sessionId/share-links', {
        ...auth_,
        schema: { params: sessionParams, body: z.object({ scope: z.enum(['snapshot', 'live']), expiresInDays: expirySchema }) },
    }, async (request, reply) => handle(reply, async () =>
        createShareLink({ ownerId: request.userId, sessionId: request.params.sessionId, scope: request.body.scope, expiresInDays: request.body.expiresInDays })));

    app.get('/v1/sessions/:sessionId/share-links', { ...auth_, schema: { params: sessionParams } }, async (request, reply) =>
        handle(reply, async () => ({ links: await listShareLinks(request.userId, request.params.sessionId) })));

    app.patch('/v1/sessions/:sessionId/share-links/:linkId', {
        ...auth_,
        schema: { params: linkParams, body: z.object({ snapshotToNow: z.literal(true).optional(), expiresInDays: expirySchema.optional() }) },
    }, async (request, reply) => handle(reply, async () => ({
        link: await updateShareLink(request.userId, request.params.sessionId, request.params.linkId, request.body),
    })));

    app.post('/v1/sessions/:sessionId/share-links/:linkId/rotate', { ...auth_, schema: { params: linkParams } }, async (request, reply) =>
        handle(reply, async () => rotateShareLink(request.userId, request.params.sessionId, request.params.linkId)));

    app.delete('/v1/sessions/:sessionId/share-links/:linkId', { ...auth_, schema: { params: linkParams } }, async (request, reply) =>
        handle(reply, async () => { await revokeShareLink(request.userId, request.params.sessionId, request.params.linkId); return { ok: true }; }));

    app.get('/v1/share-links/:linkId/accesses', { ...auth_, schema: { params: publicParams } }, async (request, reply) =>
        handle(reply, async () => ({ accesses: await listShareLinkAccesses(request.userId, request.params.linkId) })));

    app.get('/v1/shares/outgoing', auth_, async (request, reply) =>
        handle(reply, async () => listOutgoingShares(request.userId)));

    // ------------------------------------------------------------ public

    /** Rate-limit, resolve the link, map unknown/wrong-secret to 404 and charge the per-IP miss budget. */
    async function withPublicLink(request: any, reply: any, work: (link: Awaited<ReturnType<typeof resolvePublicLink>>) => Promise<unknown>) {
        applyShareLinkHeaders(reply);
        const ipKey = clientRateLimitKey(request);
        if (!(await allowAuthRequest(`share-link:ip:${ipKey}`, PUBLIC_RATE))) {
            return reply.code(429).header('retry-after', '60').send({ error: 'too_many_requests' });
        }
        const secret = request.headers['x-share-secret'];
        try {
            if (typeof secret !== 'string' || secret.length < 20 || secret.length > 128) throw new SessionShareError('link_not_found', 404);
            const link = await resolvePublicLink({ linkId: request.params.linkId, secret });
            return await work(link);
        } catch (error) {
            if (error instanceof SessionShareError && error.status === 404 && error.code === 'link_not_found') {
                // Enumeration guard: misses are budgeted per IP; a valid link holder is unaffected.
                if (!(await allowAuthRequest(`share-link:miss:${ipKey}`, PUBLIC_MISS_RATE))) {
                    return reply.code(429).header('retry-after', '600').send({ error: 'too_many_requests' });
                }
            }
            if (error instanceof SessionShareError) return reply.code(error.status).send({ error: error.code });
            throw error;
        }
    }

    async function viewerAccountId(request: any): Promise<string | null> {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        try { return (await auth.verifyToken(header.substring(7)))?.userId ?? null; } catch { return null; }
    }

    app.get('/v1/public/share-links/:linkId', { schema: { params: publicParams } }, async (request, reply) =>
        withPublicLink(request, reply, async (link) => {
            const info = await publicLinkInfo(link);
            const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null;
            await recordShareLinkAccess(link, { ip: clientIp(request), userAgent, accountId: await viewerAccountId(request) });
            return info;
        }));

    app.get('/v1/public/share-links/:linkId/messages', {
        schema: { params: publicParams, querystring: z.object({ after_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    }, async (request, reply) =>
        withPublicLink(request, reply, async (link) => publicLinkMessages(link, request.query.after_seq, request.query.limit)));
}
