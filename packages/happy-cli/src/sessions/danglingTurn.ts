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

type TurnMarker = { t: 'turn-start' | 'turn-end'; turn: string }

function turnMarker(body: unknown): TurnMarker | null {
    if (!body || typeof body !== 'object') return null
    const b = body as { role?: unknown; content?: unknown }
    if (b.role !== 'session' || !b.content || typeof b.content !== 'object') return null
    const env = b.content as { ev?: { t?: unknown }; turn?: unknown; subagent?: unknown }
    // A sub-agent's own lifecycle is not the session's turn.
    if (env.subagent !== undefined && env.subagent !== null) return null
    const t = env.ev?.t
    if ((t !== 'turn-start' && t !== 'turn-end') || typeof env.turn !== 'string' || env.turn.length === 0) return null
    return { t, turn: env.turn }
}

/** The open turn the log ends in, or null. Entries in ascending seq order. */
export function findDanglingTurn(entries: readonly LogEntry[]): { turn: string } | null {
    let lastStart: string | null = null
    const ended = new Set<string>()
    for (const entry of entries) {
        const marker = turnMarker(entry.body)
        if (!marker) continue
        if (marker.t === 'turn-start') lastStart = marker.turn
        else ended.add(marker.turn)
    }
    return lastStart && !ended.has(lastStart) ? { turn: lastStart } : null
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
): Promise<string | null> {
    const dangling = findDanglingTurn(await deps.readLog(sessionId, persisted, DANGLING_TURN_WINDOW))
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
