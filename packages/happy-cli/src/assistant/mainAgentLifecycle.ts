/**
 * B-919: the main agent's `session_wrapup` / `session_handoff` /
 * `session_restart` backends (installed with `installSessionLifecycle` when
 * the main agent's MCP server starts).
 *
 *  - wrap-up / handoff: the B-915 path (`@/wrapup/request`) — the same one
 *    turn as the owner pressing 收尾 / 交接给… in that session and as
 *    `very-happy sessions wrapup|handoff`. Any session of the account.
 *    `to: 'new'` first spawns a session in `from`'s directory on this
 *    machine (same backend), then asks `from` to hand over to it.
 *  - restart: the local daemon's `/session-restart-owner` — the B-911 idle
 *    queue (`idle`) or an immediate restart of a session that is idle right
 *    now (`now`); the daemon's guards decide, never this process.
 *
 * Receipts stay short: ids + state (+ a one-line error). Nothing of the
 * target session's conversation comes back into the main agent's context.
 */

import { sanitizeImportTitle } from '@/daemon/importTitle'
import { requestHandoff, requestWrapup, type BuiltinRequestResult, type HandoffRequest, type WrapupRequest } from '@/wrapup/request'
import type { OwnerRestartReply } from '@/daemon/controlServer'
import { requestOwnerRestartViaDaemon, spawnDaemonSession } from '@/daemon/controlClient'
import { readPersistedSessions, readSettings } from '@/persistence'
import { readSessionMetadata } from '@/sessions/sessionOps'
import type { HandoffReceipt, LifecycleError, RestartReceipt, SessionLifecycle, WrapupReceipt } from './mainAgentTools'
import { SESSION_SPAWN_AGENTS } from './assistantTools'

export type HandoffSource = { path: string; flavor: string | null; title: string | null; machineId: string | null }

export interface MainAgentLifecycleDeps {
    /** This (main agent) session: never asked to wrap itself up. */
    selfId: () => string
    requestWrapup: (sessionIds: readonly string[], request: WrapupRequest) => Promise<BuiltinRequestResult[]>
    requestHandoff: (request: HandoffRequest) => Promise<BuiltinRequestResult>
    /** Directory / flavor / title / machine of a session this machine holds the key for; null otherwise. */
    readSource: (sessionId: string) => Promise<HandoffSource | null>
    selfMachineId: () => Promise<string | null>
    spawn: (directory: string, opts: { agent?: string; title?: string }) => Promise<{ sessionId?: string; error?: string }>
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
    'busy': 'it is busy (a turn or background task is running); use when = idle',
    'daemon-too-old': 'the daemon on this machine is too old; upgrade very-happy-cli',
    'daemon-unreachable': 'the local daemon did not answer',
}

export function createMainAgentLifecycle(deps: MainAgentLifecycleDeps): SessionLifecycle {
    /** requestId → the session spawned for a `to: 'new'` handoff (a retried call reuses it). */
    const spawned = new Map<string, string>()

    async function spawnTarget(from: string, requestId: string): Promise<{ id: string; title: string | null } | LifecycleError> {
        const reused = spawned.get(requestId)
        if (reused) return { id: reused, title: null }
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
        spawned.set(requestId, result.sessionId)
        return { id: result.sessionId, title: title ?? null }
    }

    return {
        wrapup: async ({ sessionId, requestId }): Promise<WrapupReceipt> => {
            const [result] = await deps.requestWrapup([sessionId], { requestId, self: deps.selfId() })
            if (!result || result.state === 'error') return { ok: false, sessionId, error: oneLine(result?.error ?? 'wrap-up request failed') }
            return { ok: true, sessionId, state: result.state }
        },
        handoff: async ({ from, to, note, requestId }): Promise<HandoffReceipt> => {
            let target = to
            let toTitle: string | null = null
            if (to === 'new') {
                const created = await spawnTarget(from, requestId)
                if ('ok' in created) return { ...created, from, to }
                target = created.id
                toTitle = created.title
            }
            const result = await deps.requestHandoff({ from, to: target, ...(toTitle ? { toTitle } : {}), ...(note ? { note } : {}), requestId })
            if (result.state === 'error') return { ok: false, from, to: target, error: oneLine(result.error ?? 'handoff request failed') }
            return { ok: true, from, to: target, state: result.state }
        },
        restart: async ({ sessionId, when }): Promise<RestartReceipt> => {
            let reply: OwnerRestartReply
            try {
                reply = await deps.restart(sessionId, when)
            } catch (error) {
                return { ok: false, sessionId, error: oneLine(message(error)) }
            }
            if (!reply.ok) return { ok: false, sessionId, error: RESTART_REFUSALS[reply.code] ?? oneLine(reply.error ?? reply.code) }
            return { ok: true, sessionId, scheduled: when, ...(reply.state === 'already-queued' ? { already: true } : {}), ...(reply.targetVersion ? { targetVersion: reply.targetVersion } : {}) }
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
        restart: requestOwnerRestartViaDaemon,
    })
}
