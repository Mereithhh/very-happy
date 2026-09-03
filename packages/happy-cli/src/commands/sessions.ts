/**
 * `very-happy sessions` — inspect and control sessions on this machine (B-304).
 *
 * The automation counterpart to `spawn`/`send`: those start work, these let an
 * external agent layer see it and intervene. Same four operations the built-in
 * assistant already had over MCP, now reachable without being the assistant —
 * the shared transport lives in `@/sessions/sessionOps`.
 *
 *   very-happy sessions list [--all] [--tag <name>] [--limit <n>] [--json]
 *   very-happy sessions read <id> [--limit <n>] [--json]
 *   very-happy sessions stop <id> [--json]
 *   very-happy sessions archive <id> [--json]
 *   very-happy sessions approve <id> <requestId> [--for-session] [--json]
 *   very-happy sessions deny <id> <requestId> [--reason <text>] [--json]
 *
 * Everything is scoped to this machine (the daemon's children plus the keys in
 * ~/.happy/sessions.json). Reading another machine's session is not a
 * permission error, it is simply not possible from here. `list --all` widens
 * the *listing* to the account over REST, and marks every row with
 * `decryptable` so a script can tell "readable" from "someone else's" — see
 * `@/sessions/sessionOps` for why the boundary sits exactly there.
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
    type AccountSessionSummary,
    type SessionSummary,
} from '@/sessions/sessionOps'
import { resolvePermissionRequest, type PermissionVerdict } from '@/sessions/permissionOps'
import { isValidSessionId } from '@/assistant/ids'

export type SessionsAction = 'list' | 'read' | 'stop' | 'archive' | 'approve' | 'deny' | 'help'

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
    json: boolean
}

const ACTIONS: readonly SessionsAction[] = ['list', 'read', 'stop', 'archive', 'approve', 'deny']
const ACTIONS_NEEDING_ID: ReadonlySet<SessionsAction> = new Set(['read', 'stop', 'archive', 'approve', 'deny'])
const ACTIONS_NEEDING_REQUEST_ID: ReadonlySet<SessionsAction> = new Set(['approve', 'deny'])

/** Request ids are wrapper-generated (uuid / cuid-like). Bounded and URL-safe like session ids. */
const REQUEST_ID_RE = /^[a-zA-Z0-9_.:-]{1,128}$/

function defaultOptions(): SessionsCommandOptions {
    return { action: 'help', all: false, includeArchived: false, forSession: false, json: false }
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
        } else if (arg === '--reason') {
            const value = args[++i]
            if (value === undefined) throw new Error('--reason requires a value')
            options.reason = value
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
    const expectedPositionals = ACTIONS_NEEDING_REQUEST_ID.has(options.action) ? 2 : ACTIONS_NEEDING_ID.has(options.action) ? 1 : 0
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
    return options
}

export const SESSIONS_HELP = `
${chalk.bold('very-happy sessions')} - Inspect and control sessions on this machine (for automation)

${chalk.bold('Usage:')}
  very-happy sessions list [--all [--include-archived]] [--tag <name>] [--limit <n>] [--json]
  very-happy sessions read <id> [--limit <n>] [--json]
  very-happy sessions stop <id> [--json]
  very-happy sessions archive <id> [--json]
  very-happy sessions approve <id> <requestId> [--for-session] [--json]
  very-happy sessions deny <id> <requestId> [--reason <text>] [--json]

${chalk.bold('Actions:')}
  list       Running sessions plus recently seen ones, newest first.
             With --all: every session on the account (newest 150, server
             REST), attention first. Each row says whether this machine could
             decrypt it (\`decryptable\`); rows from other machines show only
             id / active / archived / timestamps / url.
  read       The tail of a session as a role-tagged transcript.
  stop       SIGTERM the session's process via the local daemon.
  archive    Mark the session inactive server-side (it stays resumable).
  approve    Answer a pending permission request \`requestId\` with approve —
             the same RPC the web permission card sends. --for-session makes
             it \`approved_for_session\` (the card's "allow for this session").
  deny       Answer it with deny (optional --reason is shown to the agent).

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
  --for-session      approve only: approved_for_session instead of approved.
  --reason <text>    deny only: reason forwarded to the wrapper.
  --json             Machine-readable output.
  -h, --help         Show this help

${chalk.bold('Scope:')}
  read / approve / deny need the session key from ~/.happy/sessions.json,
  which exists for sessions this machine's daemon spawned and is pruned after
  14 days (the message payloads and the permission RPC are encrypted with it).
  \`list --all\` sees every session on the account but can only decrypt those
  same ones; the rest come back with decryptable=false. Reading, listing in
  full and answering another machine's session from here needs the CLI to hold
  the account content key — a credentials change, not a flag.

${chalk.bold('Exit codes:')}
  0  success (approve/deny: the wrapper acknowledged the verdict; check
     \`settled\` in --json to see whether the request has left the pending set)
  1  bad arguments, unknown session, no local key, request not pending,
     session not online, or the operation failed (including \`stop\` on a
     session the daemon is not running)
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
        : summary.live ? '[running here]' : summary.active ? '[active elsewhere]' : summary.archived ? '[archived]' : '[idle]'
    const parts = [summary.id, state]
    if (!summary.decryptable) {
        parts.push('(not decryptable from this machine)')
    } else {
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
            const sessions = await listAccountSessions({ tag: options.tag, recentLimit: options.limit, includeArchived: options.includeArchived })
            if (options.json) {
                console.log(JSON.stringify({ sessions, scope: 'account' }))
            } else if (sessions.length === 0) {
                console.log(options.tag ? `No decryptable sessions tagged "${options.tag}" on this account.` : 'No sessions found on this account.')
            } else {
                for (const summary of sessions) console.log(formatAccountSummaryLine(summary))
                const foreign = sessions.filter((summary) => !summary.decryptable).length
                if (foreign > 0) {
                    console.log(chalk.dim(`${foreign} session(s) belong to another machine and cannot be decrypted here (no local key).`))
                }
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

        const sessionId = options.sessionId as string

        if (options.action === 'read') {
            const result = await readSessionTranscript(sessionId, options.limit ?? 20)
            if (options.json) {
                console.log(JSON.stringify(result))
            } else {
                console.log(formatSummaryLine(result.summary))
                console.log(`--- last ${result.messageCount} message(s) ---`)
                console.log(result.transcript.length > 0 ? result.transcript : '(no readable conversation content in this range)')
            }
            process.exit(0)
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
                result = await resolvePermissionRequest(sessionId, requestId, verdict)
            } catch (error) {
                // Pre-check refusals (no local key / not pending / not found)
                // throw before any RPC. Like `stop`, a --json caller still gets
                // a record on stdout rather than an empty string + exit 1.
                if (options.json) console.log(JSON.stringify(permissionFailureRecord(sessionId, requestId, error)))
                throw error
            }
            if (result.outcome.status !== 'acknowledged') {
                if (options.json) console.log(JSON.stringify(result))
                console.error(chalk.red('Error:'), `${options.action} of ${requestId} on ${sessionId} was not delivered (${result.outcome.status}): ${result.outcome.message}`)
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
