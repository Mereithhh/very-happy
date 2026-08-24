# Troubleshooting

## The machine does not appear

```bash
very-happy auth status
very-happy daemon status
very-happy --version
```

Confirm the CLI and browser use the same server URL and account. If the approval
link expired or says not found, run `very-happy auth login` again. Do not reuse or
forward an old link. The daemon's OS user needs the provider credentials and PATH
for the agent path you choose. Structured Claude uses the bundled Agent SDK and
does not require an external `claude` command; the native Claude TUI and optional
terminal mirror do.

## The machine appears offline

Check the newest file under `$HAPPY_HOME_DIR/logs` (default `~/.happy/logs`).
Restart only the exact daemon/home you identified. Do not delete all of
`~/.happy`; it contains credentials and session state.

## Signup fails

- `capacity-reached`: the instance is not accepting another account; existing
  users can still sign in.
- `signup-closed`: registration is disabled.
- `invite-required`: obtain a code from that instance's operator.
- `rate-limited`: wait and retry; do not automate around the limit.
- network/server unavailable: check `/health` and the configured server URL.

Google login also requires the browser origin to match the server and Google Web
OAuth configuration exactly.

## The Web app looks mixed or an asset is HTML

Hard refresh and unregister the service worker. Operators must restart the server
after swapping the Web tree, then verify the main asset's `Content-Type` is
JavaScript. Do not leave an HTML response cached at a hashed asset URL.

## A session or terminal cannot start

Verify the machine is online, the directory exists under the daemon user, and the
CLI version supports the requested feature. Use a disposable directory/session
for diagnostics; never test by deleting existing production sessions.

## Reporting a bug

Include versions, platform, exact command, expected/actual behavior, and redacted
logs. Remove tokens, cookies, OAuth data, usernames, email, absolute private paths,
session content, and secrets before posting publicly.
