/**
 * Session operations shared by the assistant's MCP tools and the
 * `very-happy sessions` CLI (B-304).
 *
 * Both surfaces answer the same four questions about sessions this machine
 * spawned — what is there, what did it say, stop it, archive it — so the
 * transport lives here once and each surface only formats the result. The
 * assistant renders one line of prose per session for an LLM; the CLI renders
 * a table or JSON for a script.
 *
 * Everything here is scoped to THIS machine: `listDaemonSessions` asks the
 * local daemon, and reads need the session key from `~/.happy/sessions.json`,
 * which only exists for sessions this machine's daemon spawned.
 *
 * `mergeSessionSummaries` is deliberately pure (live + persisted in, sorted
 * list out) so the ordering, the terminal-mirror exclusion and the tag filter
 * are unit-testable without a daemon or a server.
 *
 * `listAccountSessions` (`sessions list --all`) widens the *listing* to the
 * whole account over REST, but not the *reading*: the server stores session
 * `metadata` and `agentState` encrypted with the per-session key
 * (`happy-server/sources/app/api/routes/sessionRoutes.ts` returns the
 * ciphertext strings as-is), and a CLI holding `dataKey` credentials
 * (`persistence.ts` `Credentials.encryption`: publicKey + machineKey only) can
 * unwrap only the keys it persisted itself in `~/.happy/sessions.json`. So a
 * row from another machine is reported with `decryptable: false` and just the
 * server's plaintext columns (active / archived / timestamps). Full-fidelity
 * cross-machine rows need the CLI to hold the account content key — a
 * credentials change, tracked separately, not something this listing can
 * paper over.
 */

import axios from 'axios'
import { configuration } from '@/configuration'
import { decodeBase64, decrypt } from '@/api/encryption'
import { listDaemonSessions, stopDaemonSession } from '@/daemon/controlClient'
import { readCredentialsForConfiguredRelay, readPersistedSessions, type PersistedSession } from '@/persistence'
import { sessionWebUrl } from '@/commands/sessionMessage'
import { formatTranscript } from '@/assistant/transcript'
import { analyzeLatestTurn, type LogEntry, type TurnState } from '@/sessions/turnState'
import { pendingRequestsOf, type PendingPermissionRequest } from '@/sessions/permissionOps'
import type { AgentState, Metadata } from '@/api/types'

/** Client tag on the REST calls these operations make. */
const SESSION_OPS_CLIENT = 'session-ops'

/** Recently-seen (not currently running) sessions included in a listing. */
export const DEFAULT_RECENT_LIMIT = 15

/** Hard ceiling on how many messages one read may pull. */
export const MAX_READ_LIMIT = 100

export interface SessionSummary {
    id: string
    /** The local daemon is currently tracking a process for this session. */
    live: boolean
    pid?: number
    title?: string
    cwd?: string
    /** Backend that runs it: claude / codex / gemini / … */
    flavor?: string
    /** Origin tag(s) the session was born with — see spawnOriginTags (B-303). */
    tags?: string[]
    /** 'assistant' for the meta-agent itself. */
    variant?: string
    url: string
    savedAt?: number
}

export interface ListSessionsOptions {
    /** Keep only sessions carrying this tag (exact match). */
    tag?: string
    /** How many NOT-running sessions to include (running ones are never cut). */
    recentLimit?: number
}

/** Shape of one entry from the daemon's `/list`, narrowed to what we use. */
export interface LiveSessionLike {
    happySessionId?: unknown
    pid?: unknown
}

/**
 * Merge the daemon's live children with the locally persisted sessions.
 *
 * Running sessions come first (in the daemon's order), then the most recently
 * saved ones. Terminal-mirror shadow sessions are excluded: they are read-only
 * mirrors of what the user is already doing in a terminal, so listing them as
 * dispatchable work is wrong for both surfaces (B-105).
 */
export function mergeSessionSummaries(
    live: readonly LiveSessionLike[],
    persisted: Readonly<Record<string, PersistedSession>>,
    options: ListSessionsOptions = {},
): SessionSummary[] {
    const recentLimit = Math.max(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT)
    const seen = new Set<string>()
    const summaries: SessionSummary[] = []

    for (const child of live) {
        const id = typeof child.happySessionId === 'string' ? child.happySessionId : undefined
        if (!id || seen.has(id)) continue
        seen.add(id)
        summaries.push(toSummary(id, persisted[id], livenessOf(child)))
    }

    const rest = Object.entries(persisted)
        .filter(([id]) => !seen.has(id))
        .filter(([, entry]) => entry.metadata?.flavor !== 'terminal-mirror')
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, recentLimit)
    for (const [id, entry] of rest) {
        summaries.push(toSummary(id, entry, { live: false }))
    }

    if (!options.tag) return summaries
    const wanted = options.tag
    return summaries.filter((summary) => summary.tags?.includes(wanted) === true)
}

function livenessOf(child: LiveSessionLike): { live: boolean; pid?: number } {
    return { live: true, pid: typeof child.pid === 'number' ? child.pid : undefined }
}

/**
 * The liveness part of one session's summary from the daemon's `/list`. The
 * single source `sessions list` and `sessions read` share, so a poller that
 * only calls `read` sees the same `live`/`pid` as `list` (an unreachable daemon
 * lists nothing, so both degrade to `live: false` together).
 */
export function sessionLiveness(live: readonly LiveSessionLike[], sessionId: string): { live: boolean; pid?: number } {
    const child = live.find((entry) => entry.happySessionId === sessionId)
    return child ? livenessOf(child) : { live: false }
}

function toSummary(
    id: string,
    persisted: PersistedSession | undefined,
    extra: { live: boolean; pid?: number },
): SessionSummary {
    const meta = persisted?.metadata as (PersistedSession['metadata'] & { variant?: string }) | undefined
    return {
        id,
        live: extra.live,
        ...(extra.pid !== undefined ? { pid: extra.pid } : {}),
        ...(meta?.summary?.text ? { title: meta.summary.text } : {}),
        ...(meta?.path ? { cwd: meta.path } : {}),
        ...(meta?.flavor ? { flavor: meta.flavor } : {}),
        ...(meta?.tags?.length ? { tags: [...meta.tags] } : {}),
        ...(meta?.variant ? { variant: meta.variant } : {}),
        url: sessionWebUrl(id),
        ...(persisted?.savedAt !== undefined ? { savedAt: persisted.savedAt } : {}),
    }
}

/** Sessions on this machine: currently running plus recently seen. */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const live = await listDaemonSessions()
    return mergeSessionSummaries(live as LiveSessionLike[], readPersistedSessions(), options)
}

/** One row of the server's `/v1/sessions` list, narrowed to what we use. Ciphertext stays ciphertext here. */
export interface AccountSessionRow {
    id: string
    active: boolean
    activeAt?: number
    updatedAt?: number
    createdAt?: number
    archivedAt?: number | null
    /** base64 ciphertext (session key). */
    metadata: string
    /** base64 ciphertext (session key) or null. */
    agentState: string | null
}

/**
 * A `--all` row. Superset of `SessionSummary` so `--json` consumers of the
 * local listing keep every field they already read; the new fields only add.
 */
export interface AccountSessionSummary extends SessionSummary {
    /**
     * Whether THIS machine could decrypt the row. False means the session
     * belongs to a machine whose key is not in ~/.happy/sessions.json: only
     * the server's plaintext columns below are meaningful, and title / cwd /
     * machineId / pending are absent because they are unreadable, not empty.
     */
    decryptable: boolean
    /** Server-side `active` flag (the wrapper deactivates on exit). */
    active: boolean
    archived: boolean
    activeAt?: number
    updatedAt?: number
    /** Which machine's daemon owns the session (from decrypted metadata). */
    machineId?: string
    /** Pending permission / question requests, oldest first (decryptable rows only). */
    pending?: PendingPermissionRequest[]
    /** True when at least one request is pending — the "needs a human" signal. */
    attention: boolean
}

/**
 * Pure: fold one server row + what this machine knows into a summary.
 *
 * `liveIds` are the local daemon's running children — the only source of
 * `live`; another machine's running sessions are `live: false` here because
 * this daemon is not running them, while `active` still tells whether SOME
 * wrapper is attached server-side.
 */
export function summarizeAccountSession(
    row: AccountSessionRow,
    persisted: PersistedSession | undefined,
    liveIds: ReadonlySet<string>,
    now: number,
): AccountSessionSummary {
    const base: AccountSessionSummary = {
        id: row.id,
        live: liveIds.has(row.id),
        url: sessionWebUrl(row.id),
        decryptable: false,
        active: row.active === true,
        archived: typeof row.archivedAt === 'number',
        ...(typeof row.activeAt === 'number' ? { activeAt: row.activeAt } : {}),
        ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
        attention: false,
    }
    if (!persisted) return base

    const key = decodeBase64(persisted.encryptionKey)
    let metadata: Metadata | null = null
    let agentState: AgentState | null = null
    try {
        metadata = row.metadata ? decrypt(key, persisted.encryptionVariant, decodeBase64(row.metadata)) as Metadata | null : null
        agentState = row.agentState ? decrypt(key, persisted.encryptionVariant, decodeBase64(row.agentState)) as AgentState | null : null
    } catch {
        // A key we hold that does not open this row is a corrupt entry, not a
        // foreign machine — but the caller cannot tell the difference and
        // must not be shown ciphertext-derived garbage either.
        return base
    }
    if (!metadata) return base

    const meta = metadata as Metadata & { variant?: string }
    const pending = pendingRequestsOf(agentState, now)
    return {
        ...base,
        decryptable: true,
        ...(meta.summary?.text ? { title: meta.summary.text } : {}),
        ...(meta.path ? { cwd: meta.path } : {}),
        ...(meta.flavor ? { flavor: meta.flavor } : {}),
        ...(meta.tags?.length ? { tags: [...meta.tags] } : {}),
        ...(meta.variant ? { variant: meta.variant } : {}),
        ...(meta.machineId ? { machineId: meta.machineId } : {}),
        ...(persisted.savedAt !== undefined ? { savedAt: persisted.savedAt } : {}),
        pending,
        attention: pending.length > 0,
    }
}

/**
 * Pure: order and filter the account-wide list.
 *
 * Attention first (longest-waiting request first), then running-here, then
 * everything else newest-first. Terminal-mirror shadows are dropped for the
 * same reason as in `mergeSessionSummaries`. `--tag` can only match rows we
 * could decrypt, so it implicitly hides foreign rows — a filter that cannot
 * be evaluated is a miss, not a match. `recentLimit` caps only the idle tail,
 * as in the local listing: attention and running rows are never cut.
 */
export function orderAccountSessions(
    summaries: readonly AccountSessionSummary[],
    options: ListSessionsOptions = {},
): AccountSessionSummary[] {
    const oldestWait = (summary: AccountSessionSummary) =>
        Math.max(0, ...(summary.pending ?? []).map((request) => request.waitingMs ?? 0))
    const rank = (summary: AccountSessionSummary) => summary.attention ? 0 : summary.live ? 1 : 2
    let rows = summaries
        .filter((summary) => summary.flavor !== 'terminal-mirror')
        .slice()
        .sort((a, b) => {
            const byRank = rank(a) - rank(b)
            if (byRank !== 0) return byRank
            if (a.attention && b.attention) return oldestWait(b) - oldestWait(a)
            return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        })
    if (options.tag) {
        const wanted = options.tag
        rows = rows.filter((summary) => summary.tags?.includes(wanted) === true)
    }
    const recentLimit = Math.max(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT)
    let idleKept = 0
    return rows.filter((summary) => rank(summary) < 2 || idleKept++ < recentLimit)
}

export interface ListAccountSessionsOptions extends ListSessionsOptions {
    /** Include rows the server has already archived (default: hide them). */
    includeArchived?: boolean
}

/** Account-wide listing over REST (`/v1/sessions`, newest 150). See the header note on `decryptable`. */
export async function listAccountSessions(options: ListAccountSessionsOptions = {}): Promise<AccountSessionSummary[]> {
    const token = await bearerToken()
    const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
        },
        timeout: 15_000,
    })
    const rows: AccountSessionRow[] = Array.isArray(response.data?.sessions) ? response.data.sessions : []
    const persisted = readPersistedSessions()
    const live = await listDaemonSessions() as LiveSessionLike[]
    const liveIds = new Set(live.map((child) => child.happySessionId).filter((id): id is string => typeof id === 'string'))
    const now = Date.now()
    const summaries = rows
        .filter((row) => typeof row?.id === 'string')
        .map((row) => summarizeAccountSession(row, persisted[row.id], liveIds, now))
        .filter((summary) => options.includeArchived || !summary.archived)
    return orderAccountSessions(summaries, options)
}

export interface SessionTranscript {
    summary: SessionSummary
    /** How many messages the server actually returned. */
    messageCount: number
    /** Role-tagged transcript text (empty when nothing readable); truncated unless `full`. */
    transcript: string
    /** B-492: where the latest turn stands, and the agent's reply to the latest prompt. */
    turn: TurnState
}

async function bearerToken(): Promise<string> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) throw new Error('CLI is not authenticated (no ~/.happy/access.key)')
    return credentials.token
}

function requirePersisted(sessionId: string): PersistedSession {
    const persisted = readPersistedSessions()[sessionId]
    if (!persisted) {
        throw new Error(
            `No local key for session ${sessionId} — it was not spawned by this machine's daemon (or is older than 14 days).`,
        )
    }
    return persisted
}

/**
 * The newest `limit` messages of a session, decrypted, in ascending seq order.
 * Undecryptable entries come back with `body: null`.
 */
export async function readSessionLog(sessionId: string, persisted: PersistedSession, limit: number): Promise<LogEntry[]> {
    const token = await bearerToken()
    const response = await axios.get(
        `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
            params: { before_seq: 2147483647, limit },
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
            },
            timeout: 15_000,
        },
    )
    const messages: Array<{ seq: number; content: { t: string; c: string } }> =
        Array.isArray(response.data?.messages) ? response.data.messages : []
    // `before_seq` returns newest-first — flip to chronological order.
    messages.reverse()
    const key = decodeBase64(persisted.encryptionKey)
    return messages.map((message) => {
        if (message.content?.t !== 'encrypted') return { seq: message.seq, body: null }
        try {
            return { seq: message.seq, body: decrypt(key, persisted.encryptionVariant, decodeBase64(message.content.c)) }
        } catch {
            return { seq: message.seq, body: null }
        }
    })
}

/**
 * How many messages turn analysis looks at. The server caps a page at 500; a
 * single turn longer than that (hundreds of tool calls) falls back to the last
 * turn marker — see analyzeLatestTurn.
 */
export const TURN_WINDOW = 500

/**
 * Read the tail of a session as a compact transcript.
 *
 * Throws when there is no local key: without it the messages cannot be
 * decrypted, and that is a different failure from "the session is empty".
 */
export async function readSessionTranscript(sessionId: string, limit: number, options: { full?: boolean } = {}): Promise<SessionTranscript> {
    const persisted = requirePersisted(sessionId)
    const bounded = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit)))
    // One fetch serves both: the transcript shows the newest `bounded`
    // entries, turn analysis needs a wider window to find the prompt.
    const entries = await readSessionLog(sessionId, persisted, Math.max(bounded, TURN_WINDOW))
    const shown = entries.slice(-bounded)
    // Same daemon `/list` merge as `sessions list`; unreachable daemon → [] → live: false.
    const live = await listDaemonSessions() as LiveSessionLike[]
    return {
        summary: toSummary(sessionId, persisted, sessionLiveness(live, sessionId)),
        messageCount: shown.length,
        transcript: formatTranscript(shown.map((entry) => entry.body), { full: options.full }),
        turn: analyzeLatestTurn(entries),
    }
}

/**
 * The session's CURRENT metadata from the server, decrypted with the local key
 * (B-492). `~/.happy/sessions.json` holds the metadata from spawn time, before
 * the wrapper learned its Claude conversation / Codex thread id — a fork needs
 * the live value. Returns null when the server row has no metadata.
 */
export async function readSessionMetadata(sessionId: string, persisted: PersistedSession): Promise<Metadata | null> {
    const token = await bearerToken()
    const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
        },
        timeout: 15_000,
    })
    const ciphertext = response.data?.session?.metadata
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) return null
    return decrypt(decodeBase64(persisted.encryptionKey), persisted.encryptionVariant, decodeBase64(ciphertext)) as Metadata | null
}

/**
 * B-501: the server's plaintext lifecycle columns for one session — what
 * `deliverToSession` classifies as live / archived / offline / not_found.
 * `found: false` is the 404 (not on this account, or deleted); it is a state,
 * not an exception, because a caller wants to report it, not crash on it.
 */
export interface SessionServerState {
    found: boolean
    /** Server-side `active` flag (a wrapper is attached; presence timeout clears it after 10 min). */
    active: boolean
    /** `lastActiveAt` (ms). */
    activeAt?: number
    /** Set when the session is archived (the explicit lifecycle end). */
    archivedAt?: number | null
    updatedAt?: number
    /** Owning daemon, from the decrypted metadata — only when `persisted` was given. */
    machineId?: string
}

/**
 * `GET /v1/sessions/:id` narrowed to lifecycle columns. Same bearer / client
 * tag as `readSessionMetadata`; decrypts `metadata.machineId` only when the
 * local key is passed. Throws on transport / auth errors, NOT on 404.
 */
export async function readSessionState(sessionId: string, persisted?: PersistedSession): Promise<SessionServerState> {
    const token = await bearerToken()
    const response = await axios.get(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
        },
        timeout: 15_000,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
    })
    if (response.status === 404) return { found: false, active: false }
    const row = response.data?.session as Partial<AccountSessionRow> | undefined
    if (!row || typeof row.id !== 'string') throw new Error(`Server returned no session row for ${sessionId}`)
    const state: SessionServerState = {
        found: true,
        active: row.active === true,
        ...(typeof row.activeAt === 'number' ? { activeAt: row.activeAt } : {}),
        archivedAt: typeof row.archivedAt === 'number' ? row.archivedAt : null,
        ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
    }
    if (persisted && typeof row.metadata === 'string' && row.metadata.length > 0) {
        try {
            const metadata = decrypt(decodeBase64(persisted.encryptionKey), persisted.encryptionVariant, decodeBase64(row.metadata)) as Metadata | null
            if (metadata?.machineId) state.machineId = metadata.machineId
        } catch {
            // Undecryptable metadata does not change the lifecycle answer.
        }
    }
    return state
}

export class TurnWaitTimeoutError extends Error {
    constructor(readonly sessionId: string, readonly timeoutMs: number, readonly turn: TurnState) {
        super(`Session ${sessionId}: the latest turn did not end within ${Math.round(timeoutMs / 1000)}s`)
    }
}

/**
 * Poll until the latest turn has ended (B-492 `sessions read --wait`), then
 * return its state. Throws TurnWaitTimeoutError (carrying the last state seen)
 * when `timeoutMs` passes first.
 */
export async function waitForTurnEnd(
    sessionId: string,
    options: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<TurnState> {
    const persisted = requirePersisted(sessionId)
    const pollMs = options.pollMs ?? 3_000
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const deadline = Date.now() + options.timeoutMs
    while (true) {
        const turn = analyzeLatestTurn(await readSessionLog(sessionId, persisted, TURN_WINDOW))
        if (turn.ended) return turn
        if (Date.now() + pollMs > deadline) throw new TurnWaitTimeoutError(sessionId, options.timeoutMs, turn)
        await sleep(pollMs)
    }
}

/** SIGTERM the session's process via the local daemon. False = not running. */
export async function stopSession(sessionId: string): Promise<boolean> {
    return await stopDaemonSession(sessionId)
}

/** Mark the session inactive server-side. It stays resumable. */
export async function archiveSession(sessionId: string): Promise<void> {
    const token = await bearerToken()
    await axios.post(
        `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
        {},
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
            },
            timeout: 10_000,
        },
    )
}

/**
 * B-501: clear `archivedAt` so a wrapper may attach again (the server rejects
 * the socket of an archived session). Same route the web's 「恢复」 uses before
 * `resume-happy-session`; the session stays `active: false` until the resumed
 * wrapper reactivates it.
 */
export async function unarchiveSession(sessionId: string): Promise<void> {
    const token = await bearerToken()
    await axios.post(
        `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/unarchive`,
        {},
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Happy-Client': `${SESSION_OPS_CLIENT}/${configuration.currentCliVersion}`,
            },
            timeout: 10_000,
        },
    )
}
