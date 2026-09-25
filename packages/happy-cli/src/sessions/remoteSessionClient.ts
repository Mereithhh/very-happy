/**
 * Calling side of cross-machine session ops (B-506). Given a session this
 * machine holds no key for, find the account machine that does and ask its
 * daemon to read / send / message on our behalf — over one short-lived
 * user-scoped socket, the same `rpc-call` the web uses.
 *
 * The CLI never learns a key: the target daemon does the crypto and returns
 * plaintext (see `remoteSessionOps.ts` for the protocol and why it is
 * plaintext to the relay).
 *
 * Failure classes a caller can act on (`RemoteSessionOpsError.code`):
 *   offline      the machine is registered but its daemon is not connected
 *   too_old      its daemon reports a CLI older than the first one that
 *                answers these RPCs (only known with a server that returns
 *                `lastHappyClient`)
 *   unreachable  the server could not deliver the RPC (daemon offline or
 *                restarting, or a CLI too old for the server to tell)
 *   not_located  no online machine holds the session
 *   <daemon code> the target refused (`disabled`, `no_local_key`, …)
 *
 * All I/O is injectable (`RemoteClientDeps`) for unit tests.
 */

import axios from 'axios'
import { hostname } from 'node:os'
import { configuration } from '@/configuration'
import { readCredentialsForConfiguredRelay, readSettings } from '@/persistence'
import { openUserScopedSocket, type RpcCallAck, type UserRpcTransport } from '@/api/userSocket'
import type { DeliveryResult } from '@/commands/sessionDelivery'
import type { AccountSessionSummary } from './sessionOps'
import type { PeerListing, SendPeerMessageResult } from './peerTools'
import type { PeerSender } from './peerMessage'
import type { PeerScope } from './repoIdentity'
import type { RemoteListResult, RemoteReadResult } from '@/daemon/remoteSessionOps'
import {
    parseHappyClientVersion,
    REMOTE_OPS_PROTOCOL_VERSION,
    REMOTE_SESSION_OPS_MIN_CLI_VERSION,
    supportsRemoteSessionOps,
    type RemoteArgsOf,
    type RemoteCaller,
    type RemoteOpsErrorCode,
    type RemoteOpsResponse,
    type RemoteSessionOpsMethod,
} from './remoteSessionOps'

const REMOTE_CLIENT_TAG = 'session-ops'
/** The server's own `rpc-call` deadline; a longer client wait is pointless. */
export const REMOTE_RPC_TIMEOUT_MS = 30_000
/** Machines a locate sweep asks before giving up. */
export const REMOTE_LOCATE_MAX_MACHINES = 8

export interface AccountMachine {
    id: string
    active: boolean
    activeAt?: number
    /** From the server's plaintext `lastHappyClient` (`cli-daemon/0.2.155`); null when the server is older or the daemon never reported. */
    cliVersion: string | null
}

export type RemoteClientErrorCode = 'offline' | 'too_old' | 'unreachable' | 'not_located' | 'unknown_machine' | RemoteOpsErrorCode

export class RemoteSessionOpsError extends Error {
    constructor(readonly code: RemoteClientErrorCode, message: string, readonly machineId?: string) {
        super(message)
    }
}

export interface RemoteTransport {
    call(method: string, paramsJson: string): Promise<RpcCallAck>
    close(): void
}

export interface RemoteClientDeps {
    listMachines: () => Promise<AccountMachine[]>
    selfMachineId: () => Promise<string | undefined>
    openTransport: () => Promise<RemoteTransport>
    caller: () => Promise<RemoteCaller>
    sleep: (ms: number) => Promise<void>
    now: () => number
}

async function bearerToken(): Promise<string> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) throw new Error('CLI is not authenticated (no ~/.happy/access.key)')
    return credentials.token
}

/** `GET /v1/machines` narrowed to what routing needs. */
export async function listAccountMachines(): Promise<AccountMachine[]> {
    const token = await bearerToken()
    const response = await axios.get(`${configuration.serverUrl}/v1/machines`, {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Happy-Client': `${REMOTE_CLIENT_TAG}/${configuration.currentCliVersion}` },
        timeout: 15_000,
    })
    const rows: unknown[] = Array.isArray(response.data) ? response.data : []
    return rows
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string')
        .map((row) => ({
            id: row.id as string,
            active: row.active === true,
            ...(typeof row.activeAt === 'number' ? { activeAt: row.activeAt } : {}),
            cliVersion: parseHappyClientVersion(row.lastHappyClient),
        }))
}

/** Who this CLI is, for the target's audit line and the message header. */
export async function callerIdentity(env: NodeJS.ProcessEnv = process.env): Promise<RemoteCaller> {
    const settings = await readSettings().catch(() => null)
    const sessionId = env.VH_PEER_SESSION_ID
    return {
        ...(settings?.machineId ? { machineId: settings.machineId } : {}),
        host: hostname(),
        cli: configuration.currentCliVersion,
        ...(sessionId && /^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ? { sessionId } : {}),
    }
}

const defaultDeps: RemoteClientDeps = {
    listMachines: listAccountMachines,
    selfMachineId: async () => (await readSettings().catch(() => null))?.machineId,
    openTransport: async () => {
        const socket: UserRpcTransport = await openUserScopedSocket(await bearerToken())
        return {
            call: (method, paramsJson) => socket.rpcCall({ method, params: paramsJson }, REMOTE_RPC_TIMEOUT_MS),
            close: () => socket.close(),
        }
    },
    caller: () => callerIdentity(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
}

export function withDefaults(deps: Partial<RemoteClientDeps>): RemoteClientDeps {
    return { ...defaultDeps, ...deps }
}

/**
 * Pure: order the account's machines for a locate sweep. Self is skipped
 * (local keys were already checked), offline machines are skipped (no
 * daemon = no plaintext source), machines whose daemon is known to predate
 * these RPCs are skipped; the rest newest-active first.
 */
export function pickRemoteCandidates(machines: readonly AccountMachine[], selfId: string | undefined): {
    candidates: AccountMachine[]
    skipped: Array<{ machine: AccountMachine; reason: 'self' | 'offline' | 'too_old' }>
} {
    const candidates: AccountMachine[] = []
    const skipped: Array<{ machine: AccountMachine; reason: 'self' | 'offline' | 'too_old' }> = []
    for (const machine of machines) {
        if (selfId && machine.id === selfId) { skipped.push({ machine, reason: 'self' }); continue }
        if (!machine.active) { skipped.push({ machine, reason: 'offline' }); continue }
        if (supportsRemoteSessionOps(machine.cliVersion) === false) { skipped.push({ machine, reason: 'too_old' }); continue }
        candidates.push(machine)
    }
    candidates.sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0))
    return { candidates: candidates.slice(0, REMOTE_LOCATE_MAX_MACHINES), skipped }
}

function describeAge(activeAt: number | undefined, now: number): string {
    if (activeAt === undefined) return 'never seen'
    const minutes = Math.round((now - activeAt) / 60_000)
    if (minutes < 2) return 'seen just now'
    if (minutes < 120) return `last seen ${minutes}m ago`
    if (minutes < 48 * 60) return `last seen ${Math.round(minutes / 60)}h ago`
    return `last seen ${Math.round(minutes / 1440)}d ago`
}

/** Validate an explicitly named machine before any RPC: it must exist, be online and (when known) be new enough. */
export async function resolveExplicitMachine(machineId: string, deps: RemoteClientDeps): Promise<AccountMachine> {
    const machines = await deps.listMachines()
    const machine = machines.find((row) => row.id === machineId)
    if (!machine) throw new RemoteSessionOpsError('unknown_machine', `Machine ${machineId} is not on this account`, machineId)
    if (!machine.active) throw new RemoteSessionOpsError('offline', `Machine ${machineId} is offline (${describeAge(machine.activeAt, deps.now())}); its sessions cannot be reached until its daemon reconnects`, machineId)
    if (supportsRemoteSessionOps(machine.cliVersion) === false) {
        throw new RemoteSessionOpsError('too_old', `Machine ${machineId} runs CLI ${machine.cliVersion}; cross-machine session operations need ≥ ${REMOTE_SESSION_OPS_MIN_CLI_VERSION} on the target`, machineId)
    }
    return machine
}

/** One RPC to one machine. Maps the server's ack and the daemon's envelope into results / typed errors. */
export async function callRemoteSessionOp<M extends RemoteSessionOpsMethod, T = unknown>(
    transport: RemoteTransport,
    machineId: string,
    method: M,
    args: RemoteArgsOf<M>,
    from: RemoteCaller,
): Promise<T> {
    const params = JSON.stringify({ v: REMOTE_OPS_PROTOCOL_VERSION, from, args })
    let ack: RpcCallAck
    try {
        ack = await transport.call(`${machineId}:${method}`, params)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new RemoteSessionOpsError('unreachable', `Machine ${machineId} did not answer ${method} (${reason})`, machineId)
    }
    if (!ack?.ok) {
        const reason = ack?.error ?? 'no ack'
        if (/not available/i.test(reason)) {
            throw new RemoteSessionOpsError('unreachable', `Machine ${machineId} did not answer ${method}: its daemon is offline, restarting, or runs a CLI older than ${REMOTE_SESSION_OPS_MIN_CLI_VERSION}`, machineId)
        }
        throw new RemoteSessionOpsError('unreachable', `Machine ${machineId}: ${reason}`, machineId)
    }
    let envelope: RemoteOpsResponse<T> | { error?: string }
    try {
        envelope = typeof ack.result === 'string' ? JSON.parse(ack.result) : (ack.result as unknown as RemoteOpsResponse<T>)
    } catch {
        throw new RemoteSessionOpsError('unreachable', `Machine ${machineId} returned an unreadable ${method} response`, machineId)
    }
    if (!envelope || typeof envelope !== 'object') throw new RemoteSessionOpsError('unreachable', `Machine ${machineId} returned an empty ${method} response`, machineId)
    if ('ok' in envelope) {
        if (envelope.ok) return envelope.result
        throw new RemoteSessionOpsError(envelope.error.code, `Machine ${machineId}: ${envelope.error.message}`, machineId)
    }
    // `{ error }` = the plain handler threw before producing an envelope.
    throw new RemoteSessionOpsError('internal', `Machine ${machineId}: ${(envelope as { error?: string }).error ?? 'remote handler failed'}`, machineId)
}

export interface LocatedSession {
    machine: AccountMachine
    host: string
}

/**
 * Find which online machine holds `sessionId`. With `machineId` the answer is
 * that machine (validated, no sweep). Otherwise every candidate is asked
 * `sessions.list { ids }` in turn until one reports it.
 */
export async function locateRemoteSession(
    transport: RemoteTransport,
    sessionId: string,
    options: { machineId?: string },
    deps: RemoteClientDeps,
): Promise<LocatedSession> {
    const from = await deps.caller()
    if (options.machineId) {
        const machine = await resolveExplicitMachine(options.machineId, deps)
        const listing = await callRemoteSessionOp<'sessions.list', RemoteListResult>(transport, machine.id, 'sessions.list', { ids: [sessionId] }, from)
        if (!listing.sessions.some((row) => row.id === sessionId)) {
            throw new RemoteSessionOpsError('no_local_key', `Machine ${machine.id} (${listing.host}) has no key for session ${sessionId}: it was not spawned there (or is older than 14 days)`, machine.id)
        }
        return { machine, host: listing.host }
    }
    const { candidates, skipped } = pickRemoteCandidates(await deps.listMachines(), await deps.selfMachineId())
    const failures: string[] = []
    for (const machine of candidates) {
        try {
            const listing = await callRemoteSessionOp<'sessions.list', RemoteListResult>(transport, machine.id, 'sessions.list', { ids: [sessionId] }, from)
            if (listing.sessions.some((row) => row.id === sessionId)) return { machine, host: listing.host }
            failures.push(`${listing.host || machine.id}: not there`)
        } catch (error) {
            failures.push(`${machine.id}: ${error instanceof RemoteSessionOpsError ? error.code : (error instanceof Error ? error.message : String(error))}`)
        }
    }
    const skippedText = skipped.filter((s) => s.reason !== 'self').map((s) => `${s.machine.id}: ${s.reason}`)
    const detail = [...failures, ...skippedText]
    throw new RemoteSessionOpsError(
        'not_located',
        `Session ${sessionId} is not on this machine and no online machine of this account reports it${detail.length ? ` (${detail.join('; ')})` : ' (no other machines are online)'}. Pass --machine <id> to name one, or bring its machine online.`,
    )
}

/** Open a transport, run `fn`, always close it. */
export async function withRemoteTransport<T>(deps: RemoteClientDeps, fn: (transport: RemoteTransport) => Promise<T>): Promise<T> {
    const transport = await deps.openTransport()
    try {
        return await fn(transport)
    } finally {
        try { transport.close() } catch { /* already closed */ }
    }
}

// ── high-level operations (what the commands / tools call) ──────────────────

export interface RemoteReadOptions { machineId?: string; limit?: number; full?: boolean }

export async function readRemoteTranscript(sessionId: string, options: RemoteReadOptions = {}, overrides: Partial<RemoteClientDeps> = {}): Promise<RemoteReadResult> {
    const deps = withDefaults(overrides)
    return withRemoteTransport(deps, async (transport) => {
        const located = await locateRemoteSession(transport, sessionId, { machineId: options.machineId }, deps)
        return callRemoteSessionOp<'sessions.read', RemoteReadResult>(transport, located.machine.id, 'sessions.read', {
            sessionId, ...(options.limit !== undefined ? { limit: options.limit } : {}), ...(options.full ? { full: true } : {}),
        }, await deps.caller())
    })
}

/** `sessions read --wait` against a remote machine: poll `sessions.read` until the latest turn ended. Returns the final read. */
export async function waitForRemoteTurnEnd(
    sessionId: string,
    options: RemoteReadOptions & { timeoutMs: number; pollMs?: number },
    overrides: Partial<RemoteClientDeps> = {},
): Promise<{ read: RemoteReadResult; timedOut: boolean }> {
    const deps = withDefaults(overrides)
    const pollMs = options.pollMs ?? 3_000
    return withRemoteTransport(deps, async (transport) => {
        const located = await locateRemoteSession(transport, sessionId, { machineId: options.machineId }, deps)
        const from = await deps.caller()
        const deadline = deps.now() + options.timeoutMs
        const args = { sessionId, ...(options.limit !== undefined ? { limit: options.limit } : {}), ...(options.full ? { full: true } : {}) }
        while (true) {
            const read = await callRemoteSessionOp<'sessions.read', RemoteReadResult>(transport, located.machine.id, 'sessions.read', args, from)
            if (read.turn.ended) return { read, timedOut: false }
            if (deps.now() + pollMs > deadline) return { read, timedOut: true }
            await deps.sleep(pollMs)
        }
    })
}

export interface RemoteDeliveryResult extends DeliveryResult { machine: { id: string; host: string } }

export async function sendRemoteMessage(
    sessionId: string,
    text: string,
    options: { machineId?: string; resume?: boolean; model?: string | null; sentFrom?: string } = {},
    overrides: Partial<RemoteClientDeps> = {},
): Promise<RemoteDeliveryResult> {
    const deps = withDefaults(overrides)
    return withRemoteTransport(deps, async (transport) => {
        const located = await locateRemoteSession(transport, sessionId, { machineId: options.machineId }, deps)
        const result = await callRemoteSessionOp<'sessions.send', DeliveryResult>(transport, located.machine.id, 'sessions.send', {
            sessionId, text,
            ...(options.resume ? { resume: true } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.sentFrom !== undefined ? { sentFrom: options.sentFrom } : {}),
        }, await deps.caller())
        return { ...result, machine: { id: located.machine.id, host: located.host } }
    })
}

export interface RemotePeerMessageResult extends SendPeerMessageResult { machine: { id: string; host: string } }

/** `session_message` / `sessions message` to a session on another machine: the target daemon formats and delivers with OUR identity in the header. */
export async function sendRemotePeerMessage(
    args: { to: string; body: string; replyTo?: string; from: PeerSender },
    options: { machineId?: string } = {},
    overrides: Partial<RemoteClientDeps> = {},
): Promise<RemotePeerMessageResult> {
    const deps = withDefaults(overrides)
    return withRemoteTransport(deps, async (transport) => {
        const located = await locateRemoteSession(transport, args.to, { machineId: options.machineId }, deps)
        const caller = await deps.caller()
        const result = await callRemoteSessionOp<'sessions.message', SendPeerMessageResult>(transport, located.machine.id, 'sessions.message', {
            to: args.to, body: args.body, ...(args.replyTo ? { replyTo: args.replyTo } : {}),
            from: { ...args.from, machine: args.from.machine ?? caller.host },
        }, caller)
        return { ...result, machine: { id: located.machine.id, host: located.host } }
    })
}

export interface RemotePeerListing extends PeerListing { machineId: string; host: string }

export async function listRemotePeers(machineId: string, options: { scope?: PeerScope; cwd?: string } = {}, overrides: Partial<RemoteClientDeps> = {}): Promise<RemotePeerListing> {
    const deps = withDefaults(overrides)
    return withRemoteTransport(deps, async (transport) => {
        const machine = await resolveExplicitMachine(machineId, deps)
        return callRemoteSessionOp<'sessions.peers', RemotePeerListing>(transport, machine.id, 'sessions.peers', {
            ...(options.scope ? { scope: options.scope } : {}), ...(options.cwd ? { cwd: options.cwd } : {}),
        }, await deps.caller())
    })
}

export async function listRemoteSessions(machineId: string, options: { tag?: string; limit?: number } = {}, overrides: Partial<RemoteClientDeps> = {}): Promise<RemoteListResult> {
    const deps = withDefaults(overrides)
    return withRemoteTransport(deps, async (transport) => {
        const machine = await resolveExplicitMachine(machineId, deps)
        return callRemoteSessionOp<'sessions.list', RemoteListResult>(transport, machine.id, 'sessions.list', {
            ...(options.tag ? { tag: options.tag } : {}), ...(options.limit !== undefined ? { limit: options.limit } : {}),
        }, await deps.caller())
    })
}

/** What `sessions list --all` learned while filling foreign rows. */
export interface ForeignRowFill {
    rows: AccountSessionSummary[]
    /** Machines asked, with the outcome. */
    asked: Array<{ machineId: string; host?: string; filled: number; error?: string }>
    skipped: Array<{ machineId: string; reason: 'offline' | 'too_old' }>
}

/**
 * B-506: `sessions list --all` — rows this machine could not decrypt are
 * offered to every candidate machine (`sessions.list { ids, all: true }`);
 * a machine that holds the key answers with its own decrypted summary, which
 * replaces the bare row (`via` = that machine, `readable: true`).
 * `decryptable` keeps meaning "this machine's own key".
 */
export async function fillForeignAccountRows(rows: AccountSessionSummary[], overrides: Partial<RemoteClientDeps> = {}): Promise<ForeignRowFill> {
    const deps = withDefaults(overrides)
    const pending = new Set(rows.filter((row) => !row.decryptable).map((row) => row.id))
    const asked: ForeignRowFill['asked'] = []
    if (pending.size === 0) return { rows, asked, skipped: [] }
    const { candidates, skipped } = pickRemoteCandidates(await deps.listMachines(), await deps.selfMachineId())
    const filled = new Map<string, AccountSessionSummary>()
    if (candidates.length > 0) {
        await withRemoteTransport(deps, async (transport) => {
            const from = await deps.caller()
            for (const machine of candidates) {
                if (pending.size === 0) break
                try {
                    const listing = await callRemoteSessionOp<'sessions.list', RemoteListResult>(transport, machine.id, 'sessions.list', { ids: [...pending], all: true }, from)
                    let count = 0
                    for (const row of listing.sessions as AccountSessionSummary[]) {
                        if (!pending.has(row.id)) continue
                        pending.delete(row.id)
                        count++
                        filled.set(row.id, { ...row, decryptable: false, readable: true, via: machine.id, machine: { id: machine.id, host: listing.host } })
                    }
                    asked.push({ machineId: machine.id, host: listing.host, filled: count })
                } catch (error) {
                    asked.push({ machineId: machine.id, filled: 0, error: error instanceof Error ? error.message : String(error) })
                }
            }
        })
    }
    return {
        rows: rows.map((row) => filled.get(row.id) ?? row),
        asked,
        skipped: skipped.filter((s): s is { machine: AccountMachine; reason: 'offline' | 'too_old' } => s.reason !== 'self').map((s) => ({ machineId: s.machine.id, reason: s.reason })),
    }
}
