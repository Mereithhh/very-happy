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
    // B-867: operator tier = role 'driver' + operate. Absent on servers before B-867.
    operate: z.boolean().optional(),
    // B-867: when the grant expires (operator grants always do); absent on older servers.
    expiresAt: z.number().nullable().optional(),
    // B-867b: operator mode cap (owner's mode at grant time, moved only by the owner); null for non-operators,
    // absent on servers before B-867b. Plain string on purpose: an unknown future mode must not drop the row.
    modeCap: z.string().nullable().optional(),
    owner: z.object({ id: z.string(), displayName: z.string() }),
    // B-878 PR-B: how the row is reachable — 'project' rows live under their shared project and are left as a project.
    // Plain strings: an unknown future value must not drop the row.
    via: z.string().optional(),
    projectId: z.string().optional(),
    projectGrantId: z.string().optional(),
});
export type SessionShareInfo = z.infer<typeof SessionShareInfoSchema>;

/** One grant as the OWNER sees it (share dialog). */
export const SessionGrantViewSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    role: SessionShareRoleSchema,
    operate: z.boolean().optional(),
    status: SessionShareStatusSchema,
    createdAt: z.number(),
    acceptedAt: z.number().nullable(),
    // B-701: null = never; absent on servers before B-701.
    expiresAt: z.number().nullable().optional(),
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
    operate: z.boolean().optional(),
    status: SessionShareStatusSchema,
    createdAt: z.number(),
    expiresAt: z.number().nullable().optional(),
    owner: z.object({ id: z.string(), displayName: z.string(), username: z.string().nullable(), avatarUrl: z.string().nullable() }),
    session: z.object({ name: z.string().nullable(), path: z.string().nullable(), host: z.string().nullable() }),
});
export type SharedSessionInvite = z.infer<typeof SharedSessionInviteSchema>;

export const ApiSessionShareUpdateSchema = z.object({ t: z.literal('session-share'), invite: SharedSessionInviteSchema });
export const ApiSessionShareUpdatedSchema = z.object({ t: z.literal('session-share-updated'), sessionId: z.string(), grantId: z.string(), role: SessionShareRoleSchema, operate: z.boolean().optional(), status: SessionShareStatusSchema });
export const ApiSessionShareRevokedSchema = z.object({ t: z.literal('session-share-revoked'), sessionId: z.string(), grantId: z.string().nullable() });

// ---------------------------------------------------------------- B-701 share links

/** 1 / 7 / 30 days, or null = never. */
export type ShareExpiryDays = 1 | 7 | 30 | null;
export const SHARE_EXPIRY_CHOICES: ShareExpiryDays[] = [1, 7, 30, null];

export const ShareLinkScopeSchema = z.enum(['snapshot', 'live']);
export type ShareLinkScope = z.infer<typeof ShareLinkScopeSchema>;

export const ShareLinkViewSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    scope: ShareLinkScopeSchema,
    status: z.enum(['active', 'revoked', 'expired']),
    snapshotAt: z.number().nullable(),
    expiresAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    createdAt: z.number(),
    accessCount: z.number(),
    lastAccessedAt: z.number().nullable(),
});
export type ShareLinkView = z.infer<typeof ShareLinkViewSchema>;

/** Link opens are anonymous: when, and whether it was a link-preview bot. */
export const ShareLinkAccessSchema = z.object({
    at: z.number(),
    bot: z.boolean(),
});
export type ShareLinkAccess = z.infer<typeof ShareLinkAccessSchema>;

export const OutgoingSharesSchema = z.object({
    sessions: z.array(z.object({
        sessionId: z.string(),
        title: z.string().nullable(),
        grants: z.array(z.object({
            id: z.string(),
            grantee: z.object({ id: z.string(), displayName: z.string() }),
            role: SessionShareRoleSchema,
            operate: z.boolean().optional(),
            status: z.string(),
            expiresAt: z.number().nullable(),
            createdAt: z.number(),
        })),
        links: z.array(ShareLinkViewSchema),
    })),
});
export type OutgoingShares = z.infer<typeof OutgoingSharesSchema>;

export const PublicLinkInfoSchema = z.object({
    linkId: z.string(),
    scope: ShareLinkScopeSchema,
    snapshotAt: z.number().nullable(),
    expiresAt: z.number().nullable(),
    owner: z.object({ displayName: z.string() }),
    session: z.object({ title: z.string().nullable(), project: z.string().nullable(), flavor: z.string().nullable(), createdAt: z.number(), archived: z.boolean() }),
});
export type PublicLinkInfo = z.infer<typeof PublicLinkInfoSchema>;

export const PublicLinkMessagesSchema = z.object({
    messages: z.array(z.object({ id: z.string(), seq: z.number(), createdAt: z.number(), content: z.unknown() })),
    hasMore: z.boolean(),
    lastSeq: z.number(),
});
export type PublicLinkMessages = z.infer<typeof PublicLinkMessagesSchema>;

// ---------------------------------------------------------------- B-867 operator tier

/** What the share dialog lets the owner pick. `operator` is wire role 'driver' + operate:true. */
export type ShareTier = 'viewer' | 'driver' | 'operator';
/** Operator grants must expire (spec §5.3): no "never". */
export const OPERATOR_EXPIRY_CHOICES: Exclude<ShareExpiryDays, null>[] = [1, 7, 30];

export function tierOf(grant: { role: SessionShareRole; operate?: boolean }): ShareTier {
    if (grant.role === 'driver' && grant.operate === true) return 'operator';
    return grant.role;
}

export const OperatorEventSchema = z.object({
    id: z.string(),
    kind: z.string(),
    actorAccountId: z.string(),
    detail: z.record(z.string(), z.unknown()).nullable().optional(),
    at: z.number(),
});
export type OperatorEvent = z.infer<typeof OperatorEventSchema>;

export const OperatorActivitySchema = z.object({
    granteeAccountId: z.string(),
    displayName: z.string(),
    openTerminals: z.number(),
    lastActivityAt: z.number().nullable(),
});
export type OperatorActivity = z.infer<typeof OperatorActivitySchema>;

/** Socket `operator-activity` (owner side). */
export const OperatorActivityEventSchema = OperatorActivitySchema.extend({ sessionId: z.string() });

/** Socket `operator-revoked` (grantee side). */
export const OperatorRevokedEventSchema = z.object({ sessionId: z.string(), reason: z.string() });

/** "Is operating now": an open terminal, or any operator action within the last two minutes (spec §12.1). */
export const OPERATOR_ACTIVE_WINDOW_MS = 2 * 60_000;
export function isOperatingNow(a: Pick<OperatorActivity, 'openTerminals' | 'lastActivityAt'>, now = Date.now()): boolean {
    return a.openTerminals > 0 || (a.lastActivityAt !== null && now - a.lastActivityAt < OPERATOR_ACTIVE_WINDOW_MS);
}
