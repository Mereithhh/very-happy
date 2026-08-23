/**
 * `very-happy spawn` — one-shot automation entry point:
 * spawn a remote happy session via the LOCAL daemon control server and
 * (optionally) send the first user message, printing a clickable web URL.
 *
 * Designed for external automation (e.g. jojo-agent) running on the same
 * machine as the daemon:
 *
 *   very-happy spawn --dir <cwd> [--prompt <text>|--prompt-file <path>] [--json]
 *
 * Implementation notes:
 * - Spawn rides the existing daemon control-server endpoint
 *   (`POST /spawn-session` via `spawnDaemonSession`), same as the web's
 *   machine RPC path ends up doing on this machine. Only `directory` is
 *   sent, so older daemons that predate agent/env params still work.
 * - The first message rides the shared sessionMessage primitive (exact web
 *   semantics — see that module's header). The session key comes from
 *   `~/.happy/sessions.json`, which the daemon persists from the session's
 *   `/session-started` webhook BEFORE it answers `/spawn-session`; we
 *   tolerate a slow daemon with a bounded 15s poll. For messaging an
 *   ALREADY-running session, see `very-happy send` (send.ts).
 * - Daemon-not-running is a hard error (same semantics as the web: you
 *   cannot spawn on an offline machine). We deliberately do NOT call
 *   `ensureDaemonRunning()` here: automation running a dev build would
 *   otherwise restart the user's production daemon on version mismatch.
 *
 * Exit codes:
 *   0 — success
 *   1 — spawn failed (no session was created)
 *   2 — session spawned, but sending the first message failed
 *       (the session likely EXISTS — the URL is still printed)
 */

import chalk from 'chalk'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkIfDaemonRunningAndCleanupStaleState, spawnDaemonSession } from '@/daemon/controlClient'
import { sendUserMessage, sessionWebUrl, waitForSessionKey } from './sessionMessage'
import { logger } from '@/ui/logger'

// Re-exported for back-compat (tests and external imports historically used
// `spawn.ts` as the home of this helper; the implementation now lives in the
// shared sessionMessage module).
export { sessionWebUrl } from './sessionMessage'

export interface SpawnCommandOptions {
    dir?: string
    prompt?: string
    promptFile?: string
    json: boolean
    help: boolean
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
export function parseSpawnArgs(args: string[]): SpawnCommandOptions {
    const options: SpawnCommandOptions = { json: false, help: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--dir' || arg === '-d') {
            const value = args[++i]
            if (value === undefined) throw new Error('--dir requires a value')
            options.dir = value
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
${chalk.bold('happy spawn')} - Spawn a remote session via the local daemon (for automation)

${chalk.bold('Usage:')}
  happy spawn --dir <path> [--prompt <text> | --prompt-file <file>] [--json]

${chalk.bold('Options:')}
  --dir, -d <path>       Working directory for the new session (required)
  --prompt, -p <text>    First message to send after the session starts
  --prompt-file <file>   Read the first message from a file (UTF-8)
  --json                 Machine-readable output: {"sessionId", "url"}
  -h, --help             Show this help

${chalk.bold('Behavior:')}
  Requires the Very Happy daemon to be running on this machine (same semantics
  as spawning from the web: an offline machine cannot spawn). Without
  --prompt / --prompt-file the session is spawned idle.

${chalk.bold('Exit codes:')}
  0  success
  1  spawn failed (no session created)
  2  session spawned but first message failed (session URL still printed)
`)
}

/**
 * Send the first user message to a spawned session: wait (bounded) for the
 * daemon to persist the fresh session's key, then push via the shared
 * sessionMessage primitive.
 */
async function sendFirstMessage(sessionId: string, text: string): Promise<void> {
    const persisted = await waitForSessionKey(sessionId, 15_000)
    await sendUserMessage(sessionId, persisted, text, 'cli-spawn')
}

export async function handleSpawnCommand(args: string[]): Promise<never> {
    let options: SpawnCommandOptions
    try {
        options = parseSpawnArgs(args)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        console.error(`Run ${chalk.cyan('happy spawn --help')} for usage.`)
        process.exit(1)
    }

    if (options.help) {
        printHelp()
        process.exit(0)
    }

    if (!options.dir) {
        console.error(chalk.red('Error:'), '--dir is required')
        console.error(`Run ${chalk.cyan('happy spawn --help')} for usage.`)
        process.exit(1)
    }
    const directory = resolve(options.dir)

    // Resolve the prompt up front so a bad --prompt-file fails BEFORE we
    // spawn anything.
    let prompt: string | undefined = options.prompt
    if (options.promptFile !== undefined) {
        try {
            prompt = readFileSync(resolve(options.promptFile), 'utf8')
        } catch (error) {
            console.error(chalk.red('Error:'), `Failed to read --prompt-file: ${error instanceof Error ? error.message : String(error)}`)
            process.exit(1)
        }
    }
    if (prompt !== undefined && prompt.trim().length === 0) {
        console.error(chalk.red('Error:'), 'Prompt is empty')
        process.exit(1)
    }

    // The directory must already exist: the daemon would auto-create it
    // (approvedNewDirectoryCreation defaults to true on its side), but a
    // typo'd path silently creating directories is the wrong default for
    // automation.
    try {
        if (!statSync(directory).isDirectory()) {
            console.error(chalk.red('Error:'), `Not a directory: ${directory}`)
            process.exit(1)
        }
    } catch {
        console.error(chalk.red('Error:'), `Directory does not exist: ${directory}`)
        process.exit(1)
    }

    // Same semantics as the web: no running daemon on this machine → cannot
    // spawn. (Deliberately no ensureDaemonRunning: a dev build would restart
    // the installed daemon on version mismatch.)
    if (!await checkIfDaemonRunningAndCleanupStaleState()) {
        console.error(chalk.red('Error:'), 'Happy daemon is not running on this machine.')
        console.error(`Start it with ${chalk.cyan('very-happy daemon start')} and retry.`)
        process.exit(1)
    }

    logger.debug(`[SPAWN CMD] Spawning session in ${directory}`)
    const result = await spawnDaemonSession(directory)
    if (result?.error || !result?.success || !result?.sessionId) {
        const message = result?.error || 'Daemon returned no session ID'
        console.error(chalk.red('Error:'), `Failed to spawn session: ${message}`)
        process.exit(1)
    }

    const sessionId: string = result.sessionId
    const url = sessionWebUrl(sessionId)

    let promptError: string | null = null
    if (prompt !== undefined) {
        try {
            await sendFirstMessage(sessionId, prompt)
        } catch (error) {
            promptError = error instanceof Error ? error.message : String(error)
        }
    }

    if (options.json) {
        const payload: Record<string, unknown> = { sessionId, url }
        if (prompt !== undefined) {
            payload.promptDelivered = promptError === null
        }
        if (promptError !== null) {
            payload.error = `Session spawned but first message failed: ${promptError}`
        }
        console.log(JSON.stringify(payload))
    } else {
        console.log(`${chalk.bold('Session:')} ${sessionId}`)
        console.log(`${chalk.bold('URL:')}     ${url}`)
        if (prompt !== undefined && promptError === null) {
            console.log(chalk.green('First message sent.'))
        }
    }

    if (promptError !== null) {
        console.error(chalk.red('Error:'), `Session ${sessionId} was spawned, but sending the first message failed: ${promptError}`)
        console.error(`The session likely exists — open ${url} and send the message manually.`)
        process.exit(2)
    }

    process.exit(0)
}
