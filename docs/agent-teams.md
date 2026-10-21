# Very Happy Teams

Give a coding agent a goal and let it organize a team. A lead can delegate
independent tasks to Claude Code, Codex, or pi teammates, follow their progress,
and bring their results back for review. Teammates can delegate child tasks within
their own assignments. You can inspect any member conversation along the way.

![Very Happy Teams: goal, lead, parallel teammates, and reviewed results](../packages/happy-web-v2/public/architecture/agent-teams.svg)

Teams is optional. Ordinary conversations, terminals, and history keep working as
before. Each team currently uses one account and one execution computer; automatic
cross-machine routing is not available.

## Prerequisites

- The operator enables `VH_AGENT_TEAMS_ENABLED=true`; every account on that
  server can then use Teams (B-502 removed the per-account allowlist). Each
  account may hold 32 non-archived teams.
- The selected machine runs a compatible, online daemon advertising Teams
  capability. Update the CLI and hand over with `very-happy daemon start`; start
  a new managed session to use the new runner tools. Existing wrappers are not
  upgraded in place.
- Configure each coding agent's normal credentials. Teams does not grant provider access.
  Owners choose approval behavior in the team execution settings.
- Use a Git checkout for automatic isolated worktrees. Preserve and integrate
  changes before cleanup; a worktree with uncommitted files or commits that are
  not pushed or merged is intentionally retained.

An unavailable/disabled server reports that state. An old daemon cannot receive a
Teams delegation; it does not fall back to Claude or the legacy assistant.

## Start a team in the app

Choose **Teams → New team**, select the working folder and execution computer,
and describe the goal. The team goes into a new project with its name unless you
pick an existing project or *No project*; the project's instructions and log are
the team's shared context (see [Projects](projects.md#teams-and-projects)). A compatible daemon starts a managed lead in an isolated
worktree, supplies the official skill, and opens the lead conversation. App users
do not install skills manually. The lead lives for this goal; after acceptance its
session can be cleaned up, while unmerged changes remain preserved.

Team names appear alongside ordinary conversations in history. Select a team's
name to chat with its lead (a team whose lead has no conversation yet opens its
board); the row shows the lead's status. The chevron (or → / ←) expands the
member list without navigating, and the board icon at the end of the row — or
**Open board** in its right-click / long-press menu — opens goal, progress, and
results.
Members no longer in use fold into one **N inactive** row, both under the expanded
team in the sidebar and in the team page's member list; open it to reach their
history (this device remembers the choice, shared by both places). A member is
inactive when nothing is assigned to it (no queued, running or submitted task) and
its conversation is archived, it has stopped or exited, or it has had no activity
for 7 days. Member counts leave inactive members out; the lead never folds, and a
member whose cleanup has not finished shows **Cleanup needs attention** instead.
Inactive members can still receive work through **Transfer to** in task details.
Every conversation a team has had stays under that team in all three sidebar
groupings: the lead, sub-members, adopted leads and each earlier session of a
reused member. Earlier sessions fold into the **N inactive** row. Membership comes
only from the team's own records (live bindings, launch receipts and rebind
history), never from titles or folders. A conversation that leads two teams, such
as a lead that created a second team, sits under the newer one; the other team's
row still opens it.
Ordinary conversations are never automatically turned into teams. Appearance
settings can hide the Teams entry without stopping or deleting existing work.

A team can belong to a [project](projects.md): on the project page open
**Project settings → Teams** and attach it (only teams whose computer has one of
the project's folders are offered). The team's sessions are then listed as
project members, and the team appears in the project's sidebar group. Team members get the project instructions as background and
coordinate through their lead rather than messaging other project sessions.

For an existing managed conversation, use **More → Start a team from this
conversation**. Its wrapper establishes the scoped connection and delivers the
collaboration instructions in the background. No session ID entry or additional
join step is required. Old wrappers without the capability need a new session.

A member whose task was accepted or cancelled and whose cleanup finished is
**inactive**: it no longer counts as a member, its tasks and sessions stay
readable, and a new delegation with the same agent, model and folder reuses it
instead of adding another member. Delegating to a member that is still being
cleaned up queues the task; it starts once the cleanup completes. Delegating to an
inactive member by name reactivates it in a fresh session and worktree. The
member limit (32) counts active members only.

Team options choose the default agent/model for new assignments and the maximum
number of concurrently progressing leaf tasks. The harness select lists only the
harnesses the team's computer can run (Claude Code, Codex, pi; Gemini is not a
team harness yet), and the default model is a select built from that harness's
models on the computer — the bundled list, models published by pi sessions, and
the computer's custom models (**Settings → Models & providers**) — with
"Follow the harness default" first. Switching the harness resets the model; a
saved model that is no longer listed stays selected and is flagged. When the lead
delegates without `assistant`/`model`, the new member uses these defaults; the
new-team form's harness and model become the first defaults. A parent waiting for unfinished
children yields its slot; this is a work limit, not an OS-process limit. Running
members keep their original model configuration. The current team still uses one
execution computer.

Use a distinct request ID per action and reuse it with identical arguments after
an unknown outcome. Never copy scope tokens into prompts or personal settings.

## Optional: start from a terminal

```sh
very-happy teams install --host claude
# Inspect the reported destination and action, then apply:
very-happy teams install --host claude --apply
# --host codex and --host pi expose the same shared method.
```

All hosts use the one Very Happy-owned skill at
`~/.local/share/very-happy/skills/very-happy-teams/SKILL.md`. The command returns
its absolute path. Ask your managed coding agent to read that path. Installation
does not edit host discovery settings or promise automatic skill discovery; it
does not write through your shared personal skills tree. Edited/unowned files are
not silently overwritten. Uninstall uses the same ownership checks:

```sh
very-happy teams uninstall --host claude
very-happy teams uninstall --host claude --apply
very-happy teams doctor --host pi
```

Doctor describes static setup and relevant environment overrides; it is not a
live model/daemon connectivity test. Reading a skill alone does not attach an
unmanaged process. In particular, use `very-happy pi` for the managed pi path;
a bare `pi` terminal does not gain a background inbox from installation.

## Choose execution mode

New teams default to **No approvals** for the lead and newly dispatched members.
Choose **Ask when needed** in team settings to restore routine tool prompts. Existing
teams keep their saved mode (historical teams without a mode use normal approvals).
The choice takes effect directly, without a second confirmation. Existing sessions
and already queued operations retain their prior mode; change a live lead's session
mode separately. This does not change global agent settings or provide credentials.

An independent owner terminal can make the same choice:

```sh
very-happy teams permissions --team-id TEAM_ID --mode bypassPermissions --request-id UNIQUE_REQUEST_ID
```

Reuse the request ID on retries. Scoped agent tools cannot change this owner setting.
Team messages appear as compact cards; expand one to inspect the original instructions.

## Scheduled instructions

The Teams page can create a one-time or recurring message to a named bot on the
team machine. Enter a local first-run time and, for repetition, an interval in
whole minutes (minimum one minute). Server state survives daemon restarts; the
daemon delivers to the bound bot, not the most recently active session.

Pause/resume/cancel are version-checked. Cancelling cannot recall a message whose
delivery has already started, and delivery is not proof that the model processed
the instructions. An unavailable recipient retains its pending work rather than
falling back to another bot. Cancel active or paused schedules before archiving.
External task-source mapping and its completion policy still belong to that
source adapter; a schedule by itself does not import or complete Todo items.

## Review and recovery

- A task can be queued, running, submitted, accepted, or cancelled. Idle/blocked/
  exited are separate bot activity events; none of them means a task passed.
- A submitted result requires the owner's acceptance. Returning it creates a new
  attempt. Acceptance/return/cancellation/handoff reference the displayed attempt
  and goal version, so old pages cannot silently act on newer work.
- Cancelling closes the unfinished subtree. Before a parent is submitted or
  handed off, its child work must be resolved. Child completion alone does not
  prove that the parent goal is satisfied.
- A message marked delivered is not a processing acknowledgement from the model.
  Inspect the session and result instead of assuming a notification was handled.
- Cleanup stops only team-created managed workers. User-linked sessions are not
  automatically destroyed. A worker may switch to its own branch in the team
  worktree: once that branch is pushed or merged (including squash merges) and
  the worktree is clean, cleanup removes the worktree and keeps the branch. A
  worktree that was already removed counts as cleaned. Uncommitted files or
  unpushed commits keep the worktree; the entry explains what to push, commit or
  discard. Then choose **Retry cleanup** (otherwise it is re-checked every few
  minutes), or **Mark as handled** if you dealt with it yourself. Handled entries
  fold away under the attention list.
- A member that fails to start shows the real cause (for example the agent
  process exited during startup with its last error). When the computer has
  confirmed the failed process is gone, it relaunches the same task
  automatically with backoff (up to five attempts). If it still fails, fix the
  cause and choose **Retry launch** in the task details. When the launch outcome
  is unconfirmed, nothing relaunches automatically: confirm the old process has
  stopped, then retry the launch or cancel the task. Retry requires a CLI that
  supports it; sending a message never restarts the agent.
- Reactivating a member (delegating to it again) always creates a fresh worktree
  from the member's original repository, even when its previous worktree was
  removed. If that repository itself is missing or not a Git checkout, the task
  shows that cause, retries with the same backoff, and waits for **Retry launch**.
- When execution is unknown, first cancel or hand off the task as appropriate,
  verify the old process stopped, and preserve/integrate the results. The owner
  can then record **manual reconciliation** with the displayed claim and a note.
  This only records verification; it performs no OS cleanup or automatic respawn.
- Archive after tasks, execution operations, and cleanup are resolved. Archived
  teams leave the active list, while their existing direct links remain readable.

## Migrate from a private supervisor

```sh
very-happy teams migration-preview --file /absolute/path/to/ledger.json
```

The preview is offline: it does not import rows, spawn sessions, or finish Todo
items. Keep the original ledger and mappings as evidence.

1. Inventory and back up old schedules, ledgers, source-task mappings, live
   sessions, and worktrees. A `done`/`stopped` row does not prove resource cleanup.
2. Give every scheduled trigger and external task source an explicit replacement
   before retiring it. Preserve source-task-to-Team-task idempotency mappings;
   decide whether external completion requires acceptance or actual publication.
3. Freeze old dispatch, including an active old meta session, then reconcile its
   in-flight work. Stopping a timer does not stop a model that can still dispatch.
4. Bring work into Teams individually after checking the live session and result.
   Legacy review is not accepted. Finished rows remain history. There is no
   automatic import of active legacy status into a fabricated new attempt.
5. Enable the new writer only after the old writer is stopped for that task
   source. Observe the replacement before removing old configuration; retain a
   read-only archive and a restore path.

The retired tick/ledger cards remain readable as ordinary historical messages.
The separate voice Assistant and old `assistant` sessions remain compatible;
`variant: assistant` is not a Teams role and creates no task ownership. Do not
restart the old coordinator to “repair” a new Teams task.

## Validation boundary

Claude and Codex have completed real mixed-runner edits, commits, scoped result
submission, owner acceptance, and clean resource reclamation in an isolated
stack. Managed pi also completed a real model edit, commit, scoped submission,
individual permission approvals, owner acceptance and cleanup using the official
bridge and fixed pi-acp 0.0.33, without the private supervisor wrapper. A real pi parent also delegated to a Claude child, exchanged messages, reviewed
and merged its result, and submitted to the owner; both levels were accepted and
reclaimed. Cleanup preserved unmerged work and recovered after final integration.
Recursive state and crash fencing have mechanism tests; parent disconnection and
long-term multi-level recovery are not yet established production guarantees. Cross-machine automatic routing, global model budgets, and
long-term unattended operation remain follow-up work.
