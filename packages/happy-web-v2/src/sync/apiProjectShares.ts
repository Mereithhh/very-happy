/** B-878 PR-B project sharing — REST client (same error contract as apiSessionShares). */
import { z } from 'zod';
import { apiSocket } from './apiSocket';
import { SessionShareApiError, type ShareTarget } from './apiSessionShares';
import {
    IncomingProjectShareSchema,
    ProjectGrantViewSchema,
    SharedProjectPageSchema,
    type IncomingProjectShare,
    type ProjectGrantView,
    type ProjectShareExpiry,
    type ProjectShareRole,
    type SharedProjectPage,
} from './projectShareTypes';

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
const p = (id: string) => `/v1/projects/${encodeURIComponent(id)}/shares`;

export function createProjectGrant(projectId: string, who: ShareTarget, role: ProjectShareRole, expiresInDays: ProjectShareExpiry): Promise<ProjectGrantView> {
    return call(p(projectId), z.object({ grant: ProjectGrantViewSchema }), json({ ...who, role, expiresInDays })).then((r) => r.grant);
}
export function listProjectGrants(projectId: string): Promise<ProjectGrantView[]> {
    return call(p(projectId), z.object({ grants: z.array(ProjectGrantViewSchema) })).then((r) => r.grants);
}
export function updateProjectGrant(projectId: string, accountId: string, change: { role?: ProjectShareRole; expiresInDays?: ProjectShareExpiry }): Promise<ProjectGrantView> {
    return call(`${p(projectId)}/${encodeURIComponent(accountId)}`, z.object({ grant: ProjectGrantViewSchema }), json(change, 'PATCH')).then((r) => r.grant);
}
export function revokeProjectGrant(projectId: string, accountId: string): Promise<void> {
    return call(`${p(projectId)}/${encodeURIComponent(accountId)}`, ok, { method: 'DELETE' }).then(() => undefined);
}
export function listOutgoingProjectGrants(): Promise<ProjectGrantView[]> {
    return call('/v1/project-shares/outgoing', z.object({ grants: z.array(ProjectGrantViewSchema) })).then((r) => r.grants);
}
export function listIncomingProjectShares(): Promise<IncomingProjectShare[]> {
    return call('/v1/project-shares/incoming', z.object({ shares: z.array(IncomingProjectShareSchema) })).then((r) => r.shares);
}
export function respondToProjectGrant(grantId: string, accept: boolean): Promise<void> {
    return call(`/v1/project-shares/${encodeURIComponent(grantId)}/respond`, ok, json({ accept })).then(() => undefined);
}
export function getSharedProject(grantId: string): Promise<SharedProjectPage> {
    return call(`/v1/project-shares/${encodeURIComponent(grantId)}`, SharedProjectPageSchema);
}
