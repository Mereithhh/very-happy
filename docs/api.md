# API

This document covers the HTTP API surface and authentication flows. For WebSocket updates and event payloads, see `protocol.md`. For encryption boundaries and encoding details, see `encryption.md`.

## Method conventions
- **GET** is used for reads.
- **POST** is used for mutations or actions, even when the operation doesn't map cleanly to a single entity.
- **DELETE** is used when intent is unambiguous (e.g., removing a token or deleting a session/artifact).

We intentionally avoid the full REST verb palette because many operations span multiple entities or have non-CRUD semantics.

## Authentication
Most endpoints require `Authorization: Bearer <token>`.

Auth flows:
- `POST /v1/auth`
  - Body: `{ publicKey, challenge, signature, inviteCode? }` (base64 strings except invite code)
  - Verifies signature using the provided public key.
  - Finds or creates an account by public key and returns `{ success, token }`; new Accounts obey signup mode/capacity.

- `GET /v1/auth/config`
  - Public Web auth configuration: Google client ID (when enabled), signup mode, and current Account capacity.

- `POST /v1/account/credentials` (requires Bearer auth)
  - Attaches/replaces a normalized username and scrypt password on the current Account and returns a revocable Web login token.

- `POST /v1/account/login`
  - Password login. Returns `{ token, secret, expiresAt }`.

- `POST /v1/auth/google/challenge`
  - Requires a browser `Origin` listed in `GOOGLE_ALLOWED_ORIGINS` and returns `{ nonce, expiresAt }`.
  - The nonce expires after five minutes, is stored only as a SHA-256 digest, and can be consumed once.

- `POST /v1/account/login/google`
  - Body: `{ credential, nonce, inviteCode? }`, where `credential` is a Google Identity Services ID token initialized with that nonce.
  - Requires an allowed browser `Origin`; verifies the Google signature/claims and nonce, then atomically consumes the challenge.
  - An unknown Google subject creates an Account subject to signup mode/capacity.

- `GET /v1/account/identities` (requires Bearer auth)
  - Reports whether Email, Google, and password login methods belong to the current Account.

- `POST /v1/account/identities/email` (requires Bearer auth)
  - Body: `{ email, challengeId, code, secret }`.
  - Requires a login session created within the last 10 minutes and a `secret` that derives the current Account public key. The OTP and insert commit in one transaction.
  - Returns 400 invalid secret, 401 invalid/consumed code, 403 reauthentication required, 409 identity conflict, 429 rate limit, or 501 provider unavailable.

- `POST /v1/account/identities/google` (requires Bearer auth)
  - Body: `{ credential, nonce, secret }`; the browser `Origin` must be in `GOOGLE_ALLOWED_ORIGINS`.
  - Requires a login session created within the last 10 minutes, account-key proof, a verified Google ID token bound to `nonce`, and an unconsumed five-minute challenge. Nonce consumption and insert commit in one transaction.
  - Never merges or moves identities by matching an Email address.
  - Returns 400 invalid secret, 401 invalid token/nonce, 403 reauthentication or Origin rejection, 409 identity conflict, 429 rate limit, or 501 provider unavailable.

- `POST /v1/account/logout` (requires Bearer auth)
  - Revokes the current Web login session. Legacy CLI/daemon tokens remain compatible and are not session-managed.

- `POST /v1/auth/request`
  - Body: `{ publicKey, supportsV2? }`
  - Creates or returns a terminal auth request.
  - Response: `{ state: "requested" }` or `{ state: "authorized", token, response }`.

- `GET /v1/auth/request/status?publicKey=...`
  - Response: `{ status: "not_found" | "pending" | "authorized", supportsV2 }`.

- `POST /v1/auth/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)
  - Approves a terminal auth request.

- `POST /v1/auth/account/request`
  - Body: `{ publicKey }`
  - Similar to terminal auth, but for account linking.

- `POST /v1/auth/account/response`
  - Body: `{ response, publicKey }` (requires Bearer auth)

## Endpoint catalog
### Sessions
- `GET /v1/sessions`
- `GET /v2/sessions/active?limit=...`
- `GET /v2/sessions?cursor=cursor_v1_<id>&limit=...&changedSince=...`
- `POST /v1/sessions` (create or load by `tag`)
- `GET /v1/sessions/:sessionId/messages`
- `DELETE /v1/sessions/:sessionId`

### Machines
- `POST /v1/machines` (create or load by id)
- `GET /v1/machines`
- `GET /v1/machines/:id`

### Artifacts
- `GET /v1/artifacts`
- `GET /v1/artifacts/:id`
- `POST /v1/artifacts`
- `POST /v1/artifacts/:id` (versioned update)
- `DELETE /v1/artifacts/:id`

### Access keys
- `GET /v1/access-keys/:sessionId/:machineId`
- `POST /v1/access-keys/:sessionId/:machineId`
- `PUT /v1/access-keys/:sessionId/:machineId`

### Key-value store
- `GET /v1/kv/:key`
- `GET /v1/kv?prefix=...&limit=...`
- `POST /v1/kv/bulk`
- `POST /v1/kv` (batch mutate)

### Account and usage
- `GET /v1/account/profile`
- `GET /v1/account/settings`
- `POST /v1/account/settings`
- `POST /v1/usage/query`

### Push tokens
- `POST /v1/push-tokens`
- `DELETE /v1/push-tokens/:token`
- `GET /v1/push-tokens`

### Connect (GitHub + vendor tokens)
- `GET /v1/connect/github/params`
- `GET /v1/connect/github/callback`
- `POST /v1/connect/github/webhook`
- `DELETE /v1/connect/github`
- `POST /v1/connect/:vendor/register` (`vendor` in `openai | anthropic | gemini`)
- `GET /v1/connect/:vendor/token`
- `DELETE /v1/connect/:vendor`
- `GET /v1/connect/tokens`

### Users, friends, feed
- `GET /v1/user/:id`
- `GET /v1/user/search?query=...`
- `POST /v1/friends/add`
- `POST /v1/friends/remove`
- `GET /v1/friends`
- `GET /v1/feed`

### Version and voice
- `POST /v1/version`
- `POST /v1/voice/token`

### Dev-only
- `POST /logs-combined-from-cli-and-mobile-for-simple-ai-debugging` (only if enabled)

## Implementation references
- API routes: `packages/happy-server/sources/app/api/routes`
- Auth module: `packages/happy-server/sources/app/auth/auth.ts`
