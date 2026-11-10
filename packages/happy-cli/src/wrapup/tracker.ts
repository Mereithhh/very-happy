/**
 * B-915 wrapper side of 「收尾」/「交接给…」, one per session process.
 *
 *  - A routed user message whose localId is `wrapup-…` / `handoff-…` (Web
 *    menu, slash command, `sessions wrapup|handoff`, `session_wrapup`) marks
 *    the session's card `running` on the owner board.
 *  - `wrapup_report` reposts that card with the result (summary, files,
 *    commits, pending checkboxes, can-close).
 *  - `handoff_send` delivers the summary through the session-message
 *    channel (same machine / the other machine's daemon / the project's
 *    offline store), records the outcome on the handoff card and — only after
 *    a confirmed delivery and when asked — archives this session once the
 *    turn is over.
 *
 * Every board write degrades quietly: no board (old server, flag off) means
 * no card, never a failed turn.
 */

import { randomUUID } from 'node:crypto'
import { builtinActionOfLocalId, type AttentionItemPost } from '@slopus/happy-wire'
import type { AttentionClient } from '@/attention/client'
import type { SendPeerMessageResult } from '@/sessions/peerTools'
import {
    buildHandoffPost, buildRunningPost, buildWrapupReportPost, formatHandoffBody, shouldArchiveAfterHandoff,
    type BuiltinMode, type HandoffDelivery, type HandoffOutcome, type HandoffSendInput, type RunningAction, type WrapupReportInput,
} from './report'

export const WRAPUP_CARD_NOT_WRITTEN = 'The wrap-up card was not written (this server has no briefing board, or the request failed). List the result at the end of your reply instead: Summary / Files & commits / Pending / Can close: yes|no.'

export interface WrapupTrackerDeps {
    sessionId: () => string
    client: Pick<AttentionClient, 'post'>
    /** Resolves once the board probe is known: true when this server serves the board. */
    boardReady: () => Promise<boolean>
    sendPeer: (args: { to: string; body: string; machineId?: string; purpose: 'handoff' }) => Promise<SendPeerMessageResult>
    /** Archive this session (server route; the server then stops this wrapper). */
    archiveSelf: (sessionId: string) => Promise<void>
    log?: (message: string) => void
    now?: () => number
    requestId?: () => string
}

export interface WrapupReportResult {
    posted: boolean
    itemId?: string
    note?: string
}

export interface HandoffResult {
    to: string
    delivery: HandoffDelivery
    error?: string
    machine?: string
    /** The handoff card on the owner board was written. */
    card: boolean
    /** `scheduled` = this session is archived when the turn ends. */
    archive: 'scheduled' | 'not-requested' | 'skipped-unconfirmed'
    note: string
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function handoffDelivery(result: Pick<SendPeerMessageResult, 'delivered' | 'status'>): HandoffDelivery {
    if (result.delivered) return 'delivered'
    return result.status === 'offline-stored' ? 'offline-stored' : 'failed'
}

export function createWrapupTracker(deps: WrapupTrackerDeps) {
    const now = deps.now ?? Date.now
    const log = deps.log ?? (() => {})
    const requestId = deps.requestId ?? (() => randomUUID())
    const running = new Map<BuiltinMode, RunningAction>()
    let pendingArchive: { outcome: HandoffOutcome; run: RunningAction | undefined } | null = null
    let work: Promise<void> = Promise.resolve()
    const queue = (task: () => Promise<void>) => {
        work = work.then(task).catch((error) => log(`[wrapup] ${errorText(error)}`))
        return work
    }

    async function post(input: AttentionItemPost): Promise<string | null> {
        const { item } = await deps.client.post(input)
        return item.id
    }

    return {
        /** Every routed user message (any runner): a wrap-up / handoff turn gets its `running` card. */
        onUserMessage(message: { localId?: string | null }): void {
            const mode = builtinActionOfLocalId(message.localId)
            if (!mode || !message.localId) return
            const action: RunningAction = { mode, localId: message.localId, startedAt: now() }
            running.set(mode, action)
            void queue(async () => {
                if (!(await deps.boardReady())) return
                await post(buildRunningPost(deps.sessionId(), action))
            })
        },

        async report(input: WrapupReportInput): Promise<WrapupReportResult> {
            const run = running.get('wrapup')
            try {
                const itemId = await post(buildWrapupReportPost(deps.sessionId(), input, run, now(), requestId()))
                if (running.get('wrapup') === run) running.delete('wrapup')
                return { posted: true, ...(itemId ? { itemId } : {}), note: 'The wrap-up card is on the owner\'s board; they archive the session from it. Do not repeat the report in chat.' }
            } catch (error) {
                log(`[wrapup] report not posted: ${errorText(error)}`)
                return { posted: false, note: WRAPUP_CARD_NOT_WRITTEN }
            }
        },

        async handoff(input: HandoffSendInput): Promise<HandoffResult> {
            const archiveAfter = input.archive_after === true
            let delivery: HandoffDelivery = 'failed'
            let error: string | undefined
            let machine: string | undefined
            try {
                const result = await deps.sendPeer({
                    to: input.to, body: formatHandoffBody(input.summary, input.artifacts), purpose: 'handoff',
                    ...(input.machine_id ? { machineId: input.machine_id } : {}),
                })
                delivery = handoffDelivery(result)
                if (delivery === 'failed') error = result.error ?? `session is ${result.status}`
                machine = result.machine?.host
            } catch (e) {
                error = errorText(e)
            }
            const outcome: HandoffOutcome = {
                to: input.to, ...(input.to_title ? { toTitle: input.to_title } : {}), summary: input.summary,
                ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
                delivery, ...(error ? { error } : {}), ...(machine ? { machine } : {}), archiveAfter,
            }
            const run = running.get('handoff')
            let card = false
            try {
                await post(buildHandoffPost(deps.sessionId(), outcome, run, now(), requestId()))
                card = true
            } catch (e) {
                log(`[wrapup] handoff card not posted: ${errorText(e)}`)
            }
            if (running.get('handoff') === run) running.delete('handoff')
            const archive = shouldArchiveAfterHandoff({ archiveAfter, delivery })
            if (archive) pendingArchive = { outcome, run }
            const note = delivery === 'delivered'
                ? `Delivered to ${input.to}${machine ? ` on ${machine}` : ''}.${archive ? ' This session is archived when this turn ends: finish the turn now and start no new work.' : ' Start no new work here.'}`
                : delivery === 'offline-stored'
                    ? `${input.to} is not running; the handoff is stored and read at its next turn.${archiveAfter ? ' This session is NOT archived (delivery to a live session was not confirmed).' : ''}`
                    : `Handoff NOT delivered: ${error}.${archiveAfter ? ' This session is NOT archived.' : ''} Tell the user.`
            return {
                to: input.to, delivery, ...(error ? { error } : {}), ...(machine ? { machine } : {}), card,
                archive: archive ? 'scheduled' : archiveAfter ? 'skipped-unconfirmed' : 'not-requested',
                note,
            }
        },

        /** The turn is over (Claude `turn-ended`, any runner's `ready`): run a scheduled self-archive once. */
        onTurnEnd(): Promise<void> {
            const pending = pendingArchive
            pendingArchive = null
            if (!pending) return work
            return queue(async () => {
                try {
                    await post(buildHandoffPost(deps.sessionId(), { ...pending.outcome, archived: true }, pending.run, now(), requestId()))
                } catch (error) {
                    log(`[wrapup] archived mark not posted: ${errorText(error)}`)
                }
                await deps.archiveSelf(deps.sessionId())
            })
        },

        /** Settles once queued board writes / the archive are done (tests, shutdown). */
        idle: () => work,
        /** Test hook: the running action of a mode. */
        runningAction: (mode: BuiltinMode) => running.get(mode) ?? null,
    }
}
export type WrapupTracker = ReturnType<typeof createWrapupTracker>
