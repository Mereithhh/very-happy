/**
 * B-701 read-only share links (spec specs/2026-10-session-sharing-tiers.md).
 *
 * A link is `/s/<linkId>#<secret>`: the secret is 32 random bytes that never
 * reach server logs (URL fragment) and are stored only as sha256. Anyone
 * holding both can READ the session — never write, never RPC. The server
 * opens the owner's DEK, projects each record down to what a transcript
 * needs (no thinking, attachments, permission data, usage) and masks secrets
 * before returning plaintext; the viewer never receives a key.
 *
 * Every public request re-checks the row (no cache), so revoke / expiry take
 * effect on the next poll of an already-open page.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { displayNameOf, identityOf } from '@/app/social/accountDirectory';
import { enforceAccountWriteRate } from '@/app/api/resourceLimits';
import { SessionShareError, openSessionDataKey } from './sessionShares';
import { decryptWithDataKey } from './sessionCrypto';
import { makePathScrubber, projectLinkPage, scrubLinkText } from './linkProjection';
import { inTx } from '@/storage/inTx';
import { forever } from '@/utils/forever';
import { delay } from '@/utils/delay';
import { shutdownSignal } from '@/utils/shutdown';

export type ShareLinkScope = 'snapshot' | 'live';
export type ShareLinkStatus = 'active' | 'revoked' | 'expired';
export const SHARE_LINK_EXPIRY_DAYS = [1, 7, 30] as const;
export type ShareLinkExpiryDays = typeof SHARE_LINK_EXPIRY_DAYS[number] | null;

const MAX_ACTIVE_LINKS_PER_SESSION = 5;
const ACCESS_DEDUPE_MS = 10 * 60_000;
const ACCESS_RETENTION_MS = 90 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type LinkRow = {
    id: string;
    sessionId: string;
    createdByAccountId: string;
    tokenHash: Uint8Array;
    scope: string;
    snapshotSeq: number | null;
    snapshotAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    accessCount: number;
    lastAccessedAt: Date | null;
    createdAt: Date;
};

export type ShareLinkView = {
    id: string;
    sessionId: string;
    scope: ShareLinkScope;
    status: ShareLinkStatus;
    snapshotAt: number | null;
    expiresAt: number | null;
    revokedAt: number | null;
    createdAt: number;
    accessCount: number;
    lastAccessedAt: number | null;
};

// ---------------------------------------------------------------- pure helpers

export function generateShareSecret(): string {
    return randomBytes(32).toString('base64url');
}

export function hashShareSecret(secret: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(createHash('sha256').update(secret, 'utf8').digest());
}

export function expiresAtFor(days: ShareLinkExpiryDays, now = Date.now()): Date | null {
    return days === null ? null : new Date(now + days * DAY_MS);
}

export function linkStatus(link: Pick<LinkRow, 'revokedAt' | 'expiresAt'>, now = Date.now()): ShareLinkStatus {
    if (link.revokedAt) return 'revoked';
    if (link.expiresAt && link.expiresAt.getTime() <= now) return 'expired';
    return 'active';
}

/** Link-preview / crawler user agents: their opens are recorded but flagged, never counted. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
    if (!userAgent) return false;
    return /bot\b|crawler|spider|slurp|facebookexternalhit|embedly|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|twitterbot|skypeuripreview|googleother|bingpreview|preview|headlesschrome|curl\/|wget\/|python-requests|go-http-client/i.test(userAgent);
}

// ---------------------------------------------------------------- views

function view(link: LinkRow): ShareLinkView {
    return {
        id: link.id,
        sessionId: link.sessionId,
        scope: link.scope === 'live' ? 'live' : 'snapshot',
        status: linkStatus(link),
        snapshotAt: link.snapshotAt ? link.snapshotAt.getTime() : null,
        expiresAt: link.expiresAt ? link.expiresAt.getTime() : null,
        revokedAt: link.revokedAt ? link.revokedAt.getTime() : null,
        createdAt: link.createdAt.getTime(),
        accessCount: link.accessCount,
        lastAccessedAt: link.lastAccessedAt ? link.lastAccessedAt.getTime() : null,
    };
}

function audit(kind: string, accountId: string, sessionId: string, payload: Record<string, unknown>): void {
    log({ module: 'session-share-link', accountId, sessionId, ...payload }, kind);
    if (businessAuditEnabled()) publishAudit({ kind, accountId, sessionId, payload });
}

async function requireOwnedSession(ownerId: string, sessionId: string) {
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, seq: true } });
    if (!session || session.accountId !== ownerId) throw new SessionShareError('session_not_found', 404);
    return session;
}

async function requireOwnedLink(ownerId: string, sessionId: string, linkId: string): Promise<LinkRow> {
    await requireOwnedSession(ownerId, sessionId);
    const link = await db.sessionShareLink.findUnique({ where: { id: linkId } });
    if (!link || link.sessionId !== sessionId) throw new SessionShareError('link_not_found', 404);
    return link;
}

// ---------------------------------------------------------------- owner actions

type LinkTx = Parameters<Parameters<typeof inTx>[0]>[0];

async function assertLinkBudget(tx: LinkTx, sessionId: string, now: Date): Promise<void> {
    // Serialize link creation per session (same-row lock), then count.
    await tx.$queryRawUnsafe('SELECT 1 FROM "Session" WHERE id = $1 FOR UPDATE', sessionId);
    const active = await tx.sessionShareLink.count({ where: { sessionId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    if (active >= MAX_ACTIVE_LINKS_PER_SESSION) throw new SessionShareError('too_many_links', 409);
}

/** Create a link. The secret is returned exactly once; only its hash is kept. */
export async function createShareLink(input: { ownerId: string; sessionId: string; scope: ShareLinkScope; expiresInDays: ShareLinkExpiryDays }): Promise<{ link: ShareLinkView; secret: string }> {
    const session = await requireOwnedSession(input.ownerId, input.sessionId);
    if (!session.dataEncryptionKey) throw new SessionShareError('session_not_shareable', 409);
    if (!(await openSessionDataKey(session))) throw new SessionShareError('session_key_unavailable', 409);
    await enforceAccountWriteRate({ accountId: input.ownerId, resource: 'relationship', units: 1, envName: 'MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE', fallback: 30 });
    const now = new Date();
    const secret = generateShareSecret();
    // Count + create in one transaction so two concurrent creates cannot both pass the cap.
    const link = await inTx(async (tx) => {
        await assertLinkBudget(tx, session.id, now);
        return tx.sessionShareLink.create({ data: {
            sessionId: session.id,
            createdByAccountId: input.ownerId,
            tokenHash: hashShareSecret(secret),
            scope: input.scope,
            snapshotSeq: input.scope === 'snapshot' ? session.seq : null,
            snapshotAt: input.scope === 'snapshot' ? now : null,
            expiresAt: expiresAtFor(input.expiresInDays, now.getTime()),
        } });
    });
    audit('session.share_link.created', input.ownerId, session.id, { linkId: link.id, scope: input.scope, expiresAt: link.expiresAt?.toISOString() ?? null });
    return { link: view(link), secret };
}

/** Links of one session, newest first; revoked/expired ones stay listed for the record. */
export async function listShareLinks(ownerId: string, sessionId: string): Promise<ShareLinkView[]> {
    await requireOwnedSession(ownerId, sessionId);
    const links = await db.sessionShareLink.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return links.map(view);
}

/** Move a snapshot to "now" and/or change expiry. Revoked links cannot be revived. */
export async function updateShareLink(ownerId: string, sessionId: string, linkId: string, change: { snapshotToNow?: boolean; expiresInDays?: ShareLinkExpiryDays }): Promise<ShareLinkView> {
    const link = await requireOwnedLink(ownerId, sessionId, linkId);
    if (link.revokedAt) throw new SessionShareError('link_revoked', 409);
    const data: Record<string, unknown> = {};
    if (change.snapshotToNow) {
        if (link.scope !== 'snapshot') throw new SessionShareError('link_not_snapshot', 400);
        const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { seq: true } });
        data.snapshotSeq = session.seq;
        data.snapshotAt = new Date();
    }
    if (change.expiresInDays !== undefined) data.expiresAt = expiresAtFor(change.expiresInDays);
    const updated = await db.sessionShareLink.update({ where: { id: link.id }, data });
    audit('session.share_link.updated', ownerId, sessionId, { linkId, snapshotToNow: !!change.snapshotToNow, expiresAt: updated.expiresAt?.toISOString() ?? null });
    return view(updated);
}

export async function revokeShareLink(ownerId: string, sessionId: string, linkId: string): Promise<void> {
    const link = await requireOwnedLink(ownerId, sessionId, linkId);
    if (link.revokedAt) return; // idempotent
    await db.sessionShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    audit('session.share_link.revoked', ownerId, sessionId, { linkId });
}

/** Revoke + recreate with the same scope and remaining expiry window. */
export async function rotateShareLink(ownerId: string, sessionId: string, linkId: string): Promise<{ link: ShareLinkView; secret: string }> {
    const link = await requireOwnedLink(ownerId, sessionId, linkId);
    // Security review: rotating must never revive a revoked or expired link.
    if (linkStatus(link) !== 'active') throw new SessionShareError('link_not_active', 409);
    await enforceAccountWriteRate({ accountId: ownerId, resource: 'relationship', units: 1, envName: 'MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE', fallback: 30 });
    const now = new Date();
    const secret = generateShareSecret();
    const created = await inTx(async (tx) => {
        const revoked = await tx.sessionShareLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now } });
        if (revoked.count !== 1) throw new SessionShareError('link_not_active', 409);
        await assertLinkBudget(tx, sessionId, now);
        return tx.sessionShareLink.create({ data: {
            sessionId,
            createdByAccountId: ownerId,
            tokenHash: hashShareSecret(secret),
            scope: link.scope,
            snapshotSeq: link.snapshotSeq,
            snapshotAt: link.snapshotAt,
            expiresAt: link.expiresAt,
        } });
    });
    audit('session.share_link.rotated', ownerId, sessionId, { linkId, newLinkId: created.id });
    return { link: view(created), secret };
}

/** Opens are anonymous by design (Lead review): time and whether it was a link-preview bot, nothing else. */
export type ShareLinkAccessView = { at: number; bot: boolean };

export async function listShareLinkAccesses(ownerId: string, linkId: string): Promise<ShareLinkAccessView[]> {
    const link = await db.sessionShareLink.findUnique({ where: { id: linkId }, select: { session: { select: { accountId: true } } } });
    if (!link || link.session.accountId !== ownerId) throw new SessionShareError('link_not_found', 404);
    const rows = await db.sessionShareLinkAccess.findMany({ where: { linkId }, orderBy: { at: 'desc' }, take: 50, select: { at: true, bot: true } });
    return rows.map((row) => ({ at: row.at.getTime(), bot: row.bot }));
}

// ---------------------------------------------------------------- public (link holder)

export type PublicLinkContext = { linkId: string; secret: string };

/**
 * Resolve a link for a request that presents the secret. Unknown id or wrong
 * secret → 404 (indistinguishable). Correct secret on a revoked / expired
 * link → 410 with the reason: the holder already knows the link exists.
 */
export async function resolvePublicLink(ctx: PublicLinkContext): Promise<LinkRow> {
    const link = await db.sessionShareLink.findUnique({ where: { id: ctx.linkId } });
    const presented = hashShareSecret(ctx.secret);
    if (!link || link.tokenHash.length !== presented.length || !timingSafeEqual(link.tokenHash, presented)) {
        throw new SessionShareError('link_not_found', 404);
    }
    const status = linkStatus(link);
    if (status === 'revoked') throw new SessionShareError('link_revoked', 410);
    if (status === 'expired') throw new SessionShareError('link_expired', 410);
    return link;
}

export function hashViewerIp(ip: string): Uint8Array<ArrayBuffer> {
    const salt = process.env.HANDY_MASTER_SECRET ?? '';
    return new Uint8Array(createHash('sha256').update(`share-link-ip:${salt}:${ip}`).digest().subarray(0, 16));
}

/**
 * Record an open: anonymous (salted ipHash + bot flag only), deduped per
 * viewer per 10 minutes, so the page load and every poll may call it. Bot
 * opens are stored but never counted.
 */
export async function recordShareLinkAccess(link: Pick<LinkRow, 'id'>, viewer: { ip: string; userAgent: string | null }, now = new Date()): Promise<void> {
    const ipHash = hashViewerIp(viewer.ip);
    const bot = isBotUserAgent(viewer.userAgent);
    const recent = await db.sessionShareLinkAccess.findFirst({
        where: { linkId: link.id, ipHash, bot, at: { gt: new Date(now.getTime() - ACCESS_DEDUPE_MS) } },
        select: { id: true },
    });
    if (recent) return;
    await db.sessionShareLinkAccess.create({ data: { linkId: link.id, ipHash, bot, at: now } });
    if (!bot) await db.sessionShareLink.update({ where: { id: link.id }, data: { accessCount: { increment: 1 }, lastAccessedAt: now } });
}

/** Delete opens older than the 90-day retention. Returns rows removed. */
export async function purgeExpiredShareLinkAccesses(now = new Date()): Promise<number> {
    const result = await db.sessionShareLinkAccess.deleteMany({ where: { at: { lt: new Date(now.getTime() - ACCESS_RETENTION_MS) } } });
    return result.count;
}

/** Hourly retention sweep (started with the server, like the session timeout loop). */
export function startShareLinkAccessRetention(): void {
    forever('share-link-access-retention', async () => {
        while (true) {
            await purgeExpiredShareLinkAccesses();
            await delay(60 * 60_000, shutdownSignal);
        }
    });
}

export type PublicLinkInfo = {
    linkId: string;
    scope: ShareLinkScope;
    snapshotAt: number | null;
    expiresAt: number | null;
    owner: { displayName: string };
    session: { title: string | null; project: string | null; flavor: string | null; createdAt: number; archived: boolean };
};

export async function publicLinkInfo(link: LinkRow): Promise<PublicLinkInfo> {
    const session = await db.session.findUniqueOrThrow({ where: { id: link.sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true, createdAt: true, archivedAt: true } });
    const dek = await openSessionDataKey(session);
    if (!dek) throw new SessionShareError('session_key_unavailable', 409);
    const meta = decryptWithDataKey(new Uint8Array(Buffer.from(session.metadata, 'base64')), dek) as Record<string, any> | null;
    const scrub = makePathScrubber({ cwd: meta?.path, homeDir: meta?.homeDir });
    const project = typeof meta?.path === 'string' ? meta.path.split(/[\\/]+/).filter(Boolean).pop() ?? null : null;
    const owner = await db.account.findUniqueOrThrow({ where: { id: session.accountId }, select: { id: true, firstName: true, lastName: true, username: true } });
    const title = meta?.summary?.text ?? meta?.name ?? null;
    return {
        linkId: link.id,
        scope: link.scope === 'live' ? 'live' : 'snapshot',
        snapshotAt: link.snapshotAt ? link.snapshotAt.getTime() : null,
        expiresAt: link.expiresAt ? link.expiresAt.getTime() : null,
        owner: { displayName: displayNameOf(owner, await identityOf(owner.id)) },
        session: {
            title: typeof title === 'string' ? scrubLinkText(title, scrub) : null,
            project: project ? scrubLinkText(project, scrub) : null,
            flavor: typeof meta?.flavor === 'string' ? meta.flavor : null,
            createdAt: session.createdAt.getTime(),
            archived: !!session.archivedAt,
        },
    };
}

export type PublicLinkMessage = { id: string; seq: number; createdAt: number; content: Record<string, unknown> };

/** Projected, masked messages after `afterSeq` (forward); a snapshot never passes its snapshotSeq. */
export async function publicLinkMessages(link: LinkRow, afterSeq: number, limit: number): Promise<{ messages: PublicLinkMessage[]; hasMore: boolean; lastSeq: number }> {
    const session = await db.session.findUniqueOrThrow({ where: { id: link.sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true } });
    const dek = await openSessionDataKey(session);
    if (!dek) throw new SessionShareError('session_key_unavailable', 409);
    const meta = decryptWithDataKey(new Uint8Array(Buffer.from(session.metadata, 'base64')), dek) as Record<string, any> | null;
    const scrub = makePathScrubber({ cwd: meta?.path, homeDir: meta?.homeDir });
    const ceiling = link.scope === 'snapshot' ? (link.snapshotSeq ?? 0) : undefined;
    const rows = await db.sessionMessage.findMany({
        where: { sessionId: session.id, seq: ceiling === undefined ? { gt: afterSeq } : { gt: afterSeq, lte: ceiling } },
        orderBy: { seq: 'asc' },
        take: limit + 1,
        select: { id: true, seq: true, content: true, createdAt: true },
    });
    const page = rows.length > limit ? rows.slice(0, limit) : rows;
    // The page is budgeted as a whole: it may stop early, and the client pages on from lastSeq.
    const { projected, consumed } = projectLinkPage(page, (row) => {
        const content = row.content as { t?: string; c?: string } | null;
        if (content?.t !== 'encrypted' || typeof content.c !== 'string') return null;
        return decryptWithDataKey(new Uint8Array(Buffer.from(content.c, 'base64')), dek);
    }, scrub);
    const messages: PublicLinkMessage[] = projected.map(({ record, content }) => ({ id: record.id, seq: record.seq, createdAt: record.createdAt.getTime(), content }));
    const hasMore = rows.length > consumed;
    return { messages, hasMore, lastSeq: consumed ? page[consumed - 1].seq : afterSeq };
}

// ---------------------------------------------------------------- settings: everything I shared

export type OutgoingShares = {
    sessions: Array<{
        sessionId: string;
        title: string | null;
        grants: Array<{ id: string; grantee: { id: string; displayName: string }; role: string; status: string; expiresAt: number | null; createdAt: number }>;
        links: ShareLinkView[];
    }>;
};

export async function listOutgoingShares(ownerId: string): Promise<OutgoingShares> {
    const [grants, links] = await Promise.all([
        db.sessionGrant.findMany({ where: { grantedByAccountId: ownerId, status: { not: 'revoked' } }, include: { grantee: { select: { id: true, firstName: true, lastName: true, username: true } } }, orderBy: { createdAt: 'desc' } }),
        db.sessionShareLink.findMany({ where: { createdByAccountId: ownerId, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const sessionIds = [...new Set([...grants.map((g) => g.sessionId), ...links.map((l) => l.sessionId)])];
    const sessions = sessionIds.length ? await db.session.findMany({ where: { id: { in: sessionIds }, accountId: ownerId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true } }) : [];
    const out: OutgoingShares['sessions'] = [];
    for (const session of sessions) {
        const dek = await openSessionDataKey(session);
        const meta = dek ? decryptWithDataKey(new Uint8Array(Buffer.from(session.metadata, 'base64')), dek) as Record<string, any> | null : null;
        const sessionGrants = [];
        for (const grant of grants.filter((g) => g.sessionId === session.id)) {
            sessionGrants.push({
                id: grant.id,
                grantee: { id: grant.grantee.id, displayName: displayNameOf(grant.grantee, await identityOf(grant.grantee.id)) },
                role: grant.role,
                status: grant.expiresAt && grant.expiresAt.getTime() <= Date.now() ? 'expired' : grant.status,
                expiresAt: grant.expiresAt ? grant.expiresAt.getTime() : null,
                createdAt: grant.createdAt.getTime(),
            });
        }
        out.push({
            sessionId: session.id,
            title: meta?.summary?.text ?? meta?.name ?? null,
            grants: sessionGrants,
            links: links.filter((l) => l.sessionId === session.id).map(view),
        });
    }
    return { sessions: out };
}
