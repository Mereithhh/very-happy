# Very Happy Privacy Notice

**Last updated: August 24, 2026**

This notice describes the maintainer-operated service at
`https://happy.mereith.com`. A self-hosted operator controls their own deployment
and must provide a notice appropriate to their use.

## Trust model

Very Happy uses a **server-trusted architecture**. It is not end-to-end
encrypted, zero-knowledge, or a blind relay. Although the product uses TLS,
encrypted wire envelopes, password hashing, and encryption at rest for selected
records, the server can recover account secrets, issue login tokens, access
relayed session content and files, and send requests to capabilities exposed by
an online daemon. A server operator—or an attacker controlling the server,
database and master secret, deployment environment, or backups—must therefore be
inside your trust boundary.

Do not connect a machine or send content that you are unwilling to expose to the
operator of the chosen relay. Self-hosting changes who operates this boundary;
it does not make the design end-to-end encrypted.

## Data handled

Depending on the features you use, the service may process or store:

- account username, password verifier, and login-session records;
- Google subject identifier, email address, name, and profile image when Google
  sign-in is used;
- machine and session identifiers, metadata, messages, terminal streams,
  artifacts, uploaded files, task-board data, and notification state;
- pairing requests, daemon connectivity, IP address, user agent, timestamps,
  rate-limit state, and operational logs or metrics;
- push subscription details, webhook destinations, OAuth configuration, or
  connected-provider tokens when those optional features are enabled.

Provider credentials normally remain in the provider's local configuration on
the daemon machine. Optional connection features may store provider tokens on
the relay; consult the configuration before enabling them.

## Why data is used

Data is used to authenticate accounts, pair machines, route browser/daemon
traffic, synchronize sessions and files, enforce signup and abuse limits,
deliver enabled integrations, diagnose failures, and protect the service.
Public Cloud capacity is limited and offered without an uptime SLA.

## Sharing and subprocessors

Data is sent to infrastructure and providers needed for features you choose,
such as the hosting platform, Google sign-in, an AI provider, push delivery, or
an explicitly configured webhook. We do not claim that notification or webhook
content is device-to-device only. Do not configure destinations you do not
trust. Legal process, security response, or protection of users and the service
may also require disclosure.

## Retention and deletion

Operational records are retained as needed to run, secure, back up, and recover
the service. Deleting an account or record from the live database may not remove
it immediately from logs or backups. The project does not promise a fixed
deletion deadline unless the operator publishes one separately. Self-hosted
operators define and implement their own retention and backup policy.

## Security and your choices

- Use HTTPS and approve only pairing requests you initiated.
- Treat relay administration, account tokens, pairing links, the server master
  secret, and the daemon OS user as high-impact access.
- Use a separate CLI home for each relay and remove access from machines you no
  longer trust.
- Prefer self-hosting for sensitive work and restrict the daemon user's local
  permissions.

You may stop using the service, delete data through available product controls,
or contact the operator about access or deletion requests. Some requests may
require identity verification and may be limited by legal or operational
obligations.

## Changes and contact

This notice may change as the product and deployment change. Material changes
will be reflected by the date above. For privacy questions or security reports,
use the repository's [issue tracker](https://github.com/Mereithhh/very-happy/issues)
and [security](SECURITY.md) channels;
do not include secrets or private session content in a public issue.

The concise product-specific security model is documented in
[`docs/security.md`](docs/security.md).
