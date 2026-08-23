# Accounts and quotas

An Account can have password and/or Google login identities. Matching email
addresses are not automatically merged; the verified provider subject is the
identity key. Web login sessions expire and can be revoked. Legacy CLI tokens are
kept for compatibility and should be treated as account-wide bearer credentials.

## Signup policy

- `open`: anyone may create an account until capacity is reached.
- `invite`: a configured invite code is required for a new account.
- `closed`: no new accounts.
- `SIGNUP_MAX_ACCOUNTS`: global maximum; existing accounts still sign in.

The policy applies only to account creation, not existing identity login.

## Operational limits

Account capacity is separate from the default machine, session, message and
attachment hard caps documented in [configuration.md](configuration.md). Message
and upload ingress also uses database-backed account buckets across replicas;
socket/RPC caps are extra best-effort backstops. A client can receive 413/429 when
one of these boundaries is reached. Deleting a session releases its message and
attachment reservations. Limits are safety controls, not a promise of reserved
resources or billing entitlement; operators still need disk monitoring and a
closed/read-only degradation path.

## Account recovery

There is currently no email password-reset flow or automatic identity merge.
Losing the only login method may make an account inaccessible. Self-hosters should
document their own operator-assisted recovery policy without asking users to send
passwords, tokens, or master secrets.
