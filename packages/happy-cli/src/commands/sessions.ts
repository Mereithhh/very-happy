/**
 * `very-happy sessions` — inspect and control sessions on this machine (B-304).
 *
 * The automation counterpart to `spawn`/`send`: those start work, these let an
 * external agent layer see it and intervene. Same four operations the built-in
 * assistant already had over MCP, now reachable without being the assistant —
 * the shared transport lives in `@/sessions/sessionOps`.
 *
 *   very-happy sessions list [--all] [--tag <name>] [--limit <n>] [--json]
 *   very-happy sessions read <id> [--limit <n>] [--full] [--answer] [--wait [--timeout <s>]] [--json]
 *   very-happy sessions stop <id> [--json]
 *   very-happy sessions archive <id> [--json]
 *   very-happy sessions approve <id> <requestId> [--for-session] [--json]
 *   very-happy sessions deny <id> <requestId> [--reason <text>] [--json]
 *   very-happy sessions peers [--scope repo|cwd|machine] [--cwd <dir>] [--json]
 *   very-happy sessions message <id> <text> [--reply-to <msgId>] [--json]
 *
 * `peers` / `message` (B-497) are the CLI face of the `session_peers` /
 * `session_message` MCP tools: who else is running here (same repo by
 * default, with the files each touched lately) and a message into one of
 * them that arrives tagged with the sender. Inside a managed session's shell
 * `HAPPY_SESSION_ID` makes that session the sender; otherwise the CLI is.
 *
 * Local first: the daemon's children plus the keys in ~/.happy/sessions.json.
 * A session another machine of the account spawned is reached through THAT
 * machine's daemon (B-506, `@/sessions/remoteSessionClient`): `read`,
 * `message`, `list --all` (foreign rows get filled in) and `peers --machine`
 * proxy the operation and this CLI never sees the key. The owning machine
 * must be online; `--machine <id>` names it, otherwise the online machines
 * are asked in turn. `list --all` still marks `decryptable` (this machine's
 * own key) and adds `readable` / `via` / `machine` for proxied rows.
 *
 * `approve` / `deny` answer a pending permission request the way the web's
 * permission card does (same RPC, same payload — `@/sessions/permissionOps`).
 * The payload is encrypted with the session key, so like `read` they need the
 * local key.
 *
 * Exit codes: 0 success, 1 anything else (bad args, unknown session, no local
 * key, transport failure). `stop` on a session the daemon is not running exits
 * 1 — a caller asking to stop something must be able to tell "stopped it" from
 * "there was nothing to stop". `approve`/`deny` on a request that is not
 * pending, or on a session with no wrapper online, also exit 1.
 */

import chalk from 'chalk'
import {
    archiveSession,
    DEFAULT_RECENT_LIMIT,
    listAccountSessions,
    listSessions,
    MAX_READ_LIMIT,
    readSessionTranscript,
    stopSession,
    TurnWaitTimeoutError,
    waitForTurnEnd,
    type AccountSessionSummary,
    type SessionSummary,
} from '@/sessions/sessionOps'
import { resolvePermissionRequest, type PermissionVerdict } from '@/sessions/permissionOps'
import { isValidSessionId } from '@/assistant/ids'
import { cliPeerSelf, listPeerSessions, sendPeerMessage, type PeerToolContext } from '@/sessions/peerTools'
import { PEER_SCOPES, type PeerScope } from '@/sessions/repoIdentity'
import { readPersistedSessions } from '@/persistence'
import { resolve as resolvePath } from 'node:path'
import {
    fillForeignAccountRows,
    listRemotePeers,
    listRemoteSessions,
    readRemoteTranscript,
    waitForRemoteTurnEnd,
} from '@/sessions/remoteSessionClient'

/** Machine ids are UUIDs the CLI minted (`randomUUID()`); accept the same URL-safe charset as session ids. */
const MACHINE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export type SessionsAction = 'list' | 'read' | 'stop' | 'archive' | 'approve' | 'deny' | 'peers' | 'message' | 'help'

export interface SessionsCommandOptions {
    action: SessionsAction
    sessionId?: string
    /** approve / deny: the pending request being answered. */
    requestId?: string
    tag?: string
    limit?: number
    /** list: account-wide over REST instead of this machine's daemon + keys. */
    all: boolean
    /** list --all: keep rows the server has archived. */
    includeArchived: boolean
    /** approve: `approved_for_session` instead of a one-shot `approved`. */
    forSession: boolean
    /** deny: free-text reason forwarded to the wrapper. */
    reason?: string
    /** read: no per-entry truncation. */
    full: boolean
    /** read: print only the agent's reply to the latest prompt. */
    answer: boolean
    /** read: block until the latest turn has ended. */
    wait: boolean
    /** read --wait: give up after this many seconds (default 600). */
    timeoutSec?: number
    /** peers: repo (default) | cwd | machine. */
    scope?: PeerScope
    /** peers: compute the scope from this directory instead of the process cwd. */
    cwd?: string
    /** message: the text to send. */
    text?: string
    /** message: id of the peer message being answered. */
    replyTo?: string
    /**
     * B-506: list / read / peers / message — the account machine to go
     * through. list: that machine's local listing; read / message: skip the
     * lookup and force the proxy path; peers: that machine's live sessions.
     */
    machine?: string
    json: boolean
}

const ACTIONS: readonly SessionsAction[] = ['list', 'read', 'stop', 'archive', 'approve', 'deny', 'peers', 'message']
const ACTIONS_NEEDING_ID: ReadonlySet<SessionsAction> = new Set(['read', 'stop', 'archive', 'approve', 'deny', 'message'])
const ACTIONS_NEEDING_REQUEST_ID: ReadonlySet<SessionsAction> = new Set(['approve', 'deny'])

/** Request ids are wrapper-generated (uuid / cuid-like). Bounded and URL-safe like session ids. */
const REQUEST_ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/

function defaultOptions(): SessionsCommandOptions {
    return { action: 'help', all: false, includeArchived: false, forSession: false, full: false, answer: false, wait: false, json: false }
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseSessionsArgs(args: string[]): SessionsCommandOptions {
    const options = defaultOptions()
    let actionSeen = false
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--help' || arg === '-h') {
            return defaultOptions()
        } else if (arg === '--json') {
            options.json = true
        } else if (arg === '--all') {
            options.all = true
        } else if (arg === '--include-archived') {
            options.includeArchived = true
        } else if (arg === '--for-session') {
            options.forSession = true
        } else if (arg === '--full') {
            options.full = true
        } else if (arg === '--answer') {
            options.answer = true
        } else if (arg === '--wait') {
            options.wait = true
        } else if (arg === '--timeout') {
            const value = args[++i]
            if (value === undefined) throw new Error('--timeout requires a value')
            const parsed = Number(value)
            if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--timeout must be a positive number of seconds')
            options.timeoutSec = parsed
        } else if (arg === '--reason') {
            const value = args[++i]
            if (value === undefined) throw new Error('--reason requires a value')
            options.reason = value
        } else if (arg === '--scope') {
            const value = args[++i]
            if (value === undefined) throw new Error('--scope requires a value')
            if (!(PEER_SCOPES as readonly string[]).includes(value)) throw new Error(`--scope must be one of ${PEER_SCOPES.join(', ')}`)
            options.scope = value as PeerScope
        } else if (arg === '--cwd') {
            const value = args[++i]
            if (value === undefined) throw new Error('--cwd requires a value')
            options.cwd = value
        } else if (arg === '--reply-to') {
            const value = args[++i]
            if (value === undefined || value.trim() === '') throw new Error('--reply-to requires a value')
            options.replyTo = value
        } else if (arg === '--machine') {
            const value = args[++i]
            if (value === undefined || !MACHINE_ID_RE.test(value)) throw new Error('--machine requires a machine id')
            options.machine = value
        } else if (arg === '--tag') {
            const value = args[++i]
            if (value === undefined) throw new Error('--tag requires a value')
            options.tag = value
        } else if (arg === '--limit') {
            const value = args[++i]
            if (value === undefined) throw new Error('--limit requires a value')
            const parsed = Number(value)
            if (!Number.isInteger(parsed) || parsed < 1) throw new Error('--limit must be a positive integer')
            options.limit = parsed
        } else if (arg.startsWith('-')) {
            throw new Error(`Unknown argument: ${arg}`)
        } else if (!actionSeen) {
            if (!(ACTIONS as readonly string[]).includes(arg)) {
                throw new Error(`Unknown action: ${arg} (expected ${ACTIONS.join(', ')})`)
            }
            options.action = arg as SessionsAction
            actionSeen = true
        } else {
            positionals.push(arg)
        }
    }

    if (!actionSeen) return defaultOptions()
    const expectedPositionals = ACTIONS_NEEDING_REQUEST_ID.has(options.action) || options.action === 'message' ? 2 : ACTIONS_NEEDING_ID.has(options.action) ? 1 : 0
    if (positionals.length > expectedPositionals) {
        throw new Error(`Unexpected ${expectedPositionals > 0 ? 'extra ' : ''}argument: ${positionals[expectedPositionals]}`)
    }

    if (ACTIONS_NEEDING_ID.has(options.action)) {
        const id = positionals[0]
        if (id === undefined) throw new Error(`${options.action} requires a session id`)
        // Validate here so a mistyped id fails before any network call, and so
        // the id can never be interpolated into a URL unchecked.
        if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${id}`)
        options.sessionId = id
    }
    if (options.action === 'message') {
        const text = positionals[1]
        if (text === undefined) throw new Error('message requires a session id and the text to send')
        if (text.trim() === '') throw new Error('message text is empty')
        options.text = text
    }
    if (ACTIONS_NEEDING_REQUEST_ID.has(options.action)) {
        const requestId = positionals[1]
        if (requestId === undefined) throw new Error(`${options.action} requires a session id and a request id`)
        if (!REQUEST_ID_RE.test(requestId)) throw new Error(`Invalid request id: ${requestId}`)
        options.requestId = requestId
    }

    if (options.action !== 'list') {
        if (options.tag !== undefined) throw new Error('--tag only applies to `sessions list`')
        if (options.all) throw new Error('--all only applies to `sessions list`')
        if (options.includeArchived) throw new Error('--include-archived only applies to `sessions list --all`')
    } else if (options.includeArchived && !options.all) {
        throw new Error('--include-archived only applies to `sessions list --all`')
    }
    if (options.forSession && options.action !== 'approve') throw new Error('--for-session only applies to `sessions approve`')
    if (options.reason !== undefined && options.action !== 'deny') throw new Error('--reason only applies to `sessions deny`')
    if (options.action !== 'read') {
        if (options.full) throw new Error('--full only applies to `sessions read`')
        if (options.answer) throw new Error('--answer only applies to `sessions read`')
        if (options.wait) throw new Error('--wait only applies to `sessions read`')
    }
    if (options.timeoutSec !== undefined && !options.wait) throw new Error('--timeout only applies to `sessions read --wait`')
    if (options.action !== 'peers') {
        if (options.scope !== undefined) throw new Error('--scope only applies to `sessions peers`')
        if (options.cwd !== undefined) throw new Error('--cwd only applies to `sessions peers`')
    }
    if (options.replyTo !== undefined && options.action !== 'message') throw new Error('--reply-to only applies to `sessions message`')
    if (options.machine !== undefined) {
        if (!MACHINE_ACTIONS.has(options.action)) throw new Error('--machine only applies to `sessions list|read|peers|message`')
        if (options.all) throw new Error('--machine cannot be combined with --all (--all already asks every online machine)')
    }
    return options
}

const MACHINE_ACTIONS: ReadonlySet<SessionsAction> = new Set(['list', 'read', 'peers', 'message'])

export const SESSIONS_HELP = `
${chalk.bold('very-happy sessions')} - Inspect and control sessions on this machine and, through their daemons, on the account's other machines (for automation)

${chalk.bold('Usage:')}
  very-happy sessions list [--all [--include-archived]] [--machine <id>] [--tag <name>] [--limit <n>] [--json]
  very-happy sessions read <id> [--machine <id>] [--limit <n>] [--full] [--answer]
                          [--wait [--timeout <s>]] [--json]
  very-happy sessions stop <id> [--json]
  very-happy sessions archive <id> [--json]
  very-happy sessions approve <id> <requestId> [--for-session] [--json]
  very-happy sessions deny <id> <requestId> [--reason <text>] [--json]
  very-happy sessions peers [--scope repo|cwd|machine] [--cwd <dir>] [--machine <id>] [--json]
  very-happy sessions message <id> <text> [--reply-to <msgId>] [--machine <id>] [--json]

${chalk.bold('Actions:')}
  list       Running sessions plus recently seen ones, newest first.
             With --all: every session on the account (newest 150, server
             REST), attention first. Rows this machine cannot decrypt are
             filled in by the online machine that spawned them (\`readable\`,
             \`via\`, \`machine\` in --json; \`decryptable\` stays "this
             machine's own key"); what no online machine holds shows only
             id / active / archived / timestamps / url.
             With --machine <id>: that machine's own listing (its daemon's
             children plus what it saw lately).
  read       The tail of a session as a role-tagged transcript, plus where
             the latest turn stands (\`turn\` in --json: ended, status and
             \`answer\` = the agent's reply to the latest prompt). A session
             another machine spawned is read through that machine's daemon.
  stop       SIGTERM the session's process via the local daemon.
  archive    Mark the session inactive server-side (it stays resumable).
  approve    Answer a pending permission request \`requestId\` with approve —
             the same RPC the web permission card sends. --for-session makes
             it \`approved_for_session\` (the card's "allow for this session").
  deny       Answer it with deny (optional --reason is shown to the agent).
  peers      Other live sessions on this machine and the files each edited in
             the last 30 minutes. Default scope \`repo\`: same git repository,
             including its other worktrees (\`sameWorktree\` says which share
             your checkout); \`cwd\`: same directory; \`machine\`: everything.
             With --machine <id>: the live sessions on that machine (scope
             \`machine\` unless --cwd names a directory there).
  message    Send <text> into a running session. It arrives tagged with the
             sender (the session named by VH_PEER_SESSION_ID when run from a
             managed session's shell, else this CLI) and tells the peer how to
             reply. A session another machine spawned is delivered through
             that machine's daemon, with this host named in the header.
             Refused for sessions that are not running, or terminal mirrors.
             \`delivered\` follows \`very-happy send\`: true only when a
             wrapper was attached before and after the POST (\`stored\` = it
             is on the server anyway).

${chalk.bold('Options:')}
  --all              list only: account-wide over REST instead of this
                     machine's daemon + local keys.
  --include-archived list --all only: also show server-archived rows.
  --tag <name>       list only: keep sessions carrying this origin tag (see
                     \`spawn --spawned-by\`). With --all only decryptable rows
                     can match.
  --limit <n>        list: how many NOT-running / not-attention sessions to
                     include (default ${DEFAULT_RECENT_LIMIT}; running and attention rows are
                     never cut). read: how many messages (default 20, max ${MAX_READ_LIMIT}).
  --full             read only: do not truncate entries (default caps each
                     line at 500 chars).
  --answer           read only: print just the agent's reply to the latest
                     prompt (the text after its last tool call), untruncated.
  --wait             read only: block until the latest turn has ended
                     (claude / codex / pi), then read. Pairs with
                     \`spawn --prompt\` / \`send\` for "ask and collect".
  --timeout <s>      read --wait only: give up after <s> seconds (default 600).
  --for-session      approve only: approved_for_session instead of approved.
  --reason <text>    deny only: reason forwarded to the wrapper.
  --scope <s>        peers only: repo (default) | cwd | machine.
  --cwd <dir>        peers only: directory the scope is computed from
                     (default: the process cwd, or HAPPY_SESSION_ID's cwd).
  --reply-to <id>    message only: the peer message id being answered.
  --machine <id>     list / read / peers / message: go through this account
                     machine's daemon (its id as the web's machine list shows
                     it). read / message: skip the lookup across machines.
  --json             Machine-readable output.
  -h, --help         Show this help

${chalk.bold('Scope:')}
  Sessions this machine's daemon spawned are handled with the local key in
  ~/.happy/sessions.json (pruned after 14 days). Any other session of the
  account is handled by the daemon of the machine that spawned it: that
  machine must be online and on CLI ≥ 0.2.157, the operation runs there with
  its keys, and only the result travels back — this CLI never holds the
  account content key or another machine's session key. Without --machine
  the online machines are asked in turn which one holds the session.
  approve / deny / stop / archive remain local-only.

${chalk.bold('Exit codes:')}
  2  read --wait: the turn had not ended when --timeout ran out (the
     partial state is still printed)
  0  success (approve/deny: the wrapper acknowledged the verdict; check
     \`settled\` in --json to see whether the request has left the pending set)
  1  bad arguments, unknown session, no machine of the account holds it (or
     its machine is offline / too old), request not pending, session not
     online, or the operation failed (including \`stop\` on a session the
     daemon is not running)
`

function formatWait(ms: number): string {
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 1) return `${Math.floor(ms / 1000)}s`
    if (minutes < 60) return `${minutes}m`
    return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function formatAccountSummaryLine(summary: AccountSessionSummary): string {
    const state = summary.attention
        ? '[attention]'
        : summary.live ? (summary.machine ? `[running on ${summary.machine.host}]` : '[running here]') : summary.active ? '[active elsewhere]' : summary.archived ? '[archived]' : '[idle]'
    const parts = [summary.id, state]
    if (!summary.readable) {
        parts.push('(not readable: no online machine holds its key)')
    } else {
        if (summary.machine) parts.push(`via=${summary.machine.host}`)
        if (summary.title) parts.push(`title="${summary.title}"`)
        if (summary.flavor) parts.push(`agent=${summary.flavor}`)
        if (summary.tags?.length) parts.push(`tags=${summary.tags.join(',')}`)
        if (summary.variant) parts.push(`variant=${summary.variant}`)
        if (summary.machineId) parts.push(`machine=${summary.machineId}`)
        if (summary.cwd) parts.push(`cwd=${summary.cwd}`)
        for (const request of summary.pending ?? []) {
            parts.push(`pending=${request.id}:${request.tool}${request.waitingMs !== undefined ? `(${formatWait(request.waitingMs)})` : ''}`)
        }
    }
    parts.push(summary.url)
    return parts.join(' ')
}

/**
 * JSON record for an approve/deny that was refused before any RPC was sent
 * (no local key, request not pending, session not found). Carries the same
 * identifying fields as the success record so a script can key on them.
 */
export function permissionFailureRecord(sessionId: string, requestId: string, error: unknown): { sessionId: string; requestId: string; error: string } {
    return { sessionId, requestId, error: error instanceof Error ? error.message : String(error) }
}

function formatSummaryLine(summary: SessionSummary): string {
    const parts = [summary.id, summary.live ? '[running]' : '[not running]']
    if (summary.title) parts.push(`title="${summary.title}"`)
    if (summary.flavor) parts.push(`agent=${summary.flavor}`)
    if (summary.tags?.length) parts.push(`tags=${summary.tags.join(',')}`)
    if (summary.variant) parts.push(`variant=${summary.variant}`)
    if (summary.cwd) parts.push(`cwd=${summary.cwd}`)
    if (summary.pid !== undefined) parts.push(`pid=${summary.pid}`)
    parts.push(summary.url)
    return parts.join(' ')
}

export async function handleSessionsCommand(args: string[]): Promise<never> {
    let options: SessionsCommandOptions
    try {
        options = parseSessionsArgs(args)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        console.error(`Run ${chalk.cyan('very-happy sessions --help')} for usage.`)
        process.exit(1)
    }

    if (options.action === 'help') {
        console.log(SESSIONS_HELP)
        process.exit(0)
    }

    try {
        if (options.action === 'list' && options.all) {
            // B-506: --tag is applied AFTER the foreign rows are filled in, so
            // a tag on another machine's session can match; the idle cap stays
            // the local listing's.
            const listed = await listAccountSessions({ recentLimit: options.tag ? 150 : options.limit, includeArchived: options.includeArchived })
            const fill = await fillForeignAccountRows(listed)
            let sessions = fill.rows
            if (options.tag) {
                const wanted = options.tag
                sessions = sessions.filter((summary) => summary.tags?.includes(wanted) === true)
                const recentLimit = Math.max(0, options.limit ?? DEFAULT_RECENT_LIMIT)
                let idleKept = 0
                sessions = sessions.filter((summary) => summary.attention || summary.live || idleKept++ < recentLimit)
            }
            if (options.json) {
                console.log(JSON.stringify({ sessions, scope: 'account', machines: { asked: fill.asked, skipped: fill.skipped } }))
            } else if (sessions.length === 0) {
                console.log(options.tag ? `No readable sessions tagged "${options.tag}" on this account.` : 'No sessions found on this account.')
            } else {
                for (const summary of sessions) console.log(formatAccountSummaryLine(summary))
                const foreign = sessions.filter((summary) => !summary.readable).length
                const filled = fill.asked.reduce((n, a) => n + a.filled, 0)
                if (filled > 0) {
                    console.log(chalk.dim(`${filled} session(s) read through their own machine's daemon (${fill.asked.filter((a) => a.filled > 0).map((a) => a.host ?? a.machineId).join(', ')}).`))
                }
                for (const asked of fill.asked.filter((a) => a.error)) console.log(chalk.dim(`machine ${asked.machineId}: ${asked.error}`))
                if (foreign > 0) {
                    const why = fill.skipped.length > 0 ? ` (${fill.skipped.map((s) => `${s.machineId}: ${s.reason}`).join('; ')})` : ''
                    console.log(chalk.dim(`${foreign} session(s) belong to a machine that is not reachable right now${why}.`))
                }
            }
            process.exit(0)
        }

        if (options.action === 'list' && options.machine) {
            const listing = await listRemoteSessions(options.machine, { tag: options.tag, limit: options.limit })
            const sessions = listing.sessions as SessionSummary[]
            if (options.json) {
                console.log(JSON.stringify({ sessions, machine: { id: listing.machineId, host: listing.host } }))
            } else if (sessions.length === 0) {
                console.log(options.tag ? `No sessions tagged "${options.tag}" on ${listing.host}.` : `No sessions found on ${listing.host}.`)
            } else {
                console.log(chalk.dim(`machine ${listing.host} (${listing.machineId})`))
                for (const summary of sessions) console.log(formatSummaryLine(summary))
            }
            process.exit(0)
        }

        if (options.action === 'list') {
            const sessions = await listSessions({ tag: options.tag, recentLimit: options.limit })
            if (options.json) {
                console.log(JSON.stringify({ sessions }))
            } else if (sessions.length === 0) {
                console.log(options.tag ? `No sessions tagged "${options.tag}" on this machine.` : 'No sessions found on this machine.')
            } else {
                for (const summary of sessions) console.log(formatSummaryLine(summary))
            }
            process.exit(0)
        }

        if (options.action === 'peers' || options.action === 'message') {
            const cwd = options.cwd ? resolvePath(options.cwd) : process.cwd()
            const persisted = readPersistedSessions()
            const context: PeerToolContext = { self: () => cliPeerSelf(process.env, cwd, persisted), readPersisted: () => persisted }
            if (options.action === 'peers') {
                const listing = options.machine
                    ? await listRemotePeers(options.machine, { ...(options.scope ? { scope: options.scope } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) })
                    : await listPeerSessions(context, options.scope ?? 'repo')
                if (options.json) {
                    console.log(JSON.stringify(listing))
                } else if (listing.peers.length === 0) {
                    console.log(`No other live sessions in scope "${listing.scope}"${listing.self.repoRoot ? ` (repo ${listing.self.repoRoot})` : ''}${'host' in listing ? ` on ${listing.host}` : ''}.`)
                } else {
                    if ('host' in listing) console.log(chalk.dim(`machine ${String(listing.host)} (${String((listing as { machineId?: string }).machineId)})`))
                    for (const peer of listing.peers) {
                        const parts = [peer.sessionId, `[${peer.kind === 'mirror' ? 'terminal' : 'running'}]`]
                        if (peer.title) parts.push(`title="${peer.title}"`)
                        if (peer.flavor) parts.push(`agent=${peer.flavor}`)
                        if (peer.cwd) parts.push(`cwd=${peer.cwd}${peer.sameWorktree ? '' : ' (other worktree)'}`)
                        parts.push(peer.url)
                        console.log(parts.join(' '))
                        for (const edit of peer.edits) console.log(chalk.dim(`    ${edit.tool} ${edit.path} (${Math.round((Date.now() - edit.at) / 60_000)}m ago)`))
                    }
                }
                process.exit(0)
            }
            const target = options.sessionId as string
            try {
                const result = await sendPeerMessage(context, { to: target, body: options.text as string, replyTo: options.replyTo, ...(options.machine ? { machineId: options.machine } : {}) })
                if (options.json) console.log(JSON.stringify(result))
                else if (result.delivered) console.log(`Message ${result.messageId} delivered to ${target}${result.machine ? ` on ${result.machine.host}` : ''}\n${result.url}`)
                else console.error(chalk.yellow('Not delivered:'), result.error ?? `session is ${result.status}`, result.stored ? '(stored server-side, unread)' : '')
                process.exit(result.delivered ? 0 : 1)
            } catch (error) {
                if (options.json) console.log(JSON.stringify({ delivered: false, to: target, error: error instanceof Error ? error.message : String(error) }))
                throw error
            }
        }

        const sessionId = options.sessionId as string

        if (options.action === 'read') {
            let timedOut = false
            const local = !options.machine && readPersistedSessions()[sessionId] !== undefined
            let result: Awaited<ReturnType<typeof readSessionTranscript>> & { machine?: { id: string; host: string }; truncated?: boolean }
            if (local) {
                if (options.wait) {
                    try {
                        await waitForTurnEnd(sessionId, { timeoutMs: (options.timeoutSec ?? 600) * 1000 })
                    } catch (error) {
                        if (!(error instanceof TurnWaitTimeoutError)) throw error
                        timedOut = true
                        console.error(chalk.yellow('Timeout:'), error.message)
                    }
                }
                result = await readSessionTranscript(sessionId, options.limit ?? 20, { full: options.full })
            } else {
                // B-506: the owning machine's daemon reads (and, with --wait, is polled).
                const readOptions = { limit: options.limit ?? 20, full: options.full, ...(options.machine ? { machineId: options.machine } : {}) }
                let remote: Awaited<ReturnType<typeof readRemoteTranscript>>
                if (options.wait) {
                    const timeoutMs = (options.timeoutSec ?? 600) * 1000
                    const waited = await waitForRemoteTurnEnd(sessionId, { ...readOptions, timeoutMs })
                    remote = waited.read
                    if (waited.timedOut) {
                        timedOut = true
                        console.error(chalk.yellow('Timeout:'), `Session ${sessionId} on ${remote.host}: the latest turn did not end within ${Math.round(timeoutMs / 1000)}s`)
                    }
                } else {
                    remote = await readRemoteTranscript(sessionId, readOptions)
                }
                const { machineId, host, ...rest } = remote
                result = { ...rest, machine: { id: machineId, host } }
            }
            if (options.json) {
                console.log(JSON.stringify(options.answer ? { sessionId, turn: result.turn, ...(result.machine ? { machine: result.machine } : {}) } : result))
            } else if (options.answer) {
                if (result.turn.answer.length > 0) console.log(result.turn.answer)
                else console.error(chalk.dim('(the agent has not replied to the latest prompt yet)'))
            } else {
                console.log(formatSummaryLine(result.summary) + (result.machine ? chalk.dim(` machine=${result.machine.host}`) : ''))
                console.log(`--- last ${result.messageCount} message(s)${result.truncated ? ' (truncated to fit the RPC budget)' : ''} ---`)
                console.log(result.transcript.length > 0 ? result.transcript : '(no readable conversation content in this range)')
                const turn = result.turn
                console.log(chalk.dim(`--- latest turn: ${turn.ended ? `ended (${turn.status ?? 'unknown'})` : 'running'}${turn.error ? ` — ${turn.error}` : ''} ---`))
            }
            process.exit(timedOut ? 2 : 0)
        }

        if (options.action === 'stop') {
            const stopped = await stopSession(sessionId)
            if (!stopped) {
                // Not an "already fine" case: the caller asked to stop something
                // and nothing was stopped. Exit 1 so a script can tell.
                if (options.json) console.log(JSON.stringify({ sessionId, stopped: false }))
                console.error(chalk.red('Error:'), `Session ${sessionId} is not among the daemon's running sessions.`)
                process.exit(1)
            }
            if (options.json) console.log(JSON.stringify({ sessionId, stopped: true }))
            else console.log(`Stopped ${sessionId}`)
            process.exit(0)
        }

        if (options.action === 'approve' || options.action === 'deny') {
            const requestId = options.requestId as string
            const verdict: PermissionVerdict = options.action === 'approve'
                ? { kind: 'approve', forSession: options.forSession }
                : { kind: 'deny', reason: options.reason }
            let result: Awaited<ReturnType<typeof resolvePermissionRequest>>
            try {
                result = await resolvePermissionRequest(sessionId, requestId, verdict, {
                    // T-014: a rate refusal waits (bounded) before re-sending;
                    // say so on stderr so the wait does not look like a hang.
                    onRateLimited: ({ attempt, waitMs, serverError }) => {
                        console.error(chalk.yellow('Rate limited:'), `${serverError} — waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt}`)
                    },
                })
            } catch (error) {
                // Pre-check refusals (no local key / not pending / not found)
                // throw before any RPC. Like `stop`, a --json caller still gets
                // a record on stdout rather than an empty string + exit 1.
                if (options.json) console.log(JSON.stringify(permissionFailureRecord(sessionId, requestId, error)))
                throw error
            }
            if (result.outcome.status !== 'acknowledged') {
                if (options.json) console.log(JSON.stringify(result))
                const hint = result.outcome.status === 'rate-limited'
                    ? ` — the request is still pending; re-run in ~${Math.ceil(result.outcome.retryAfterMs / 1000)}s`
                    : ''
                console.error(chalk.red('Error:'), `${options.action} of ${requestId} on ${sessionId} was not delivered (${result.outcome.status}): ${result.outcome.message}${hint}`)
                process.exit(1)
            }
            if (options.json) {
                console.log(JSON.stringify(result))
            } else {
                const verb = options.action === 'approve' ? 'Approved' : 'Denied'
                console.log(`${verb} ${requestId} on ${sessionId} (${result.payload.decision})${result.settled ? '' : ' — wrapper acknowledged, but the request was still listed as pending when we stopped waiting'}`)
            }
            process.exit(0)
        }

        await archiveSession(sessionId)
        if (options.json) console.log(JSON.stringify({ sessionId, archived: true }))
        else console.log(`Archived ${sessionId}`)
        process.exit(0)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        process.exit(1)
    }
}
