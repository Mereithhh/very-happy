# Configuration

Very Happy is configured with server environment variables and per-machine CLI
state. Never commit production values.

## Server essentials

| Variable | Meaning | Safe starting point |
|---|---|---|
| `HANDY_MASTER_SECRET` | Root secret for tokens and server-side account-secret encryption | Generate a high-entropy value; back it up separately |
| `SIGNUP_MODE` | `open`, `invite`, or `closed` | `closed` until the instance is verified |
| `SIGNUP_MAX_ACCOUNTS` | Global account cap; `0`/unset is unlimited | Set an explicit small value for public service |
| `SIGNUP_INVITE_CODES` | Comma-separated codes for invite mode | Store outside Git |
| `LOGIN_SESSION_TTL_DAYS` | Password/Google Web login lifetime, 1–365 | `30` |
| `MAX_LOGIN_SESSIONS_PER_ACCOUNT` | Active Password/Google Web sessions retained per account; oldest active session is evicted before a new login | `20` |
| `MAX_CREDENTIAL_CHANGES_PER_ACCOUNT_PER_MINUTE` | Shared database-backed password/username change rate; `0` disables only for a trusted private relay | `5` |
| `TRUST_PROXY` | Trusted hop count or proxy IP/CIDR allowlist | Exact topology; never unrestricted trust |
| `PORT` | HTTP/WebSocket port | `3005` |
| `METRICS_ENABLED` / `METRICS_HOST` / `METRICS_PORT` | Prometheus endpoint | Disabled by default; enable explicitly on `127.0.0.1:9090` |
| `AUTH_ALLOW_LEGACY_PAIRING` | Temporarily accept pairing without a one-time claim secret | Unset/`false`; enable only during the documented CLI rollout |
| `AUTH_PAIRING_TTL_MINUTES` | Pairing request lifetime, bounded to 1–60 minutes | `10` |
| `MAX_PENDING_AUTH_PAIRINGS` | Global unclaimed Terminal + Account pairing rows retained inside the TTL window | `1000` |
| `MAX_PENDING_GOOGLE_LOGIN_CHALLENGES` | Global outstanding Google nonce rows retained inside their five-minute TTL | `10000` |
| `ALLOW_LEGACY_KEY_SIGNUP` | Accept the legacy unauthenticated account-key signup route | Unset/`false` on public relays |
| `MAX_MACHINES_PER_ACCOUNT` | Hard machine count, serialized in the database | `20` |
| `MAX_SESSIONS_PER_ACCOUNT` | Hard session count, serialized in the database | `500` |
| `MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE` | Shared session metadata/state write budget; one unit per started 64 KiB, minimum one per write | `600` |
| `MAX_SESSION_STATE_BYTES_PER_ACCOUNT` | Stored session metadata plus agent-state bytes | `268435456` |
| `MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE` | Shared machine metadata/state write budget; one unit per started 64 KiB, minimum one per write | `240` |
| `MAX_MACHINE_STATE_BYTES_PER_ACCOUNT` | Stored machine metadata plus daemon-state bytes | `16777216` |
| `MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared synchronized-account-settings write rate; values are capped at 256 KiB UTF-8 | `60` |
| `MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE` | Shared database-backed message ingress rate | `600` |
| `MAX_MESSAGES_PER_ACCOUNT` | Stored message count per account | `100000` |
| `MAX_MESSAGE_BYTES_PER_ACCOUNT` | Stored encrypted message bytes per account | `536870912` |
| `MAX_ATTACHMENT_BYTES_PER_ACCOUNT` | Reserved attachment storage per account | `104857600` |
| `MAX_UPLOADED_FILES_PER_ACCOUNT` | Uploaded-file rows per account, including attachment reservations and avatars | `2000` |
| `ATTACHMENT_RESERVATION_TTL_MINUTES` | Reclaim uncompleted attachment reservations and their objects after this age; `0` disables cleanup | `60` |
| `MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared encrypted access-key create/update rate | `120` |
| `MAX_ACCESS_KEYS_PER_ACCOUNT` | Stored session/machine access-key rows per account | `2000` |
| `MAX_ACCESS_KEY_BYTES_PER_ACCOUNT` | Stored base64 access-key envelope bytes per account | `8388608` |
| `MAX_ARTIFACT_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared artifact create/update rate | `120` |
| `MAX_ARTIFACTS_PER_ACCOUNT` | Stored artifact count per account | `1000` |
| `MAX_ARTIFACT_BYTES_PER_ACCOUNT` | Stored artifact header, body, and data-key bytes per account | `268435456` |
| `MAX_KV_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared KV mutation rate, charged per mutation in a batch | `240` |
| `MAX_KV_ENTRIES_PER_ACCOUNT` | Stored KV rows per account, including tombstones | `5000` |
| `MAX_KV_BYTES_PER_ACCOUNT` | Stored KV key and encrypted-value bytes per account | `33554432` |
| `MAX_PUSH_TOKEN_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared push-token/webhook configuration write rate | `60` |
| `MAX_PUSH_TOKENS_PER_ACCOUNT` | Stored device, web-push, and webhook token rows per account | `25` |
| `MAX_USAGE_REPORT_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared usage-report write rate | `600` |
| `MAX_USAGE_REPORTS_PER_ACCOUNT` | Unique usage-report keys per account | `5000` |
| `MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared feed append/update rate | `120` |
| `MAX_FEED_ITEMS_PER_ACCOUNT` | Stored feed rows per account | `10000` |
| `MAX_FEED_BYTES_PER_ACCOUNT` | Stored feed JSON and repeat-key bytes per account | `67108864` |
| `MAX_RELATIONSHIP_WRITES_PER_ACCOUNT_PER_MINUTE` | Shared friend add/remove mutation rate | `60` |
| `MAX_RELATIONSHIPS_PER_ACCOUNT` | Outbound relationship rows per account | `2000` |
| `SOCKET_MAX_CONNECTIONS_PER_ACCOUNT` | Best-effort connection cap per server process; count includes browsers, machines, and every live agent/session socket; `0` disables | `128` |
| `SOCKET_MAX_PAYLOAD_BYTES` | Maximum Socket.IO payload | `1048576` |
| `TERMINAL_RELAY_BYTES_PER_SECOND` / `TERMINAL_RELAY_BURST_BYTES` | Per-account terminal relay byte token bucket, per process | `2097152` / `8388608` |
| `TERMINAL_RELAY_EVENTS_PER_SECOND` / `TERMINAL_RELAY_BURST_EVENTS` | Per-account terminal relay event token bucket, per process | `200` / `400` |
| `RPC_MAX_PAYLOAD_BYTES` | Maximum RPC call payload | `262144` |
| `RPC_MAX_CALLS_PER_MINUTE` | Best-effort RPC call cap per socket | `120` |
| `RPC_MAX_REGISTERED_METHODS_PER_SOCKET` | Unique RPC rooms a machine socket may register; `0` disables | `256` |
| `RPC_RELAY_BYTES_PER_SECOND` / `RPC_RELAY_BURST_BYTES` | Shared per-account RPC byte token bucket, per process | `2097152` / `20971520` |
| `RPC_RELAY_EVENTS_PER_SECOND` / `RPC_RELAY_BURST_EVENTS` | Shared per-account RPC event token bucket, per process | `2` / `120` |
| `VOICE_EXTRA_LIMIT_ACCOUNT_IDS` | Optional comma-separated account IDs that receive the legacy extra voice allowance | Unset/empty; configure only for an operator-managed migration |

`SIGNUP_CLOSED` remains a legacy fallback only. Prefer explicit `SIGNUP_MODE`.

## Google login

Set `GOOGLE_CLIENT_ID` and `GOOGLE_ALLOWED_ORIGINS` together. Create your own Web
OAuth client and list exact HTTPS JavaScript origins. The GIS popup flow needs no
client secret or redirect URI. Loopback HTTP is allowed for local development;
non-loopback origins must use HTTPS.

GitHub connect is enabled only when its client settings and an HTTPS
`PUBLIC_WEBAPP_URL` (or `HAPPY_WEB_URL`) are present. OAuth callbacks return to
that configured origin and never include the GitHub username in the URL.

## Storage and scale

- No `DATABASE_URL`: embedded PGlite.
- `DATABASE_URL`: external Postgres.
- No `S3_HOST`: local files under `DATA_DIR`.
- A configured S3 endpoint moves objects to S3-compatible storage.
- `REDIS_URL`: multi-process event/socket coordination.

Machine/session reservations and the account state, message, upload, access-key,
artifact, feed, KV, push-token, and usage-report buckets are enforced through the database across
replicas. HTTP and Socket.IO writers share the same account lock and rate bucket;
batch message/KV requests are charged per item. Socket connection, terminal
relay, and RPC relay/call caps are additional per-process/per-socket backstops, not global
billing-grade quotas. Set both rate and burst to `0` only on a trusted private
relay; multi-replica operators should divide the desired terminal allowance by
their maximum replica count for a strict cluster-wide ceiling.
Attachment byte/count quota is reserved when an upload URL is issued. Uncompleted
reservations are reclaimed after `ATTACHMENT_RESERVATION_TTL_MINUTES` (default 60)
in bounded batches, including deletion of the local/S3 object. Local PUT or the
first download marks a reservation complete; legacy readable attachments without
reservation rows remain compatible. Completed rows remain charged until the
owning session is deleted.

The four `TERMINAL_RELAY_*` settings are one shared per-account allowance for
terminal, clipboard, file-preview, and AccessKey Socket read events. `VOICE_EXTRA_LIMIT_ACCOUNT_IDS`
is empty by default and the repository contains no privileged account IDs. The
server accepts at most 100 comma-separated IDs, each up to 128 ASCII letters,
digits, `_`, or `-`; a malformed or oversized list fails closed to no extra
allowance. Prefer uniform quotas for a public service.

The four `RPC_RELAY_*` settings form a separate shared per-account allowance for
RPC calls accepted by one server process. Its default burst fits one complete
8 MiB terminal file handoff after encoding; `RPC_MAX_PAYLOAD_BYTES` and
`RPC_MAX_CALLS_PER_MINUTE` remain per-socket hard backstops. Multi-replica
operators should divide the sustained allowance when they need a strict
cluster-wide ceiling.

New and updated access-key envelopes must be canonical standard base64 and decode
to at most 4096 bytes. The account access-key byte quota measures the encoded
UTF-8 bytes actually stored; exact create retries are idempotent and updates are
charged by their encoded-byte delta. Artifact fields are capped at 262144 decoded header bytes, 8388608 decoded body
bytes, and 4096 decoded data-key bytes. KV keys are capped at 512 UTF-8 bytes and
values at 262144 decoded bytes. Push tokens are capped at 8192 UTF-8 bytes. Usage
keys/session IDs are capped at 256 UTF-8 bytes and usage payloads at 16384 bytes.
The server or proxy transport body limit can reject a request before these
per-field ceilings. Malformed or oversized individual fields fail validation before a write. Count or
rate exhaustion returns a stable `*_count_quota_exceeded` or
`*_rate_quota_exceeded` error (429); stored-byte exhaustion returns
`*_bytes_quota_exceeded` (413). Setting a resource limit to `0` explicitly makes
that one limit unlimited and is not recommended for an untrusted public relay.
Session/machine metadata fields are capped at 262144 stored UTF-8 bytes; agent
and daemon state fields are capped at 524288. Their write-rate settings use one
unit per started 65536 stored bytes so large full-state CAS updates cost more.
Synchronized account settings are capped at 262144 UTF-8 bytes and their writes
share a database-backed per-account rate bucket. Feed notification ciphertext is capped at 65536 UTF-8 bytes, feed IDs/repeat keys
at 256 bytes, and repeat-key updates replace a row atomically while charging only
the stored-byte delta.

See [deployment.md](deployment.md) for the full list and persistence guidance.

## CLI

| Variable | Purpose | Default |
|---|---|---|
| `HAPPY_SERVER_URL` | HTTP/WebSocket relay used by the CLI and daemon | `https://happy.mereith.com` |
| `HAPPY_WEBAPP_URL` | Browser origin opened for the one-time machine approval | `https://happy.mereith.com` |
| `HAPPY_HOME_DIR` | Credentials, settings, logs, daemon state, and local server data | `~/.happy` |
| `HAPPY_DISABLE_CAFFEINATE` | Disable the macOS sleep-prevention helper when `true`/`1`/`yes` | unset |
| `HAPPY_EXPERIMENTAL` | Enable explicitly experimental CLI paths | unset |

Cloud users need no endpoint variables. For self-hosting, set both URL variables
to the matching deployment. The daemon inherits them when it starts, so a value
exported only in an unrelated interactive shell does not configure a daemon
started later by a service manager. Use a distinct `HAPPY_HOME_DIR` per relay;
credentials and machine IDs are relay-specific. New credentials record their
issuing relay and fail closed before any request if an endpoint is changed.
Both endpoint values must be absolute HTTP(S) origins, without credentials,
paths, queries, or fragments. A trailing slash is accepted and normalized.

The same endpoints can be persisted as machine-local settings:

```json
{
  "serverUrl": "https://happy.example.com",
  "webappUrl": "https://happy.example.com"
}
```

Environment variables take precedence over `$HAPPY_HOME_DIR/settings.json`.
Agent provider credentials are separate. Native Claude TUI, Codex, Gemini,
OpenCode, and OpenClaw paths require their local command or gateway to be
configured for the daemon OS user. Provider credentials stay local by default.
Running `very-happy connect codex|claude|gemini` is an explicit
exception: it uploads that OAuth credential to, and retains it on, the configured
trusted relay. This storage is not end-to-end encrypted and is currently used
primarily by the Gemini path. Do not use it unless you trust the relay operator
and backups.

### Claude credentials for structured sessions

Web-created structured Claude sessions use the bundled Agent SDK. Very Happy
does not include Claude usage and does not broker a Claude.ai login. Configure a
credential supported for third-party Agent SDK applications in the daemon's own
startup environment:

| Source | Configuration | Recommended use |
|---|---|---|
| Claude API | `ANTHROPIC_API_KEY` | Simplest public quick start |
| Amazon Bedrock | normal AWS credentials plus `CLAUDE_CODE_USE_BEDROCK=true` | AWS-managed deployments |
| Google Vertex AI | normal Google Cloud credentials plus `CLAUDE_CODE_USE_VERTEX=true` | GCP-managed deployments |
| Microsoft Foundry | normal Azure credentials plus `CLAUDE_CODE_USE_FOUNDRY=true` | Azure-managed deployments |
| Auth gateway | `ANTHROPIC_AUTH_TOKEN` and the gateway's documented base URL/settings | Deliberate compatible gateway deployments |
| Claude configuration | `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, or an existing local credential store | Existing local setups; support and policy depend on Anthropic's current terms |

The first four are the documented deployment choices. Never commit these values
or place them in `settings.json`. `very-happy doctor` checks the current process
and reports only a source category. `very-happy daemon status` reports the source
category captured from the daemon's own environment at startup; older daemons
show `not detected at daemon start`.

An interactive shell export reaches a daemon only when that shell starts it. A
service manager needs the value in its own secret store/environment (for systemd,
a root/user-readable mode-`0600` `EnvironmentFile` is one option). Restart after
changes:

```bash
very-happy daemon stop
very-happy daemon start
very-happy doctor
very-happy daemon status
```

If Doctor detects a source but Claude still rejects the first session, run a
minimal provider request or Claude Code as the same OS user to validate account,
region, model access, and billing; then restart the daemon. If Doctor detects no
source, check the service-manager environment rather than repeatedly creating
sessions. OS-keychain credentials are intentionally not inspected, so that case
may work while Doctor remains conservative. See Anthropic's
[authentication](https://platform.claude.com/docs/en/manage-claude/authentication),
[cloud provider](https://code.claude.com/docs/en/team), and
[legal/compliance](https://code.claude.com/docs/en/legal-and-compliance)
documentation for the current provider rules.

The OpenClaw adapter reads `OPENCLAW_GATEWAY_URL`,
`OPENCLAW_GATEWAY_TOKEN`, and `OPENCLAW_GATEWAY_PASSWORD` when set; otherwise it
asks the local `openclaw` command for its gateway URL and reads the provider's
own config for the gateway token. Its generated device identity and paired
device token stay locally under `$HAPPY_HOME_DIR/openclaw/` with directory mode
`0700` and file mode `0600`. The first upgraded run securely copies any legacy
`~/openclaw/` auth files into that isolated home and hardens the originals for
rollback compatibility.

Use an isolated home for tests:

```bash
VH_TEST_HOME=$(mktemp -d)
HAPPY_HOME_DIR="$VH_TEST_HOME" \
HAPPY_SERVER_URL=http://127.0.0.1:3005 \
HAPPY_WEBAPP_URL=http://127.0.0.1:3005 \
  very-happy daemon status
```

Machine-only advanced settings live in `$HAPPY_HOME_DIR/settings.json`. Account
settings sync through the trusted server. Do not reuse the production `~/.happy`
for development.

Run `very-happy doctor` after changing an endpoint, PATH, Node, tmux, or agent
installation. It distinguishes required failures from optional degradation:
without tmux, authentication, structured sessions, daemon control, and plain Web
terminals still work. A direct shell may survive a brief browser reconnect while
the same daemon holds its PTY, but it is not durable/discoverable like tmux and
ends on daemon restart or idle cleanup.
