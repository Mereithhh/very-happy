# Very Happy Server

> **Distribution:** the supported public self-host path is `Dockerfile.server`
> from a reviewed repository checkout. This workspace package is private and
> guarded against npm publication; do not install the unrelated upstream
> `happy-server-self-host` package.

Self-hosted synchronization relay and Web backend for Very Happy.

## What is Happy?

Very Happy Server synchronizes Claude Code/Codex sessions, connects browser clients to CLI daemons, and serves the production Web UI when a static directory is configured.

This fork uses a **server-trusted model**, not the upstream zero-knowledge/E2E model. Email-code, password, and Google login require the server to recover the account secret. An operator—or an attacker controlling the server—may therefore read synchronized content and impersonate a Web client toward machines connected to that account. Only use a server whose operator you trust.

## Features

- 🔑 **Email-code and Google login** - Passwordless-by-default multi-user Web accounts, with optional password compatibility, signup policy, and capacity controls
- 🧭 **CLI pairing** - Existing cryptographic account/daemon flow remains compatible
- 📖 **Open source** - Transparent implementation you can audit and self-host
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 🌐 **Browser-first** - Web V2, Web Terminal and multi-device session management
- 🔔 **Push Notifications** - Notify when agents finish tasks or need permissions
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

The browser and CLI/daemon connect to the same account through the server. Wire payloads still use Happy's encrypted formats, but in this fork the server can recover account keys to support email-code, optional username/password, and Google login. Encryption at rest/in transit does not remove the need to trust the server operator.

## Hosting

You can self-host or connect to a maintainer-operated instance. These are not equivalent trust boundaries: a hosted instance's operator controls its server and deployment secrets. Read the instance's policy before connecting a daemon capable of remote command execution.

## Self-Hosting with Docker

The standalone Docker image runs everything in a single container with no external dependencies (no Postgres, no Redis, no S3).

```bash
docker build -t very-happy-server -f Dockerfile.server .
```

Run from the monorepo root:

```bash
docker run -d --name very-happy-server --restart unless-stopped \
  -p 127.0.0.1:3005:3005 \
  -e HANDY_MASTER_SECRET='replace-with-a-high-entropy-secret' \
  -e SIGNUP_MODE=invite \
  -e SIGNUP_INVITE_CODES='replace-with-one-time-bootstrap-code' \
  -e SIGNUP_MAX_ACCOUNTS=10 \
  -v happy-data:/data \
  very-happy-server
```

This uses:
- **PGlite** - embedded PostgreSQL (data stored in `/data/pglite`)
- **Local filesystem** - for file uploads (stored in `/data/files`)
- **In-memory event bus** - no Redis needed

Data persists in the `happy-data` Docker volume across container replacement.
Register the first operator with the bootstrap code, then replace the container
while retaining that volume:

```bash
docker rm -f very-happy-server
# Repeat the docker run command above with the same happy-data volume,
# remove SIGNUP_INVITE_CODES, and use: -e SIGNUP_MODE=closed
```

A plain `docker restart` retains the old environment and does **not** close
signup. Invite codes are not consumed automatically, so leaving the bootstrap
policy enabled is unsafe.
Keep this loopback-only while evaluating. Before exposing it, terminate TLS at
a trusted reverse proxy, configure `TRUST_PROXY`, backups, quotas, and an
explicit `closed`/`invite`/`open` registration policy. See the repository
[deployment](../../docs/deployment.md) and [security](../../docs/security.md)
guides.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Master secret for auth/encryption |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `HAPPY_RELAYS_JSON` | No | disabled | Control-mode candidate origins: JSON array of `{id,url,region}` |
| `RELAY_TOKEN_SECRET` | With regional relays | - | Dedicated shared signing secret; never reuse `HANDY_MASTER_SECRET` |
| `DATA_DIR` | No | `/data` in the Docker image; `./data` for the bare package | Base data directory |
| `PGLITE_DIR` | No | `<DATA_DIR>/pglite` | PGlite database directory |
| `SIGNUP_MODE` | No | `closed` | Account signup mode: `open`, `invite`, or `closed`; opening registration must be explicit |
| `SIGNUP_MAX_ACCOUNTS` | No | unlimited | Global Account limit; existing users can still sign in |
| `SIGNUP_INVITE_CODES` | No | - | Comma-separated codes for invite mode |
| `LOGIN_SESSION_TTL_DAYS` | No | `30` | Email/Google/password Web session lifetime (1–365 days) |
| `MAX_LOGIN_SESSIONS_PER_ACCOUNT` | No | `20` | Active Web login sessions retained per account; a new login evicts the oldest at the cap |
| `MAX_CREDENTIAL_CHANGES_PER_ACCOUNT_PER_MINUTE` | No | `5` | Database-backed per-account password/username change rate |
| `AUTH_PAIRING_TTL_MINUTES` | No | `10` | Terminal/account pairing lifetime (1–60 minutes) |
| `CLI_RECOMMENDED_VERSION` | No | unset | Exact CLI version advertised to connected daemons; pin for an operator-reviewed rollout |
| `CLI_MINIMUM_VERSION` | No | - | Exact compatibility/security floor; older daemons show a required-update warning |
| `CLI_VERSION_REGISTRY_LOOKUP` | No | `false` | Set `true` to opt into outbound npm version discovery when no recommended version is pinned |
| `MAX_PENDING_AUTH_PAIRINGS` | No | `1000` | Global outstanding pairing cap across both pairing tables |
| `GOOGLE_CLIENT_ID` | No | - | Enables Google Identity Services account login |
| `GOOGLE_ALLOWED_ORIGINS` | With Google | - | Comma-separated exact Web origins allowed to request/consume Google login challenges |
| `AUTH_EMAIL_PROVIDER` | No | - | Enables passwordless email codes: `resend` or `cloudflare` |
| `AUTH_EMAIL_FROM` | With email | - | Verified sender, for example `Very Happy <login@example.com>` |
| `RESEND_API_KEY` | With Resend | - | Resend API key; keep it only in deployment secrets |
| `CLOUDFLARE_EMAIL_ACCOUNT_ID` / `CLOUDFLARE_EMAIL_API_TOKEN` | With Cloudflare | - | Cloudflare Email Service account and scoped sending token |
| `AUTH_EMAIL_CODE_TTL_MINUTES` | No | `10` | One-time code lifetime (2–30 minutes) |
| `MAX_PENDING_EMAIL_LOGIN_CHALLENGES` | No | `10000` | Global cap for unconsumed email challenges |
| `AUTH_EMAIL_GLOBAL_DAILY_SEND_LIMIT` / `AUTH_EMAIL_GLOBAL_MONTHLY_SEND_LIMIT` | No | `200` / `3000` | Shared delivery budgets across replicas; keep finite to bound abuse and spend |
| `AUTH_PASSWORD_LOGIN_DISABLED` | No | `false` | Set to `true` only after email or Google login is working; rejects password login, signup, and credential changes |
| `TRUST_PROXY` | Behind proxy | - | Positive trusted hop count or comma-separated proxy IP/CIDR allowlist used to recover real client IPs safely |
| `MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE` / `MAX_SESSION_STATE_BYTES_PER_ACCOUNT` | No | `600` / `268435456` | Session metadata/state weighted writes and stored bytes; one unit per started 64 KiB |
| `MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE` / `MAX_MACHINE_STATE_BYTES_PER_ACCOUNT` | No | `240` / `16777216` | Machine metadata/state weighted writes and stored bytes; one unit per started 64 KiB |
| `MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE` | No | `120` | Shared database-backed access-key create/update rate |
| `MAX_ACCESS_KEYS_PER_ACCOUNT` | No | `2000` | Stored access-key rows per account |
| `MAX_ACCESS_KEY_BYTES_PER_ACCOUNT` | No | `8388608` | Encoded access-key envelope bytes stored per account; individual envelopes decode to at most 4096 bytes |
| `MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE` / `MAX_FEED_ITEMS_PER_ACCOUNT` / `MAX_FEED_BYTES_PER_ACCOUNT` | No | `120` / `10000` / `67108864` | Database-backed feed rate, row, and stored-byte guards |
| `MAX_RELATIONSHIP_WRITES_PER_ACCOUNT_PER_MINUTE` / `MAX_RELATIONSHIPS_PER_ACCOUNT` | No | `60` / `2000` | Friend mutation rate and outbound relationship-row cap |
| `MAX_UPLOADED_FILES_PER_ACCOUNT` / `ATTACHMENT_RESERVATION_TTL_MINUTES` | No | `2000` / `60` | Uploaded-file row cap and abandoned attachment reservation/object cleanup age |
| `TERMINAL_RELAY_BYTES_PER_SECOND` / `TERMINAL_RELAY_BURST_BYTES` | No | `2097152` / `8388608` | Per-account, per-process terminal bandwidth bucket; `0` disables that dimension |
| `TERMINAL_RELAY_EVENTS_PER_SECOND` / `TERMINAL_RELAY_BURST_EVENTS` | No | `200` / `400` | Per-account, per-process terminal event bucket; `0` disables that dimension |
| `RPC_RELAY_BYTES_PER_SECOND` / `RPC_RELAY_BURST_BYTES` | No | `2097152` / `20971520` | Shared per-account, per-process RPC byte bucket; default burst fits one encoded 8 MiB terminal handoff |
| `RPC_RELAY_EVENTS_PER_SECOND` / `RPC_RELAY_BURST_EVENTS` | No | `2` / `120` | Shared per-account, per-process RPC event bucket |
| `RPC_MAX_REGISTERED_METHODS_PER_SOCKET` | No | `256` | Unique RPC method rooms per machine socket; overflow disconnects the socket |

To enable Google login, create a **Web application** OAuth client in Google Cloud Console and add every deployed Web origin (for example `https://happy.example.com`) under **Authorized JavaScript origins**. Set that client ID and the same exact origin(s) in the two variables above. The popup ID-token callback does not use an Authorized redirect URI or client secret. Do not copy the maintainer Cloud client ID for a self-hosted domain; create a client owned by your deployment.

Email codes are the Web UI's preferred sign-in method when configured. Verify a
sending domain with Resend or Cloudflare Email Service, then set the matching
provider credentials and `AUTH_EMAIL_FROM`. The server stores only an HMAC of
each six-digit code, expires it after ten minutes by default, permits three failed
attempts, and consumes it once. Existing identities continue to sign in when
signup is closed or full; a new email still obeys the normal signup policy.
Cloudflare Email Sending is currently Beta and arbitrary recipients require the
Workers Paid plan; Resend remains the stable alternative for operators who do
not want that prerequisite.

Do not set `AUTH_PASSWORD_LOGIN_DISABLED=true` in the same first deployment.
First deliver and consume a real code, verify Google too if it is your fallback,
then recreate the server with password login disabled. Startup fails closed if
password login is disabled while neither email nor Google is configured, or if
any password identity still has no email/Google identity on the same Account.

### Optional: Regional realtime relays

Run the control/data server with a dedicated signing secret and a finite candidate
list:

```bash
export RELAY_TOKEN_SECRET='<dedicated-high-entropy-secret>'
export HAPPY_RELAYS_JSON='[{"id":"relay-a","url":"https://relay-a.example.com","region":"region-a"}]'
```

Run each relay from the same server package without database or storage credentials:

```bash
RELAY_ID=relay-a \
RELAY_REGION=region-a \
RELAY_TOKEN_SECRET='<same-dedicated-secret>' \
HOST=0.0.0.0 PORT=3010 \
happy-server relay
```

Terminate TLS in front of every relay. Verify `/health` before adding an origin
to `HAPPY_RELAYS_JSON`. Relay mode serves Socket.IO at `/v1/relay`, validates
short-lived machine-scoped tokens locally, and never needs `DATABASE_URL` or
`HANDY_MASTER_SECRET`. Clearing the candidate list disables discovery and keeps
the compatible single-server path.

### Optional: External Services

To use external Postgres or Redis instead of the embedded defaults, set:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL (bypasses PGlite) |
| `REDIS_URL` | Redis connection URL |
| `S3_HOST` | S3/MinIO host (bypasses local file storage) |

When `DATABASE_URL` is set, the image runs `prisma migrate deploy` against that
database before serving. Without it, the same entrypoint applies the bundled
SQL migrations to PGlite under `/data/pglite`.

PGlite is strictly single-process. The server holds a kernel advisory lock on the
canonical database directory for its full lifetime and refuses a second opener.
Never attach another PGlite process to a running data directory for diagnostics;
stop the service and inspect a complete copy instead. Use external PostgreSQL when
multi-process administration or point-in-time recovery is required.

The Docker image includes the required `flock` utility. A bare Unix development
host needs either system `flock` or Python 3 with `fcntl`; without either kernel
advisory-lock helper, persistent PGlite refuses to start rather than running
without an enforceable process boundary. Keep the PGlite directory on a local
filesystem; network/NFS volumes are unsupported. Use external PostgreSQL for
networked or multi-host storage.

### S3 bucket configuration (when self-hosting with S3)

When `S3_HOST` is set, image attachments and other blobs land in S3 under
`sessions/<sessionId>/attachments/<id>.enc`. Two bucket-level settings are
not configured by the server itself and must be applied once at deploy
time:

**1. Lifecycle rule for attachment TTL.** Encrypted blobs are deleted when
their session is deleted, but a long-lived session would otherwise keep
its blobs forever. Add a lifecycle rule on the attachments prefix so
objects age out automatically. Pick a TTL that matches your retention
policy (30 days is a reasonable default).

```bash
# AWS CLI
aws s3api put-bucket-lifecycle-configuration --bucket happy-blobs \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "session-attachments-ttl",
      "Status": "Enabled",
      "Filter": { "Prefix": "sessions/" },
      "Expiration": { "Days": 30 }
    }]
  }'

# MinIO
mc ilm rule add myminio/happy-blobs \
  --expire-days 30 \
  --prefix "sessions/"
```

**2. Server-side encryption (defense-in-depth).** Blobs use Happy's encrypted
wire/storage format, but this fork remains server-trusted because the server can
recover account secrets. Enabling AES-256 SSE still protects against an attacker
who obtains only raw object-storage access without the application secrets.

```bash
# AWS CLI
aws s3api put-bucket-encryption --bucket happy-blobs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# MinIO
mc encrypt set sse-s3 myminio/happy-blobs
```

Local-storage mode (no `S3_HOST`) writes blobs under
`<DATA_DIR>/files/sessions/<sessionId>/attachments/`. There is no
lifecycle equivalent — clean up old session directories on a cron if
you want a TTL story.

## License and attribution

MIT. Very Happy is a deeply modified fork of
[slopus/happy](https://github.com/slopus/happy) by Kirill Dubovitskiy and Happy
Coder Contributors. The preserved copyright and permission notice is included
in [LICENSE](./LICENSE).
