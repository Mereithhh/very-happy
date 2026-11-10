/**
 * B-915: ask a session to wrap up / hand off — the shared path of the
 * `session_wrapup` / `session_handoff` MCP tools and
 * `very-happy sessions wrapup|handoff` (the main agent's entry, B-910).
 *
 * It sends ONE ordinary user turn (same text the Web menu sends, built by the
 * wire's `buildWrapupPrompt` / `buildHandoffPrompt`) with a `wrapup-` /
 * `handoff-` localId and a short `meta.displayText`. The target wrapper turns
 * that localId into a `running` card; the agent's `wrapup_report` /
 * `handoff_send` fills in the result.
 *
 * Receipt per session: `queued` (the turn reached a live wrapper), `running`
 * (its card of that mode is already `running` and fresh — `wrapupInProgress`
 * — so nothing was sent: batch callers may repeat a call safely) or `error`.
 * A server without the board skips the running check (nothing to read).
 * `requestId` makes a retried call reuse its localIds: the server stores one
 * message per (session, localId), so a retry after an unknown outcome cannot
 * deliver twice.
 *
 * Delivery: a session this machine holds the key for goes through
 * `deliverToSession` (live check before and after the POST); any other
 * session through its own machine's daemon (B-506 `sessions.send`). An
 * offline (hibernated / exited) session is resumed on its machine first and
 * the turn sent once it is live — the main agent's nightly batch targets
 * sessions idle for hours, past the hibernation threshold. An archived one is
 * refused instead (a wrap-up request must not unarchive it). The target must
 * be an existing session — to hand off to a new one, spawn it first.
 */

import { createHash, randomUUID } from 'node:crypto'
import axios from 'axios'
import {
    buildHandoffPrompt, buildWrapupPrompt, decodeWrapupConfig, handoffDisplayText, handoffLocalId, HANDOFF_ITEM_KEY,
    resolveWrapupTemplate, WRAPUP_ITEM_KEY, WRAPUP_KV_KEY, wrapupDisplayText, wrapupInProgress, wrapupLocalId,
    type AttentionItem, type WrapupConfig,
} from '@slopus/happy-wire'
import { configuration } from '@/configuration'
import { readCredentialsForConfiguredRelay, readPersistedSessions, type PersistedSession } from '@/persistence'
import { isValidSessionId } from '@/assistant/ids'
import { deliverToSession, type DeliveryResult } from '@/commands/sessionDelivery'
import { sendUserMessage } from '@/commands/sessionMessage'
import { sendRemoteMessage } from '@/sessions/remoteSessionClient'
import { readSessionState, type SessionServerState } from '@/sessions/sessionOps'
import { AttentionUnsupportedError, sharedAttentionClient } from '@/attention/client'
import type { BuiltinMode } from './report'

export type BuiltinRequestState = 'queued' | 'running' | 'error'

export interface BuiltinRequestResult {
    sessionId: string
    state: BuiltinRequestState
    error?: string
}

/** `meta.sentFrom` of these turns: not the owner typing (no owner question item). */
const SENT_FROM = 'cli'
const CLIENT_TAG = 'cli-wrapup'
const NOT_LIVE_HINT = 'It could not be woken on its machine; open it in the Web, then ask again.'

type DeliverOptions = { localId: string; displayText: string; resume: boolean }

export interface BuiltinRequestDeps {
    /** Open board items of a session; [] when the server has no board. */
    openItems: (sessionId: string) => Promise<Pick<AttentionItem, 'kind' | 'key' | 'state' | 'updatedAt' | 'payload'>[]>
    readConfig: () => Promise<WrapupConfig>
    readPersisted: () => Record<string, PersistedSession>
    /** Lifecycle columns (`GET /v1/sessions/:id`): archived / missing targets are refused before anything is sent. */
    readState: (sessionId: string) => Promise<Pick<SessionServerState, 'found' | 'archivedAt'>>
    deliverLocal: (sessionId: string, persisted: PersistedSession, text: string, options: DeliverOptions) => Promise<DeliveryResult>
    deliverRemote: (sessionId: string, text: string, options: DeliverOptions) => Promise<DeliveryResult>
    now: () => number
    nonce: () => string
}

async function defaultOpenItems(sessionId: string) {
    try {
        return (await sharedAttentionClient().list({ sessionId, state: 'open', limit: 50 })).items
    } catch (error) {
        if (error instanceof AttentionUnsupportedError) return []
        throw error
    }
}

/** The account's template (KV `vh.wrapup.v1`); defaults when unset or unreadable. */
export async function readWrapupConfig(): Promise<WrapupConfig> {
    try {
        const credentials = await readCredentialsForConfiguredRelay()
        if (!credentials) return { template: null }
        const response = await axios.get(`${configuration.serverUrl}/v1/kv/${encodeURIComponent(WRAPUP_KV_KEY)}`, {
            headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': `${CLIENT_TAG}/${configuration.currentCliVersion}` },
            timeout: 5_000,
            validateStatus: (s) => s === 200 || s === 404,
        })
        return response.status === 200 ? decodeWrapupConfig((response.data as { value?: string })?.value) : { template: null }
    } catch {
        return { template: null }
    }
}

export function defaultBuiltinRequestDeps(): BuiltinRequestDeps {
    return {
        openItems: defaultOpenItems,
        readConfig: readWrapupConfig,
        readPersisted: readPersistedSessions,
        readState: (sessionId) => readSessionState(sessionId),
        deliverLocal: (sessionId, persisted, text, options) => deliverToSession(sessionId, persisted, text, CLIENT_TAG, { sentFrom: SENT_FROM, resumeHint: NOT_LIVE_HINT, resume: options.resume }, {
            send: (id, key, body, client, opts) => sendUserMessage(id, key, body, client, { ...opts, localId: options.localId, displayText: options.displayText }),
        }),
        deliverRemote: (sessionId, text, options) => sendRemoteMessage(sessionId, text, { sentFrom: SENT_FROM, localId: options.localId, displayText: options.displayText, resume: options.resume }),
        now: Date.now,
        nonce: () => randomUUID(),
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** localId nonce: derived from the caller's request id (retry-safe) or random. */
export function builtinNonce(requestId: string | undefined, mode: BuiltinMode, sessionId: string, random: () => string): string {
    if (!requestId) return random()
    return createHash('sha256').update(`${mode}\n${sessionId}\n${requestId}`).digest('hex').slice(0, 32)
}

async function inProgress(deps: BuiltinRequestDeps, sessionId: string, mode: BuiltinMode): Promise<boolean> {
    const key = mode === 'wrapup' ? WRAPUP_ITEM_KEY : HANDOFF_ITEM_KEY
    const items = await deps.openItems(sessionId)
    return items.some((item) => item.key === key && wrapupInProgress(item, mode, deps.now()))
}

/** Send one built-in turn; never throws (a refusal is a receipt with `error`). */
async function sendTurn(deps: BuiltinRequestDeps, sessionId: string, mode: BuiltinMode, text: string, displayText: string, requestId: string | undefined): Promise<BuiltinRequestResult> {
    const nonce = builtinNonce(requestId, mode, sessionId, deps.nonce)
    const localId = mode === 'wrapup' ? wrapupLocalId(nonce) : handoffLocalId(nonce)
    try {
        if (await inProgress(deps, sessionId, mode)) return { sessionId, state: 'running' }
        const state = await deps.readState(sessionId)
        if (!state.found) return { sessionId, state: 'error', error: `Session ${sessionId} was not found on this account` }
        if (typeof state.archivedAt === 'number') return { sessionId, state: 'error', error: `Session ${sessionId} is archived; restore it first if it should still ${mode === 'wrapup' ? 'wrap up' : 'hand off'}` }
        const persisted = deps.readPersisted()[sessionId]
        // Offline (hibernated / exited) → resumed on its machine, then sent once live.
        const options: DeliverOptions = { localId, displayText, resume: true }
        const result = persisted
            ? await deps.deliverLocal(sessionId, persisted, text, options)
            : await deps.deliverRemote(sessionId, text, options)
        if (result.delivered) return { sessionId, state: 'queued' }
        const stored = result.stored ? ' (the request is stored server-side and runs if the session comes back)' : ''
        return { sessionId, state: 'error', error: `${result.error ?? `session is ${result.status}`}${stored}` }
    } catch (error) {
        return { sessionId, state: 'error', error: message(error) }
    }
}

export interface WrapupRequest {
    /** Overrides the account template for this request (the protocol tail is still added). */
    template?: string
    requestId?: string
    /** The calling session: refused (an agent wraps itself up by just doing it). */
    self?: string
}

/** Ask each session to wrap up, in order, one at a time (duplicates collapse). */
export async function requestWrapup(sessionIds: readonly string[], request: WrapupRequest = {}, overrides: Partial<BuiltinRequestDeps> = {}): Promise<BuiltinRequestResult[]> {
    const deps = { ...defaultBuiltinRequestDeps(), ...overrides }
    const config = await deps.readConfig()
    const lang = config.lang ?? 'en'
    const custom = request.template?.trim()
    const text = buildWrapupPrompt(custom ? custom : resolveWrapupTemplate(config, 'en'))
    const results: BuiltinRequestResult[] = []
    for (const sessionId of [...new Set(sessionIds)]) {
        if (!isValidSessionId(sessionId)) { results.push({ sessionId, state: 'error', error: 'Invalid session id' }); continue }
        if (sessionId === request.self) { results.push({ sessionId, state: 'error', error: 'That is this session; wrap it up yourself instead' }); continue }
        results.push(await sendTurn(deps, sessionId, 'wrapup', text, wrapupDisplayText(lang), request.requestId))
    }
    return results
}

export interface HandoffRequest {
    from: string
    /** An existing session (handing off to a new one: spawn it first). */
    to: string
    toTitle?: string
    /** Machine of the TARGET (`to`), quoted to the source so its `handoff_send` skips the lookup. */
    machineId?: string
    archiveAfter?: boolean
    note?: string
    requestId?: string
}

/** Ask `from` to hand its work over to `to`. */
export async function requestHandoff(request: HandoffRequest, overrides: Partial<BuiltinRequestDeps> = {}): Promise<BuiltinRequestResult> {
    const deps = { ...defaultBuiltinRequestDeps(), ...overrides }
    if (!isValidSessionId(request.from)) return { sessionId: request.from, state: 'error', error: 'Invalid session id (from)' }
    if (!isValidSessionId(request.to)) return { sessionId: request.from, state: 'error', error: 'Invalid session id (to): it must be an existing session (to hand off to a new one, spawn it first)' }
    if (request.from === request.to) return { sessionId: request.from, state: 'error', error: 'from and to are the same session' }
    const config = await deps.readConfig()
    const text = buildHandoffPrompt({
        to: { id: request.to, title: request.toTitle ?? null, machineId: request.machineId ?? null },
        archiveAfter: request.archiveAfter === true,
        note: request.note ?? null,
    })
    return sendTurn(deps, request.from, 'handoff', text, handoffDisplayText(config.lang ?? 'en', request.toTitle), request.requestId)
}
