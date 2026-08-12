/**
 * `very-happy send` — push one user message into an EXISTING happy session:
 *
 *   very-happy send --session <id> (--prompt <text> | --prompt-file <path>) [--json]
 *
 * Companion to `very-happy spawn` for external automation (e.g. the Tanka
 * quote-reply dispatcher): spawn creates a session and optionally sends the
 * first message; send follows up on a session that is already running.
 *
 * Implementation notes:
 * - Delivery reuses the shared sessionMessage primitive (same web semantics:
 *   session-key-encrypted user envelope POSTed to `/v3/sessions/:id/messages`).
 * - The session key MUST already be in `~/.happy/sessions.json` — only
 *   sessions spawned by this machine's daemon (recent enough to persist
 *   keys) qualify. A missing key is a hard error: we cannot encrypt for a
 *   session whose key we don't hold.
 * - No daemon liveness check: unlike spawn, sending rides the server REST
 *   outbox directly; the daemon only mattered for key persistence, which has
 *   already happened (or not) by now.
 *
 * Exit codes:
 *   0 — message delivered
 *   1 — anything else (bad args, unknown session / missing key, send failed)
 */

import chalk from 'chalk'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPersistedSessions } from '@/persistence'
import { configuration } from '@/configuration'
import { sendUserMessage, sessionWebUrl } from './sessionMessage'

export interface SendCommandOptions {
    session?: string
    prompt?: string
    promptFile?: string
    json: boolean
    help: boolean
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseSendArgs(args: string[]): SendCommandOptions {
    const options: SendCommandOptions = { json: false, help: false }
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
${chalk.bold('happy send')} - Send a message into an existing session (for automation)

${chalk.bold('Usage:')}
  happy send --session <id> (--prompt <text> | --prompt-file <file>) [--json]

${chalk.bold('Options:')}
  --session, -s <id>     Target session id (required)
  --prompt, -p <text>    Message text to send
  --prompt-file <file>   Read the message from a file (UTF-8)
  --json                 Machine-readable output: {"sessionId", "url", "delivered"}
  -h, --help             Show this help

${chalk.bold('Behavior:')}
  The session must have been spawned by THIS machine's daemon (its
  encryption key must be in ${configuration.sessionsFile}); sessions from
  other machines or from daemons too old to persist keys cannot be reached.

${chalk.bold('Exit codes:')}
  0  message delivered
  1  bad arguments, unknown session, or delivery failed
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
        console.error(`Run ${chalk.cyan('happy send --help')} for usage.`)
        process.exit(1)
    }

    if (options.help) {
        printHelp()
        process.exit(0)
    }

    if (!options.session) {
        console.error(chalk.red('Error:'), '--session is required')
        console.error(`Run ${chalk.cyan('happy send --help')} for usage.`)
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
        console.error(`Run ${chalk.cyan('happy send --help')} for usage.`)
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

    try {
        await sendUserMessage(sessionId, persisted, prompt, 'cli-send')
    } catch (error) {
        fail(options, sessionId, `Failed to send message: ${error instanceof Error ? error.message : String(error)}`)
    }

    const url = sessionWebUrl(sessionId)
    if (options.json) {
        console.log(JSON.stringify({ sessionId, url, delivered: true }))
    } else {
        console.log(`${chalk.bold('Session:')} ${sessionId}`)
        console.log(`${chalk.bold('URL:')}     ${url}`)
        console.log(chalk.green('Message sent.'))
    }
    process.exit(0)
}
