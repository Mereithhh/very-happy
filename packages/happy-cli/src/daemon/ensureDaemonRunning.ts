import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { logger } from '@/ui/logger'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient'
import { spawnHappyCLIOrphaned } from '@/utils/spawnHappyCLI'
import { readDaemonState } from '@/persistence'
import { configuration } from '@/configuration'
import { daemonEndpointsMatch } from '@/ui/doctorReadiness'
import { kickstartLaunchdJob, parseSystemdUnit } from './daemonSupervisor'

const DAEMON_READY_TIMEOUT_MS = 5000
const DAEMON_READY_POLL_INTERVAL_MS = 100

/**
 * B-965: what a wrapper does about the daemon before it starts its session.
 *
 * - `skip`: the wrapper was spawned by the daemon (`--started-by daemon`). That
 *   daemon is running by definition, and during an upgrade window it is older
 *   than the bundle the wrapper runs from. Replacing it from here made the new
 *   daemon a child of this wrapper (the next restart of this session
 *   tree-killed the daemon's other sessions) and, under systemd, stopped the
 *   unit's main process with exit 0, so the unit went inactive and nothing
 *   supervised the machine any more. The daemon replaces itself (auto-update,
 *   B-856 bundle watch). Claude wrappers already did this (B-512).
 * - `handover`: a mismatched daemon owned by systemd or launchd is replaced by
 *   its supervisor (B-505 / B-770), so the new one is the unit's / job's
 *   process, not this wrapper's child.
 * - `replace` / `start`: an unsupervised (or no) daemon; the new one is spawned
 *   orphaned, re-parented away from this wrapper.
 */
export type EnsureDaemonAction = 'ok' | 'skip' | 'handover' | 'replace' | 'start'

export function planEnsureDaemon(input: {
  startedBy?: string
  running: boolean
  matches: boolean
  supervisor?: string
}): EnsureDaemonAction {
  if (input.startedBy === 'daemon') return 'skip'
  if (input.running && input.matches) return 'ok'
  if (!input.running) return 'start'
  if (input.supervisor === 'systemd' || input.supervisor === 'launchd') return 'handover'
  return 'replace'
}

/**
 * B-965: env for a daemon started from a wrapper. A wrapper spawned by a
 * systemd-owned daemon inherits the unit's INVOCATION_ID and
 * HAPPY_DAEMON_SUPERVISOR; a daemon started from it is NOT the unit's process
 * and must not claim the supervisor (main.ts `daemon start` does the same, B-505).
 */
export function detachedDaemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { HAPPY_DAEMON_SUPERVISOR: _supervisor, INVOCATION_ID: _invocation, ...rest } = env
  return rest
}

export type SupervisorHandoverDeps = {
  readCgroup?: (pid: number) => string
  run?: (file: string, args: string[]) => { status: number | null }
  stop?: () => Promise<void>
  kickstart?: () => Promise<boolean>
}

/**
 * B-965: let the supervisor start the installed CLI as its own process.
 * systemd: `systemctl [--user] restart <the daemon's unit>` (the unit read from
 * the daemon's cgroup; `KillMode=process` keeps the wrappers). launchd: stop the
 * daemon (exit 0 keeps the job down) and kickstart the job (B-770). false = could
 * not hand over; the caller falls back to an orphaned replacement.
 */
export async function handOverToSupervisor(
  supervisor: string | undefined,
  daemonPid: number | undefined,
  deps: SupervisorHandoverDeps = {},
): Promise<boolean> {
  try {
    if (supervisor === 'systemd' && daemonPid) {
      const owner = parseSystemdUnit((deps.readCgroup ?? ((pid) => readFileSync(`/proc/${pid}/cgroup`, 'utf8')))(daemonPid))
      if (!owner) return false
      const run = deps.run ?? ((file, args) => spawnSync(file, args, { stdio: 'ignore', timeout: 30_000 }))
      return run('systemctl', [...(owner.user ? ['--user'] : []), 'restart', owner.unit]).status === 0
    }
    if (supervisor === 'launchd') {
      await (deps.stop ?? stopDaemon)()
      return await (deps.kickstart ?? (() => kickstartLaunchdJob()))()
    }
  } catch (error) {
    logger.debug('Supervisor handover failed', error)
  }
  return false
}

export async function ensureDaemonRunning(options: { startedBy?: string } = {}): Promise<void> {
  if (planEnsureDaemon({ startedBy: options.startedBy, running: true, matches: true }) === 'skip') {
    logger.debug('Daemon-spawned wrapper: leaving the daemon that started it alone')
    return
  }
  logger.debug('Ensuring Happy background service is running & matches our version...')

  const versionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion()
  const state = await readDaemonState()
  const endpointsMatch = Boolean(state) && daemonEndpointsMatch(
    state?.serverUrl,
    state?.webappUrl,
    configuration.serverUrl,
    configuration.webappUrl,
  )
  if (versionMatches && endpointsMatch) {
    return
  }

  const running = await checkIfDaemonRunningAndCleanupStaleState()
  let action = planEnsureDaemon({ running, matches: false, supervisor: state?.supervisor })
  if (action === 'handover') {
    logger.debug(`Handing the daemon over to ${state?.supervisor}...`)
    if (!await handOverToSupervisor(state?.supervisor, state?.pid)) {
      logger.debug('Supervisor handover failed; replacing the daemon directly')
      action = 'replace'
    }
  }
  if (action === 'replace') {
    logger.debug('Stopping daemon whose version or configured relay no longer matches...')
    await stopDaemon()
  }
  if (action !== 'handover') {
    logger.debug('Starting Happy background service...')
    // B-965: never this wrapper's child (see spawnHappyCLIOrphaned).
    spawnHappyCLIOrphaned(['daemon', 'start-sync'], { env: detachedDaemonEnv(process.env) })
  }

  // Wait for the new daemon to be fully ready: it must write daemon.state.json,
  // bind its HTTP port, and respond to a health ping. Without this, early callers
  // (e.g. notifyDaemonSessionStarted) race the daemon startup and the webhook is
  // silently lost — which later breaks resume-happy-session. A handover also
  // waits for the replacement (the state file names the new pid).
  const previousPid = state?.pid
  const deadline = Date.now() + (action === 'handover' ? 3 * DAEMON_READY_TIMEOUT_MS : DAEMON_READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (await checkIfDaemonRunningAndCleanupStaleState()) {
      const current = action === 'handover' ? await readDaemonState() : null
      if (action !== 'handover' || (current?.pid && current.pid !== previousPid)) {
        logger.debug('Happy background service is ready')
        return
      }
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS))
  }

  logger.debug(`Happy background service did not become ready within the timeout; continuing anyway`)
}
