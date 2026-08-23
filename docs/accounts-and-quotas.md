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

Account capacity does not bound active sockets, messages, terminals, sessions,
files, RPC calls, or CPU. Public operators should configure the runtime limits
documented in [configuration.md](configuration.md), return stable 413/429 errors,
and keep a closed/read-only degradation path. Limits are safety controls, not a
promise of reserved resources or billing entitlement.

## Account recovery

There is currently no email password-reset flow or automatic identity merge.
Losing the only login method may make an account inaccessible. Self-hosters should
document their own operator-assisted recovery policy without asking users to send
passwords, tokens, or master secrets.
