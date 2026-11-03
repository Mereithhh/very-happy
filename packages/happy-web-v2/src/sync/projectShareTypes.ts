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
    })).default([]),
});
export type SharedProjectPage = z.infer<typeof SharedProjectPageSchema>;

export const ProjectShareChangedSchema = z.object({ grantId: z.string() });
export const ProjectShareRevokedSchema = z.object({ grantId: z.string(), reason: z.string().optional() });

/** A project terminal share id (`p:<projectGrantId>:<machineId>:<terminalId>`) → its project grant id, else null. Pure. */
export function projectGrantIdOfShareId(shareId: string): string | null {
    if (!shareId.startsWith('p:')) return null;
    const parts = shareId.split(':');
    return parts.length === 4 && parts[1] ? parts[1] : null;
}
