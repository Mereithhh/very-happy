import { z } from 'zod';
import {
    ISSUES_DISABLED_ERROR, IssueAgentCommentSchema, IssueAgentUpdateSchema, IssueCommentCreateSchema, IssueCreateSchema, IssueDispatchClaimSchema,
    IssueDispatchCompleteSchema, IssueDispatchFailSchema, IssueDispatchPollQuerySchema, IssueListQuerySchema, IssueRunAckSchema, IssueRunCancelSchema,
    IssueRunCreateSchema, IssueRunSessionEventSchema, IssueUpdateSchema, ISSUE_LIMITS,
} from '@slopus/happy-wire';
import type { Fastify } from '../types';
import { IssueError, issuesEnabled } from '@/app/issues/rules';
import {
    ackRunFailure, agentComment, agentUpdate, cancelRun, createComment, createIssue, createRun, deleteComment, deleteIssue, editComment, getIssue,
    listIssues, sessionIssueContext, updateIssueFields,
} from '@/app/issues/store';
import { claimDispatch, completeDispatch, failDispatch, listWorkers, pollDispatches, runSessionEvent } from '@/app/issues/dispatch';
import { importLegacyTodos } from '@/app/issues/todoImport';

const ref = z.string().min(1).max(128);
const params = z.object({ id: ref });
const commentParams = z.object({ id: ref, commentId: ref });
const runParams = z.object({ runId: ref });
const sessionParams = z.object({ sessionId: ref });
/**
 * The wire schema only admits the agent statuses; the route widens `status`
 * to any short string so a done / cancelled attempt reaches
 * `checkAgentStatusChange` and is refused as `issue_status_forbidden` (the
 * code the MCP tool and CLI branch on) instead of a generic validation 400.
 */
const agentUpdateBody = z.object({ ...IssueAgentUpdateSchema.shape, status: z.string().min(1).max(64).optional() })
    .refine(v => v.status !== undefined || v.comment !== undefined, 'status or comment required');
const commentEdit = z.object({ body: z.string().max(ISSUE_LIMITS.commentBytes).refine(v => new TextEncoder().encode(v).length <= ISSUE_LIMITS.commentBytes).pipe(z.string().trim().min(1)) });

/**
 * B-872 Issues REST (`specs/2026-11-issues.md` §9). Account-authenticated.
 * While `VH_ISSUES_ENABLED` is not `true` every route answers 404
 * `issues_disabled` before validation or auth — the same "nothing here" an
 * older server's unknown route gives (compat matrix). Errors are
 * `{ error, ...details }`, never 401/403 (Web treats those as signed out).
 *
 * Static segments (`workers`, `session`, `agent`, `dispatch`, `runs`,
 * `import-legacy-todos`) are registered before `/:id`.
 */
export function issueRoutes(app: Fastify) {
    const gate = {
        onRequest: async (_request: unknown, reply: any) => {
            if (!issuesEnabled()) return reply.code(404).send({ error: ISSUES_DISABLED_ERROR });
        },
        preHandler: app.authenticate,
    };
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try { return await work(); }
        catch (error) {
            if (error instanceof IssueError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            throw error;
        }
    };

    app.get('/v1/issues', { ...gate, schema: { querystring: IssueListQuerySchema } },
        async (request, reply) => handle(reply, () => listIssues(request.userId, request.query)));
    app.post('/v1/issues', { ...gate, schema: { body: IssueCreateSchema } },
        async (request, reply) => handle(reply, () => createIssue(request.userId, request.body)));

    app.get('/v1/issues/workers', gate,
        async (request, reply) => handle(reply, () => listWorkers(request.userId)));
    app.post('/v1/issues/import-legacy-todos', gate,
        async (request, reply) => handle(reply, () => importLegacyTodos(request.userId)));

    // Wrapper (agent) paths: the wrapper stamps its own sessionId.
    app.get('/v1/issues/session/:sessionId', { ...gate, schema: { params: sessionParams, querystring: z.object({ since: z.coerce.number().int().min(0).optional() }) } },
        async (request, reply) => handle(reply, () => sessionIssueContext(request.userId, request.params.sessionId, request.query.since)));
    app.post('/v1/issues/agent/update', { ...gate, schema: { body: agentUpdateBody } },
        async (request, reply) => handle(reply, () => agentUpdate(request.userId, request.body)));
    app.post('/v1/issues/agent/comment', { ...gate, schema: { body: IssueAgentCommentSchema } },
        async (request, reply) => handle(reply, () => agentComment(request.userId, request.body)));

    // Daemon worker paths.
    app.get('/v1/issues/dispatch', { ...gate, schema: { querystring: IssueDispatchPollQuerySchema } },
        async (request, reply) => handle(reply, () => pollDispatches(request.userId, request.query.machineId, request.query.workerVersion)));
    app.post('/v1/issues/dispatch/:id/claim', { ...gate, schema: { params, body: IssueDispatchClaimSchema } },
        async (request, reply) => handle(reply, () => claimDispatch(request.userId, request.params.id, request.body.machineId)));
    app.post('/v1/issues/dispatch/:id/complete', { ...gate, schema: { params, body: IssueDispatchCompleteSchema } },
        async (request, reply) => handle(reply, () => completeDispatch(request.userId, request.params.id, request.body)));
    app.post('/v1/issues/dispatch/:id/fail', { ...gate, schema: { params, body: IssueDispatchFailSchema } },
        async (request, reply) => handle(reply, () => failDispatch(request.userId, request.params.id, request.body)));
    app.post('/v1/issues/runs/:runId/session-event', { ...gate, schema: { params: runParams, body: IssueRunSessionEventSchema } },
        async (request, reply) => handle(reply, () => runSessionEvent(request.userId, request.params.runId, request.body)));

    app.post('/v1/issues/runs/:runId/cancel', { ...gate, schema: { params: runParams, body: IssueRunCancelSchema.nullish() } },
        async (request, reply) => handle(reply, () => cancelRun(request.userId, request.params.runId)));
    app.post('/v1/issues/runs/:runId/ack-failure', { ...gate, schema: { params: runParams, body: IssueRunAckSchema.nullish() } },
        async (request, reply) => handle(reply, () => ackRunFailure(request.userId, request.params.runId)));

    app.get('/v1/issues/:id', { ...gate, schema: { params } },
        async (request, reply) => handle(reply, () => getIssue(request.userId, request.params.id)));
    app.patch('/v1/issues/:id', { ...gate, schema: { params, body: IssueUpdateSchema } },
        async (request, reply) => handle(reply, () => updateIssueFields(request.userId, request.params.id, request.body)));
    app.delete('/v1/issues/:id', { ...gate, schema: { params } },
        async (request, reply) => handle(reply, () => deleteIssue(request.userId, request.params.id)));
    app.post('/v1/issues/:id/comments', { ...gate, schema: { params, body: IssueCommentCreateSchema } },
        async (request, reply) => handle(reply, () => createComment(request.userId, request.params.id, request.body)));
    app.patch('/v1/issues/:id/comments/:commentId', { ...gate, schema: { params: commentParams, body: commentEdit } },
        async (request, reply) => handle(reply, () => editComment(request.userId, request.params.id, request.params.commentId, request.body.body)));
    app.delete('/v1/issues/:id/comments/:commentId', { ...gate, schema: { params: commentParams } },
        async (request, reply) => handle(reply, () => deleteComment(request.userId, request.params.id, request.params.commentId)));
    app.post('/v1/issues/:id/runs', { ...gate, schema: { params, body: IssueRunCreateSchema } },
        async (request, reply) => handle(reply, () => createRun(request.userId, request.params.id, request.body)));
}
