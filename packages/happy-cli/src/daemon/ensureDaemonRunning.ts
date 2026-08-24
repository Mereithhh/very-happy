import { logger } from '@/ui/logger'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { readDaemonState } from '@/persistence'
import { configuration } from '@/configuration'
import { daemonEndpointsMatch } from '@/ui/doctorReadiness'

const DAEMON_READY_TIMEOUT_MS = 5000
const DAEMON_READY_POLL_INTERVAL_MS = 100

export async function ensureDaemonRunning(): Promise<void> {
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

  if (await checkIfDaemonRunningAndCleanupStaleState()) {
    logger.debug('Stopping daemon whose version or configured relay no longer matches...')
    await stopDaemon()
  }

  logger.debug('Starting Happy background service...')

  const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  daemonProcess.unref()

  // Wait for the spawned daemon to be fully ready: it must write daemon.state.json,
  // bind its HTTP port, and respond to a health ping. Without this, early callers
  // (e.g. notifyDaemonSessionStarted) race the daemon startup and the webhook is
  // silently lost — which later breaks resume-happy-session.
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkIfDaemonRunningAndCleanupStaleState()) {
      logger.debug('Happy background service is ready')
      return
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS))
  }

  logger.debug(`Happy background service did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms; continuing anyway`)
}
