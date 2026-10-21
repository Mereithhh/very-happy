/**
 * B-619 session sharing routes (spec specs/2026-10-session-sharing.md).
 *
 * Owner:    POST/GET /v1/sessions/:id/shares, PATCH/DELETE /v1/sessions/:id/shares/:accountId
 * Grantee:  GET /v1/shares/pending, POST /v1/shares/:grantId/{accept,decline},
 *           POST /v1/sessions/:id/shared-messages (driver only)
 * Any:      PUT /v1/account/content-public-key (lets a QR-paired account receive shares)
 */
import { z } from 'zod';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import { isAccountResourceLimitError } from '../resourceLimits';
import {
    SessionShareError,
    createSessionGrant,
    listPendingSessionInvites,
    listSessionGrants,
    postSharedMessage,
    respondToSessionGrant,
    revokeSessionGrant,
    updateSessionGrantRole,
} from '@/app/session/sessionShares';

const sessionParams = z.object({ sessionId: z.string().min(1).max(128) });
const granteeParams = sessionParams.extend({ accountId: z.string().min(1).max(128) });
const grantParams = z.object({ grantId: z.string().min(1).max(128) });
const roleSchema = z.enum(['viewer', 'driver']);
// B-701: optional expiry in days; null = never. Omitted keeps the B-619 behaviour (never).
const expirySchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]);

export function sessionShareRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof SessionShareError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: error.code });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };

    app.get('/v1/sessions/:sessionId/shares', { ...auth, schema: { params: sessionParams } }, async (request, reply) =>
        handle(reply, async () => ({ grants: await listSessionGrants(request.userId, request.params.sessionId) })));

    app.post('/v1/sessions/:sessionId/shares', {
        ...auth,
        // Either a typed target (email / handle / login username) or a directory
        // account id (friend picker). Exactly one of the two.
        schema: { params: sessionParams, body: z.object({
            target: z.string().min(1).max(320).optional(),
            accountId: z.string().min(1).max(256).optional(),
            role: roleSchema,
            expiresInDays: expirySchema.optional(),
        }).refine((b) => Boolean(b.target) !== Boolean(b.accountId), { message: 'target xor accountId' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await createSessionGrant({ ownerId: request.userId, sessionId: request.params.sessionId, target: request.body.target, granteeAccountId: request.body.accountId, role: request.body.role, expiresInDays: request.body.expiresInDays }),
    })));

    app.patch('/v1/sessions/:sessionId/shares/:accountId', {
        ...auth,
        schema: { params: granteeParams, body: z.object({ role: roleSchema.optional(), expiresInDays: expirySchema.optional() }).refine((b) => b.role !== undefined || b.expiresInDays !== undefined, { message: 'role or expiresInDays' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await updateSessionGrantRole(request.userId, request.params.sessionId, request.params.accountId, request.body.role, request.body.expiresInDays),
    })));

    app.delete('/v1/sessions/:sessionId/shares/:accountId', { ...auth, schema: { params: granteeParams } }, async (request, reply) =>
        handle(reply, async () => { await revokeSessionGrant(request.userId, request.params.sessionId, request.params.accountId); return { ok: true }; }));

    app.get('/v1/shares/pending', auth, async (request, reply) =>
        handle(reply, async () => ({ invites: await listPendingSessionInvites(request.userId) })));

    app.post('/v1/shares/:grantId/accept', { ...auth, schema: { params: grantParams } }, async (request, reply) =>
        handle(reply, async () => ({ invite: await respondToSessionGrant(request.userId, request.params.grantId, true) })));

    app.post('/v1/shares/:grantId/decline', { ...auth, schema: { params: grantParams } }, async (request, reply) =>
        handle(reply, async () => { await respondToSessionGrant(request.userId, request.params.grantId, false); return { ok: true }; }));

    app.post('/v1/sessions/:sessionId/shared-messages', {
        ...auth,
        schema: { params: sessionParams, body: z.object({ text: z.string().min(1).max(200_000), localId: z.string().min(1).max(128) }) },
    }, async (request, reply) => handle(reply, async () => ({
        message: await postSharedMessage({ granteeAccountId: request.userId, sessionId: request.params.sessionId, text: request.body.text, localId: request.body.localId }),
    })));

    app.put('/v1/account/content-public-key', {
        ...auth,
        schema: { body: z.object({ contentPublicKey: z.string().min(40).max(64) }) },
    }, async (request, reply) => handle(reply, async () => {
        const bytes = Buffer.from(request.body.contentPublicKey, 'base64');
        if (bytes.length !== 32) throw new SessionShareError('invalid_public_key', 400);
        await db.account.update({ where: { id: request.userId }, data: { contentPublicKey: bytes.toString('base64') } });
        return { ok: true };
    }));
}
