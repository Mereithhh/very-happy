/**
 * B-619 session sharing — grants, access resolution, key re-wrapping,
 * grantee-authored messages and the fan-out hook (spec
 * specs/2026-10-session-sharing.md).
 *
 * Trust model (unchanged, now explicit): the server holds every account's
 * master secret, so it CAN open any session. B-619 is the first code path
 * that does; everything it opens is scoped to one session and one grant,
 * and every open is logged.
 *
 * What a grantee can reach is deliberately narrow (security audit in the
 * spec): session rows and messages of granted sessions, attachment downloads
 * of those sessions, and — for drivers — ONE write: a plain-text user message
 * the server encrypts itself. No RPC, no relay token, no metadata / state
 * writes, no archive / delete, no re-sharing.
 */
import type { Prisma, SessionGrantRole, SessionGrantStatus } from '@prisma/client';
import { db } from '@/storage/db';
import { inTx, afterTx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { log } from '@/utils/log';
import { loadAccountSecret } from '@/app/auth/accountSecrets';
import { eventRouter, buildNewMessageUpdate, type UpdatePayload } from '@/app/events/eventRouter';
import { storeSessionMessages, SESSION_MESSAGE_CONTENT_MAX_BYTES } from '@/app/api/sessionMessageStore';
import { enforceAccountWriteRate } from '@/app/api/resourceLimits';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { buildUserProfile, type UserProfile } from '@/app/social/type';
import { displayNameOf, identityOf, profileInclude, resolveAccountByHandle, type ProfileAccount } from '@/app/social/accountDirectory';
import { RelationshipStatus } from '@prisma/client';
import {
    contentKeyPairFromSecret,
    decodeAccountSecret,
    decryptWithDataKey,
    encryptWithDataKey,
    unwrapDataEncryptionKey,
    wrapDataEncryptionKey,
} from './sessionCrypto';

export type { SessionGrantRole, SessionGrantStatus };

export class SessionShareError extends Error {
    constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
        super(code);
    }
}

export type SessionAccess =
    | { kind: 'owner'; ownerId: string }
    | { kind: 'grant'; ownerId: string; role: SessionGrantRole; grantId: string };

const MAX_GRANTS_PER_SESSION = 20;
const DEK_CACHE_TTL_MS = 10 * 60_000;
const GRANTEE_CACHE_TTL_MS = 5_000;
/** Metadata keys a grantee never needs and must not learn (audit §2). */
const REDACTED_METADATA_KEYS = ['homeDir', 'happyHomeDir', 'happyLibDir', 'happyToolsDir', 'hostPid', 'terminalId', 'mcpServers', 'claudeEnvVars'] as const;

export const SHARED_SENT_FROM = 'shared';

type SessionKeyRow = { id: string; accountId: string; dataEncryptionKey: Uint8Array | Buffer | null };

// ---------------------------------------------------------------- access

/** B-701: a grant whose expiresAt has passed is treated exactly like a revoked one. */
export function unexpiredGrant(now = new Date()): Prisma.SessionGrantWhereInput {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

const DAY_MS = 24 * 60 * 60_000;
export type GrantExpiryDays = 1 | 7 | 30 | null;
export function grantExpiresAt(days: GrantExpiryDays | undefined, now = Date.now()): Date | null {
    return days ? new Date(now + days * DAY_MS) : null;
}

export async function resolveSessionAccess(userId: string, sessionId: string, client: Pick<typeof db, 'session' | 'sessionGrant'> = db): Promise<SessionAccess | null> {
    // Owner fast path: the exact query every route made before B-619.
    const owned = await client.session.findFirst({ where: { id: sessionId, accountId: userId }, select: { id: true } });
    if (owned) return { kind: 'owner', ownerId: userId };
    const grant = await client.sessionGrant.findFirst({
        where: { sessionId, granteeAccountId: userId, status: 'active', ...unexpiredGrant() },
        select: { id: true, role: true, session: { select: { accountId: true } } },
    });
    if (!grant) return null;
    return { kind: 'grant', ownerId: grant.session.accountId, role: grant.role, grantId: grant.id };
}

export async function requireSessionAccess(userId: string, sessionId: string, minimum: 'viewer' | 'driver' | 'owner'): Promise<SessionAccess> {
    const access = await resolveSessionAccess(userId, sessionId);
    if (!access) throw new SessionShareError('session_not_found', 404);
    if (minimum === 'owner' && access.kind !== 'owner') throw new SessionShareError('owner_only', 403);
    if (minimum === 'driver' && access.kind === 'grant' && access.role !== 'driver') throw new SessionShareError('driver_only', 403);
    return access;
}

// ---------------------------------------------------------------- keys

const dekCache = new Map<string, { dek: Uint8Array; at: number }>();

async function loadMasterSecret(accountId: string): Promise<Uint8Array | null> {
    // Accounts from before AccountSecret existed only hold the sealed secret on
    // their password credential; loadAccountSecret migrates it forward.
    const credential = await db.accountCredential.findUnique({ where: { accountId }, select: { secretEnc: true } });
    const secret = await loadAccountSecret(db, accountId, credential?.secretEnc);
    if (!secret) return null;
    try { return decodeAccountSecret(secret); } catch { return null; }
}

/** Open a session's DEK with the OWNER's content key. Null = legacy session (no DEK) or owner secret unavailable. */
export async function openSessionDataKey(session: SessionKeyRow): Promise<Uint8Array | null> {
    if (!session.dataEncryptionKey) return null;
    const cached = dekCache.get(session.id);
    if (cached && Date.now() - cached.at < DEK_CACHE_TTL_MS) return cached.dek;
    const master = await loadMasterSecret(session.accountId);
    if (!master) return null;
    const dek = unwrapDataEncryptionKey(new Uint8Array(session.dataEncryptionKey), contentKeyPairFromSecret(master));
    if (!dek) return null;
    dekCache.set(session.id, { dek, at: Date.now() });
    return dek;
}

/** The grantee's content public key: uploaded by their web client, else derived from their server-held secret. */
async function granteeContentPublicKey(accountId: string): Promise<Uint8Array | null> {
    const account = await db.account.findUnique({ where: { id: accountId }, select: { contentPublicKey: true } });
    if (account?.contentPublicKey) {
        const bytes = new Uint8Array(Buffer.from(account.contentPublicKey, 'base64'));
        if (bytes.length === 32) return bytes;
    }
    const master = await loadMasterSecret(accountId);
    return master ? contentKeyPairFromSecret(master).publicKey : null;
}

function decodeBundle(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }
function encodeBundle(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }

export function redactMetadataObject(metadata: Record<string, unknown>): Record<string, unknown> {
    const out = { ...metadata };
    for (const key of REDACTED_METADATA_KEYS) delete out[key];
    return out;
}

/** Re-encrypt the session's metadata for a grantee with the sensitive machine fields removed. Null when it cannot be opened. */
export async function redactedMetadataFor(session: SessionKeyRow & { metadata: string }): Promise<string | null> {
    const dek = await openSessionDataKey(session);
    if (!dek) return null;
    const plain = decryptWithDataKey(decodeBundle(session.metadata), dek);
    if (!plain || typeof plain !== 'object') return null;
    return encodeBundle(encryptWithDataKey(redactMetadataObject(plain as Record<string, unknown>), dek));
}

async function sessionPreview(session: SessionKeyRow & { metadata: string }): Promise<{ name: string | null; path: string | null; host: string | null }> {
    const dek = await openSessionDataKey(session);
    const plain = dek ? decryptWithDataKey(decodeBundle(session.metadata), dek) as Record<string, any> | null : null;
    return {
        name: plain?.summary?.text ?? plain?.name ?? null,
        path: typeof plain?.path === 'string' ? plain.path : null,
        host: typeof plain?.host === 'string' ? plain.host : null,
    };
}

// ---------------------------------------------------------------- profiles
// Who-is-this lives in the account directory (B-621) so sharing, friends and
// later Spaces resolve people the same way.

function profileOf(account: ProfileAccount): UserProfile {
    return buildUserProfile(account, RelationshipStatus.none);
}

// ---------------------------------------------------------------- views

export type SessionGrantView = {
    id: string;
    sessionId: string;
    role: SessionGrantRole;
    status: SessionGrantStatus;
    createdAt: number;
    acceptedAt: number | null;
    expiresAt: number | null;
    grantee: UserProfile & { email: string | null; displayName: string };
};

export type SharedSessionInvite = {
    id: string;
    sessionId: string;
    role: SessionGrantRole;
    status: SessionGrantStatus;
    createdAt: number;
    expiresAt: number | null;
    owner: { id: string; displayName: string; username: string | null; avatarUrl: string | null };
    session: { name: string | null; path: string | null; host: string | null };
};

async function grantView(grant: { id: string; sessionId: string; role: SessionGrantRole; status: SessionGrantStatus; createdAt: Date; acceptedAt: Date | null; expiresAt: Date | null; grantee: ProfileAccount }): Promise<SessionGrantView> {
    const identity = await identityOf(grant.grantee.id);
    return {
        id: grant.id,
        sessionId: grant.sessionId,
        role: grant.role,
        status: grant.status,
        createdAt: grant.createdAt.getTime(),
        acceptedAt: grant.acceptedAt ? grant.acceptedAt.getTime() : null,
        expiresAt: grant.expiresAt ? grant.expiresAt.getTime() : null,
        grantee: { ...profileOf(grant.grantee), username: grant.grantee.username ?? identity.handle ?? '', email: identity.email, displayName: displayNameOf(grant.grantee, identity) },
    };
}

async function inviteView(grant: { id: string; sessionId: string; role: SessionGrantRole; status: SessionGrantStatus; createdAt: Date; expiresAt: Date | null; grantedBy: ProfileAccount; session: SessionKeyRow & { metadata: string } }): Promise<SharedSessionInvite> {
    const owner = profileOf(grant.grantedBy);
    return {
        id: grant.id,
        sessionId: grant.sessionId,
        role: grant.role,
        status: grant.status,
        createdAt: grant.createdAt.getTime(),
        expiresAt: grant.expiresAt ? grant.expiresAt.getTime() : null,
        owner: { id: owner.id, displayName: displayNameOf(grant.grantedBy, await identityOf(owner.id)), username: grant.grantedBy.username, avatarUrl: owner.avatar?.url ?? null },
        session: await sessionPreview(grant.session),
    };
}

// ---------------------------------------------------------------- mutations

async function emitToAccount(accountId: string, body: UpdatePayload['body']): Promise<void> {
    const seq = await allocateUserSeq(accountId);
    eventRouter.emitUpdate({
        userId: accountId,
        payload: { id: randomKeyNaked(12), seq, body, createdAt: Date.now() },
        recipientFilter: { type: 'user-scoped-only' },
    });
}

function audit(kind: string, accountId: string, sessionId: string, payload: Record<string, unknown>): void {
    log({ module: 'session-share', accountId, sessionId, ...payload }, kind);
    if (businessAuditEnabled()) publishAudit({ kind, accountId, sessionId, payload });
}

export async function createSessionGrant(input: { ownerId: string; sessionId: string; target?: string; granteeAccountId?: string; role: SessionGrantRole; expiresInDays?: GrantExpiryDays }): Promise<SessionGrantView> {
    const session = await db.session.findUnique({ where: { id: input.sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true } });
    if (!session || session.accountId !== input.ownerId) throw new SessionShareError('session_not_found', 404);
    if (!session.dataEncryptionKey) throw new SessionShareError('session_not_shareable', 409);
    // A friend picked from the directory arrives as an id; typed input is resolved by handle / email.
    const grantee = input.granteeAccountId
        ? await db.account.findUnique({ where: { id: input.granteeAccountId }, include: profileInclude })
        : await resolveAccountByHandle(input.target ?? '');
    if (!grantee) throw new SessionShareError('target_not_found', 404);
    if (grantee.id === input.ownerId) throw new SessionShareError('cannot_share_with_self', 400);

    const dek = await openSessionDataKey(session);
    if (!dek) throw new SessionShareError('session_key_unavailable', 409);
    const granteePublicKey = await granteeContentPublicKey(grantee.id);
    if (!granteePublicKey) throw new SessionShareError('grantee_key_unavailable', 409);

    await enforceAccountWriteRate({ accountId: input.ownerId, resource: 'relationship', units: 1, envName: 'MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE', fallback: 30 });

    const grant = await inTx(async (tx) => {
        const existing = await tx.sessionGrant.findUnique({ where: { sessionId_granteeAccountId: { sessionId: session.id, granteeAccountId: grantee.id } } });
        const existingLive = existing && existing.status !== 'revoked' && (!existing.expiresAt || existing.expiresAt.getTime() > Date.now());
        if (existing && existingLive) throw new SessionShareError('already_shared', 409, { grantId: existing.id, status: existing.status });
        const count = await tx.sessionGrant.count({ where: { sessionId: session.id, status: { not: 'revoked' }, ...unexpiredGrant() } });
        if (count >= MAX_GRANTS_PER_SESSION) throw new SessionShareError('too_many_grants', 409);
        const data = {
            role: input.role,
            status: 'pending' as const,
            granteeDataEncryptionKey: Buffer.from(wrapDataEncryptionKey(dek, granteePublicKey)),
            grantedByAccountId: input.ownerId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: grantExpiresAt(input.expiresInDays),
        };
        return existing
            ? tx.sessionGrant.update({ where: { id: existing.id }, data, include: { grantee: { include: profileInclude } } })
            : tx.sessionGrant.create({ data: { ...data, sessionId: session.id, granteeAccountId: grantee.id }, include: { grantee: { include: profileInclude } } });
    });
    invalidateGrantees(session.id);
    audit('session.share.created', input.ownerId, session.id, { grantId: grant.id, granteeAccountId: grantee.id, role: input.role, expiresAt: grant.expiresAt?.toISOString() ?? null });

    const invite = await inviteView({ ...grant, grantedBy: (await db.account.findUniqueOrThrow({ where: { id: input.ownerId }, include: profileInclude })), session });
    await emitToAccount(grantee.id, { t: 'session-share', invite });
    return grantView(grant);
}

export async function listSessionGrants(ownerId: string, sessionId: string): Promise<SessionGrantView[]> {
    await requireSessionAccess(ownerId, sessionId, 'owner');
    const grants = await db.sessionGrant.findMany({
        where: { sessionId, status: { not: 'revoked' } },
        orderBy: { createdAt: 'asc' },
        include: { grantee: { include: profileInclude } },
    });
    return Promise.all(grants.map(grantView));
}

export async function updateSessionGrantRole(ownerId: string, sessionId: string, granteeAccountId: string, role: SessionGrantRole | undefined, expiresInDays?: GrantExpiryDays): Promise<SessionGrantView> {
    await requireSessionAccess(ownerId, sessionId, 'owner');
    const grant = await db.sessionGrant.findUnique({ where: { sessionId_granteeAccountId: { sessionId, granteeAccountId } }, include: { grantee: { include: profileInclude } } });
    if (!grant || grant.status === 'revoked') throw new SessionShareError('grant_not_found', 404);
    const data: Prisma.SessionGrantUpdateInput = {};
    if (role) data.role = role;
    if (expiresInDays !== undefined) data.expiresAt = grantExpiresAt(expiresInDays);
    const updated = await db.sessionGrant.update({ where: { id: grant.id }, data, include: { grantee: { include: profileInclude } } });
    invalidateGrantees(sessionId);
    audit('session.share.role', ownerId, sessionId, { grantId: grant.id, granteeAccountId, role: updated.role, expiresAt: updated.expiresAt?.toISOString() ?? null });
    await emitToAccount(granteeAccountId, { t: 'session-share-updated', sessionId, grantId: grant.id, role: updated.role, status: updated.status });
    return grantView(updated);
}

export async function revokeSessionGrant(ownerId: string, sessionId: string, granteeAccountId: string): Promise<void> {
    await requireSessionAccess(ownerId, sessionId, 'owner');
    const grant = await db.sessionGrant.findUnique({ where: { sessionId_granteeAccountId: { sessionId, granteeAccountId } } });
    if (!grant || grant.status === 'revoked') throw new SessionShareError('grant_not_found', 404);
    await db.sessionGrant.update({ where: { id: grant.id }, data: { status: 'revoked', revokedAt: new Date() } });
    invalidateGrantees(sessionId);
    audit('session.share.revoked', ownerId, sessionId, { grantId: grant.id, granteeAccountId });
    await emitToAccount(granteeAccountId, { t: 'session-share-revoked', sessionId, grantId: grant.id });
}

export async function respondToSessionGrant(granteeAccountId: string, grantId: string, accept: boolean): Promise<SharedSessionInvite | null> {
    const grant = await db.sessionGrant.findUnique({ where: { id: grantId }, include: { grantedBy: { include: profileInclude }, session: { select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true } } } });
    if (!grant || grant.granteeAccountId !== granteeAccountId || grant.status === 'revoked') throw new SessionShareError('grant_not_found', 404);
    if (accept && grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) throw new SessionShareError('grant_not_found', 404);
    if (grant.status === 'active' && accept) return inviteView(grant);
    const updated = await db.sessionGrant.update({
        where: { id: grant.id },
        data: accept ? { status: 'active', acceptedAt: new Date() } : { status: 'revoked', revokedAt: new Date() },
    });
    invalidateGrantees(grant.sessionId);
    audit(accept ? 'session.share.accepted' : 'session.share.declined', granteeAccountId, grant.sessionId, { grantId: grant.id, ownerId: grant.grantedByAccountId });
    await emitToAccount(grant.grantedByAccountId, { t: 'session-share-updated', sessionId: grant.sessionId, grantId: grant.id, role: updated.role, status: updated.status });
    return accept ? inviteView({ ...grant, status: updated.status }) : null;
}

export async function listPendingSessionInvites(granteeAccountId: string): Promise<SharedSessionInvite[]> {
    const grants = await db.sessionGrant.findMany({
        where: { granteeAccountId, status: 'pending', ...unexpiredGrant() },
        orderBy: { createdAt: 'desc' },
        include: { grantedBy: { include: profileInclude }, session: { select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true } } },
    });
    return Promise.all(grants.map(inviteView));
}

/** Rows a grantee sees in /v1/sessions: the owner's row with the grantee-wrapped key and redacted metadata. */
export async function listSharedSessionRows<T extends SessionKeyRow & { metadata: string }>(
    granteeAccountId: string,
    select: Prisma.SessionSelect,
): Promise<Array<{ row: T; share: { grantId: string; role: SessionGrantRole; owner: { id: string; displayName: string } }; dataEncryptionKey: Buffer; metadata: string }>> {
    const grants = await db.sessionGrant.findMany({
        where: { granteeAccountId, status: 'active', ...unexpiredGrant() },
        include: { grantedBy: { select: { id: true, firstName: true, lastName: true, username: true } }, session: { select: { ...select, id: true, accountId: true, dataEncryptionKey: true, metadata: true } } },
        orderBy: { createdAt: 'desc' },
    });
    const out = [];
    for (const grant of grants) {
        const row = grant.session as unknown as T;
        const metadata = await redactedMetadataFor(row);
        if (!metadata) continue; // owner secret missing: nothing we can safely show
        out.push({
            row,
            share: { grantId: grant.id, role: grant.role, owner: { id: grant.grantedBy.id, displayName: displayNameOf(grant.grantedBy, await identityOf(grant.grantedBy.id)) } },
            dataEncryptionKey: Buffer.from(grant.granteeDataEncryptionKey),
            metadata,
        });
    }
    return out;
}

/** One shared session for a grantee (GET /v1/sessions/:id). */
export async function sharedSessionRowFor<T extends SessionKeyRow & { metadata: string }>(granteeAccountId: string, sessionId: string, select: Prisma.SessionSelect) {
    const rows = await listSharedSessionRows<T>(granteeAccountId, select);
    return rows.find((entry) => entry.row.id === sessionId) ?? null;
}

// ---------------------------------------------------------------- driver messages

function sanitizeHeaderValue(value: string): string {
    return value.replace(/[%";\]\n\r]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function buildSharedMessageText(sender: { accountId: string; displayName: string }, text: string): string {
    return `[Very Happy shared session message from "${sanitizeHeaderValue(sender.displayName)}" ${sender.accountId}]\n${text}`;
}

export async function postSharedMessage(input: { granteeAccountId: string; sessionId: string; text: string; localId: string }) {
    const access = await requireSessionAccess(input.granteeAccountId, input.sessionId, 'driver');
    if (access.kind !== 'grant') throw new SessionShareError('owner_uses_normal_send', 400);
    const text = input.text;
    if (!text.trim()) throw new SessionShareError('empty_message', 400);
    if (Buffer.byteLength(text, 'utf8') > SESSION_MESSAGE_CONTENT_MAX_BYTES / 2) throw new SessionShareError('message_too_large', 413);
    const session = await db.session.findUniqueOrThrow({ where: { id: input.sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, archivedAt: true } });
    if (session.archivedAt) throw new SessionShareError('session_archived', 409);
    const dek = await openSessionDataKey(session);
    if (!dek) throw new SessionShareError('session_key_unavailable', 409);
    const sender = await db.account.findUniqueOrThrow({ where: { id: input.granteeAccountId }, select: { id: true, firstName: true, lastName: true, username: true } });
    const displayName = displayNameOf(sender, await identityOf(sender.id));
    // Charge the grantee's own write budget too, so a noisy driver cannot exhaust the owner's.
    await enforceAccountWriteRate({ accountId: input.granteeAccountId, resource: 'message', units: 1, envName: 'MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE', fallback: 600 });
    const record = {
        role: 'user',
        content: { type: 'text', text: buildSharedMessageText({ accountId: sender.id, displayName }, text) },
        // No permissionMode / model / delivery here, by construction: a driver
        // cannot steer, re-mode or re-model the owner's session (audit §4).
        meta: { sentFrom: SHARED_SENT_FROM, displayText: text, sharedBy: { accountId: sender.id, displayName } },
    };
    const stored = await storeSessionMessages({
        accountId: session.accountId,
        sessionId: session.id,
        messages: [{ localId: input.localId, content: encodeBundle(encryptWithDataKey(record, dek)) }],
    });
    for (const message of stored.createdMessages) {
        const { updateSeq, ...storedMessage } = message;
        eventRouter.emitUpdate({
            userId: session.accountId,
            payload: buildNewMessageUpdate(storedMessage, session.id, updateSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'all-interested-in-session', sessionId: session.id },
        });
    }
    audit('session.share.message', input.granteeAccountId, session.id, { ownerId: session.accountId, localId: input.localId });
    const message = stored.messages[0];
    return { id: message.id, seq: message.seq, localId: message.localId, createdAt: message.createdAt.getTime() };
}

// ---------------------------------------------------------------- fan-out

const granteeCache = new Map<string, { ids: string[]; at: number }>();

export function invalidateGrantees(sessionId: string): void {
    granteeCache.delete(sessionId);
}

export async function activeGranteeIds(sessionId: string): Promise<string[]> {
    const cached = granteeCache.get(sessionId);
    if (cached && Date.now() - cached.at < GRANTEE_CACHE_TTL_MS) return cached.ids;
    const grants = await db.sessionGrant.findMany({ where: { sessionId, status: 'active', ...unexpiredGrant() }, select: { granteeAccountId: true } });
    const ids = grants.map((grant) => grant.granteeAccountId);
    granteeCache.set(sessionId, { ids, at: Date.now() });
    return ids;
}

/**
 * Mirror an owner-side session update to every active grantee's user-scoped
 * room. `update-session` metadata is re-encrypted with the machine fields
 * removed; everything else (messages, agentState, prompt queue) is forwarded
 * as-is since the grantee holds the same DEK.
 */
export async function fanoutSessionUpdateToGrantees(sessionId: string, payload: UpdatePayload): Promise<void> {
    const grantees = await activeGranteeIds(sessionId);
    if (grantees.length === 0) return;
    let forwarded = payload;
    if (payload.body.t === 'update-session' && payload.body.metadata?.value) {
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true } });
        if (!session) return;
        const redacted = await redactedMetadataFor({ ...session, metadata: payload.body.metadata.value });
        if (!redacted) return;
        forwarded = { ...payload, body: { ...payload.body, metadata: { ...payload.body.metadata, value: redacted } } };
    }
    eventRouter.emitToRooms(grantees.map((id) => `user:${id}:user-scoped`), 'update', forwarded);
}

export async function fanoutSessionEphemeralToGrantees(sessionId: string, payload: unknown): Promise<void> {
    const grantees = await activeGranteeIds(sessionId);
    if (grantees.length === 0) return;
    eventRouter.emitToRooms(grantees.map((id) => `user:${id}:user-scoped`), 'ephemeral', payload);
}

/** sessionDelete: tell grantees the session is gone (rows cascade). */
export async function notifyGranteesSessionDeleted(sessionId: string, granteeIds: string[]): Promise<void> {
    invalidateGrantees(sessionId);
    for (const granteeId of granteeIds) await emitToAccount(granteeId, { t: 'session-share-revoked', sessionId, grantId: null });
}

export function installSessionShareFanout(): void {
    eventRouter.setSessionFanout({
        update: (sessionId, payload) => fanoutSessionUpdateToGrantees(sessionId, payload).catch((error) => log({ module: 'session-share', sessionId, error }, 'fan-out failed')),
        ephemeral: (sessionId, payload) => fanoutSessionEphemeralToGrantees(sessionId, payload).catch((error) => log({ module: 'session-share', sessionId, error }, 'fan-out failed')),
    });
}
