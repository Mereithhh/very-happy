/**
 * `very-happy sessions` — inspect and control sessions on this machine (B-304).
 *
 * The automation counterpart to `spawn`/`send`: those start work, these let an
 * external agent layer see it and intervene. Same four operations the built-in
 * assistant already had over MCP, now reachable without being the assistant —
 * the shared transport lives in `@/sessions/sessionOps`.
 *
 *   very-happy sessions list [--tag <name>] [--limit <n>] [--json]
 *   very-happy sessions read <id> [--limit <n>] [--json]
 *   very-happy sessions stop <id> [--json]
 *   very-happy sessions archive <id> [--json]
 *
 * Everything is scoped to this machine (the daemon's children plus the keys in
 * ~/.happy/sessions.json). Reading another machine's session is not a
 * permission error, it is simply not possible from here.
 *
 * Exit codes: 0 success, 1 anything else (bad args, unknown session, no local
 * key, transport failure). `stop` on a session the daemon is not running exits
 * 1 — a caller asking to stop something must be able to tell "stopped it" from
 * "there was nothing to stop".
 */

import chalk from 'chalk'
import {
    archiveSession,
    DEFAULT_RECENT_LIMIT,
    listSessions,
    MAX_READ_LIMIT,
    readSessionTranscript,
    stopSession,
    type SessionSummary,
} from '@/sessions/sessionOps'
import { isValidSessionId } from '@/assistant/ids'

export type SessionsAction = 'list' | 'read' | 'stop' | 'archive' | 'help'

export interface SessionsCommandOptions {
    action: SessionsAction
    sessionId?: string
    tag?: string
    limit?: number
    json: boolean
}

const ACTIONS_NEEDING_ID: ReadonlySet<SessionsAction> = new Set(['read', 'stop', 'archive'])

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseSessionsArgs(args: string[]): SessionsCommandOptions {
    const options: SessionsCommandOptions = { action: 'help', json: false }
    let actionSeen = false
    const positionals: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--help' || arg === '-h') {
            return { action: 'help', json: false }
        } else if (arg === '--json') {
            options.json = true
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
            if (arg !== 'list' && arg !== 'read' && arg !== 'stop' && arg !== 'archive') {
                throw new Error(`Unknown action: ${arg} (expected list, read, stop or archive)`)
            }
            options.action = arg
            actionSeen = true
        } else {
            positionals.push(arg)
        }
    }

    if (!actionSeen) return { action: 'help', json: false }
    if (positionals.length > 1) throw new Error(`Unexpected extra argument: ${positionals[1]}`)

    if (ACTIONS_NEEDING_ID.has(options.action)) {
        const id = positionals[0]
        if (id === undefined) throw new Error(`${options.action} requires a session id`)
        // Validate here so a mistyped id fails before any network call, and so
        // the id can never be interpolated into a URL unchecked.
        if (!isValidSessionId(id)) throw new Error(`Invalid session id: ${id}`)
        options.sessionId = id
    } else if (positionals.length > 0) {
        throw new Error(`Unexpected argument: ${positionals[0]}`)
    }

    if (options.action !== 'list' && options.tag !== undefined) {
        throw new Error('--tag only applies to `sessions list`')
    }
    return options
}

export const SESSIONS_HELP = `
${chalk.bold('very-happy sessions')} - Inspect and control sessions on this machine (for automation)

${chalk.bold('Usage:')}
  very-happy sessions list [--tag <name>] [--limit <n>] [--json]
  very-happy sessions read <id> [--limit <n>] [--json]
  very-happy sessions stop <id> [--json]
  very-happy sessions archive <id> [--json]

${chalk.bold('Actions:')}
  list       Running sessions plus recently seen ones, newest first.
  read       The tail of a session as a role-tagged transcript.
  stop       SIGTERM the session's process via the local daemon.
  archive    Mark the session inactive server-side (it stays resumable).

${chalk.bold('Options:')}
  --tag <name>   list only: keep sessions carrying this origin tag (see
                 \`spawn --spawned-by\`).
  --limit <n>    list: how many NOT-running sessions to include (default ${DEFAULT_RECENT_LIMIT};
                 running ones are never cut). read: how many messages
                 (default 20, max ${MAX_READ_LIMIT}).
  --json         Machine-readable output.
  -h, --help     Show this help

${chalk.bold('Scope:')}
  This machine only. Reads need the session key from ~/.happy/sessions.json,
  which exists for sessions this machine's daemon spawned and is pruned after
  14 days. A session on another machine cannot be read or stopped from here.

${chalk.bold('Exit codes:')}
  0  success
  1  bad arguments, unknown session, no local key, or the operation failed
     (including \`stop\` on a session the daemon is not running)
`

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

        await archiveSession(sessionId)
        if (options.json) console.log(JSON.stringify({ sessionId, archived: true }))
        else console.log(`Archived ${sessionId}`)
        process.exit(0)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        process.exit(1)
    }
}
