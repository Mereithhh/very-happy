/**
 * B-878 terminal sharing — REST client (same error contract as apiSessionShares:
 * parsed data or a SessionShareApiError carrying the server's stable code).
 */
import { z } from 'zod';
import { apiSocket } from './apiSocket';
import { SessionShareApiError, type ShareTarget } from './apiSessionShares';
import {
    IncomingTerminalShareSchema,
    TerminalGrantViewSchema,
    TerminalShareEventSchema,
    type IncomingTerminalShare,
    type TerminalGrantView,
    type TerminalShareEvent,
    type TerminalShareExpiry,
    type TerminalShareRole,
} from './terminalShareTypes';

async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await apiSocket.request(path, init);
    if (!response.ok) {
        let code = `http_${response.status}`;
        try {
            const body = await response.json() as { error?: unknown };
            if (typeof body.error === 'string') code = body.error;
        } catch { /* non-JSON error body */ }
        throw new SessionShareApiError(code, response.status);
    }
    return schema.parse(await response.json());
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ok = z.object({ ok: z.literal(true) });

export function createTerminalGrant(input: { machineId: string; terminalId: string; title?: string; who: ShareTarget; role: TerminalShareRole; expiresInDays: TerminalShareExpiry; confirmOperator?: true }): Promise<TerminalGrantView> {
    const { who, ...rest } = input;
    return call('/v1/terminal-shares', z.object({ grant: TerminalGrantViewSchema }), json({ ...rest, ...who, ...(rest.title ? { title: rest.title.slice(0, 200) } : {}) })).then((r) => r.grant);
}

export function listTerminalGrants(machineId: string, terminalId: string): Promise<TerminalGrantView[]> {
    const q = new URLSearchParams({ machineId, terminalId });
    return call(`/v1/terminal-shares?${q}`, z.object({ grants: z.array(TerminalGrantViewSchema) })).then((r) => r.grants);
}

export function listOutgoingTerminalGrants(): Promise<TerminalGrantView[]> {
    return call('/v1/terminal-shares/outgoing', z.object({ grants: z.array(TerminalGrantViewSchema) })).then((r) => r.grants);
}

export function listIncomingTerminalShares(): Promise<IncomingTerminalShare[]> {
    return call('/v1/terminal-shares/incoming', z.object({ shares: z.array(IncomingTerminalShareSchema) })).then((r) => r.shares);
}

export function updateTerminalGrant(grantId: string, change: { role?: TerminalShareRole; expiresInDays?: TerminalShareExpiry; confirmOperator?: true }): Promise<TerminalGrantView> {
    return call(`/v1/terminal-shares/${encodeURIComponent(grantId)}`, z.object({ grant: TerminalGrantViewSchema }), json(change, 'PATCH')).then((r) => r.grant);
}

export function revokeTerminalGrant(grantId: string): Promise<void> {
    return call(`/v1/terminal-shares/${encodeURIComponent(grantId)}`, ok, { method: 'DELETE' }).then(() => undefined);
}

export function respondToTerminalGrant(grantId: string, accept: boolean): Promise<void> {
    return call(`/v1/terminal-shares/${encodeURIComponent(grantId)}/respond`, ok, json({ accept })).then(() => undefined);
}

export function listTerminalGrantEvents(grantId: string): Promise<TerminalShareEvent[]> {
    return call(`/v1/terminal-shares/${encodeURIComponent(grantId)}/events?limit=100`, z.object({ events: z.array(TerminalShareEventSchema) })).then((r) => r.events);
}
