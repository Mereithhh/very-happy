/**
 * `very-happy spawn` — one-shot automation entry point:
 * spawn a remote happy session via the LOCAL daemon control server and
 * (optionally) send the first user message, printing a clickable web URL.
 *
 * Designed for external automation (e.g. jojo-agent) running on the same
 * machine as the daemon:
 *
 *   very-happy spawn --dir <cwd> [--prompt <text>|--prompt-file <path>] [--json]
 *   very-happy spawn --fork <sessionId> [--prompt …] [--json]
 *
 * B-492: defaults match the web launcher — permission mode and first-message
 * model come from happy-wire's AGENT_CODE_DEFAULTS (claude: yolo on Opus 5.5),
 * overridable with --permission-mode / --model. `--fork` is the web's fork.
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
import { checkIfDaemonRunningAndCleanupStaleState, spawnDaemonSession, stopDaemonSession } from '@/daemon/controlClient'
import { readPersistedSessions } from '@/persistence'
import { resolveFirstMessageMeta, resolveSpawnPermissionMode, type FirstMessageMeta } from './spawnDefaults'
import { forkProviderConversation, resolveForkSource, type ForkSource } from './spawnFork'
import { readSessionMetadata } from '@/sessions/sessionOps'
import { sendUserMessage, sessionWebUrl, waitForSessionKey } from './sessionMessage'
import { isValidSpawnOrigin } from '@/utils/createSessionMetadata'
import { ALLOWED_SPAWN_PERMISSION_MODES, sanitizeSpawnPermissionMode } from '@/daemon/spawnPermissionMode'
import { logger } from '@/ui/logger'

// Re-exported for back-compat (tests and external imports historically used
// `spawn.ts` as the home of this helper; the implementation now lives in the
// shared sessionMessage module).
export { sessionWebUrl } from './sessionMessage'

export interface SpawnCommandOptions {
    dir?: string
    prompt?: string
    promptFile?: string
    /** B-303: spawn origin — becomes the new session's tag (e.g. 'tanka'). */
    spawnedBy?: string
    /** B-306: permission mode for the new session (see SPAWN_AGENTS note). */
    permissionMode?: string
    /** B-306: which backend runs the session. */
    agent?: string
    /** B-306: extra environment for the session process. */
    env?: Record<string, string>
    /** B-492: model for the first message ('default' = machine default). */
    model?: string
    /** B-492: fork this session (id) instead of starting from scratch. */
    fork?: string
    json: boolean
    help: boolean
}

/** Pure argv parser (exported for tests). Throws on malformed input. */
/** Backends the daemon's spawn RPC accepts — the shared list in utils/spawnAgents. */
import { SPAWN_AGENTS } from '@/utils/spawnAgents'
export { SPAWN_AGENTS }

/** Pure parser for one `--env KEY=VALUE` pair (exported for tests). */
export function parseEnvAssignment(raw: string): [string, string] {
    const eq = raw.indexOf('=')
    if (eq <= 0) throw new Error(`--env expects KEY=VALUE, got: ${raw}`)
    const key = raw.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`--env key is not a valid variable name: ${key}`)
    return [key, raw.slice(eq + 1)]
}

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
        } else if (arg === '--spawned-by') {
            const value = args[++i]
            if (value === undefined) throw new Error('--spawned-by requires a value')
            // Validate here, not at the daemon: a typo'd origin would otherwise
            // spawn a perfectly good but silently untagged session, and the
            // caller (an unattended adapter) would never notice.
            if (!isValidSpawnOrigin(value)) {
                throw new Error('--spawned-by must be 1-24 chars of [a-z0-9] plus - or _, starting with a letter or digit')
            }
            options.spawnedBy = value
        } else if (arg === '--permission-mode') {
            const value = args[++i]
            if (value === undefined) throw new Error('--permission-mode requires a value')
            // Reject here rather than at the daemon: the daemon logs an invalid
            // mode and spawns WITHOUT the flag, so a typo would silently hand an
            // unattended dispatcher a session that blocks on the first prompt.
            if (sanitizeSpawnPermissionMode(value) === null) {
                throw new Error(`--permission-mode must be one of: ${ALLOWED_SPAWN_PERMISSION_MODES.join(', ')}`)
            }
            options.permissionMode = value
        } else if (arg === '--agent') {
            const value = args[++i]
            if (value === undefined) throw new Error('--agent requires a value')
            if (!(SPAWN_AGENTS as readonly string[]).includes(value)) {
                throw new Error(`--agent must be one of: ${SPAWN_AGENTS.join(', ')}`)
            }
            options.agent = value
        } else if (arg === '--env') {
            const value = args[++i]
            if (value === undefined) throw new Error('--env requires a value')
            const [key, val] = parseEnvAssignment(value)
            options.env = { ...(options.env ?? {}), [key]: val }
        } else if (arg === '--model' || arg === '-m') {
            const value = args[++i]
            if (value === undefined || value.trim().length === 0) throw new Error('--model requires a value')
            options.model = value
        } else if (arg === '--fork') {
            const value = args[++i]
            if (value === undefined) throw new Error('--fork requires a session id')
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid session id for --fork: ${value}`)
            options.fork = value
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
${chalk.bold('very-happy spawn')} - Spawn a remote session via the local daemon (for automation)

${chalk.bold('Usage:')}
  very-happy spawn --dir <path> [--prompt <text> | --prompt-file <file>]
                   [--spawned-by <name>] [--permission-mode <mode>]
                   [--agent <name>] [--model <id>] [--env KEY=VALUE]... [--json]
  very-happy spawn --fork <sessionId> [--prompt …] [--permission-mode <mode>]
                   [--model <id>] [--spawned-by <name>] [--json]

${chalk.bold('Options:')}
  --dir, -d <path>       Working directory for the new session (required)
  --prompt, -p <text>    First message to send after the session starts
  --prompt-file <file>   Read the first message from a file (UTF-8)
  --spawned-by <name>    Tag the new session with its origin (e.g. tanka).
                            1-24 chars: [a-z0-9] plus - or _. Shows as a chip in
                            the web list and is searchable as #<name>.
  --permission-mode <m>  Permission mode for the new session: default,
                            acceptEdits, plan, yolo, bypassPermissions.
                            Default = the web launcher's: yolo for claude /
                            codex / pi, 'default' for gemini / openclaw. A fork
                            keeps its source's mode. 'default' stops at the first
                            un-allowlisted tool until someone approves it (see
                            \`sessions approve\`).
  --agent <name>         Backend to run: claude (default), codex, gemini,
                            openclaw, pi (needs pi-acp on the daemon's PATH).
  --model, -m <id>       Model for the session, sent with the first message
                            (needs --prompt). Default = the web launcher's:
                            claude-opus-5-5 for claude (the machine default when
                            its Claude Code is too old for it); other agents use
                            their own default. 'default' = the machine default.
  --fork <sessionId>     Fork an existing session of THIS machine (same as the
                            web's fork): copies its conversation and continues
                            it in a new session, in the same directory and with
                            the same agent (so --dir / --agent are not needed).
  --env KEY=VALUE        Extra environment for the session process. Repeatable.
                            \${VAR} is expanded against the daemon's environment;
                            an unresolved reference fails the spawn.
  --json                 Machine-readable output: {"sessionId", "url",
                            "permissionMode", …}
  -h, --help             Show this help

${chalk.bold('Behavior:')}
  Requires the Very Happy daemon to be running on this machine (same semantics
  as spawning from the web: an offline machine cannot spawn). Without
  --prompt / --prompt-file the session is spawned idle. To collect the reply:
  \`very-happy sessions read <id> --wait --answer\`.

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
async function sendFirstMessage(
    sessionId: string,
    text: string,
    metaFor: (capabilities: string[] | null) => FirstMessageMeta,
): Promise<FirstMessageMeta> {
    const persisted = await waitForSessionKey(sessionId, 15_000)
    const meta = metaFor(persisted.metadata?.capabilities ?? null)
    await sendUserMessage(sessionId, persisted, text, 'cli-spawn', meta)
    return meta
}

export async function handleSpawnCommand(args: string[]): Promise<never> {
    let options: SpawnCommandOptions
    try {
        options = parseSpawnArgs(args)
    } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
        console.error(`Run ${chalk.cyan('very-happy spawn --help')} for usage.`)
        process.exit(1)
    }

    if (options.help) {
        printHelp()
        process.exit(0)
    }

    let forkSource: ForkSource | null = null
    if (options.fork !== undefined) {
        try {
            // sessions.json keeps spawn-time metadata; the provider conversation
            // id arrives later, so overlay the server's current metadata.
            const persisted = readPersistedSessions()[options.fork]
            const current = persisted ? await readSessionMetadata(options.fork, persisted) : null
            forkSource = resolveForkSource(options.fork, persisted && current ? { ...persisted, metadata: { ...persisted.metadata, ...current } } : persisted)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error))
            process.exit(1)
        }
        if (options.dir !== undefined && resolve(options.dir) !== forkSource.directory) {
            console.error(chalk.red('Error:'), `--dir ${resolve(options.dir)} differs from the forked session's directory ${forkSource.directory}; a fork always continues in its source directory.`)
            process.exit(1)
        }
        if (options.agent !== undefined && options.agent !== forkSource.agent) {
            console.error(chalk.red('Error:'), `--agent ${options.agent} differs from the forked session's agent ${forkSource.agent}.`)
            process.exit(1)
        }
    } else if (!options.dir) {
        console.error(chalk.red('Error:'), '--dir is required (or --fork <sessionId>)')
        console.error(`Run ${chalk.cyan('very-happy spawn --help')} for usage.`)
        process.exit(1)
    }
    const directory = forkSource ? forkSource.directory : resolve(options.dir as string)
    const agent = forkSource ? forkSource.agent : options.agent
    // Web launcher semantics (B-492): explicit flag, else a fork keeps its
    // source's mode, else the per-agent code default (claude: yolo).
    const permissionMode = options.permissionMode ?? forkSource?.permissionMode ?? resolveSpawnPermissionMode(agent, undefined)

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
    if (options.model !== undefined && prompt === undefined) {
        // The model travels on a message (web semantics); an idle spawn has none.
        console.error(chalk.red('Error:'), '--model needs --prompt / --prompt-file (the model is sent with the first message); for an idle session pass it later with `very-happy send --model`.')
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

    // Fork step 1 (web: claude-fork-session / codex-fork-thread RPC): copy the
    // conversation locally. Only after the daemon check, so a stopped daemon
    // does not leave an orphan copy behind.
    let resumeIds: { resumeClaudeSessionId?: string; resumeCodexThreadId?: string } = {}
    if (forkSource) {
        try {
            resumeIds = await forkProviderConversation(forkSource)
        } catch (error) {
            console.error(chalk.red('Error:'), `Failed to fork session ${forkSource.parentSessionId}: ${error instanceof Error ? error.message : String(error)}`)
            process.exit(1)
        }
    }

    logger.debug(`[SPAWN CMD] Spawning session in ${directory}${forkSource ? ` (fork of ${forkSource.parentSessionId})` : ''}`)
    // A daemon older than the field strips the unknown key from its zod body
    // schema, so the session still spawns — just without that option (铁律 4).
    // ⚠️ For --permission-mode that degradation is silent and matters: the
    // session comes up in 'default' and will block on approval. Version skew is
    // transient (the daemon runs from this same install and hands over on
    // update), but a caller that MUST have bypass should check
    // `very-happy daemon status` after an upgrade.
    const result = await spawnDaemonSession(directory, undefined, {
        spawnedBy: options.spawnedBy,
        permissionMode,
        agent,
        environmentVariables: options.env,
        ...resumeIds,
        ...(forkSource ? { parentSessionId: forkSource.parentSessionId } : {}),
    })
    if (result?.error || !result?.success || !result?.sessionId) {
        const message = result?.error || 'Daemon returned no session ID'
        console.error(chalk.red('Error:'), `Failed to spawn session: ${message}`)
        process.exit(1)
    }

    const sessionId: string = result.sessionId
    const url = sessionWebUrl(sessionId)

    // A daemon older than B-492 strips the resume fields and starts a FRESH
    // session — silently wrong for a fork. Stop it instead of handing it out.
    if (forkSource && result.resumed !== true) {
        await stopDaemonSession(sessionId).catch(() => false)
        console.error(chalk.red('Error:'), 'The running daemon is too old to fork from the CLI (it spawned a fresh session, now stopped). Restart the daemon on this CLI version and retry.')
        process.exit(1)
    }

    let promptError: string | null = null
    let sentMeta: FirstMessageMeta | null = null
    if (prompt !== undefined) {
        try {
            sentMeta = await sendFirstMessage(sessionId, prompt, (capabilities) => resolveFirstMessageMeta({
                agent, permissionMode, explicitModel: options.model, capabilities,
            }))
        } catch (error) {
            promptError = error instanceof Error ? error.message : String(error)
        }
    }

    if (options.json) {
        const payload: Record<string, unknown> = { sessionId, url, permissionMode }
        if (options.spawnedBy !== undefined) {
            payload.spawnedBy = options.spawnedBy
        }
        if (agent !== undefined) {
            payload.agent = agent
        }
        if (forkSource) {
            payload.forkedFrom = forkSource.parentSessionId
        }
        if (sentMeta && sentMeta.model !== undefined) {
            payload.model = sentMeta.model
        }
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
