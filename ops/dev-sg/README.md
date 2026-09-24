# dev-sg daemon

dev-sg is one of the main development machines (Linux, always on) and a daemon
host next to mac-office: sessions spawned there from the Web, and automation
driving `very-happy spawn` / `sessions read --wait` (B-492), run on it.

| Item | Fact (verified 2026-09-25) |
|---|---|
| Host | Ubuntu 24.04, x86_64, user `ubuntu`; `ssh dev-sg` |
| CLI install | global npm under prefix `/usr` → `/usr/bin/very-happy`, package in `/usr/lib/node_modules/very-happy-cli` (installed with `sudo npm i -g`) |
| Supervision | systemd **user** unit [`very-happy-daemon.service`](very-happy-daemon.service), `loginctl` linger = yes (runs without a login) |
| Daemon env | `~/.config/very-happy/daemon.env` (non-secret; optional) |
| Logs | `~/.local/state/happy/daemon-systemd.log` (unit stdout/stderr) + `~/.happy/logs/*-daemon.log` |
| Version on 2026-09-25 | 0.2.142 — below 0.2.143, see the warning below |

## Health check

```bash
ssh dev-sg 'systemctl --user status very-happy-daemon --no-pager | head -5; very-happy daemon status'
```

The unit's main PID is `very-happy daemon start-sync`; the daemon itself is its
child. `daemon status` must report the installed version as the running one.

## Upgrade

```bash
ssh dev-sg
sudo npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<version>
very-happy daemon stop                         # stop the old daemon (systemd sees a clean exit)
systemctl --user start very-happy-daemon       # new daemon under systemd again
systemctl --user status very-happy-daemon --no-pager | head -5
very-happy daemon status                       # running daemon = installed CLI
```

- Like mac-office's launchd, a `very-happy daemon start` from a shell hands over
  to a daemon **outside** systemd (nobody restarts it if it dies). Always end
  with `daemon stop` + `systemctl --user start`, and check the unit is `active`.
- Stopping the daemon stops sessions it is running (2026-09-12: `sudo npm i -g`
  + `daemon start` on dev-sg ended the running sessions; they are resumable from
  the Web). Upgrade when nothing important is mid-turn.
- ⚠️ Daemons ≤ 0.2.142 exit **0** on a fatal socket error (B-477), and the unit
  is `Restart=on-failure`, so such a crash is not restarted. 0.2.143+ exit 1 on
  fatal errors. Keep dev-sg at ≥ 0.2.143.
