/**
 * B-878 PR-B project sharing — wire shapes (spec specs/2026-11-share-terminals-and-projects.md §4, §7).
 * safeParse / transforms everywhere, so a newer server never breaks this client.
 */
import { z } from 'zod';

export type ProjectShareRole = 'viewer' | 'driver';
export type ProjectShareExpiry = 1 | 7 | 30 | null;

const roleSchema = z.string().transform((v): ProjectShareRole => (v === 'driver' ? 'driver' : 'viewer'));
const statusSchema = z.string().transform((v): 'pending' | 'active' | 'revoked' => (v === 'active' || v === 'revoked' ? v : 'pending'));
const PersonSchema = z.object({ id: z.string(), displayName: z.string(), username: z.string().nullable().optional() });

export const ProjectGrantViewSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    role: roleSchema,
    status: statusSchema,
    createdAt: z.number(),
    acceptedAt: z.number().nullable().optional(),
    expiresAt: z.number().nullable().optional(),
    grantee: PersonSchema,
    projectName: z.string().optional(),
});
export type ProjectGrantView = z.infer<typeof ProjectGrantViewSchema>;

export const IncomingProjectShareSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    role: roleSchema,
    status: statusSchema,
    granteeKey: z.string(),
    name: z.string(),
    createdAt: z.number(),
    expiresAt: z.number().nullable().optional(),
    owner: PersonSchema,
});
export type IncomingProjectShare = z.infer<typeof IncomingProjectShareSchema>;

export const SharedProjectPageSchema = z.object({
    project: z.object({
        id: z.string(),
        name: z.string(),
        goal: z.string().nullable().optional(),
        instructions: z.string().nullable().optional(),
        archivedAt: z.number().nullable().optional(),
        folders: z.array(z.object({ machineId: z.string(), name: z.string(), primary: z.boolean().optional() })).default([]),
    }),
    log: z.array(z.object({
        id: z.string(),
        seq: z.number().optional(),
        kind: z.string(),
        title: z.string(),
        body: z.string().nullable().optional(),
        supersededBy: z.string().nullable().optional(),
        createdAt: z.number(),
        byAgent: z.boolean().optional(),
    })).default([]),
    sessionIds: z.array(z.string()).default([]),
    terminals: z.array(z.object({
        shareId: z.string(),
        machineId: z.string(),
        terminalId: z.string(),
        title: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        viewOnlySupported: z.boolean().optional(),
        // B-899: my own live direct grant on this terminal (effective = max(direct, project)); old servers omit it.
        direct: z.object({
            grantId: z.string(),
            role: z.string().transform((v): 'viewer' | 'operator' => (v === 'operator' ? 'operator' : 'viewer')),
            status: z.string().transform((v): 'pending' | 'active' => (v === 'active' ? 'active' : 'pending')),
            expiresAt: z.number(),
        }).nullable().optional().catch(undefined),
    })).default([]),
});
export type SharedProjectPage = z.infer<typeof SharedProjectPageSchema>;

export const ProjectShareChangedSchema = z.object({ grantId: z.string() });
export const ProjectShareRevokedSchema = z.object({ grantId: z.string(), reason: z.string().optional() });

export type SharedProjectTerminal = SharedProjectPage['terminals'][number];
export type ProjectTerminalLink = { shareId: string; role: 'viewer' | 'operator'; via: 'direct' | 'project'; pending: boolean };

/**
 * B-899: where a project page's terminal row leads. effective = max(direct, project): my own unexpired direct
 * grant wins (its page operates when it is "can operate", or asks me to accept it first); otherwise — none, or
 * it expired since the page was read — the view-only project share. Pure.
 */
export function projectTerminalLink(term: SharedProjectTerminal, now: number): ProjectTerminalLink {
    const direct = term.direct;
    if (direct && direct.expiresAt > now) return { shareId: direct.grantId, role: direct.role, via: 'direct', pending: direct.status === 'pending' };
    return { shareId: term.shareId, role: 'viewer', via: 'project', pending: false };
}

/** A project terminal share id (`p:<projectGrantId>:<machineId>:<terminalId>`) → its project grant id, else null. Pure. */
export function projectGrantIdOfShareId(shareId: string): string | null {
    if (!shareId.startsWith('p:')) return null;
    const parts = shareId.split(':');
    return parts.length === 4 && parts[1] ? parts[1] : null;
}

/** B-900: the project's terminals whose direct grant to me still waits for my accept (one "Accept all"). Pure. */
export function pendingDirectGrantIds(terminals: ReadonlyArray<SharedProjectTerminal>, now: number): string[] {
    return terminals.map((term) => projectTerminalLink(term, now)).filter((l) => l.via === 'direct' && l.pending).map((l) => l.shareId);
}
