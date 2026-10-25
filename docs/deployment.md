# Deployment

This document describes generic self-hosting. Maintainer production details for
`veryhappy.dev` live in [`operations.md`](operations.md).

## Runtime modes

| Mode | Database | Events/cache | Files | Intended use |
|---|---|---|---|---|
| Standalone | Embedded PGlite | In process | Local filesystem | One container, personal/small hosted instance |
| Full infrastructure | External Postgres | Optional Redis | Local or S3-compatible | Multiple processes/replicas and managed infrastructure |

Both modes run Fastify + Socket.IO on port 3005 and can expose Prometheus metrics
on a separate port. The maintainer Cloud currently uses external PostgreSQL in
Docker; Postgres/Redis/S3 are not universally required for self-hosting.

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
   - Optional for one process, mandatory for the maintainer blue-green release
     topology. In that mode it backs Socket.IO cross-slot routing, connection
     leases and relay assignment leases; readiness fails closed if Redis is not
     healthy.

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.
   - **Deployed separately** — not managed by this repo's Kubernetes manifests. In prod, the S3-compatible service (MinIO or similar) behind `S3_PUBLIC_URL` is provisioned and managed by external infrastructure. The app only consumes it via env vars: `S3_PUBLIC_URL` is set in the Deployment, and credentials come from Vault via ExternalSecret (`/handy-files`).
   - If `S3_HOST` is unset, the server falls back to local filesystem storage (`./data/files/`).
   - For local k8s dev, a MinIO pod is deployed via `deploy/overlays/local/minio.yaml`.

## Environment variables
**Required in control/data mode**
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.

**Standalone storage**
- `DATA_DIR`: persistent base directory.
- `PGLITE_DIR`: optional PGlite path override.

**Full-infrastructure overrides**
- `DATABASE_URL`: external Postgres connection string.
- `REDIS_URL`: optional Redis connection string.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: S3-compatible object storage. Without `S3_HOST`, files use local storage.

**Optional regional realtime plane**
- `HAPPY_RELAYS_JSON`: control-server JSON array of `{ "id", "url", "region" }` relay origins.
- `RELAY_TOKEN_SECRET`: high-entropy secret shared only by the control server and regional relays; do not reuse `HANDY_MASTER_SECRET`.
- Relay processes run `happy-server relay` with `RELAY_ID`, `RELAY_REGION`, the same `RELAY_TOKEN_SECRET`, `HOST`, and `PORT`. Relay mode does not require `HANDY_MASTER_SECRET`, `DATABASE_URL`, or storage credentials.
- Every relay URL must be an HTTPS origin in production and expose `/health` plus Socket.IO `/v1/relay`. Deploy and verify all candidates before enabling `HAPPY_RELAYS_JSON`; clearing the variable returns new clients to the legacy control path.

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
- `LOGIN_SESSION_TTL_DAYS`: Web email/Google/password session lifetime, from 1 to 365 days (default `30`).
- `MAX_PENDING_GOOGLE_LOGIN_CHALLENGES`: cross-replica cap for outstanding,
  five-minute Google login nonce rows (default `10000`).
- `TRUST_PROXY`: comma-separated IP/CIDR allowlist of the reverse proxy the server sees as its socket peer (for example `172.18.0.1` for a Docker-gateway Caddy, or `loopback`/`uniquelocal`). Hop counts such as `1` are rejected at startup: they cannot validate the peer and Fastify 5.12+ treats them as trusting nobody. Never set it to an unrestricted boolean; correct client IPs are required for auth rate limiting.
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
- Automations guard: `MAX_AUTOMATIONS_PER_ACCOUNT` (`100`, active + paused;
  `0` disables). Teams and Automations themselves are server-wide switches
  (`VH_AGENT_TEAMS_ENABLED` / `VH_AUTOMATIONS_ENABLED`) with no per-account
  allowlist.
- Profile guard: `MAX_PROFILE_WRITES_PER_ACCOUNT_PER_MINUTE` (`20`) for display name / handle edits.
- Social graph guards: `MAX_RELATIONSHIP_WRITES_PER_ACCOUNT_PER_MINUTE` (`60`)
  and `MAX_RELATIONSHIPS_PER_ACCOUNT` (`2000`). Two-sided mutations lock both
  accounts in stable order; existing relationships remain updatable at capacity.
- Upload row/lifecycle guards: `MAX_UPLOADED_FILES_PER_ACCOUNT` (`2000`) and
  `ATTACHMENT_RESERVATION_TTL_MINUTES` (`60`). Cleanup is bounded and removes
  both abandoned rows and their local/S3 objects; `0` disables cleanup and is
  intended only for a monitored trusted relay.

**Optional integrations**
- Google account login: `GOOGLE_CLIENT_ID` (Web OAuth client ID) and `GOOGLE_ALLOWED_ORIGINS` (comma-separated exact browser origins). No client secret is needed for Google Identity Services ID-token login.
- Generic OpenID Connect login (B-620; any provider with a discovery document, for
  example Authentik, Keycloak, Okta, Entra ID): `OIDC_ISSUER` (the issuer URL,
  https except loopback; its `/.well-known/openid-configuration` must be reachable
  from the server) and `OIDC_CLIENT_ID` enable it; `OIDC_CLIENT_SECRET` is used
  when the client is confidential (`client_secret_post`, or `client_secret_basic`
  when the provider advertises only that). Register the redirect URI
  `<server origin>/v1/auth/oidc/callback` at the provider. Optional:
  `OIDC_DISPLAY_NAME` (button label, default `SSO`), `OIDC_SCOPES` (default
  `openid profile email`; `openid` is always added), `OIDC_REDIRECT_URL` (explicit
  callback URL when `PUBLIC_URL`/proxy headers would derive the wrong origin),
  `OIDC_WEB_RETURN_URL` (Web origin to land on, when the Web UI is not served from
  the API origin; `PUBLIC_WEBAPP_URL` is also honoured), `OIDC_ALLOWED_EMAIL_DOMAINS`
  (comma-separated; accounts whose token email is missing or outside the list are
  refused), and `MAX_PENDING_OIDC_LOGIN_CHALLENGES` (default `10000`). The flow is
  authorization code + PKCE with server-held state/nonce; id_tokens are verified
  with the provider's JWKS (RS256/ES256 family). Account creation obeys
  `SIGNUP_MODE` unless `OIDC_SIGNUP_MODE` (`open`/`invite`/`closed`, B-623)
  overrides it for SSO first logins only — `OIDC_SIGNUP_MODE=open` with
  `OIDC_ALLOWED_EMAIL_DOMAINS` makes an invite-only relay self-service for the
  provider's users while password/email/Google sign-up keeps asking for a code;
  `SIGNUP_MAX_ACCOUNTS` still applies. An identity is keyed `oidc:<issuer>` +
  `sub`, so the same person always lands on the same account; `OIDC_LINK_BY_EMAIL=verified`
  (B-626, default `off`) additionally lets a first SSO login with a
  provider-verified email attach to the existing Email/Google account that owns
  that address — only set it when the provider really verifies emails. A configured issuer counts as an interactive
  login path for the `AUTH_PASSWORD_LOGIN_DISABLED` startup check.
- Moving everyone to another relay (B-627): copy the database to the new relay
  first (`pg_dump` → restore; account/session/machine ids stay the same on both
  sides). If the new relay has a different `HANDY_MASTER_SECRET`, run
  `happy-server rekey` against the copy with `OLD_HANDY_MASTER_SECRET=<old>` and
  `HANDY_MASTER_SECRET=<new>` (B-636; dry run by default, `--apply` to write): it
  re-wraps account secrets, GitHub/vendor tokens and team credentials and drops
  the old relay's login sessions, so everyone signs in once more. To take only
  some people along, run `happy-server prune-accounts --keep-file ids.txt`
  (one account id per line, `#` comments; dry run by default, `--apply` to
  delete) on the copy: every account not listed is removed with all its rows,
  walking the real foreign-key graph, and GitHub tokens nobody references any
  more go with them. Then on the OLD relay set `MIGRATION_TARGET_URL` (API
  origin of the new relay), optionally `MIGRATION_TARGET_WEBAPP_URL` (Web
  origin, defaults to the API origin) and `MIGRATION_TARGET_NAME` (banner
  wording, defaults to the host), and say who moves with `MIGRATION_ACCOUNT_IDS`
  (comma-separated) and/or `MIGRATION_EMAIL_DOMAINS` (comma-separated; matched
  against provider-verified Email/Google/OIDC identity emails). Both relays
  share `MIGRATION_HANDOFF_SECRET` (≥32 chars). Targeted accounts then see a
  "moved" banner (`GET /v1/migration`); the click mints a signed ten-minute,
  single-use ticket (`POST /v1/migration/handoff`) and sends the browser to
  `<new web origin>/login/migrate?handoff=…`. On the new relay that page runs
  the SSO round trip with the ticket (the `oidc:<issuer>`+`sub` identity is
  attached to the copied account, or moved off an empty account the person
  created meanwhile; an account with sessions or machines is reported as
  `migration_conflict`), or, without an OIDC issuer, spends it at
  `POST /v1/auth/migrate/complete` for a direct login. The old relay also sends
  every targeted daemon a `server-migrate` socket event (`{ url, webappUrl,
  handoff }`) on connect; a daemon with B-635 buys a machine token at the new
  relay with the same endpoint, rewrites `settings.serverUrl`/`webappUrl` and its
  credentials, and hands over to a fresh daemon process once no agent is
  mid-turn (a daemon whose environment pins `HAPPY_SERVER_URL` refuses and logs
  why; running session wrappers finish on the old relay). Keep the old relay
  up (read-mostly) until the banner has done its job, then switch it off.
- White-label (B-624 / B-637 / B-638, standalone entrypoint): `BRAND_NAME` renames the
  product in every Web UI string that names it (auth cards, loaders, Settings →
  About, document title, the PWA install card, first-machine guide, notifications,
  release notes; max 64 chars). Brand assets, each an http(s) URL or absolute path:
  `BRAND_LOGO_URL` (square mark: sidebar, auth cards, empty states, install card,
  splash) with optional `BRAND_LOGO_DARK_URL` for the dark theme; `BRAND_WORDMARK_URL`
  (+ `_DARK_URL`, horizontal logo-with-text lockup: auth cards, splash, public
  header); `BRAND_ICON_URL` (opaque square PNG ≥ 512 px: favicon, apple-touch-icon,
  PWA manifest icons, `og:image`). The server rewrites `index.html` and
  `manifest.webmanifest` on the way out, so the first paint, the tab and the
  home-screen icon already carry the brand. `BRAND_ASSETS_DIR=/some/dir` serves that
  directory read-only at `/brand/` (mount a ConfigMap and point the URLs at
  `/brand/<file>`). `BRAND_ENV_LABEL` (max 24 chars, e.g. `Staging`) adds a badge
  next to the name and suffixes the title / PWA name so a test relay is never
  mistaken for production. Finally, `WEB_LANDING=off` removes the marketing page so anonymous
  visitors to `/` and `/welcome` go straight to `/login` (docs and legal pages
  stay public). Values are injected into `window.__HAPPY_CONFIG__` as `brand` /
  `landing`; an explicit `HAPPY_INJECT_HTML_CONFIG` JSON still wins.
- Passwordless email login: set `AUTH_EMAIL_PROVIDER=resend` with `AUTH_EMAIL_FROM` and `RESEND_API_KEY`, or `AUTH_EMAIL_PROVIDER=cloudflare` with `AUTH_EMAIL_FROM`, `CLOUDFLARE_EMAIL_ACCOUNT_ID`, and `CLOUDFLARE_EMAIL_API_TOKEN`. Verify the sender domain first. Deploy and smoke-test a real code before optionally setting `AUTH_PASSWORD_LOGIN_DISABLED=true`; the server fails startup if that would leave no email or Google login path.

Before deploying the one-Google-identity-per-account constraint, run this read-only
preflight against the production database. Zero rows is required:

```sql
SELECT "accountId", COUNT(*) AS identity_count
FROM "AccountIdentity"
WHERE "provider" = 'google'
GROUP BY "accountId"
HAVING COUNT(*) > 1;
```

If it returns rows, stop the deployment and determine ownership with the affected
user. Never delete, move, or merge those identities based only on matching Email
addresses. The migration intentionally fails closed with the same condition.
  Existing accounts must explicitly link Email from **Settings → Account → Email
  sign-in** or Google from **Settings → Account → Google sign-in** during a login
  session created within the last 10 minutes. Do not merge
  accounts or move identities by matching Email/Google address strings.

For the maintainer Cloud, the origin configuration is:

```env
GOOGLE_CLIENT_ID=<maintainer-owned-web-client-id>
GOOGLE_ALLOWED_ORIGINS=https://veryhappy.dev
TRUST_PROXY=172.18.0.1
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

The public, complete image is
`ghcr.io/mereithhh/very-happy-server:latest`. It contains the current server,
Prisma schema and generated Client, migrations, and Web V2. Pin a full commit-SHA
tag or manifest digest instead of `latest` for reproducible production
deployments. Maintainer CI moves `latest` only after the same digest passes
production health and Web asset checks. Do not
bind-mount `sources`, `prisma`, `node_modules`, or `webapp` over the image: those
parts are one release unit and mixing their versions can make migrations succeed
while runtime queries fail.

`Dockerfile.server` remains available for source builds:

```bash
docker build -t very-happy-server -f Dockerfile.server .
```

Operators who split realtime traffic into regional data-plane processes can
build the database-free image from `Dockerfile.relay`. Maintainer deployment
manifests for Docker/Caddy live under `ops/relay/`; they are
examples of topology, not a source for signing secrets.

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image writes embedded database and local file state under `/data`.
- Startup applies PGlite migrations by default, or `prisma migrate deploy` to
  external Postgres when `DATABASE_URL`/`DB_PROVIDER=postgres` is configured.

For a small standalone installation:

```bash
docker run -d --name very-happy-server --restart unless-stopped \
  -p 127.0.0.1:3005:3005 \
  -e HANDY_MASTER_SECRET='replace-with-a-high-entropy-secret' \
  -e SIGNUP_MODE=invite \
  -e SIGNUP_INVITE_CODES='replace-with-one-time-bootstrap-code' \
  -e SIGNUP_MAX_ACCOUNTS=10 \
  -v very-happy-data:/data \
  ghcr.io/mereithhh/very-happy-server:latest
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

For a long-lived or multi-user installation, use external PostgreSQL and keep
both services on a private Compose network. Set `DATABASE_URL` to the Postgres
service name, persist its data volume, and let the server image run
`prisma migrate deploy` before serving. A minimal shape is:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    env_file: .env
    volumes:
      - postgres-data:/var/lib/postgresql/data
  happy:
    image: ghcr.io/mereithhh/very-happy-server:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      - postgres
    ports:
      - 127.0.0.1:3005:3005
    volumes:
      - happy-data:/data
volumes:
  postgres-data:
  happy-data:
```

The `.env` must include a valid `DATABASE_URL`, Postgres credentials,
`HANDY_MASTER_SECRET`, and an explicit signup policy. Pin the Postgres image by
digest and add a healthcheck before treating this abbreviated example as a
production manifest.

## Connect a machine and its agents

Installing the server is only half of a usable Very Happy deployment. On every
machine that should run agents, install the current CLI and point both endpoints
at the HTTPS origin serving the self-hosted Web and API:

```bash
npm install --global very-happy-cli
export HAPPY_SERVER_URL=https://happy.example.com
export HAPPY_WEBAPP_URL=https://happy.example.com
very-happy auth login
very-happy daemon start
```

Keep both endpoint variables in the daemon's persistent service environment, not
only in an interactive shell. If `HAPPY_HOME_DIR` is customized, the login,
daemon, `spawn`/`send`, and any MCP subprocess must all use the same value. Keep
server/Web and CLI/daemon versions compatible and upgrade them together for new
wire capabilities.

Managed Claude, Codex, Gemini and ACP sessions automatically receive Very Happy's
clipboard bridge. A plain `claude` process can opt into the narrower,
clipboard-only MCP server:

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

You can then ask the agent in natural language to copy text to your clipboard.
This is an encrypted, best-effort handoff to Web/PWA clients currently online on
the same account, not a persistent cloud clipboard. The Web page stores received
text in that device's local clipboard history and writes the OS clipboard when
the page is visible, focused, served over HTTPS, and the browser permits it;
otherwise it shows a click-to-copy prompt. Offline delivery is not queued, tool
success is not a browser acknowledgement, and payloads are capped at 256 KiB.
Depending on the agent's permission mode, the MCP tool may still require approval.

`very-happy spawn` and `very-happy send` are also available to self-hosters.
`spawn` requires the same-machine daemon; `send` requires access to the same
Happy home and session key. The standalone `very-happy mcp` command intentionally
does not expose spawn/send, terminal, preview, or provider-routing tools. See
[`channels.md`](channels.md) for the exact capability matrix.

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
