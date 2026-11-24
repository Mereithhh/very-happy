import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockCheckIfDaemonRunningAndCleanupStaleState: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
  mockReadDaemonState: vi.fn(),
  mockStopDaemon: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  checkIfDaemonRunningAndCleanupStaleState: mocks.mockCheckIfDaemonRunningAndCleanupStaleState,
  stopDaemon: mocks.mockStopDaemon,
}))

vi.mock('@/persistence', () => ({ readDaemonState: mocks.mockReadDaemonState }))
vi.mock('@/configuration', () => ({
  configuration: { serverUrl: 'https://api.example', webappUrl: 'https://web.example' },
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLIOrphaned: mocks.mockSpawnHappyCLI,
}))

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detachedDaemonEnv, ensureDaemonRunning, handOverToSupervisor, planEnsureDaemon } from './ensureDaemonRunning'

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
    mocks.mockReadDaemonState.mockResolvedValue({
      serverUrl: 'https://api.example',
      webappUrl: 'https://web.example',
    })
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('starts the daemon and waits for readiness when the installed version is not running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await ensureDaemonRunning()

    // B-965: orphaned (never this wrapper's child), without the unit's supervisor claim.
    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      env: detachedDaemonEnv(process.env),
    })
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledTimes(3)
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Happy background service is ready')
  })

  it('stops and restarts a same-version daemon connected to another relay', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)
    mocks.mockReadDaemonState.mockResolvedValue({
      serverUrl: 'https://old.example',
      webappUrl: 'https://old.example',
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockStopDaemon).toHaveBeenCalledOnce()
    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledOnce()
  })
})

describe('a wrapper never makes the daemon its own child (B-965)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
  })

  it('a daemon-spawned wrapper leaves even a mismatched daemon alone', async () => {
    expect(planEnsureDaemon({ startedBy: 'daemon', running: true, matches: false })).toBe('skip')
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    await ensureDaemonRunning({ startedBy: 'daemon' })
    expect(mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion).not.toHaveBeenCalled()
    expect(mocks.mockStopDaemon).not.toHaveBeenCalled()
    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
  })

  it('plans: supervised → handover, unsupervised → replace, none → start', () => {
    expect(planEnsureDaemon({ startedBy: 'terminal', running: true, matches: false, supervisor: 'systemd' })).toBe('handover')
    expect(planEnsureDaemon({ running: true, matches: false, supervisor: 'launchd' })).toBe('handover')
    expect(planEnsureDaemon({ running: true, matches: false, supervisor: 'none' })).toBe('replace')
    expect(planEnsureDaemon({ running: true, matches: false })).toBe('replace')
    expect(planEnsureDaemon({ running: false, matches: false })).toBe('start')
    expect(planEnsureDaemon({ running: true, matches: true })).toBe('ok')
  })

  it('systemd: restarts the unit the daemon runs in, never spawns a replacement itself', async () => {
    const run = vi.fn(() => ({ status: 0 }))
    const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/very-happy-daemon.service\n'
    expect(await handOverToSupervisor('systemd', 42, { readCgroup: () => cgroup, run })).toBe(true)
    expect(run).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'very-happy-daemon.service'])
    // A daemon outside any unit (or a failed restart) falls back to an orphaned replacement.
    expect(await handOverToSupervisor('systemd', 42, { readCgroup: () => '0::/user.slice/session-3.scope\n', run })).toBe(false)
    expect(await handOverToSupervisor('systemd', 42, { readCgroup: () => cgroup, run: () => ({ status: 1 }) })).toBe(false)
  })

  it('launchd: stops the daemon and kickstarts the job', async () => {
    const order: string[] = []
    const ok = await handOverToSupervisor('launchd', 42, {
      stop: async () => { order.push('stop') },
      kickstart: async () => { order.push('kickstart'); return true },
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['stop', 'kickstart'])
  })

  it('a daemon started from a wrapper does not claim the unit\'s supervisor', () => {
    expect(detachedDaemonEnv({ INVOCATION_ID: 'x', HAPPY_DAEMON_SUPERVISOR: 'systemd', HAPPY_HOME_DIR: '/h' })).toEqual({ HAPPY_HOME_DIR: '/h' })
  })

  it('every wrapper entry point passes its --started-by', async () => {
    const main = await readFile(join(__dirname, '..', 'main.ts'), 'utf8')
    const codex = await readFile(join(__dirname, '..', 'commands', 'codexCommand.ts'), 'utf8')
    expect(main).not.toMatch(/ensureDaemonRunning\(\)/)
    expect(main.match(/ensureDaemonRunning\(\{ startedBy(: (parsed|options)\.startedBy)? \}\)/g)).toHaveLength(6)
    expect(codex).toContain('await ensureDaemonRunning({ startedBy })')
  })
})
