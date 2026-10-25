import { execFile, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { classifyLineage, parseLaunchctlPid, HAPPY_DAEMON_LAUNCHD_LABEL, type ClaudeAuthLineage } from './claudeAuth/claudeAuthProbe';

/**
 * B-505 — who restarts this daemon when it exits, and therefore how a CLI
 * upgrade must hand the machine over.
 *
 * An unsupervised daemon (a shell `daemon start`) replaces itself: it
 * releases the state, lock and socket, spawns `very-happy daemon start`
 * detached and exits 0. Nothing else is touched, so the session wrappers keep
 * running and the new daemon re-adopts them.
 *
 * B-770: that same move is what took mac-office out of launchd. The
 * replacement is spawned detached (its own process group), so it survives the
 * job, re-parents to PID 1 and is not the job's process; the old daemon's
 * exit 0 then satisfies `KeepAlive.SuccessfulExit=false`, the job reads
 * `not running`, and nothing restarts the new daemon when it crashes. A
 * launchd-owned daemon therefore hands over exactly like a systemd one.
 *
 * Under a systemd service the same move is wrong twice over. A unit with the
 * default `KillMode=control-group` SIGTERMs EVERY remaining process of the
 * cgroup the moment its main process exits — the spawned replacement daemon,
 * every session wrapper, their SDK children and MCP servers (2026-09-25:
 * `daemon stop` for the 0.2.155 upgrade ended two sessions mid-turn this way).
 * And even with `KillMode=process`, a daemon spawned from inside the unit is
 * invisible to systemd: the unit reads `inactive`, `Restart=` never watches it.
 *
 * So a supervised daemon does not spawn its successor. It exits with
 * `HANDOVER_EXIT_CODE` and lets the supervisor start the installed bundle as
 * its new main process: systemd via `Restart=on-failure` (`KillMode=process`
 * keeps the wrappers alive in the cgroup), launchd via `KeepAlive.
 * SuccessfulExit=false` (wrappers are spawned detached, in their own process
 * groups, so the job exit does not reap them; the launch wrapper finds the
 * state released and execs `daemon start-sync`). The new daemon re-adopts the
 * wrappers. `systemctl --user restart` / `daemon start` (stop, then a plain
 * `launchctl kickstart`, B-770) are the manual equivalents.
 *
 * Detection: the unit says so explicitly (`HAPPY_DAEMON_SUPERVISOR=systemd`),
 * or systemd's own `INVOCATION_ID` is present — set for every service's main
 * process since systemd 232 and inherited by children, never by a login
 * shell. A shell-started daemon therefore reads `none` even on a systemd host.
 * launchd is never taken from the environment alone: `XPC_SERVICE_NAME` is
 * inherited by everything the job ever spawned (including a daemon that
 * already escaped it), and exiting 75 with no job watching would leave the
 * machine offline. It must also be proven that the job's current pid is this
 * process or one of its ancestors (`launchctl print`) — the same evidence the
 * Claude auth lineage uses, so the two can never disagree.
 */
export type DaemonSupervisor = 'launchd' | 'systemd' | 'none';

/** What `launchctl print gui/<uid>/<label>` says about the job, plus our own pid chain. */
export interface LaunchdJobEvidence {
    jobPid: number | null;
    /** This process first, then its ancestors. */
    ancestorPids: number[];
}

export function detectDaemonSupervisor(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
    launchd: LaunchdJobEvidence | null = null,
): DaemonSupervisor {
    const explicit = env.HAPPY_DAEMON_SUPERVISOR?.trim().toLowerCase();
    if (explicit === 'systemd') return 'systemd';
    if (explicit === 'none') return 'none';
    if (platform === 'linux' && typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.trim() !== '') return 'systemd';
    if (platform === 'darwin' && launchd && classifyLineage({ platform, env, launchdJobPid: launchd.jobPid, ancestorPids: launchd.ancestorPids }) === 'launchd') return 'launchd';
    return 'none';
}

/**
 * B-770: the machine page's "daemon lineage". It used to be computed on darwin
 * only, so a systemd-owned dev-sg daemon (state `supervisor: systemd`) showed
 * `other · linux`. A supervisor, when there is one, is the lineage.
 */
export function daemonLineage(
    supervisor: DaemonSupervisor,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
    launchd: LaunchdJobEvidence | null = null,
): ClaudeAuthLineage {
    if (supervisor !== 'none') return supervisor;
    return classifyLineage({ platform, env, launchdJobPid: launchd?.jobPid ?? null, ancestorPids: launchd?.ancestorPids ?? [] });
}

function execText(file: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: LAUNCHD_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout ?? '')));
    });
}

const LAUNCHD_PROBE_TIMEOUT_MS = 3000;

/** darwin only; any failure reads as "no job", i.e. unsupervised. */
export async function probeLaunchdJob(exec: (file: string, args: string[]) => Promise<string> = execText): Promise<LaunchdJobEvidence> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const jobPid = uid === null ? null : parseLaunchctlPid(await exec('launchctl', ['print', `gui/${uid}/${HAPPY_DAEMON_LAUNCHD_LABEL}`]));
    const ancestorPids = [process.pid];
    let pid = process.ppid;
    for (let i = 0; i < 10 && pid > 1; i++) {
        ancestorPids.push(pid);
        const ppid = Number((await exec('ps', ['-o', 'ppid=', '-p', String(pid)])).trim());
        if (!Number.isFinite(ppid) || ppid <= 0 || ppid === pid) break;
        pid = ppid;
    }
    return { jobPid, ancestorPids };
}

/**
 * B-817b — may the handover leave while a turn or background task is running?
 *
 * B-817 stopped holding the handover for turns once the bundle is replaced:
 * wrappers are detached and re-adopted, so a turn runs straight through. That
 * is only true when the way this process leaves does not take the wrappers
 * with it, and `detectDaemonSupervisor` reads `systemd` from `INVOCATION_ID`
 * alone — any unit, `systemd-run` or distro template. The CLI ships no unit;
 * a hand-written one has the default `KillMode=control-group`, and exit 75
 * then SIGTERMs every wrapper in the cgroup (2026-09-25, above). Before B-817
 * that only cost idle wrappers; without the gate it would end turns.
 *
 * So the gate is skipped only where the exit provably spares the wrappers:
 * - `none`: the old daemon spawns its successor and exits 0, wrappers are in
 *   their own sessions — unless this process is a container's init (PID 1)
 *   or the direct child of one (tini, `docker run --init`): the container
 *   ends with it. Windows is unverified and keeps the gate.
 * - `launchd`: the job's exit reaps only its own process group (B-770).
 * - `systemd` with the unit's `KillMode` read back as `process` (or `none`).
 *   When it cannot be read, an explicit `HAPPY_DAEMON_SUPERVISOR=systemd`
 *   (only set by the shipped unit, which pairs it with `KillMode=process`)
 *   is accepted; a read-back `control-group`/`mixed` always wins over it.
 */
export interface HandoverSurvivalEvidence {
    supervisor: DaemonSupervisor;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    pid: number;
    ppid: number;
    /** `/.dockerenv` or `/run/.containerenv` exists. */
    inContainer: boolean;
    /** The unit's `KillMode` from `systemctl show`, or null when unknown. */
    systemdKillMode: string | null;
}

export function wrappersSurviveHandover(e: HandoverSurvivalEvidence): boolean {
    if (e.supervisor === 'launchd') return true;
    if (e.supervisor === 'systemd') {
        const killMode = e.systemdKillMode?.trim().toLowerCase();
        if (killMode) return killMode === 'process' || killMode === 'none';
        return e.env.HAPPY_DAEMON_SUPERVISOR?.trim().toLowerCase() === 'systemd';
    }
    if (e.platform === 'win32') return false;
    if (e.pid === 1) return false;
    if (e.inContainer && e.ppid === 1) return false;
    return true;
}

/**
 * Whether running turns/background tasks hold the handover. Only a replaced
 * bundle (not a relay move, not both at once) whose exit spares the wrappers
 * may leave mid-turn.
 */
export function handoverWaitsForSessions(o: { bundleReplaced: boolean; relayMove: boolean; sparesWrappers: boolean }): boolean {
    return !o.bundleReplaced || o.relayMove || !o.sparesWrappers;
}

/**
 * The systemd unit owning this process, from `/proc/self/cgroup` (v2 `0::`
 * line, else v1 `name=systemd`). A user-manager unit sits under
 * `user@<uid>.service/`, which decides `systemctl --user`.
 */
export function parseSystemdUnit(cgroup: string): { unit: string; user: boolean } | null {
    const lines = cgroup.split('\n');
    const path = lines.find((line) => line.startsWith('0::'))?.slice(3)
        ?? lines.find((line) => line.split(':')[1] === 'name=systemd')?.split(':').slice(2).join(':');
    if (!path) return null;
    const segments = path.trim().split('/').filter(Boolean);
    let index = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].endsWith('.service')) { index = i; break; }
    }
    if (index < 0) return null;
    const unit = segments[index];
    if (!/^[A-Za-z0-9:_.@\\-]+\.service$/.test(unit) || /^user@\d+\.service$/.test(unit)) return null;
    return { unit, user: segments.slice(0, index).some((segment) => /^user@\d+\.service$/.test(segment)) };
}

/** linux only; any failure reads as "unknown" (null), which keeps the turn gate unless the unit said so explicitly. */
export async function probeSystemdKillMode(
    readCgroup: () => Promise<string> = () => readFile('/proc/self/cgroup', 'utf8'),
    exec: (file: string, args: string[]) => Promise<string> = execText,
): Promise<string | null> {
    const owner = parseSystemdUnit(await readCgroup().catch(() => ''));
    if (!owner) return null;
    const out = (await exec('systemctl', [...(owner.user ? ['--user'] : []), 'show', '-p', 'KillMode', '--value', owner.unit])).trim();
    return /^[a-z-]+$/.test(out) ? out : null;
}

/** The manual, supervisor-owned restart for a host whose daemon reads `systemd`. */
export const SYSTEMD_RESTART_HINT = 'systemctl --user restart very-happy-daemon';

/**
 * B-770: `daemon start` hands a launchd-owned daemon back to its job. Call after
 * `daemon stop` (exit 0, so the job stays down): a plain kickstart starts the
 * wrapper, which execs `daemon start-sync` on the installed CLI. Not `-k`: the
 * job's pid is the bin shim, and a SIGTERM there skips the daemon's cleanup.
 */
export async function kickstartLaunchdJob(
    run: (file: string, args: string[]) => { status: number | null; stdout?: string } = (file, args) => spawnSync(file, args, { encoding: 'utf8', timeout: LAUNCHD_PROBE_TIMEOUT_MS }),
    uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
    if (uid === null) return false;
    const target = `gui/${uid}/${HAPPY_DAEMON_LAUNCHD_LABEL}`;
    try {
        // The stopped daemon is gone, but the job's pid is the bin shim, which
        // exits just after it; a kickstart while that pid is still listed is a
        // no-op and would leave the job down.
        for (let i = 0; i < 50; i++) {
            const printed = run('launchctl', ['print', target]);
            if (printed.status !== 0) return false;
            if (parseLaunchctlPid(printed.stdout ?? '') === null) break;
            await sleep(100);
        }
        return run('launchctl', ['kickstart', target]).status === 0;
    } catch {
        return false;
    }
}
