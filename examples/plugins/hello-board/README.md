# Hello Board: example Very Happy plugin

A zero-dependency Node program (`node:http` only) that uses all four plugin
extension points:

| Extension point | What Hello Board does |
|---|---|
| Panel | A counter page served at the root of its own origin. It calls `fetch('/api/count')` with an absolute path and keeps a "last visit" time in `localStorage`, both of which work unchanged inside Very Happy. |
| Sidebar badge | The counter value, `PUT /badge` on every change. At multiples of 5 the tone is `attention`. |
| Decision cards | At every multiple of 5, a `choice` card "Continue / Reset"; the callback resets on "Reset" and closes the card with `DELETE`. The panel's **Ask me for a label** button posts an `input` card; the text you submit becomes the counter's label. |
| Session widget | With `HELLO_SESSION_ID` set, a "count: N" chip on that session with **+1** and **Reset** (confirmed) actions and an "Open in panel" link. |

It also shows the safe defaults every plugin should copy from
[`verify.mjs`](verify.mjs):

- callbacks are accepted only with a valid `X-VH-Signature`, a fresh timestamp
  and an unseen event id;
- writes to the panel API (`POST /api/*`) are accepted only when they were
  forwarded and signed by Very Happy, because any local program can reach
  `127.0.0.1:4310`.

## Run it

Needs Node 20+ and a computer connected to Very Happy with a CLI that has the
`plugin` command.

1. Start the plugin:
   ```bash
   node server.mjs
   ```
2. Register it on the same computer:
   ```bash
   very-happy plugin add ./vh-plugin.json
   ```
3. Approve it in the web app (the **Needs you** card, or **Settings → Plugins**).
   Hello Board picks up its token and secret from `~/.happy/plugins/hello-board/`
   on the next call, so there is no restart. Open **Hello** in the sidebar.

To try the session widget, start it with a session id from this computer:

```bash
HELLO_SESSION_ID=<session id> node server.mjs
```

## Options

| Variable | Default | Meaning |
|---|---|---|
| `HELLO_PORT` | `4310` | Must match `upstream` and `callback.url` in `vh-plugin.json`. |
| `HELLO_SESSION_ID` | unset | Session to put the widget on (must run on this computer). |
| `HELLO_PULL` | unset | `1` = long-poll `GET /plugin/v1/events` instead of relying on the callback. |
| `HELLO_INSECURE_LOCAL` | unset | `1` = accept unsigned writes, for opening `http://127.0.0.1:4310` directly while developing. |
| `VH_PLUGIN_API`, `VH_PLUGIN_TOKEN_FILE`, `VH_PLUGIN_SECRET_FILE` | from `~/.happy/plugins/hello-board/` | What `very-happy plugin env hello-board --shell` prints. `HAPPY_HOME_DIR` moves the default directory. |

## Files

| File | |
|---|---|
| `vh-plugin.json` | The manifest (`vh-plugin/v1`). |
| `server.mjs` | Panel page, panel API, callback handler, calls to `/plugin/v1`. |
| `verify.mjs` | Reference signature verification and event dedupe; copy it into your plugin. |
| `verify.test.mjs` | Checks `verify.mjs` against the test vectors in [plugin-api-v1.md](../../../docs/plugin-api-v1.md#71-test-vectors): `node --test verify.test.mjs`. |

More: [plugins.md](../../../docs/plugins.md) (concepts, approval, security
boundary) and [plugin-api-v1.md](../../../docs/plugin-api-v1.md) (the contract).
