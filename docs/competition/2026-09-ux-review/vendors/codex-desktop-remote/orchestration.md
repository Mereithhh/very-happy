# OpenAI Codex (ChatGPT desktop app / Codex Remote / Codex cloud) — Workflow abstraction & orchestration

Research date: 2026-09-03. Researcher lens: how the product abstracts "work" above a single chat, and whether that abstraction reduces the operational context a human has to hold. Evidence is tagged **OBSERVED** (seen in official docs / changelog / release blog) or **INFERRED** (my reading of the mechanism). Written for the very-happy owner; not constrained by very-happy's current architecture.

## 0. Product status (verified)

- **OBSERVED** The standalone Codex app (macOS Feb 2 2026, Windows Mar 4 2026) merged into the **new ChatGPT desktop app on July 9 2026** (macOS + Windows; Linux preview Aug 11). The app has three modes — **Chat**, **Work** (the ChatGPT agent, "Codex technology built-in"), and **Codex** (developer view). Existing Codex users update in place; Codex can stay the default view and keep its icon; Codex history stays separate from ChatGPT history. The old ChatGPT app was renamed "ChatGPT Classic". Codex is *not selectable on web or mobile*; desktop Codex chats are reachable only via the mobile **Remote** tab. (openai.com/index/chatgpt-for-your-most-ambitious-work, help.openai.com moving-to-the-new-chatgpt-desktop-app, learn.chatgpt.com/docs/whats-new)
- **OBSERVED** "Codex Remote" = Codex inside the ChatGPT mobile app controlling a paired Mac/Windows host (preview May 14 2026, GA June 25 2026, one-to-one QR pairing per phone/host, secure relay; host must be awake and app running). (openai.com/index/work-with-codex-from-anywhere, learn.chatgpt.com/docs/remote-connections, changelog 2026-06-25)
- **OBSERVED** Vocabulary churn: docs renamed *thread/task → chat* and *Automations → Scheduled tasks* (the pages keep legacy anchors like `#start-a-task-without-a-project`, `#thread-automations`); iOS release notes still say "tasks" and "thread ID"; CLI says "threads"/"tasks". The Feb launch blog said "command center for agents"; the Sept 2026 app page says "Your command center for complex work".

## 1. The mental model being sold

**"Command center" with chats as the unit of work.** Everything above the chat is a *lens on chats*, not a different object:

| Layer | What it is (OBSERVED) | Source |
|---|---|---|
| **Project** | Folder(s) on disk (primary + secondary), or a ChatGPT project with sources; a chat may also be standalone ("New chat" without project) or a **Quick chat** (plain ChatGPT chat opened from Codex, not shown in the Codex sidebar). | docs/projects |
| **Chat** (thread/task) | Transcript + context + results + actions, bound to a **run location**: Local / Worktree / Cloud (composer picker), or a remote SSH host. | docs/environments/modes, docs/remote-connections |
| **Goal** | `/goal` attaches a persistent objective to a chat; the goal text is "both the first prompt and the completion criteria"; a progress row above the composer lets you pause/resume/edit/clear; GA May 21 2026. | docs/long-running-work, changelog 2026-05-21 |
| **Subagent threads** | Children of a chat; visible as threads (app: open from activity; CLI `/agent`; IDE panel with "stop all"). | docs/agent-configuration/subagents |
| **Scheduled task** | Standalone (new chat per run, results land in **Scheduled** inbox) or **in-chat "heartbeat"** (returns to the same chat with its context, minute-level cadence allowed). | docs/automations, glossary "Heartbeat" |
| **Attention views** | **Activity view** (bell, Cmd/Ctrl+Opt+U: unread / running / waiting for your response; filters Work/Chat/Pinned/Scheduled; "Mark all as read"), **Scheduled** inbox with unread runs, iOS **Priority view** (running, unread, awaiting response on top, Sept 1 2026). | docs/notifications, changelog 2026-07-30, 2026-09-01 |
| **Ambient status** | **Pets** (floating overlay; states Running / Needs input / Ready / Blocked; tray prioritizes needs-input > blocked > ready > running) and **Codex Micro** hardware (6 Agent Keys lit by chat status; Approve/Decline/Fork/Mic keys; "Priority chats" key mode). | docs/pets, docs/features/codex-micro |

**INFERRED** The implicit promise: you never look at a "fleet" or a "graph", you look at a list of chats sorted by *whether they need you*. That is a deliberately shallow abstraction — one level (project) of grouping plus attention sorting — and it is coherent across desktop, phone, hardware keypad and the pet. Nothing in the docs sells "roles", "teams" or "org charts".

## 2. Parallel work: worktrees, handoff, cloud

- **OBSERVED** Worktree chats create a Git worktree under `$CODEX_HOME/worktrees` at the selected branch's HEAD (uncommitted local changes are applied), **detached HEAD** so branches aren't polluted; `.worktreeinclude` copies ignored files (`.env`) into managed worktrees; `AGENTS.override.md` is copied automatically. Default cap **15 managed worktrees**; not deleted if the chat is pinned, in progress, or the worktree is permanent; **a snapshot is saved before deletion and offered for restore** when you reopen the chat. Local environments define **setup scripts** that run on worktree creation and **actions** (buttons in the top bar that run in the integrated terminal), checked into `.codex/`. (docs/app/worktrees, docs/environments/local-environment)
- **OBSERVED** **Handoff** moves a chat *and its Git state* Local ↔ Worktree, and (June 18 2026) local ↔ remote SSH host ("Codex can also coordinate the handoff for you"; you can ask Codex in another chat to hand off a *named* chat, but a chat can't hand off itself; handoff to cloud isn't supported). "Create branch here" converts a worktree into a branch. (docs/app/worktrees, docs/remote-connections, changelog 2026-06-18)
- **OBSERVED** Codex cloud = isolated container per chat (setup script, 12h container cache, agent-phase internet off by default), list UI with tabs *Chats / Code reviews / Security reviews / Archive*, rows show repo · branch · +/− lines · Merged/Closed/Cancelled. Marketing says "You want to compare several attempts — run tasks in parallel". (developers.openai.com/codex/cloud, docs/environments/cloud-environment)
- **INFERRED** There is no observed fan-out/compare/merge UI (no "run 3 variants and pick one" control in the current docs; earlier best-of-N is an open question). Parallelism is achieved by *starting more chats*; comparison is manual, via the review pane or PR list.

## 3. Subagents and their visibility

- **OBSERVED** Subagent workflows are on by default in local clients; triggered by direct request ("spawn one agent per point, wait for all, summarize") or by `AGENTS.md`/skill instructions; Work-on-web "Ultra" intelligence level delegates proactively. Built-in agents `default`, `worker`, `explorer`; custom agents are TOML files in `~/.codex/agents/` or `.codex/agents/` with `name`, `description`, `developer_instructions`, optional `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. Global `[agents]` has `max_concurrent_threads_per_session`, default model/effort, `interrupt_message`. (docs/agent-configuration/subagents)
- **OBSERVED** Visibility: the app "surfaces each subagent thread so you can inspect its work and the summary returned"; May 29 2026 added **stable identicons for background subagents**; the CLI approval overlay for a request from an *inactive* agent thread shows the **source thread label and `o` opens that thread** before you approve. Web "Subagents" sidebar is read-only (Active/Done, no stop/steer). Steering or stopping a subagent in the app is done by *asking the parent agent*. Subagents inherit the parent's permission mode; nested subagent token usage counts toward the root goal budget (CLI 0.151). (docs/subagents, changelog 2026-05-29, 2026-08-29)
- **INFERRED** Subagents are treated as *contexts* to keep the main thread clean ("context rot" is the stated motivation), not as *roles* with persistent identity, inboxes, or ownership. The custom-agent TOML is the closest thing to a role definition and it lives outside the UI.

## 4. Cross-chat messaging and agents driving the orchestrator

- **OBSERVED** CLI 0.150.0 (Aug 26 2026): "Reference other Codex tasks with `@` mentions, and ask agents to read, create, or message tasks from the terminal." PR #40308 adds a `codex_tui` tool namespace for **listing, reading, waiting on, creating, forking, messaging, renaming, archiving and restoring tasks**, routed "through an authenticated local MCP server with explicit approval prompts" and falling back on older app-servers. PR #40315: `@` mention popup lists tasks (prioritizing current cwd), submitted as "bounded live thread references" the model loads with `read_thread`. (changelog 2026-08-26, github PRs 40308/40315)
- **OBSERVED** Desktop: May 29 2026 "thread coordination for local projects and worktrees, including separate background threads when explicitly requested"; July 23 2026 **ChatGPT Voice** "start a new chat or task in voice mode, then ask ChatGPT to start, check, or steer work in other threads"; iOS July 6 "creating, searching, opening, forking, and managing Codex tasks directly from a conversation". (changelog)
- **OBSERVED** Programmatic surfaces: `codex exec` (CI/scripts, `--json`, `--output-schema`), Codex SDK (TS/Python: start/resume/fork threads, per-turn sandbox), **app-server** (JSON-RPC: `thread/start|resume|fork`, `turn/start`, `turn/steer`, `turn/interrupt`, approval requests as events; stdio/unix/ws transports; `codex --remote ws://…` lets a TUI attach to a remote app-server), Hooks (SessionStart/End, Pre/PostToolUse, PermissionRequest with `decision.behavior: allow`, UserPromptSubmit, Subagent Start/Stop, Stop, Interrupt; async commands and MCP-tool hooks), GitHub Action. `codex mcp-server` is deprecated in favour of app-server. (docs/codex-sdk, docs/app-server, docs/hooks, docs/github-action, changelog 2026-08-24)
- **OBSERVED** Self-scheduling: "Codex can now schedule future work for itself and wake up automatically to continue on a long-term task" (Apr 16 2026); skills can create scheduled tasks ("a skill for babysitting a pull request could set up a scheduled task that checks PR status … and fixes new review feedback"). (openai.com/index/codex-for-almost-everything, docs/automations)
- **INFERRED** Put together, an agent *can* act as a dispatcher (list tasks → read → message → wait → fork), but the product ships no dispatcher persona, no "chief of staff" screen, and every cross-task action is gated by an approval prompt. The orchestration graph exists only inside the model's context and the human sees it as ordinary chat activity.

## 5. Scheduled / recurring work and external triggers

- **OBSERVED** Desktop scheduled tasks: per project (or several projects), run in local checkout or a **dedicated background worktree**; model/effort selectable; custom cadence via **RFC 5545 RRULE**; run **unattended with `approval_policy = "never"`** when org policy allows, otherwise fall back to the selected permission mode; docs warn Full-access schedules are "elevated risk"; **Scheduled view is the inbox** (runs with findings, unread indicator, bulk mark-read/archive since June 18). Worktree sprawl is called out ("frequent schedules can create many worktrees"). Examples shipped: self-improving skills scan of `~/.codex/sessions`, 24h exec brief, `$recent-code-bugfix`. (developers.openai.com/codex/app/automations)
- **OBSERVED** **Event triggers** (Aug 25 2026): Gmail (sender/subject filters), Slack (selected channels, `@ChatGPT` must be a member), GitHub (PR reviews/comments/commits/merges, filter by author/title/label). **Web and mobile only — "not available in the ChatGPT desktop app, Codex CLI, or the IDE extension"**; an event task can't also have a time schedule; close events may be batched; "Run now" processes pending events. (docs/automations)
- **OBSERVED** Codex cloud triggers: Slack `@Codex` (reads thread history, picks environment by best match else most-recently-used, reacts 👀, posts link then result); Linear (assign issue to Codex or `@Codex` comment; **triage rules can auto-delegate new issues to Codex**, runs as issue creator); GitHub (`@codex review` posts P0/P1-only reviews, `@codex fix the P1 issue` pushes to the branch, automatic reviews on PR open, `## Code Review Rules` in AGENTS.md); GitLab beta. (docs/third-party/slack, linear, github)
- **INFERRED** Two orchestration worlds: *local* (desktop app, worktrees, scheduled tasks bound to an awake machine) and *cloud* (containers, integrations, event triggers). They share account, skills and plugins but not the trigger surface — you cannot yet have a GitHub event start a job on your own machine.

## 6. Approval / permission UX

- **OBSERVED** Three modes in the app composer: **Ask for approval** (default), **Approve for me** (= Auto-review: a separate reviewer agent decides boundary-crossing requests; returns rationale; denial instructs the main agent to find "a materially safer path or stop and ask"; **circuit breaker** aborts the turn after 3 consecutive or 10-of-last-50 denials; `/approve` re-runs one specific denied action once), **Full access** (with model-specific danger warnings). Sandbox (read-only / workspace-write / full) is orthogonal to who approves. Modes must be *enabled* in Settings before they appear. Auto-review sees a compact transcript, not hidden reasoning; policy is open-source and overridable per user/tenant. (docs/permission-modes, docs/sandboxing/auto-review)
- **OBSERVED** Remote approval card on phone: "Do you want to allow Codex to run this command? `pnpm test -- StatusBadge`" with **Approve / Always approve / Tell Codex what to do / Deny**; on desktop Enter approves, Esc declines; iOS supports "editable message approvals" (Aug 18). (developers.openai.com/codex/remote, docs/reference/commands, changelog 2026-08-18)
- **INFERRED** "Approve for me" is the product's real answer to babysitting: it keeps the sandbox boundary and swaps the human for a reviewer model. Everything else (rules allowlists, `writable_roots`) is "fix the boundary so fewer things need review".

## 7. Where the human still babysits (first-principles judgement)

1. **Machine liveness is your job.** Local scheduled tasks and Remote both require the host awake, app open, project on disk ("Prevent sleep while running" setting; lid-closed Mac needs an external display). Cloud is the workaround, with different capabilities. (docs/automations, docs/remote-connections, docs/long-running-work)
2. **Coordination state is invisible.** Which chat is waiting on which, who forked whom, what a subagent is blocked on — none of that is a view. Activity view is a flat, time-sorted list; the pet shows one state. Cross-task actions are prompt-driven ("ask Codex to steer a running subagent").
3. **Git topology decisions stay manual.** One-branch-per-worktree errors, Handoff vs "Create branch here", worktree cleanup, `.worktreeinclude`. The docs devote a section to explaining the Git error.
4. **Scheduled tasks are prompt-engineering.** "Test the prompt manually first… review the first few outputs… make the prompt durable… describe when to stop or ask you." There is no run-diff, no cost/quality trend per task in the docs.
5. **Trigger routing is heuristic.** Slack/Linear pick the environment "that best matches" else most-recent; the fix is to reply in the thread and re-mention.
6. **Approval fatigue is pushed to config.** The recommended path is writing `rules` and `writable_roots`; auto-review is opt-in and still trips a breaker that returns control to you.
7. **Reliability of the remote path.** Sept 1 iOS notes fix "stuck Send states, missing approvals, and stale task updates"; the docs have a troubleshooting entry "The approval request doesn't appear".

**Does it reduce the operational context a human must hold?** Partly. It collapses *where is my attention needed* into one sorted list across four form factors (desktop, phone, keypad, pet), and it collapses *where does this run* into a composer picker with reversible handoff. It does **not** reduce *why is this work happening* (no goals above chat level, no task graph) or *who owns what* (no roles). For one person supervising a handful of chats it works; for a "virtual office" it lacks the office.

## 8. "Virtual office of role-bots with a chief of staff" — what Codex has vs lacks

Has (OBSERVED): role definitions (custom agent TOML with model/effort/sandbox/MCP), an agent-callable task registry (`codex_tui` list/read/wait/create/fork/message), self-scheduling and in-chat heartbeats, an inbox of findings, approval routing to a reviewer agent, a relay so the phone is a full control surface, event triggers (cloud), a documented app-server protocol so a third party could build the office on top ("Codex as a platform", Relay sample app: task board where moving an issue to ready starts a scoped workflow).

Lacks (OBSERVED absent / INFERRED): persistent role identities with their own queues and memory; a dispatcher UI that shows delegation edges; per-role budgets and SLAs; a decision inbox that is separate from chat unread; goals that span chats; local event triggers; any "office" view at all. Proactive "start your day" suggestions exist (Apr 16 2026 blog, app-page use case "focused work brief") but are memory-dependent personalization, not orchestration.

## 9. Borrowable for very-happy (ranked by UX impact)

1. **A single "needs me" queue with keyboard cycling** — Activity view (unread/running/waiting), `Next chat needing attention` (Cmd+Opt+A), `Clear all unread` (Shift+Esc), iOS Priority view, pet ordering needs-input > blocked > ready > running. very-happy's session list + notifications could adopt the four-state vocabulary and a cross-machine attention queue; this is the cheapest big reduction in operational context.
2. **Run-location as a session property with reversible Handoff** — Local / Worktree / Cloud / host chip under the composer; worktree lifecycle (cap, snapshot-before-delete, pinned = protected, `.worktreeinclude`). very-happy has machines + tmux; make "where this runs" explicit and movable, with worktree sessions that clean themselves up.
3. **In-chat heartbeat + standalone scheduled tasks with a findings inbox** — RRULE, run-in-worktree, unread findings, bulk archive, agent/skill-creatable ("babysit PR"). Maps naturally onto very-happy's task board and daemon (which already solves the always-on problem the Codex desktop app has).
4. **Goal chip** — `/goal` = first prompt + done criteria, persistent row with pause/resume/edit/clear, budget accounting to the root goal. Small UI, survives `/clear` and compaction.
5. **Session-registry tools for agents, approval-gated** — list/read/wait/create/fork/message sessions, `@session` mentions as bounded references. very-happy already has spawn/send channels and /btw; exposing this to Claude Code sessions is what would let the weak "assistant" screen become a dispatcher with real hands.
6. **Approve-for-me reviewer mode** — a reviewer agent at the sandbox boundary with rationale, denial breaker, and `/approve` retry of one specific denied action. very-happy's permission requests could add an auto-review lane (the /btw side-query machinery is the right shape) instead of only ask/yolo.
7. **Subagent threads as first-class, with source-thread labels on approvals** — stable identicons, "open the thread this approval came from", stop-all panel. very-happy renders sidechains; adding source labels on permission requests is a direct borrow.
8. **Trigger surfaces that reply to origin** — Slack mention reads thread history and posts result back; Linear assign/triage rule; GitHub `@codex review/fix`. very-happy's webhook out + spawn/send in could be framed the same way: trigger → session → reply where it came from.
9. **Review pane scopes + inline comments as next-prompt input** — Unstaged/Staged/Commit/Branch/**Last turn**, per-hunk stage/revert, detached review chat. "Last turn" scope is the one that matters for a chat-first client.
10. **Phone approval card wording** — Approve / Always approve / Tell Codex what to do / Deny (the third option turns a denial into a steer). Trivial to adopt on very-happy's permission UI.
11. **Project actions** — checked-in `.codex` actions rendered as buttons that run in the integrated terminal; very-happy's tmux terminals could host per-project action buttons.
12. **Read-only shared thread snapshot with secret redaction** — useful as a way to hand a session to another agent or human without live access.

## 10. Anti-patterns (don't copy)

1. **Vocabulary churn across surfaces** (task/thread/chat, Automations/Scheduled tasks; iOS still "tasks") — every rename adds context the human must hold; very-happy should pick one noun and keep it.
2. **Binding background work to a GUI app being open** — local scheduled tasks and Remote die when the desktop app closes or the Mac sleeps; very-happy's daemon model is strictly better here, don't regress toward "the browser tab must stay open".
3. **Coordination through prose instead of structure** — "ask Codex to stop the subagent", "ask Codex in another chat to hand off X": powerful for the model, invisible to the human; if very-happy adds agent-to-agent tools, also render the resulting edges.
4. **Two orchestration worlds with different powers** — event triggers only on web/mobile, subagent controls read-only on web, Codex not selectable on web/mobile. Capability asymmetry between surfaces is exactly what a single web/PWA client can avoid.
5. **Unattended `approval_policy = never` as the schedule default** with a docs warning, rather than defaulting schedules to the reviewer mode.
6. **INFERRED (press/community only)** Folding a coding app into a three-mode consumer super-app buried ordinary chat as "Quick chat" and drew "where did my projects go" confusion; keep very-happy's surface single-purpose.

## 11. Open questions

- Does Codex cloud still expose best-of-N / multiple attempts per task? Not seen in current docs.
- How the desktop app (not CLI) exposes task mentions / `codex_tui` tools; "thread coordination for local projects and worktrees" (May 29) is under-documented.
- Whether Activity view filters by project/host and how unread is computed for subagent threads.
- How proactive "work brief" suggestions are surfaced (home screen? notification?) — only described in the Apr 16 blog and an app-page use case.
- Whether event-triggered tasks will reach desktop/local projects.
- Real-world Remote approval latency and relay reliability (multiple iOS fixes for missing approvals).
- Whether a goal can span chats or survive handoff; how goal budgets interact with compaction.

## Sources (all read 2026-09-03)

- https://developers.openai.com/codex/app — desktop app overview: "command center", parallel projects, Chat/Work/Codex toggle, Quick chat, "focused work brief" use case.
- https://developers.openai.com/codex/remote — Remote page: phone task list (Pinned/Today), approval card (Approve / Always approve / Tell Codex what to do / Deny), diff review, QR setup.
- https://developers.openai.com/codex/cloud — cloud list UI (Chats/Code reviews/Archive, repo·branch·+/−, Merged/Closed), environments, integrations, "compare several attempts".
- https://developers.openai.com/codex/llms.txt — full doc index (renames, page inventory).
- https://developers.openai.com/codex/app/worktrees — worktree mechanics, Handoff, permanent worktrees, 15-cap, snapshots, `.worktreeinclude`.
- https://developers.openai.com/codex/app/automations and https://learn.chatgpt.com/docs/automations.md — scheduled tasks, Scheduled inbox, RRULE, in-chat heartbeat, `approval_policy=never`, event triggers (web/mobile only), examples.
- https://developers.openai.com/codex/changelog (+ `?month=2026-07`, `2026-05`, `2026-04`) — dated entries: 2026-09-01 iOS Priority view; 2026-08-26 CLI 0.150 task mentions; 2026-08-25 event triggers; 2026-08-24 mcp-server deprecated; 2026-08-20 shared snapshots; 2026-07-30 Activity view; 2026-07-23 Voice steering other threads; 2026-07-09 merge; 2026-06-25 Remote GA; 2026-06-18 host handoff; 2026-05-29 thread coordination + subagent identicons; 2026-05-21 Goal mode GA; 2026-04-16 in-thread automations; 2026-03-03 Handoff Local↔Worktree.
- https://learn.chatgpt.com/docs/projects.md — projects, primary/secondary folders, standalone chat, Quick chat, pin/archive/search.
- https://learn.chatgpt.com/docs/long-running-work.md — `/goal`, progress row, side chat, parallel goals via worktrees, Prevent sleep.
- https://learn.chatgpt.com/docs/notifications.md — desktop notification controls, Activity view, pet.
- https://learn.chatgpt.com/docs/pets.md — pet states and priority ordering.
- https://learn.chatgpt.com/docs/features/codex-micro.md — hardware Agent Keys status colours, Command Keys, Priority chats mode.
- https://learn.chatgpt.com/docs/integrated-terminal.md — per-chat terminal scoped to project/worktree, actions.
- https://learn.chatgpt.com/docs/code-review.md — review scopes, inline comments, PR flow, per-hunk staging, detached review.
- https://learn.chatgpt.com/docs/environments/modes.md — Local/Worktree/Cloud picker.
- https://learn.chatgpt.com/docs/environments/local-environment.md — setup scripts, actions, `.codex`.
- https://learn.chatgpt.com/docs/environments/cloud-environment.md — container lifecycle, caching, secrets.
- https://learn.chatgpt.com/docs/remote-connections.md — Remote capabilities, host requirements, SSH hosts, handoff between hosts, "ask Codex in another chat to hand off".
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md — subagent model, custom agents TOML, `[agents]` config, approvals from inactive threads, visibility per surface.
- https://learn.chatgpt.com/docs/sandboxing/auto-review.md — reviewer agent, breaker thresholds, `/approve`, policy.
- https://learn.chatgpt.com/docs/permission-modes.md and https://learn.chatgpt.com/docs/sandboxing.md — Ask for approval / Approve for me / Full access; sandbox vs approvals.
- https://learn.chatgpt.com/docs/third-party/slack.md, …/linear.md, …/github.md — trigger mechanics, environment selection, triage rules, `@codex review/fix`.
- https://learn.chatgpt.com/docs/codex-sdk.md, https://learn.chatgpt.com/docs/app-server.md, https://learn.chatgpt.com/docs/hooks.md, https://learn.chatgpt.com/docs/github-action.md — programmatic control surfaces and hook events.
- https://learn.chatgpt.com/docs/get-started-with-work.md and https://learn.chatgpt.com/docs/use-chatgpt.md — Work vs Codex comparison table, cloud vs local work, shared thread snapshots.
- https://learn.chatgpt.com/docs/whats-new.md — weekly digest Apr–Aug 2026 (Activity view, Voice steering, Codex Micro, handoff, Goal GA, Remote preview).
- https://learn.chatgpt.com/docs/glossary.md — definitions (Chat, Heartbeat, Finding, Handoff, Codex-managed worktree).
- https://learn.chatgpt.com/docs/reference/commands.md and https://learn.chatgpt.com/docs/developer-commands.md?surface=cli — shortcuts (Next chat needing attention, Clear all unread, Activity toggle, side chat) and slash commands (`/goal`, `/agent`, `/approve`, `/review`).
- https://learn.chatgpt.com/docs/prompting.md and https://learn.chatgpt.com/docs/customization/memories.md — goal/plan guidance; local memory store.
- https://openai.com/index/introducing-the-codex-app (2026-02-02) — "command center for agents", worktrees, Automations review queue.
- https://openai.com/index/codex-for-almost-everything (2026-04-16) — automations reuse threads, self-scheduling, memory, proactive suggestions, summary pane.
- https://openai.com/index/work-with-codex-from-anywhere (2026-05-14) — Remote preview, relay, Remote SSH GA, hooks GA, access tokens.
- https://openai.com/index/codex-for-knowledge-work and https://openai.com/index/codex-for-every-role-tool-workflow (2026-06-02) — role plugins, Sites, annotations, parallel-task usage stats.
- https://openai.com/index/chatgpt-for-your-most-ambitious-work (2026-07-09) — Work launch, Codex app merges into ChatGPT desktop app, scheduled tasks, auto-review.
- https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app — Chat/Work/Codex structure, ChatGPT Classic, Codex not on web/mobile.
- https://developers.openai.com/blog/run-long-horizon-tasks-with-codex (2026-02-23) — 25h run, durable project memory files.
- https://developers.openai.com/blog/codex-as-a-platform (2026-08-19) — app-server as embedding layer, Relay sample (task board → scoped workflow with approval).
- https://developers.openai.com/blog/automating-repetitive-work-at-openai-with-codex (2026-08-25) — goal-in-notebook + auto-review pattern, monitoring from phone.
- https://github.com/openai/codex/pull/40308 and https://github.com/openai/codex/pull/40315 — `codex_tui` task tools and task mentions mechanics.
