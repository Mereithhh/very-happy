/**
 * B-619 session sharing — wire shapes between happy-server's
 * sessionShareRoutes and the web. Kept as zod so a server/web skew never
 * becomes an undefined-property crash in the sidebar.
 */
import { z } from 'zod';

export const SessionShareRoleSchema = z.enum(['viewer', 'driver']);
export type SessionShareRole = z.infer<typeof SessionShareRoleSchema>;
export const SessionShareStatusSchema = z.enum(['pending', 'active', 'revoked']);
export type SessionShareStatus = z.infer<typeof SessionShareStatusSchema>;

/** Rides on a /v1/sessions row that is shared WITH this account. */
export const SessionShareInfoSchema = z.object({
    grantId: z.string(),
    role: SessionShareRoleSchema,
    owner: z.object({ id: z.string(), displayName: z.string() }),
});
export type SessionShareInfo = z.infer<typeof SessionShareInfoSchema>;

/** One grant as the OWNER sees it (share dialog). */
export const SessionGrantViewSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    role: SessionShareRoleSchema,
    status: SessionShareStatusSchema,
    createdAt: z.number(),
    acceptedAt: z.number().nullable(),
    grantee: z.object({
        id: z.string(),
        username: z.string().nullable().optional(),
        displayName: z.string(),
        email: z.string().nullable(),
        avatar: z.object({ url: z.string() }).passthrough().nullable().optional(),
    }).passthrough(),
});
export type SessionGrantView = z.infer<typeof SessionGrantViewSchema>;

/** One invitation as the GRANTEE sees it (sidebar). */
export const SharedSessionInviteSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    role: SessionShareRoleSchema,
    status: SessionShareStatusSchema,
    createdAt: z.number(),
    owner: z.object({ id: z.string(), displayName: z.string(), username: z.string().nullable(), avatarUrl: z.string().nullable() }),
    session: z.object({ name: z.string().nullable(), path: z.string().nullable(), host: z.string().nullable() }),
});
export type SharedSessionInvite = z.infer<typeof SharedSessionInviteSchema>;

export const ApiSessionShareUpdateSchema = z.object({ t: z.literal('session-share'), invite: SharedSessionInviteSchema });
export const ApiSessionShareUpdatedSchema = z.object({ t: z.literal('session-share-updated'), sessionId: z.string(), grantId: z.string(), role: SessionShareRoleSchema, status: SessionShareStatusSchema });
export const ApiSessionShareRevokedSchema = z.object({ t: z.literal('session-share-revoked'), sessionId: z.string(), grantId: z.string().nullable() });
