/**
 * B-501: deliver a user message to an EXISTING session only when something
 * will read it.
 *
 * `POST /v3/sessions/:id/messages` stores the message unconditionally — the
 * server does not check `active` / `archivedAt` — so an HTTP 2xx used to be
 * reported as "delivered" even when the session had no live wrapper (archived
 * after Ctrl-C, killed, or idle past the 10-minute presence timeout). Callers
 * such as the Tanka auto-reply then believed a session was working on their
 * message while it sat unread on the server.
 *
 * This module is the single delivery path for `very-happy send` and the
 * assistant's `session_send`:
 *
 *  1. classify the session (`classifySessionState`, pure) from the local
 *     daemon's `/list` and the server's `GET /v1/sessions/:id`;
 *  2. refuse when it is not `live` — unless `resume` was asked for, in which
 *     case it is brought back on THIS machine the same way the web's 「恢复」
 *     does (unarchive → daemon resume → re-archive on failure,
 *     specs/2026-09-archive-restore.md) and we wait for it to come up;
 *  3. send, then re-check: a wrapper that vanished between the check and the
 *     POST is reported as `delivered: false` (the message IS stored
 *     server-side; the caller decides whether to resume or spawn).
 *
 * Every side effect is injectable (`DeliveryDeps`) so the orchestration is
 * unit-tested without a daemon or a server.
 */

import type { PersistedSession } from '@/persistence'
import { listDaemonSessions, resumeDaemonSession } from '@/daemon/controlClient'
import { archiveSession, readSessionState, unarchiveSession, sessionLiveness, type LiveSessionLike, type SessionServerState } from '@/sessions/sessionOps'
import { sendUserMessage } from './sessionMessage'
import { delay } from '@/utils/time'

/** Where a session stands for delivery purposes. */
export type SessionDeliveryStatus = 'live' | 'archived' | 'offline' | 'not_found'

/**
 * How recent `activeAt` must be for a server-side `active: true` to count as
 * a live wrapper on ANOTHER machine — the same window `/v2/sessions/active`
 * applies. The local daemon's `/list` is authoritative for this machine.
 */
export const ACTIVE_FRESH_WINDOW_MS = 15 * 60 * 1000

/** How long a resumed session may take to show up live before we give up. */
export const DEFAULT_RESUME_WAIT_MS = 30_000
export const DEFAULT_RESUME_POLL_MS = 1_000

/**
 * Pure classification.
 *
 * - `not_found`: the server has no such session on this account.
 * - `archived`: `archivedAt` is set. Wins over a local live process: the
 *   server rejects the socket of an archived session, so even a lingering
 *   wrapper cannot receive the message.
 * - `live`: a wrapper is tracked by this machine's daemon, or the server says
 *   `active` with a fresh `activeAt` (wrapper on another machine).
 * - `offline`: everything else — the wrapper exited or its presence timed out.
 */
export function classifySessionState(input: {
    liveHere: boolean
    server: SessionServerState
    now: number
}): SessionDeliveryStatus {
    const { liveHere, server, now } = input
    if (!server.found) return 'not_found'
    if (typeof server.archivedAt === 'number') return 'archived'
    if (liveHere) return 'live'
    if (server.active && typeof server.activeAt === 'number' && now - server.activeAt <= ACTIVE_FRESH_WINDOW_MS) return 'live'
    return 'offline'
}

/** One-line reason a session cannot take a message, with the caller's own resume hint. */
export function explainNotLive(sessionId: string, status: Exclude<SessionDeliveryStatus, 'live'>, resumeHint: string): string {
    switch (status) {
        case 'archived':
            return `Session ${sessionId} is archived — no live wrapper will receive this message. ${resumeHint}`
        case 'offline':
            return `Session ${sessionId} is offline (its wrapper exited or timed out) — no live wrapper will receive this message. ${resumeHint}`
        case 'not_found':
            return `Session ${sessionId} was not found on this account — it cannot be messaged or resumed. Spawn a new session instead.`
    }
}

export interface DeliverOptions {
    /** Bring an archived / offline session back on this machine before sending. */
    resume?: boolean
    /** Switch the session's model with this message; `null` = machine default. */
    model?: string | null
    /** `meta.sentFrom` on the envelope (default 'cli'). */
    sentFrom?: string
    /** Forwarded to the resumed wrapper only. */
    permissionMode?: string
    /** Resume: how long to wait for the session to come up live. */
    waitMs?: number
    pollMs?: number
    /** Surface-specific tail of the "not live" message (default: the CLI's `--resume` hint). */
    resumeHint?: string
}

export const CLI_RESUME_HINT = 'Use --resume to bring it back on this machine, or spawn a new session.'

export interface DeliveryResult {
    sessionId: string
    status: SessionDeliveryStatus
    /** True only when a live wrapper was attached before AND after the POST. */
    delivered: boolean
    /** The session was resumed on this machine as part of this call. */
    resumed: boolean
    /** The POST went through: the message exists server-side even when `delivered` is false. */
    stored: boolean
    /** Why `delivered` is false. */
    error?: string
    /** Present when a resume was attempted. */
    resume?: { ok: boolean; error?: string }
}

export interface DeliveryDeps {
    listLive: () => Promise<LiveSessionLike[]>
    readState: (sessionId: string, persisted: PersistedSession) => Promise<SessionServerState>
    send: (
        sessionId: string,
        persisted: PersistedSession,
        text: string,
        client: string,
        options: { model?: string | null; sentFrom?: string },
    ) => Promise<void>
    unarchive: (sessionId: string) => Promise<void>
    archive: (sessionId: string) => Promise<void>
    resume: (sessionId: string, opts: { model?: string; permissionMode?: string }) => Promise<{ success: boolean; error?: string }>
    sleep: (ms: number) => Promise<void>
    now: () => number
}

const defaultDeps: DeliveryDeps = {
    listLive: () => listDaemonSessions() as Promise<LiveSessionLike[]>,
    readState: (sessionId, persisted) => readSessionState(sessionId, persisted),
    send: (sessionId, persisted, text, client, options) => sendUserMessage(sessionId, persisted, text, client, options),
    unarchive: unarchiveSession,
    archive: archiveSession,
    resume: resumeDaemonSession,
    sleep: (ms) => delay(ms).then(() => undefined),
    now: () => Date.now(),
}

/**
 * Deliver `text` into `sessionId` (whose key `persisted` we hold). Resolves
 * with a result for every lifecycle outcome; throws only on transport-level
 * failures (state read failed, send POST failed) — the caller maps those to a
 * generic error.
 */
export async function deliverToSession(
    sessionId: string,
    persisted: PersistedSession,
    text: string,
    client: string,
    options: DeliverOptions = {},
    deps: Partial<DeliveryDeps> = {},
): Promise<DeliveryResult> {
    const d: DeliveryDeps = { ...defaultDeps, ...deps }
    const resumeHint = options.resumeHint ?? CLI_RESUME_HINT
    const classify = async (): Promise<SessionDeliveryStatus> => {
        const [live, server] = await Promise.all([d.listLive(), d.readState(sessionId, persisted)])
        return classifySessionState({ liveHere: sessionLiveness(live, sessionId).live, server, now: d.now() })
    }

    let status = await classify()
    let resumed = false
    let resumeOutcome: DeliveryResult['resume']

    if (status !== 'live') {
        if (!options.resume || status === 'not_found') {
            return { sessionId, status, delivered: false, resumed: false, stored: false, error: explainNotLive(sessionId, status, resumeHint) }
        }
        // Same compensating transition as the web (`commitSessionResume`): an
        // archived session is unarchived first and re-archived if the daemon
        // refuses; a merely offline one is resumed as-is, so a transient
        // failure never archives a healthy session.
        const wasArchived = status === 'archived'
        if (wasArchived) {
            try {
                await d.unarchive(sessionId)
            } catch (error) {
                const message = `unarchive failed: ${error instanceof Error ? error.message : String(error)}`
                return { sessionId, status, delivered: false, resumed: false, stored: false, error: message, resume: { ok: false, error: message } }
            }
        }
        const outcome = await d.resume(sessionId, {
            ...(typeof options.model === 'string' ? { model: options.model } : {}),
            ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
        })
        if (!outcome.success) {
            let message = outcome.error ?? 'resume failed'
            if (wasArchived) {
                try {
                    await d.archive(sessionId)
                } catch (error) {
                    message += `; failed to restore archive state: ${error instanceof Error ? error.message : String(error)}`
                }
            }
            return { sessionId, status, delivered: false, resumed: false, stored: false, error: message, resume: { ok: false, error: message } }
        }
        resumed = true
        resumeOutcome = { ok: true }
        status = await waitUntilLive(classify, d, options)
        if (status !== 'live') {
            const waited = Math.round((options.waitMs ?? DEFAULT_RESUME_WAIT_MS) / 1000)
            return {
                sessionId, status, delivered: false, resumed, stored: false, resume: resumeOutcome,
                error: `Session ${sessionId} was resumed but no live wrapper showed up within ${waited}s (state: ${status}); message not sent`,
            }
        }
    }

    await d.send(sessionId, persisted, text, client, {
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.sentFrom !== undefined ? { sentFrom: options.sentFrom } : {}),
    })

    // The wrapper may have gone between the check and the POST. A failed
    // re-check is not evidence of that, so it keeps the pre-send answer.
    let after: SessionDeliveryStatus = 'live'
    try {
        after = await classify()
    } catch {
        after = 'live'
    }
    if (after !== 'live') {
        return {
            sessionId, status: after, delivered: false, resumed, stored: true, ...(resumeOutcome ? { resume: resumeOutcome } : {}),
            error: `Session ${sessionId} went ${after} while sending: the message is stored server-side but no wrapper is attached to read it. ${after === 'not_found' ? 'Spawn a new session.' : resumeHint}`,
        }
    }
    return { sessionId, status: 'live', delivered: true, resumed, stored: true, ...(resumeOutcome ? { resume: resumeOutcome } : {}) }
}

async function waitUntilLive(
    classify: () => Promise<SessionDeliveryStatus>,
    d: DeliveryDeps,
    options: DeliverOptions,
): Promise<SessionDeliveryStatus> {
    const waitMs = options.waitMs ?? DEFAULT_RESUME_WAIT_MS
    const pollMs = options.pollMs ?? DEFAULT_RESUME_POLL_MS
    const deadline = d.now() + waitMs
    let status = await classify()
    while (status !== 'live' && d.now() < deadline) {
        await d.sleep(pollMs)
        status = await classify()
    }
    return status
}
