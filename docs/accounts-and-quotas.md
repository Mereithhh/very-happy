# Accounts and quotas

An Account can have password and/or Google login identities. Matching email
addresses are not automatically merged; the verified provider subject is the
identity key. Web login sessions expire and can be revoked. Legacy CLI tokens are
kept for compatibility and should be treated as account-wide bearer credentials.
Password/username changes replace the account's prior password identity (Google
identity is preserved), are database-rate-limited per account, and revoke the
older Web sessions. Expired/revoked Web session rows are physically pruned; a
bounded active-session set evicts the oldest session before issuing a new one, so
the token returned by a successful login remains valid.

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

There is currently no email password-reset flow or automatic identity merge.
Losing the only login method may make an account inaccessible. Self-hosters should
document their own operator-assisted recovery policy without asking users to send
passwords, tokens, or master secrets.
