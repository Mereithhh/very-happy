/**
 * `very-happy send` — push one user message into an EXISTING happy session:
 *
 *   very-happy send --session <id> (--prompt <text> | --prompt-file <path>) [--model <id>] [--resume] [--json]
 *
 * Companion to `very-happy spawn` for external automation (for example an IM
 * quote-reply dispatcher): spawn creates a session and optionally sends the
 * first message; send follows up on a session that is already running.
 *
 * Implementation notes:
 * - Delivery goes through `deliverToSession` (sessionDelivery.ts), shared
 *   with the assistant's `session_send`: classify the session first (local
 *   daemon `/list` + server `GET /v1/sessions/:id`), send only when a live
 *   wrapper will read it, re-check afterwards. The POST itself is the shared
 *   sessionMessage primitive (session-key-encrypted user envelope to
 *   `/v3/sessions/:id/messages`, same as the web).
 * - The session key MUST already be in `~/.happy/sessions.json` — only
 *   sessions spawned by this machine's daemon (recent enough to persist
 *   keys) qualify. A missing key is a hard error: we cannot encrypt for a
 *   session whose key we don't hold.
 * - B-501: the server stores messages for archived / dead sessions too, so a
 *   2xx never meant "someone will read this". A session that is `archived`,
 *   `offline` or `not_found` is refused (exit 3) unless `--resume` brings it
 *   back on this machine first (unarchive → daemon resume → wait until live),
 *   the same path as the web's 「恢复」.
 *
 * Exit codes:
 *   0 — message delivered to a live wrapper
 *   1 — bad args, unknown session / missing key, transport failure
 *   3 — session not live (archived / offline / not found), or resume failed;
 *       nothing was delivered (with --json see `status` / `stored`)
 */

import chalk from 'chalk'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPersistedSessions } from '@/persistence'
import { configuration } from '@/configuration'
import { sessionWebUrl } from './sessionMessage'
import { deliverToSession, type DeliveryResult } from './sessionDelivery'

/** Exit code: the session has no live wrapper (or could not be resumed); nothing was delivered. */
export const EXIT_SESSION_NOT_LIVE = 3

export interface SendCommandOptions {
    session?: string
    prompt?: string
    promptFile?: string
    /** B-492: switch the session's model with this message ('default' = machine default). */
    model?: string
    /** B-501: bring an archived / offline session back on this machine before sending. */
    resume: boolean
    json: boolean
    help: boolean
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseSendArgs(args: string[]): SendCommandOptions {
    const options: SendCommandOptions = { resume: false, json: false, help: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--session' || arg === '-s') {
            const value = args[++i]
            if (value === undefined) throw new Error('--session requires a value')
            options.session = value
        } else if (arg === '--prompt' || arg === '-p') {
            const value = args[++i]
            if (value === undefined) throw new Error('--prompt requires a value')
            options.prompt = value
        } else if (arg === '--prompt-file') {
            const value = args[++i]
            if (value === undefined) throw new Error('--prompt-file requires a value')
            options.promptFile = value
        } else if (arg === '--model' || arg === '-m') {
            const value = args[++i]
            if (value === undefined || value.trim().length === 0) throw new Error('--model requires a value')
            options.model = value
        } else if (arg === '--resume') {
            options.resume = true
        } else if (arg === '--json') {
            options.json = true
        } else if (arg === '--help' || arg === '-h') {
            options.help = true
        } else {
            throw new Error(`Unknown argument: ${arg}`)
        }
    }
    if (options.prompt !== undefined && options.promptFile !== undefined) {
        throw new Error('--prompt and --prompt-file are mutually exclusive')
    }
    return options
}

function printHelp() {
    console.log(`
${chalk.bold('very-happy send')} - Send a message into an existing session (for automation)

${chalk.bold('Usage:')}
  very-happy send --session <id> (--prompt <text> | --prompt-file <file>)
                  [--model <id>] [--resume] [--json]

${chalk.bold('Options:')}
  --session, -s <id>     Target session id (required)
  --prompt, -p <text>    Message text to send
  --prompt-file <file>   Read the message from a file (UTF-8)
  --model, -m <id>       Switch the session to this model with this message
                            ('default' = the machine default). Without it the
                            session keeps whatever model it is on.
  --resume               If the session is archived or offline, bring it back
                            on THIS machine first (same as the web's Restore),
                            wait until it is live, then send.
  --json                 Machine-readable output (see below)
  -h, --help             Show this help

${chalk.bold('Behavior:')}
  The session must have been spawned by THIS machine's daemon (its
  encryption key must be in ${configuration.sessionsFile}); sessions from
  other machines or from daemons too old to persist keys cannot be reached.

  Before sending, the session is classified from the local daemon and the
  server: live (a wrapper is attached, here or on another machine), archived,
  offline (wrapper exited / presence timed out) or not_found. The server
  stores messages for any session, so only "live" means someone will read it;
  anything else is refused with exit 3 unless --resume is given.

${chalk.bold('JSON output:')}
  delivered  {"sessionId","url","delivered":true,"status":"live","resumed":false|true}
  refused    {"sessionId","url","delivered":false,"status":"archived"|"offline"|"not_found",
              "error":"...","resume":{"ok":false,"error":"..."}}   (resume only with --resume)
  dropped    {"delivered":false,"stored":true,...}  the POST succeeded but the wrapper
              went away meanwhile: the message is stored server-side, unread

${chalk.bold('Exit codes:')}
  0  message delivered to a live wrapper
  1  bad arguments, unknown session, or transport failure
  3  session not live (archived / offline / not found) or resume failed
`)
}

function fail(options: SendCommandOptions, sessionId: string | null, message: string): never {
    if (options.json) {
        const payload: Record<string, unknown> = { delivered: false, error: message }
        if (sessionId) {
            payload.sessionId = sessionId
            payload.url = sessionWebUrl(sessionId)
        }
        console.log(JSON.stringify(payload))
    } else {
        console.error(chalk.red('Error:'), message)
    }
    process.exit(1)
}

export async function handleSendCommand(args: string[]): Promise<never> {
    let options: SendCommandOptions
    try {
        options = parseSendArgs(args)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        console.error(`Run ${chalk.cyan('very-happy send --help')} for usage.`)
        process.exit(1)
    }

    if (options.help) {
        printHelp()
        process.exit(0)
    }

    if (!options.session) {
        console.error(chalk.red('Error:'), '--session is required')
        console.error(`Run ${chalk.cyan('very-happy send --help')} for usage.`)
        process.exit(1)
    }
    const sessionId = options.session

    let prompt: string | undefined = options.prompt
    if (options.promptFile !== undefined) {
        try {
            prompt = readFileSync(resolve(options.promptFile), 'utf8')
        } catch (error) {
            fail(options, sessionId, `Failed to read --prompt-file: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    if (prompt === undefined) {
        console.error(chalk.red('Error:'), 'One of --prompt / --prompt-file is required')
        console.error(`Run ${chalk.cyan('very-happy send --help')} for usage.`)
        process.exit(1)
    }
    if (prompt.trim().length === 0) {
        fail(options, sessionId, 'Prompt is empty')
    }

    // The key must ALREADY be persisted — this is an existing session, so
    // there is nothing to wait for. Missing key ⇒ not spawned by this
    // machine's daemon, or the daemon was too old to persist keys.
    const persisted = readPersistedSessions()[sessionId]
    if (!persisted) {
        fail(options, sessionId,
            `Session ${sessionId} has no encryption key in ${configuration.sessionsFile}. ` +
            `It was not spawned by this machine's daemon, or the daemon is too old to persist session keys.`)
    }

    let result: DeliveryResult
    try {
        result = await deliverToSession(sessionId, persisted, prompt, 'cli-send', {
            resume: options.resume,
            ...(options.model !== undefined ? { model: options.model === 'default' ? null : options.model } : {}),
        })
    } catch (error) {
        fail(options, sessionId, `Failed to send message: ${error instanceof Error ? error.message : String(error)}`)
    }

    const url = sessionWebUrl(sessionId)
    if (!result.delivered) {
        if (options.json) {
            console.log(JSON.stringify({
                sessionId, url, delivered: false, status: result.status, resumed: result.resumed, stored: result.stored,
                error: result.error,
                ...(result.resume ? { resume: result.resume } : {}),
            }))
        } else {
            console.error(chalk.red('Not delivered:'), result.error ?? `session is ${result.status}`)
            if (result.stored) console.error(chalk.yellow('The message is stored server-side; nothing is reading it.'))
        }
        process.exit(EXIT_SESSION_NOT_LIVE)
    }
    if (options.json) {
        console.log(JSON.stringify({ sessionId, url, delivered: true, status: 'live', resumed: result.resumed }))
    } else {
        console.log(`${chalk.bold('Session:')} ${sessionId}`)
        console.log(`${chalk.bold('URL:')}     ${url}`)
        if (result.resumed) console.log(chalk.green('Session resumed on this machine.'))
        console.log(chalk.green('Message sent.'))
    }
    process.exit(0)
}
