# Web plugins

> Status: v1, rolling out. The server advertises `plugins-v1` in `/v1/features`;
> the daemon advertises `pluginApi: 1`. Field-level contract:
> [plugin-api-v1.md](plugin-api-v1.md). Worked example:
> [`examples/plugins/hello-board`](../examples/plugins/hello-board/).

A **plugin** is a program running on one of your computers plus a
`vh-plugin/v1` manifest. Once you approve it in the web app, it can add four
things to Very Happy:

| Extension point | What you see | Permission |
|---|---|---|
| Sidebar entry + badge | A row in the sidebar's **Plugins** group: icon, name, count. Greyed out with "machine offline" while the computer is offline. | `sidebar` |
| Full-page panel | `/plugins/:installId/:panelId`: the plugin's own web page, with a host bar ("Plugin · name · machine", Disable, Open in new window). Full screen on phones. | `panel` |
| Decision cards | Cards in **Needs you**, styled like the others, with an unforgeable "Plugin · name" tag: 2–4 buttons, a text box, or just "Got it". | `decisions` |
| Session widget | A chip in the session header (icon, status, colour). Tap it for a short text, up to 2 actions and "Open in panel". | `session.widget` |

Two sensitive permissions let a plugin read sessions on its own computer; they
are never pre-checked: `sessions.list` (titles, folders, agent, status) and
`sessions.read` (message text, one session at a time).

Anyone can write a plugin. Very Happy treats every plugin as possibly
untrusted: it never gets your account token, your machine key, the daemon's
control token or another plugin's data, and it cannot inject scripts, styles
or HTML into Very Happy pages.

## How it fits together

```
plugin process ──Bearer plugin token──▶ daemon /plugin/v1 ──machine socket──▶ server ──▶ web app
      ▲                                    │
      └──── signed callbacks / proxied panel requests (loopback only) ◀───┘
```

- **Reports go through the local daemon only.** A plugin calls
  `http://127.0.0.1:<daemon port>/plugin/v1/*` with its plugin token. The
  daemon forwards over its already-authenticated machine connection; the server
  accepts it only if the install belongs to that machine, is enabled, and holds
  the permission. A token works on that one daemon and nowhere else.
- **Only the panel is an iframe.** Badge, cards and widgets are drawn by Very
  Happy from limited structured data (plain text or restricted Markdown without
  images or HTML).
- **Panels get their own origin.** Each install is served from
  `https://<pluginId>-<hash>.<plugin host>`; requests go server → daemon →
  the `upstream` your manifest declares on `127.0.0.1` / `[::1]`. Your page
  runs at the root of its origin, so absolute paths (`fetch('/api/x')`),
  cookies and `localStorage` work unchanged, and it cannot touch Very Happy's
  storage. It works from a phone outside your network, and your plugin does
  not need HTTPS.
- **Callbacks.** When you press a card button or a widget action, the server
  records an event and the daemon POSTs it, HMAC-signed, to your
  `callback.url`. If the computer is offline the event waits and is delivered
  when it reconnects; plugins without a callback can pull events instead.

## Security boundary (read this)

- **The server sees panel content.** Very Happy is server-trusted, not
  end-to-end encrypted. Your browser talks HTTP to the plugin origin on the
  server, so whoever runs the server can see panel pages and requests in
  plaintext. If that matters, self-host the server.
- **Same OS user = same trust.** A plugin process running as your OS user can
  already read your files, including Very Happy's own credentials. The
  permission model limits what a plugin can do *through Very Happy* (the web
  UI, your account data, other computers); it is not an OS sandbox. Run
  plugins you do not trust as a separate OS user or in a container.
- **Do not trust "it came from loopback".** Proxied requests and callbacks
  arrive from `127.0.0.1`, and so can requests from any other local program.
  Check `X-VH-Signature` (see the [reference verifier](../examples/plugins/hello-board/verify.mjs)).
- Card buttons only call back into the plugin; they can never trigger a Very
  Happy action. Links in cards show their full domain and ask before opening.

## Install and approve

Everything starts from the CLI on the computer that runs the plugin. There is
no "drop a file in a folder" install, so other local programs cannot add
plugins silently.

1. Start your plugin, then register it:
   ```bash
   very-happy plugin add ./vh-plugin.json        # or http://127.0.0.1:PORT/.well-known/vh-plugin.json
   ```
   `add` accepts a local file or a loopback URL only. It validates the
   manifest and creates a **pending** install, and prints the review link on
   the web app (`HAPPY_WEBAPP_URL`, or the default web app); you get a notification and a
   "Plugin install waiting for approval" card.
2. Open the card (or **Settings → Plugins**). The review page shows the name,
   icon, version, publisher (marked *unverified*), the computer, the first 8
   characters of the manifest hash, the proxy and callback addresses, and one
   row per permission with its risk. Sensitive permissions are unchecked and
   need a second confirmation.
3. **Approve** (all or some permissions) or **Reject**. Approval is bound to
   the manifest hash you were shown: if the manifest changed in between, it is
   refused with `manifest_changed`.
4. After approval the daemon writes the plugin's credentials to
   `~/.happy/plugins/<id>/` (directory 0700, every file 0600; `HAPPY_HOME_DIR`
   moves `~/.happy`): `token`, `secret`, `manifest.json` and `runtime.json`.
   Point your plugin at them:
   ```bash
   eval "$(very-happy plugin env <id> --shell)"   # VH_PLUGIN_API, VH_PLUGIN_TOKEN_FILE, VH_PLUGIN_SECRET_FILE
   ```

### Updating a plugin

`very-happy plugin update <id> [--manifest <file|loopback URL>]` re-reads the
manifest (from where `add` read it, unless you pass `--manifest`).

| Change | Needs approval again? |
|---|---|
| New permission, panel, callback or session widget | Yes |
| `upstream` or `callback.url` changed (even just the port) | Yes |
| `name`, `icon` or `id` changed (identity; stops impersonation) | Yes |
| Permission or panel removed | No, applies immediately |
| `version`, `description`, `publisher`, panel `title` / `entry`, `sidebar.title` | No |

While a change waits for approval (`update_pending`), the previously approved
manifest and grants stay in force, so the plugin keeps working.

### Other commands

```bash
very-happy plugin list [--json]         # id, installId, state, grants, pending changes
very-happy plugin show <id> [--json]    # includes the review link
very-happy plugin doctor <id>           # upstream/callback reachable, HMAC self-test, permission state
very-happy plugin rotate <id>           # new token and secret; the old ones stop working once the daemon reloads (it does so right away)
very-happy plugin env <id> [--shell]    # VH_PLUGIN_API, VH_PLUGIN_TOKEN_FILE, VH_PLUGIN_SECRET_FILE (--shell: as export lines)
very-happy plugin badge <id> <count|clear> [--tone attention] [--label L]
very-happy plugin decision <id> post --key K --title T [--option id=label]... [--input [--multiline] | --notice] [--body-file F]
very-happy plugin decision <id> close --key K [--outcome done|dropped|superseded]
```

`badge` and `decision` are thin wrappers for script-style plugins. `post` makes
an `input` card with `--input` (`--multiline` gives it a multi-line text
box, `input.multiline: true`, and implies `--input`), a `notice` with `--notice` or without any
`--option`, and a `choice` card otherwise. Commands that print data accept
`--json`; `plugins` works as an alias of `plugin`.

## Turning a plugin off

| Where | How | Effect |
|---|---|---|
| The computer | `very-happy plugin disable <id> [--reason …]` / `plugin remove <id> [--keep-items]` | The daemon refuses the plugin's API calls (`plugin_disabled`) and stops proxying at once; the server is told. `remove` also deletes the credentials and the install (`--keep-items` keeps its cards). Works while the daemon is stopped (applied on next start). `plugin enable <id>` undoes it: it clears the local disable, then asks the server (with this computer's token) to lift the disable this computer set. A disable set in your account cannot be lifted from the CLI (`enable` links to **Settings → Plugins**), and neither can an operator block (`enable` says so). |
| Your account | **Settings → Plugins**: Disable, Remove, or revoke one permission | Immediate on the server: open panels are signed out, machine calls are refused, cards and widgets are hidden (kept, and restored if you re-enable). Revoking a permission needs nothing from the plugin. |
| The server operator | `VH_PLUGINS_DISABLED=1` (everything) or `VH_PLUGIN_DENYLIST=<plugin id or manifest sha256, …>` | Matching installs show as `disabled_by_operator`; only the operator can lift it. |

How `disable` and `enable` on the computer work:

- `plugin disable <id>` turns the plugin off on this computer at once (works
  offline), then calls `POST /v1/plugins/installs/<installId>/disable` with
  the computer's token. The server records it as disabled **by this
  machine**.
- `plugin enable <id>` clears the local disable, then calls
  `POST /v1/plugins/installs/<installId>/enable` with the computer's token
  (body `{ "machineId": … }`, header `X-VH-Machine-Id`). The server lifts only
  a disable set by this same machine on its own install. A disable
  set in your account, or an install on another computer, answers
  `403 enable_requires_owner`, and the CLI points you to **Settings →
  Plugins**. An operator block answers `409 disabled_by_operator`; only the
  operator can lift it. `409 not_disabled` means there was nothing left to
  lift and counts as success. If the server cannot be reached, only the local disable is
  cleared and the CLI says so.

If a plugin token leaks, `rotate` it or disable the plugin in your account.

You can also **mute** a plugin: its cards stop pushing notifications and its
badge stops counting toward the app badge. Only badges with
`tone: "attention"` count toward the app badge in the first place.

## Self-hosting

| | Official service | Self-hosted |
|---|---|---|
| Plugin host | Configured by the operator | Set `VH_PLUGIN_HOST` (e.g. `p.example.com`, a port is allowed) with wildcard DNS and TLS for `*.p.example.com`. Put it under the same registrable domain as the web app so panel cookies stay same-site. Without it, panels are unavailable; badge, cards and widgets still work. `VH_PLUGIN_WEB_ORIGINS` (comma-separated) sets which web app origins may frame panels; it defaults to the origin of `PUBLIC_URL`. For local development only, `VH_PLUGIN_HOST_SCHEME=http` serves panels without TLS (e.g. `VH_PLUGIN_HOST=lvh.me:3005`). |
| Feature switch | On, may be rolled out per account (`VH_PLUGINS_ENABLED_ACCOUNTS`, comma-separated account ids) | `VH_PLUGINS_ENABLED=1`. While off, `/v1/features` does not list `plugins-v1` and every `/v1/plugins/*` request (any path, any body) answers `404 plugins_disabled` before validation. |
| Decision cards | Shown in **Needs you** | Also need the owner board: `VH_OWNER_BOARD_ENABLED=true`. Without it, cards are stored but nowhere to answer them. |
| Kill switch | `VH_PLUGINS_DISABLED`, `VH_PLUGIN_DENYLIST` | Yours |
| Who can see panel content | The operator | Only you |

Two things self-hosters most often miss:

- **Decision cards need the owner board.** Set `VH_OWNER_BOARD_ENABLED=true`
  as well as `VH_PLUGINS_ENABLED=1`, or plugin cards are stored but never
  shown in **Needs you**. Badges, panels and widgets do not depend on it.
- **Machines signed in with old credentials cannot run plugins** (next
  section).

## Machines signed in with old credentials

**What you see.** The plugin panel shows "*machine* is signed in the old way,
so this plugin cannot open here" with a list of commands, instead of the
panel. Sessions on that machine show a **Plugin unavailable** chip in their
header instead of the plugin's widget. Through the API, the panel answers
`502 machine_unsupported` and widget writes for its sessions answer
`403 session_not_on_machine`. Badges and decision cards still work.

**Why.** Older CLI logins stored only the account secret in
`~/.happy/access.key`, so the machine and its sessions were registered
without a data encryption key. Panels and widgets need that key: the server
uses it to relay panel traffic through the machine and to check which machine
a session runs on. A machine keeps the key it was first registered with, so
upgrading the CLI alone does not add one; a new sign-in does.

**Fix.** On that computer, in this order:

```bash
very-happy plugin remove <id>         # while still signed in as the old machine: drops the old install on the server too
very-happy auth login --force         # new sign-in; the computer is added as a new machine
very-happy daemon start
very-happy plugin add <manifest>      # the same file or loopback URL as before
```

Then approve the plugin again in **Settings → Plugins**. An install belongs
to one machine, so after the new sign-in it has to be added again; its old
credentials stop working. If the old install is still listed (for example
because `plugin remove` ran after the new sign-in and could not reach it),
remove it from **Settings → Plugins**. The old machine entry stays in the
machine list as offline; its sessions and history are kept.

## Compatibility

| Combination | Behaviour |
|---|---|
| New server, old CLI | No `plugin` command: `very-happy plugin …` is not recognised and, like any unknown word, is passed to Claude as a prompt (it starts a Claude session). The machine's plugin area says "CLI too old". |
| New CLI, old server (or plugins switched off for the account) | `plugin add` / `update` report `server_too_old` (any 404 without a plugin error code counts) and write nothing locally; `plugin list` says the server does not support plugins; `/plugin/v1` calls get `503 server_too_old`. |
| New server, old web app | No plugin UI. Plugin cards without a session are only sent to clients that ask for them (`?include=plugin`). |
| New web app, old server | `/v1/plugins/*` returns 404; the plugin UI is hidden. |
| Manifest `minApi` above the daemon's `pluginApi` | `plugin add` reports `api_too_old`. |
| Unknown manifest major (`vh-plugin/v2`) | Refused with `unsupported_schema`. |

Within v1, things are only added and announced in `features[]` of
`GET /plugin/v1/info`; unknown manifest fields are ignored with a warning.
Breaking changes will come as `vh-plugin/v2` and `/plugin/v2`, with both
versions supported side by side for at least two major releases.

**Machine web panels** (`webPanels` in `~/.happy/settings.json`) stay as they
are: they are direct links the browser opens itself. Plugins are proxied
through the daemon and approved per permission.

## FAQ

**Can a plugin send messages to a session or start sessions?** No, v1 has no
`send`, `spawn` or plain-notification permission. To start sessions, use the
public CLI (`very-happy spawn`) directly; that path does not go through the
plugin API.

**Can a widget go on any session?** Only on sessions running on the plugin's
own computer, one widget per plugin per session, and at most three plugin
widgets shown per session. Archived sessions hide their widgets.

**Can panels use WebSockets or Server-Sent Events?** Not in v1 (`501
unsupported_upgrade`); poll instead.

**Does my plugin need HTTPS?** No. The browser talks HTTPS to the plugin
origin on the server; the last hop is the daemon talking HTTP to `127.0.0.1`.

**Are there typed schemas?** In this repository, `packages/happy-wire`
(`src/plugins.ts`, `src/pluginCrypto.ts`) holds the zod schemas, TypeScript
types, hash functions and signature helpers the host itself uses
(`parsePluginManifest`, `pluginManifestHash`, `signPluginEvent`,
`verifyPluginEvent`, …). The package is not published to npm; plain JSON over
HTTP is the contract, so copy what you need or use the zero-dependency
[reference verifier](../examples/plugins/hello-board/verify.mjs).
