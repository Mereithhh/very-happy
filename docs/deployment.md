# Deployment

This document describes generic self-hosting. Maintainer production details for
`happy.mereith.com` live in [`operations.md`](operations.md).

## Runtime modes

| Mode | Database | Events/cache | Files | Intended use |
|---|---|---|---|---|
| Standalone | Embedded PGlite | In process | Local filesystem | One container, personal/small hosted instance |
| Full infrastructure | External Postgres | Optional Redis | Local or S3-compatible | Multiple processes/replicas and managed infrastructure |

Both modes run Fastify + Socket.IO on port 3005 and can expose Prometheus metrics
on a separate port. The maintainer Cloud currently uses the standalone/PGlite
shape inside Docker; Postgres/Redis/S3 are not universally required.

Before exposing an instance, read [`security.md`](security.md), set an explicit
`SIGNUP_MODE` and `SIGNUP_MAX_ACCOUNTS`, configure exact proxy trust, and keep the
metrics port off the public Internet. The relay is server-trusted.

## Local evaluation

Use the Docker example below with `-p 127.0.0.1:3005:3005`, invite-only bootstrap,
and persistent `/data`. `very-happy-server` is intentionally a private workspace
package: its Prisma build tooling is not an approved public production
dependency surface. Do not install the upstream-owned
`happy-server-self-host`, which serves a different product build.

## Full-infrastructure services
1. **Postgres**
   - Required only when `DATABASE_URL` is set; standalone uses PGlite.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Optional. When `REDIS_URL` is set, startup verifies it and multi-process
     Socket.IO uses Redis-backed coordination.
   - Configure via `REDIS_URL`.
   - Managed by this repo: `packages/happy-server/deploy/happy-redis.yaml` (StatefulSet + redis-exporter sidecar).

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.
   - **Deployed separately** — not managed by this repo's Kubernetes manifests. In prod, the S3-compatible service (MinIO or similar) behind `S3_PUBLIC_URL` is provisioned and managed by external infrastructure. The app only consumes it via env vars: `S3_PUBLIC_URL` is set in the Deployment, and credentials come from Vault via ExternalSecret (`/handy-files`).
   - If `S3_HOST` is unset, the server falls back to local filesystem storage (`./data/files/`).
   - For local k8s dev, a MinIO pod is deployed via `deploy/overlays/local/minio.yaml`.

## Environment variables
**Required in every mode**
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.

**Standalone storage**
- `DATA_DIR`: persistent base directory.
- `PGLITE_DIR`: optional PGlite path override.

**Full-infrastructure overrides**
- `DATABASE_URL`: external Postgres connection string.
- `REDIS_URL`: optional Redis connection string.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: S3-compatible object storage. Without `S3_HOST`, files use local storage.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: metrics are disabled by default; set exactly `true` to enable them.
- `METRICS_HOST`: metrics bind address (default `127.0.0.1`). Set a non-loopback
  address only behind a private network or authenticated proxy; never publish it
  directly to the Internet.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).
- `SIGNUP_MODE`: `open`, `invite`, or `closed`. The standalone entrypoint defaults
  to `closed`; full-infrastructure deployments retain legacy resolution when it
  is unset (closed for `SIGNUP_CLOSED`, invite when codes exist, otherwise open).
- `SIGNUP_MAX_ACCOUNTS`: positive global Account limit; unset or `0` means unlimited. Existing accounts can always log in when the limit is reached.
- `SIGNUP_INVITE_CODES`: comma-separated invite codes used when `SIGNUP_MODE=invite`.
- `LOGIN_SESSION_TTL_DAYS`: Web password/Google session lifetime, from 1 to 365 days (default `30`).
- `MAX_PENDING_GOOGLE_LOGIN_CHALLENGES`: cross-replica cap for outstanding,
  five-minute Google login nonce rows (default `10000`).
- `TRUST_PROXY`: trusted reverse-proxy hop count (for example `1`) or comma-separated proxy IP/CIDR allowlist. Never set it to an unrestricted boolean; correct client IPs are required for auth rate limiting.
- Access-key storage guards: `MAX_ACCESS_KEY_WRITES_PER_ACCOUNT_PER_MINUTE`
  (default `120`), `MAX_ACCESS_KEYS_PER_ACCOUNT` (default `2000`), and
  `MAX_ACCESS_KEY_BYTES_PER_ACCOUNT` (default `8388608`). Keep finite values on
  public relays; accepted envelopes are canonical base64 with a 4096-byte decoded
  ceiling, while the account byte quota measures encoded bytes stored.
- Persistent state guards: `MAX_SESSION_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE`
  (`600`), `MAX_SESSION_STATE_BYTES_PER_ACCOUNT` (`268435456`),
  `MAX_MACHINE_STATE_WRITE_UNITS_PER_ACCOUNT_PER_MINUTE` (`240`), and
  `MAX_MACHINE_STATE_BYTES_PER_ACCOUNT` (`16777216`). A write costs at least one
  unit plus one unit per started 64 KiB; keep finite values on public relays.
- Account-settings guard: `MAX_ACCOUNT_SETTINGS_WRITES_PER_ACCOUNT_PER_MINUTE`
  (`60`). Each synchronized value is capped at 256 KiB UTF-8 before storage.
- Feed guards: `MAX_FEED_WRITES_PER_ACCOUNT_PER_MINUTE` (`120`),
  `MAX_FEED_ITEMS_PER_ACCOUNT` (`10000`), and `MAX_FEED_BYTES_PER_ACCOUNT`
  (`67108864`).
- Social graph guards: `MAX_RELATIONSHIP_WRITES_PER_ACCOUNT_PER_MINUTE` (`60`)
  and `MAX_RELATIONSHIPS_PER_ACCOUNT` (`2000`). Two-sided mutations lock both
  accounts in stable order; existing relationships remain updatable at capacity.
- Upload row/lifecycle guards: `MAX_UPLOADED_FILES_PER_ACCOUNT` (`2000`) and
  `ATTACHMENT_RESERVATION_TTL_MINUTES` (`60`). Cleanup is bounded and removes
  both abandoned rows and their local/S3 objects; `0` disables cleanup and is
  intended only for a monitored trusted relay.

**Optional integrations**
- Google account login: `GOOGLE_CLIENT_ID` (Web OAuth client ID) and `GOOGLE_ALLOWED_ORIGINS` (comma-separated exact browser origins). No client secret is needed for Google Identity Services ID-token login.

For the maintainer Cloud, the origin configuration is:

```env
GOOGLE_CLIENT_ID=<maintainer-owned-web-client-id>
GOOGLE_ALLOWED_ORIGINS=https://happy.mereith.com
TRUST_PROXY=1
```

The same origin must be listed under **Authorized JavaScript origins** in Google Cloud Console. This flow uses the GIS popup ID-token callback, so it does not require an Authorized redirect URI. The origin is where the browser opens the Web UI (scheme and any non-default port included, with no path), which may differ from an API origin. Self-hosters must create their own Web OAuth client rather than copying the official Client ID. For local development, authorize and allowlist `http://localhost:8082`; non-loopback origins must use HTTPS. Changing these environment variables requires restarting the server with the new environment (container deployments normally recreate the container).
- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, plus redirect URL/URI.
  - `GITHUB_REDIRECT_URL` is used by the OAuth callback handler.
  - `GITHUB_REDIRECT_URI` is used by the GitHub App initializer.
- Voice: `ELEVENLABS_API_KEY` (required for `/v1/voice/conversations` in production).
- Subscriptions: `REVENUECAT_API_KEY` (server-side RevenueCat key, required for voice subscription checks).
- Legacy voice credits: `VOICE_EXTRA_LIMIT_ACCOUNT_IDS` is an optional,
  comma-separated operator migration list. It is empty by default; never commit
  real account IDs, and prefer uniform public quotas.
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` enables local file logging. The remote dev log endpoint is registered only when
  `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING_TOKEN` is also set; the CLI
  must receive the same token. Keep both unset outside a short debugging window.

## Docker image
A production Dockerfile is provided at `Dockerfile.server`.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image writes embedded database and local file state under `/data`.
- Startup applies PGlite migrations by default, or `prisma migrate deploy` to
  external Postgres when `DATABASE_URL`/`DB_PROVIDER=postgres` is configured.

From the repository root:

```bash
docker build -t very-happy-server -f Dockerfile.server .
docker run -d --name very-happy-server --restart unless-stopped \
  -p 127.0.0.1:3005:3005 \
  -e HANDY_MASTER_SECRET='replace-with-a-high-entropy-secret' \
  -e SIGNUP_MODE=invite \
  -e SIGNUP_INVITE_CODES='replace-with-one-time-bootstrap-code' \
  -e SIGNUP_MAX_ACCOUNTS=10 \
  -v very-happy-data:/data \
  very-happy-server
```

Create the first operator account with that bootstrap code. Then replace the
container while retaining the same volume:

```bash
docker rm -f very-happy-server
# Repeat the docker run command above with the same very-happy-data volume,
# remove SIGNUP_INVITE_CODES, and use: -e SIGNUP_MODE=closed
```

A plain `docker restart` retains the old environment and does **not** close
signup. Invite codes are policy values, not automatically one-time secrets;
closing registration after bootstrap is required.

Terminate TLS at a trusted reverse proxy before accepting non-loopback clients.
Persist `/data`, back it up together with the master secret, and test restore.

## Kubernetes manifests
Example manifests live in `packages/happy-server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`. The example explicitly sets
  `METRICS_ENABLED=true` and `METRICS_HOST=0.0.0.0` for pod-network scraping;
  keep that port behind cluster NetworkPolicy. The Service does not publish it.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `pnpm --filter very-happy-server db` (Postgres in Docker)
- `pnpm --filter very-happy-server redis`
- `pnpm --filter very-happy-server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `pnpm --filter very-happy-server dev`.

## Implementation references
- Entrypoint: `packages/happy-server/sources/main.ts`
- Dockerfile: `Dockerfile.server`
- Kubernetes manifests: `packages/happy-server/deploy`
- Env usage: `packages/happy-server/sources` (`rg -n "process.env"`)
