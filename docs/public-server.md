# Public Cloud

`https://veryhappy.dev` is the maintainer-operated Very Happy instance and
the CLI's default target. It is useful for evaluation and ordinary use, but it is
not equivalent to self-hosting.

## Trust and service level

- The service is server-trusted. Its operator can recover account secrets, read
  relayed content, and exercise the account's remote-control path toward an
  online daemon.
- There is no paid SLA, guaranteed retention, or guaranteed support response.
- TLS protects traffic in transit; encrypted wire blobs do not prevent the
  application server from reading content.
- Connect only machines and repositories that fit this trust boundary.

## Registration and capacity

The operator can set registration to `open`, `invite`, or `closed`, and can set a
global account maximum. Reaching the maximum blocks only new accounts. Existing
password and Google identities continue to sign in. The signup page reports the
current state without exposing private account information.

Capacity is an operational safety valve, not a per-user entitlement. It does not
promise storage, terminal, message, or compute allocation. Abuse controls may
temporarily reject new sessions, machines, connections, or oversized requests.

## When to self-host

Self-host when you need to control server access, backups, retention, egress,
identity configuration, or uptime. Self-hosting moves the trust boundary to your
infrastructure; it does not turn this fork into E2E encryption.
