/**
 * Target side of cross-machine session ops (B-506): the daemon answers the
 * five `sessions.*` plaintext RPCs with THIS machine's keys and returns the
 * plaintext result to a CLI on another machine of the same account.
 *
 * Every call goes through the same funnel: setting check → shape/size guard
 * (`guardRemoteSessionOpsRequest`, pure) → per-daemon budget → the local
 * operation the CLI would have run here itself → one audit line in the daemon
 * log. Handlers never throw to the RPC layer; failures come back as
 * `{ ok: false, error: { code, message } }` without stack traces.
 *
 * The operations are the SAME functions `very-happy sessions …` uses locally
 * (`sessionOps`, `sessionDelivery`, `peerTools`), injected so this module is
 * unit-tested without a daemon, a server or a key file.
 */

import { hostname } from 'node:os'
import { logger } from '@/ui/logger'
import { sessionWebUrl } from '@/commands/sessionMessage'
import { readSettings, readPersistedSessions, type PersistedSession } from '@/persistence'
import {
    listAccountSessions,
    listSessions,
    readSessionTranscript,
    MAX_READ_LIMIT,
    type AccountSessionSummary,
    type SessionSummary,
    type SessionTranscript,
} from '@/sessions/sessionOps'
import { deliverToSession, type DeliveryResult } from '@/commands/sessionDelivery'
import { listPeerSessions, sendPeerMessage, type PeerListing, type PeerToolContext, type SendPeerMessageResult } from '@/sessions/peerTools'
import { CLI_PEER_SENDER_ID } from '@/sessions/peerMessage'
import {
    capRemoteTranscript,
    formatRemoteAuditLine,
    guardRemoteSessionOpsRequest,
    RemoteCallBudget,
    remoteError,
    REMOTE_SESSION_OPS_METHODS,
    type RemoteArgsOf,
    type RemoteCaller,
    type RemoteOpsErrorCode,
    type RemoteOpsResponse,
    type RemoteSessionOpsMethod,
} from '@/sessions/remoteSessionOps'

/** `sessions.list` result: which machine answered plus its rows. */
export interface RemoteListResult {
    machineId: string
    host: string
    sessions: Array<SessionSummary | AccountSessionSummary>
}

export interface RemoteReadResult extends SessionTranscript {
    machineId: string
    host: string
    /** The transcript was cut to fit the RPC budget. */
    truncated?: boolean
}

export interface RemoteSessionOpsDeps {
    machineId: string
    host: string
    enabled: () => Promise<boolean>
    readPersisted: () => Record<string, PersistedSession>
    listLocal: (options: { tag?: string; recentLimit?: number }) => Promise<SessionSummary[]>
    listAccount: (options: { tag?: string; recentLimit?: number; includeArchived?: boolean }) => Promise<AccountSessionSummary[]>
    readTranscript: (sessionId: string, limit: number, options: { full?: boolean }) => Promise<SessionTranscript>
    deliver: (sessionId: string, persisted: PersistedSession, text: string, client: string, options: { resume?: boolean; model?: string | null; sentFrom?: string }) => Promise<DeliveryResult>
    listPeers: (context: PeerToolContext, scope: 'repo' | 'cwd' | 'machine') => Promise<PeerListing>
    sendPeer: (context: PeerToolContext, args: { to: string; body: string; replyTo?: string }) => Promise<SendPeerMessageResult>
    log: (line: string) => void
    now: () => number
    budget?: RemoteCallBudget
}

export type RemoteSessionOpsHandlers = Record<RemoteSessionOpsMethod, (params: unknown) => Promise<RemoteOpsResponse<unknown>>>

const REMOTE_CLIENT_TAG = 'cli-send-remote'

function defaultDeps(machineId: string): RemoteSessionOpsDeps {
    return {
        machineId,
        host: hostname(),
        enabled: async () => (await readSettings()).remoteSessionOps !== 'off',
        readPersisted: readPersistedSessions,
        listLocal: (options) => listSessions(options),
        listAccount: (options) => listAccountSessions(options),
        readTranscript: (sessionId, limit, options) => readSessionTranscript(sessionId, limit, options),
        deliver: (sessionId, persisted, text, client, options) => deliverToSession(sessionId, persisted, text, client, options),
        listPeers: (context, scope) => listPeerSessions(context, scope),
        sendPeer: (context, args) => sendPeerMessage(context, args),
        log: (line) => logger.info(line),
        now: () => Date.now(),
    }
}

/** Build the five handlers. `machineId` is this daemon's; deps default to the real operations. */
export function createRemoteSessionOpsHandlers(machineId: string, overrides: Partial<RemoteSessionOpsDeps> = {}): RemoteSessionOpsHandlers {
    const deps: RemoteSessionOpsDeps = { ...defaultDeps(machineId), ...overrides }
    const budget = deps.budget ?? new RemoteCallBudget(undefined, deps.now)

    const run = <M extends RemoteSessionOpsMethod>(
        method: M,
        op: (args: RemoteArgsOf<M>, from: RemoteCaller) => Promise<unknown>,
        targetOf: (args: RemoteArgsOf<M>) => string | undefined,
    ) => async (params: unknown): Promise<RemoteOpsResponse<unknown>> => {
        const started = deps.now()
        let from: RemoteCaller | null = null
        let sessionId: string | undefined
        const finish = (response: RemoteOpsResponse<unknown>): RemoteOpsResponse<unknown> => {
            const outcome: 'ok' | RemoteOpsErrorCode = response.ok ? 'ok' : response.error.code
            deps.log(formatRemoteAuditLine({ method, from, sessionId, outcome, durationMs: deps.now() - started }))
            return response
        }
        let enabled = false
        try {
            enabled = await deps.enabled()
        } catch {
            enabled = true
        }
        const guard = guardRemoteSessionOpsRequest(method, params, { enabled })
        if (!guard.ok) return finish(guard)
        from = guard.request.from
        sessionId = targetOf(guard.request.args)
        const token = budget.take()
        if (!token.ok) {
            return finish(remoteError('rate_limited', `This machine accepts at most ${budget.perMinute} remote session calls per minute; retry in ${Math.ceil(token.retryAfterMs / 1000)}s`))
        }
        try {
            return finish({ ok: true, result: await op(guard.request.args, from) })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Remote session operation failed'
            if (error instanceof RemoteOpFailure) return finish(remoteError(error.code, message))
            return finish(remoteError('internal', message))
        }
    }

    const requirePersisted = (id: string): PersistedSession => {
        const persisted = deps.readPersisted()[id]
        if (!persisted) throw new RemoteOpFailure('no_local_key', `Session ${id} is not on ${deps.host} (no local key there either)`)
        return persisted
    }

    return {
        'sessions.list': run('sessions.list', async (args) => {
            const wanted = args.ids ? new Set(args.ids) : null
            let sessions: Array<SessionSummary | AccountSessionSummary>
            if (args.all) {
                sessions = (await deps.listAccount({ tag: args.tag, recentLimit: wanted ? 10_000 : args.limit, includeArchived: true }))
                    .filter((row) => row.decryptable)
            } else if (wanted) {
                // Locate: what this machine holds a key for, live or recent.
                const persisted = deps.readPersisted()
                const live = await deps.listLocal({ recentLimit: 10_000 })
                const liveById = new Map(live.map((row) => [row.id, row]))
                sessions = [...wanted]
                    .filter((id) => persisted[id] !== undefined || liveById.has(id))
                    .map((id) => liveById.get(id) ?? summaryFromPersisted(id, persisted[id]))
            } else {
                sessions = await deps.listLocal({ tag: args.tag, recentLimit: args.limit })
            }
            if (wanted) sessions = sessions.filter((row) => wanted.has(row.id))
            const result: RemoteListResult = { machineId: deps.machineId, host: deps.host, sessions }
            return result
        }, () => undefined),

        'sessions.read': run('sessions.read', async (args) => {
            requirePersisted(args.sessionId)
            const limit = Math.max(1, Math.min(MAX_READ_LIMIT, args.limit ?? 20))
            const transcript = await deps.readTranscript(args.sessionId, limit, { full: args.full === true })
            const capped = capRemoteTranscript(transcript.transcript)
            const result: RemoteReadResult = {
                ...transcript,
                transcript: capped.transcript,
                ...(capped.truncated ? { truncated: true } : {}),
                machineId: deps.machineId,
                host: deps.host,
            }
            return result
        }, (args) => args.sessionId),

        'sessions.send': run('sessions.send', async (args) => {
            const persisted = requirePersisted(args.sessionId)
            return deps.deliver(args.sessionId, persisted, args.text, REMOTE_CLIENT_TAG, {
                resume: args.resume === true,
                ...(args.model !== undefined ? { model: args.model } : {}),
                ...(args.sentFrom !== undefined ? { sentFrom: args.sentFrom } : {}),
            })
        }, (args) => args.sessionId),

        'sessions.peers': run('sessions.peers', async (args, from) => {
            const scope = args.cwd ? (args.scope ?? 'machine') : 'machine'
            const context: PeerToolContext = {
                self: () => ({ sessionId: from.sessionId ?? CLI_PEER_SENDER_ID, cwd: args.cwd ?? '/', machine: from.host }),
                readPersisted: deps.readPersisted,
            }
            const listing = await deps.listPeers(context, scope)
            return { ...listing, machineId: deps.machineId, host: deps.host }
        }, () => undefined),

        'sessions.message': run('sessions.message', async (args) => {
            requirePersisted(args.to)
            const context: PeerToolContext = {
                self: () => ({ ...args.from, cwd: args.from.cwd ?? '/' }),
                readPersisted: deps.readPersisted,
                // The target must be HERE; never bounce a remote request onward.
                remoteMessage: null,
            }
            return deps.sendPeer(context, { to: args.to, body: args.body, ...(args.replyTo ? { replyTo: args.replyTo } : {}) })
        }, (args) => args.to),
    }
}

/** A refusal with a protocol code, as opposed to an unexpected throw (`internal`). */
export class RemoteOpFailure extends Error {
    constructor(readonly code: RemoteOpsErrorCode, message: string) {
        super(message)
    }
}

function summaryFromPersisted(id: string, persisted: PersistedSession | undefined): SessionSummary {
    const meta = persisted?.metadata as (PersistedSession['metadata'] & { variant?: string }) | undefined
    return {
        id,
        live: false,
        ...(meta?.summary?.text ? { title: meta.summary.text } : {}),
        ...(meta?.path ? { cwd: meta.path } : {}),
        ...(meta?.flavor ? { flavor: meta.flavor } : {}),
        ...(meta?.tags?.length ? { tags: [...meta.tags] } : {}),
        ...(meta?.variant ? { variant: meta.variant } : {}),
        ...(persisted?.savedAt !== undefined ? { savedAt: persisted.savedAt } : {}),
        url: sessionWebUrl(id),
    }
}

export { REMOTE_SESSION_OPS_METHODS }
