# Very Happy Server

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
docker build -t happy-server -f Dockerfile .
```

Run from the monorepo root:

```bash
docker run -p 3005:3005 \
  -e HANDY_MASTER_SECRET=<your-secret> \
  -v happy-data:/data \
  happy-server
```

This uses:
- **PGlite** - embedded PostgreSQL (data stored in `/data/pglite`)
- **Local filesystem** - for file uploads (stored in `/data/files`)
- **In-memory event bus** - no Redis needed

Data persists in the `happy-data` Docker volume across container restarts.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HANDY_MASTER_SECRET` | Yes | - | Master secret for auth/encryption |
| `PUBLIC_URL` | No | `http://localhost:3005` | Public base URL for file URLs sent to clients |
| `PORT` | No | `3005` | Server port |
| `DATA_DIR` | No | `/data` | Base data directory |
| `PGLITE_DIR` | No | `/data/pglite` | PGlite database directory |
| `SIGNUP_MODE` | No | `open` | Account signup mode: `open`, `invite`, or `closed` |
| `SIGNUP_MAX_ACCOUNTS` | No | unlimited | Global Account limit; existing users can still sign in |
| `SIGNUP_INVITE_CODES` | No | - | Comma-separated codes for invite mode |
| `LOGIN_SESSION_TTL_DAYS` | No | `30` | Password/Google Web session lifetime (1–365 days) |
| `GOOGLE_CLIENT_ID` | No | - | Enables Google Identity Services account login |
| `GOOGLE_ALLOWED_ORIGINS` | With Google | - | Comma-separated exact Web origins allowed to request/consume Google login challenges |
| `TRUST_PROXY` | Behind proxy | - | Positive trusted hop count or comma-separated proxy IP/CIDR allowlist used to recover real client IPs safely |

To enable Google login, create a **Web application** OAuth client in Google Cloud Console and add every deployed Web origin (for example `https://happy.example.com`) under **Authorized JavaScript origins**. Set that client ID and the same exact origin(s) in the two variables above. The popup ID-token callback does not use an Authorized redirect URI or client secret. Do not copy the maintainer Cloud client ID for a self-hosted domain; create a client owned by your deployment.

### Optional: External Services

To use external Postgres or Redis instead of the embedded defaults, set:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection URL (bypasses PGlite) |
| `REDIS_URL` | Redis connection URL |
| `S3_HOST` | S3/MinIO host (bypasses local file storage) |

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

## License

MIT - Use it, modify it, deploy it anywhere.
