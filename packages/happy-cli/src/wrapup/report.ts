/**
 * B-915 「收尾」/「交接给…」— pure pieces of the wrapper side: the MCP input
 * schemas and the owner-board posts they turn into. The posts follow the
 * wire contract (`AttentionWrapupPayloadSchema`, `happy-wire/src/attention.ts`;
 * prompts and keys in `happy-wire/src/wrapup.ts`).
 *
 * One card per session and mode (`key` wrapup / handoff): the wrapper posts
 * a `running` card when a wrap-up / handoff turn arrives, the agent's
 * `wrapup_report` / `handoff_send` reposts it with the result.
 */

import {
    ATTENTION_LIMITS, HANDOFF_ITEM_KEY, WRAPUP_ITEM_KEY, WRAPUP_LIMITS, WRAPUP_TEMPLATE_MAX_CHARS, WrapupCommitSchema,
    type AttentionItemPost, type AttentionWrapupPayload,
} from '@slopus/happy-wire'
import { z } from 'zod'

export type BuiltinMode = 'wrapup' | 'handoff'
export type HandoffDelivery = 'delivered' | 'offline-stored' | 'failed'

/** The turn that asked for a wrap-up / handoff (from its `wrapup-` / `handoff-` localId). */
export interface RunningAction {
    mode: BuiltinMode
    localId: string
    startedAt: number
}

const path = z.string().trim().min(1).max(WRAPUP_LIMITS.pathChars)
const sessionId = z.string().trim().min(1).max(128)
const requestId = z.string().trim().min(1).max(128).describe('Unique id of this call; repeat it with the same arguments when the outcome was unknown (the same turn is never sent twice)')

export const WRAPUP_REPORT_INPUT = {
    summary: z.string().trim().min(1).max(WRAPUP_LIMITS.summaryChars).describe('What this session did, a few lines (the card shows the first three)'),
    files: z.array(path).max(WRAPUP_LIMITS.files).optional().describe('Paths you created or changed'),
    commits: z.array(WrapupCommitSchema).max(WRAPUP_LIMITS.commits).optional().describe('Commits made in this session: sha (7-64 hex), subject, repo (owner/name or remote URL) when known'),
    pending: z.array(z.string().trim().min(1).max(WRAPUP_LIMITS.pendingChars)).max(WRAPUP_LIMITS.pending).optional()
        .describe('Short items that need the user\'s confirmation or are left undone; each becomes a checkbox'),
    can_close: z.boolean().describe('true when nothing here still needs this session'),
    artifacts: z.array(path).max(WRAPUP_LIMITS.artifacts).optional().describe('Other outputs worth keeping: docs, reports, screenshots, PR links'),
}
export const WrapupReportInputSchema = z.object(WRAPUP_REPORT_INPUT)
export type WrapupReportInput = z.infer<typeof WrapupReportInputSchema>

/** `handoff_send`: this session hands its own work over. */
export const HANDOFF_SEND_INPUT = {
    to: sessionId.describe('Session id that takes the work over'),
    to_title: z.string().trim().max(WRAPUP_LIMITS.titleChars).optional().describe('Its title, for the card'),
    machine_id: z.string().trim().min(1).max(128).optional().describe('Machine the target runs on, when known'),
    summary: z.string().trim().min(1).max(12_000).describe('The handoff summary: goal, done, current state, next steps, open questions'),
    artifacts: z.array(path).max(WRAPUP_LIMITS.artifacts).optional().describe('Artifact paths (files, branches, PRs, docs) the target needs'),
    archive_after: z.boolean().optional().describe('Archive this session once delivery to a live session is confirmed (default false)'),
}
export const HandoffSendInputSchema = z.object(HANDOFF_SEND_INPUT)
export type HandoffSendInput = z.infer<typeof HandoffSendInputSchema>

/** `session_wrapup` batch cap: one call stays well inside the 30 s RPC budget per remote target. */
export const SESSION_WRAPUP_MAX_IDS = 20
export const SESSION_WRAPUP_INPUT = {
    session_ids: z.array(sessionId).min(1).max(SESSION_WRAPUP_MAX_IDS).describe('Sessions to wrap up (1-20)'),
    template: z.string().trim().min(1).max(WRAPUP_TEMPLATE_MAX_CHARS).optional().describe('Use this text instead of the account\'s wrap-up template'),
    request_id: requestId.optional(),
}
export const SessionWrapupInputSchema = z.object(SESSION_WRAPUP_INPUT)
export type SessionWrapupInput = z.infer<typeof SessionWrapupInputSchema>

/** `session_handoff`: ask session `from` to hand its work over to `to`. */
export const SESSION_HANDOFF_INPUT = {
    from: sessionId.describe('Session that should hand its work over'),
    to: sessionId.describe('An existing session that takes it over (to hand off to a new session, spawn it first)'),
    to_title: z.string().trim().max(WRAPUP_LIMITS.titleChars).optional().describe('Title of the target, quoted in the request'),
    machine_id: z.string().trim().min(1).max(128).optional().describe('Machine the TARGET runs on, when known'),
    archive_after: z.boolean().optional().describe('The source archives itself after a confirmed delivery (default false)'),
    note: z.string().trim().max(2000).optional().describe('Extra instruction appended to the request'),
    request_id: requestId.optional(),
}
export const SessionHandoffInputSchema = z.object(SESSION_HANDOFF_INPUT)
export type SessionHandoffInput = z.infer<typeof SessionHandoffInputSchema>

function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Card title: the summary's first non-empty line. */
export function wrapupTitle(summary: string): string {
    const first = summary.split('\n').find((line) => line.trim()) ?? ''
    return clip(first, ATTENTION_LIMITS.titleChars) || 'Wrap-up'
}

function itemKey(mode: BuiltinMode): string {
    return mode === 'wrapup' ? WRAPUP_ITEM_KEY : HANDOFF_ITEM_KEY
}

function runningFields(mode: BuiltinMode, running: RunningAction | null | undefined, now: number): Pick<AttentionWrapupPayload, 'localId' | 'startedAt'> {
    return running && running.mode === mode ? { localId: running.localId, startedAt: running.startedAt } : { startedAt: now }
}

/** The card shown while the agent works through a wrap-up / handoff turn (not counted as waiting on the owner). */
export function buildRunningPost(session: string, action: RunningAction): AttentionItemPost {
    return {
        sessionId: session, source: 'agent', kind: 'wrapup', key: itemKey(action.mode),
        title: action.mode === 'wrapup' ? 'Wrapping up…' : 'Handing off…',
        payload: { v: 1, mode: action.mode, status: 'running', localId: action.localId, startedAt: action.startedAt },
        anchor: { localId: action.localId },
        // A replayed routed message reposts the same request: a no-op.
        requestId: `running-${action.localId}`.slice(0, 128),
    }
}

/** `wrapup_report` → the result card (pending items become unticked checkboxes p1…p10). */
export function buildWrapupReportPost(session: string, input: WrapupReportInput, running: RunningAction | null | undefined, now: number, requestId: string): AttentionItemPost {
    const run = runningFields('wrapup', running, now)
    return {
        sessionId: session, source: 'agent', kind: 'wrapup', key: WRAPUP_ITEM_KEY,
        title: wrapupTitle(input.summary),
        payload: {
            v: 1, mode: 'wrapup', status: 'done', ...run,
            summary: input.summary,
            ...(input.files?.length ? { files: input.files } : {}),
            ...(input.commits?.length ? { commits: input.commits } : {}),
            ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
            ...(input.pending?.length ? { pending: input.pending.map((label, i) => ({ id: `p${i + 1}`, label, checked: false })) } : {}),
            canClose: input.can_close,
        },
        ...(run.localId ? { anchor: { localId: run.localId } } : {}),
        requestId,
    }
}

export interface HandoffOutcome {
    to: string
    toTitle?: string
    summary: string
    artifacts?: string[]
    delivery: HandoffDelivery
    error?: string
    machine?: string
    archiveAfter: boolean
    archived?: boolean
}

/** `handoff_send` → the source session's card: delivered / stored / failed (red), with the archive intent. */
export function buildHandoffPost(session: string, outcome: HandoffOutcome, running: RunningAction | null | undefined, now: number, requestId: string): AttentionItemPost {
    const run = runningFields('handoff', running, now)
    const target = outcome.toTitle?.trim() || outcome.to
    return {
        sessionId: session, source: 'agent', kind: 'wrapup', key: HANDOFF_ITEM_KEY,
        title: clip(outcome.delivery === 'failed' ? `Handoff to ${target} failed` : `Handed off to ${target}`, ATTENTION_LIMITS.titleChars),
        payload: {
            v: 1, mode: 'handoff', status: outcome.delivery === 'failed' ? 'failed' : 'done', ...run,
            summary: outcome.summary.slice(0, WRAPUP_LIMITS.summaryChars),
            ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}),
            handoff: {
                to: outcome.to,
                ...(outcome.toTitle?.trim() ? { toTitle: outcome.toTitle.trim().slice(0, WRAPUP_LIMITS.titleChars) } : {}),
                delivery: outcome.delivery,
                ...(outcome.error ? { error: outcome.error.slice(0, WRAPUP_LIMITS.errorChars) } : {}),
                ...(outcome.machine ? { machine: outcome.machine.slice(0, WRAPUP_LIMITS.titleChars) } : {}),
                archiveAfter: outcome.archiveAfter,
                ...(outcome.archived ? { archived: true } : {}),
            },
        },
        ...(run.localId ? { anchor: { localId: run.localId } } : {}),
        requestId,
    }
}

/**
 * Lead 11-11: archive the source only after a confirmed delivery — this
 * machine's live wrapper took it, or the other machine's daemon acked it
 * (`delivered: true` either way). A message stored for a session that is not
 * running (`offline-stored`) or a failure never archives.
 */
export function shouldArchiveAfterHandoff(input: { archiveAfter: boolean; delivery: HandoffDelivery }): boolean {
    return input.archiveAfter && input.delivery === 'delivered'
}

/** The text the target receives: the summary plus an artifact list. */
export function formatHandoffBody(summary: string, artifacts: readonly string[] | undefined): string {
    const list = artifacts?.length ? `\n\nArtifacts:\n${artifacts.map((p) => `- ${p}`).join('\n')}` : ''
    return `${summary.trim()}${list}`
}
