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
        summaries.push(toSummary(id, persisted[id], {
            live: true,
            pid: typeof child.pid === 'number' ? child.pid : undefined,
        }))
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
    /** Role-tagged, truncated transcript text (empty when nothing readable). */
    transcript: string
}

async function bearerToken(): Promise<string> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) throw new Error('CLI is not authenticated (no ~/.happy/access.key)')
    return credentials.token
}

/**
 * Read the tail of a session as a compact transcript.
 *
 * Throws when there is no local key: without it the messages cannot be
 * decrypted, and that is a different failure from "the session is empty".
 */
export async function readSessionTranscript(sessionId: string, limit: number): Promise<SessionTranscript> {
    const persisted = readPersistedSessions()[sessionId]
    if (!persisted) {
        throw new Error(
            `No local key for session ${sessionId} — it was not spawned by this machine's daemon (or is older than 14 days).`,
        )
    }
    const bounded = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit)))
    const token = await bearerToken()
    const response = await axios.get(
        `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
            params: { before_seq: 2147483647, limit: bounded },
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
    const bodies = messages.map((message) => {
        if (message.content?.t !== 'encrypted') return null
        try {
            return decrypt(key, persisted.encryptionVariant, decodeBase64(message.content.c))
        } catch {
            return null
        }
    })
    return {
        summary: toSummary(sessionId, persisted, { live: false }),
        messageCount: messages.length,
        transcript: formatTranscript(bodies),
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
