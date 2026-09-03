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
 */

import axios from 'axios'
import { configuration } from '@/configuration'
import { decodeBase64, decrypt } from '@/api/encryption'
import { listDaemonSessions, stopDaemonSession } from '@/daemon/controlClient'
import { readCredentialsForConfiguredRelay, readPersistedSessions, type PersistedSession } from '@/persistence'
import { sessionWebUrl } from '@/commands/sessionMessage'
import { formatTranscript } from '@/assistant/transcript'

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
