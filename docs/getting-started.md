# Getting started

This path uses the maintainer-operated Cloud. For your own relay, first follow
[Self-hosting](deployment.md), then substitute your server URL below.

## 1. Prepare the machine

Install Node.js 20+ and Claude Code. Confirm `claude --version` works in the same
shell account that will run Very Happy.

```bash
npm install -g very-happy-cli
very-happy --version
```

## 2. Create or sign in to an account

Open [happy.mereith.com](https://happy.mereith.com). Choose Google or a username
and password. New registration can be open, invite-only, closed, or temporarily
full; an existing account can still sign in in every mode.

The hosted relay is [server-trusted](security.md). Do not continue with a machine
whose contents or remote-control capability you are unwilling to expose to the
server operator.

## 3. Connect the machine

```bash
very-happy auth login
```

Open the generated HTTPS link and approve only if you initiated it on the machine
in front of you. Pairing links expire; generate a new one instead of forwarding
or reusing an old link.

For a self-hosted relay:

```bash
HAPPY_SERVER_URL=https://happy.example.com \
HAPPY_WEBAPP_URL=https://happy.example.com \
very-happy auth login
```

## 4. Start the daemon and first session

```bash
very-happy
```

Return to the Web UI. When the machine is online, choose **New session**, select
the machine and project directory, and start. `very-happy daemon status` and
[Troubleshooting](troubleshooting.md) cover a machine that stays offline.

## Next

- [CLI and daemon](cli-architecture.md)
- [Public Cloud](public-server.md)
- [Configuration](configuration.md)
- [Security and privacy](security.md)
