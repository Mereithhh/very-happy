# Agent Teams: getting started and migration

Agent Teams is an opt-in collaboration feature. Ordinary managed sessions can
organize work; there is no special **Meta agent** checkbox. A bot can implement
its own assignment and delegate independent child tasks within that assignment.

The current boundary is one account and one execution machine per team. The
server owns task state, attempts, messages, and decisions. The daemon runs the
coding agents and reconciles execution/cleanup. The manual task board stays
independent and is not a second scheduling database.

## Prerequisites

- The operator enables `VH_AGENT_TEAMS_ENABLED=true`; deployments may additionally
  restrict `VH_AGENT_TEAMS_ACCOUNT_IDS`. This is account-level access, not a
  machine-specific allowlist.
- The selected machine runs a compatible, online daemon advertising Teams
  capability. Update the CLI and hand over with `very-happy daemon start`; start
  a new managed session to use the new runner tools. Existing wrappers are not
  upgraded in place.
- Configure each coding agent's normal credentials and approve its normal
  permission requests. Teams does not grant provider access or default to yolo.
- Use a Git checkout for automatic isolated worktrees. Preserve and integrate
  changes before cleanup; a dirty or unmerged worktree is intentionally retained.

An unavailable/disabled server reports that state. An old daemon cannot receive a
Teams delegation; it does not fall back to Claude or the legacy assistant.

## Install the shared method

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

## Start a team

1. Open a normal managed Claude, Codex, or pi session on the selected machine.
2. Ask it to read the installed skill and inspect its connection. `team_inspect`
   reads an existing assignment; `team_create` or `team_join` connects a root
   session. Keep the returned team ID.
3. Give a bounded goal, for example: “Inspect this repository, propose independent
   work, and delegate the approved changes with acceptance criteria. Integrate
   and verify the results before asking me to accept.”
4. Open **Teams** in the Web sidebar to follow bots, tasks, execution attempts,
   results, and cleanup. Session links open the actual conversation.

Creating a team in Web records it on the selected machine. **Link lead** records
an existing session identity; that session must still call the Teams join tool or
CLI to establish its scoped connection. It is not connected merely because a
link appears in the UI. For an existing managed session, the CLI form is:

```sh
very-happy teams join --name lead --team-id TEAM_ID --session-id SESSION_ID
```

Use a distinct request ID per action and reuse it with identical arguments after
an unknown outcome. Never copy scope tokens into prompts or personal settings.

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
  automatically destroyed; dirty or unmerged team worktrees retain their results.
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
bridge and fixed pi-acp 0.0.33, without the private supervisor wrapper. Recursive state, fencing, and recovery have
mechanism tests, but full multi-level model recovery is not yet an established
production guarantee. Cross-machine automatic routing, global model budgets, and
long-term unattended operation remain follow-up work.
