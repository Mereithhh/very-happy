import { z } from 'zod';
import {
    AutomationClaimSchema, AutomationCreateSchema, AutomationFireSchema, AutomationListQuerySchema, AutomationManualRunSchema, AutomationNameSchema,
    AutomationReportSchema, AutomationRunsQuerySchema, AutomationStickyDeleteSchema, AutomationStickyPutSchema, AutomationUpdateSchema,
} from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { AutomationError } from '@/app/automations/errors';
import {
    ackRun, cancelRun, claimRuns, createAutomation, deleteAutomation, deleteSticky, fireAutomation, getAutomation, getAutomationByName, getRun,
    listAutomations, listRuns, listStickies, putSticky, reportRun, runAutomationNow, setAutomationStatus, updateAutomation,
} from '@/app/automations/store';

const params = z.object({ id: z.string().min(1).max(128) });
const nameParams = z.object({ name: AutomationNameSchema });
/**
 * B-496 Automations REST. Every route is account-authenticated; when
 * `VH_AUTOMATIONS_ENABLED` is off the store throws `automations_disabled`
 * (404). B-502: no account allowlist; the per-account cap answers 429
 * `automation_count_quota_exceeded` with `{ limit, count }`. Errors are
 * `{ error, ...details }`.
 */
export function automationRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof AutomationError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };
    app.get('/v1/automations', { ...auth, schema: { querystring: AutomationListQuerySchema } }, async (request, reply) => handle(reply, async () => ({ automations: await listAutomations(request.userId, request.query.machineId) })));
    app.post('/v1/automations', { ...auth, schema: { body: AutomationCreateSchema } }, async (request, reply) => handle(reply, async () => ({ automation: await createAutomation(request.userId, request.body) })));
    // Static segments are registered before `/:id` so `claim`, `runs` and `by-name` never resolve as ids.
    app.post('/v1/automations/claim', { ...auth, schema: { body: AutomationClaimSchema } }, async (request, reply) => handle(reply, () => claimRuns(request.userId, request.body)));
    app.get('/v1/automations/runs', { ...auth, schema: { querystring: AutomationRunsQuerySchema } }, async (request, reply) => handle(reply, async () => {
        const q = request.query;
        return { runs: await listRuns(request.userId, { automationId: q.automationId, name: q.name, status: q.status, attention: q.attention === '1' || q.attention === 'true', limit: q.limit }) };
    }));
    app.get('/v1/automations/runs/:id', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ run: await getRun(request.userId, request.params.id) })));
    app.post('/v1/automations/runs/:id/report', { ...auth, schema: { params, body: AutomationReportSchema } }, async (request, reply) => handle(reply, async () => ({ run: await reportRun(request.userId, request.params.id, request.body) })));
    app.post('/v1/automations/runs/:id/cancel', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ run: await cancelRun(request.userId, request.params.id) })));
    app.post('/v1/automations/runs/:id/ack', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ run: await ackRun(request.userId, request.params.id) })));
    app.get('/v1/automations/by-name/:name', { ...auth, schema: { params: nameParams } }, async (request, reply) => handle(reply, async () => ({ automation: await getAutomationByName(request.userId, request.params.name) })));
    app.post('/v1/automations/by-name/:name/fire', { ...auth, schema: { params: nameParams, body: AutomationFireSchema } }, async (request, reply) => handle(reply, () => fireAutomation(request.userId, request.params.name, request.body)));
    app.get('/v1/automations/:id', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ automation: await getAutomation(request.userId, request.params.id) })));
    app.patch('/v1/automations/:id', { ...auth, schema: { params, body: AutomationUpdateSchema } }, async (request, reply) => handle(reply, async () => ({ automation: await updateAutomation(request.userId, request.params.id, request.body) })));
    app.delete('/v1/automations/:id', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => { await deleteAutomation(request.userId, request.params.id); return { ok: true }; }));
    app.post('/v1/automations/:id/pause', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ automation: await setAutomationStatus(request.userId, request.params.id, 'paused') })));
    app.post('/v1/automations/:id/resume', { ...auth, schema: { params } }, async (request, reply) => handle(reply, async () => ({ automation: await setAutomationStatus(request.userId, request.params.id, 'active') })));
    app.post('/v1/automations/:id/run', { ...auth, schema: { params, body: AutomationManualRunSchema } }, async (request, reply) => handle(reply, async () => ({ run: await runAutomationNow(request.userId, request.params.id, request.body) })));
    app.get('/v1/automations/:id/stickies', { ...auth, schema: { params, querystring: z.object({ key: z.string().min(1).max(512).optional() }) } }, async (request, reply) => handle(reply, async () => ({ stickies: await listStickies(request.userId, request.params.id, request.query.key) })));
    app.put('/v1/automations/:id/stickies', { ...auth, schema: { params, body: AutomationStickyPutSchema } }, async (request, reply) => handle(reply, async () => ({ sticky: await putSticky(request.userId, request.params.id, request.body.key, request.body.sessionId) })));
    app.delete('/v1/automations/:id/stickies', { ...auth, schema: { params, body: AutomationStickyDeleteSchema } }, async (request, reply) => handle(reply, async () => ({ removed: await deleteSticky(request.userId, request.params.id, request.body.key) })));
}
