/**
 * B-878 PR-B project sharing — grants and DERIVED access (spec
 * specs/2026-11-share-terminals-and-projects.md §4).
 *
 * A ProjectGrant gives one account `viewer` or `driver` on a whole project.
 * Nothing is copied into SessionGrant: whether a session is reachable through a
 * project share is computed on every read from the project's CURRENT
 * membership (explicit ∪ team-derived, projects/store.ts `membersOf`). So a
 * session added later is visible at once, and a session moved out is not.
 * Terminals of the project are always view only (terminalShareBroker.ts).
 *
 * Revoking a project share ends only the derived access; a direct session
 * share of the same session is a separate grant and is untouched.
 */
import type { SessionGrantRole, SessionGrantStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { log } from '@/utils/log';
import { enforceAccountWriteRate } from '@/app/api/resourceLimits';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { displayNameOf, identityOf, profileInclude, resolveAccountByHandle, type ProfileAccount } from '@/app/social/accountDirectory';
import { projectIdOfSession, projectSessionIds, setProjectMembershipChangeHook, sharedProjectSnapshot } from '@/app/projects/store';
import { wrapDataEncryptionKey } from '@/app/session/sessionCrypto';
import { emitToAccount, teardownProjectTerminalShares } from './terminalShareBroker';

export class ProjectShareError extends Error {
    constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
        super(code);
    }
}

/** Project shares: view only / can send. Never "can operate" (decision #50). */
export type ProjectShareRole = Extract<SessionGrantRole, 'viewer' | 'driver'>;
export type ProjectShareExpiryDays = 1 | 7 | 30 | null;
const MAX_GRANTS_PER_PROJECT = 20;
const ACCESS_CACHE_TTL_MS = 1_000;
const DAY_MS = 24 * 60 * 60_000;
const OPEN_AUDIT_DEDUP_MS = 10 * 60_000;

type Person = { id: string; displayName: string; username: string | null };

export type ProjectGrantView = {
    id: string;
    projectId: string;
    role: ProjectShareRole;
    status: SessionGrantStatus;
    createdAt: number;
    acceptedAt: number | null;
    expiresAt: number | null;
    grantee: Person;
};

export type IncomingProjectShare = {
    id: string;
    projectId: string;
    role: ProjectShareRole;
    status: SessionGrantStatus;
    /** Stream key for the project's terminals, boxed to my content key. */
    granteeKey: string;
    name: string;
    createdAt: number;
    expiresAt: number | null;
    owner: Person;
};

async function person(account: ProfileAccount): Promise<Person> {
    return { id: account.id, displayName: displayNameOf(account, await identityOf(account.id)), username: account.username ?? null };
}

export function projectShareExpiresAt(days: unknown, now = Date.now()): Date | null {
    if (days === undefined || days === null) return null;
    if (days !== 1 && days !== 7 && days !== 30) throw new ProjectShareError('bad_expiry', 400);
    return new Date(now + days * DAY_MS);
}

function liveWhere(now = new Date()) {
    return { status: { not: 'revoked' as const }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}
function activeWhere(now = new Date()) {
    return { status: 'active' as const, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

function audit(kind: string, ownerAccountId: string, actorAccountId: string, grantId: string, projectId: string, detail: Record<string, unknown> = {}): void {
    void db.shareAuditEvent.create({ data: { ownerAccountId, actorAccountId, grantKind: 'project', grantId, resourceKind: 'project', resourceId: projectId, kind, detail: detail as any } })
        .catch((error) => log({ module: 'project-share', grantId, errorName: error instanceof Error ? error.name : typeof error }, 'project share event write failed'));
    log({ module: 'project-share', grantId, actorAccountId }, `project-share.${kind}`);
    if (businessAuditEnabled()) publishAudit({ kind: `project.share.${kind}`, accountId: actorAccountId, payload: { grantId, projectId, ...detail } });
}

// ---------------------------------------------------------------- derived access

type DerivedAccess = { projectGrantId: string; projectId: string; ownerId: string; role: ProjectShareRole };
const accessCache = new Map<string, { access: DerivedAccess | null; at: number }>();
const granteeCache = new Map<string, { ids: string[]; at: number }>();

/** Any project grant or membership change: drop every derived verdict (this slot; other slots via the share broadcast). */
export function invalidateProjectShareCaches(): void {
    accessCache.clear();
    granteeCache.clear();
}

/** The project grant through which `userId` reaches `sessionId` (owner's session, current member of a shared project), or null. */
export async function resolveProjectSessionAccess(userId: string, sessionId: string): Promise<DerivedAccess | null> {
    const key = `${userId}:${sessionId}`;
    const cached = accessCache.get(key);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) return cached.access;
    let access: DerivedAccess | null = null;
    const grants = await db.projectGrant.findMany({ where: { granteeAccountId: userId, ...activeWhere() }, select: { id: true, projectId: true, ownerAccountId: true, role: true } });
    if (grants.length > 0) {
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
        if (session && session.accountId !== userId) {
            const projectId = await projectIdOfSession(session.accountId, sessionId);
            const grant = projectId ? grants.find((g) => g.projectId === projectId && g.ownerAccountId === session.accountId) : undefined;
            if (grant) access = { projectGrantId: grant.id, projectId: grant.projectId, ownerId: grant.ownerAccountId, role: grant.role as ProjectShareRole };
        }
    }
    accessCache.set(key, { access, at: Date.now() });
    return access;
}

/** Grantees reaching this session through a project share (for the update fan-out). */
export async function projectGranteeIds(sessionId: string): Promise<string[]> {
    const cached = granteeCache.get(sessionId);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_TTL_MS * 5) return cached.ids;
    let ids: string[] = [];
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
    if (session && await db.projectGrant.count({ where: { ownerAccountId: session.accountId, ...activeWhere() } }) > 0) {
        const projectId = await projectIdOfSession(session.accountId, sessionId);
        if (projectId) ids = (await db.projectGrant.findMany({ where: { projectId, ...activeWhere() }, select: { granteeAccountId: true } })).map((g) => g.granteeAccountId);
    }
    granteeCache.set(sessionId, { ids, at: Date.now() });
    return ids;
}

/** Every session reachable through my active project shares: { sessionId → grant } (one project per session). */
export async function projectSharedSessions(granteeId: string): Promise<Map<string, DerivedAccess>> {
    const out = new Map<string, DerivedAccess>();
    const grants = await db.projectGrant.findMany({ where: { granteeAccountId: granteeId, ...activeWhere() }, select: { id: true, projectId: true, ownerAccountId: true, role: true } });
    for (const g of grants) {
        for (const sessionId of await projectSessionIds(g.ownerAccountId, g.projectId)) {
            out.set(sessionId, { projectGrantId: g.id, projectId: g.projectId, ownerId: g.ownerAccountId, role: g.role as ProjectShareRole });
        }
    }
    return out;
}

const openAudited = new Map<string, number>();
/** `project.derive.open`: first time (per 10 min) a grantee is handed a session key through a project share. */
export function noteProjectDerivedOpen(granteeId: string, access: DerivedAccess, sessionId: string): void {
    const key = `${granteeId}:${sessionId}`;
    const last = openAudited.get(key) ?? 0;
    if (Date.now() - last < OPEN_AUDIT_DEDUP_MS) return;
    openAudited.set(key, Date.now());
    if (openAudited.size > 10_000) openAudited.clear();
    void db.shareAuditEvent.create({ data: { ownerAccountId: access.ownerId, actorAccountId: granteeId, grantKind: 'project', grantId: access.projectGrantId, resourceKind: 'session', resourceId: sessionId, kind: 'project.derive.open', detail: { projectId: access.projectId } } })
        .catch(() => undefined);
}

// ---------------------------------------------------------------- membership changes

/**
 * Wraps every project membership mutation (projects/store.ts). When the owner
 * has project shares, the sessions that LEFT a shared project are reported to
 * its grantees as revoked (unless a direct session share still covers them),
 * and grantees of a project that GAINED sessions are told to re-read.
 */
export async function aroundMembershipChange<T>(ownerId: string, work: () => Promise<T>): Promise<T> {
    const grants = await db.projectGrant.findMany({ where: { ownerAccountId: ownerId, ...activeWhere() }, select: { id: true, projectId: true, granteeAccountId: true } });
    if (grants.length === 0) {
        const result = await work();
        invalidateProjectShareCaches();
        return result;
    }
    const projects = [...new Set(grants.map((g) => g.projectId))];
    const before = new Map<string, Set<string>>();
    for (const p of projects) before.set(p, new Set(await projectSessionIds(ownerId, p)));
    const result = await work();
    invalidateProjectShareCaches();
    shareChangedHook?.();
    for (const p of projects) {
        const after = new Set(await projectSessionIds(ownerId, p).catch(() => []));
        const removed = [...(before.get(p) ?? [])].filter((s) => !after.has(s));
        const added = [...after].filter((s) => !before.get(p)?.has(s));
        for (const g of grants.filter((x) => x.projectId === p)) {
            for (const sessionId of removed) {
                const direct = await db.sessionGrant.findFirst({ where: { sessionId, granteeAccountId: g.granteeAccountId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } });
                if (direct) { emitToAccount(g.granteeAccountId, 'project-share-changed', { grantId: g.id }); continue; }
                await emitUpdateToAccount?.(g.granteeAccountId, { t: 'session-share-revoked', sessionId, grantId: g.id });
                audit('project.item.removed', ownerId, ownerId, g.id, p, { sessionId });
            }
            if (added.length > 0 || removed.length > 0) emitToAccount(g.granteeAccountId, 'project-share-changed', { grantId: g.id });
        }
    }
    return result;
}

/** Wired by sessionShares.ts (it owns the update-seq emitter and the cross-slot broadcast). */
let emitUpdateToAccount: ((accountId: string, body: any) => Promise<void>) | null = null;
let shareChangedHook: (() => void) | null = null;
export function wireProjectShares(deps: { emitUpdate: (accountId: string, body: any) => Promise<void>; sharesChanged: () => void }): void {
    emitUpdateToAccount = deps.emitUpdate;
    shareChangedHook = deps.sharesChanged;
    setProjectMembershipChangeHook((accountId, work) => aroundMembershipChange(accountId, work));
    // Expiry is enforced on every read; this only tells grantees and owners promptly.
    if (!expiryTimer) {
        expiryTimer = setInterval(() => { void expireProjectGrants().catch(() => undefined); }, 30_000);
        expiryTimer.unref?.();
    }
}
let expiryTimer: NodeJS.Timeout | null = null;

function changed(): void {
    invalidateProjectShareCaches();
    shareChangedHook?.();
}

// ---------------------------------------------------------------- grants

async function grantView(grant: { id: string; projectId: string; role: SessionGrantRole; status: SessionGrantStatus; createdAt: Date; acceptedAt: Date | null; expiresAt: Date | null; grantee: ProfileAccount }): Promise<ProjectGrantView> {
    return {
        id: grant.id, projectId: grant.projectId, role: grant.role as ProjectShareRole, status: grant.status,
        createdAt: grant.createdAt.getTime(), acceptedAt: grant.acceptedAt ? grant.acceptedAt.getTime() : null, expiresAt: grant.expiresAt ? grant.expiresAt.getTime() : null,
        grantee: await person(grant.grantee),
    };
}

async function ownedProject(ownerId: string, projectId: string) {
    const project = await db.project.findFirst({ where: { id: projectId, accountId: ownerId }, select: { id: true, name: true, archivedAt: true } });
    if (!project) throw new ProjectShareError('project_not_found', 404);
    return project;
}

export async function createProjectGrant(input: { ownerId: string; projectId: string; target?: string; granteeAccountId?: string; role: ProjectShareRole; expiresInDays?: ProjectShareExpiryDays }, granteePublicKey: (accountId: string) => Promise<Uint8Array | null>): Promise<ProjectGrantView> {
    const project = await ownedProject(input.ownerId, input.projectId);
    if (project.archivedAt) throw new ProjectShareError('project_archived', 409);
    const expiresAt = projectShareExpiresAt(input.expiresInDays);
    const grantee = input.granteeAccountId
        ? await db.account.findUnique({ where: { id: input.granteeAccountId }, include: profileInclude })
        : await resolveAccountByHandle(input.target ?? '');
    if (!grantee) throw new ProjectShareError('target_not_found', 404);
    if (grantee.id === input.ownerId) throw new ProjectShareError('cannot_share_with_self', 400);
    const publicKey = await granteePublicKey(grantee.id);
    if (!publicKey) throw new ProjectShareError('grantee_key_unavailable', 409);
    await enforceAccountWriteRate({ accountId: input.ownerId, resource: 'relationship', units: 1, envName: 'MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE', fallback: 30 });
    const grant = await inTx(async (tx) => {
        const existing = await tx.projectGrant.findUnique({ where: { projectId_granteeAccountId: { projectId: project.id, granteeAccountId: grantee.id } } });
        if (existing && existing.status !== 'revoked' && (!existing.expiresAt || existing.expiresAt.getTime() > Date.now())) {
            throw new ProjectShareError('already_shared', 409, { grantId: existing.id, status: existing.status });
        }
        const count = await tx.projectGrant.count({ where: { projectId: project.id, ...liveWhere() } });
        if (count >= MAX_GRANTS_PER_PROJECT) throw new ProjectShareError('too_many_grants', 409);
        const data = {
            role: input.role, status: 'pending' as const,
            // A fresh terminal stream key on every (re)share.
            granteeKey: Buffer.from(wrapDataEncryptionKey(new Uint8Array(randomBytes(32)), publicKey)),
            expiresAt, endedReason: null, acceptedAt: null, revokedAt: null,
        };
        return existing
            ? tx.projectGrant.update({ where: { id: existing.id }, data, include: { grantee: { include: profileInclude } } })
            : tx.projectGrant.create({ data: { ...data, projectId: project.id, ownerAccountId: input.ownerId, granteeAccountId: grantee.id }, include: { grantee: { include: profileInclude } } });
    });
    changed();
    audit('grant.create', input.ownerId, input.ownerId, grant.id, project.id, { role: input.role, expiresAt: expiresAt?.toISOString() ?? null });
    emitToAccount(grantee.id, 'project-share-changed', { grantId: grant.id });
    return grantView(grant);
}

export async function listProjectGrants(ownerId: string, projectId: string): Promise<ProjectGrantView[]> {
    await ownedProject(ownerId, projectId);
    const grants = await db.projectGrant.findMany({ where: { projectId, ...liveWhere() }, orderBy: { createdAt: 'asc' }, include: { grantee: { include: profileInclude } } });
    return Promise.all(grants.map(grantView));
}

export async function listOutgoingProjectGrants(ownerId: string): Promise<Array<ProjectGrantView & { projectName: string }>> {
    const grants = await db.projectGrant.findMany({ where: { ownerAccountId: ownerId, ...liveWhere() }, orderBy: { createdAt: 'desc' }, take: 200, include: { grantee: { include: profileInclude }, project: { select: { name: true } } } });
    return Promise.all(grants.map(async (g) => ({ ...(await grantView(g)), projectName: g.project.name })));
}

async function grantByGrantee(ownerId: string, projectId: string, granteeAccountId: string) {
    await ownedProject(ownerId, projectId);
    const grant = await db.projectGrant.findUnique({ where: { projectId_granteeAccountId: { projectId, granteeAccountId } }, include: { grantee: { include: profileInclude } } });
    if (!grant || grant.status === 'revoked') throw new ProjectShareError('grant_not_found', 404);
    return grant;
}

export async function updateProjectGrant(ownerId: string, projectId: string, granteeAccountId: string, input: { role?: ProjectShareRole; expiresInDays?: ProjectShareExpiryDays }): Promise<ProjectGrantView> {
    const grant = await grantByGrantee(ownerId, projectId, granteeAccountId);
    const updated = await db.projectGrant.update({
        where: { id: grant.id },
        data: { ...(input.role ? { role: input.role } : {}), ...(input.expiresInDays !== undefined ? { expiresAt: projectShareExpiresAt(input.expiresInDays) } : {}) },
        include: { grantee: { include: profileInclude } },
    });
    changed();
    audit('grant.update', ownerId, ownerId, grant.id, projectId, { role: updated.role, expiresAt: updated.expiresAt?.toISOString() ?? null });
    emitToAccount(granteeAccountId, 'project-share-changed', { grantId: grant.id });
    return grantView(updated);
}

/** Owner revokes: derived access ends now; direct session shares of the same sessions are untouched. */
export async function revokeProjectGrant(ownerId: string, projectId: string, granteeAccountId: string): Promise<void> {
    const grant = await grantByGrantee(ownerId, projectId, granteeAccountId);
    await endProjectGrant(grant.id, 'revoked');
}

/** Ends one grant: row revoked, caches dropped on every slot, derived sessions withdrawn, project terminals detached. */
async function endProjectGrant(grantId: string, reason: 'revoked' | 'left' | 'declined' | 'expired' | 'deleted'): Promise<void> {
    const grant = await db.projectGrant.findUnique({ where: { id: grantId } });
    if (!grant) return;
    const wasActive = grant.status === 'active';
    // The sessions the grantee could reach a moment ago (before the row flips).
    const reachable = wasActive ? await projectSessionIds(grant.ownerAccountId, grant.projectId).catch(() => []) : [];
    if (grant.status !== 'revoked') await db.projectGrant.update({ where: { id: grant.id }, data: { status: 'revoked', revokedAt: new Date(), endedReason: reason } });
    changed();
    emitToAccount(grant.granteeAccountId, 'project-share-revoked', { grantId: grant.id, reason });
    for (const sessionId of reachable) {
        const direct = await db.sessionGrant.findFirst({ where: { sessionId, granteeAccountId: grant.granteeAccountId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } });
        if (!direct) await emitUpdateToAccount?.(grant.granteeAccountId, { t: 'session-share-revoked', sessionId, grantId: grant.id });
    }
    await teardownProjectTerminalShares(grant.id, reason === 'declined' ? 'left' : reason === 'expired' ? 'expired' : reason === 'left' ? 'left' : 'revoked');
    audit(reason === 'left' ? 'left' : reason === 'declined' ? 'grant.decline' : 'ended', grant.ownerAccountId, reason === 'left' || reason === 'declined' ? grant.granteeAccountId : grant.ownerAccountId, grant.id, grant.projectId, { reason });
    emitToAccount(grant.ownerAccountId, 'project-share-changed', { grantId: grant.id });
}

export async function respondToProjectGrant(granteeId: string, grantId: string, accept: boolean): Promise<void> {
    const grant = await db.projectGrant.findFirst({ where: { id: grantId, granteeAccountId: granteeId } });
    if (!grant || grant.status === 'revoked' || (grant.expiresAt && grant.expiresAt.getTime() <= Date.now())) throw new ProjectShareError('grant_not_found', 404);
    if (accept) {
        if (grant.status === 'active') return;
        await db.projectGrant.update({ where: { id: grant.id }, data: { status: 'active', acceptedAt: new Date() } });
        changed();
        audit('grant.accept', grant.ownerAccountId, granteeId, grant.id, grant.projectId);
        emitToAccount(grant.ownerAccountId, 'project-share-changed', { grantId: grant.id });
        emitToAccount(granteeId, 'project-share-changed', { grantId: grant.id });
        return;
    }
    await endProjectGrant(grant.id, grant.status === 'active' ? 'left' : 'declined');
}

export async function listIncomingProjectShares(granteeId: string): Promise<IncomingProjectShare[]> {
    const grants = await db.projectGrant.findMany({ where: { granteeAccountId: granteeId, ...liveWhere() }, orderBy: { createdAt: 'desc' }, include: { project: { select: { name: true, archivedAt: true } } } });
    const out: IncomingProjectShare[] = [];
    for (const g of grants) {
        const owner = await db.account.findUnique({ where: { id: g.ownerAccountId }, include: profileInclude });
        if (!owner) continue;
        out.push({
            id: g.id, projectId: g.projectId, role: g.role as ProjectShareRole, status: g.status,
            granteeKey: Buffer.from(g.granteeKey).toString('base64'), name: g.project.name,
            createdAt: g.createdAt.getTime(), expiresAt: g.expiresAt ? g.expiresAt.getTime() : null, owner: await person(owner),
        });
    }
    return out;
}

/**
 * The grantee's read-only project page: name / goal / instructions and the
 * live log (decisions, findings, handoffs). No presence, messages, teams,
 * automations, defaults or folder paths (folders only as machine + basename).
 */
export async function sharedProjectView(granteeId: string, grantId: string) {
    const grant = await db.projectGrant.findFirst({ where: { id: grantId, granteeAccountId: granteeId, ...activeWhere() } });
    if (!grant) throw new ProjectShareError('grant_not_found', 404);
    const snap = await sharedProjectSnapshot(grant.ownerAccountId, grant.projectId);
    if (!snap) throw new ProjectShareError('grant_not_found', 404);
    const p = snap.project;
    const machines = await db.machine.findMany({ where: { accountId: grant.ownerAccountId }, select: { id: true } });
    const known = new Set(machines.map((m) => m.id));
    return {
        project: {
            id: p.id, name: p.name, goal: p.goal, instructions: p.instructions, instructionsVersion: p.instructionsVersion,
            archivedAt: p.archivedAt, createdAt: p.createdAt, updatedAt: p.updatedAt,
            folders: p.folders.filter((f) => known.has(f.machineId)).map((f) => ({ machineId: f.machineId, name: f.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f.path, primary: !!f.primary })),
        },
        log: snap.log.map((e) => ({ id: e.id, seq: e.seq, kind: e.kind, title: e.title, body: e.body, supersedes: e.supersedes, supersededBy: e.supersededBy, createdAt: e.createdAt, byAgent: !!e.authorSessionId })),
        sessionIds: await projectSessionIds(grant.ownerAccountId, grant.projectId),
    };
}

/** Sweep helper: grants whose expiry passed while still active (their terminals are torn down by the broker's own sweep). */
export async function expireProjectGrants(): Promise<void> {
    const expired = await db.projectGrant.findMany({ where: { status: { not: 'revoked' }, expiresAt: { lte: new Date() } }, select: { id: true }, take: 50 });
    for (const g of expired) await endProjectGrant(g.id, 'expired');
}
