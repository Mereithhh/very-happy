# Accounts and quotas

An Account can have email-code, password, and/or Google login identities.
Matching email strings across different providers are not automatically merged;
the verified provider subject is the
identity key. Web login sessions expire and can be revoked. Legacy CLI tokens are
kept for compatibility and should be treated as account-wide bearer credentials.
Password/username changes replace the account's prior password identity (email
and Google identities are preserved), are database-rate-limited per account, and revoke the
older Web sessions. Expired/revoked Web session rows are physically pruned; a
bounded active-session set evicts the oldest session before issuing a new one, so
the token returned by a successful login remains valid.

## Link email to an existing account

If you already use password or Google login, sign in with that existing method
first. Then open **Settings → Account → Email sign-in**, request a code, and
verify the address. Do this before trying Email login. On an open-signup relay,
using an unlinked address at the login screen can create a separate Account;
matching the address on Google does not merge it. Linking requires a login from
the last 10 minutes, so the UI may ask you to sign out, sign in again, and
request a new code. Reauthenticate with a method already linked to the current
Account; do not use the new Email address until linking succeeds.

## Link Google to an existing account

Sign in with the existing account first, then open **Settings → Account → Google
sign-in** and choose the Google account to link. Do this before using the Google
button on the public login page. Matching Email addresses never merge accounts;
the explicit link requires a login from the last 10 minutes and proof of the
current account key. A Google identity already owned by another Account is left
unchanged and returns a conflict. If reauthentication is required, use an
already-linked method for the current Account—not the Google identity being
added—then return to the link screen.
The selected Google identity cannot currently be changed or unlinked in the Web
UI, so confirm the account in Google's chooser before continuing. An operator
can resolve a mistaken link only after verifying ownership and a safe fallback
login method; never edit ownership by matching Email strings.

## Generic OIDC login

A server can offer "Continue with <provider>" for any OpenID Connect provider
(`OIDC_ISSUER` + `OIDC_CLIENT_ID`, see [deployment.md](deployment.md)). The Web
client asks the server for an authorization URL (`POST /v1/auth/oidc/start`),
the browser visits the provider, and the provider returns to
`GET /v1/auth/oidc/callback`, which exchanges the code (PKCE) and redirects the
browser to `/login/oidc?handoff=<one-time code>`. The Web client then calls
`POST /v1/auth/oidc/complete` to receive the login token and account secret; the
handoff expires after two minutes and works once. The identity key is
`oidc:<issuer>` + the provider's `sub`; email strings never merge accounts. A
first login creates an Account under the usual signup policy (invite code
accepted on the signup page) unless the server sets `OIDC_SIGNUP_MODE`, which
replaces `SIGNUP_MODE` for SSO first logins only (`open` = the provider plus
`OIDC_ALLOWED_EMAIL_DOMAINS` vouch for the person, no code; the signup page then
leads with the SSO button and says only the other methods need a code). The
account's first/last name come from the token's `name` (split at the first
space; a single-token name stays whole), and `preferred_username` becomes the
handle when it is free. With `OIDC_LINK_BY_EMAIL=verified` (B-626, off by
default) a first SSO login whose token says `email_verified: true` attaches the
`oidc:<issuer>`+`sub` identity to the account that already owns that email
through an Email-OTP or Google identity (both provider-verified; password
identities carry no email), so the person keeps their sessions, machines and
contacts; the link happens inside the signup gate's transaction and counts as a
login, not a signup. Unverified emails, unknown emails and key-only accounts
without a stored secret fall through to the normal first-login path. When two
accounts own the same email the callback returns `account_link_ambiguous` and the
person signs in with the old method. Linking an OIDC identity from inside an
existing session is still not available. When a relay is being retired
(B-627, `MIGRATION_*` in [deployment.md](deployment.md)), the old relay's
banner carries a signed ticket for the person's account to the new relay's
`/login/migrate`; `POST /v1/auth/oidc/start` accepts it as `migrationHandoff`
and the callback attaches the SSO identity to that account instead of
creating one (or moves it off an empty account the subject made meanwhile).

## Profile handle and People

Every account has an optional public **handle** (`Account.username`): what
colleagues type into People search and the share dialog. It is separate from a
password account's login username, which keeps working unchanged; a password
sign-up seeds the handle from the login username when it is free (existing rows
were backfilled once). Lookups for sharing and friend requests accept a handle,
a login username or an exact verified email — never a prefix. **Settings →
Account → Name & handle** edits the display name and handle (handle rules:
lowercase letters, digits, `.`, `-`, `_`; 3–64 characters; unique across both
handles and login usernames). People (sidebar) lists friends and requests;
friends appear as one-tap chips in the share dialog, but sharing never requires
friendship.

## Signup policy

- `open`: anyone may create an account until capacity is reached.
- `invite`: a configured invite code is required for a new account.
- `closed`: no new accounts.
- `SIGNUP_MAX_ACCOUNTS`: global maximum; existing accounts still sign in.

The policy applies only to account creation, not existing identity login.

## Operational limits

Account capacity is separate from the default machine, session, message,
state, synchronized-settings, attachment, access-key, artifact, feed, KV, push-token, and usage-report caps documented in
[configuration.md](configuration.md). Their persistent write paths use
database-backed account locks and shared rate buckets across replicas and across
HTTP/Socket.IO entry points; socket/RPC caps are extra best-effort backstops.

- 400 means an individual field or batch shape is invalid; shortening a key or
  payload is actionable.
- 413 with a stable `*_bytes_quota_exceeded` error means the account's stored-byte
  cap is full.
- 429 with `*_count_quota_exceeded` or `*_rate_quota_exceeded` distinguishes
  persistent capacity from a one-minute write burst.

Existing access-key/artifact/KV updates are charged by their byte delta, and
exact access-key create retries, message local IDs, push tokens, and usage-report
keys do not consume another count slot. New access-key envelopes must be canonical
base64 and decode to no more than 4096 bytes; their account byte cap measures the
encoded UTF-8 data stored. Deleting a session releases its messages, attachment
reservations, and associated access keys;
deleting an artifact releases its count and bytes. A KV delete is a synchronized
tombstone: it releases the value bytes but deliberately retains the row, key
bytes, and count slot. Limits are safety controls, not a promise of reserved
resources or billing entitlement; operators still need disk monitoring and a
closed/read-only degradation path.

Session and machine metadata/state updates are full encrypted-envelope CAS
writes. Metadata is capped at 262144 stored UTF-8 bytes and state at 524288;
account byte totals are charged by delta, and rate budgets charge one unit per
started 65536 bytes. Feed repeat keys update one row in place, while null/new
keys consume a count slot. Attachment upload URLs reserve both one uploaded-file
row and the declared bytes; an uncompleted reservation and its object are
reclaimed after the configured TTL (60 minutes by default).

Unauthenticated CLI/account pairing requests have a short logical TTL and a
shared database rate limiter. Creation also takes a cross-replica database lock,
physically removes expired rows from both pairing tables, and enforces one global
outstanding-request cap. Reaching it returns `429 pairing-capacity`; retry after
older requests expire rather than raising the limit blindly.

## Account recovery

Email-code login is passwordless; there is no email-based password-reset or
automatic identity merge.
Losing the only login method may make an account inaccessible. Self-hosters should
document their own operator-assisted recovery policy without asking users to send
passwords, tokens, or master secrets.
