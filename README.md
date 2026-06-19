<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-light.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-dark.png">
    <img src="/.github/logotype-dark.png" width="360" alt="Very Happy">
  </picture>
</div>

<h1 align="center">
  Drive Claude Code from any browser
</h1>

<h4 align="center">
Sign in with a password, pick up your coding sessions on any device — no app store, no QR code.
</h4>

---

**Very Happy** is a friendly fork of [slopus/happy](https://github.com/slopus/happy) (MIT) — a web + mobile client and relay that lets you watch and steer [Claude Code](https://www.anthropic.com/claude-code) from your phone or any browser. The upstream project is excellent; Very Happy reworks it around a different trade-off — **convenience over end-to-end encryption** — and adds a heavily polished web UI.

## What's different from Happy

Upstream Happy is end-to-end encrypted and pairs devices by scanning a QR code. Very Happy deliberately takes the opposite stance to make self-hosting for a small, trusted group effortless:

- 🔑 **Password accounts, no pairing** — create an account with a username + password and sign in on any device. No QR code, no re-linking. Your sessions follow you everywhere.
- 🔁 **Multi-device sync** — start on your laptop, keep going on your phone, finish in a browser tab. Same session, instantly.
- 🌐 **Web-first** — runs entirely in the browser. Install it to your home screen as a PWA if you want; you never need an app store.
- 🔔 **Web push notifications** — get notified when your agent needs permission or finishes, even with the tab closed (iOS 16.4+ as an installed PWA).
- 🧠 **Reworked session UI** — inline thinking, per-turn model / token usage / cost / duration, tool calls that expand to the full command and output, automatic session titles (with manual rename), a file sidebar, live status bar, context-usage % with one-tap compact, and rich permission cards with command/diff context and batch approve.
- ⚡ **Latest models** — bumped to a current Claude Agent SDK so remote sessions run the newest models (e.g. Opus 4.8), not whatever an app-store build happened to ship.
- 🏠 **Self-hostable & invite-gated** — bring your own relay and gate signups with invite codes.

Everything else — the CLI wrapper, the agent runtime, the two execution paths (interactive vs. SDK) — comes from upstream Happy and keeps working.

> [!IMPORTANT]
> **Very Happy is server-trusted, not end-to-end encrypted.** Your sessions are relayed through the server, and its operator can decrypt and read their contents. This is an intentional trade-off for password-based multi-device sync. Only sign up on an instance run by someone you trust, and only host an instance for people who trust you. If you need true end-to-end encryption, use [upstream Happy](https://github.com/slopus/happy) instead.

## Getting started

**Step 1 — Install Claude Code** so the `claude` command is on your `PATH`.

**Step 2 — Install the Very Happy CLI** on the machine you want to control:

```bash
npm install -g very-happy-cli
```

**Step 3 — Run it** (it's pre-configured to connect to the default server):

```bash
very-happy
```

Then open the web app, create an account, and your machine shows up. To point the CLI at your own relay, set `HAPPY_SERVER_URL`.

## How it works

```
web client ──▶ relay server ──socket──▶ very-happy CLI daemon ──spawn──▶ claude (Claude Code)
```

On your computer you run `very-happy` instead of `claude`. When you take control from your phone or a browser, the daemon runs Claude Code via the Claude Agent SDK in remote mode and streams everything back to you. Same engine, tools, skills, subagents, hooks and MCP as the real CLI.

## Project components

- **happy-app** — web + mobile client (Expo)
- **happy-cli** — the `very-happy` command-line wrapper for Claude Code
- **happy-server** — relay + sync backend, and it also hosts the web app
- **happy-agent** / **happy-wire** — remote agent control + shared protocol

## Self-hosting & releases

See [`RELEASING.md`](RELEASING.md) for the npm + CI release runbook (tag-driven publish, manual server/web deploy).

## Credits & license

Very Happy is a fork of [**slopus/happy**](https://github.com/slopus/happy) — huge thanks to the Happy authors and contributors for the foundation. Licensed under the MIT License; see [LICENSE](LICENSE).
</content>
</invoke>
