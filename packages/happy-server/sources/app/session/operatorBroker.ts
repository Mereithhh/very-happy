/**
 * B-867 operator tier — the server broker (spec specs/2026-11-session-sharing-operator.md §2, §5, §6).
 *
 * An operator never holds the owner's machine key, relay token or RPC room.
 * Every operator action arrives here over the operator's own user socket,
 * encrypted with the ONE session DEK it already holds (B-619), and is:
 *
 *   1. authorized   — an active, unexpired `operate` grant on that session;
 *   2. planned      — allowlist + rewrites in operatorPolicy.ts;
 *   3. re-keyed     — DEK for session RPCs, the owner's machine key for terminals;
 *   4. forwarded    — into the OWNER's RPC room / machine room, same shape the
 *                     owner's own web sends, so the daemon needs no change;
 *   5. audited      — metadata only (SessionOperatorEvent + business audit).
 *
 * Terminal output for operator terminals is picked out of the owner's machine
 * stream (`operatorTerminalTap`), re-encrypted with the DEK and unicast to the
 * operator. Revocation / downgrade / expiry / archive / delete run
 * `teardownOperatorGrant`: kill the terminals the operator opened, detach the
 * ones it attached to, tell every slot and the operator's web.
 *
 * Plaintext rule (Lead 11-03): decrypted params, terminal bytes and results
 * never reach a log line, a metric label or an error string. Errors are the
 * fixed OperatorError codes; logs carry ids and error *names* only.
 *
 * Machine-key rule: `openOperatorMachineKey` is the only place the owner's
 * machine key is opened, and it takes a VerifiedOperatorGrant, which only
 * `resolveOperatorGrant` (an operator call) or `registeredGrant` (teardown of
 * a terminal a verified operator call registered) can mint.
 */
import type { Server, Socket } from 'socket.io';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { randomBytes } from 'node:crypto';
import { routeRpcToRoom, rpcRoom } from '@/app/api/socket/rpcHandler';
import type { AccountTerminalRateLimiter } from '@/app/api/socket/terminalRateLimit';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { displayNameOf, identityOf } from '@/app/social/accountDirectory';
import { loadAccountSecret } from '@/app/auth/accountSecrets';
import { openSessionDataKey, ownerSetOperatorModeCap } from './sessionShares';
import { contentKeyPairFromSecret, decodeAccountSecret, decryptWithDataKey, encryptWithDataKey, unwrapDataEncryptionKey } from './sessionCrypto';
import {
    OperatorError,
    isOperatorSessionMethod,
    isOperatorTerminalOp,
    operatorAuditPayload,
    planOperatorSessionCall,
    planOperatorTerminalCall,
    type OperatorErrorCode,
    type TerminalRegistryEntry,
} from './operatorPolicy';

export type OperatorEndReason = 'revoked' | 'downgraded' | 'expired' | 'deleted' | 'archived' | 'ended_by_owner';

const GRANT_CACHE_TTL_MS = 1_000;
const MACHINE_KEY_CACHE_TTL_MS = 10 * 60_000;
/** B-867c: 1 s (was 2 s) so an expiry reaches the operator within ~1 s; idle cost is one indexed query per slot per tick. */
const SWEEP_INTERVAL_MS = 1_000;
const INPUT_FLUSH_MS = 60_000;
const ACTIVITY_EMIT_MIN_MS = 20_000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_PARAMS_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
const CROSS_SLOT_EVENT = 'vh-operator-changed';

// ---------------------------------------------------------------- grants

const VERIFIED = Symbol('verified-operator-grant');
export type VerifiedOperatorGrant = {
    readonly [VERIFIED]: true;
    grantId: string;
    sessionId: string;
    ownerId: string;
    granteeId: string;
    expiresAt: number;
    /** SessionGrant.operateModeCap (B-867b); null reads as `default`. */
    modeCap: string | null;
};

const grantCache = new Map<string, { grant: VerifiedOperatorGrant | null; at: number }>();

function mint(row: { grantId: string; sessionId: string; ownerId: string; granteeId: string; expiresAt: number; modeCap: string | null }): VerifiedOperatorGrant {
    return { [VERIFIED]: true, ...row };
}

function stillValid(grant: VerifiedOperatorGrant | null, now = Date.now()): grant is VerifiedOperatorGrant {
    return !!grant && grant.expiresAt > now;
}

/** The operator's live grant on this session, or null. Cached ≤1 s; revoke invalidates every slot at once. */
export async function resolveOperatorGrant(granteeId: string, sessionId: string): Promise<VerifiedOperatorGrant | null> {
    const key = `${granteeId}:${sessionId}`;
    const cached = grantCache.get(key);
    if (cached && Date.now() - cached.at < GRANT_CACHE_TTL_MS) return stillValid(cached.grant) ? cached.grant : null;
    const now = new Date();
    const row = await db.sessionGrant.findFirst({
        where: { sessionId, granteeAccountId: granteeId, status: 'active', role: 'driver', operate: true, expiresAt: { gt: now } },
        select: { id: true, expiresAt: true, operateModeCap: true, session: { select: { accountId: true, archivedAt: true } } },
    });
    const grant = row && row.expiresAt && !row.session.archivedAt
        ? mint({ grantId: row.id, sessionId, ownerId: row.session.accountId, granteeId, expiresAt: row.expiresAt.getTime(), modeCap: row.operateModeCap })
        : null;
    grantCache.set(key, { grant, at: Date.now() });
    return grant;
}

function invalidateGrantCache(): void {
    grantCache.clear();
}

/** Any grant change (accept, re-role, expiry edit, revoke): drop cached verdicts on every slot. */
export function operatorGrantsChanged(): void {
    invalidateGrantCache();
    try { ioRef?.serverSideEmit(CROSS_SLOT_EVENT, {}); } catch { /* single-node adapter */ }
}

/**
 * rpcHandler hook for the account's own `rpc-call`: an owner `set-permission-mode`
 * or a mode-carrying approval updates the operator cap. Cheap no-op unless the
 * session has an active operator grant.
 */
export async function noteOwnerModeRpc(ownerId: string, method: string, encryptedParams: unknown): Promise<void> {
    const sep = method.lastIndexOf(':');
    if (sep <= 0) return;
    const sessionId = method.slice(0, sep);
    const name = method.slice(sep + 1);
    if (name !== 'set-permission-mode' && name !== 'permission') return;
    const operators = await db.sessionGrant.count({ where: { sessionId, operate: true, status: 'active', session: { accountId: ownerId } } });
    if (operators === 0) return;
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true } });
    if (!session || session.accountId !== ownerId) return;
    const dek = await openSessionDataKey(session);
    if (!dek) return;
    const params = open(encryptedParams, dek) as Record<string, unknown> | null;
    if (!params || typeof params.mode !== 'string') return;
    if (name === 'permission' && params.approved !== true) return;
    await ownerSetOperatorModeCap(ownerId, sessionId, params.mode);
}

/** Teardown only: a grant reference for a terminal row a verified operator call registered. */
function registeredGrant(row: { grantId: string; sessionId: string; ownerAccountId: string; granteeAccountId: string }): VerifiedOperatorGrant {
    return mint({ grantId: row.grantId, sessionId: row.sessionId, ownerId: row.ownerAccountId, granteeId: row.granteeAccountId, expiresAt: 0, modeCap: null });
}

// ---------------------------------------------------------------- keys

const machineKeyCache = new Map<string, { key: Uint8Array; at: number }>();

/**
 * The owner's machine data key. ONLY reachable with a VerifiedOperatorGrant,
 * and only for a machine owned by that grant's owner.
 */
async function openOperatorMachineKey(grant: VerifiedOperatorGrant, machineId: string): Promise<Uint8Array | null> {
    if (!grant || grant[VERIFIED] !== true) return null;
    const cacheKey = `${grant.ownerId}:${machineId}`;
    const cached = machineKeyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MACHINE_KEY_CACHE_TTL_MS) return cached.key;
    const machine = await db.machine.findFirst({ where: { id: machineId, accountId: grant.ownerId }, select: { dataEncryptionKey: true } });
    if (!machine?.dataEncryptionKey) return null; // legacy machine key: unsupported
    const credential = await db.accountCredential.findUnique({ where: { accountId: grant.ownerId }, select: { secretEnc: true } });
    const secret = await loadAccountSecret(db, grant.ownerId, credential?.secretEnc);
    if (!secret) return null;
    let key: Uint8Array | null = null;
    try { key = unwrapDataEncryptionKey(new Uint8Array(machine.dataEncryptionKey), contentKeyPairFromSecret(decodeAccountSecret(secret))); } catch { key = null; }
    if (!key) return null;
    machineKeyCache.set(cacheKey, { key, at: Date.now() });
    return key;
}

type SessionContext = {
    dek: Uint8Array;
    /** Encrypted agentState (pending permission requests live here). */
    agentState: string | null;
    cwd: string;
    currentMode: unknown;
    flavor: unknown;
    capabilities: unknown;
    sessionTerminalId: string | null;
    machineId: string | null;
};

async function loadSessionContext(grant: VerifiedOperatorGrant): Promise<SessionContext | null> {
    const session = await db.session.findUnique({ where: { id: grant.sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true, agentState: true } });
    if (!session || session.accountId !== grant.ownerId) return null;
    const dek = await openSessionDataKey(session);
    if (!dek) return null;
    const metadata = decryptWithDataKey(fromB64(session.metadata), dek) as Record<string, unknown> | null;
    if (!metadata || typeof metadata.path !== 'string' || !metadata.path) return null;
    return {
        dek,
        agentState: session.agentState,
        cwd: metadata.path,
        currentMode: metadata.permissionMode,
        flavor: metadata.flavor,
        capabilities: metadata.capabilities,
        sessionTerminalId: typeof metadata.terminalId === 'string' ? metadata.terminalId : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
    };
}

/** agentState.requests[params.id].tool, or null when unknown (the policy then fails closed). */
function pendingRequestTool(ctx: SessionContext, params: unknown): string | null {
    const id = params && typeof params === 'object' ? (params as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string' || !ctx.agentState) return null;
    const state = open(ctx.agentState, ctx.dek) as { requests?: Record<string, { tool?: unknown }> } | null;
    const tool = state?.requests && Object.prototype.hasOwnProperty.call(state.requests, id) ? state.requests[id]?.tool : undefined;
    return typeof tool === 'string' ? tool : null;
}

function fromB64(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }
function toB64(value: Uint8Array): string { return Buffer.from(value).toString('base64'); }
function seal(value: unknown, key: Uint8Array): string { return toB64(encryptWithDataKey(value, key)); }
function open(value: unknown, key: Uint8Array): unknown | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try { return decryptWithDataKey(fromB64(value), key); } catch { return null; }
}

// ---------------------------------------------------------------- terminal index

type IndexEntry = { grantId: string; sessionId: string; ownerId: string; granteeId: string; machineId: string; terminalId: string; kind: 'opened' | 'attached'; openedAt: number };

/** Open operator terminals by `${machineId}:${terminalId}` — what the output tap consults per frame. */
let terminalIndex = new Map<string, IndexEntry[]>();
let indexLoadedAt = 0;

async function refreshTerminalIndex(): Promise<IndexEntry[]> {
    const rows = await db.sessionOperatorTerminal.findMany({
        where: { closedAt: null },
        select: { grantId: true, sessionId: true, ownerAccountId: true, granteeAccountId: true, machineId: true, terminalId: true, kind: true, openedAt: true },
    });
    const next = new Map<string, IndexEntry[]>();
    const entries: IndexEntry[] = rows.map((row) => ({
        grantId: row.grantId, sessionId: row.sessionId, ownerId: row.ownerAccountId, granteeId: row.granteeAccountId,
        machineId: row.machineId, terminalId: row.terminalId, kind: row.kind === 'attached' ? 'attached' : 'opened', openedAt: row.openedAt.getTime(),
    }));
    for (const entry of entries) {
        const key = `${entry.machineId}:${entry.terminalId}`;
        next.set(key, [...(next.get(key) ?? []), entry]);
    }
    terminalIndex = next;
    indexLoadedAt = Date.now();
    return entries;
}

function grantRegistry(grantId: string): TerminalRegistryEntry[] {
    const out: TerminalRegistryEntry[] = [];
    for (const entries of terminalIndex.values()) {
        for (const entry of entries) if (entry.grantId === grantId) out.push({ terminalId: entry.terminalId, kind: entry.kind });
    }
    return out;
}

function findIndexEntry(granteeId: string, sessionId: string, terminalId: string): IndexEntry | null {
    for (const entries of terminalIndex.values()) {
        for (const entry of entries) {
            if (entry.granteeId === granteeId && entry.sessionId === sessionId && entry.terminalId === terminalId) return entry;
        }
    }
    return null;
}

// ---------------------------------------------------------------- io / cross-slot

let ioRef: Server | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

function announceChange(): void {
    invalidateGrantCache();
    void refreshTerminalIndex().catch((error) => log({ module: 'operator', errorName: errorName(error) }, 'operator index refresh failed'));
    try { ioRef?.serverSideEmit(CROSS_SLOT_EVENT, {}); } catch { /* single-node adapter */ }
}

/** Wire the broker to this server's io: cross-slot invalidation + the sweep. */
export function startOperatorBroker(io: Server): void {
    ioRef = io;
    io.on(CROSS_SLOT_EVENT, () => {
        invalidateGrantCache();
        void refreshTerminalIndex().catch(() => { /* next sweep */ });
    });
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(() => { void sweepOperatorTerminals(); }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
}

export function stopOperatorBroker(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    ioRef = null;
}

/** Test seam: run with an io without the sweep timer. */
export function __setOperatorIoForTests(io: Server | null): void {
    ioRef = io;
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
}

// ---------------------------------------------------------------- audit + activity

export async function recordOperatorEvent(input: { sessionId: string; grantId: string; actorAccountId: string; kind: string; detail?: Record<string, unknown> }): Promise<void> {
    await db.sessionOperatorEvent.create({ data: { sessionId: input.sessionId, grantId: input.grantId, actorAccountId: input.actorAccountId, kind: input.kind, detail: (input.detail ?? {}) as any } })
        .catch((error) => log({ module: 'operator', sessionId: input.sessionId, errorName: errorName(error) }, 'operator event write failed'));
    log({ module: 'operator', sessionId: input.sessionId, grantId: input.grantId, actorAccountId: input.actorAccountId }, `operator.${input.kind}`);
    // Command text stays in SessionOperatorEvent (the owner's log); the business audit gets metadata only (B-867c).
    if (businessAuditEnabled()) publishAudit({ kind: `session.share.operator.${input.kind}`, accountId: input.actorAccountId, sessionId: input.sessionId, payload: operatorAuditPayload(input.grantId, input.detail) });
}

const lastActivityEmit = new Map<string, number>();

async function emitOperatorActivity(grant: { grantId: string; sessionId: string; ownerId: string; granteeId: string }, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - (lastActivityEmit.get(grant.grantId) ?? 0) < ACTIVITY_EMIT_MIN_MS) return;
    lastActivityEmit.set(grant.grantId, now);
    const openTerminals = await db.sessionOperatorTerminal.count({ where: { grantId: grant.grantId, closedAt: null } });
    const account = await db.account.findUnique({ where: { id: grant.granteeId }, select: { id: true, firstName: true, lastName: true, username: true } });
    const displayName = account ? displayNameOf(account, await identityOf(account.id)) : grant.granteeId;
    ioRef?.to(`user:${grant.ownerId}:user-scoped`).emit('operator-activity', {
        sessionId: grant.sessionId, granteeAccountId: grant.granteeId, displayName, openTerminals, lastActivityAt: now,
    });
}

const inputStats = new Map<string, { sessionId: string; granteeId: string; bytes: number; enters: number }>();

function countInput(grant: VerifiedOperatorGrant, plainB64: string): void {
    const bytes = Buffer.from(plainB64, 'base64');
    const stat = inputStats.get(grant.grantId) ?? { sessionId: grant.sessionId, granteeId: grant.granteeId, bytes: 0, enters: 0 };
    stat.bytes += bytes.length;
    for (const byte of bytes) if (byte === 0x0d) stat.enters++;
    inputStats.set(grant.grantId, stat);
}

let lastInputFlush = Date.now();
async function flushInputStats(force = false): Promise<void> {
    if (!force && Date.now() - lastInputFlush < INPUT_FLUSH_MS) return;
    lastInputFlush = Date.now();
    const batch = [...inputStats.entries()];
    inputStats.clear();
    for (const [grantId, stat] of batch) {
        // Counts only — keystrokes can be passwords (spec §6.1).
        await recordOperatorEvent({ sessionId: stat.sessionId, grantId, actorAccountId: stat.granteeId, kind: 'terminal.input', detail: { bytes: stat.bytes, enters: stat.enters } });
    }
}

// ---------------------------------------------------------------- forwarding

async function forwardToOwner(io: Server, ownerId: string, method: string, encryptedParams: string): Promise<unknown> {
    const routed = await routeRpcToRoom(io, rpcRoom(ownerId, method), method, encryptedParams);
    if (!routed.ok) throw new OperatorError(routed.code === 'not_available' || routed.code === 'target_disconnected' ? 'machine_offline' : 'rpc_failed');
    return routed.result;
}

function decryptTerminalField(value: unknown, machineKey: Uint8Array): unknown {
    const plain = open(value, machineKey);
    return typeof plain === 'string' ? plain : value;
}

/** Owner daemon terminal result (machine-key stream) → plain terminal bytes, sealed later with the DEK as a whole. */
function plainTerminalResult(result: Record<string, unknown>, machineKey: Uint8Array): Record<string, unknown> {
    const out = { ...result };
    if (typeof out.data === 'string') out.data = decryptTerminalField(out.data, machineKey);
    if (Array.isArray(out.chunks)) out.chunks = (out.chunks as Array<{ seq: number; data: unknown }>).map((chunk) => ({ ...chunk, data: decryptTerminalField(chunk.data, machineKey) }));
    out.encStream = false;
    return out;
}

type Limits = { rpc?: AccountTerminalRateLimiter; terminal?: AccountTerminalRateLimiter };

function charge(limiter: AccountTerminalRateLimiter | undefined, accountIds: string[], bytes: number): boolean {
    if (!limiter) return true;
    for (const id of accountIds) if (!limiter.tryConsume(id, bytes).ok) return false;
    return true;
}

function boundedId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;
}

export type OperatorRpcAck = { ok: true; result: unknown } | { ok: false; error: OperatorErrorCode };

/** One `operator-rpc` call. Never throws; errors are fixed codes. */
export async function handleOperatorRpc(io: Server, granteeId: string, data: unknown, limits: Limits = {}): Promise<OperatorRpcAck> {
    try {
        return { ok: true, result: await runOperatorRpc(io, granteeId, data, limits) };
    } catch (error) {
        if (error instanceof OperatorError) return { ok: false, error: error.code };
        log({ module: 'operator', granteeId, errorName: errorName(error) }, 'operator rpc failed');
        return { ok: false, error: 'rpc_failed' };
    }
}

async function runOperatorRpc(io: Server, granteeId: string, data: unknown, limits: Limits): Promise<unknown> {
    const { sessionId, op, params } = (data ?? {}) as { sessionId?: unknown; op?: unknown; params?: unknown };
    if (!boundedId(sessionId) || typeof op !== 'string' || op.length > 64) throw new OperatorError('bad_params');
    if (params !== undefined && params !== null && (typeof params !== 'string' || params.length > MAX_PARAMS_BYTES)) throw new OperatorError('bad_params');
    if (!isOperatorSessionMethod(op) && !isOperatorTerminalOp(op)) throw new OperatorError('operator_method_denied');

    const grant = await resolveOperatorGrant(granteeId, sessionId);
    if (!grant) throw new OperatorError('not_operator');
    if (!charge(limits.rpc, [granteeId, grant.ownerId], typeof params === 'string' ? params.length : 0)) throw new OperatorError('rate_limited');
    const ctx = await loadSessionContext(grant);
    if (!ctx) throw new OperatorError('machine_unsupported');
    const plainParams = typeof params === 'string' ? open(params, ctx.dek) : {};
    if (plainParams === null) throw new OperatorError('bad_params');

    if (isOperatorSessionMethod(op)) {
        const plan = planOperatorSessionCall(op, plainParams, {
            cwd: ctx.cwd,
            currentMode: ctx.currentMode,
            modeCap: grant.modeCap,
            flavor: ctx.flavor,
            capabilities: ctx.capabilities,
            permissionTool: op === 'permission' ? pendingRequestTool(ctx, plainParams) : undefined,
        });
        const method = `${sessionId}:${plan.method}`;
        const result = await forwardToOwner(io, grant.ownerId, method, seal(plan.params, ctx.dek));
        if (!(await resolveOperatorGrant(granteeId, sessionId))) throw new OperatorError('not_operator');
        if (plan.audit) await recordOperatorEvent({ sessionId, grantId: grant.grantId, actorAccountId: granteeId, kind: plan.audit.kind, detail: plan.audit.detail });
        void emitOperatorActivity(grant, false);
        // The daemon already sealed the result with the same DEK the operator holds.
        return result;
    }

    if (!ctx.machineId) throw new OperatorError('machine_unsupported');
    const machineId = ctx.machineId;
    if (Date.now() - indexLoadedAt > SWEEP_INTERVAL_MS) await refreshTerminalIndex();
    const plan = planOperatorTerminalCall(op, plainParams, {
        cwd: ctx.cwd,
        sessionTerminalId: ctx.sessionTerminalId,
        registry: grantRegistry(grant.grantId),
        newTerminalId: () => `op-${randomBytes(6).toString('hex')}`,
    });
    if (plan.kind === 'list') {
        return seal({ terminals: grantRegistry(grant.grantId), sessionTerminal: !!ctx.sessionTerminalId }, ctx.dek);
    }

    const machineKey = await openOperatorMachineKey(grant, machineId);
    if (!machineKey) throw new OperatorError('machine_unsupported');
    if (plan.register) {
        // Register BEFORE opening so the tap already forwards the first frames.
        await db.sessionOperatorTerminal.upsert({
            where: { grantId_machineId_terminalId: { grantId: grant.grantId, machineId, terminalId: plan.register.terminalId } },
            create: { grantId: grant.grantId, sessionId, ownerAccountId: grant.ownerId, granteeAccountId: granteeId, machineId, terminalId: plan.register.terminalId, kind: plan.register.kind },
            update: { closedAt: null, closeReason: null, pendingKill: false, kind: plan.register.kind },
        });
        announceChange();
    }
    let raw: unknown;
    // The operator's own kill: the daemonState push it causes is not "closed on the machine".
    const killing = plan.unregister ? `${machineId}:${plan.unregister}` : null;
    if (killing) operatorKillsInFlight.add(killing);
    try {
        raw = await forwardToOwner(io, grant.ownerId, `${machineId}:${plan.method}`, seal(plan.params, machineKey));
    } catch (error) {
        if (plan.register) await closeRegistry(grant.grantId, machineId, plan.register.terminalId, 'open_failed');
        throw error;
    } finally {
        if (killing) operatorKillsInFlight.delete(killing);
    }
    const result = open(raw, machineKey) as Record<string, unknown> | null;
    if (!result || typeof result !== 'object') {
        if (plan.register) await closeRegistry(grant.grantId, machineId, plan.register.terminalId, 'open_failed');
        throw new OperatorError('rpc_failed');
    }
    if (plan.method === 'open-terminal' && result.type === 'success' && result.encStream !== true) {
        // A daemon that cannot encrypt the stream: never relay it in clear.
        if (plan.register?.kind === 'opened') await killOnOwnerMachine(io, grant, machineId, plan.register.terminalId, machineKey);
        if (plan.register) await closeRegistry(grant.grantId, machineId, plan.register.terminalId, 'cli_upgrade_required');
        throw new OperatorError('cli_upgrade_required');
    }
    if (plan.method === 'open-terminal' && result.type !== 'success' && plan.register) {
        await closeRegistry(grant.grantId, machineId, plan.register.terminalId, 'open_failed');
    }
    if (!(await resolveOperatorGrant(granteeId, sessionId))) throw new OperatorError('not_operator');
    if (plan.method === 'open-terminal' && result.type === 'success' && plan.register?.kind === 'opened') {
        void tagOperatorTerminal(io, grant, machineId, plan.register.terminalId, machineKey);
    }
    if (plan.unregister && result.type === 'success') await closeRegistry(grant.grantId, machineId, plan.unregister, 'killed');
    if (plan.auditKind) {
        await recordOperatorEvent({ sessionId, grantId: grant.grantId, actorAccountId: granteeId, kind: plan.auditKind, detail: { terminalId: plan.register?.terminalId ?? plan.unregister ?? null, cwd: plan.register?.kind === 'opened' ? ctx.cwd : undefined } });
        void emitOperatorActivity(grant, true);
    } else {
        void emitOperatorActivity(grant, false);
    }
    const terminalId = plan.register?.terminalId ?? (typeof plan.params.terminalId === 'string' ? plan.params.terminalId : undefined);
    return seal({ ...plainTerminalResult(result, machineKey), ...(terminalId ? { terminalId } : {}) }, ctx.dek);
}

async function closeRegistry(grantId: string, machineId: string, terminalId: string, reason: string): Promise<void> {
    await db.sessionOperatorTerminal.updateMany({ where: { grantId, machineId, terminalId, closedAt: null }, data: { closedAt: new Date(), closeReason: reason } });
    announceChange();
}

async function killOnOwnerMachine(io: Server, grant: VerifiedOperatorGrant, machineId: string, terminalId: string, machineKey?: Uint8Array | null): Promise<boolean> {
    const key = machineKey ?? await openOperatorMachineKey(grant, machineId);
    if (!key) return false;
    try {
        const raw = await forwardToOwner(io, grant.ownerId, `${machineId}:kill-terminal`, seal({ terminalId }, key));
        const result = open(raw, key) as { type?: string } | null;
        return result?.type === 'success';
    } catch {
        return false;
    }
}

/** Mark the operator's terminal in the owner's terminal list (best effort). */
async function tagOperatorTerminal(io: Server, grant: VerifiedOperatorGrant, machineId: string, terminalId: string, machineKey: Uint8Array): Promise<void> {
    try {
        const account = await db.account.findUnique({ where: { id: grant.granteeId }, select: { id: true, firstName: true, lastName: true, username: true } });
        const displayName = account ? displayNameOf(account, await identityOf(account.id)) : 'shared';
        const handle = (account?.username ?? 'operator').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'operator';
        await forwardToOwner(io, grant.ownerId, `${machineId}:set-terminal-title`, seal({ terminalId, title: `${displayName.slice(0, 40)} · shared` }, machineKey));
        await forwardToOwner(io, grant.ownerId, `${machineId}:set-terminal-tags`, seal({ terminalId, tags: [`shared-${handle}`] }, machineKey));
    } catch { /* cosmetic */ }
}

// ---------------------------------------------------------------- live stream

const tapChains = new Map<string, Promise<void>>();

/**
 * Called by terminalHandler for every owner-machine `terminal-output` /
 * `terminal-exit` (after the owner's own emit). O(1) miss for the owner's own
 * terminals; for operator terminals it re-keys the frame and unicasts it.
 * Frames of one terminal are processed in arrival order.
 */
export function operatorTerminalTap(ownerId: string, machineId: string, event: 'terminal-output' | 'terminal-exit', frame: { terminalId: string; data?: string; seq?: number; enc?: boolean; exitCode?: number }): void {
    const key = `${machineId}:${frame.terminalId}`;
    const entries = terminalIndex.get(key);
    if (!entries || entries.length === 0) return;
    const previous = tapChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => deliverFrame(ownerId, machineId, event, frame, entries)).catch((error) => {
        log({ module: 'operator', machineId, errorName: errorName(error) }, 'operator tap failed');
    });
    tapChains.set(key, next);
    void next.finally(() => { if (tapChains.get(key) === next) tapChains.delete(key); });
}

async function deliverFrame(ownerId: string, machineId: string, event: 'terminal-output' | 'terminal-exit', frame: { terminalId: string; data?: string; seq?: number; enc?: boolean; exitCode?: number }, entries: IndexEntry[]): Promise<void> {
    for (const entry of entries) {
        if (entry.ownerId !== ownerId) continue;
        const grant = await resolveOperatorGrant(entry.granteeId, entry.sessionId);
        if (!grant || grant.grantId !== entry.grantId) continue;
        const room = `user:${entry.granteeId}:user-scoped`;
        if (event === 'terminal-exit') {
            await operatorTerminalGone(entry, 'exited', frame.exitCode);
            continue;
        }
        if (typeof frame.data !== 'string') continue;
        let plain: unknown = frame.data;
        if (frame.enc) {
            const machineKey = await openOperatorMachineKey(grant, machineId);
            if (!machineKey) continue;
            plain = open(frame.data, machineKey);
            if (typeof plain !== 'string') continue;
        }
        const dek = await openSessionDataKey(await sessionKeyRow(entry.sessionId));
        if (!dek) continue;
        ioRef?.to(room).emit('operator-terminal-output', { sessionId: entry.sessionId, terminalId: frame.terminalId, seq: frame.seq, data: seal(plain, dek) });
    }
}

async function sessionKeyRow(sessionId: string) {
    const row = await db.session.findUnique({ where: { id: sessionId }, select: { id: true, accountId: true, dataEncryptionKey: true } });
    return row ?? { id: sessionId, accountId: '', dataEncryptionKey: null };
}

/**
 * A terminal registered less than this ago may be missing from a push that predates
 * its creation (the row is written before open-terminal): leave it to a later push —
 * the title / tag writes right after the open produce one.
 */
const GONE_GRACE_MS = 10_000;
const operatorKillsInFlight = new Set<string>();

/**
 * An operator terminal ended on the owner's machine: it exited, or it left the
 * machine's terminal list (the owner closed it from their sidebar — the daemon's
 * kill-terminal sends no terminal-exit). Close its registry row so it stops
 * counting toward the per-grant limit, tell the operator's pane, refresh the
 * owner's chip. Only the call that closes the row reports it (B-867c, QA40 P2-4).
 */
async function operatorTerminalGone(entry: IndexEntry, reason: 'exited' | 'closed_on_machine', exitCode?: number): Promise<void> {
    const closed = await db.sessionOperatorTerminal.updateMany({
        where: { grantId: entry.grantId, machineId: entry.machineId, terminalId: entry.terminalId, closedAt: null },
        data: { closedAt: new Date(), closeReason: reason, pendingKill: false },
    });
    if (closed.count === 0) return;
    announceChange();
    ioRef?.to(`user:${entry.granteeId}:user-scoped`).emit('operator-terminal-exit', {
        sessionId: entry.sessionId, terminalId: entry.terminalId, exitCode: Number.isSafeInteger(exitCode) ? exitCode : -1, reason,
    });
    if (reason === 'closed_on_machine') {
        await recordOperatorEvent({ sessionId: entry.sessionId, grantId: entry.grantId, actorAccountId: entry.ownerId, kind: 'terminal.gone', detail: { terminalId: entry.terminalId } });
    }
    void emitOperatorActivity(entry, true);
}

/** Pushed terminal ids in a daemonState, or null when it carries no list this daemon run wrote. */
function pushedTerminalIds(state: unknown): Set<string> | null {
    const s = state as { startedAt?: unknown; webTerminals?: { updatedAt?: unknown; terminals?: unknown } } | null;
    const wt = s?.webTerminals;
    if (!wt || typeof wt.updatedAt !== 'number' || !Array.isArray(wt.terminals)) return null;
    if (typeof s?.startedAt === 'number' && wt.updatedAt < s.startedAt) return null;
    return new Set((wt.terminals as Array<{ id?: unknown }>).map((t) => t?.id).filter((id): id is string => typeof id === 'string'));
}

/**
 * machineUpdateHandler hook: the owner's machine stored a new daemonState. O(index)
 * miss unless an operator terminal is open on that machine; then the list is read
 * with the machine key (reached through the registered row, like teardown).
 */
export async function noteOperatorMachineState(ownerId: string, machineId: string, encryptedState: unknown): Promise<void> {
    const entries: IndexEntry[] = [];
    for (const list of terminalIndex.values()) for (const e of list) if (e.ownerId === ownerId && e.machineId === machineId) entries.push(e);
    if (entries.length === 0) return;
    const row = { grantId: entries[0].grantId, sessionId: entries[0].sessionId, ownerAccountId: ownerId, granteeAccountId: entries[0].granteeId };
    const key = await openOperatorMachineKey(registeredGrant(row), machineId);
    if (!key) return;
    const ids = pushedTerminalIds(open(encryptedState, key));
    if (!ids) return;
    for (const entry of entries) {
        if (ids.has(entry.terminalId) || operatorKillsInFlight.has(`${machineId}:${entry.terminalId}`)) continue;
        if (Date.now() - entry.openedAt < GONE_GRACE_MS) continue;
        await operatorTerminalGone(entry, 'closed_on_machine');
    }
}

/** Operator → owner machine: input / resize / close for a registered terminal. */
async function forwardTerminalEvent(granteeId: string, event: 'terminal-input' | 'terminal-resize' | 'terminal-close', data: Record<string, unknown>, limits: Limits): Promise<void> {
    const { sessionId, terminalId } = data;
    if (!boundedId(sessionId) || !boundedId(terminalId)) return;
    const grant = await resolveOperatorGrant(granteeId, sessionId);
    if (!grant) return;
    const entry = findIndexEntry(granteeId, sessionId, terminalId);
    if (!entry || entry.grantId !== grant.grantId) return;
    const room = `user:${grant.ownerId}:machine:${entry.machineId}`;
    if (event === 'terminal-input') {
        if (typeof data.data !== 'string' || data.data.length > MAX_PARAMS_BYTES) return;
        if (!charge(limits.terminal, [granteeId, grant.ownerId], data.data.length)) return;
        const dek = await openSessionDataKey(await sessionKeyRow(sessionId));
        if (!dek) return;
        const plain = open(data.data, dek);
        if (typeof plain !== 'string') return;
        const machineKey = await openOperatorMachineKey(grant, entry.machineId);
        if (!machineKey) return;
        countInput(grant, plain);
        ioRef?.to(room).emit('terminal-input', { terminalId, data: seal(plain, machineKey), enc: true });
        void emitOperatorActivity(grant, false);
        return;
    }
    if (!charge(limits.terminal, [granteeId], 64)) return;
    if (event === 'terminal-resize') {
        const cols = data.cols; const rows = data.rows;
        const ok = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 10_000;
        if (!ok(cols) || !ok(rows)) return;
        ioRef?.to(room).emit('terminal-resize', { terminalId, cols, rows });
        return;
    }
    ioRef?.to(room).emit('terminal-close', { terminalId });
}

// ---------------------------------------------------------------- socket wiring

/** Grantee side: user-scoped sockets only. Operator traffic never uses the relay. */
export function operatorHandler(userId: string, socket: Socket, connection: { connectionType: string }, limits: Limits): void {
    if (connection.connectionType !== 'user-scoped') return;
    socket.on('operator-rpc', async (data: unknown, callback?: (ack: OperatorRpcAck) => void) => {
        const ack = await handleOperatorRpc(ioRef ?? (socket.nsp.server as Server), userId, data, limits);
        if (typeof callback === 'function') callback(ack);
    });
    for (const [inbound, outbound] of [
        ['operator-terminal-input', 'terminal-input'],
        ['operator-terminal-resize', 'terminal-resize'],
        ['operator-terminal-close', 'terminal-close'],
    ] as const) {
        socket.on(inbound, (data: unknown) => {
            if (!data || typeof data !== 'object') return;
            void forwardTerminalEvent(userId, outbound, data as Record<string, unknown>, limits).catch((error) => {
                log({ module: 'operator', userId, errorName: errorName(error) }, 'operator terminal event failed');
            });
        });
    }
}

// ---------------------------------------------------------------- teardown

const tearingDown = new Set<string>();
const pendingKillsInFlight = new Set<string>();

type TeardownSummary = { killed: number; pending: number; detached: number };

/**
 * End a grant's operator access everywhere: close its registry rows (the tap
 * stops), mark opened terminals pendingKill, invalidate every slot, tell the
 * operator's web — then return. The kills run in `kills`: a slow or offline
 * daemon (kill-terminal waits out the RPC timeout) never holds up the owner's
 * revoke / downgrade request (B-867c); an undelivered kill stays pendingKill
 * and is retried on reconnect and by the sweep. Idempotent.
 */
export async function beginOperatorTeardown(grantId: string, reason: OperatorEndReason, notify?: { sessionId: string; granteeId: string; ownerId: string }): Promise<{ kills: Promise<TeardownSummary> }> {
    if (tearingDown.has(grantId)) return { kills: Promise.resolve({ killed: 0, pending: 0, detached: 0 }) };
    tearingDown.add(grantId);
    try {
        invalidateGrantCache();
        const rows = await db.sessionOperatorTerminal.findMany({ where: { grantId, closedAt: null } });
        // Stop the tap first (closedAt); opened terminals are pendingKill until a kill lands.
        if (rows.length > 0) {
            const closedAt = new Date();
            await db.sessionOperatorTerminal.updateMany({ where: { grantId, closedAt: null, kind: 'opened' }, data: { closedAt, closeReason: reason, pendingKill: true } });
            await db.sessionOperatorTerminal.updateMany({ where: { grantId, closedAt: null }, data: { closedAt, closeReason: reason } });
        }
        announceChange();
        const target = notify ?? (rows[0] ? { sessionId: rows[0].sessionId, granteeId: rows[0].granteeAccountId, ownerId: rows[0].ownerAccountId } : null);
        if (target) {
            ioRef?.to(`user:${target.granteeId}:user-scoped`).emit('operator-revoked', { sessionId: target.sessionId, reason });
            ioRef?.to(`user:${target.ownerId}:user-scoped`).emit('operator-activity', { sessionId: target.sessionId, granteeAccountId: target.granteeId, displayName: null, openTerminals: 0, lastActivityAt: Date.now(), ended: true });
        }
        const kills = (async (): Promise<TeardownSummary> => {
            const summary: TeardownSummary = { killed: 0, pending: 0, detached: 0 };
            for (const row of rows) {
                if (row.kind !== 'opened') { summary.detached++; continue; }
                pendingKillsInFlight.add(row.id);
                try {
                    const killed = ioRef ? await killOnOwnerMachine(ioRef, registeredGrant(row), row.machineId, row.terminalId) : false;
                    if (killed) {
                        summary.killed++;
                        await db.sessionOperatorTerminal.update({ where: { id: row.id }, data: { pendingKill: false } });
                    } else summary.pending++;
                } finally {
                    pendingKillsInFlight.delete(row.id);
                }
            }
            if (target) await recordOperatorEvent({ sessionId: target.sessionId, grantId, actorAccountId: target.ownerId, kind: 'ended', detail: { reason, ...summary } });
            return summary;
        })();
        kills.catch((error) => log({ module: 'operator', grantId, errorName: errorName(error) }, 'operator teardown kills failed'));
        return { kills };
    } finally {
        tearingDown.delete(grantId);
    }
}

/** `beginOperatorTeardown` and wait for the kills (sweep, archive / delete, tests). */
export async function teardownOperatorGrant(grantId: string, reason: OperatorEndReason, notify?: { sessionId: string; granteeId: string; ownerId: string }): Promise<TeardownSummary> {
    return (await beginOperatorTeardown(grantId, reason, notify)).kills;
}

/** Session archived / deleted: end every operator grant on it. */
export async function teardownOperatorSession(sessionId: string, reason: 'archived' | 'deleted'): Promise<void> {
    const grantIds = new Set((await db.sessionOperatorTerminal.findMany({ where: { sessionId, closedAt: null }, select: { grantId: true } })).map((row) => row.grantId));
    const grants = await db.sessionGrant.findMany({ where: { sessionId, operate: true, status: 'active' }, select: { id: true, granteeAccountId: true, session: { select: { accountId: true } } } });
    for (const grant of grants) {
        grantIds.delete(grant.id);
        await teardownOperatorGrant(grant.id, reason, { sessionId, granteeId: grant.granteeAccountId, ownerId: grant.session.accountId });
    }
    for (const grantId of grantIds) await teardownOperatorGrant(grantId, reason);
}

/** Retry kills that could not be delivered (daemon was offline). Called on machine connect and by the sweep. */
export async function retryPendingOperatorKills(ownerId?: string, machineId?: string): Promise<void> {
    if (!ioRef) return;
    const rows = await db.sessionOperatorTerminal.findMany({ where: { pendingKill: true, ...(ownerId ? { ownerAccountId: ownerId } : {}), ...(machineId ? { machineId } : {}) }, take: 50 });
    for (const row of rows) {
        if (pendingKillsInFlight.has(row.id)) continue;
        pendingKillsInFlight.add(row.id);
        void killOnOwnerMachine(ioRef, registeredGrant(row), row.machineId, row.terminalId)
            .then(async (killed) => { if (killed) await db.sessionOperatorTerminal.update({ where: { id: row.id }, data: { pendingKill: false } }); })
            .catch(() => undefined)
            .finally(() => pendingKillsInFlight.delete(row.id));
    }
}

let sweeping = false;
let lastRetention = 0;
let lastPendingRetry = 0;

/**
 * Every 2 s per slot: refresh the terminal index, end terminals whose grant
 * is no longer valid (expiry, a revoke another slot missed, a deleted
 * session), flush input counters, retry pending kills, prune old events.
 */
export async function sweepOperatorTerminals(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
        const entries = await refreshTerminalIndex();
        const byGrant = new Map<string, IndexEntry>();
        for (const entry of entries) byGrant.set(entry.grantId, entry);
        if (byGrant.size > 0) {
            const live = await db.sessionGrant.findMany({
                where: { id: { in: [...byGrant.keys()] }, status: 'active', role: 'driver', operate: true, expiresAt: { gt: new Date() } },
                select: { id: true, session: { select: { archivedAt: true } } },
            });
            const liveIds = new Set(live.filter((grant) => !grant.session.archivedAt).map((grant) => grant.id));
            for (const [grantId, entry] of byGrant) {
                if (liveIds.has(grantId)) continue;
                const grant = await db.sessionGrant.findUnique({ where: { id: grantId }, select: { status: true, operate: true, expiresAt: true } });
                const reason: OperatorEndReason = !grant ? 'deleted'
                    : grant.status === 'revoked' ? 'revoked'
                    : !grant.operate ? 'downgraded'
                    : grant.expiresAt && grant.expiresAt.getTime() <= Date.now() ? 'expired'
                    : 'archived';
                await teardownOperatorGrant(grantId, reason, { sessionId: entry.sessionId, granteeId: entry.granteeId, ownerId: entry.ownerId });
            }
        }
        await flushInputStats();
        if (Date.now() - lastPendingRetry > 30_000) {
            lastPendingRetry = Date.now();
            await retryPendingOperatorKills();
        }
        if (Date.now() - lastRetention > 60 * 60_000) {
            lastRetention = Date.now();
            await db.sessionOperatorEvent.deleteMany({ where: { at: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } });
        }
    } catch (error) {
        log({ module: 'operator', errorName: errorName(error) }, 'operator sweep failed');
    } finally {
        sweeping = false;
    }
}

/** Test seam. */
export async function __flushOperatorInputForTests(): Promise<void> {
    await flushInputStats(true);
}

// ---------------------------------------------------------------- owner views

export async function listOperatorEvents(sessionId: string, granteeAccountId: string, limit: number) {
    const grant = await db.sessionGrant.findUnique({ where: { sessionId_granteeAccountId: { sessionId, granteeAccountId } }, select: { id: true } });
    if (!grant) return [];
    const rows = await db.sessionOperatorEvent.findMany({ where: { grantId: grant.id }, orderBy: { at: 'desc' }, take: Math.max(1, Math.min(limit, 200)) });
    return rows.map((row) => ({ id: row.id, kind: row.kind, actorAccountId: row.actorAccountId, detail: row.detail ?? {}, at: row.at.getTime() }));
}

export async function listOperatorActivity(sessionId: string) {
    const grants = await db.sessionGrant.findMany({
        where: { sessionId, status: 'active', operate: true, expiresAt: { gt: new Date() } },
        select: { id: true, grantee: { select: { id: true, firstName: true, lastName: true, username: true } } },
    });
    const out = [];
    for (const grant of grants) {
        const openTerminals = await db.sessionOperatorTerminal.count({ where: { grantId: grant.id, closedAt: null } });
        const last = await db.sessionOperatorEvent.findFirst({ where: { grantId: grant.id, actorAccountId: grant.grantee.id }, orderBy: { at: 'desc' }, select: { at: true } });
        out.push({
            granteeAccountId: grant.grantee.id,
            displayName: displayNameOf(grant.grantee, await identityOf(grant.grantee.id)),
            openTerminals,
            lastActivityAt: last ? last.at.getTime() : null,
        });
    }
    return out;
}
