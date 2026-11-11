/**
 * B-919: the main agent's `session_wrapup` / `session_handoff` /
 * `session_restart` backends (installed with `installSessionLifecycle` when
 * the main agent's MCP server starts).
 *
 *  - wrap-up / handoff: the B-915 path (`@/wrapup/request`) — the same one
 *    turn as the owner pressing 收尾 / 交接给… in that session and as
 *    `very-happy sessions wrapup|handoff`. Any session of the account except
 *    the main agent itself. A repeated requestId sends nothing and answers
 *    `deduped: true` (request.ts).
 *    `to: 'new'` first spawns a session in `from`'s directory on this
 *    machine (same backend), then asks `from` to hand over to it. The
 *    requestId → new session pair is kept on disk (`handoff-new.json`), so a
 *    retry from a restarted wrapper finds the same session instead of
 *    spawning a second one.
 *  - restart: the local daemon's `/session-restart-owner` — the B-911 idle
 *    queue (`idle`) or an immediate restart of a session that is idle right
 *    now (`now`); the daemon's guards decide, never this process.
 *
 * Receipts stay short: ids + state (+ a one-line error). Nothing of the
 * target session's conversation comes back into the main agent's context.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeImportTitle } from '@/daemon/importTitle'
import { requestHandoff, requestWrapup, type BuiltinRequestResult, type HandoffRequest, type WrapupRequest } from '@/wrapup/request'
import type { OwnerRestartReply } from '@/daemon/controlServer'
import { requestOwnerRestartViaDaemon, spawnDaemonSession } from '@/daemon/controlClient'
import { configuration } from '@/configuration'
import { readPersistedSessions, readSettings } from '@/persistence'
import { readSessionMetadata, readSessionState } from '@/sessions/sessionOps'
import type { HandoffReceipt, LifecycleError, RestartReceipt, SessionLifecycle, WrapupReceipt } from './mainAgentTools'
import { SESSION_SPAWN_AGENTS } from './assistantTools'

export type HandoffSource = { path: string; flavor: string | null; title: string | null; machineId: string | null }

/** requestId → the session spawned for a `to: 'new'` handoff; survives the wrapper (a retry after a restart). */
export interface HandoffNewStore {
    get: (key: string) => string | null
    set: (key: string, sessionId: string) => void
}

export interface MainAgentLifecycleDeps {
    /** This (main agent) session: never asked to wrap itself up, hand off, or receive a handoff. */
    selfId: () => string
    requestWrapup: (sessionIds: readonly string[], request: WrapupRequest) => Promise<BuiltinRequestResult[]>
    requestHandoff: (request: HandoffRequest) => Promise<BuiltinRequestResult>
    /** Directory / flavor / title / machine of a session this machine holds the key for; null otherwise. */
    readSource: (sessionId: string) => Promise<HandoffSource | null>
    selfMachineId: () => Promise<string | null>
    spawn: (directory: string, opts: { agent?: string; title?: string }) => Promise<{ sessionId?: string; error?: string }>
    handoffNew: HandoffNewStore
    /** A remembered new session is reused only while it still exists and is not archived. */
    sessionUsable: (sessionId: string) => Promise<boolean>
    restart: (sessionId: string, when: 'idle' | 'now') => Promise<OwnerRestartReply>
}

const oneLine = (text: string, max = 240) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Why a restart was refused, in words the main agent can relay to the owner. */
const RESTART_REFUSALS: Record<string, string> = {
    'not-live': 'it is not running on this machine (only sessions of the machine the main agent runs on can be restarted)',
    'local-terminal': 'it runs in the owner\'s own terminal; restart it there',
    'assistant': 'it is an assistant session',
    'unsupported-flavor': 'its agent cannot be restarted in place',
    'no-turn-reports': 'its wrapper is too old to prove it is idle; restart it from the Web',
    'not-resumable': 'its conversation cannot be resumed',
    'already-queued': 'a restart is already queued for it',
    'daemon-too-old': 'the daemon on this machine is too old; upgrade very-happy-cli',
    'daemon-unreachable': 'the local daemon did not answer',
}
/** `busy:<wait>` from the daemon (the idle-restart waits) → why it is not idle right now. */
const BUSY_REASONS: Record<string, string> = {
    'turn-active': 'a turn is running',
    'background-tasks': 'a background task is running',
    'automation-run': 'an automation run is using it',
    'quiet': 'its last turn ended moments ago (more may be queued)',
    'upgrade-pending': 'a CLI upgrade is about to restart it anyway',
}

export function restartRefusalText(reply: { code: string; error?: string }): string {
    if (reply.code === 'busy') {
        const wait = reply.error?.startsWith('busy:') ? reply.error.slice(5) : ''
        return `it is not idle right now: ${BUSY_REASONS[wait] ?? (wait || 'busy')}; use when = idle to restart it once it is`
    }
    return RESTART_REFUSALS[reply.code] ?? oneLine(reply.error ?? reply.code)
}

/** The handoff-new key of a request: the source and the caller's requestId. */
export function handoffNewKey(from: string, requestId: string): string {
    return createHash('sha256').update(`${from}\n${requestId}`).digest('hex').slice(0, 32)
}

export function createMainAgentLifecycle(deps: MainAgentLifecycleDeps): SessionLifecycle {
    const MAIN_AGENT_NOTE = 'that is the main agent itself'

    async function spawnTarget(from: string, requestId: string): Promise<{ id: string; title: string | null; reused: boolean } | LifecycleError> {
        const key = handoffNewKey(from, requestId)
        const remembered = deps.handoffNew.get(key)
        if (remembered && await deps.sessionUsable(remembered).catch(() => false)) return { id: remembered, title: null, reused: true }
        const fail = (error: string): LifecycleError => ({ ok: false, error })
        let source: HandoffSource | null
        try {
            source = await deps.readSource(from)
        } catch (error) {
            return fail(`Could not read session ${from}: ${oneLine(message(error))}`)
        }
        const self = await deps.selfMachineId()
        if (!source || !source.path || (source.machineId && self && source.machineId !== self)) {
            return fail(`Session ${from} is not on this machine; start a session on its machine (session_spawn) and pass its id as to`)
        }
        const agent = (SESSION_SPAWN_AGENTS as readonly string[]).includes(source.flavor ?? '') ? source.flavor! : undefined
        const title = sanitizeImportTitle(`Handoff: ${source.title ?? from}`) ?? undefined
        const result = await deps.spawn(source.path, { ...(agent ? { agent } : {}), ...(title ? { title } : {}) })
        if (!result.sessionId) return fail(`Could not start the new session: ${oneLine(result.error ?? 'no session id')}`)
        try { deps.handoffNew.set(key, result.sessionId) } catch { /* a lost record only costs dedupe on a later retry */ }
        return { id: result.sessionId, title: title ?? null, reused: false }
    }

    return {
        wrapup: async ({ sessionId, requestId }): Promise<WrapupReceipt> => {
            const [result] = await deps.requestWrapup([sessionId], { requestId, self: deps.selfId() })
            if (!result || result.state === 'error') return { ok: false, sessionId, error: oneLine(result?.error ?? 'wrap-up request failed') }
            return { ok: true, sessionId, state: result.state, ...(result.deduped ? { deduped: true as const } : {}) }
        },
        handoff: async ({ from, to, note, requestId }): Promise<HandoffReceipt> => {
            const self = deps.selfId()
            if (from === self) return { ok: false, from, to, error: `from is ${MAIN_AGENT_NOTE}; name the session whose work should be handed over` }
            if (to === self) return { ok: false, from, to, error: `to is ${MAIN_AGENT_NOTE}, which does not take work over; name a working session, or omit to for a new one` }
            let target = to
            let toTitle: string | null = null
            let reused = false
            if (to === 'new') {
                const created = await spawnTarget(from, requestId)
                if ('ok' in created) return { ...created, from, to }
                target = created.id
                toTitle = created.title
                reused = created.reused
            }
            const result = await deps.requestHandoff({ from, to: target, ...(toTitle ? { toTitle } : {}), ...(note ? { note } : {}), requestId })
            if (result.state === 'error') return { ok: false, from, to: target, error: oneLine(result.error ?? 'handoff request failed') }
            return { ok: true, from, to: target, state: result.state, ...(result.deduped || reused ? { deduped: true as const } : {}) }
        },
        restart: async ({ sessionId, when }): Promise<RestartReceipt> => {
            let reply: OwnerRestartReply
            try {
                reply = await deps.restart(sessionId, when)
            } catch (error) {
                return { ok: false, sessionId, error: oneLine(message(error)) }
            }
            if (!reply.ok) return { ok: false, sessionId, error: restartRefusalText(reply) }
            return { ok: true, sessionId, scheduled: when, ...(reply.state === 'already-queued' ? { already: true } : {}), ...(reply.targetVersion ? { targetVersion: reply.targetVersion } : {}) }
        },
    }
}

const HANDOFF_NEW_TTL_MS = 7 * 24 * 60 * 60 * 1000
const HANDOFF_NEW_MAX = 200

/** `<HAPPY_HOME>/assistant/handoff-new.json`: { key: { sessionId, at } }, last 200 / 7 days. */
export function fileHandoffNewStore(file: string, now: () => number = Date.now): HandoffNewStore {
    const read = (): Record<string, { sessionId: string; at: number }> => {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            return raw && typeof raw === 'object' ? raw : {}
        } catch {
            return {}
        }
    }
    return {
        get: (key) => {
            const entry = read()[key]
            return entry && typeof entry.sessionId === 'string' && now() - entry.at < HANDOFF_NEW_TTL_MS ? entry.sessionId : null
        },
        set: (key, sessionId) => {
            const t = now()
            const kept = Object.entries({ ...read(), [key]: { sessionId, at: t } })
                .filter(([, e]) => t - e.at < HANDOFF_NEW_TTL_MS)
                .sort((a, b) => b[1].at - a[1].at)
                .slice(0, HANDOFF_NEW_MAX)
            mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
            const tmp = `${file}.${process.pid}.tmp`
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 })
            renameSync(tmp, file)
        },
    }
}

/** The live dependencies (tests inject doubles instead). */
export function createLiveMainAgentLifecycle(selfId: () => string): SessionLifecycle {
    return createMainAgentLifecycle({
        selfId,
        requestWrapup: (ids, request) => requestWrapup(ids, request),
        requestHandoff: (request) => requestHandoff(request),
        readSource: async (sessionId) => {
            const persisted = readPersistedSessions()[sessionId]
            if (!persisted) return null
            const metadata = await readSessionMetadata(sessionId, persisted) ?? persisted.metadata ?? null
            if (!metadata?.path) return null
            return { path: metadata.path, flavor: metadata.flavor ?? null, title: metadata.summary?.text ?? null, machineId: metadata.machineId ?? null }
        },
        selfMachineId: async () => { try { return (await readSettings())?.machineId ?? null } catch { return null } },
        spawn: async (directory, opts) => {
            const result = await spawnDaemonSession(directory, undefined, { spawnedBy: 'assistant', ...opts })
            return typeof result?.sessionId === 'string' ? { sessionId: result.sessionId } : { error: String(result?.error ?? 'daemon returned no session id') }
        },
        handoffNew: fileHandoffNewStore(join(configuration.happyHomeDir, 'assistant', 'handoff-new.json')),
        sessionUsable: async (sessionId) => {
            const state = await readSessionState(sessionId)
            return state.found && typeof state.archivedAt !== 'number'
        },
        restart: requestOwnerRestartViaDaemon,
    })
}
