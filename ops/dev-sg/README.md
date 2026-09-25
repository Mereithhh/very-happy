# dev-sg daemon

dev-sg is one of the main development machines (Linux, always on) and a daemon
host next to the main Mac: sessions spawned there from the Web, and automation
driving `very-happy spawn` / `sessions read --wait` (B-492), run on it.

| Item | Fact (verified 2026-09-25) |
|---|---|
| Host | Ubuntu 24.04, x86_64, user `ubuntu`; `ssh dev-sg` |
| CLI install | global npm under prefix `/usr` → `/usr/bin/very-happy`, package in `/usr/lib/node_modules/very-happy-cli` (installed with `sudo npm i -g`) |
| Supervision | systemd **user** unit [`very-happy-daemon.service`](very-happy-daemon.service) installed by [`install-systemd-unit.sh`](install-systemd-unit.sh); `loginctl` linger = yes (runs without a login) |
| Daemon env | `~/.config/very-happy/daemon.env` (non-secret; optional) |
| Logs | `~/.local/state/happy/daemon-systemd.log` (unit stdout/stderr) + `~/.happy/logs/*-daemon.log` |
| Version | not recorded here; read it with the health check below |

## Health check

```bash
ssh dev-sg 'systemctl --user status very-happy-daemon --no-pager | head -5; very-happy daemon status; very-happy daemon list'
```

The unit's main PID is the daemon itself (`node --no-warnings --no-deprecation
/usr/bin/very-happy daemon start-sync`; the bin shim imports the CLI in-process
when node already carries the quiet flags). `daemon status` must report the
installed version as the running one and `supervisor: "systemd"` in the state.
`daemon list` prints every session wrapper with `turnActive` and a one-line
"N session(s) with a turn in flight" summary for the whole machine.

## Upgrade (B-505: never takes sessions down)

```bash
ssh dev-sg
bash ~/code/github/very-happy/ops/dev-sg/install-systemd-unit.sh --check   # unit up to date? (any checkout of main)
very-happy daemon list                          # optional courtesy: see what is mid-turn
sudo npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<version>
systemctl --user restart very-happy-daemon      # SIGTERM to the daemon ONLY; wrappers keep running
systemctl --user status very-happy-daemon --no-pager | head -5
very-happy daemon status                        # running daemon = installed CLI
very-happy daemon list                          # the same sessions, re-adopted (same pids)
```

Why this is safe now (2026-09-25, B-505):

- The unit runs with **`KillMode=process`**: stopping or restarting it signals
  the daemon process only. Session wrappers, their SDK children, MCP servers
  and the tmux terminals live in the same cgroup and are left alone; the new
  daemon re-adopts them (B-272). A turn in flight simply continues — the
  wrapper talks to the relay itself. Before this, the default
  `KillMode=control-group` SIGTERMed all of them the moment the daemon exited,
  which is how every earlier upgrade (`daemon stop` → `systemctl start`) ended
  the sessions that were mid-turn.
- The **wrapper's SIGTERM path no longer archives** (CLI ≥ 0.2.156): an
  infrastructure exit marks the session offline (`POST /deactivate`, active=false)
  and never touches `archivedAt`, so even a machine shutdown leaves sessions
  resumable from the Web "Restore" instead of archived. Wrappers older than
  that still self-archive on SIGTERM — one more reason the unit must not signal
  them.
- **Automatic updates** (`autoUpdatePolicy=latest`, B-503) hand over the same
  way: the daemon sees `HAPPY_DAEMON_SUPERVISOR=systemd`, exits **75** instead of
  spawning an unsupervised replacement, and `Restart=on-failure` (RestartSec 3 s)
  starts the installed bundle as the unit's new main process. The B-466 gate
  still waits for "no turn in flight" before installing.
- `very-happy daemon start` from a shell **refuses** while the running daemon is
  unit-owned and prints the `systemctl --user restart` line: a shell-started
  daemon would run outside systemd (nobody restarts it if it dies). `very-happy
  daemon stop` still works and stays stopped (exit 0 is not restarted); bring it
  back with `systemctl --user start very-happy-daemon`.
- The unit's `ExecStart` passes the node quiet flags so the main PID is the
  daemon, not the bin shim: with `KillMode=process` a shim as main PID would be
  the only process signalled and the real daemon would be orphaned.

Rollback of the unit: `git show <previous>:ops/dev-sg/very-happy-daemon.service`
→ install the same way → `daemon-reload`. Only revert together with a CLI
version that predates the `daemon start` refusal if you also need shell
handovers again.

- ⚠️ Daemons ≤ 0.2.142 exit **0** on a fatal socket error (B-477), and the unit
  is `Restart=on-failure`, so such a crash is not restarted. 0.2.143+ exit 1 on
  fatal errors. Keep dev-sg at ≥ 0.2.143.
