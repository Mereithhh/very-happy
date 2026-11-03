/**
 * B-878 terminal sharing — the server broker (spec
 * specs/2026-11-share-terminals-and-projects.md §3). Same shape as the B-867
 * operator broker (app/session/operatorBroker.ts), keyed by a TerminalGrant
 * instead of a session grant:
 *
 *   1. authorized — an active, unexpired TerminalGrant of THIS grantee;
 *   2. planned    — terminalSharePolicy.ts (role allowlist + rewrites; a
 *                   viewer attaches `viewOnly` so the owner's pane is never
 *                   resized);
 *   3. re-keyed   — the grant's own stream key (boxed to the grantee) ↔ the
 *                   owner's machine key;
 *   4. forwarded  — into the owner's machine room, the same shape the owner's
 *                   web sends, so the daemon needs no share-specific code;
 *   5. audited    — metadata only (ShareAuditEvent + business audit).
 *
 * Owner output for a shared terminal is picked out of the machine stream by
 * `terminalShareTap`, re-keyed and unicast to the grantee. Revoke / expiry /
 * leave run `teardownTerminalGrant`: the grantee is told at once, its
 * subscriptions are released, nothing on the owner's machine is killed — the
 * terminal is the owner's.
 *
 * Plaintext rule (B-867 contract): decrypted params, terminal bytes and
 * results never reach a log line, a metric label or an error string.
 *
 * Machine-key rule: `openTerminalShareMachineKey` is the only place this module
 * opens an owner's machine key, and it takes a VerifiedTerminalShare, which
 * only `resolveTerminalShare` (a grantee call) or `attachedShare` (a row a
 * verified call registered — teardown / state checks) can mint.
 */
import type { Server, Socket } from 'socket.io';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { routeRpcToRoom, rpcRoom } from '@/app/api/socket/rpcHandler';
import type { AccountTerminalRateLimiter } from '@/app/api/socket/terminalRateLimit';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { displayNameOf, identityOf } from '@/app/social/accountDirectory';
import { loadMasterSecret } from '@/app/session/sessionShares';
import { contentKeyPairFromSecret, decryptWithDataKey, encryptWithDataKey, unwrapDataEncryptionKey } from '@/app/session/sessionCrypto';
import {
    TerminalShareError,
    cwdBasename,
    allowTerminalShareEvent,
    isTerminalShareRole,
    planTerminalShareCall,
    terminalShareAuditPayload,
    viewOnlyCapable,
    webTerminalIds,
    webTerminalInfo,
    type TerminalShareErrorCode,
    type TerminalShareRole,
} from './terminalSharePolicy';

export type TerminalShareEndReason = 'revoked' | 'left' | 'expired' | 'downgraded' | 'deleted' | 'moved';

const GRANT_CACHE_TTL_MS = 1_000;
const KEY_CACHE_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 1_000;
const INPUT_FLUSH_MS = 60_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_PARAMS_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
const CROSS_SLOT_EVENT = 'vh-terminal-share-changed';
const GRANT_KIND = 'terminal';

/**
 * B-878 PR-B: a terminal reached through a PROJECT share has no grant row of its
 * own; its share id is `p:<projectGrantId>:<machineId>:<terminalId>` (none of the
 * parts can contain ':'). Always view only; valid only while the terminal's
 * `@vh_project` is that project.
 */
export function projectTerminalShareId(projectGrantId: string, machineId: string, terminalId: string): string {
    return `p:${projectGrantId}:${machineId}:${terminalId}`;
}
type ParsedShareId = { kind: 'terminal'; grantId: string } | { kind: 'project'; projectGrantId: string; machineId: string; terminalId: string };
export function parseShareId(id: string): ParsedShareId | null {
    if (!id.startsWith('p:')) return id.includes(':') ? null : { kind: 'terminal', grantId: id };
    const parts = id.split(':');
    if (parts.length !== 4 || parts.some((p) => !p)) return null;
    return { kind: 'project', projectGrantId: parts[1], machineId: parts[2], terminalId: parts[3] };
}
function kindOf(grantId: string): 'terminal' | 'project' {
    return grantId.startsWith('p:') ? 'project' : 'terminal';
}

// ---------------------------------------------------------------- grants

const VERIFIED = Symbol('verified-terminal-share');
export type VerifiedTerminalShare = {
    readonly [VERIFIED]: true;
    grantId: string;
    ownerId: string;
    granteeId: string;
    machineId: string;
    terminalId: string;
    role: TerminalShareRole;
    expiresAt: number;
    /** B-878 PR-B: the project this share is derived from (project-share ids only). */
    projectId?: string;
};

const grantCache = new Map<string, { grant: VerifiedTerminalShare | null; at: number }>();

function mint(row: Omit<VerifiedTerminalShare, typeof VERIFIED>): VerifiedTerminalShare {
    return { [VERIFIED]: true, ...row };
}

/** The grantee's live grant, or null. Cached ≤1 s; any change invalidates every slot at once. */
export async function resolveTerminalShare(granteeId: string, grantId: string): Promise<VerifiedTerminalShare | null> {
    const key = `${granteeId}:${grantId}`;
    const cached = grantCache.get(key);
    if (cached && Date.now() - cached.at < GRANT_CACHE_TTL_MS) return cached.grant && cached.grant.expiresAt > Date.now() ? cached.grant : null;
    const parsed = parseShareId(grantId);
    let grant: VerifiedTerminalShare | null = null;
    if (parsed?.kind === 'project') {
        grant = await resolveProjectTerminal(granteeId, parsed.projectGrantId, parsed.machineId, parsed.terminalId);
    } else if (parsed) {
        const row = await db.terminalGrant.findFirst({
            where: { id: grantId, granteeAccountId: granteeId, status: 'active', expiresAt: { gt: new Date() } },
            select: { id: true, ownerAccountId: true, machineId: true, terminalId: true, role: true, expiresAt: true },
        });
        grant = row && isTerminalShareRole(row.role)
            ? mint({ grantId: row.id, ownerId: row.ownerAccountId, granteeId, machineId: row.machineId, terminalId: row.terminalId, role: row.role, expiresAt: row.expiresAt.getTime() })
            : null;
    }
    grantCache.set(key, { grant, at: Date.now() });
    return grant;
}

/**
 * QA50 P2-2: does the OWNER's machine report this terminal? `null` = cannot tell
 * (machine offline, no list this daemon run wrote, legacy key) — the grant is
 * then created and the attach answers terminal_gone later, as before. Same
 * check as an attach (the daemon's pushed list), read with the owner's key for
 * the owner's own authenticated request.
 */
export async function ownerTerminalExists(ownerId: string, machineId: string, terminalId: string): Promise<boolean | null> {
    const machine = await db.machine.findFirst({ where: { id: machineId, accountId: ownerId }, select: { active: true } });
    if (!machine?.active) return null;
    const probe = mint({ grantId: '', ownerId, granteeId: ownerId, machineId, terminalId, role: 'viewer', expiresAt: 0 });
    const machineKey = await openTerminalShareMachineKey(probe);
    if (!machineKey) return null;
    const ids = webTerminalIds(await readDaemonState(probe, machineKey));
    return ids ? ids.has(terminalId) : null;
}

/** This grantee's ACTIVE, unexpired project grant row (the only input a project share is minted from). */
async function activeProjectGrant(granteeId: string, projectGrantId: string) {
    return db.projectGrant.findFirst({
        where: { id: projectGrantId, granteeAccountId: granteeId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true, projectId: true, ownerAccountId: true, expiresAt: true },
    });
}

/** Mint for one machine of a verified project grant. View only, always. */
function mintProjectShare(row: { id: string; projectId: string; ownerAccountId: string; expiresAt: Date | null }, granteeId: string, machineId: string, terminalId: string): VerifiedTerminalShare {
    return mint({
        grantId: projectTerminalShareId(row.id, machineId, terminalId), ownerId: row.ownerAccountId, granteeId, machineId, terminalId,
        role: 'viewer', expiresAt: row.expiresAt ? row.expiresAt.getTime() : Number.MAX_SAFE_INTEGER, projectId: row.projectId,
    });
}

/** A project terminal share is valid only while the owner's daemon reports that terminal in that project. */
async function resolveProjectTerminal(granteeId: string, projectGrantId: string, machineId: string, terminalId: string): Promise<VerifiedTerminalShare | null> {
    const row = await activeProjectGrant(granteeId, projectGrantId);
    if (!row) return null;
    const candidate = mintProjectShare(row, granteeId, machineId, terminalId);
    const machineKey = await openTerminalShareMachineKey(candidate);
    if (!machineKey) return null;
    const info = webTerminalInfo(await readDaemonState(candidate, machineKey), terminalId);
    return info && info.projectId === row.projectId ? candidate : null;
}

export type ProjectTerminalView = { shareId: string; machineId: string; terminalId: string; title: string | null; cwd: string | null; viewOnlySupported: boolean };

/** The project's terminals right now (every owner machine whose daemon reports `@vh_project` = the project). */
export async function listProjectTerminals(granteeId: string, projectGrantId: string): Promise<ProjectTerminalView[]> {
    const row = await activeProjectGrant(granteeId, projectGrantId);
    if (!row) return [];
    const machines = await db.machine.findMany({ where: { accountId: row.ownerAccountId, dataEncryptionKey: { not: null } }, select: { id: true } });
    const out: ProjectTerminalView[] = [];
    for (const machine of machines) {
        const probe = mintProjectShare(row, granteeId, machine.id, '');
        const machineKey = await openTerminalShareMachineKey(probe);
        if (!machineKey) continue;
        const state = await readDaemonState(probe, machineKey);
        const ids = webTerminalIds(state);
        if (!ids) continue;
        for (const terminalId of ids) {
            const info = webTerminalInfo(state, terminalId);
            if (!info || info.projectId !== row.projectId) continue;
            out.push({ shareId: projectTerminalShareId(row.id, machine.id, terminalId), machineId: machine.id, terminalId, title: info.title, cwd: cwdBasename(info.cwd), viewOnlySupported: viewOnlyCapable(state) });
        }
    }
    return out;
}

/** Teardown / state checks only: a grant reference for an attachment a verified grantee call registered. */
function attachedShare(row: { grantId: string; ownerAccountId: string; granteeAccountId: string; machineId: string; terminalId: string }): VerifiedTerminalShare {
    return mint({ grantId: row.grantId, ownerId: row.ownerAccountId, granteeId: row.granteeAccountId, machineId: row.machineId, terminalId: row.terminalId, role: 'viewer', expiresAt: 0 });
}

// ---------------------------------------------------------------- keys

const machineKeyCache = new Map<string, { key: Uint8Array; at: number }>();
const streamKeyCache = new Map<string, { key: Uint8Array; at: number }>();

/** The owner's machine data key. ONLY reachable with a VerifiedTerminalShare, only for the grant's own machine. */
async function openTerminalShareMachineKey(grant: VerifiedTerminalShare): Promise<Uint8Array | null> {
    if (!grant || grant[VERIFIED] !== true) return null;
    const cacheKey = `${grant.ownerId}:${grant.machineId}`;
    const cached = machineKeyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.key;
    const machine = await db.machine.findFirst({ where: { id: grant.machineId, accountId: grant.ownerId }, select: { dataEncryptionKey: true } });
    if (!machine?.dataEncryptionKey) return null; // legacy machine key: unsupported
    const master = await loadMasterSecret(grant.ownerId);
    if (!master) return null;
    let key: Uint8Array | null = null;
    try { key = unwrapDataEncryptionKey(new Uint8Array(machine.dataEncryptionKey), contentKeyPairFromSecret(master)); } catch { key = null; }
    if (!key) return null;
    machineKeyCache.set(cacheKey, { key, at: Date.now() });
    return key;
}

/** The grant's stream key, opened with the grantee's content key (the grantee's web does the same). */
async function openStreamKey(grantId: string, granteeId: string): Promise<Uint8Array | null> {
    const cached = streamKeyCache.get(grantId);
    if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.key;
    const parsed = parseShareId(grantId);
    if (!parsed) return null;
    const row = parsed.kind === 'project'
        ? await db.projectGrant.findUnique({ where: { id: parsed.projectGrantId }, select: { granteeKey: true, granteeAccountId: true } })
        : await db.terminalGrant.findUnique({ where: { id: grantId }, select: { granteeKey: true, granteeAccountId: true } });
    if (!row || row.granteeAccountId !== granteeId) return null;
    const master = await loadMasterSecret(granteeId);
    if (!master) return null;
    let key: Uint8Array | null = null;
    try { key = unwrapDataEncryptionKey(new Uint8Array(row.granteeKey), contentKeyPairFromSecret(master)); } catch { key = null; }
    if (!key) return null;
    streamKeyCache.set(grantId, { key, at: Date.now() });
    return key;
}

function fromB64(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }
function toB64(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
function seal(value: unknown, key: Uint8Array): string { return toB64(encryptWithDataKey(value, key)); }
function open(value: unknown, key: Uint8Array): unknown | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try { return decryptWithDataKey(fromB64(value), key); } catch { return null; }
}

/** The owner machine's stored daemonState, decrypted with the machine key. Null when absent / unreadable. */
async function readDaemonState(grant: VerifiedTerminalShare, machineKey: Uint8Array): Promise<unknown | null> {
    const machine = await db.machine.findFirst({ where: { id: grant.machineId, accountId: grant.ownerId }, select: { daemonState: true } });
    return machine?.daemonState ? open(machine.daemonState, machineKey) : null;
}

// ---------------------------------------------------------------- attachment index

type AttachEntry = { grantId: string; ownerId: string; granteeId: string; machineId: string; terminalId: string; subscribers: number; openedAt: number };

/** Open attachments by `${machineId}:${terminalId}` — what the output tap consults per frame. */
let attachIndex = new Map<string, AttachEntry[]>();
/** Last geometry each attachment was told about (state hook dedup). */
const lastGeometry = new Map<string, string>();

async function refreshAttachIndex(): Promise<AttachEntry[]> {
    const rows = await db.shareTerminalAttachment.findMany({
        where: { closedAt: null },
        select: { grantId: true, ownerAccountId: true, granteeAccountId: true, machineId: true, terminalId: true, subscribers: true, openedAt: true },
    });
    const next = new Map<string, AttachEntry[]>();
    const entries: AttachEntry[] = rows.map((row) => ({
        grantId: row.grantId, ownerId: row.ownerAccountId, granteeId: row.granteeAccountId,
        machineId: row.machineId, terminalId: row.terminalId, subscribers: row.subscribers, openedAt: row.openedAt.getTime(),
    }));
    for (const entry of entries) {
        const key = `${entry.machineId}:${entry.terminalId}`;
        next.set(key, [...(next.get(key) ?? []), entry]);
    }
    attachIndex = next;
    return entries;
}

// ---------------------------------------------------------------- io / cross-slot

let ioRef: Server | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

function invalidateCaches(): void {
    grantCache.clear();
    // A re-share boxes a NEW stream key into the same row: never keep sealing with the old one.
    streamKeyCache.clear();
}

function announceChange(): void {
    invalidateCaches();
    void refreshAttachIndex().catch((error) => log({ module: 'terminal-share', errorName: errorName(error) }, 'terminal share index refresh failed'));
    try { ioRef?.serverSideEmit(CROSS_SLOT_EVENT, {}); } catch { /* single-node adapter */ }
}

/** Any grant change (create, accept, re-role, revoke): drop cached verdicts on every slot. */
export function terminalSharesChanged(): void {
    announceChange();
}

export function startTerminalShareBroker(io: Server): void {
    ioRef = io;
    io.on(CROSS_SLOT_EVENT, () => {
        invalidateCaches();
        void refreshAttachIndex().catch(() => { /* next sweep */ });
    });
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => { void sweepTerminalShares(); }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
}

export function stopTerminalShareBroker(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    ioRef = null;
}

/** Test seam: run with an io without the sweep timer. */
export function __setTerminalShareIoForTests(io: Server | null): void {
    ioRef = io;
    grantCache.clear();
    machineKeyCache.clear();
    streamKeyCache.clear();
}

export function emitToAccount(accountId: string, event: string, payload: unknown): void {
    ioRef?.to(`user:${accountId}:user-scoped`).emit(event, payload);
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------- audit

export async function recordTerminalShareEvent(input: { ownerAccountId: string; actorAccountId: string; grantId: string; machineId: string; terminalId: string; kind: string; detail?: Record<string, unknown> }): Promise<void> {
    await db.shareAuditEvent.create({ data: {
        ownerAccountId: input.ownerAccountId, actorAccountId: input.actorAccountId, grantKind: kindOf(input.grantId), grantId: input.grantId,
        resourceKind: 'terminal', resourceId: `${input.machineId}:${input.terminalId}`, kind: input.kind, detail: (input.detail ?? {}) as any,
    } }).catch((error) => log({ module: 'terminal-share', grantId: input.grantId, errorName: errorName(error) }, 'terminal share event write failed'));
    log({ module: 'terminal-share', grantId: input.grantId, actorAccountId: input.actorAccountId }, `terminal-share.${input.kind}`);
    if (businessAuditEnabled()) publishAudit({ kind: `terminal.share.${input.kind}`, accountId: input.actorAccountId, payload: terminalShareAuditPayload(input.grantId, input.detail) });
}

const inputStats = new Map<string, { grant: VerifiedTerminalShare; bytes: number; enters: number }>();

function countInput(grant: VerifiedTerminalShare, plainB64: string): void {
    const bytes = Buffer.from(plainB64, 'base64');
    const stat = inputStats.get(grant.grantId) ?? { grant, bytes: 0, enters: 0 };
    stat.bytes += bytes.length;
    for (const byte of bytes) if (byte === 0x0d) stat.enters++;
    inputStats.set(grant.grantId, stat);
}

let lastInputFlush = Date.now();
async function flushInputStats(force = false): Promise<void> {
    if (!force && Date.now() - lastInputFlush < INPUT_FLUSH_MS) return;
    lastInputFlush = Date.now();
    const batch = [...inputStats.values()];
    inputStats.clear();
    for (const { grant, bytes, enters } of batch) {
        // Counts only — keystrokes can be passwords.
        await recordTerminalShareEvent({ ownerAccountId: grant.ownerId, actorAccountId: grant.granteeId, grantId: grant.grantId, machineId: grant.machineId, terminalId: grant.terminalId, kind: 'terminal.input', detail: { bytes, enters } });
    }
}

/** Owner side: who is watching / operating this terminal right now. */
async function emitShareActivity(grant: { grantId: string; ownerId: string; granteeId: string; machineId: string; terminalId: string }, watching: boolean, role: string | null): Promise<void> {
    const account = await db.account.findUnique({ where: { id: grant.granteeId }, select: { id: true, firstName: true, lastName: true, username: true } });
    const displayName = account ? displayNameOf(account, await identityOf(account.id)) : grant.granteeId;
    emitToAccount(grant.ownerId, 'terminal-share-activity', {
        grantId: grant.grantId, machineId: grant.machineId, terminalId: grant.terminalId,
        granteeAccountId: grant.granteeId, displayName, role, watching, at: Date.now(),
    });
}

// ---------------------------------------------------------------- calls

type Limits = { rpc?: AccountTerminalRateLimiter; terminal?: AccountTerminalRateLimiter };

function charge(limiter: AccountTerminalRateLimiter | undefined, accountIds: string[], bytes: number): boolean {
    if (!limiter) return true;
    for (const id of accountIds) if (!limiter.tryConsume(id, bytes).ok) return false;
    return true;
}

function boundedId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;
}

async function forwardToOwner(io: Server, ownerId: string, method: string, encryptedParams: string): Promise<unknown> {
    const routed = await routeRpcToRoom(io, rpcRoom(ownerId, method), method, encryptedParams);
    if (!routed.ok) throw new TerminalShareError(routed.code === 'not_available' || routed.code === 'target_disconnected' ? 'machine_offline' : 'rpc_failed');
    return routed.result;
}

function decryptTerminalField(value: unknown, machineKey: Uint8Array): unknown {
    const plain = open(value, machineKey);
    return typeof plain === 'string' ? plain : value;
}

/** Owner daemon terminal result (machine-key stream) → plain terminal bytes; the whole result is then sealed with the stream key. */
function plainTerminalResult(result: Record<string, unknown>, machineKey: Uint8Array): Record<string, unknown> {
    const out = { ...result };
    if (typeof out.data === 'string') out.data = decryptTerminalField(out.data, machineKey);
    if (Array.isArray(out.chunks)) out.chunks = (out.chunks as Array<{ seq: number; data: unknown }>).map((chunk) => ({ ...chunk, data: decryptTerminalField(chunk.data, machineKey) }));
    out.encStream = false;
    delete out.tmuxSession;
    return out;
}

export type TerminalShareRpcAck = { ok: true; result: unknown } | { ok: false; error: TerminalShareErrorCode };

/** One `share-terminal-rpc` call. Never throws; errors are fixed codes. */
export async function handleTerminalShareRpc(io: Server, granteeId: string, data: unknown, limits: Limits = {}, onSubscribed?: (grantId: string) => void): Promise<TerminalShareRpcAck> {
    try {
        return { ok: true, result: await runTerminalShareRpc(io, granteeId, data, limits, onSubscribed) };
    } catch (error) {
        if (error instanceof TerminalShareError) return { ok: false, error: error.code };
        log({ module: 'terminal-share', granteeId, errorName: errorName(error) }, 'terminal share rpc failed');
        return { ok: false, error: 'rpc_failed' };
    }
}

async function runTerminalShareRpc(io: Server, granteeId: string, data: unknown, limits: Limits, onSubscribed?: (grantId: string) => void): Promise<unknown> {
    const { grantId, op, params } = (data ?? {}) as { grantId?: unknown; op?: unknown; params?: unknown };
    if (!boundedId(grantId) || typeof op !== 'string' || op.length > 32) throw new TerminalShareError('bad_params');
    if (params !== undefined && params !== null && (typeof params !== 'string' || params.length > MAX_PARAMS_BYTES)) throw new TerminalShareError('bad_params');

    const grant = await resolveTerminalShare(granteeId, grantId);
    if (!grant) throw new TerminalShareError('not_shared');
    if (!charge(limits.rpc, [granteeId, grant.ownerId], typeof params === 'string' ? params.length : 0)) throw new TerminalShareError('rate_limited');
    const streamKey = await openStreamKey(grant.grantId, granteeId);
    if (!streamKey) throw new TerminalShareError('machine_unsupported');
    const plainParams = typeof params === 'string' ? open(params, streamKey) : {};
    if (plainParams === null) throw new TerminalShareError('bad_params');

    const machineKey = await openTerminalShareMachineKey(grant);
    if (!machineKey) throw new TerminalShareError('machine_unsupported');
    const state = await readDaemonState(grant, machineKey);
    const info = webTerminalInfo(state, grant.terminalId);
    const plan = planTerminalShareCall(op, plainParams, {
        role: grant.role,
        terminalId: grant.terminalId,
        grantId: grant.grantId,
        viewOnlyCapable: viewOnlyCapable(state),
        geometry: info && info.cols !== null && info.rows !== null ? { cols: info.cols, rows: info.rows } : null,
    });
    const isAttach = plan.method === 'open-terminal';
    const isResub = isAttach && plan.params.resub === true;
    if (isAttach) {
        // Register BEFORE the open so the tap already forwards the first frames.
        await db.shareTerminalAttachment.upsert({
            where: { grantKind_grantId_machineId_terminalId: { grantKind: kindOf(grant.grantId), grantId: grant.grantId, machineId: grant.machineId, terminalId: grant.terminalId } },
            create: { grantKind: kindOf(grant.grantId), grantId: grant.grantId, ownerAccountId: grant.ownerId, granteeAccountId: granteeId, machineId: grant.machineId, terminalId: grant.terminalId, subscribers: isResub ? 0 : 1 },
            update: { closedAt: null, closeReason: null, ...(isResub ? {} : { subscribers: { increment: 1 } }) },
        });
        announceChange();
    }

    let raw: unknown;
    try {
        raw = await forwardToOwner(io, grant.ownerId, `${grant.machineId}:${plan.method}`, seal(plan.params, machineKey));
    } catch (error) {
        if (isAttach && !isResub) await releaseSubscriber(grant, 'open_failed');
        throw error;
    }
    const result = open(raw, machineKey) as Record<string, unknown> | null;
    if (!result || typeof result !== 'object') {
        if (isAttach && !isResub) await releaseSubscriber(grant, 'open_failed');
        throw new TerminalShareError('rpc_failed');
    }
    if (typeof result.error === 'string') {
        if (isAttach && !isResub) await releaseSubscriber(grant, 'open_failed');
        throw new TerminalShareError(result.error.includes('terminal-gone') ? 'terminal_gone' : 'rpc_failed');
    }
    if (isAttach && result.type === 'success' && result.encStream !== true) {
        // A daemon that cannot encrypt the stream: never relay it in clear.
        await releaseSubscriber(grant, 'cli_upgrade_required', true);
        throw new TerminalShareError('cli_upgrade_required');
    }
    if (!(await resolveTerminalShare(granteeId, grant.grantId))) throw new TerminalShareError('not_shared');
    if (plan.auditKind) {
        await recordTerminalShareEvent({ ownerAccountId: grant.ownerId, actorAccountId: granteeId, grantId: grant.grantId, machineId: grant.machineId, terminalId: grant.terminalId, kind: plan.auditKind, detail: { role: grant.role } });
    }
    if (isAttach && !isResub) {
        onSubscribed?.(grant.grantId);
        void emitShareActivity(grant, true, grant.role).catch(() => undefined);
    }
    const geometry = isAttach && typeof result.paneCols === 'number' && typeof result.paneRows === 'number'
        ? { cols: result.paneCols, rows: result.paneRows }
        : isAttach && info?.cols && info.rows ? { cols: info.cols, rows: info.rows } : undefined;
    return seal({ ...plainTerminalResult(result, machineKey), terminalId: grant.terminalId, role: grant.role, ...(geometry ? { geometry } : {}) }, streamKey);
}

/**
 * One subscription less (grantee closed its pane, or an open failed). Atomic and
 * idempotent: returns false — and changes nothing — when this grant holds no
 * subscription, so a repeated close can never reach below what the grant
 * itself added to the daemon's count (QA50 P2-1). The row closes at zero.
 */
async function releaseSubscriber(grant: { grantId: string; machineId: string; terminalId: string }, reason: string, close = false): Promise<boolean> {
    const key = { grantKind: kindOf(grant.grantId), grantId: grant.grantId, machineId: grant.machineId, terminalId: grant.terminalId };
    const taken = await db.shareTerminalAttachment.updateMany({ where: { ...key, closedAt: null, subscribers: { gt: 0 } }, data: { subscribers: { decrement: 1 } } });
    if (taken.count === 0) return false;
    await db.shareTerminalAttachment.updateMany({ where: { ...key, closedAt: null, ...(close ? {} : { subscribers: 0 }) }, data: { closedAt: new Date(), closeReason: reason } });
    announceChange();
    return true;
}

/** Grantee → owner machine: input / resize / close for the grant's terminal. */
async function forwardTerminalEvent(granteeId: string, event: 'input' | 'resize' | 'close', data: Record<string, unknown>, limits: Limits): Promise<void> {
    const { grantId } = data;
    if (!boundedId(grantId)) return;
    const grant = await resolveTerminalShare(granteeId, grantId);
    if (!grant) return;
    if (!allowTerminalShareEvent(grant.role, event)) return;
    const room = `user:${grant.ownerId}:machine:${grant.machineId}`;
    if (event === 'input') {
        if (typeof data.data !== 'string' || data.data.length > MAX_PARAMS_BYTES) return;
        if (!charge(limits.terminal, [granteeId, grant.ownerId], data.data.length)) return;
        const streamKey = await openStreamKey(grant.grantId, granteeId);
        if (!streamKey) return;
        const plain = open(data.data, streamKey);
        if (typeof plain !== 'string') return;
        const machineKey = await openTerminalShareMachineKey(grant);
        if (!machineKey) return;
        countInput(grant, plain);
        ioRef?.to(room).emit('terminal-input', { terminalId: grant.terminalId, data: seal(plain, machineKey), enc: true, shareGrantId: grant.grantId });
        return;
    }
    if (!charge(limits.terminal, [granteeId], 64)) return;
    if (event === 'resize') {
        const cols = data.cols; const rows = data.rows;
        const ok = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 2 && (v as number) <= 10_000;
        if (!ok(cols) || !ok(rows)) return;
        ioRef?.to(room).emit('terminal-resize', { terminalId: grant.terminalId, cols, rows, shareGrantId: grant.grantId });
        return;
    }
    // close = unsubscribe this pane; never a kill. Only a subscription this grant really holds is
    // released on the daemon: a stray / repeated close must not unsubscribe the owner's own view.
    if (!(await releaseSubscriber(grant, 'detached'))) return;
    ioRef?.to(room).emit('terminal-close', { terminalId: grant.terminalId });
    void emitShareActivity(grant, false, grant.role).catch(() => undefined);
}

// ---------------------------------------------------------------- live stream

const tapChains = new Map<string, Promise<void>>();

/**
 * Called by terminalHandler for every owner-machine `terminal-output` /
 * `terminal-exit` (after the owner's own emit). O(1) miss for unshared
 * terminals; for shared ones the frame is re-keyed and unicast. Frames of one
 * terminal are processed in arrival order.
 */
export function terminalShareTap(ownerId: string, machineId: string, event: 'terminal-output' | 'terminal-exit', frame: { terminalId: string; data?: string; seq?: number; enc?: boolean; exitCode?: number }): void {
    const key = `${machineId}:${frame.terminalId}`;
    const entries = attachIndex.get(key);
    if (!entries || entries.length === 0) return;
    const previous = tapChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => deliverFrame(ownerId, machineId, event, frame, entries)).catch((error) => {
        log({ module: 'terminal-share', machineId, errorName: errorName(error) }, 'terminal share tap failed');
    });
    tapChains.set(key, next);
    void next.finally(() => { if (tapChains.get(key) === next) tapChains.delete(key); });
}

async function deliverFrame(ownerId: string, machineId: string, event: 'terminal-output' | 'terminal-exit', frame: { terminalId: string; data?: string; seq?: number; enc?: boolean; exitCode?: number }, entries: AttachEntry[]): Promise<void> {
    for (const entry of entries) {
        if (entry.ownerId !== ownerId) continue;
        const grant = await resolveTerminalShare(entry.granteeId, entry.grantId);
        if (!grant || grant.machineId !== machineId) continue;
        if (event === 'terminal-exit') {
            await terminalGone(entry, 'exited', frame.exitCode);
            continue;
        }
        if (typeof frame.data !== 'string') continue;
        let plain: unknown = frame.data;
        if (frame.enc) {
            const machineKey = await openTerminalShareMachineKey(grant);
            if (!machineKey) continue;
            plain = open(frame.data, machineKey);
            if (typeof plain !== 'string') continue;
        }
        const streamKey = await openStreamKey(grant.grantId, grant.granteeId);
        if (!streamKey) continue;
        emitToAccount(entry.granteeId, 'share-terminal-output', { grantId: entry.grantId, seq: frame.seq, data: seal(plain, streamKey) });
    }
}

/** The shared terminal ended on the owner's machine (exit, or closed from the owner's sidebar). */
async function terminalGone(entry: AttachEntry, reason: 'exited' | 'closed_on_machine', exitCode?: number): Promise<void> {
    const closed = await db.shareTerminalAttachment.updateMany({
        where: { grantKind: kindOf(entry.grantId), grantId: entry.grantId, machineId: entry.machineId, terminalId: entry.terminalId, closedAt: null },
        data: { closedAt: new Date(), closeReason: reason, subscribers: 0 },
    });
    if (closed.count === 0) return;
    announceChange();
    emitToAccount(entry.granteeId, 'share-terminal-exit', { grantId: entry.grantId, exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1, reason });
}

/**
 * machineUpdateHandler hook: the owner's machine stored a new daemonState.
 * Map miss unless a shared terminal is attached on that machine; then the list
 * is read with the machine key (reached through the attachment row): a terminal
 * gone from the list ends for its viewers, a new pane size is pushed so a
 * view-only pane re-fits.
 */
export async function noteTerminalShareMachineState(ownerId: string, machineId: string, encryptedState: unknown): Promise<void> {
    const entries: AttachEntry[] = [];
    for (const list of attachIndex.values()) for (const e of list) if (e.ownerId === ownerId && e.machineId === machineId) entries.push(e);
    if (entries.length === 0) return;
    const first = entries[0];
    const key = await openTerminalShareMachineKey(attachedShare({ grantId: first.grantId, ownerAccountId: ownerId, granteeAccountId: first.granteeId, machineId, terminalId: first.terminalId }));
    if (!key) return;
    const state = open(encryptedState, key);
    const ids = webTerminalIds(state);
    if (!ids) return;
    for (const entry of entries) {
        if (!ids.has(entry.terminalId)) {
            if (Date.now() - entry.openedAt < GONE_GRACE_MS) continue;
            await terminalGone(entry, 'closed_on_machine');
            continue;
        }
        const info = webTerminalInfo(state, entry.terminalId);
        // B-878 PR-B: a project terminal moved out of the project — access ends now.
        const parsed = parseShareId(entry.grantId);
        if (parsed?.kind === 'project') {
            const pg = await db.projectGrant.findUnique({ where: { id: parsed.projectGrantId }, select: { projectId: true } });
            if (!pg || info?.projectId !== pg.projectId) {
                await teardownTerminalGrant(entry.grantId, 'moved', { granteeId: entry.granteeId, ownerId: entry.ownerId, machineId: entry.machineId, terminalId: entry.terminalId });
                continue;
            }
        }
        if (!info || info.cols === null || info.rows === null) continue;
        const size = `${info.cols}x${info.rows}`;
        const dedupKey = `${entry.grantId}:${entry.terminalId}`;
        if (lastGeometry.get(dedupKey) === size) continue;
        lastGeometry.set(dedupKey, size);
        emitToAccount(entry.granteeId, 'share-terminal-geometry', { grantId: entry.grantId, cols: info.cols, rows: info.rows });
    }
}

/** A push that predates the attach may not list a just-restored terminal yet. */
const GONE_GRACE_MS = 10_000;

// ---------------------------------------------------------------- socket wiring

/** Grantee side: user-scoped sockets only (central server, never the relay). */
export function terminalShareHandler(userId: string, socket: Socket, connection: { connectionType: string }, limits: Limits): void {
    if (connection.connectionType !== 'user-scoped') return;
    // Subscriptions this socket holds: a closed tab or dropped socket never sends
    // share-terminal-close, and a leaked subscriber pins the owner's pty past the idle reaper.
    const held = new Map<string, number>();
    socket.on('share-terminal-rpc', async (data: unknown, callback?: (ack: TerminalShareRpcAck) => void) => {
        const ack = await handleTerminalShareRpc(ioRef ?? (socket.nsp.server as Server), userId, data, limits, (grantId) => {
            held.set(grantId, (held.get(grantId) ?? 0) + 1);
        });
        if (typeof callback === 'function') callback(ack);
    });
    socket.on('disconnect', () => {
        void releaseHeldSubscriptions(userId, held).catch((error) => {
            log({ module: 'terminal-share', userId, errorName: errorName(error) }, 'terminal share release failed');
        });
    });
    for (const [inbound, event] of [
        ['share-terminal-input', 'input'],
        ['share-terminal-resize', 'resize'],
        ['share-terminal-close', 'close'],
    ] as const) {
        socket.on(inbound, (data: unknown) => {
            if (!data || typeof data !== 'object') return;
            if (event === 'close') {
                const grantId = (data as { grantId?: unknown }).grantId;
                const count = typeof grantId === 'string' ? held.get(grantId) ?? 0 : 0;
                if (count > 1) held.set(grantId as string, count - 1); else if (count === 1) held.delete(grantId as string);
            }
            void forwardTerminalEvent(userId, event, data as Record<string, unknown>, limits).catch((error) => {
                log({ module: 'terminal-share', userId, errorName: errorName(error) }, 'terminal share event failed');
            });
        });
    }
}

/** The socket went away: close every subscription it still held (no-op for a grant already ended). */
export async function releaseHeldSubscriptions(granteeId: string, held: Map<string, number>): Promise<void> {
    for (const [grantId, count] of held) {
        for (let i = 0; i < count; i++) await forwardTerminalEvent(granteeId, 'close', { grantId }, {});
    }
    held.clear();
}

/** Test seam for the socket events. */
export async function __forwardTerminalEventForTests(granteeId: string, event: 'input' | 'resize' | 'close', data: Record<string, unknown>): Promise<void> {
    await forwardTerminalEvent(granteeId, event, data, {});
}

// ---------------------------------------------------------------- teardown

/**
 * End a grant's access everywhere: close its attachments (the tap stops),
 * release the daemon subscriptions it held, invalidate every slot, tell the
 * grantee's web. Never kills the owner's terminal. Idempotent.
 */
export async function teardownTerminalGrant(grantId: string, reason: TerminalShareEndReason, notify?: { granteeId: string; ownerId: string; machineId: string; terminalId: string }): Promise<{ detached: number }> {
    invalidateCaches();
    const rows = await db.shareTerminalAttachment.findMany({ where: { grantKind: kindOf(grantId), grantId, closedAt: null } });
    if (rows.length > 0) {
        await db.shareTerminalAttachment.updateMany({ where: { grantKind: kindOf(grantId), grantId, closedAt: null }, data: { closedAt: new Date(), closeReason: reason, subscribers: 0 } });
    }
    announceChange();
    const target = notify ?? (rows[0] ? { granteeId: rows[0].granteeAccountId, ownerId: rows[0].ownerAccountId, machineId: rows[0].machineId, terminalId: rows[0].terminalId } : null);
    if (target) emitToAccount(target.granteeId, 'share-terminal-revoked', { grantId, reason });
    for (const row of rows) {
        // Release the daemon subscriptions this grant held (an unsubscribe, not a kill).
        for (let i = 0; i < row.subscribers; i++) ioRef?.to(`user:${row.ownerAccountId}:machine:${row.machineId}`).emit('terminal-close', { terminalId: row.terminalId });
    }
    if (target) {
        await flushInputStats(true);
        void emitShareActivity({ grantId, ...target }, false, null).catch(() => undefined);
        await recordTerminalShareEvent({ ownerAccountId: target.ownerId, actorAccountId: reason === 'left' ? target.granteeId : target.ownerId, grantId, machineId: target.machineId, terminalId: target.terminalId, kind: 'ended', detail: { reason, detached: rows.length } });
    }
    return { detached: rows.length };
}

/** A project share ended: detach every project terminal reached through it. */
export async function teardownProjectTerminalShares(projectGrantId: string, reason: TerminalShareEndReason): Promise<void> {
    invalidateCaches();
    const rows = await db.shareTerminalAttachment.findMany({ where: { grantKind: 'project', grantId: { startsWith: `p:${projectGrantId}:` }, closedAt: null }, select: { grantId: true } });
    for (const grantId of new Set(rows.map((r) => r.grantId))) await teardownTerminalGrant(grantId, reason);
}

let sweeping = false;
let lastRetention = 0;

/**
 * Every 1 s per slot: refresh the attachment index, end attachments whose grant
 * is no longer valid (expiry, a revoke another slot missed), flush input
 * counters, prune old audit events.
 */
export async function sweepTerminalShares(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
        const entries = await refreshAttachIndex();
        const byGrant = new Map<string, AttachEntry>();
        for (const entry of entries) byGrant.set(entry.grantId, entry);
        if (byGrant.size > 0) {
            const terminalIds = [...byGrant.keys()].filter((id) => kindOf(id) === 'terminal');
            const live = await db.terminalGrant.findMany({ where: { id: { in: terminalIds }, status: 'active', expiresAt: { gt: new Date() } }, select: { id: true } });
            const liveIds = new Set(live.map((grant) => grant.id));
            for (const [grantId, entry] of byGrant) {
                if (kindOf(grantId) === 'project') {
                    // Revoked / expired project share, or the terminal left the project.
                    if (await resolveTerminalShare(entry.granteeId, grantId)) continue;
                    const parsed = parseShareId(grantId);
                    const pg = parsed?.kind === 'project' ? await db.projectGrant.findUnique({ where: { id: parsed.projectGrantId }, select: { status: true, expiresAt: true } }) : null;
                    const why: TerminalShareEndReason = !pg ? 'deleted' : pg.status === 'revoked' ? 'revoked' : pg.expiresAt && pg.expiresAt.getTime() <= Date.now() ? 'expired' : 'moved';
                    await teardownTerminalGrant(grantId, why, { granteeId: entry.granteeId, ownerId: entry.ownerId, machineId: entry.machineId, terminalId: entry.terminalId });
                    continue;
                }
                if (liveIds.has(grantId)) continue;
                const grant = await db.terminalGrant.findUnique({ where: { id: grantId }, select: { status: true, expiresAt: true } });
                const reason: TerminalShareEndReason = !grant ? 'deleted' : grant.status === 'revoked' ? 'revoked' : 'expired';
                await teardownTerminalGrant(grantId, reason, { granteeId: entry.granteeId, ownerId: entry.ownerId, machineId: entry.machineId, terminalId: entry.terminalId });
            }
        }
        await flushInputStats();
        if (Date.now() - lastRetention > 60 * 60_000) {
            lastRetention = Date.now();
            await db.shareAuditEvent.deleteMany({ where: { at: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } });
        }
    } catch (error) {
        log({ module: 'terminal-share', errorName: errorName(error) }, 'terminal share sweep failed');
    } finally {
        sweeping = false;
    }
}

/** Test seams. */
export async function __flushTerminalShareInputForTests(): Promise<void> {
    await flushInputStats(true);
}
export async function __refreshTerminalShareIndexForTests(): Promise<void> {
    await refreshAttachIndex();
}

// ---------------------------------------------------------------- views

/** For the grantee's list: live title / cwd / online, read with the verified grant. */
export async function liveTerminalView(grant: VerifiedTerminalShare): Promise<{ title: string | null; cwd: string | null; alive: boolean | null; viewOnlySupported: boolean } | null> {
    const machineKey = await openTerminalShareMachineKey(grant);
    if (!machineKey) return null;
    const state = await readDaemonState(grant, machineKey);
    const ids = webTerminalIds(state);
    const info = webTerminalInfo(state, grant.terminalId);
    return { title: info?.title ?? null, cwd: info?.cwd ?? null, alive: ids ? ids.has(grant.terminalId) : null, viewOnlySupported: viewOnlyCapable(state) };
}

export async function listTerminalShareEvents(grantId: string, limit: number) {
    const rows = await db.shareAuditEvent.findMany({ where: { grantKind: GRANT_KIND, grantId }, orderBy: { at: 'desc' }, take: Math.max(1, Math.min(limit, 200)) });
    return rows.map((row) => ({ id: row.id, kind: row.kind, actorAccountId: row.actorAccountId, detail: row.detail ?? {}, at: row.at.getTime() }));
}
