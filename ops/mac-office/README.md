# mac-office daemon LaunchAgent

This directory makes the repository, rather than the external Owner skills repo,
the source of truth for mac-office daemon startup.

Install or update:

```bash
bash ops/mac-office/install-launch-agent.sh
```

The installer renders `~/Library/LaunchAgents/com.mereith.happy-daemon.plist`
with the current checkout and home paths, bootstraps it into the current user's
GUI domain, and starts it.

Verify:

```bash
launchctl print gui/$(id -u)/com.mereith.happy-daemon | grep -E 'state = |last exit'
pgrep -fl 'very-happy-cli/dist/index.mjs'
tail -20 ~/.local/state/happy/daemon-launchd.log
```

Optional daemon environment (`~/.config/very-happy/daemon.env`):

The launch wrapper sources this file, if present, before `very-happy daemon
start-sync`. Put non-secret variables there that every session the daemon spawns
should inherit — for example `PI_ACP_PI_COMMAND` to run pi sessions through the
vh-supervisor wrapper (permission gate + very-happy bridge). Never put secrets
in it: the daemon's environment is inherited by every session. A reinstall of
the LaunchAgent does not touch the file.

Temporary stop:

```bash
very-happy daemon stop
```

Because the plist restarts only abnormal exits, an intentional successful stop
stays stopped. Resume with:

```bash
launchctl kickstart -k gui/$(id -u)/com.mereith.happy-daemon
```

Uninstall:

```bash
launchctl bootout gui/$(id -u)/com.mereith.happy-daemon
rm ~/Library/LaunchAgents/com.mereith.happy-daemon.plist
```

The LaunchAgent runs only after a user logs into the macOS GUI session. FileVault
or a machine waiting at the login window prevents fully unattended recovery.

Do not replace this with `sudo very-happy daemon install`; that path creates an
invalid root LaunchDaemon for this fork.
