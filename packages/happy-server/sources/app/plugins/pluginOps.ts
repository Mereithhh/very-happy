import type { Socket } from 'socket.io';
import { PLUGIN_OP_PAYLOAD_SCHEMAS, pluginOpMissingPermission, PluginOpRequestSchema, type PluginOp, type PluginOpAck } from '@slopus/happy-wire';
import { log } from '@/utils/log';
import { pluginsEnabledFor } from './pluginConfig';
import { createWindowLimiter, effectiveGrants, PluginError } from './pluginRules';
import {
    ackEvents, disableInstall, eventResult, installInfo, machineInstall, pullEvents, putBadge, recordSensitiveRead, removeInstall,
    syncMachineInstalls, touchSeen,
} from './pluginStore';
import { deleteDecision, listDecisions, patchDecision, postDecision } from './pluginDecisions';
import { deleteWidget, getWidget, putWidget } from './pluginWidgets';

/**
 * B-974 §5.6 / §5.10 (r4): `plugin-op` on an authenticated machine socket. The socket's own identity
 * (account + machineId from the handshake, checked by validateSocketOwnership) is what an op is checked
 * against; nothing in the payload names the machine. Per op: install on THIS machine, usable state, the
 * op's permissions (wire `pluginOpMissingPermission`) against the current grants — re-read every call.
 */

const opLimiter = createWindowLimiter(1200, 60_000);

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
    return error.issues.map(i => ({ path: i.path.map(p => typeof p === 'symbol' ? String(p) : p) as (string | number)[], message: i.message }));
}

export async function handlePluginOp(accountId: string, machineId: string, envelope: unknown): Promise<PluginOpAck> {
    try {
        // Off for the account: the same 404 an older server gives (R-a; the daemon treats it as `server_too_old`).
        if (!pluginsEnabledFor(accountId)) throw new PluginError('plugins_disabled', 404);
        const request = PluginOpRequestSchema.safeParse(envelope);
        if (!request.success) throw new PluginError('invalid_request', 400, { issues: issues(request.error) });
        const { installId, op, requestId } = request.data;
        const parsed = PLUGIN_OP_PAYLOAD_SCHEMAS[op].safeParse(request.data.payload);
        if (!parsed.success) throw new PluginError('invalid_request', 400, { issues: issues(parsed.error) });
        const payload = parsed.data as any;
        const limited = opLimiter.take(`${accountId}:${machineId}`);
        if (!limited.ok) throw new PluginError('rate_limited', 429, { retryAfterMs: limited.retryAfterMs });

        if (op === 'install.sync') return ok(await syncMachineInstalls(accountId, machineId));
        if (op === 'install.disable') return ok(await disableInstall(accountId, installId!, payload, 'machine', machineId));
        if (op === 'install.remove') return ok(await removeInstall(accountId, installId!, payload, 'machine', machineId));

        const install = await machineInstall(accountId, machineId, installId);
        const missing = pluginOpMissingPermission(op, request.data.payload, effectiveGrants(install));
        if (missing) throw new PluginError('permission_denied', 403, { permission: missing });
        void touchSeen(install);
        return ok(await runOp(op, install, payload, requestId));
    } catch (error) {
        if (error instanceof PluginError) return { ok: false, status: error.status, error: error.code, ...(error.details ?? {}) } as PluginOpAck;
        log({ module: 'plugins', level: 'error', error }, 'plugin-op failed');
        return { ok: false, status: 500, error: 'internal_error' };
    }
}

async function runOp(op: PluginOp, install: Awaited<ReturnType<typeof machineInstall>>, payload: any, requestId: string): Promise<unknown> {
    switch (op) {
        case 'info': return installInfo(install);
        case 'badge.put': return putBadge(install, payload);
        case 'decision.post': return postDecision(install, payload, requestId);
        case 'decision.patch': return patchDecision(install, payload, requestId);
        case 'decision.delete': return deleteDecision(install, payload);
        case 'decision.list': return listDecisions(install, payload);
        case 'widget.put': return putWidget(install, payload);
        case 'widget.delete': return deleteWidget(install, payload.sessionId);
        case 'widget.get': return getWidget(install, payload.sessionId);
        case 'events.pull': return pullEvents(install, payload);
        case 'events.ack': return ackEvents(install, payload.upTo);
        case 'events.result': return eventResult(install, payload);
        case 'audit.sensitiveRead': return recordSensitiveRead(install, payload, requestId);
        default: throw new PluginError('invalid_request', 400, { issues: [{ path: ['op'], message: `unknown op ${op}` }] });
    }
}

function ok(result: unknown): PluginOpAck {
    return { ok: true, result };
}

/** Wires `plugin-op` on machine-scoped sockets only; any other socket gets `machine_only`. */
export function pluginOpHandler(accountId: string, socket: Socket, connection: { connectionType: string; machineId?: string }): void {
    socket.on('plugin-op', async (envelope: unknown, callback?: (ack: PluginOpAck) => void) => {
        if (typeof callback !== 'function') return;
        if (connection.connectionType !== 'machine-scoped' || !connection.machineId) {
            callback({ ok: false, status: 403, error: 'machine_only' });
            return;
        }
        callback(await handlePluginOp(accountId, connection.machineId, envelope));
    });
}
