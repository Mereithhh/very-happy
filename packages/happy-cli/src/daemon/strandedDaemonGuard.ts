/**
 * B-965 — the upgrade from a daemon that already left its supervisor.
 *
 * Before 0.2.226 a codex/gemini/pi/dsh/acp/openclaw wrapper spawned during an
 * upgrade window replaced the daemon itself: it stopped the supervisor's main
 * process over HTTP (exit 0, so `Restart=on-failure` / `KeepAlive.
 * SuccessfulExit=false` left the unit / job down) and started a new daemon as
 * its own child. That daemon still inherits the unit's environment, so it
 * reads itself as `systemd`-supervised and, on the next auto-update, hands over
 * by exiting 75 — with no unit watching. The machine goes offline until a
 * person runs `systemctl --user start`.
 *
 * That handover is the OLD daemon's code, but it runs the NEW bundle's
 * `--version` first (the handover preflight, B-321) and holds on any non-zero
 * exit. So the new bundle, asked by such a stranded daemon, repairs the machine
 * instead of answering: it starts the unit / job (whose fresh daemon on the new
 * bundle stops the stranded one over HTTP and re-adopts every wrapper —
 * `KillMode=process`, wrappers in their own sessions) and exits non-zero so the
 * stranded daemon does not exit 75. If the start fails, the stranded daemon
 * keeps running the old version: online, not upgraded, never offline.
 *
 * Recognised only when all of it holds, otherwise `--version` behaves as before:
 * - this process runs as a handover preflight (`HAPPY_HOME_DIR` is the
 *   preflight's throwaway `vh-preflight-*` home) and its parent is a
 *   `daemon start-sync` process;
 * - linux: the parent is in a systemd `.service` cgroup, claims systemd
 *   (`HAPPY_DAEMON_SUPERVISOR=systemd` or `INVOCATION_ID`), and the unit's
 *   `MainPID` is not the parent (0 = inactive, as observed);
 * - darwin: the parent carries the job's `XPC_SERVICE_NAME` and the job has
 *   no running process.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { HAPPY_DAEMON_LAUNCHD_LABEL, parseLaunchctlPid } from './claudeAuth/claudeAuthProbe';
import { parseSystemdUnit } from './daemonSupervisor';

export type StrandedDaemon =
    | { kind: 'systemd'; unit: string; user: boolean; mainPid: number | null }
    | { kind: 'launchd'; target: string };

export type StrandedGuardDeps = {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    ppid?: number;
    uid?: number | null;
    readFile?: (path: string) => string;
    run?: (file: string, args: string[]) => { status: number | null; stdout?: string };
};

const run = (file: string, args: string[]) => spawnSync(file, args, { encoding: 'utf8', timeout: 5_000 });

/** Is this `--version` a handover preflight of a `daemon start-sync` parent? */
export function isHandoverPreflight(env: NodeJS.ProcessEnv, parentCmdline: string): boolean {
    const home = env.HAPPY_HOME_DIR;
    if (!home || !basename(home).startsWith('vh-preflight-')) return false;
    return /\bdaemon start-sync\b/.test(parentCmdline.replace(/\0/g, ' '));
}

export function detectStrandedDaemon(deps: StrandedGuardDeps = {}): StrandedDaemon | null {
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    const ppid = deps.ppid ?? process.ppid;
    const read = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const exec = deps.run ?? run;
    try {
        if (platform === 'linux') {
            if (!isHandoverPreflight(env, read(`/proc/${ppid}/cmdline`))) return null;
            const claimsSystemd = env.HAPPY_DAEMON_SUPERVISOR?.trim().toLowerCase() === 'systemd' || Boolean(env.INVOCATION_ID?.trim());
            if (!claimsSystemd) return null;
            const owner = parseSystemdUnit(read(`/proc/${ppid}/cgroup`));
            if (!owner) return null;
            const shown = exec('systemctl', [...(owner.user ? ['--user'] : []), 'show', '-p', 'MainPID', '--value', owner.unit]);
            if (shown.status !== 0) return null; // cannot tell: behave as before
            const mainPid = Number((shown.stdout ?? '').trim());
            if (!Number.isInteger(mainPid) || mainPid === ppid) return null;
            return { kind: 'systemd', unit: owner.unit, user: owner.user, mainPid: mainPid > 0 ? mainPid : null };
        }
        if (platform === 'darwin') {
            const cmd = exec('ps', ['-o', 'command=', '-p', String(ppid)]);
            if (!isHandoverPreflight(env, cmd.stdout ?? '')) return null;
            if (env.XPC_SERVICE_NAME !== HAPPY_DAEMON_LAUNCHD_LABEL) return null;
            const uid = deps.uid !== undefined ? deps.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
            if (uid === null) return null;
            const target = `gui/${uid}/${HAPPY_DAEMON_LAUNCHD_LABEL}`;
            const printed = exec('launchctl', ['print', target]);
            if (printed.status !== 0) return null; // no such job: nothing to go back to
            if (parseLaunchctlPid(printed.stdout ?? '') !== null) return null; // the job runs: not stranded
            return { kind: 'launchd', target };
        }
    } catch {
        return null;
    }
    return null;
}

/** Start the unit / job without waiting for it (the stranded daemon must stay responsive to be stopped). */
export function reviveSupervisor(stranded: StrandedDaemon, exec: StrandedGuardDeps['run'] = run): boolean {
    try {
        if (stranded.kind === 'systemd') {
            // A unit that is active with another main process already has its daemon; leave it.
            if (stranded.mainPid !== null) return false;
            return exec('systemctl', [...(stranded.user ? ['--user'] : []), '--no-block', 'start', stranded.unit]).status === 0;
        }
        return exec('launchctl', ['kickstart', stranded.target]).status === 0;
    } catch {
        return false;
    }
}

/**
 * Called by `--version` before the self-check. Returns an exit code when this
 * is a stranded daemon's preflight (the caller prints and exits with it), or
 * null to answer normally.
 */
export function guardStrandedPreflight(deps: StrandedGuardDeps = {}): number | null {
    const stranded = detectStrandedDaemon(deps);
    if (!stranded) return null;
    const revived = reviveSupervisor(stranded, deps.run ?? run);
    const where = stranded.kind === 'systemd' ? stranded.unit : stranded.target;
    console.error(revived
        ? `very-happy: the running daemon is outside ${where}; started it there instead of handing over (B-965)`
        : `very-happy: the running daemon is outside ${where} and it could not be started; holding the handover (B-965)`);
    return 3;
}
