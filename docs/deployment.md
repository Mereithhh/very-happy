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
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).
- `SIGNUP_MODE`: `open`, `invite`, or `closed` (default keeps legacy behavior: closed when `SIGNUP_CLOSED` is set, invite when invite codes exist, otherwise open).
- `SIGNUP_MAX_ACCOUNTS`: positive global Account limit; unset or `0` means unlimited. Existing accounts can always log in when the limit is reached.
- `SIGNUP_INVITE_CODES`: comma-separated invite codes used when `SIGNUP_MODE=invite`.
- `LOGIN_SESSION_TTL_DAYS`: Web password/Google session lifetime, from 1 to 365 days (default `30`).
- `TRUST_PROXY`: trusted reverse-proxy hop count (for example `1`) or comma-separated proxy IP/CIDR allowlist. Never set it to an unrestricted boolean; correct client IPs are required for auth rate limiting.

**Optional integrations**
- Google account login: `GOOGLE_CLIENT_ID` (Web OAuth client ID) and `GOOGLE_ALLOWED_ORIGINS` (comma-separated exact browser origins). No client secret is needed for Google Identity Services ID-token login.

Official Cloud currently uses:

```env
GOOGLE_CLIENT_ID=190908753734-rto8svijvvh616877aketn4pnkhauec1.apps.googleusercontent.com
GOOGLE_ALLOWED_ORIGINS=https://happy.mereith.com
TRUST_PROXY=1
```

The same origin must be listed under **Authorized JavaScript origins** in Google Cloud Console. This flow uses the GIS popup ID-token callback, so it does not require an Authorized redirect URI. The origin is where the browser opens the Web UI (scheme and any non-default port included, with no path), which may differ from an API origin. Self-hosters must create their own Web OAuth client rather than copying the official Client ID. For local development, authorize and allowlist `http://localhost:8082`; non-loopback origins must use HTTPS. Changing these environment variables requires restarting the server with the new environment (container deployments normally recreate the container).
- GitHub OAuth/App: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, plus redirect URL/URI.
  - `GITHUB_REDIRECT_URL` is used by the OAuth callback handler.
  - `GITHUB_REDIRECT_URI` is used by the GitHub App initializer.
- Voice: `ELEVENLABS_API_KEY` (required for `/v1/voice/conversations` in production).
- Subscriptions: `REVENUECAT_API_KEY` (server-side RevenueCat key, required for voice subscription checks).
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Docker image
A production Dockerfile is provided at `Dockerfile.server`.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image includes FFmpeg and Python for media processing.

## Kubernetes manifests
Example manifests live in `packages/happy-server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `pnpm --filter happy-server db` (Postgres in Docker)
- `pnpm --filter happy-server redis`
- `pnpm --filter happy-server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `pnpm --filter happy-server dev`.

## Implementation references
- Entrypoint: `packages/happy-server/sources/main.ts`
- Dockerfile: `Dockerfile.server`
- Kubernetes manifests: `packages/happy-server/deploy`
- Env usage: `packages/happy-server/sources` (`rg -n "process.env"`)
