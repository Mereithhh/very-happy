/**
 * B-878 terminal sharing routes (spec specs/2026-11-share-terminals-and-projects.md §7).
 *
 * Owner:    POST /v1/terminal-shares, GET /v1/terminal-shares?machineId&terminalId,
 *           GET /v1/terminal-shares/outgoing, PATCH/DELETE /v1/terminal-shares/:grantId,
 *           GET /v1/terminal-shares/:grantId/events,
 *           B-900: POST /v1/terminal-shares/batch-operate, POST /v1/terminal-shares/batch-revoke (one person × named terminals)
 * Grantee:  GET /v1/terminal-shares/incoming, POST /v1/terminal-shares/:grantId/respond
 * Streams go over the user socket (`share-terminal-*`, terminalShareBroker.ts), never the relay.
 */
import { z } from 'zod';
import type { Fastify } from '../types';
import { isAccountResourceLimitError } from '../resourceLimits';
import { TerminalShareError } from '@/app/share/terminalSharePolicy';
import {
    TerminalShareStoreError,
    MAX_TERMINAL_BATCH,
    createTerminalGrant,
    grantTerminalsOperator,
    listIncomingTerminalShares,
    listOutgoingTerminalGrants,
    listTerminalGrants,
    respondToTerminalGrant,
    revokeTerminalGrant,
    revokeTerminalsFor,
    terminalGrantEvents,
    updateTerminalGrant,
} from '@/app/share/terminalShares';
import { humanOnly } from '@/app/auth/ownerGuard';

const id = z.string().min(1).max(128);
const grantParams = z.object({ grantId: id });
const roleSchema = z.enum(['viewer', 'operator']);
// Every terminal tier expires (Lead 11-03): 1 / 7 / 30 days, never "forever".
const expirySchema = z.union([z.literal(1), z.literal(7), z.literal(30)]);

export function terminalShareRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof TerminalShareStoreError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            if (error instanceof TerminalShareError) return reply.code(400).send({ error: error.code });
            if (isAccountResourceLimitError(error)) return reply.code(error.statusCode).send({ error: error.code });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };

    app.post('/v1/terminal-shares', {
        preHandler: [app.authenticate, humanOnly('share.terminal.create')],
        schema: { body: z.object({
            machineId: id,
            terminalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            title: z.string().max(200).optional(),
            target: z.string().min(1).max(320).optional(),
            accountId: z.string().min(1).max(256).optional(),
            role: roleSchema,
            expiresInDays: expirySchema.optional(),
            confirmOperator: z.literal(true).optional(),
        }).strict().refine((b) => Boolean(b.target) !== Boolean(b.accountId), { message: 'target xor accountId' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await createTerminalGrant({ ownerId: request.userId, machineId: request.body.machineId, terminalId: request.body.terminalId, title: request.body.title, target: request.body.target, granteeAccountId: request.body.accountId, role: request.body.role, expiresInDays: request.body.expiresInDays, confirmOperator: request.body.confirmOperator }),
    })));

    // B-900: one person × the terminals the owner confirmed (the project's terminals right now).
    const batchRefs = z.array(z.object({ machineId: id, terminalId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), title: z.string().max(200).optional() }).strict()).min(1).max(MAX_TERMINAL_BATCH);
    app.post('/v1/terminal-shares/batch-operate', {
        preHandler: [app.authenticate, humanOnly('share.terminal.batch-operate')],
        schema: { body: z.object({ accountId: z.string().min(1).max(256), terminals: batchRefs, expiresInDays: expirySchema, confirmOperator: z.literal(true).optional() }).strict() },
    }, async (request, reply) => handle(reply, async () => ({
        results: await grantTerminalsOperator({ ownerId: request.userId, granteeAccountId: request.body.accountId, terminals: request.body.terminals, expiresInDays: request.body.expiresInDays, confirmOperator: request.body.confirmOperator }),
    })));

    app.post('/v1/terminal-shares/batch-revoke', {
        ...auth,
        schema: { body: z.object({ accountId: z.string().min(1).max(256), terminals: batchRefs }).strict() },
    }, async (request, reply) => handle(reply, async () => revokeTerminalsFor({ ownerId: request.userId, granteeAccountId: request.body.accountId, terminals: request.body.terminals })));

    app.get('/v1/terminal-shares', {
        ...auth,
        schema: { querystring: z.object({ machineId: id, terminalId: id }) },
    }, async (request, reply) => handle(reply, async () => ({
        grants: await listTerminalGrants(request.userId, request.query.machineId, request.query.terminalId),
    })));

    app.get('/v1/terminal-shares/outgoing', auth, async (request, reply) =>
        handle(reply, async () => ({ grants: await listOutgoingTerminalGrants(request.userId) })));

    app.get('/v1/terminal-shares/incoming', auth, async (request, reply) =>
        handle(reply, async () => ({ shares: await listIncomingTerminalShares(request.userId) })));

    app.patch('/v1/terminal-shares/:grantId', {
        preHandler: [app.authenticate, humanOnly('share.terminal.update')],
        schema: { params: grantParams, body: z.object({ role: roleSchema.optional(), expiresInDays: expirySchema.optional(), confirmOperator: z.literal(true).optional() }).strict()
            .refine((b) => b.role !== undefined || b.expiresInDays !== undefined, { message: 'role or expiresInDays' }) },
    }, async (request, reply) => handle(reply, async () => ({
        grant: await updateTerminalGrant(request.userId, request.params.grantId, request.body),
    })));

    app.delete('/v1/terminal-shares/:grantId', { ...auth, schema: { params: grantParams } }, async (request, reply) =>
        handle(reply, async () => { await revokeTerminalGrant(request.userId, request.params.grantId); return { ok: true }; }));

    app.post('/v1/terminal-shares/:grantId/respond', {
        preHandler: [app.authenticate, humanOnly('share.terminal.respond')],
        schema: { params: grantParams, body: z.object({ accept: z.boolean() }) },
    }, async (request, reply) => handle(reply, async () => { await respondToTerminalGrant(request.userId, request.params.grantId, request.body.accept); return { ok: true }; }));

    app.get('/v1/terminal-shares/:grantId/events', {
        ...auth,
        schema: { params: grantParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
    }, async (request, reply) => handle(reply, async () => ({
        events: await terminalGrantEvents(request.userId, request.params.grantId, request.query.limit ?? 100),
    })));
}
