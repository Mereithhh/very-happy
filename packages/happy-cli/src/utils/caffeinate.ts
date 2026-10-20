/**
 * Caffeinate utility for preventing macOS from sleeping
 * Uses the built-in macOS caffeinate command to keep the system awake
 */

import { spawn, execSync, ChildProcess } from 'child_process'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'

let caffeinateProcess: ChildProcess | null = null

/**
 * Start caffeinate to prevent system sleep
 * Only works on macOS, silently does nothing on other platforms
 * 
 * @returns true if caffeinate was started, false otherwise
 */
export function startCaffeinate(): boolean {
    // Check if caffeinate is disabled via configuration
    if (configuration.disableCaffeinate) {
        logger.debug('[caffeinate] Caffeinate disabled via HAPPY_DISABLE_CAFFEINATE environment variable')
        return false
    }

    // Only run on macOS
    if (process.platform !== 'darwin') {
        logger.debug('[caffeinate] Not on macOS, skipping caffeinate')
        return false
    }

    // Don't start if already running
    if (caffeinateProcess && !caffeinateProcess.killed) {
        logger.debug('[caffeinate] Caffeinate already running')
        return true
    }

    // Kill caffeinate processes orphaned by OLD daemons (spawned without -w)
    killOrphanedCaffeinateProcesses()

    try {
        caffeinateProcess = spawn('caffeinate', caffeinateArgs(process.pid), {
            stdio: 'ignore',
            detached: false
        })

        caffeinateProcess.on('error', (error) => {
            logger.debug('[caffeinate] Error starting caffeinate:', error)
            caffeinateProcess = null
        })

        caffeinateProcess.on('exit', (code, signal) => {
            logger.debug(`[caffeinate] Process exited with code ${code}, signal ${signal}`)
            caffeinateProcess = null
        })

        logger.debug(`[caffeinate] Started with PID ${caffeinateProcess.pid}`)
        
        // Set up cleanup handlers
        setupCleanupHandlers()
        
        return true
    } catch (error) {
        logger.debug('[caffeinate] Failed to start caffeinate:', error)
        return false
    }
}

let isStopping = false

/**
 * Stop the caffeinate process
 */
export async function stopCaffeinate(): Promise<void> {
    // Prevent re-entrant calls during cleanup
    if (isStopping) {
        logger.debug('[caffeinate] Already stopping, skipping')
        return
    }
    
    if (caffeinateProcess && !caffeinateProcess.killed) {
        isStopping = true
        logger.debug(`[caffeinate] Stopping caffeinate process PID ${caffeinateProcess.pid}`)
        
        try {
            caffeinateProcess.kill('SIGTERM')
            
            // Give it a moment to terminate gracefully
            await new Promise(resolve => setTimeout(resolve, 1000))

            if (caffeinateProcess && !caffeinateProcess.killed) {
                logger.debug('[caffeinate] Force killing caffeinate process')
                caffeinateProcess.kill('SIGKILL')
            }
            caffeinateProcess = null
            isStopping = false
        } catch (error) {
            logger.debug('[caffeinate] Error stopping caffeinate:', error)
            isStopping = false
        }
    }
}

/**
 * Check if caffeinate is currently running
 */
export function isCaffeinateRunning(): boolean {
    return caffeinateProcess !== null && !caffeinateProcess.killed
}

/**
 * Set up cleanup handlers to ensure caffeinate is stopped on exit
 */
let cleanupHandlersSet = false

function setupCleanupHandlers(): void {
    if (cleanupHandlersSet) {
        return
    }
    
    cleanupHandlersSet = true
    
    // Clean up on various exit conditions
    const cleanup = () => {
        stopCaffeinate()
    }
    
    process.on('exit', cleanup)
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
    process.on('SIGUSR1', cleanup)
    process.on('SIGUSR2', cleanup)
    process.on('uncaughtException', (error) => {
        logger.debug('[caffeinate] Uncaught exception, cleaning up:', error)
        cleanup()
    })
    process.on('unhandledRejection', (reason, promise) => {
        logger.debug('[caffeinate] Unhandled rejection, cleaning up:', reason)
        cleanup()
    })
}

/**
 * B-517: `-w <pid>` ties the assertion to this daemon — caffeinate exits by
 * itself when the daemon dies, even on SIGKILL, so no new orphan can exist and
 * nothing has to be killed by name. (A name match — the old
 * `pkill -f "caffeinate -im"` — also killed a SIBLING daemon's caffeinate,
 * e.g. an isolated HAPPY_HOME_DIR test daemon starting on the production Mac,
 * which then never re-spawns it and the Mac can sleep.)
 */
export function caffeinateArgs(daemonPid: number): string[] {
    return ['-im', '-w', String(daemonPid)]
}

/**
 * Orphans from daemons older than B-517: exactly `caffeinate -im` (no `-w`),
 * already re-parented to launchd (ppid 1) because their daemon is gone. A live
 * daemon's caffeinate keeps that daemon as its parent and is never matched.
 * Input is `ps -A -o pid=,ppid=,command=`.
 */
export function orphanedLegacyCaffeinatePids(psOutput: string): number[] {
    const pids: number[] = []
    for (const line of psOutput.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
        if (!m) continue
        const [, pid, ppid, command] = m
        if (ppid !== '1') continue
        if (!/^(?:\/usr\/bin\/)?caffeinate -im$/.test(command)) continue
        pids.push(Number(pid))
    }
    return pids
}

export function killOrphanedCaffeinateProcesses(): void {
    if (process.platform !== 'darwin') return
    let ps: string
    try {
        ps = execSync('ps -A -o pid=,ppid=,command=', { timeout: 5000, encoding: 'utf8' })
    } catch (error) {
        logger.debug('[caffeinate] Could not list processes; skipping orphan cleanup:', error)
        return
    }
    for (const pid of orphanedLegacyCaffeinatePids(ps)) {
        try {
            process.kill(pid, 'SIGTERM')
            logger.debug(`[caffeinate] Killed orphaned legacy caffeinate PID ${pid}`)
        } catch {
            // already gone
        }
    }
}
