/**
 * B-505 — who restarts this daemon when it exits, and therefore how a CLI
 * upgrade must hand the machine over.
 *
 * On mac-office/launchd the daemon replaces itself: it releases the state,
 * lock and socket, spawns `very-happy daemon start` detached and exits 0.
 * Nothing else in the job is touched, so the session wrappers keep running
 * and the new daemon re-adopts them.
 *
 * Under a systemd service the same move is wrong twice over. A unit with the
 * default `KillMode=control-group` SIGTERMs EVERY remaining process of the
 * cgroup the moment its main process exits — the spawned replacement daemon,
 * every session wrapper, their SDK children and MCP servers (2026-09-25:
 * `daemon stop` for the 0.2.155 upgrade ended two sessions mid-turn this way).
 * And even with `KillMode=process`, a daemon spawned from inside the unit is
 * invisible to systemd: the unit reads `inactive`, `Restart=` never watches it.
 *
 * So a systemd-supervised daemon does not spawn its successor. It exits with
 * `HANDOVER_EXIT_CODE` and lets the unit (`Restart=on-failure`, `KillMode=
 * process`) start the installed bundle as its new main process; wrappers stay
 * alive in the cgroup and are re-adopted. The same unit settings make
 * `systemctl --user restart` the manual upgrade path with identical semantics.
 *
 * Detection: the unit says so explicitly (`HAPPY_DAEMON_SUPERVISOR=systemd`),
 * or systemd's own `INVOCATION_ID` is present — set for every service's main
 * process since systemd 232 and inherited by children, never by a login
 * shell. A shell-started daemon therefore reads `none` even on a systemd host.
 */
export type DaemonSupervisor = 'systemd' | 'none';

export function detectDaemonSupervisor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): DaemonSupervisor {
    const explicit = env.HAPPY_DAEMON_SUPERVISOR?.trim().toLowerCase();
    if (explicit === 'systemd') return 'systemd';
    if (explicit === 'none') return 'none';
    if (platform === 'linux' && typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID.trim() !== '') return 'systemd';
    return 'none';
}

/** The manual, supervisor-owned restart for a host whose daemon reads `systemd`. */
export const SYSTEMD_RESTART_HINT = 'systemctl --user restart very-happy-daemon';
