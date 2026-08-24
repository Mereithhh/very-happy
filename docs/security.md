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

Terminal file handoff is relay traffic, not a private side channel. Pasting a
clipboard image/file or dropping a file into a Web terminal transfers up to
8 MB through the trusted relay and stages it on the selected machine under
`~/.happy/uploads/terminal/`. The client inserts only a path quoted for the
daemon's default shell at the cursor and does not press Enter, open, or execute
the file. Native Windows needs a current daemon to declare cmd versus
PowerShell; the Web client refuses ambiguous automatic insertion. Treat transferred
files as untrusted input and use only a relay operator you trust with their
contents.

## Remote execution

Approving a machine links an account to a daemon that can run agents and terminal
commands under the daemon's OS user. Treat an account token, pairing link, server
master secret, and server administrator access as high impact. Approve only
requests you initiated, use short-lived links, and remove access when a machine
or account is no longer trusted.

Fresh Web devices start sessions in review-first modes; direct CLI sessions
without an explicit mode use the agent's approval-oriented `default`, not YOLO.
Devices that already saved Very Happy settings retain their previous auto-apply
preference for compatibility. Check **Settings → Agents → New sessions** on
every device. `yolo`, `bypassPermissions`, and
`--dangerously-skip-permissions` allow the agent to act without normal approval
and should be treated as full remote execution under the daemon OS user. See
[Permission resolution](permission-resolution.md).

## Operator checklist

- Use HTTPS; protect the master secret and backups; keep metrics private.
- Configure exact proxy trust, OAuth origins, signup mode, capacity, and runtime
  abuse limits.
- Keep public PR code off private runners and production networks.
- Restrict outbound webhook egress to public destinations.
- Monitor auth rejection, capacity, connection, process-memory, and error rates.
- Upgrade promptly and rehearse rollback without destructive down migrations.

For vulnerability reports, follow the root [security policy](../SECURITY.md).
