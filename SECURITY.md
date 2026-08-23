# Security policy

## Supported versions

Security fixes target the current `main` branch and the latest published
`very-happy-cli` release. Older server deployments and CLI versions may not
receive fixes; upgrade before reporting behavior already corrected on `main`.

The legacy Expo `packages/happy-app` is unsupported and must not be used as the
production client for this fork.

## Report a vulnerability

Use GitHub's **Security → Report a vulnerability** private reporting flow for
this repository. Include affected versions, impact, a minimal reproduction, and
suggested mitigations. Do not open a public issue, attach real session data, or
send working credentials. If private reporting is unavailable, open a public
issue containing only a request for a private contact channel.

Please allow maintainers time to reproduce and coordinate a fix before public
disclosure. We will credit reporters who want attribution.

## High-impact areas

Reports involving account takeover, pairing-token theft, cross-account access,
remote command execution, server-side request forgery, authentication bypass,
secret/log leakage, or public CI access to private infrastructure are especially
important.

## Security model is not a vulnerability

Very Happy is intentionally server-trusted. The operator can recover account
secrets, read relayed content, and act toward connected daemons. A report that
only restates this documented boundary is not an implementation vulnerability;
a way to cross accounts, bypass authorization, or escape configured limits is.
