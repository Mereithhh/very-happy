# Plugin API v1 (`vh-plugin/v1`, `/plugin/v1`)

Normative contract for Very Happy Web plugins. Concepts, install flow and the
security boundary: [plugins.md](plugins.md). Reference implementation of the
host side: `packages/happy-wire/src/plugins.ts` and `pluginCrypto.ts`; of the
plugin side: [`examples/plugins/hello-board`](../examples/plugins/hello-board/).

Lengths are in characters (UTF-16 code units) unless marked as bytes.

## 1. Manifest

A JSON file, UTF-8, at most 32 KB.

| Field | Type / constraint | Required | Notes |
|---|---|---|---|
| `schema` | `"vh-plugin/v1"` | yes | Any other value is refused with `unsupported_schema`. |
| `id` | `^[a-z0-9][a-z0-9-]{1,31}$` | yes | Unique per computer; the same plugin may be installed on several computers. |
| `name` | 1–40, no control or bidi-override characters | yes | Display name. |
| `version` | semver, ≤ 32 | yes | Display and audit only. |
| `description` | ≤ 280 | no | Shown on the review page. |
| `publisher` | `{ name: 1–60, url?: https URL ≤ 200 }` | no | Always marked *unverified*. |
| `icon` | built-in icon name, or one emoji | no | Default `puzzle`. SVG and image URLs are not accepted. Names: `puzzle kanban bot inbox bell chart list terminal calendar check clock code database file flag folder globe heart home layers mail map package rocket search server settings shield star tag user zap`. |
| `minApi` | integer ≥ 1, default 1 | no | Lowest `/plugin/v1` feature level the plugin needs. |
| `permissions` | unique values from §3 | yes | Calls outside the granted set fail with 403. |
| `sidebar` | `{ title: 1–24, panel: <panel id> }` | with `sidebar` | `panel` must name one of `panels`. |
| `panels` | 1–4 × `{ id: ^[a-z0-9-]{1,32}$, title: 1–40, upstream, entry?: path = "/" }` | with `panel` | Panel ids unique. |
| `callback` | `{ url }` | no | Push events here; without it, pull them (§6.4). |
| `sessionWidget` | boolean | `true` with `session.widget` | |

Feature fields and permissions must match both ways: `sidebar` ⇔ `sidebar`
permission, `panels` ⇔ `panel`, `sessionWidget: true` ⇔ `session.widget`.

**Addresses.** `upstream` is exactly `http://127.0.0.1:<port>` or
`http://[::1]:<port>`, port 1024–65535 without leading zeros, nothing else (no
hostname, not even `localhost`; no path, userinfo, query or fragment).
`callback.url` follows the same rules but may add a path (no `.` / `..`
segments, no `//`, no encoded `/`, `\` or NUL).

**Paths** (`entry`, `panelPath`): start with `/`, at most 512, no `//` prefix,
no `.` / `..` segments after percent-decoding, no backslash or control
characters, valid percent-encoding. A `?query` and a `#fragment` are allowed;
the fragment is passed to the panel's URL as is.

Unknown top-level fields are ignored (`plugin add` prints a warning).

### 1.1 Hashes

- **Canonical JSON**: object keys sorted by UTF-16 code unit, no whitespace,
  array order kept, `undefined` members dropped, strings and numbers as
  `JSON.stringify` writes them.
- **`manifestHash`** = lowercase hex sha256 of the canonical JSON of the
  **parsed** manifest: unknown fields removed and defaults filled in (`icon`,
  `minApi`, `panels[].entry`), so an omitted default and the explicit default
  hash the same. Approval is bound to it (`409 manifest_changed`).
- **`privilegedHash`** = sha256 of the canonical JSON of
  ```json
  { "id", "name", "icon", "permissions": [sorted], "panels": [{ "id", "upstream" }] sorted by id,
    "callbackUrl": string | null, "sidebarPanel": string | null, "sessionWidget": boolean }
  ```
  A different `privilegedHash` after `plugin update` puts the install in
  `update_pending`, unless every difference is a removal (a permission, panel,
  callback or the session widget), which applies at once.

Vectors for the manifest in `examples/plugins/hello-board/vh-plugin.json`:

| Value | sha256 |
|---|---|
| `manifestHash` | `defa292ed6959042026f18e386382fc7ef5d1a17e308d7337b715685c310be59` |
| `privilegedHash` | `0e687a30ca8475d4cfedb665d8ef2ece98d554acc6ea2c4e3c725804980fe4d5` |

Canonical privileged view behind that hash:

```
{"callbackUrl":"http://127.0.0.1:4310/vh/callback","icon":"kanban","id":"hello-board","name":"Hello Board","panels":[{"id":"main","upstream":"http://127.0.0.1:4310"}],"permissions":["decisions","panel","session.widget","sidebar"],"sessionWidget":true,"sidebarPanel":"main"}
```

## 2. Credentials and discovery

After approval the daemon writes `~/.happy/plugins/<id>/` (directory 0700):

| File | Content |
|---|---|
| `token` (0600) | Plugin token, `vhp_` + 32 random bytes base64url. Trim whitespace and send it as is in `Bearer`. |
| `secret` (0600) | 32 random bytes as unpadded base64url: exactly 43 characters, maybe followed by a newline, no prefix. Trim surrounding whitespace and base64url-decode it; **the 32 decoded bytes are the HMAC key**. Never use the text itself as the key. |
| `manifest.json` | The approved manifest. |
| `runtime.json` | `{ "api": "http://127.0.0.1:<daemonPort>/plugin/v1", "installId", "state" }`, refreshed on every daemon start. |

`very-happy plugin env <id> --shell` prints `VH_PLUGIN_API`,
`VH_PLUGIN_TOKEN_FILE` and `VH_PLUGIN_SECRET_FILE`. Re-read the files rather
than caching them: `plugin rotate` replaces both at once.

## 3. Permissions

| Permission | Risk | Allows | Pre-checked |
|---|---|---|---|
| `sidebar` | low | One sidebar entry and badge | yes |
| `panel` | medium | Panels, proxied to the declared loopback upstreams | yes |
| `decisions` | medium | Cards in **Needs you**, response callbacks | yes |
| `session.widget` | medium | A chip on sessions on this computer, action callbacks | yes |
| `sessions.list` | **sensitive** | Metadata of this computer's sessions | **no** |
| `sessions.read` | **sensitive** | Message text of this computer's sessions | **no** |

Permissions are checked against the **current** grants on every call. A
decision with `sessionId` also needs `session.widget` or `sessions.list`; a
`panelPath` (card or widget) also needs `panel`.

## 4. Conventions

- **Base URL**: `runtime.json.api`. Same port as the daemon's control API,
  separate prefix and authentication.
- **Auth**: `Authorization: Bearer <plugin token>`. The daemon identifies the
  install from the token only; identity claims in bodies are ignored.
- **Bodies**: `application/json`, at most 64 KB (`413` above).
- **Idempotency**: writes accept `Idempotency-Key` (≤ 128); the same key and
  body within 10 minutes return the same result.
- **Errors**: `{ "error": "<code>", "message": "...", ...details }`.

| HTTP | `error` | Details / meaning |
|---|---|---|
| 400 | `invalid_request` | `issues[]` |
| 400 | `invalid_path` | Panel proxy: rejected request path |
| 401 | `unauthorized` | Missing or invalid token |
| 403 | `permission_denied` | `permission` |
| 403 | `plugin_pending` / `plugin_rejected` / `plugin_disabled` / `disabled_by_operator` | Install state does not allow calls |
| 403 | `session_not_on_machine` | Session is not on this computer |
| 404 | `not_found` | Card, session or widget |
| 409 | `version_conflict` | `currentVersion` |
| 409 | `manifest_changed` | Approval hash mismatch |
| 413 | `payload_too_large` | |
| 422 | `limit_exceeded` | `limit` |
| 429 | `rate_limited` | `retryAfterMs` |
| 501 | `unsupported_upgrade` | Panel proxy: WebSocket / SSE not supported in v1 |
| 502 | `upstream_unreachable` | Panel proxy |
| 503 | `server_unreachable` | Daemon is offline from the server; writes were queued (`queued: true`) |
| 504 | `upstream_timeout` | Panel proxy |

- **Offline**: while the daemon cannot reach the server, badge, widget and
  card writes are queued locally (200 per install, latest value per key) and
  replayed in order on reconnect; the call returns `503 server_unreachable`
  with `queued: true`. Reads return 503.
- **CLI-only codes**: `server_too_old`, `api_too_old`, `unsupported_schema`,
  `invalid_manifest`.

## 5. Endpoints

### 5.1 Info

```
GET /plugin/v1/info
→ 200 { apiVersion: 1, features: ["badge","panel","decisions","decisions.input","widget","events.pull"],
        installId, pluginId, state, grants: [...], machineId }
```

Check `features` before using something newer than v1.0.

### 5.2 Badge (`sidebar`)

```
PUT /plugin/v1/badge   { count: 0..9999 | null, tone?: "default" | "attention", label?: 1..16 }
→ 200 { badge: { count, tone, label, updatedAt } }
```

`null` clears it; more than 99 shows as `99+`; `label` is the screen-reader and
hover text. 60 writes per minute; repeating the same value is dropped. Only
`tone: "attention"` counts toward the app badge (unless the owner muted the
plugin).

### 5.3 Decision cards (`decisions`)

```
POST /plugin/v1/decisions
{
  key: 1..256,                       // your dedupe key; same key = update, a closed card reopens
  kind: "choice" | "input" | "notice",
  title: 1..120,
  bodyMd?: ≤ 8 KB (bytes),           // restricted Markdown: no images or HTML; links show the full domain
  options?: 2..4 × { id: ^[a-z0-9_-]{1,16}$, label: 1..40, style?: "default"|"primary"|"danger", detail?: ≤ 200 },  // choice only, required
  input?: { placeholder?: ≤ 80, maxLength?: 1..2000 (default 500), multiline?: boolean },                       // input only, required
  sessionId?: string,                // a session on this computer (needs session.widget or sessions.list)
  panelPath?: path,                  // "Open in plugin" target (needs panel)
  push?: boolean = true              // at most one push per key
}
→ 201 { item, created: true } | 200 { item, created: false }

PATCH  /plugin/v1/decisions/:key  { title?, bodyMd?, options?, input?, panelPath?, reopen?: true, expectedVersion? } → 200 { item }
DELETE /plugin/v1/decisions/:key  { outcome?: "done"|"dropped"|"superseded", note?: ≤ 500 }                         → 200 { item }
GET    /plugin/v1/decisions?state=open|all&limit=1..200                                                             → 200 { items }
```

`item` (`PluginDecision`):
`{ itemId, key, kind, title, bodyMd, options, input, sessionId, panelPath, state: "open"|"responded"|"closed", response?: { action, choice?, text?, note?, at }, delivery: "pending"|"delivered"|"failed", version, createdAt, updatedAt }`.

- `notice` takes neither `options` nor `input`; the owner can only dismiss it.
- When the owner answers, the card becomes `responded` (no second answer) and
  an event is queued. Close it with `DELETE`, or `PATCH { reopen: true }` to
  ask again. Not acknowledged within 24 hours, the card shows "Plugin has not
  confirmed".
- Limits: 50 open cards per install (`422 limit_exceeded`), 30 new cards per
  minute.

### 5.4 Session widget (`session.widget`)

```
PUT /plugin/v1/sessions/:sessionId/widget
{
  status: { label: 1..24, tone: "neutral"|"info"|"success"|"warning"|"danger" },
  text?: ≤ 280,                                  // plain text
  actions?: ≤ 2 × { id: ^[a-z0-9_-]{1,16}$, label: 1..20, style?: "default"|"primary"|"danger", confirm?: ≤ 120 },
  panelPath?: path,                              // needs panel
  expectedVersion?: integer
}
→ 200 { widget: { sessionId, status, text, actions, panelPath, version, updatedAt } }

DELETE /plugin/v1/sessions/:sessionId/widget → 200 { removed: true }
GET    /plugin/v1/sessions/:sessionId/widget → 200 { widget } | 404
```

The session must run on this computer (`403 session_not_on_machine`). One
widget per plugin per session; at most three plugin widgets are shown per
session; archived sessions hide them. With `confirm`, the owner confirms before
the callback fires. 30 writes per session per minute.

### 5.5 Sensitive reads

```
GET /plugin/v1/sessions?limit=1..100&cursor=…                       [sessions.list]
→ { sessions: [{ id, title, cwd, agent, status: "running"|"idle"|"archived", updatedAt }], cursor }

GET /plugin/v1/sessions/:id/messages?limit=1..50&before=…           [sessions.read]
→ { messages: [{ id, role: "user"|"agent", text, createdAt }], cursor }
```

This computer's sessions only; text only (no tool input/output, no
attachments). Every call is audited and the owner sees "read N sessions in the
last 24 hours".

## 6. Events

### 6.1 Envelope

```json
{ "id": "evt_…", "type": "decision.responded", "installId": "pi_…", "pluginId": "hello-board",
  "createdAt": 1795577286598, "attempt": 1, "data": { } }
```

| `type` | `data` |
|---|---|
| `decision.responded` | `{ itemId, key, action: "choose"\|"submit"\|"dismiss", choice?, text?, note?, respondedAt, actor: "owner" }` |
| `widget.action` | `{ sessionId, actionId, at, actor: "owner" }` |
| `install.changed` | `{ state, grants, manifestHash }`: approval, disable, permission revoked |
| `ping` | `{}`: on enable and from `plugin doctor` |

Ignore types you do not know.

### 6.2 Push

With `callback.url`, the daemon sends `POST <callback.url>`:

```
Content-Type: application/json
X-VH-Event-Id: evt_…
X-VH-Timestamp: <unix seconds>
X-VH-Signature: v1=<hex HMAC-SHA256>
```

Any 2xx within 10 seconds is a delivery. Otherwise it retries after 10 s,
1 min, 5 min, 30 min, 2 h, then every 6 h, and gives up 24 h after the first
attempt (`delivery: "failed"`, visible on the card and in settings). Delivery
is **at least once**: dedupe on `X-VH-Event-Id`.

### 6.3 Verifying (do all three)

1. Recompute the signature over the **raw body bytes** and compare in constant
   time.
2. Reject timestamps more than 300 seconds from your clock.
3. Remember event ids for at least 10 minutes; answer a repeat with 200 and do
   nothing.

### 6.4 Pull

```
GET  /plugin/v1/events?after=<cursor>&wait=0..25   → 200 { events: [{ event, rawBody, timestamp, signature }], cursor }
POST /plugin/v1/events/ack { upTo: <cursor> }       → 200 { acked }
```

`rawBody` is the exact JSON text of `event`; `signature` and `timestamp` are
what a push would have sent, so the same verifier works.

## 7. Signatures

`key` is the 32 bytes decoded from the `secret` file (§2): trim, base64url-decode,
check the length is 32.

**Event** (push and pull):

```
X-VH-Signature = "v1=" + hex(HMAC-SHA256(key, "v1:" + timestamp + ":" + eventId + ":" + rawBody))
```

**Proxied panel request.** The daemon adds `X-VH-Install`, `X-VH-Request-Id`,
`X-VH-Timestamp`, `X-VH-Viewer: owner` and

```
X-VH-Signature = "v1=" + hex(HMAC-SHA256(key,
    "v1:" + timestamp + ":" + requestId + ":" + METHOD + ":" + pathWithQuery + ":" + hex(sha256(body))))
```

`METHOD` is upper case; `pathWithQuery` is the request target as your server
receives it (e.g. `/api/count?x=1`); an empty body hashes as zero bytes
(`e3b0c442…b855`). Incoming `X-VH-*` headers from the browser are stripped, so
these cannot be forged by a page.

### 7.1 Test vectors

```
secret file = AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE        (43 characters, then a newline)
key (hex)   = 0101010101010101010101010101010101010101010101010101010101010101
timestamp  = 1795577286
```

Event:

```
eventId    = evt_01JTESTVECTOR0000000000000
rawBody    = {"id":"evt_01JTESTVECTOR0000000000000","type":"decision.responded","installId":"pi_test","pluginId":"hello-board","createdAt":1795577286598,"attempt":1,"data":{"itemId":"it_1","key":"count:5","action":"choose","choice":"continue","respondedAt":1795577286000,"actor":"owner"}}
signature  = v1=020f2dc559ea6540094c4ad2adfc0cc55408f104ca8b96166a1738525874c737
```

Panel request with a body:

```
requestId  = req_01JTEST
method     = POST
path       = /api/count?x=1
body       = {"delta":1}
sha256     = 2c5f28bf1e8d3e071e067f175a8b6f728081245b9b8313a9cce44a5aeff3f246
signature  = v1=60cf37275780ee4c721da0b4724d2fb8f872b474066d1b20bad20cb325708362
```

Panel request without a body:

```
requestId  = req_01JTEST
method     = GET
path       = /
signature  = v1=44002e33ed4e7748d5813ea71d5e87e0bc28a38d6ea67022b3ae179d89891433
```

These values are locked by the wire tests (`pluginCrypto.test.ts`) and the
example's `verify.test.mjs`.

### 7.2 Reference verifier (Node)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const t = readFileSync(process.env.VH_PLUGIN_SECRET_FILE, 'utf8').trim();
const key = Buffer.from(t, 'base64url');            // the HMAC key is these 32 bytes, not the text
if (!/^[A-Za-z0-9_-]{43}$/.test(t) || key.length !== 32) throw new Error('bad secret file');

export function verifyEvent(key, headers, rawBody, nowSec = Math.floor(Date.now() / 1000)) {
  const ts = headers['x-vh-timestamp'], id = headers['x-vh-event-id'], sig = headers['x-vh-signature'] ?? '';
  if (!/^\d{1,12}$/.test(ts ?? '') || !id || Math.abs(nowSec - Number(ts)) > 300) return false;
  const want = 'v1=' + createHmac('sha256', key).update(`v1:${ts}:${id}:`).update(rawBody).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Then dedupe on `id`. The full version, including panel requests, is
[`verify.mjs`](../examples/plugins/hello-board/verify.mjs).

## 8. Panels

- The panel lives at `https://<pluginId>-<h8>.<plugin host>/`, where `<h8>` is
  the first 8 characters of the lowercase, unpadded RFC 4648 base32 of
  `sha256(installId)`. It is embedded with
  `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"`,
  `referrerpolicy="no-referrer"` and `allow=""`.
- Reserved paths, never forwarded: `/__vh/enter`, `/__vh/health`. The host's
  `__Host-vhp` cookie is stripped before forwarding.
- Requests are forwarded only to the approved `upstream`, connecting to the IP
  literal (no DNS, no proxy variables). `Host` becomes the upstream authority;
  a same-origin `Origin` becomes `http://127.0.0.1:<port>` (others are removed);
  `X-Forwarded-Proto: https` and `X-Forwarded-Host: <plugin origin host>` are
  added. Non-GET requests must be same-origin.
- Redirects are not followed; a `Location` pointing at the upstream itself is
  rewritten to a relative path.
- Response headers added by the host (not removable): `Content-Security-Policy:
  frame-ancestors <web app origin>` (your own CSP is kept, only
  `frame-ancestors` is replaced), `Cross-Origin-Resource-Policy: same-origin`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), usb=(), payment=()`.
  `X-Frame-Options` is removed. `Set-Cookie` is made host-only (no `Domain`).
- Service workers cannot be registered on plugin origins.
- Limits: request body 8 MB, response 32 MB, 30 s per request, 16 concurrent
  requests per install (429 beyond). No WebSocket / SSE in v1.

### 8.1 Bridge (`postMessage`)

Messages `{ vh: 1, id, method, params }`, replies
`{ vh: 1, id, ok, result | error }`. The host accepts messages only from the
panel's own window and origin and replies to that origin only. 20 calls per
second.

| Method | Effect | Permission |
|---|---|---|
| `host.hello` → `{ apiVersion, theme, locale, installId, panelId, mobile }` | Handshake; never returns tokens, account or session data | `panel` |
| `host.theme.subscribe` | The host then sends `{ vh: 1, event: "host.themeChanged", params: { theme } }` | `panel` |
| `host.setTitle { title: 1..40 }` | Host bar title | `panel` |
| `host.navigate { to: "panel", panelId, path? }` | Another panel of the same plugin | `panel` |
| `host.navigate { to: "session", sessionId }` | A session on this computer | `panel` + `session.widget` |
| `host.openExternal { url }` | `https:` only; the host shows the full URL and asks first | `panel` |
| `host.badge.refresh` | Ask the host to re-read the badge | `sidebar` |

The bridge has no data access; read data through `/plugin/v1` on the daemon.
