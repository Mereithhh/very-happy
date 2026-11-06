/**
 * B-878 terminal sharing — grants (spec specs/2026-11-share-terminals-and-projects.md §3, §6, §7).
 *
 * A TerminalGrant names ONE terminal `(machineId, terminalId)` of the owner's
 * and one grantee. Like session grants it starts `pending` and becomes
 * `active` when the grantee accepts. Every tier expires (1/7/30 days; Lead
 * 11-03: terminal output often echoes env / tokens); the operator tier also
 * needs the owner's explicit confirmation.
 *
 * The grant carries its own random stream key boxed to the grantee's content
 * public key (`granteeKey`): the broker re-keys the owner's machine-key stream
 * to it, so the grantee never holds a key that opens anything else.
 */
import type { SessionGrantStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { enforceAccountWriteRate, isAccountResourceLimitError } from '@/app/api/resourceLimits';
import { displayNameOf, identityOf, profileInclude, resolveAccountByHandle, type ProfileAccount } from '@/app/social/accountDirectory';
import { granteeContentPublicKey } from '@/app/session/sessionShares';
import { wrapDataEncryptionKey } from '@/app/session/sessionCrypto';
import {
    MAX_TERMINAL_GRANTS_PER_TERMINAL,
    TerminalShareError,
    cwdBasename,
    isTerminalShareRole,
    terminalShareExpiry,
    type TerminalShareRole,
} from './terminalSharePolicy';
import {
    emitToAccount,
    listTerminalShareEvents,
    liveTerminalView,
    ownerTerminalExists,
    recordTerminalShareEvent,
    resolveTerminalShare,
    teardownTerminalGrant,
    terminalSharesChanged,
} from './terminalShareBroker';

export class TerminalShareStoreError extends Error {
    constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) {
        super(code);
    }
}

type Person = { id: string; displayName: string; username: string | null };

export type TerminalGrantView = {
    id: string;
    machineId: string;
    terminalId: string;
    role: TerminalShareRole;
    status: SessionGrantStatus;
    title: string | null;
    createdAt: number;
    acceptedAt: number | null;
    expiresAt: number;
    grantee: Person;
};

export type IncomingTerminalShare = {
    id: string;
    role: TerminalShareRole;
    status: SessionGrantStatus;
    /** Base64 box of the stream key to the grantee's content public key (same format as a session DEK). */
    granteeKey: string;
    title: string | null;
    /** Directory name only. */
    cwd: string | null;
    /** null = unknown (machine state unreadable); false = the terminal is not running now. */
    alive: boolean | null;
    viewOnlySupported: boolean | null;
    machineId: string;
    createdAt: number;
    expiresAt: number;
    owner: Person;
};

async function person(account: ProfileAccount): Promise<Person> {
    return { id: account.id, displayName: displayNameOf(account, await identityOf(account.id)), username: account.username ?? null };
}

function sanitizeTitle(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    return clean || null;
}

async function grantView(grant: { id: string; machineId: string; terminalId: string; role: string; status: SessionGrantStatus; titleSnapshot: string | null; createdAt: Date; acceptedAt: Date | null; expiresAt: Date; grantee: ProfileAccount }): Promise<TerminalGrantView> {
    return {
        id: grant.id, machineId: grant.machineId, terminalId: grant.terminalId,
        role: isTerminalShareRole(grant.role) ? grant.role : 'viewer',
        status: grant.status, title: grant.titleSnapshot,
        createdAt: grant.createdAt.getTime(), acceptedAt: grant.acceptedAt ? grant.acceptedAt.getTime() : null, expiresAt: grant.expiresAt.getTime(),
        grantee: await person(grant.grantee),
    };
}

function liveWhere(now = new Date()) {
    return { status: { not: 'revoked' as const }, expiresAt: { gt: now } };
}

function notifyChanged(accountIds: string[], grantId: string): void {
    for (const id of accountIds) emitToAccount(id, 'terminal-share-updated', { grantId });
}

/**
 * Owner shares one of their terminals. The machine must be the owner's; the
 * terminal's existence is checked when the grantee attaches (the daemon is the
 * truth), so an offline machine can still be shared. `title` is the owner's
 * cosmetic label for the invite.
 */
export async function createTerminalGrant(input: { ownerId: string; machineId: string; terminalId: string; title?: string; target?: string; granteeAccountId?: string; role: TerminalShareRole; expiresInDays?: unknown; confirmOperator?: boolean }): Promise<TerminalGrantView> {
    const expiresAt = terminalShareExpiry({ role: input.role, expiresInDays: input.expiresInDays, confirmOperator: input.confirmOperator });
    const machine = await db.machine.findFirst({ where: { id: input.machineId, accountId: input.ownerId }, select: { id: true, dataEncryptionKey: true } });
    if (!machine) throw new TerminalShareStoreError('machine_not_found', 404);
    if (!machine.dataEncryptionKey) throw new TerminalShareStoreError('machine_unsupported', 409);
    // QA50 P2-2: refuse a terminal the machine does not report; an offline machine cannot be checked (created as before).
    if (await ownerTerminalExists(input.ownerId, machine.id, input.terminalId) === false) throw new TerminalShareStoreError('terminal_gone', 404);
    const grantee = input.granteeAccountId
        ? await db.account.findUnique({ where: { id: input.granteeAccountId }, include: profileInclude })
        : await resolveAccountByHandle(input.target ?? '');
    if (!grantee) throw new TerminalShareStoreError('target_not_found', 404);
    if (grantee.id === input.ownerId) throw new TerminalShareStoreError('cannot_share_with_self', 400);
    const publicKey = await granteeContentPublicKey(grantee.id);
    if (!publicKey) throw new TerminalShareStoreError('grantee_key_unavailable', 409);
    await enforceAccountWriteRate({ accountId: input.ownerId, resource: 'relationship', units: 1, envName: 'MAX_SESSION_SHARES_PER_ACCOUNT_PER_MINUTE', fallback: 30 });

    const streamKey = new Uint8Array(randomBytes(32));
    const grant = await inTx(async (tx) => {
        const key = { machineId_terminalId_granteeAccountId: { machineId: machine.id, terminalId: input.terminalId, granteeAccountId: grantee.id } };
        const existing = await tx.terminalGrant.findUnique({ where: key });
        if (existing && existing.status !== 'revoked' && existing.expiresAt.getTime() > Date.now()) {
            throw new TerminalShareStoreError('already_shared', 409, { grantId: existing.id, status: existing.status });
        }
        const count = await tx.terminalGrant.count({ where: { machineId: machine.id, terminalId: input.terminalId, ownerAccountId: input.ownerId, ...liveWhere() } });
        if (count >= MAX_TERMINAL_GRANTS_PER_TERMINAL) throw new TerminalShareStoreError('too_many_grants', 409);
        const data = {
            role: input.role,
            status: 'pending' as const,
            // A fresh stream key on every (re)share: a revoked grantee's old key opens nothing new.
            granteeKey: Buffer.from(wrapDataEncryptionKey(streamKey, publicKey)),
            titleSnapshot: sanitizeTitle(input.title),
            expiresAt,
            operateConfirmedAt: input.role === 'operator' ? new Date() : null,
            endedReason: null, acceptedAt: null, revokedAt: null,
        };
        return existing
            ? tx.terminalGrant.update({ where: { id: existing.id }, data, include: { grantee: { include: profileInclude } } })
            : tx.terminalGrant.create({ data: { ...data, ownerAccountId: input.ownerId, granteeAccountId: grantee.id, machineId: machine.id, terminalId: input.terminalId }, include: { grantee: { include: profileInclude } } });
    });
    terminalSharesChanged();
    await recordTerminalShareEvent({ ownerAccountId: input.ownerId, actorAccountId: input.ownerId, grantId: grant.id, machineId: machine.id, terminalId: input.terminalId, kind: 'grant.create', detail: { role: input.role, expiresAt: expiresAt.toISOString() } });
    notifyChanged([grantee.id, input.ownerId], grant.id);
    return grantView(grant);
}

/** Owner: the grants of one terminal (live + pending). */
export async function listTerminalGrants(ownerId: string, machineId: string, terminalId: string): Promise<TerminalGrantView[]> {
    const grants = await db.terminalGrant.findMany({
        where: { ownerAccountId: ownerId, machineId, terminalId, ...liveWhere() },
        orderBy: { createdAt: 'asc' },
        include: { grantee: { include: profileInclude } },
    });
    return Promise.all(grants.map(grantView));
}

/** Owner: every live terminal grant (settings → Shared). */
export async function listOutgoingTerminalGrants(ownerId: string): Promise<TerminalGrantView[]> {
    const grants = await db.terminalGrant.findMany({
        where: { ownerAccountId: ownerId, ...liveWhere() },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { grantee: { include: profileInclude } },
    });
    return Promise.all(grants.map(grantView));
}

async function ownedGrant(ownerId: string, grantId: string) {
    const grant = await db.terminalGrant.findFirst({ where: { id: grantId, ownerAccountId: ownerId }, include: { grantee: { include: profileInclude } } });
    if (!grant) throw new TerminalShareStoreError('grant_not_found', 404);
    return grant;
}

/**
 * Owner changes the tier or the expiry. Raising to operator needs the same
 * confirmation as granting it; lowering to viewer ends the grantee's current
 * panes (they reattach view-only).
 */
export async function updateTerminalGrant(ownerId: string, grantId: string, input: { role?: TerminalShareRole; expiresInDays?: unknown; confirmOperator?: boolean }): Promise<TerminalGrantView> {
    const grant = await ownedGrant(ownerId, grantId);
    if (grant.status === 'revoked' || grant.expiresAt.getTime() <= Date.now()) throw new TerminalShareStoreError('grant_not_found', 404);
    const role = input.role ?? (isTerminalShareRole(grant.role) ? grant.role : 'viewer');
    const raising = role === 'operator' && grant.role !== 'operator';
    const expiresAt = input.expiresInDays !== undefined || raising
        ? terminalShareExpiry({ role, expiresInDays: input.expiresInDays, confirmOperator: input.confirmOperator })
        : grant.expiresAt;
    const updated = await db.terminalGrant.update({
        where: { id: grant.id },
        data: { role, expiresAt, ...(raising ? { operateConfirmedAt: new Date() } : {}) },
        include: { grantee: { include: profileInclude } },
    });
    terminalSharesChanged();
    if (grant.role === 'operator' && role === 'viewer') {
        await teardownTerminalGrant(grant.id, 'downgraded', { granteeId: grant.granteeAccountId, ownerId, machineId: grant.machineId, terminalId: grant.terminalId });
    }
    await recordTerminalShareEvent({ ownerAccountId: ownerId, actorAccountId: ownerId, grantId: grant.id, machineId: grant.machineId, terminalId: grant.terminalId, kind: 'grant.update', detail: { role, expiresAt: expiresAt.toISOString() } });
    notifyChanged([grant.granteeAccountId, ownerId], grant.id);
    return grantView(updated);
}

/** Owner revokes: the grantee is cut off at once (teardown), the terminal keeps running. */
export async function revokeTerminalGrant(ownerId: string, grantId: string): Promise<void> {
    const grant = await ownedGrant(ownerId, grantId);
    if (grant.status === 'revoked') return;
    await db.terminalGrant.update({ where: { id: grant.id }, data: { status: 'revoked', revokedAt: new Date(), endedReason: 'revoked' } });
    terminalSharesChanged();
    await teardownTerminalGrant(grant.id, 'revoked', { granteeId: grant.granteeAccountId, ownerId, machineId: grant.machineId, terminalId: grant.terminalId });
    notifyChanged([grant.granteeAccountId, ownerId], grant.id);
}

/** Grantee accepts / declines a pending invite, or leaves an active share (decline). */
export async function respondToTerminalGrant(granteeId: string, grantId: string, accept: boolean): Promise<void> {
    const grant = await db.terminalGrant.findFirst({ where: { id: grantId, granteeAccountId: granteeId } });
    if (!grant || grant.status === 'revoked' || grant.expiresAt.getTime() <= Date.now()) throw new TerminalShareStoreError('grant_not_found', 404);
    if (accept) {
        if (grant.status === 'active') return;
        await db.terminalGrant.update({ where: { id: grant.id }, data: { status: 'active', acceptedAt: new Date() } });
        terminalSharesChanged();
        await recordTerminalShareEvent({ ownerAccountId: grant.ownerAccountId, actorAccountId: granteeId, grantId: grant.id, machineId: grant.machineId, terminalId: grant.terminalId, kind: 'grant.accept' });
    } else {
        await db.terminalGrant.update({ where: { id: grant.id }, data: { status: 'revoked', revokedAt: new Date(), endedReason: grant.status === 'active' ? 'left' : 'declined' } });
        terminalSharesChanged();
        if (grant.status === 'active') {
            await teardownTerminalGrant(grant.id, 'left', { granteeId, ownerId: grant.ownerAccountId, machineId: grant.machineId, terminalId: grant.terminalId });
        } else {
            await recordTerminalShareEvent({ ownerAccountId: grant.ownerAccountId, actorAccountId: granteeId, grantId: grant.id, machineId: grant.machineId, terminalId: grant.terminalId, kind: 'grant.decline' });
        }
    }
    notifyChanged([granteeId, grant.ownerAccountId], grant.id);
}

/** Grantee: pending invites and active shares, with the live title / directory when readable. */
export async function listIncomingTerminalShares(granteeId: string): Promise<IncomingTerminalShare[]> {
    const grants = await db.terminalGrant.findMany({
        where: { granteeAccountId: granteeId, ...liveWhere() },
        orderBy: { createdAt: 'desc' },
        include: { owner: { include: profileInclude } },
    });
    const out: IncomingTerminalShare[] = [];
    for (const grant of grants) {
        const verified = grant.status === 'active' ? await resolveTerminalShare(granteeId, grant.id) : null;
        const live = verified ? await liveTerminalView(verified).catch(() => null) : null;
        out.push({
            id: grant.id,
            role: isTerminalShareRole(grant.role) ? grant.role : 'viewer',
            status: grant.status,
            granteeKey: Buffer.from(grant.granteeKey).toString('base64'),
            title: live?.title ?? grant.titleSnapshot,
            cwd: cwdBasename(live?.cwd ?? null),
            alive: live ? live.alive : null,
            viewOnlySupported: live ? live.viewOnlySupported : null,
            machineId: grant.machineId,
            createdAt: grant.createdAt.getTime(),
            expiresAt: grant.expiresAt.getTime(),
            owner: await person(grant.owner),
        });
    }
    return out;
}

/** Owner: the audit trail of one grant. */
export async function terminalGrantEvents(ownerId: string, grantId: string, limit: number) {
    await ownedGrant(ownerId, grantId);
    return listTerminalShareEvents(grantId, limit);
}

// ---------------------------------------------------------------- B-900 batch

/** Most terminals one batch may name (a project's terminals; each item is still one grant). */
export const MAX_TERMINAL_BATCH = 50;

export type TerminalBatchRef = { machineId: string; terminalId: string; title?: string };
export type TerminalBatchOutcome = 'created' | 'upgraded' | 'skipped' | 'failed';
export type TerminalBatchResult = { machineId: string; terminalId: string; outcome: TerminalBatchOutcome; code?: string; grant?: TerminalGrantView };

function batchErrorCode(error: unknown): string {
    if (error instanceof TerminalShareStoreError || error instanceof TerminalShareError) return error.code;
    if (isAccountResourceLimitError(error)) return error.code;
    throw error;
}

function uniqueRefs(terminals: TerminalBatchRef[]): TerminalBatchRef[] {
    const seen = new Set<string>();
    return terminals.filter((t) => { const k = `${t.machineId}:${t.terminalId}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * B-900 (decision #59, spec §2.1): give ONE person "can operate" on the terminals the owner confirmed —
 * the project's terminals at this moment. It is a loop of ordinary per-terminal grants, not a project
 * tier: a terminal put into the project later gets nothing. The confirmation and the 1/7/30-day expiry
 * are checked once, up front, exactly as for a single grant (no "forever"). Per terminal:
 *  - the person already has live "can operate" → `skipped` (expiry untouched);
 *  - they have live "view only" → `upgraded` (same grant; a pending one stays pending);
 *  - nothing live → a new pending grant (`created`; they accept it like any other);
 *  - any refusal (terminal gone, too_many_grants, the share-rate limit, …) → `failed` with its code,
 *    the rest still run, so the owner sees exactly which ones to retry.
 */
export async function grantTerminalsOperator(input: { ownerId: string; granteeAccountId: string; terminals: TerminalBatchRef[]; expiresInDays?: unknown; confirmOperator?: boolean }): Promise<TerminalBatchResult[]> {
    terminalShareExpiry({ role: 'operator', expiresInDays: input.expiresInDays, confirmOperator: input.confirmOperator });
    const refs = uniqueRefs(input.terminals);
    if (refs.length === 0 || refs.length > MAX_TERMINAL_BATCH) throw new TerminalShareStoreError('bad_batch', 400);
    if (input.granteeAccountId === input.ownerId) throw new TerminalShareStoreError('cannot_share_with_self', 400);
    const out: TerminalBatchResult[] = [];
    for (const ref of refs) {
        const base = { machineId: ref.machineId, terminalId: ref.terminalId };
        try {
            const existing = await db.terminalGrant.findFirst({ where: { ownerAccountId: input.ownerId, machineId: ref.machineId, terminalId: ref.terminalId, granteeAccountId: input.granteeAccountId, ...liveWhere() }, select: { id: true, role: true } });
            if (existing?.role === 'operator') { out.push({ ...base, outcome: 'skipped' }); continue; }
            if (existing) {
                const grant = await updateTerminalGrant(input.ownerId, existing.id, { role: 'operator', expiresInDays: input.expiresInDays, confirmOperator: input.confirmOperator });
                out.push({ ...base, outcome: 'upgraded', grant });
                continue;
            }
            const grant = await createTerminalGrant({ ownerId: input.ownerId, machineId: ref.machineId, terminalId: ref.terminalId, title: ref.title, granteeAccountId: input.granteeAccountId, role: 'operator', expiresInDays: input.expiresInDays, confirmOperator: input.confirmOperator });
            out.push({ ...base, outcome: 'created', grant });
        } catch (error) {
            out.push({ ...base, outcome: 'failed', code: batchErrorCode(error) });
        }
    }
    return out;
}

/**
 * B-900: revoke ONE person's DIRECT terminal grants on the named terminals (the project's terminals).
 * Only TerminalGrant rows of this owner for this grantee: the project share, other people's grants and
 * the terminals themselves are untouched — the person falls back to the project's view-only access.
 */
export async function revokeTerminalsFor(input: { ownerId: string; granteeAccountId: string; terminals: TerminalBatchRef[] }): Promise<{ revoked: number }> {
    const refs = uniqueRefs(input.terminals);
    if (refs.length === 0 || refs.length > MAX_TERMINAL_BATCH) throw new TerminalShareStoreError('bad_batch', 400);
    const grants = await db.terminalGrant.findMany({
        where: { ownerAccountId: input.ownerId, granteeAccountId: input.granteeAccountId, status: { not: 'revoked' }, OR: refs.map((r) => ({ machineId: r.machineId, terminalId: r.terminalId })) },
        select: { id: true },
    });
    for (const grant of grants) await revokeTerminalGrant(input.ownerId, grant.id);
    return { revoked: grants.length };
}
