/**
 * Cross-machine session operations — the protocol both ends share (B-506,
 * specs/2026-09-cross-machine-session-ops.md).
 *
 * A CLI (or managed session) on machine A cannot read or message a session
 * machine B spawned: the session key lives only in B's ~/.happy/sessions.json
 * and the CLI deliberately holds no account content key (the B-337 path is
 * the one we chose NOT to take). So the operation is proxied: A sends a
 * machine RPC to B's daemon over the same server channel the web uses, B
 * runs the operation with its own keys and returns the plaintext result.
 *
 * Five whitelisted methods, registered by the daemon as plaintext RPC
 * handlers (`RpcHandlerManager.registerPlainHandler`): params and result are
 * JSON strings, not machine-key ciphertext, because the two machines share no
 * secret. The relay sees them — consistent with this fork's server-trusted
 * model. Same-account isolation is structural: the server routes
 * `rpc-call` only into `rpc:${userId}:${method}` rooms.
 *
 * Everything here is pure (validation, limits, audit line, version parsing)
 * so the daemon side and the client side can be unit-tested without a socket.
 */

import type { PeerSender } from './peerMessage'
import type { PeerScope } from './repoIdentity'

/** First CLI whose daemon answers these methods. */
export const REMOTE_SESSION_OPS_MIN_CLI_VERSION = '0.2.157'

export const REMOTE_SESSION_OPS_METHODS = ['sessions.list', 'sessions.read', 'sessions.send', 'sessions.peers', 'sessions.message'] as const
export type RemoteSessionOpsMethod = typeof REMOTE_SESSION_OPS_METHODS[number]

export const REMOTE_OPS_PROTOCOL_VERSION = 1

/** Largest `text` / `body` a remote send may carry (the server caps the whole RPC at 256 KB). */
export const REMOTE_TEXT_MAX_BYTES = 64 * 1024
/** Transcript bytes a remote read returns before it is cut (socket acks above ~1 MB drop the connection). */
export const REMOTE_TRANSCRIPT_MAX_BYTES = 200 * 1024
/** Remote calls one daemon accepts per minute, all callers together. */
export const REMOTE_CALLS_PER_MINUTE = 60
/** Sessions one locate query may ask about. */
export const REMOTE_LOCATE_MAX_IDS = 200

/** Who is asking — self-reported; the server already guarantees the same account. */
export interface RemoteCaller {
    machineId?: string
    host: string
    cli: string
    /** The managed session on the calling machine, when one is speaking (VH_PEER_SESSION_ID). */
    sessionId?: string
}

export interface RemoteOpsRequest<A> {
    v: typeof REMOTE_OPS_PROTOCOL_VERSION
    from: RemoteCaller
    args: A
}

export type RemoteOpsErrorCode = 'disabled' | 'bad_request' | 'no_local_key' | 'not_running' | 'rate_limited' | 'too_large' | 'internal'

export type RemoteOpsResponse<T> =
    | { ok: true; result: T }
    | { ok: false; error: { code: RemoteOpsErrorCode; message: string } }

export interface RemoteListArgs {
    /** Locate: only report these ids (those this machine holds a key for). */
    ids?: string[]
    /** Account-wide rows this machine can decrypt (fresh titles / pending) instead of the local listing. */
    all?: boolean
    tag?: string
    limit?: number
}

export interface RemoteReadArgs {
    sessionId: string
    limit?: number
    full?: boolean
}

export interface RemoteSendArgs {
    sessionId: string
    text: string
    resume?: boolean
    /** null = machine default. */
    model?: string | null
    sentFrom?: string
}

export interface RemotePeersArgs {
    scope?: PeerScope
    /** Directory on the TARGET machine the scope is computed from; absent = scope `machine`. */
    cwd?: string
}

export interface RemoteMessageArgs {
    to: string
    body: string
    replyTo?: string
    /** The sender as the target should print it (title / cwd / agent of the calling session). */
    from: PeerSender
}

export type RemoteArgsOf<M extends RemoteSessionOpsMethod> =
    M extends 'sessions.list' ? RemoteListArgs
    : M extends 'sessions.read' ? RemoteReadArgs
    : M extends 'sessions.send' ? RemoteSendArgs
    : M extends 'sessions.peers' ? RemotePeersArgs
    : RemoteMessageArgs

export function isRemoteSessionOpsMethod(value: unknown): value is RemoteSessionOpsMethod {
    return typeof value === 'string' && (REMOTE_SESSION_OPS_METHODS as readonly string[]).includes(value)
}

export interface RemoteOpsFailure { ok: false; error: { code: RemoteOpsErrorCode; message: string } }

export function remoteError(code: RemoteOpsErrorCode, message: string): RemoteOpsFailure {
    return { ok: false, error: { code, message } }
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const PEER_SCOPES: readonly string[] = ['repo', 'cwd', 'machine']

function isSessionId(value: unknown): value is string {
    return typeof value === 'string' && SESSION_ID_RE.test(value)
}

function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, 'utf8')
}

function sanitizeSender(raw: unknown): PeerSender | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.sessionId !== 'string' || r.sessionId.length === 0 || r.sessionId.length > 128) return null
    const optional = (key: 'title' | 'flavor' | 'cwd' | 'machine', max: number) =>
        typeof r[key] === 'string' && (r[key] as string).length > 0 ? { [key]: (r[key] as string).slice(0, max) } : {}
    return {
        sessionId: r.sessionId,
        ...optional('title', 200),
        ...optional('flavor', 32),
        ...optional('cwd', 1024),
        ...optional('machine', 128),
    } as PeerSender
}

/**
 * Validate one incoming request for `method`. Pure. `enabled` is the target
 * machine's `remoteSessionOps` setting; a disabled machine still answers, so
 * the caller sees "disabled" rather than a 15 s "not available" wait.
 */
export function guardRemoteSessionOpsRequest<M extends RemoteSessionOpsMethod>(
    method: M,
    raw: unknown,
    options: { enabled: boolean },
): { ok: true; request: RemoteOpsRequest<RemoteArgsOf<M>> } | { ok: false; error: { code: RemoteOpsErrorCode; message: string } } {
    if (!options.enabled) {
        return remoteError('disabled', 'Remote session operations are turned off on this machine (settings.json remoteSessionOps = "off")')
    }
    if (!raw || typeof raw !== 'object') return remoteError('bad_request', 'Request must be an object')
    const r = raw as Record<string, unknown>
    if (r.v !== REMOTE_OPS_PROTOCOL_VERSION) return remoteError('bad_request', `Unsupported protocol version ${String(r.v)} (this daemon speaks v${REMOTE_OPS_PROTOCOL_VERSION})`)
    const from = r.from as Record<string, unknown> | undefined
    if (!from || typeof from !== 'object' || typeof from.host !== 'string' || from.host.length === 0 || typeof from.cli !== 'string') {
        return remoteError('bad_request', 'from.host and from.cli are required')
    }
    const caller: RemoteCaller = {
        host: from.host.slice(0, 128),
        cli: from.cli.slice(0, 32),
        ...(typeof from.machineId === 'string' && from.machineId.length > 0 ? { machineId: from.machineId.slice(0, 128) } : {}),
        ...(isSessionId(from.sessionId) ? { sessionId: from.sessionId } : {}),
    }
    const args = (r.args && typeof r.args === 'object' ? r.args : {}) as Record<string, unknown>
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 1 ? Math.floor(args.limit) : undefined

    let clean: unknown
    switch (method) {
        case 'sessions.list': {
            if (args.ids !== undefined) {
                if (!Array.isArray(args.ids) || !args.ids.every(isSessionId)) return remoteError('bad_request', 'ids must be an array of session ids')
                if (args.ids.length > REMOTE_LOCATE_MAX_IDS) return remoteError('too_large', `ids: at most ${REMOTE_LOCATE_MAX_IDS} per call`)
            }
            const out: RemoteListArgs = {
                ...(args.ids !== undefined ? { ids: args.ids as string[] } : {}),
                ...(args.all === true ? { all: true } : {}),
                ...(typeof args.tag === 'string' && args.tag.length > 0 ? { tag: args.tag.slice(0, 128) } : {}),
                ...(limit !== undefined ? { limit } : {}),
            }
            clean = out
            break
        }
        case 'sessions.read': {
            if (!isSessionId(args.sessionId)) return remoteError('bad_request', 'sessionId is required')
            const out: RemoteReadArgs = { sessionId: args.sessionId, ...(limit !== undefined ? { limit } : {}), ...(args.full === true ? { full: true } : {}) }
            clean = out
            break
        }
        case 'sessions.send': {
            if (!isSessionId(args.sessionId)) return remoteError('bad_request', 'sessionId is required')
            if (typeof args.text !== 'string' || args.text.trim().length === 0) return remoteError('bad_request', 'text must be non-empty')
            if (utf8Bytes(args.text) > REMOTE_TEXT_MAX_BYTES) return remoteError('too_large', `text exceeds ${REMOTE_TEXT_MAX_BYTES} bytes`)
            const out: RemoteSendArgs = {
                sessionId: args.sessionId,
                text: args.text,
                ...(args.resume === true ? { resume: true } : {}),
                ...(args.model === null || typeof args.model === 'string' ? { model: args.model as string | null } : {}),
                ...(typeof args.sentFrom === 'string' && args.sentFrom.length > 0 ? { sentFrom: args.sentFrom.slice(0, 64) } : {}),
            }
            clean = out
            break
        }
        case 'sessions.peers': {
            if (args.scope !== undefined && !PEER_SCOPES.includes(args.scope as string)) return remoteError('bad_request', `scope must be one of ${PEER_SCOPES.join(', ')}`)
            const out: RemotePeersArgs = {
                ...(args.scope !== undefined ? { scope: args.scope as PeerScope } : {}),
                ...(typeof args.cwd === 'string' && args.cwd.length > 0 ? { cwd: args.cwd.slice(0, 4096) } : {}),
            }
            clean = out
            break
        }
        case 'sessions.message': {
            if (!isSessionId(args.to)) return remoteError('bad_request', 'to is required')
            if (typeof args.body !== 'string' || args.body.trim().length === 0) return remoteError('bad_request', 'body must be non-empty')
            if (utf8Bytes(args.body) > REMOTE_TEXT_MAX_BYTES) return remoteError('too_large', `body exceeds ${REMOTE_TEXT_MAX_BYTES} bytes`)
            const sender = sanitizeSender(args.from)
            if (!sender) return remoteError('bad_request', 'from.sessionId (the sender) is required')
            const out: RemoteMessageArgs = {
                to: args.to,
                body: args.body,
                ...(typeof args.replyTo === 'string' && args.replyTo.length > 0 ? { replyTo: args.replyTo.slice(0, 64) } : {}),
                from: { ...sender, machine: sender.machine ?? caller.host },
            }
            clean = out
            break
        }
    }
    return { ok: true, request: { v: REMOTE_OPS_PROTOCOL_VERSION, from: caller, args: clean as RemoteArgsOf<M> } }
}

/** Fixed-window-free token bucket for the per-daemon remote call budget. */
export class RemoteCallBudget {
    private tokens: number
    private lastRefill: number

    constructor(readonly perMinute: number = REMOTE_CALLS_PER_MINUTE, private readonly now: () => number = Date.now) {
        this.tokens = perMinute
        this.lastRefill = now()
    }

    /** Take one token; false = over budget (with ms until the next token). */
    take(): { ok: true } | { ok: false; retryAfterMs: number } {
        if (this.perMinute <= 0) return { ok: true }
        const t = this.now()
        const refill = ((t - this.lastRefill) / 60_000) * this.perMinute
        if (refill > 0) {
            this.tokens = Math.min(this.perMinute, this.tokens + refill)
            this.lastRefill = t
        }
        if (this.tokens >= 1) {
            this.tokens -= 1
            return { ok: true }
        }
        return { ok: false, retryAfterMs: Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000) }
    }
}

/** One audit line per remote call — written to the daemon log on the target machine. */
export function formatRemoteAuditLine(input: {
    method: string
    from: RemoteCaller | null
    sessionId?: string
    outcome: 'ok' | RemoteOpsErrorCode
    durationMs: number
}): string {
    const from = input.from
    return `[REMOTE SESSION OPS] ${input.method} from machine=${from?.machineId ?? '?'} host=${from?.host ?? '?'} cli=${from?.cli ?? '?'} session=${from?.sessionId ?? '-'} target=${input.sessionId ?? '-'} → ${input.outcome} (${Math.max(0, Math.round(input.durationMs))}ms)`
}

/** Cut a transcript so the whole JSON result stays under the ack budget; marks the cut. */
export function capRemoteTranscript(transcript: string, maxBytes: number = REMOTE_TRANSCRIPT_MAX_BYTES): { transcript: string; truncated: boolean } {
    if (utf8Bytes(transcript) <= maxBytes) return { transcript, truncated: false }
    // Keep the TAIL: the newest messages are what a remote reader wants.
    const buffer = Buffer.from(transcript, 'utf8')
    const marker = '… [truncated by the remote machine: transcript exceeded the RPC budget; use --limit] …\n'
    const tail = buffer.subarray(buffer.length - (maxBytes - Buffer.byteLength(marker))).toString('utf8')
    return { transcript: marker + tail.replace(/^�+/, ''), truncated: true }
}

/** `cli-daemon/0.2.155` (the server's plaintext `lastHappyClient`) → `0.2.155`; null when unparseable. */
export function parseHappyClientVersion(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/** Numeric semver compare on the three leading components; anything else compares as 0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

export function supportsRemoteSessionOps(cliVersion: string | null | undefined): boolean | null {
    if (!cliVersion) return null
    return compareVersions(cliVersion, REMOTE_SESSION_OPS_MIN_CLI_VERSION) >= 0
}
