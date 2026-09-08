# CLI update recovery (B-385)

Status: Final

## Evidence and scope

The daemon currently overwrites `cliUpdate.autoUpdate` on every policy refresh,
so install failures disappear while the in-memory failed-version latch remains.
Busy skips publish no state. npm installs have no narrow EEXIST/partial-tree
recovery although `scripts/update-daemon.sh` already implements it.

## Design

Keep the existing optional `cliUpdate.autoUpdate` object, add states
`waiting_idle`, `disabled`, `current`, `unapproved` alongside installing,
installed and failed. Add optional `retrySupported: true` to CLI update state.
The daemon retains failed/installed state across policy refreshes for the same
approved target. A new `cli-update-retry` machine RPC accepts only the exact
currently failed, approved version. It clears the latch once, acknowledges
immediately, and schedules the existing idle-only path. RPC is idempotent while
pending/running; no automatic retry loop. Busy machines publish waiting_idle and
are reconsidered on the existing heartbeat (no extra network polling).

Share a bounded npm installer: resolve global prefix/root with argv-based npm,
unlink only own two bin symlinks after resolving exact paths under the verified
package root; never touch regular files/foreign links. After one EEXIST/ENOTEMPTY install failure (not network failure or timeout),
verify the preexisting package manifest identity and prefix/root relationship, then remove only the validated non-symlink `<npm root -g>/very-happy-cli` package tree,
then retry npm exactly once. Reject unexpected roots and symlinked package dirs.
All installation execution is mocked in tests. Existing daemon handover preflight
continues to verify the replacement; installed is not reported as running.

Web displays localized states and freshness/offline limitations. The retry button
requires explicit daemon `retrySupported`, a failed state and online presence.
Old/unknown daemons retain the pinned manual command and are never shown as
successfully upgraded based on a version threshold or an RPC acknowledgement.

## Compatibility

| Web | Daemon | Behavior |
|---|---|---|
| Old | New | Ignores additive capability; existing string state remains compatible |
| New | Old | No retry RPC, manual fixed-version command |
| New | New | State display and explicit one-shot retry |

No server/wire transport change: daemonState is existing opaque JSON and CLI
schema gains only an optional property. Deploy Web/server before the new CLI.

## Verification

Behavior tests: busy/disabled/failed/current state derivation; failure retention;
retry validates version and capability semantics; one retry under concurrency;
owned vs foreign symlinks; unexpected/symlink package root refusal; failed npm
gets at most two attempts. Web parser rejects malformed state and exposes no
retry for old/offline daemons. Full CLI and Web gates owned by integration agent.

## Implementation notes

`serialTask` releases the heartbeat guard on hold/early return and on errors;
previously a handover preflight hold returned before resetting the guard, so no
later heartbeat could retry it. Handover now rechecks idle both before and after
preflight, and never examines a partially written bundle during managed install.
No existing live session is killed to make an update eligible.

Unix recovery checks package.json name and the exact prefix/lib/node_modules
relationship. Both bins are validated before either is unlinked. A missing
manifest, foreign bin, linked package, or unusual npm layout requires manual
recovery rather than speculative deletion. Windows executes npm through cmd with
strictly allowlisted arguments but does not apply Unix symlink/tree repair.

Verified locally: 30 CLI update behavior tests (including build/typecheck), Web
recovery parser/RPC tests, Web typecheck, and 390px coarse-pointer Chromium layout
in both themes. Integration/full gates are owned by the parent release task.

## Review correction: single operation fence

Policy refresh, explicit retry validation, idle decisions and the complete
handover preflight/ownership-release sequence share one controller fence.
This closes two reproduced races: an idle tick resuming against a replaced
policy could install a revoked target; a preflight for one bundle could finish
after another install and hand over a different, unverified bundle. Busy RPCs
return immediately, and accepted retries still return before starting npm.
Handover preflight failures enter retained failed state with a hold reason and
can be explicitly retried against a freshly checked approved target.

Npm runs in its own Unix process group; deadlines terminate the whole group.
Windows uses a validated cmd invocation and taskkill /T for the owned process
subtree. If exit cannot be confirmed within the termination grace period, the
controller disables retries and handover, reports manual_required, and performs
no further package/link writes. This fence lasts for the running daemon process;
manual recovery must confirm the installer has exited before restarting it.
State/target/detail transitions are warning logs; unchanged policy refreshes are
debug logs while the latest state is still republished to keep status fresh.

Real macOS fault injection (temporary probe, no npm): a Node parent spawned a
grandchild inheriting stdout, both holding the pipe open. The 500ms deadline
returned in 513ms with terminationConfirmed=true; both PIDs were absent 200ms
later. Windows process-tree behavior is covered by mocked invocation tests, not
a local Windows host run.
