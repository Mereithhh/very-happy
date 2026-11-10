import type { Automation } from '@slopus/happy-wire';
import { sharedProjectsClient } from '@/projects/client';

/**
 * B-917: the project an automation's spawned sessions join (B-644 `projectId`).
 * Shared by `very-happy auto --project` and the `automation_create/update` MCP
 * tools. `'current'` = the project of the managed session running this
 * (VH_PEER_SESSION_ID); `null` detaches; `undefined` leaves it unchanged.
 * Ownership is enforced by the server (`project_not_found`), not here.
 */
export type ProjectMembershipLookup = (sessionId: string) => Promise<{ projectId: string | null }>;

export async function resolveAutomationProject(ref: string | null | undefined, deps: { env?: NodeJS.ProcessEnv; membership?: ProjectMembershipLookup } = {}): Promise<string | null | undefined> {
    if (ref === undefined || ref === null) return ref;
    const project = ref.trim();
    if (!project) throw new Error('project needs a project id or `current`');
    if (project !== 'current') return project;
    const sessionId = (deps.env ?? process.env).VH_PEER_SESSION_ID;
    if (!sessionId) throw new Error('project `current` only works inside a Very Happy managed session; pass the project id instead');
    const membership = await (deps.membership ?? ((id: string) => sharedProjectsClient().membership(id)))(sessionId);
    if (!membership.projectId) throw new Error('This session does not belong to a project; pass a project id or omit it');
    return membership.projectId;
}

/** An older server strips `projectId` (B-644): say so instead of reporting a silent success. */
export function automationProjectNotice(requested: string | null | undefined, automation: Automation): string | null {
    if (requested === undefined) return null;
    if (!Object.prototype.hasOwnProperty.call(automation, 'projectId')) return 'This server does not support automation projects: the project setting was ignored. Upgrade the server, or set the project in the Web automation editor.';
    return null;
}
