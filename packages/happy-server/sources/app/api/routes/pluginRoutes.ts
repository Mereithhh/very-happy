import { z } from 'zod';
import type { Fastify } from '../types';
import { requestTokenKind, requireHumanOwner } from '@/app/auth/tokenKind';
import { PluginError } from '@/app/plugins/pluginRules';
import {
    approveInstall, disableInstall, enableInstall, installAudit, installDetail, listInstalls, muteInstall, rejectInstall, removeInstall,
    revokeGrants, submitInstall,
} from '@/app/plugins/pluginStore';
import { listWidgets, widgetAction } from '@/app/plugins/pluginWidgets';
import {
    PLUGIN_SERVER_FEATURE, PluginFrameTicketRequestSchema, PluginInstallApproveSchema, PluginInstallDisableSchema, PluginInstallMuteSchema,
    PluginInstallRevokeSchema, PluginWidgetActionRequestSchema,
} from '@slopus/happy-wire';
import { pluginsEnabledFor } from '@/app/plugins/pluginConfig';
import { issueFrameTicket } from '@/app/plugins/pluginFrame';
import { requestOrigin } from '../requestOrigin';

const idParams = z.object({ id: z.string().min(1).max(64) });

/**
 * B-974 Web ↔ server plugin routes (design §5.8 + r1). Errors are `{ error, ...details }`. With plugins off
 * for the account every route answers 404 `plugins_disabled` (the Web hides the feature, as on an older
 * server) — from `onRequest`, before the body is parsed or validated, so a malformed body cannot tell an
 * existing route from a missing one. Owner acts (approve / reject / revoke / mute / frame-ticket / widget
 * action) need a signed-in person (`requireHumanOwner`); a machine token may only submit, disable, remove,
 * or enable an install it disabled itself — and only an install on the machine it names.
 */
export function pluginRoutes(app: Fastify) {
    const handle = async (reply: any, work: () => Promise<unknown>) => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof PluginError) return reply.code(error.status).send({ error: error.code, ...(error.details ?? {}) });
            throw error;
        }
    };
    const pluginsOn = async (request: any, reply: any) => {
        if (!pluginsEnabledFor(request.userId)) return reply.code(404).send({ error: 'plugins_disabled' });
    };
    // Auth and the switch run in `onRequest` (headers only): with plugins off nothing reaches body parsing or the schema.
    const auth = { onRequest: [app.authenticate, pluginsOn] };
    const human = (request: any, reply: any) => requireHumanOwner(request, reply);
    const machineOf = (request: any, fromBody?: string) => {
        const header = request.headers['x-vh-machine-id'];
        return fromBody ?? (typeof header === 'string' ? header : undefined);
    };

    // §7: what this server offers this account. `plugins-v1` only while plugins are on for it (off = an older server).
    app.get('/v1/features', { preHandler: app.authenticate }, async (request) => ({ features: pluginsEnabledFor(request.userId) ? [PLUGIN_SERVER_FEATURE] : [] }));

    app.get('/v1/plugins/installs', auth, async (request, reply) => handle(reply, () => listInstalls(request.userId)));

    // CLI `add` / `update` (machine token). The machine is named by `machineId` (body) or `X-VH-Machine-Id`; it
    // must be this account's machine, and only a `pending` install can come of it.
    app.post('/v1/plugins/installs', { ...auth, schema: { body: z.object({ manifest: z.unknown(), machineId: z.string().min(1).max(128).optional(), requestId: z.string().max(128).optional() }) } },
        async (request, reply) => handle(reply, async () => {
            const header = request.headers['x-vh-machine-id'];
            const machineId = request.body.machineId ?? (typeof header === 'string' ? header : undefined);
            if (!machineId) throw new PluginError('machine_id_required', 400);
            const result = await submitInstall(request.userId, { manifest: request.body.manifest, machineId, requestId: request.body.requestId });
            return reply.code(result.state === 'pending' ? 201 : 200).send(result);
        }));

    app.get('/v1/plugins/installs/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => installDetail(request.userId, request.params.id));
    });

    app.get('/v1/plugins/installs/:id/audit', { ...auth, schema: { params: idParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }) } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => installAudit(request.userId, request.params.id, request.query.limit));
    });

    app.post('/v1/plugins/installs/:id/approve', { ...auth, schema: { params: idParams, body: PluginInstallApproveSchema } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => approveInstall(request.userId, request.params.id, request.body));
    });

    app.post('/v1/plugins/installs/:id/reject', { ...auth, schema: { params: idParams } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => rejectInstall(request.userId, request.params.id));
    });

    const machineScoped = PluginInstallDisableSchema.extend({ machineId: z.string().max(128).optional() }).optional();
    app.post('/v1/plugins/installs/:id/disable', { ...auth, schema: { params: idParams, body: machineScoped } }, async (request, reply) => handle(reply, () => {
        const isHuman = requestTokenKind(request) === 'human';
        const header = request.headers['x-vh-machine-id'];
        const machineId = request.body?.machineId ?? (typeof header === 'string' ? header : undefined);
        if (!isHuman && !machineId) throw new PluginError('machine_id_required', 400);
        return disableInstall(request.userId, request.params.id, { reason: request.body?.reason }, isHuman ? 'owner' : 'machine', isHuman ? undefined : machineId);
    }));

    // A machine token re-enables only what it disabled itself, on the machine it names (CLI `plugin enable`).
    app.post('/v1/plugins/installs/:id/enable', { ...auth, schema: { params: idParams, body: z.object({ machineId: z.string().max(128).optional() }).nullish() } }, async (request, reply) => handle(reply, () => {
        if (requestTokenKind(request) === 'human') return enableInstall(request.userId, request.params.id);
        const machineId = machineOf(request, request.body?.machineId);
        if (!machineId) throw new PluginError('machine_id_required', 400);
        return enableInstall(request.userId, request.params.id, machineId);
    }));

    app.delete('/v1/plugins/installs/:id', { ...auth, schema: { params: idParams, querystring: z.object({ machineId: z.string().max(128).optional(), keepItems: z.enum(['1', 'true', '0', 'false']).optional() }) } }, async (request, reply) => handle(reply, () => {
        const isHuman = requestTokenKind(request) === 'human';
        const header = request.headers['x-vh-machine-id'];
        const machineId = request.query.machineId ?? (typeof header === 'string' ? header : undefined);
        if (!isHuman && !machineId) throw new PluginError('machine_id_required', 400);
        const keepItems = request.query.keepItems === '1' || request.query.keepItems === 'true';
        return removeInstall(request.userId, request.params.id, { keepItems }, isHuman ? 'owner' : 'machine', isHuman ? undefined : machineId);
    }));

    app.post('/v1/plugins/installs/:id/grants', { ...auth, schema: { params: idParams, body: PluginInstallRevokeSchema } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => revokeGrants(request.userId, request.params.id, request.body.revoke));
    });

    app.post('/v1/plugins/installs/:id/mute', { ...auth, schema: { params: idParams, body: PluginInstallMuteSchema } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => muteInstall(request.userId, request.params.id, request.body.muted));
    });

    app.post('/v1/plugins/installs/:id/frame-ticket', { ...auth, schema: { params: idParams, body: PluginFrameTicketRequestSchema } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => issueFrameTicket(request.userId, request.params.id, request.body, { loginSessionId: request.authLoginSessionId!, webOrigin: typeof request.headers.origin === 'string' ? request.headers.origin : requestOrigin(request) }));
    });

    app.get('/v1/plugins/widgets', { ...auth, schema: { querystring: z.object({ sessionId: z.string().max(128).optional() }) } },
        async (request, reply) => handle(reply, () => listWidgets(request.userId, request.query.sessionId)));

    app.post('/v1/plugins/widgets/:installId/:sessionId/action', { ...auth, schema: { params: z.object({ installId: z.string().max(64), sessionId: z.string().max(128) }), body: PluginWidgetActionRequestSchema } }, async (request, reply) => {
        if (!human(request, reply)) return reply;
        return handle(reply, () => widgetAction(request.userId, request.params.installId, request.params.sessionId, request.body.actionId));
    });

    // Any other `/v1/plugins/*` path: the same `plugins_disabled` while off, so a probe cannot tell real routes from missing ones.
    app.all('/v1/plugins/*', auth, async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
}
