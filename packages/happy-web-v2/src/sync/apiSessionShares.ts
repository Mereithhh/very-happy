/**
 * B-619 session sharing — REST client. Same shape as apiAutomations: every
 * call returns parsed data or throws SessionShareApiError with the server's
 * stable error code, so screens can map codes to copy.
 */
import { z } from 'zod';
import { apiSocket } from './apiSocket';
import {
    OperatorActivitySchema,
    OperatorEventSchema,
    OutgoingSharesSchema,
    type OperatorActivity,
    type OperatorEvent,
    SessionGrantViewSchema,
    ShareLinkAccessSchema,
    ShareLinkViewSchema,
    type OutgoingShares,
    type ShareExpiryDays,
    type ShareLinkAccess,
    type ShareLinkScope,
    type ShareLinkView,
    SharedSessionInviteSchema,
    type SessionGrantView,
    type SessionShareRole,
    type SharedSessionInvite,
} from './sessionShareTypes';

export class SessionShareApiError extends Error {
    constructor(readonly code: string, readonly status: number) {
        super(code);
    }
}

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

const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export function listSessionGrants(sessionId: string): Promise<SessionGrantView[]> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shares`, z.object({ grants: z.array(SessionGrantViewSchema) })).then((r) => r.grants);
}

/** B-621: share to a typed target (email / handle) or to a directory account id (friend picker). */
export type ShareTarget = { target: string } | { accountId: string };

/**
 * B-867: the operator tier rides on role 'driver'. The server refuses it
 * without `confirmOperator: true` and a finite expiry; the dialog only sends
 * this after the owner ticked the acknowledgement AND confirmed the modal.
 */
export type OperatorGrantOptions = { operate: true; confirmOperator: true };

export function createSessionGrant(sessionId: string, who: ShareTarget, role: SessionShareRole, expiresInDays?: ShareExpiryDays, operator?: OperatorGrantOptions): Promise<SessionGrantView> {
    // B-701: omit expiresInDays for "never" so a pre-B-701 server (which strips unknown keys anyway) sees the same body.
    const base = expiresInDays ? { ...who, role, expiresInDays } : { ...who, role };
    const body = operator ? { ...base, ...operator } : base;
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shares`, z.object({ grant: SessionGrantViewSchema }), json(body)).then((r) => r.grant);
}

export function updateSessionGrant(sessionId: string, accountId: string, change: { role?: SessionShareRole; expiresInDays?: ShareExpiryDays; operate?: boolean; confirmOperator?: true; endOperation?: true }): Promise<SessionGrantView> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shares/${encodeURIComponent(accountId)}`, z.object({ grant: SessionGrantViewSchema }), json(change, 'PATCH')).then((r) => r.grant);
}

export function updateSessionGrantRole(sessionId: string, accountId: string, role: SessionShareRole): Promise<SessionGrantView> {
    return updateSessionGrant(sessionId, accountId, { role });
}

// ---------------------------------------------------------------- B-867 operator audit / presence (owner side)

export function listOperatorEvents(sessionId: string, accountId: string, limit = 100): Promise<OperatorEvent[]> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shares/${encodeURIComponent(accountId)}/operator-events?limit=${limit}`, z.object({ events: z.array(OperatorEventSchema) })).then((r) => r.events);
}

export function getOperatorActivity(sessionId: string): Promise<OperatorActivity[]> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/operator-activity`, z.object({ operators: z.array(OperatorActivitySchema) })).then((r) => r.operators);
}

// ---------------------------------------------------------------- B-701 share links (owner side)

const LinkWithSecretSchema = z.object({ link: ShareLinkViewSchema, secret: z.string() });
export type CreatedShareLink = z.infer<typeof LinkWithSecretSchema>;
const linkPath = (sessionId: string, linkId?: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/share-links${linkId ? `/${encodeURIComponent(linkId)}` : ''}`;

export function listShareLinks(sessionId: string): Promise<ShareLinkView[]> {
    return call(linkPath(sessionId), z.object({ links: z.array(ShareLinkViewSchema) })).then((r) => r.links);
}

export function createShareLink(sessionId: string, scope: ShareLinkScope, expiresInDays: ShareExpiryDays): Promise<CreatedShareLink> {
    return call(linkPath(sessionId), LinkWithSecretSchema, json({ scope, expiresInDays }));
}

export function updateShareLink(sessionId: string, linkId: string, change: { snapshotToNow?: true; expiresInDays?: ShareExpiryDays }): Promise<ShareLinkView> {
    return call(linkPath(sessionId, linkId), z.object({ link: ShareLinkViewSchema }), json(change, 'PATCH')).then((r) => r.link);
}

export function rotateShareLink(sessionId: string, linkId: string): Promise<CreatedShareLink> {
    return call(`${linkPath(sessionId, linkId)}/rotate`, LinkWithSecretSchema, { method: 'POST' });
}

export function revokeShareLink(sessionId: string, linkId: string): Promise<void> {
    return call(linkPath(sessionId, linkId), z.object({ ok: z.boolean() }), { method: 'DELETE' }).then(() => undefined);
}

export function listShareLinkAccesses(linkId: string): Promise<ShareLinkAccess[]> {
    return call(`/v1/share-links/${encodeURIComponent(linkId)}/accesses`, z.object({ accesses: z.array(ShareLinkAccessSchema) })).then((r) => r.accesses);
}

export function listOutgoingShares(): Promise<OutgoingShares> {
    return call('/v1/shares/outgoing', OutgoingSharesSchema);
}

/** The URL handed out: the secret rides in the fragment so it never reaches a server log or Referer. */
export function shareLinkUrl(origin: string, linkId: string, secret: string): string {
    return `${origin.replace(/\/$/, '')}/s/${encodeURIComponent(linkId)}#${secret}`;
}

export function revokeSessionGrant(sessionId: string, accountId: string): Promise<void> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shares/${encodeURIComponent(accountId)}`, z.object({ ok: z.boolean() }), { method: 'DELETE' }).then(() => undefined);
}

export function listPendingInvites(): Promise<SharedSessionInvite[]> {
    return call('/v1/shares/pending', z.object({ invites: z.array(SharedSessionInviteSchema) })).then((r) => r.invites);
}

export function acceptInvite(grantId: string): Promise<SharedSessionInvite | null> {
    return call(`/v1/shares/${encodeURIComponent(grantId)}/accept`, z.object({ invite: SharedSessionInviteSchema.nullable() }), { method: 'POST' }).then((r) => r.invite);
}

export function declineInvite(grantId: string): Promise<void> {
    return call(`/v1/shares/${encodeURIComponent(grantId)}/decline`, z.object({ ok: z.boolean() }), { method: 'POST' }).then(() => undefined);
}

export const SharedMessageReceiptSchema = z.object({ id: z.string(), seq: z.number(), localId: z.string().nullable(), createdAt: z.number() });
export type SharedMessageReceipt = z.infer<typeof SharedMessageReceiptSchema>;

/** Driver write path: plain text in, server encrypts + attributes (never mode/model/steer). */
export function sendSharedMessage(sessionId: string, text: string, localId: string): Promise<SharedMessageReceipt> {
    return call(`/v1/sessions/${encodeURIComponent(sessionId)}/shared-messages`, z.object({ message: SharedMessageReceiptSchema }), json({ text, localId })).then((r) => r.message);
}

/** Lets this account RECEIVE shares even when its master secret is not server-held (QR-paired). Idempotent. */
export function uploadContentPublicKey(contentPublicKeyBase64: string): Promise<void> {
    return call('/v1/account/content-public-key', z.object({ ok: z.boolean() }), json({ contentPublicKey: contentPublicKeyBase64 }, 'PUT')).then(() => undefined);
}
