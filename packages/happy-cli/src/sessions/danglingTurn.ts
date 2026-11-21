/**
 * B-942 — a turn whose process is gone is closed on the server.
 *
 * A wrapper killed mid-turn (SIGKILL, OOM, a crash the wrapper does not
 * survive) never writes the `turn-end` it owed: the session log keeps an open
 * `turn-start` for good. `sessions read --wait` then waits out its whole
 * timeout, and any client that reads turn state from the log thinks the turn
 * is still running. The daemon sees the wrapper exit; it closes that turn with
 * the `turn-end` the wrapper would have written (`failed`, or `cancelled` for a
 * stop that was asked for), with the reason in `error`.
 *
 * `findDanglingTurn` is pure. A turn is dangling when it is the LAST turn the
 * log opened and no `turn-end` names it: a newer `turn-start` means another
 * wrapper (a resume) already owns the session, and its turn is not ours to end.
 */
import axios from 'axios'
import { createEnvelope } from '@slopus/happy-wire'
import { configuration } from '@/configuration'
import { decodeBase64, encodeBase64, encrypt } from '@/api/encryption'
import { readCredentialsForConfiguredRelay, type PersistedSession } from '@/persistence'
import { readSessionLog } from '@/sessions/sessionOps'
import type { LogEntry } from '@/sessions/turnState'

type TurnMarker = { t: 'turn-start' | 'turn-end'; turn: string; time: number | null }

function turnMarker(body: unknown): TurnMarker | null {
    if (!body || typeof body !== 'object') return null
    const b = body as { role?: unknown; content?: unknown }
    if (b.role !== 'session' || !b.content || typeof b.content !== 'object') return null
    const env = b.content as { ev?: { t?: unknown }; turn?: unknown; subagent?: unknown; time?: unknown }
    // A sub-agent's own lifecycle is not the session's turn.
    if (env.subagent !== undefined && env.subagent !== null) return null
    const t = env.ev?.t
    if ((t !== 'turn-start' && t !== 'turn-end') || typeof env.turn !== 'string' || env.turn.length === 0) return null
    return { t, turn: env.turn, time: typeof env.time === 'number' ? env.time : null }
}

/**
 * The open turn the log ends in, or null. Entries in ascending seq order.
 * `startedBefore` (ms): a turn opened after the process exited belongs to the
 * wrapper that came after it (a wake, a resume) and is never dangling.
 */
export function findDanglingTurn(entries: readonly LogEntry[], opts: { startedBefore?: number } = {}): { turn: string } | null {
    let last: TurnMarker | null = null
    const ended = new Set<string>()
    for (const entry of entries) {
        const marker = turnMarker(entry.body)
        if (!marker) continue
        if (marker.t === 'turn-start') last = marker
        else ended.add(marker.turn)
    }
    if (!last || ended.has(last.turn)) return null
    if (opts.startedBefore !== undefined && last.time !== null && last.time > opts.startedBefore) return null
    return { turn: last.turn }
}

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null }

/** The `turn-end` a wrapper that is gone would have written. */
export function danglingTurnVerdict(exit: ProcessExit | undefined, requested: boolean): { status: 'failed' | 'cancelled'; error: string } {
    if (requested) return { status: 'cancelled', error: 'The session was stopped before this turn ended.' }
    const how = exit?.signal ? `was killed (${exit.signal})` : typeof exit?.code === 'number' ? `exited (code ${exit.code})` : 'exited'
    return { status: 'failed', error: `The session process ${how} before this turn ended. Send a message to continue.` }
}

export type CloseDanglingTurnDeps = {
    readLog: (sessionId: string, persisted: PersistedSession, limit: number) => Promise<LogEntry[]>
    post: (sessionId: string, content: string, localId: string) => Promise<void>
}

const defaultDeps: CloseDanglingTurnDeps = {
    readLog: readSessionLog,
    post: async (sessionId, content, localId) => {
        const credentials = await readCredentialsForConfiguredRelay()
        if (!credentials) throw new Error('CLI is not authenticated')
        await axios.post(
            `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
            { messages: [{ content, localId }] },
            {
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                    'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                },
                timeout: 30_000,
            },
        )
    },
}

/** How far back the open turn is looked for (a long turn's tool calls included). */
const DANGLING_TURN_WINDOW = 500

/**
 * Close the session's open turn, if its log ends in one. Returns the turn it
 * closed, or null. The localId is derived from the turn, so a repeat (two
 * exits, a retry) is stored once.
 */
export async function closeDanglingTurn(
    sessionId: string,
    persisted: PersistedSession,
    verdict: { status: 'failed' | 'cancelled'; error: string },
    deps: CloseDanglingTurnDeps = defaultDeps,
    exitedAt?: number,
): Promise<string | null> {
    const dangling = findDanglingTurn(await deps.readLog(sessionId, persisted, DANGLING_TURN_WINDOW), { startedBefore: exitedAt })
    if (!dangling) return null
    const envelope = createEnvelope('agent', { t: 'turn-end', status: verdict.status, error: verdict.error }, { turn: dangling.turn })
    const content = encodeBase64(encrypt(decodeBase64(persisted.encryptionKey), persisted.encryptionVariant, {
        role: 'session',
        content: envelope,
        meta: { sentFrom: 'cli' },
    }))
    await deps.post(sessionId, content, `turn-end-after-exit-${dangling.turn}`.slice(0, 200))
    return dangling.turn
}

/** An exit the wrapper did not clean up after: killed, crashed, or a non-zero code — and not one the daemon asked for. */
export function isAbnormalExit(exit: ProcessExit | undefined, stopRequested: boolean): boolean {
    if (stopRequested || !exit) return false
    return exit.signal != null || (typeof exit.code === 'number' && exit.code !== 0)
}

export type SettleExitedWrapperInput = {
    sessionId: string
    pid: number
    /** The session's local record (its key); without it no turn can be written. */
    persisted: PersistedSession | undefined
    exit: ProcessExit | undefined
    /** The daemon asked this PID to stop (stop / restart). */
    stopRequested: boolean
    /** The session is being brought back (auto-restart) or another tracked wrapper already runs it. */
    runsAgain: boolean
    exitedAt: number
}

export type SettleExitedWrapperDeps = {
    closeTurn: (sessionId: string, persisted: PersistedSession, verdict: { status: 'failed' | 'cancelled'; error: string }, exitedAt: number) => Promise<string | null>
    deactivate: (sessionId: string) => Promise<boolean>
}

/**
 * What the daemon does when a tracked wrapper exits (`onChildExited`, B-942):
 * - the session's log ends in a turn this process opened → write the
 *   `turn-end` it owed (`failed` with the reason; `cancelled` for a stop);
 * - the exit was abnormal (the wrapper could not run its own exit path) and
 *   nothing brings the session back → mark it offline on the server, so
 *   `send` and the Web wake it instead of delivering to nobody for the
 *   10-minute presence timeout. A normal exit already deactivated itself.
 * Each step is best effort and independent of the other.
 */
export async function settleExitedWrapper(input: SettleExitedWrapperInput, deps: SettleExitedWrapperDeps): Promise<{ closedTurn: string | null; deactivated: boolean | null }> {
    let closedTurn: string | null = null
    if (input.persisted) {
        try {
            closedTurn = await deps.closeTurn(input.sessionId, input.persisted, danglingTurnVerdict(input.exit, input.stopRequested), input.exitedAt)
        } catch {
            closedTurn = null
        }
    }
    let deactivated: boolean | null = null
    if (isAbnormalExit(input.exit, input.stopRequested) && !input.runsAgain) {
        deactivated = await deps.deactivate(input.sessionId).catch(() => false)
    }
    return { closedTurn, deactivated }
}
