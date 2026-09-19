/**
 * B-477 — a crash must not exit 0, or the supervisor will not restart it.
 *
 * `cleanupAndShutdown` used to `process.exit(0)` for every shutdown source,
 * including `'exception'` (an uncaught exception or unhandled rejection). The
 * mac-office LaunchAgent is installed with `KeepAlive = {SuccessfulExit: false}`
 * (`ops/mac-office/install-launch-agent.sh`) — a deliberate choice, because the
 * relaunch wrapper also exits 0 when it finds a healthy daemon already running,
 * and unconditional KeepAlive would respawn it every ThrottleInterval.
 *
 * So the crash reported success and launchd did exactly what it was told:
 * nothing. 2026-09-19 the machine sat offline for 25 hours after a single
 * dropped RPC ack (see `api/socketAck.ts`).
 *
 * The shutdown source is the truth about the exit code. A requested shutdown —
 * signal, CLI, app — is a success. An exception is a failure, and saying so is
 * what lets any supervisor (launchd, systemd, a wrapper checking `$?`) bring the
 * daemon back without a human.
 */
export type ShutdownSource = 'happy-app' | 'happy-cli' | 'os-signal' | 'exception';

export function daemonExitCode(source: ShutdownSource): 0 | 1 {
    return source === 'exception' ? 1 : 0;
}
