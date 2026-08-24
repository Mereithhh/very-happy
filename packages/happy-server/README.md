# Very Happy Server

> **Distribution:** the supported public self-host path is `Dockerfile.server`
> from a reviewed repository checkout. This workspace package is private and
> guarded against npm publication; do not install the unrelated upstream
> `happy-server-self-host` package.

Self-hosted synchronization relay and Web backend for Very Happy.

## What is Happy?

Very Happy Server synchronizes Claude Code/Codex sessions, connects browser clients to CLI daemons, and serves the production Web UI when a static directory is configured.

This fork uses a **server-trusted model**, not the upstream zero-knowledge/E2E model. Password and Google login require the server to recover the account secret. An operator—or an attacker controlling the server—may therefore read synchronized content and impersonate a Web client toward machines connected to that account. Only use a server whose operator you trust.

## Features

- 🔑 **Password and Google login** - Multi-user Web accounts with signup policy and capacity controls
- 🧭 **CLI pairing** - Existing cryptographic account/daemon flow remains compatible
- 📖 **Open source** - Transparent implementation you can audit and self-host
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 🌐 **Browser-first** - Web V2, Web Terminal and multi-device session management
- 🔔 **Push Notifications** - Notify when agents finish tasks or need permissions
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

The browser and CLI/daemon connect to the same account through the server. Wire payloads still use Happy's encrypted formats, but in this fork the server can recover account keys to support username/password and Google login. Encryption at rest/in transit does not remove the need to trust the server operator.

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
| `DATA_DIR` | No | `/data` in the Docker image; `./data` for the bare package | Base data directory |
| `PGLITE_DIR` | No | `<DATA_DIR>/pglite` | PGlite database directory |
| `SIGNUP_MODE` | No | `closed` | Account signup mode: `open`, `invite`, or `closed`; opening registration must be explicit |
| `SIGNUP_MAX_ACCOUNTS` | No | unlimited | Global Account limit; existing users can still sign in |
| `SIGNUP_INVITE_CODES` | No | - | Comma-separated codes for invite mode |
| `LOGIN_SESSION_TTL_DAYS` | No | `30` | Password/Google Web session lifetime (1–365 days) |
| `MAX_LOGIN_SESSIONS_PER_ACCOUNT` | No | `20` | Active Web login sessions retained per account; a new login evicts the oldest at the cap |
| `MAX_CREDENTIAL_CHANGES_PER_ACCOUNT_PER_MINUTE` | No | `5` | Database-backed per-account password/username change rate |
| `AUTH_PAIRING_TTL_MINUTES` | No | `10` | Terminal/account pairing lifetime (1–60 minutes) |
| `MAX_PENDING_AUTH_PAIRINGS` | No | `1000` | Global outstanding pairing cap across both pairing tables |
| `GOOGLE_CLIENT_ID` | No | - | Enables Google Identity Services account login |
| `GOOGLE_ALLOWED_ORIGINS` | With Google | - | Comma-separated exact Web origins allowed to request/consume Google login challenges |
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
