# Orca (stablyai/orca, onorca.dev) — Lens: Workflow Abstraction & Orchestration

Researched 2026-09-03 for very-happy (veryhappy.dev). Orca desktop v1.4.195 (released 2026-09-02), mobile 0.0.47. All docs read the same day; Orca "ships daily", so treat feature specifics as a snapshot. Tags: **[OBS]** = seen in official docs / changelog / release notes / repo files; **[INF]** = inferred from those or from third-party reports.

Companion file: `inventory.md` in this directory (surface inventory). This file only covers how Orca abstracts *work above one chat*.

---

## 1. The mental model Orca sells

Orca calls itself an **ADE** ("agent development environment") for "a fleet of parallel agents", and the unit of work is the **git worktree**: "every task gets its own git worktree, its own agent terminal, and its own browser tab" ([docs index](https://onorca.dev/docs)). The pitch is explicitly *not* a control plane with a manager agent — it is a **workbench that keeps N independent agents from colliding and tells you which one needs you** ("Orca tracks what each agent is doing and tells you when one needs you", [home](https://onorca.dev)). Third-party comparisons read it the same way: "Orca's model is closer to a fleet of independent agents you supervise" vs Conductor's named team roles ([superset.sh compare](https://superset.sh/compare/orca-vs-conductor)). **[OBS + INF]**

Underneath that there are actually **four stacked abstractions**, each with a different owner:

| Layer | Who drives it | Where it lives | Maturity |
|---|---|---|---|
| Worktree race (fan-out / compare / merge winner) | Human, by hand | Sidebar + split panes + diff viewer | Core, the "hero recipe" |
| "Tracked in one place" attention model | Orca, from OSC titles + hooks | Sidebar glyphs, Agent Dashboard, Agents feed, Cmd-J, bell, mobile push | Core + experimental dashboard |
| Orchestration (Run / Task / Dispatch / worker_done / gates) | **Any agent acting as coordinator via CLI** | `orca orchestration …`, skill guide | Experimental, CLI-only, no UI coordinator |
| Scheduled automations (cron/RRULE prompts) | Human sets schedule; agent runs | `orca automations …` + desktop Automations table | Shipped, cross-host |

The key first-principles observation: the **human is the scheduler**. Orca's own skill guide says so verbatim: "Agents still choose placement and concurrency; Orca does not schedule workers or infer conflicts" ([skill-guides/orchestration.md](https://raw.githubusercontent.com/stablyai/orca/main/skill-guides/orchestration.md)). Orca never decides *what* to run, *where*, or *when*; it provides isolation, mailboxes, and status. **[OBS]**

---

## 2. Layer 1 — Fan-out / compare / merge is a manual race, not a feature

The documented "killer move" ([recipes/parallel-agents](https://onorca.dev/docs/recipes/parallel-agents), [first-session](https://onorca.dev/docs/first-session)) is seven manual steps: create 3 worktrees from the same start-from ref, launch a different agent in each, **paste the same prompt into all three**, drag tabs into splits to watch, review each diff, annotate the winner, commit/push/PR from it, delete losers (dir + branch go together). **[OBS]**

What this means from first principles:

- There is **no "one prompt → N agents" primitive** in the UI. The README's "Fan one prompt across five agents" is a description of the recipe, not a button. Fan-out exists only via CLI: `orca worktree create --agent codex --prompt "…"` per worker, or orchestration `worker-start` with the same task spec ([cli/reference](https://onorca.dev/docs/cli/reference)). **[OBS]**
- There is **no diff-vs-diff comparison, scoring, or "pick winner" affordance**. "Compare and merge the winner" = open each worktree's diff view in turn and delete the others. The docs' rationale — "Where three agents agree, the answer is probably right. Where they split, you've found the hard part" — is a human reading discipline, not tooling. **[OBS + INF]**
- The *real* product value is in the tail of the race: Annotate AI Diff batches line-anchored comments into one revision prompt and lets you pick which agent revises ("Send notes to" menu), attribution marks AI-written lines, and commit/PR/checks/auto-merge/stacked PRs are inline ([annotate-ai-diff](https://onorca.dev/docs/review/annotate-ai-diff), [review/github](https://onorca.dev/docs/review/github)). **[OBS]**
- Third-party reviewers flag the hidden cost: 5 agents = 5× tokens, and "a git worktree separates files and branches, but it does not automatically isolate databases, ports, credentials, browser sessions" ([evomap review](https://evomap.ai/blog/orca-ai-review-parallel-coding-reduce-rework), [margrop review](https://blog.margrop.net/en/post/orca-parallel-ai-agent-ide-review)). Orca partially answers with per-workspace **environment recipes** (`orca.yaml` → cloud VM / Docker per worktree) and worktree setup hooks / `.worktreeinclude` ([ways-to-run](https://onorca.dev/docs/ways-to-run), [model/worktrees](https://onorca.dev/docs/model/worktrees)). **[OBS]**

**Verdict:** Orca reduces *collision* context (files, branches) to zero, but leaves *judgment* context (which of N diffs is right, how they conflict) entirely with the human. The evomap reviewer's line is apt: parallelism can become "a way to postpone coordination until merge time."

---

## 3. Layer 2 — "Tracked in one place": the attention model

This is Orca's strongest orchestration-adjacent asset, and it is built on a thin signal: **agent state is detected from the terminal's OSC title sequence plus Orca-managed status hooks** installed into Claude Code / Codex / Pi / OMP etc. ([agents-sessions](https://onorca.dev/docs/model/agents-sessions), [hooks-memory](https://onorca.dev/docs/agents/hooks-memory)). If you launch a CLI by typing its binary instead of via the agent combobox, you get no state. **[OBS]**

State vocabulary is shared across every surface (sidebar rows, tabs, dashboard, palette): spinner = working; **amber `?` = waiting on you** (permission / input); emerald = done; red = blocked / failed; gray = idle; heartbeat glyph for background monitoring tasks ([agents-sessions](https://onorca.dev/docs/model/agents-sessions), [changelog](https://onorca.dev/changelog)). **[OBS]**

Surfaces that consume it:

- **Sidebar**: projects → worktrees → inline agent rows; unread worktrees are **bolded, not badged**; filters hide sleeping / automation-created / CLI-created / other-client / detached-HEAD workspaces; parent/child nesting (sidebar-only lineage, "does not change Git history"); "Sleep with Descendants (N)" ([model/worktrees](https://onorca.dev/docs/model/worktrees)). **[OBS]**
- **Agent Dashboard** (experimental, Settings → Experimental): a kanban of agents across worktrees with columns **Needs You / Working / Done / (Idle hidden by default, ~30 min quiet)**; cards show the session's conversation name, last user/agent message preview, host badge, cached PR state; Needs You cards tint amber "so tint means 'look here'"; nested Codex/Claude subagents appear as expandable children; click = focus that agent's live terminal; in-window or pop-out ([agents-sessions](https://onorca.dev/docs/model/agents-sessions)). **[OBS]**
- **Agents feed** (Activity page): a chronological, threaded feed across all worktrees — turn finished (idle or blocked on a question), new worktree created, "waiting on input long enough to surface as blocking", last-response preview; running agents pinned on top; "the catch-up surface when you've been away" ([activity](https://onorca.dev/docs/activity)). **[OBS]**
- **Jump Palette Cmd-J**: with an empty query shows up to six "Recent Chats & Terminals" **ranked needs-you → done → idle**, with `Cmd-1..6` digit shortcuts whose membership freezes while open; the idle tab you are already on is omitted "so the list stays actionable"; a non-matching query offers "Create worktree" ([quick-open](https://onorca.dev/docs/model/quick-open)). **[OBS]**
- **Notifications**: agent working→idle transition fires system notification + sound + chip; header bell mirrors an unread count onto the macOS Dock badge; right-click **mark unread** "when you've triaged something but want to come back to it later" ([notifications](https://onorca.dev/docs/notifications)). **[OBS]**
- **Worktree checkpoints**: every worktree carries a free-text **comment** and a **workspace status** (`todo / in-progress / in-review / completed`) that agents write via `orca worktree set --comment … --workspace-status …`; docs recommend it as "the pattern for keeping human collaborators in the loop without forcing chat", with guidance to *read before write* so agent updates do not clobber user-written goals ([worktree-checkpoints](https://onorca.dev/docs/cli/worktree-checkpoints)). A "Workspace Board" (kanban by workspace status) exists behind a shortcut ([settings](https://onorca.dev/docs/settings)). **[OBS]**
- **Hibernation**: done-and-untouched background agents are paused after 30 min (1 min–24 h) and auto-resumed with `--resume` on reopen — but never while an orchestration Dispatch is unsettled or a subagent roster is still attached ([hibernation](https://onorca.dev/docs/agents/hibernation)). **[OBS]**

**First-principles judgment:** this genuinely reduces operational context. The human no longer polls N terminals; the system answers "who needs me, who is done, who is still going" from three views (dashboard, feed, palette) that all share one state vocabulary. The weaknesses: (a) state fidelity depends on the CLI emitting titles/hooks — a mis-recognized session silently has "no indicator"; (b) "Needs You" is derived from a TUI prompt state, not a structured permission object, so the *action* is still "go to the terminal and type" (the Chat UI overlay renders AskUserQuestion cards, but it is experimental); (c) preview text is scraped, not authored. **[INF]**

---

## 4. Layer 3 — Orchestration: a mailbox + ledger for an agent that manages agents

Orca has a real multi-agent layer, shipped May 2026 in answer to community discussion #681 ("coordinator pattern"), reworked since ("Run + worker-start loop, replacing retired `run`/`run-stop`") ([discussion 681](https://github.com/stablyai/orca/discussions/681), [changelog](https://onorca.dev/changelog)). Everything below is **CLI-only and agent-driven**; there is no UI to create a Run, and the coordinator is *whatever agent you type the instruction into*. **[OBS]**

Core model ([cli/orchestration](https://onorca.dev/docs/cli/orchestration), [skill guide](https://raw.githubusercontent.com/stablyai/orca/main/skill-guides/orchestration.md)):

- **Run** — "durable namespace and home inbox. Never schedules or places workers."
- **Task** — spec + `--deps` + status `pending / ready / dispatched / completed / failed / blocked`; `task-list --ready` is offered as the coordinator's "external memory".
- **Dispatch** — one attempt of a Task on a terminal; the lifecycle authority. After 3 consecutive failures the task circuit-breaks to `failed`.
- **Messages** — typed inbox mail: `status, dispatch, worker_done, merge_ready, escalation, handoff, question, decision_gate, heartbeat`; FIFO Deliveries of up to 50 that replay until `--ack`.
- **`ask` / `reply`** — blocking worker→coordinator question with `--options`; timeouts leave it pending and resumable by message id.
- **Decision gates** — coordinator-owned questions that block a Task in the DAG until resolved.
- **Group addresses** — `@all, @idle, @claude, @codex, @worktree:<id>` for broadcasts (never for lifecycle mail).
- **Worker contract** — a preamble injected into the worker's prompt: send `worker_done` exactly once with `--outcome succeeded|failed`, include both task and dispatch IDs "so stale retries cannot complete the wrong dispatch", heartbeat during long work, use `ask` instead of local TUI prompts, then "end that dispatched turn and idle at the agent prompt."
- **Placement** — `worker-start --worktree current | new-child | new-top-level --agent codex --model … --effort …`; federated workers on another paired Orca server with `--on <env>`; nested worker depth is a numeric setting (default 1: workers cannot dispatch).
- **Cleanup discipline** — after each accepted `worker_done` the coordinator must reuse the terminal for a follow-up Dispatch, `worker-retain` (user asked), or `worker-release`; `worker-read --source auto` returns the hook-reported Claude/Codex transcript when provable, else bounded terminal output.
- **Full handoff vs supervised** — the guide is emphatic that "hand off / give this to another agent" means **ownership transfer with no lifecycle obligations**; only explicit "supervise / monitor / wait for worker_done / DAG / decision gate" language triggers orchestration. This exists because coordinators over-supervised.

Visible UI hooks are minimal: task IDs printed in terminals are clickable and focus the assigned terminal (even on a remote runtime); child worktrees created by orchestration nest under the parent in the sidebar; hibernation defers to unsettled Dispatches; the landing mock shows "Splitting auth rewrite into 2 PRs… 2 children · Creating workspaces…" ([cli/orchestration](https://onorca.dev/docs/cli/orchestration), [home](https://onorca.dev)). **[OBS]**

**First-principles judgment:**

- Orca solved the *hard infrastructure* of an agent-manages-agents system — durable IDs, at-least-once mail with acks, completion authority bound to a dispatch (not a terminal handle), circuit breaking, cross-host routing, contract migration across app updates — but **exposes none of it as a human-facing workflow**. A human sees a coordinator terminal scrolling JSON. There is no Run view, no DAG view, no "gates awaiting your decision" inbox; the coordinator's `ask`/`escalation` reach the human only if the coordinator agent relays them into its own TUI. **[OBS + INF]**
- The whole design assumes **coordinator = LLM in a terminal**, i.e. the chief of staff is a prompt, not a product. That is why the skill guide is 42 KB of protocol rules ("Process every message before acknowledging", "Do not release a worker because of a timeout", "never dual-send to old and new handles"). Reliability is delegated to the model reading the guide. Orca's own release notes show the failure surface: `worker-start --agent claude` on a host without `claude` "injects the task prompt into a zsh shell" and stalls ([issue 17943](https://github.com/stablyai/orca/issues/17943), open 2026-09-01). **[OBS]**
- There is **no first-party MCP server or SDK** to drive Orca from outside; "Orca consumes MCP servers without exposing one, and otherwise takes direction through its CLI" ([superset compare](https://superset.sh/compare/orca-vs-conductor)); a community `orca-mcp` bridge exists as a "stopgap for stablyai/orca#13079" ([lobehub orca-mcp](https://lobehub.com/de/mcp/buildcontext-orca-mcp)). **[OBS]**
- Roles/bots: none. `@claude`/`@codex` group addresses are by *CLI vendor*, not by role. The discussion that seeded the feature asked for Coordinator/Builder/Reviewer/Runner roles with cost-aware routing; that part did not ship ([discussion 681](https://github.com/stablyai/orca/discussions/681)). **[OBS + INF]**

---

## 5. Layer 4 — Scheduled automations and triggers

- **Scheduled automations** ([cli/automations](https://onorca.dev/docs/cli/automations)): `orca automations create --trigger hourly|daily|weekdays|weekly|<cron>|<RRULE> --time 09:00 --timezone … --prompt "…" --provider codex --repo my-repo | --workspace active`. Notable mechanisms: `--precheck "<shell>"` skips the run (recorded as *skipped*) when a cheap probe fails, e.g. no PRs to review; `--reuse-session` continues in the previous live automation terminal instead of a blank one; missed-run grace; runs stored per host and managed in one cross-host table with last-run outcome filters; on-demand `run` and **Rerun** in the UI; automation-created workspaces are filterable in the sidebar. **[OBS]** This is the one place Orca *initiates* work without a human — but the trigger vocabulary is time only.
- **Task intake from trackers**: a worktree can be created from a GitHub issue / PR, GitHub Projects card, Linear issue, Jira issue, GitLab MR; the composer pre-fills the name, uses Linear's suggested branch name, links the item to the card, and injects inline images from Linear descriptions/comments into the agent prompt ([review/github](https://onorca.dev/docs/review/github), [review/linear](https://onorca.dev/docs/review/linear)). Agents can read/write Linear via `orca linear save-issue …` with MCP-style semantics ([cli/reference](https://onorca.dev/docs/cli/reference)). **[OBS]**
- **Event triggers**: failed GitHub checks show as a red chip and a **"Fix broken checks"** action hands failing check names + links to an agent ([review/github](https://onorca.dev/docs/review/github)). **[OBS]** No inbound Slack / Discord / webhook / "@orca on an issue" trigger is documented anywhere; superset's comparison lists Slack dispatch as a Superset-only feature ([superset compare](https://superset.sh/compare/orca-vs-conductor)). **[INF]**
- **"Task chips" / suggestions to spin new work**: none beyond the Cmd-J "Create worktree" row for an unmatched query and Quick Commands (saved agent prompts). **[OBS]**

---

## 6. Subagents, cross-session messaging and handoff

- **Subagent visibility**: Codex Task subagents and Claude "Background subagents and Agent Teams teammates" show as expandable child rows under the lead agent in the sidebar and dashboard; clicking a child focuses the *parent* terminal ("subagents do not own a separate pane") ([agents/codex](https://onorca.dev/docs/agents/codex), [agents/claude-code](https://onorca.dev/docs/agents/claude-code)). Claude Agent Teams can be launched via `orca claude-teams` "with native panes for each teammate" (off by default) ([agents/supported](https://onorca.dev/docs/agents/supported)). **[OBS]**
- **Cross-session messaging**: only through orchestration mail (`send --to dispatch:<id>`, group addresses) or raw `orca terminal send`. No human-facing "message another session" UI. **[OBS]**
- **Handoff**: "Continue in New Session…" starts a fresh session (same or different CLI) with "a bounded handoff prompt from the prior transcript or captured context", leaving the original alone; "Copy Context" copies a bounded transcript for pasting elsewhere ([agents/codex](https://onorca.dev/docs/agents/codex), [terminal](https://onorca.dev/docs/terminal)). Note this is the closest analogue to very-happy's `/btw` — but it is a *fork with summary*, not a side-question over the live context. **[OBS + INF]**

---

## 7. Mobile as remote control

The companion app is "a read-mostly view of running agents… the controls you actually want from a phone" and "intentionally not a full editor — it's a remote control for the desktop" ([mobile](https://onorca.dev/docs/mobile)). Pairing is one-time (code or deep link; Orca Relay optional with sign-in, LAN/Tailscale otherwise); the desktop is the source of truth and a closed desktop app drops LAN sessions. From the phone you can: see every worktree across all hosts with status, hydrate scrollback, reply `continue`/`yes`/free text or dictate, switch to Chat UI per session, run Quick Commands, create a workspace from Smart/GitHub/Linear/GitLab/branch, stage/commit, switch accounts and spend a Codex "rate-limit reset credit", and receive push when an agent finishes. **[OBS]** Orchestration state (Runs, gates) is invisible on mobile. **[INF]**

---

## 8. "Opaque terminal" — what is still true, and what has changed

The seed brief says Orca treats agents as opaque terminals with no structured transcript. As of v1.4.195 that is **half true**:

- The PTY **remains the source of truth**; state is inferred from OSC titles + hooks; previews are scraped. **[OBS]**
- But an experimental **Chat UI** decodes the same PTY into "a structured transcript + composer" for Claude, Codex, Grok, OMP, with model/effort pills, slash-command catalog, and AskUserQuestion cards; a separate "updated structured native chat" keeps session state in Orca for **local Codex on macOS/Linux only** ([native-chat](https://onorca.dev/docs/agents/native-chat)). Mobile reuses the same Chat UI. **[OBS]**
- `worker-read --source auto` returns the "exact hook-reported Codex, Claude, OpenClaude, or Grok transcript when it can prove the worker session" ([skill guide](https://raw.githubusercontent.com/stablyai/orca/main/skill-guides/orchestration.md)). **[OBS]**

UX consequence: Orca gets *breadth* (30+ CLIs, "if it runs in a terminal, it runs in Orca") at the price of *depth* — every structured affordance (Needs You, previews, chat cards, permission answers) is a heuristic overlay that can be wrong or absent, and permission handling defaults to bypass flags (`--dangerously-skip-permissions` etc., "the worktree itself is the sandbox") because Orca cannot mediate approvals in-band ([agents-sessions](https://onorca.dev/docs/model/agents-sessions), [SFEIR](https://www.sfeir.com/articles/orca-ade-flotte-agents-paralleles)). very-happy's SDK-session model is the opposite trade. **[OBS + INF]**

---

## 9. First-principles scorecard

**Does it reduce the operational context a human must hold?**

| Context the human held before | Orca's answer | Residual babysitting |
|---|---|---|
| "Which agent is in which directory/branch?" | Worktree = card; delete removes both | Disk / memory / port / env collisions still yours (setup hooks help) |
| "Who is waiting on me?" | Needs You column, amber glyph, feed, bell, mobile push | Only as good as OSC/hook detection; answering means typing into a TUI |
| "Who finished and what did they do?" | Done column, preview, agent comment on card, attribution in diff | Reading N diffs; no cross-diff comparison |
| "What should happen next?" | Nothing — human or coordinator-LLM decides | Entire planning/merge/sequencing burden |
| "Keep the fleet coherent while I'm away" | Hibernation, session restore, automations, remote server | Host reboot kills PTYs; orchestration only if an LLM coordinator is running |
| "Decisions escalated by workers" | `ask`/`escalation`/gates in the coordinator inbox | Reaches the human only through the coordinator's TUI; no gate inbox UI |

**What a "virtual office of role-bots with a chief of staff" needs — Orca has / lacks:**

Has: durable task ledger with deps and statuses; dispatch-bound completion authority; at-least-once inbox with acks; blocking `ask` with options; decision gates that block DAG nodes; cross-host worker placement; heartbeat liveness separate from completion; explicit release/retain cleanup; cron automations with prechecks; tracker-linked worktrees; a shared state vocabulary across desktop and phone. **[OBS]**

Lacks: any *human-facing* view of Runs/Tasks/gates; a persistent chief-of-staff (coordinator is an ad-hoc LLM turn that dies with its terminal); roles (Builder/Reviewer/Runner) or per-role model/cost routing; event triggers beyond time and "fix broken checks"; an inbound API/MCP for other software; a structured permission channel (defaults to yolo); cross-diff comparison for the fan-out it advertises. **[OBS + INF]**

---

## 10. Borrowable for very-happy (ranked by UX impact)

1. **One state vocabulary for every session, shown everywhere** — Needs You / Working / Done / Idle with a single glyph set across list, board, feed, palette, and mobile. very-happy already *owns* structured state (SDK events, permission objects), so it can do this with certainty rather than OSC heuristics.
2. **A cross-session "Needs You" board + chronological Agents feed as the catch-up surface**, with Needs-You tint meaning "look here" and running items pinned on top.
3. **Recent-sessions palette ranked needs-you → done → idle with digit shortcuts and the current session omitted** — a keyboard-first "what next?" that answers the question instead of listing everything.
4. **Agent-writable status line + workspace status on the session/task card** (`worktree set --comment/--workspace-status`) as the documented way for agents to keep humans informed "without forcing chat", with read-before-write guidance. Maps directly onto very-happy's task board + session metadata.
5. **Orchestration primitives as a *product surface*, not just a CLI**: Run/Task/Dispatch/gate ledger with `worker_done` bound to dispatch IDs, `ask` with options, `check --wait` instead of polling, release/retain cleanup. very-happy's assistant/dispatcher screen could become the human-facing coordinator inbox Orca lacks (gates awaiting decision, escalations, DAG progress).
6. **Scheduled prompts with `--precheck` and `--reuse-session`** — cheap shell probe to skip no-op runs; continue in the same session for recurring digests.
7. **Batch review loop**: line-anchored comments → one revision prompt → pick which session revises; unresolved comments re-batch on the next send. Fits very-happy's structured diff cards better than a PTY.
8. **"Fix broken checks" style event → prompt hand-offs** (failed CI chip → agent prompt with check names/links), and worktree-from-issue with tracker branch names and inline images injected into the prompt.
9. **Mark-unread + Dock/PWA badge for agent pings**, and "hibernate done sessions, auto-resume on open" semantics for a long-lived session list.
10. **"Continue in New Session" bounded handoff** as a complement to `/btw` (fork with summary into a fresh or different agent).
11. **Full-handoff vs supervised distinction in agent instructions** — Orca's guide shows coordinators over-supervise unless told; very-happy's dispatcher prompt should encode the same rule.

## 11. Anti-patterns to avoid

- **Chief of staff as a 42 KB protocol prompt**: reliability of the multi-agent loop rests on the coordinator LLM obeying ack/release/retry rules; no UI shows the ledger, so a misbehaving coordinator is invisible until a terminal is left in zsh with task text (issue 17943).
- **Yolo by default**: pre-filling permission-bypass flags for every CLI because approvals cannot be mediated in-band; reviewers escalate this to the CISO level (SFEIR). very-happy's structured permission channel is the right side of this trade — do not dilute it for breadth.
- **Advertising fan-out without a compare step**: "fan one prompt across five agents" ends in five separate diff tabs and manual deletion; the review cost is pushed to the human.
- **Heuristic state from terminal titles**: a session launched outside the combobox has "no indicator"; phone can show a stuck spinner needing manual refresh (mobile troubleshooting). Structured sources should be preferred wherever available.
- **Time-only triggers and no inbound API**: automation cannot be reached from Slack/GitHub events or other software; the community had to build an MCP bridge.

## 12. Open questions

- How does the coordinator's `ask`/`escalation` reach the human in practice — is there any toast/inbox, or only the coordinator's own TUI output? Docs show none.
- Is the Agent Dashboard / Agents feed reachable from the paired web client or mobile, or desktop only?
- How reliable is "Needs You" detection for permission prompts when agents run with bypass flags (does it ever fire)?
- Does `worker-read --source auto` expose tool-call-level structure, or a flat transcript?
- Are there plans (roadmap, #13079) for a first-party MCP server / SDK, and for role-based routing as requested in #681?

---

## Sources (all read 2026-09-03)

- https://github.com/stablyai/orca — README: positioning ("ADE for a fleet of parallel agents"), feature wall, "Agents drive Orca too" CLI pitch, supported CLIs.
- https://onorca.dev — landing: mock sidebar with agent status lines, "Orca tracks what each agent is doing and tells you when one needs you", "Splitting auth rewrite into 2 PRs… 2 children", Run-on picker, mobile mock; testimonial describing worker_done workflow.
- https://onorca.dev/docs — "What is Orca?": worktree + terminal + browser per task; when to use; not a model / git replacement / VPS product.
- https://onorca.dev/changelog — Agent Dashboard, Chat UI, orchestration Run + worker-start replacing retired `run`, cross-host automations, heartbeat glyphs, Cmd-J recency, recursive sleep.
- https://github.com/stablyai/orca/releases (via GitHub API, v1.4.193–v1.4.195, 2026-08-31 to 2026-09-02) — 48–72 h release cadence, native chat fixes, orchestration dep recovery, relay/daemon PTY reaping.
- https://onorca.dev/docs/model/worktrees — worktree lifecycle, start-from picker, shared paths/.worktreeinclude, sidebar filters, parent/child lineage, Sleep with Descendants, CLI/automation provenance filters.
- https://onorca.dev/docs/model/agents-sessions — state glyphs from OSC titles + hooks; Agent Dashboard columns/cards; yolo launch defaults; restart chip; lifecycle.
- https://onorca.dev/docs/recipes/parallel-agents and https://onorca.dev/docs/first-session — the manual 7-step race recipe.
- https://onorca.dev/docs/cli/orchestration — Run/Task/Dispatch/Message/Gate model, supervised loop, worker contract, group addresses, recovery, clickable task IDs.
- https://raw.githubusercontent.com/stablyai/orca/main/skill-guides/orchestration.md and https://raw.githubusercontent.com/stablyai/orca/main/skills/orchestration/SKILL.md — full worker/coordinator protocol, "Orca does not schedule workers or infer conflicts", nested depth, full-handoff vs supervised, worker-read source auto, hybrid stub design.
- https://onorca.dev/docs/cli/automations — cron/RRULE, precheck, reuse-session, missed-run grace, cross-host table, Rerun.
- https://onorca.dev/docs/cli/overview, https://onorca.dev/docs/cli/reference — full CLI surface incl. worktree --prompt/--agent, terminal send/wait/read, Linear MCP-style writes, artifacts, host selectors.
- https://onorca.dev/docs/cli/skills — skills registry, hybrid stubs, MCP servers consumed via Settings → Integrations.
- https://onorca.dev/docs/cli/worktree-checkpoints — agent-written comment + workspace status pattern.
- https://onorca.dev/docs/activity — Agents feed semantics.
- https://onorca.dev/docs/notifications — agent-finished pings, bell, Dock badge, mark unread.
- https://onorca.dev/docs/model/quick-open — Cmd-J recents ranked needs-you first, digit shortcuts, Create worktree row.
- https://onorca.dev/docs/mobile — pairing, read-mostly remote control, Chat UI, Quick Commands, create workspace, account/reset credits.
- https://onorca.dev/docs/agents/native-chat — Chat UI as overlay on PTY; structured native chat for local Codex only; AskUserQuestion cards.
- https://onorca.dev/docs/agents/claude-code, https://onorca.dev/docs/agents/codex, https://onorca.dev/docs/agents/supported — subagent child rows, Agent Teams via `orca claude-teams`, Continue in New Session, permission defaults table.
- https://onorca.dev/docs/agents/session-history, https://onorca.dev/docs/agents/hibernation, https://onorca.dev/docs/model/session-restore, https://onorca.dev/docs/agents/hooks-memory — resume semantics, hibernation guards for orchestration, daemon-owned PTYs, managed status hooks.
- https://onorca.dev/docs/review/annotate-ai-diff, https://onorca.dev/docs/review/github, https://onorca.dev/docs/review/linear, https://onorca.dev/docs/review/attribution, https://onorca.dev/docs/review/diff-viewer — batch review loop, Fix broken checks, worktree-from-issue, image injection from Linear, attribution.
- https://onorca.dev/docs/browser/design-mode, https://onorca.dev/docs/browser/overview, https://onorca.dev/docs/cli/computer-use — pointer-to-code context, agent-scriptable browser/desktop.
- https://onorca.dev/docs/agents/usage-tracking, https://onorca.dev/docs/agents/codex-hot-swap — usage roster, account switch semantics.
- https://onorca.dev/docs/remote-servers, https://onorca.dev/docs/ways-to-run, https://onorca.dev/docs/settings, https://onorca.dev/docs/terminal, https://onorca.dev/docs/model/tabs-panes-splits — run modes, experimental toggles (Dashboard, Chat UI, Cloud VM, orchestration), floating terminal "supports orchestration setup", Copy Context.
- https://github.com/stablyai/orca/issues/17943 (opened 2026-09-01) — worker-start injects task into zsh when agent unavailable.
- https://github.com/stablyai/orca/discussions/681 (Apr–May 2026) — origin of orchestration; role/cost-routing proposal; maintainer note on experimental shipping.
- https://superset.sh/compare/orca-vs-conductor (2026-08-30) — "fleet of independent agents you supervise"; Orca consumes MCP without exposing one.
- https://lobehub.com/de/mcp/buildcontext-orca-mcp — community MCP bridge as stopgap for issue #13079.
- https://www.sfeir.com/articles/orca-ade-flotte-agents-paralleles (2026-08-28) — yolo default critique, worktree ≠ sandbox, shared rate-limit caveat.
- https://blog.margrop.net/en/post/orca-parallel-ai-agent-ide-review (2026-08-19) — 5× token cost, "more parallel code generation means more review work".
- https://evomap.ai/blog/orca-ai-review-parallel-coding-reduce-rework (2026-08-31) — worktree does not isolate runtime resources; human merge gate.
