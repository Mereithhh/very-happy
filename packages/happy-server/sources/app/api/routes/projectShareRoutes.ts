/**
 * B-878 PR-B project sharing routes (spec specs/2026-11-share-terminals-and-projects.md §4, §7).
 *
 * Owner:    POST/GET /v1/projects/:projectId/shares, PATCH/DELETE /v1/projects/:projectId/shares/:accountId,
 *           GET /v1/project-shares/outgoing
 * Grantee:  GET /v1/project-shares/incoming, POST /v1/project-shares/:grantId/respond,
 *           GET /v1/project-shares/:grantId (read-only project page: info, log, member ids, terminals)
 * Sessions of a shared project come through GET /v1/sessions?projectShares=1 (derived at read time).
 */
import { z } from 'zod';
import type { Fastify } from '../types';
import { isAccountResourceLimitError } from '../resourceLimits';
import { granteeContentPublicKey } from '@/app/session/sessionShares';
import { listProjectTerminals } from '@/app/share/terminalShareBroker';
import {
    ProjectShareError,
    createProjectGrant,
    listIncomingProjectShares,
    listOutgoingProjectGrants,
    listProjectGrants,
    respondToProjectGrant,
    revokeProjectGrant,
    sharedProjectView,
    updateProjectGrant,
} from '@/app/share/projectShares';

const id = z.string().min(1).max(128);
// Project shares: view only / can send. "Can operate" is only ever granted per session or terminal.
const roleSchema = z.enum(['viewer', 'driver']);
const expirySchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]);

export function projectShareRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof ProjectShareError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: error.code });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };
    const projectParams = z.object({ projectId: id });
    const granteeParams = projectParams.extend({ accountId: id });
    const grantParams = z.object({ grantId: id });

    app.post('/v1/projects/:projectId/shares', {
        ...auth,
        schema: { params: projectParams, body: z.object({
            target: z.string().min(1).max(320).optional(),
            accountId: z.string().min(1).max(256).optional(),
            role: roleSchema,
            expiresInDays: expirySchema.optional(),
        }).strict().refine((b) => Boolean(b.target) !== Boolean(b.accountId), { message: 'target xor accountId' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await createProjectGrant({ ownerId: request.userId, projectId: request.params.projectId, target: request.body.target, granteeAccountId: request.body.accountId, role: request.body.role, expiresInDays: request.body.expiresInDays }, granteeContentPublicKey),
    })));

    app.get('/v1/projects/:projectId/shares', { ...auth, schema: { params: projectParams } }, async (request, reply) =>
        handle(reply, async () => ({ grants: await listProjectGrants(request.userId, request.params.projectId) })));

    app.patch('/v1/projects/:projectId/shares/:accountId', {
        ...auth,
        schema: { params: granteeParams, body: z.object({ role: roleSchema.optional(), expiresInDays: expirySchema.optional() }).strict()
            .refine((b) => b.role !== undefined || b.expiresInDays !== undefined, { message: 'role or expiresInDays' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await updateProjectGrant(request.userId, request.params.projectId, request.params.accountId, request.body),
    })));

    app.delete('/v1/projects/:projectId/shares/:accountId', { ...auth, schema: { params: granteeParams } }, async (request, reply) =>
        handle(reply, async () => { await revokeProjectGrant(request.userId, request.params.projectId, request.params.accountId); return { ok: true }; }));

    app.get('/v1/project-shares/outgoing', auth, async (request, reply) =>
        handle(reply, async () => ({ grants: await listOutgoingProjectGrants(request.userId) })));

    app.get('/v1/project-shares/incoming', auth, async (request, reply) =>
        handle(reply, async () => ({ shares: await listIncomingProjectShares(request.userId) })));

    app.post('/v1/project-shares/:grantId/respond', { ...auth, schema: { params: grantParams, body: z.object({ accept: z.boolean() }) } }, async (request, reply) =>
        handle(reply, async () => { await respondToProjectGrant(request.userId, request.params.grantId, request.body.accept); return { ok: true }; }));

    app.get('/v1/project-shares/:grantId', { ...auth, schema: { params: grantParams } }, async (request, reply) =>
        handle(reply, async () => ({
            ...(await sharedProjectView(request.userId, request.params.grantId)),
            terminals: await listProjectTerminals(request.userId, request.params.grantId),
        })));
}
