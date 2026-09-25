# CLI update recovery (B-385)

Status: Shipped — implementation in PR #279; production deployment is separate.

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

Online machines retain manual_required instructions even when the approved-version policy expires: the installer fence deliberately stops policy refresh. Offline status still indicates that the displayed state is not live.

## Explicit update before automatic rollout (B-442)

Status: Shipped 2026-09-10. Web c628adf41 (PR #334), CLI 0.2.133 at b245843a3 (PR #335 fixes release-scanner field layout).

The pending-rollout notice keeps waiting for automatic delivery as the recommended
choice and adds a manual action for the displayed machine and exact version.
`cli-update-request { version }` is an authenticated machine RPC; it re-fetches
relay policy and accepts only the current recommended version, newer than the
running CLI and not below the minimum. It acknowledges scheduling, not installation.
It shares the existing controller fence, idle check, bounded installer and handover
preflight. It never kills sessions or changes `CLI_AUTO_UPDATE_VERSION` / settings.
An explicit request may run when unattended installation is disabled.

Add optional `manualUpdateSupported` and `autoUpdate.source: 'manual'` to daemon
state. The exact manual intent lives in this daemon controller; restart cancels an
unstarted request. Policy changes revoke it rather than selecting another version.
Failed manual installs remain failed until a matching explicit retry/request;
installer termination uncertainty still requires manual recovery. Duplicate requests
while waiting/installing/installed cannot schedule another install.

Compatibility: new Web checks the reported capability, never a version threshold.
Old daemons expose a pinned copyable install command with a clear explanation,
not a nonfunctional one-click RPC. Old Web ignores additive fields. Deploy Web
before CLI; no server or wire schema change is needed for opaque daemon state.
Tests cover fresh policy, invalid/stale/mismatched versions, disabled unattended
updates, busy wait, duplicate/concurrent requests, revocation, failure/retry,
blocked installer and handover exclusion; browser covers pending recommendation,
manual acknowledgement/failure and legacy command in both themes/mobile sizes.

Release evidence: Web deploy 34425148876 serves the exact c628adf41 entry and all
52 reachable assets; health, 24 public-page checks and six real-component layouts
using production CSS passed. CLI publish/promote 34425626732 and push smoke
34425626730 attempt 1 use tag v0.2.133 / b245843a3; all six Linux/macOS/Windows ×
Node 20/24 jobs passed. npm latest is 0.2.133. mac-office runs 0.2.133 under
launchd, advertises `manualUpdateSupported`, rejects an invalid version through
the new authenticated RPC, and answers the read-only terminal-list RPC. The terminal-list response contains three terminals. Auto-install approval remains 0.2.132; recommending or
manually requesting a version does not change it. Rollback: Web 8e8c03f0e,
CLI 0.2.132. All local gates passed: wire 82, Web 2755, CLI 2103, server 647
(one existing skip), required builds/typechecks and executable version smoke.

## Idle means "no turn in flight" (B-466, 2026-09-14)

The install and handover gates required no session wrapper and no live web
terminal. A machine whose owner keeps web terminals open is never idle by that
rule and never updates (five machines still on 0.2.129 twelve days after
0.2.134). Owner decision 2026-09-14: wait only for an agent turn in flight;
terminals live in tmux and idle wrappers survive a handover, so neither holds
an update.

Mechanism (`update/turnActivity.ts`): every wrapper's `ApiSessionClient.keepAlive`
feeds a `TurnReporter` that POSTs `turn_started` on the rising edge of
`thinking` (renewed every 60 s while it stays up) and `turn_ended` on the
falling edge to the daemon's `/session-event`. The daemon's
`TurnActivityTracker` marks a session busy until `turn_ended`, the wrapper's
exit, or 150 s without renewal — a lost `turn_ended` cannot pin a machine on an
old version. `idle()` for the controller and both handover checks are
`!turnActivity.hasActiveTurn()`; `teamWorker.busy` and a running installer
still hold. Wrappers started by an older CLI never report and therefore never
count as busy. Old daemons reject the new event values with 400, which the
wrapper ignores.

## Release recommendation convergence (B-443)

The old publish check returned success even with a stale recommendation; the
relay cached npm latest for one hour. After six smoke jobs pass and promotion
succeeds, the release now waits up to ten minutes for npm latest and the public
relay recommendation to equal the exact release. The relay refreshes its shared,
in-flight-deduplicated registry cache after one minute; failed lookups retain
the last good value with the existing five-minute backoff. HTTP policy caching
is limited to one minute. No timer or extra endpoint is introduced.

A mismatching explicit pin fails verification with a hold explanation, without
overwriting configuration. Unavailable/stale/network responses retry within the
bound; timeout fails the release job after publication (npm artifacts and latest
are not rolled back). Rerunning is idempotent. The independent auto-install
variable is not edited by CI; since B-503 production sets it to `latest`, so it
follows the promoted tag by resolution rather than by an env edit. Existing clients and response schema remain compatible; deploy
server/Web before relying on the new publish check.

Verification: release-check behavior tests cover stale policy, registry mismatch,
explicit hold, unavailable service, network recovery, idempotency and invalid
versions; provider tests prove refresh at 60 seconds and unchanged installation
approval. Full wire/Web/CLI/server gates pass (82/2755/2103/648 tests; one existing
server skip). Real Chromium checks at 1280/760/390/320px in both themes confirm
8px internal status spacing, unchanged transcript/composer alignment, single-row
height, no overflow, working details, streaming follow and preserved scrollback.

## Install into the running copy (B-489, 2026-09-24)

Evidence: a SageMaker dev machine ran the daemon from
`~/.local/lib/node_modules/very-happy-cli` (0.2.144) while the `npm` on the
daemon's PATH was conda's (`npm prefix -g` = `/opt/conda`). Automatic installs of
0.2.148 and 0.2.149 exited 0 into `/opt/conda`, were reported `installed`, and the
daemon stayed on 0.2.144 for two days: the bundle it watches never changed, and
`installed` is terminal, so the Web kept saying "no manual action needed".

Design:

- The daemon installs into the prefix of the package it runs from
  (`projectPath()`), accepted only in the standard
  `<prefix>/lib/node_modules/very-happy-cli` layout with an allowlisted path.
  `npm root -g`, `npm prefix -g` and `npm i -g` all carry `--prefix=<that>`, and
  the resolved package dir must equal the running one. npm's own default prefix
  is never trusted.
- Unrecognised layout, symlinked package, unreadable manifest → `manual_required`
  `install_location_unverified`; unwritable `lib/node_modules`, package dir or
  `bin` → `install_location_not_writable`. No npm runs and nothing is mutated, so
  unlike `installer_termination_unconfirmed` the controller fence stays open; the
  state is terminal for that target (a newer approved target is evaluated again).
- After npm exits 0 the running package's `package.json` version must equal the
  target, else `failed` / `installed_elsewhere` (retry stays available). Windows
  keeps npm's layout but gets the same post-install check.
- Web: `failed/installed_elsewhere` and `manual_required/install_location_*` are
  `attention` with readable copy. For OLD daemons, which can only say
  `installed`, the Web treats `installed` whose `at` is older than 30 minutes while
  `currentVersion` is still below it as `installed_not_running` (`attention`).
  The handover waits for no agent turn in flight, so the copy names that as the
  other possible cause. The copied command for these two problems installs into
  the prefix of the `very-happy` the shell resolves:
  `P=$(readlink -f "$(command -v very-happy)") && npm install -g --prefix "${P%/lib/node_modules/very-happy-cli/*}" …`.
- `doctor` / `daemon status` warn when PATH holds several very-happy installs,
  when the shell command resolves to a different copy than the running CLI, or
  when `npm prefix -g` differs from the running prefix (with the `--prefix`
  command).

Compatibility: additive detail strings in existing opaque daemon state; old Web
shows them through the existing generic `failed` / `manual_required` paths. No
server or wire change. Deploy order does not matter; the Web half is what reaches
machines already stuck, because they cannot receive the CLI half automatically.

Not covered: machines already stuck need one manual update (the Web now says so);
installs where the running copy's prefix is not writable need a person; the extra
copy left in the other npm tree is only warned about by `doctor`.
