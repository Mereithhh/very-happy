/**
 * B-531 — a fork's first message must land AFTER its replayed history.
 *
 * A forked session starts with an empty server log; its wrapper replays the
 * copied conversation (Claude JSONL / Codex thread) through its outbox, and
 * the outbox uploads asynchronously. `very-happy spawn --fork … --prompt`
 * used to POST the prompt as soon as the daemon answered, so the server gave
 * the prompt a seq in the MIDDLE of the replay (dev-sg 2026-10-04, 0.2.162:
 * 95 lines queued at 10:27:09.549, the prompt reached the wrapper at .690
 * while the replay tail was still uploading). Seq is the only order every
 * client sorts by, so that is permanent misordering, not a display glitch.
 *
 * Protocol (spec `specs/2026-10-fork-first-message-order.md`):
 *  - The wrapper advertises FORK_BACKFILL_CAPABILITY in its session metadata
 *    from birth (it reaches `~/.happy/sessions.json` via /session-started).
 *  - After a fork replay it waits until the server has accepted every replayed
 *    message (`drainOutbox`) and only then writes `metadata.forkBackfill`.
 *  - The CLI, for a fork with a prompt, waits for that marker before it POSTs.
 *    A wrapper without the capability (older install) gets the old immediate
 *    send; a capable wrapper that never confirms is a hard error — the prompt
 *    is NOT sent out of order (the session exists; the caller can send later).
 */
import type { Metadata } from '@/api/types'

export const FORK_BACKFILL_CAPABILITY = 'fork-backfill-ack-v1'

/** Large forks upload in many POSTs (outboxBatch.ts); a slow Codex app-server
 *  start precedes its replay. Generous on purpose: late beats misordered. */
export const FORK_BACKFILL_WAIT_TIMEOUT_MS = 120_000
export const FORK_BACKFILL_POLL_MS = 500

export interface ForkBackfillMarker {
    done: true
    /** Provider lines (Claude) / envelopes (Codex) replayed. */
    count: number
    /** The replay source could not be read; nothing (or nothing more) was replayed. */
    failed?: boolean
    completedAt: number
}

/**
 * B-880: written while the replay uploads (`done: false`), so the Web can show
 * the import's progress instead of streaming the history in from its oldest
 * message. `total` / `sent` count outbox envelopes, not transcript lines.
 * Every reader of the final marker requires `done === true`, so an older CLI
 * waiting on the marker keeps waiting through these.
 */
export interface ForkBackfillProgress {
    done: false
    total: number
    sent: number
}

export const FORK_BACKFILL_PROGRESS_MS = 1_000

/**
 * B-880: before the replay reads and encrypts the transcript (seconds for a
 * long one, the event loop busy throughout): the Web parks the session from
 * the start instead of rendering whatever lands first. Followed by
 * `publishForkBackfillWhenCommitted` on every path, failures included.
 */
export function announceForkBackfill(session: Pick<ForkBackfillSession, 'updateMetadata'>): void {
    const progress: ForkBackfillProgress = { done: false, total: 0, sent: 0 }
    session.updateMetadata((metadata) => ({ ...metadata, forkBackfill: progress }))
}

export function readForkBackfillMarker(metadata: unknown): ForkBackfillMarker | null {
    if (!metadata || typeof metadata !== 'object') return null
    const marker = (metadata as { forkBackfill?: unknown }).forkBackfill
    if (!marker || typeof marker !== 'object') return null
    const value = marker as Partial<ForkBackfillMarker>
    if (value.done !== true) return null
    return {
        done: true,
        count: typeof value.count === 'number' ? value.count : 0,
        ...(value.failed === true ? { failed: true } : {}),
        completedAt: typeof value.completedAt === 'number' ? value.completedAt : 0,
    }
}

/** What the wrapper needs from its session client. */
export interface ForkBackfillSession {
    /** Resolves true once the server accepted every message enqueued before the call; false if the client closed first. */
    drainOutbox(): Promise<boolean>
    updateMetadata(handler: (metadata: Metadata) => Metadata): void
    /** B-880: replayed messages not yet accepted by the server (absent: no progress is published). */
    pendingBackfillCount?(): number
}

type Every = (tick: () => void, ms: number) => () => void
const every: Every = (tick, ms) => {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
}

/**
 * Wrapper side: call right after the replay loop enqueued its messages (also
 * on a failed replay, so the CLI is not left waiting). Never throws.
 */
export async function publishForkBackfillWhenCommitted(
    session: ForkBackfillSession,
    result: { count: number; failed?: boolean },
    now: () => number = Date.now,
    schedule: Every = every,
): Promise<boolean> {
    const total = session.pendingBackfillCount?.() ?? 0
    let stopProgress = () => {}
    if (total > 0) {
        let sent = -1
        const publishProgress = () => {
            const next = Math.max(0, total - (session.pendingBackfillCount?.() ?? 0))
            if (next === sent) return
            sent = next
            const progress: ForkBackfillProgress = { done: false, total, sent }
            session.updateMetadata((metadata) => ({ ...metadata, forkBackfill: progress }))
        }
        publishProgress()
        stopProgress = schedule(publishProgress, FORK_BACKFILL_PROGRESS_MS)
    }
    let drained = false
    try {
        drained = await session.drainOutbox()
    } catch {
        drained = false
    } finally {
        stopProgress()
    }
    // Closed before the server confirmed: no marker. The waiting CLI times out
    // instead of sending into the middle of a half-uploaded history.
    if (!drained) return false
    const marker: ForkBackfillMarker = {
        done: true,
        count: result.count,
        ...(result.failed ? { failed: true } : {}),
        completedAt: now(),
    }
    session.updateMetadata((metadata) => ({ ...metadata, forkBackfill: marker }))
    return true
}

export type ForkBackfillGate =
    | { kind: 'confirmed'; marker: ForkBackfillMarker }
    /** The wrapper predates the marker: nothing to wait for (old behaviour). */
    | { kind: 'legacy-wrapper' }

export class ForkBackfillTimeoutError extends Error {
    constructor(timeoutMs: number, lastError?: unknown) {
        const cause = lastError === undefined ? '' : ` (last read error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
        super(`the forked history was not confirmed on the server within ${Math.round(timeoutMs / 1000)}s${cause}; the first message was NOT sent, so it cannot land in the middle of the replayed history`)
        this.name = 'ForkBackfillTimeoutError'
    }
}

/**
 * CLI side: before the first message of a fork. `capabilities` is the
 * wrapper's spawn-time metadata (sessions.json); `readMetadata` fetches the
 * server's current metadata. Read errors are retried until the deadline.
 */
export async function waitForForkBackfill(opts: {
    capabilities: readonly string[] | null | undefined
    readMetadata: () => Promise<unknown>
    timeoutMs?: number
    pollMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}): Promise<ForkBackfillGate> {
    if (!opts.capabilities?.includes(FORK_BACKFILL_CAPABILITY)) return { kind: 'legacy-wrapper' }
    const timeoutMs = opts.timeoutMs ?? FORK_BACKFILL_WAIT_TIMEOUT_MS
    const pollMs = opts.pollMs ?? FORK_BACKFILL_POLL_MS
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const now = opts.now ?? Date.now
    const deadline = now() + timeoutMs
    let lastError: unknown
    while (true) {
        try {
            const marker = readForkBackfillMarker(await opts.readMetadata())
            if (marker) return { kind: 'confirmed', marker }
            lastError = undefined
        } catch (error) {
            lastError = error
        }
        if (now() >= deadline) throw new ForkBackfillTimeoutError(timeoutMs, lastError)
        await sleep(pollMs)
    }
}
