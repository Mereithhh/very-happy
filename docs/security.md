# Security and privacy model

## The honest boundary

Very Happy is **server-trusted, not end-to-end encrypted or zero-knowledge**.
An operator—or an attacker with control of the server, database plus master
secret, deployment environment, or backups—can recover account secrets, read
relayed content, impersonate Web access, and interact with online machines within
the daemon's remote-control capabilities.

TLS, encrypted wire envelopes, hashed passwords, encrypted account secrets, and
hashed login-session tokens are valuable layers. None remove the server operator
from the trust boundary.

## Data handled

Depending on use, the relay stores or processes account identities, password
verifiers, Google subject/email/profile claims, login sessions, machine/session
metadata, encrypted message/artifact blobs, uploaded files, push subscriptions,
webhook URLs, and operational logs/metrics. Do not put bearer tokens, raw request
bodies, session content, email addresses, or IP addresses in metric labels.

## Remote execution

Approving a machine links an account to a daemon that can run agents and terminal
commands under the daemon's OS user. Treat an account token, pairing link, server
master secret, and server administrator access as high impact. Approve only
requests you initiated, use short-lived links, and remove access when a machine
or account is no longer trusted.

## Operator checklist

- Use HTTPS; protect the master secret and backups; keep metrics private.
- Configure exact proxy trust, OAuth origins, signup mode, capacity, and runtime
  abuse limits.
- Keep public PR code off private runners and production networks.
- Restrict outbound webhook egress to public destinations.
- Monitor auth rejection, capacity, connection, process-memory, and error rates.
- Upgrade promptly and rehearse rollback without destructive down migrations.

For vulnerability reports, follow the root [security policy](../SECURITY.md).
