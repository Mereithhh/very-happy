import { z } from 'zod';
import {
    ProjectAttachTeamSchema, ProjectCreateSchema, ProjectDigestQuerySchema, ProjectInstructionsPutSchema, ProjectLogCreateSchema, ProjectLogRevokeSchema,
    ProjectMembersAddSchema, ProjectUxBatchSchema, ProjectMessageCreateSchema, ProjectMessagesDeliveredSchema, ProjectPresencePutSchema, ProjectSessionContextQuerySchema, ProjectUpdateSchema,
} from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { allowAuthRequest } from '@/app/auth/authRateLimiter';
import { countProjectOp, recordProjectUxEvent, type ProjectOp } from '@/app/monitoring/projectMetrics';
import { ProjectError } from '@/app/projects/rules';
import {
    addMembers, attachTeam, createLogEntry, createMessage, createProject, deleteProject, detachTeam, getProject, listInstructionRevisions, listLog, listProjects,
    listUndelivered, markDelivered, putInstructions, putPresence, removeMember, revokeLogEntry, sessionContext, sessionDigest, sessionMembership, updateProject,
} from '@/app/projects/store';

const params = z.object({ id: z.string().min(1).max(128) });
const sessionParams = z.object({ sessionId: z.string().min(1).max(128) });
const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * B-644 Projects REST (`specs/2026-10-projects.md`). Account-authenticated.
 * Errors are `{ error, ...details }`; `VH_PROJECTS_ENABLED=false` answers 404
 * `projects_disabled`, the same shape an older server's unknown route gives,
 * so clients have one "no projects here" path (compat matrix).
 *
 * Static segments (`presence`, `session`, `messages`) are registered before
 * `/:id` so they never resolve as ids.
 */
export function projectRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>, op?: ProjectOp, actor: 'user' | 'agent' | 'daemon' = 'user') => {
        try {
            const result = await work();
            if (op) countProjectOp(op, actor);
            return result;
        }
        catch (error) {
            if (error instanceof ProjectError) {
                // B-651: refusals that matter for the A/B read-out.
                if (error.code === 'project_note_quota_exceeded') countProjectOp('note_quota_refused', 'agent');
                if (error.code === 'instructions_version_conflict') countProjectOp('instructions_conflict', 'user');
                return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            }
            throw error;
        }
    };
    const auth = { preHandler: app.authenticate };

    app.get('/v1/projects', { ...auth, schema: { querystring: z.object({ includeArchived: z.enum(['0', '1', 'true', 'false']).optional() }) } },
        async (request, reply) => handle(reply, () => listProjects(request.userId, { includeArchived: truthy(request.query.includeArchived) })));
    app.post('/v1/projects', { ...auth, schema: { body: ProjectCreateSchema } },
        async (request, reply) => handle(reply, async () => ({ project: await createProject(request.userId, request.body) }), 'create'));

    // Daemon / wrapper paths.
    app.put('/v1/projects/presence', { ...auth, schema: { body: ProjectPresencePutSchema } },
        async (request, reply) => handle(reply, () => putPresence(request.userId, request.body), 'presence_write', 'daemon'));
    app.get('/v1/projects/session/:sessionId', { ...auth, schema: { params: sessionParams } },
        async (request, reply) => handle(reply, () => sessionMembership(request.userId, request.params.sessionId)));
    app.get('/v1/projects/session/:sessionId/context', { ...auth, schema: { params: sessionParams, querystring: ProjectSessionContextQuerySchema } },
        async (request, reply) => handle(reply, () => sessionContext(request.userId, request.params.sessionId, { full: truthy(request.query.full), peek: truthy(request.query.peek) }), 'context_read', 'agent'));
    app.get('/v1/projects/session/:sessionId/digest', { ...auth, schema: { params: sessionParams, querystring: ProjectDigestQuerySchema } },
        async (request, reply) => handle(reply, async () => {
            const digest = await sessionDigest(request.userId, request.params.sessionId, request.query.since);
            if (digest.instructions || digest.decisions.length || digest.revoked.length || digest.messages.length) countProjectOp('digest_nonempty', 'agent');
            return digest;
        }, 'digest_read', 'agent'));
    app.get('/v1/projects/session/:sessionId/messages', { ...auth, schema: { params: sessionParams } },
        async (request, reply) => handle(reply, async () => ({ messages: await listUndelivered(request.userId, request.params.sessionId) })));
    app.post('/v1/projects/messages/delivered', { ...auth, schema: { body: ProjectMessagesDeliveredSchema } },
        async (request, reply) => handle(reply, async () => {
            const out = await markDelivered(request.userId, request.body.sessionId, request.body.messageIds);
            countProjectOp('message_delivered', 'agent', out.delivered);
            return out;
        }));

    app.get('/v1/projects/:id', { ...auth, schema: { params } },
        async (request, reply) => handle(reply, () => getProject(request.userId, request.params.id)));
    app.patch('/v1/projects/:id', { ...auth, schema: { params, body: ProjectUpdateSchema } },
        async (request, reply) => handle(reply, async () => ({ project: await updateProject(request.userId, request.params.id, request.body) })));
    app.delete('/v1/projects/:id', { ...auth, schema: { params } },
        async (request, reply) => handle(reply, async () => { await deleteProject(request.userId, request.params.id); return { ok: true }; }));
    app.put('/v1/projects/:id/instructions', { ...auth, schema: { params, body: ProjectInstructionsPutSchema } },
        async (request, reply) => handle(reply, async () => ({ project: await putInstructions(request.userId, request.params.id, request.body) }), 'instructions_put'));
    app.get('/v1/projects/:id/instructions/history', { ...auth, schema: { params } },
        async (request, reply) => handle(reply, async () => ({ revisions: await listInstructionRevisions(request.userId, request.params.id) })));
    app.post('/v1/projects/:id/members', { ...auth, schema: { params, body: ProjectMembersAddSchema } },
        async (request, reply) => handle(reply, async () => ({ members: await addMembers(request.userId, request.params.id, request.body) }), 'member_add', request.body.via === 'lineage' || request.body.via === 'automation' ? 'daemon' : 'user'));
    app.delete('/v1/projects/:id/members/:sessionId', { ...auth, schema: { params: params.merge(sessionParams) } },
        async (request, reply) => handle(reply, () => removeMember(request.userId, request.params.id, request.params.sessionId), 'member_remove'));
    app.post('/v1/projects/:id/attach-team', { ...auth, schema: { params, body: ProjectAttachTeamSchema } },
        async (request, reply) => handle(reply, () => attachTeam(request.userId, request.params.id, request.body.teamId), 'team_attach'));
    app.post('/v1/projects/:id/detach-team', { ...auth, schema: { params, body: ProjectAttachTeamSchema } },
        async (request, reply) => handle(reply, () => detachTeam(request.userId, request.params.id, request.body.teamId)));
    app.get('/v1/projects/:id/log', { ...auth, schema: { params } },
        async (request, reply) => handle(reply, async () => ({ log: await listLog(request.userId, request.params.id) })));
    app.post('/v1/projects/:id/log', { ...auth, schema: { params, body: ProjectLogCreateSchema } },
        async (request, reply) => handle(reply, async () => ({ entry: await createLogEntry(request.userId, request.params.id, request.body) }), 'note_create', request.body.authorSessionId ? 'agent' : 'user'));
    app.post('/v1/projects/:id/log/:entry/revoke', { ...auth, schema: { params: params.extend({ entry: z.string().min(1).max(128) }), body: ProjectLogRevokeSchema.nullish() } },
        async (request, reply) => handle(reply, async () => ({ entry: await revokeLogEntry(request.userId, request.params.id, request.params.entry, request.body?.bySessionId) }), 'note_revoke', request.body?.bySessionId ? 'agent' : 'user'));
    app.post('/v1/projects/:id/messages', { ...auth, schema: { params, body: ProjectMessageCreateSchema } },
        async (request, reply) => handle(reply, async () => ({ message: await createMessage(request.userId, request.params.id, request.body), stored: true }), 'message_stored', 'agent'));
    // B-651: web-reported UX events (dispatch entry points, 等你处理 → opened latency). Counts only.
    app.post('/v1/projects/ux-events', { ...auth, bodyLimit: 8 * 1024, schema: { body: ProjectUxBatchSchema } },
        async (request, reply) => {
            const allowed = await allowAuthRequest(`project-ux:${request.userId}`, { max: 120, windowMs: 60_000, cost: request.body.events.length });
            if (!allowed) return reply.code(429).send({ error: 'project_ux_rate_limited' });
            for (const event of request.body.events) recordProjectUxEvent(event);
            return { accepted: request.body.events.length };
        });
}
