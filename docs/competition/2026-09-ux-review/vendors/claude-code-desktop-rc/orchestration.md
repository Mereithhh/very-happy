# Claude Code Desktop + Remote Control + Web + Cowork/Dispatch — Workflow abstraction & orchestration

Lens: how Anthropic's own surfaces abstract "work" above a single chat, and what that implies for very-happy.
Read date: 2026-09-03. All claims labeled **[OBS]** (seen in official docs/changelog/digests) or **[INF]** (my inference).
Product state changes weekly (Claude Code v2.1.258 as of 2026-09-01); every finding cites the page it came from.

---

## 1. The mental model Anthropic sells

**[OBS]** There is no single "control plane". Anthropic ships *four stacked models*, each with its own surface, and the docs explicitly tell you to pick by "who holds the plan":

| Layer | Primitive | Who coordinates | Surface |
|---|---|---|---|
| Inside one session | Subagents (background by default, fork mode on by default), dynamic workflows (a JS script Claude writes), `/loop`, `/goal`, `/btw` side chat | Claude, turn by turn (or the script) | Chat + Desktop *tasks pane* / CLI `/tasks`, `/workflows` |
| Between sessions you run | Sidebar tabs with automatic worktrees; cross-session messaging (`ListAgents`/`SendMessage`); "task chips"; Claude can list/rename/archive/message your other sessions | **You** (Claude only passes notes) | Desktop sidebar; CLI `claude agents` (agent view) |
| Claude-supervised fleet | Agent teams (lead + teammates + shared task list + mailbox) | Claude (the lead) | **CLI only, experimental, off by default; not in Desktop** |
| Above sessions (no human at the keyboard) | Dispatch (Cowork), Routines (cloud: schedule / API / GitHub triggers), Desktop scheduled tasks (local), Channels (Telegram/Discord/iMessage → running session), Auto-fix PR, Slack/Claude Tag | Trigger + saved prompt; Dispatch routes | Cowork tab; claude.ai/code/routines; Desktop "Routines" list |

Sources: agents comparison page ("The right one depends on whether you want to stay in each conversation yourself, hand tasks off and check back later, or have Claude coordinate a group of workers for you") — https://code.claude.com/docs/en/agents ; workflows comparison table ("who decides what runs next") — https://code.claude.com/docs/en/workflows ; "Work when you are away from your terminal" table — https://code.claude.com/docs/en/platforms .

**[OBS]** The dominant everyday model in Desktop is **"sessions as sidebar tabs, each in its own worktree"**: "In the Code tab, each conversation is a session: it has its own chat history, project folder, and code changes, independent of any other session. The sidebar lists your sessions and lets you run several in parallel." Filters by status/project/environment, group by project, Cmd-click to split two sessions side by side, Ctrl+Tab to cycle. (https://code.claude.com/docs/en/desktop)

**[OBS]** The CLI's parallel model is **"agent view = a table of rows grouped by what needs you"**: `Pinned / Ready for review / Needs input / Working / Completed`, each row a Haiku-written one-line headline, a PR label `#1234` colored by CI/review state, `Space` to peek+reply without opening the transcript, `Enter` to attach. Docs explicitly say "Most of the time the peek panel is enough and you don't need to open the full transcript." (https://code.claude.com/docs/en/agent-view)

**[OBS]** Remote Control's model is **"the phone/browser is a window into the local session"**, not a separate runtime: "The web and mobile interfaces are a window into that local session." (https://code.claude.com/docs/en/remote-control)

**[OBS]** Dispatch's model is **"one persistent thread that routes to workers"**: "Instead of starting a new session for each task, you have a single persistent thread with Claude... When you assign a task, Claude figures out what kind of work is needed and spins up the right session. Development tasks run in Claude Code; knowledge work runs in Cowork... Claude messages you the outcome (a spreadsheet, a memo, a comparison table, a pull request) rather than showing you every step." Limitation: "One continuous thread. There's no way to start a new thread or manage multiple threads." (https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork , updated 2026-09-02)

**[INF]** Net: Anthropic's "chief of staff" is Dispatch, and it is deliberately a *router + notifier*, not a manager. The manager role (assign, supervise, re-plan) exists only in experimental CLI agent teams, and Desktop explicitly does not ship it ("Agent teams... are available in the CLI, not in Desktop. For multi-agent work inside one session, use dynamic workflows... Claude can also message and manage your other sessions directly." — desktop doc).

---

## 2. Inventory of mechanisms (with user-visible behavior)

### 2.1 Inside a session

- **Subagents** [OBS]: since w27 (late June 2026) subagents run in the background by default; since v2.1.232 (w33) fork mode is on by default, so Claude can spawn a `fork` subagent that inherits the full conversation + prompt cache; `/subtask` starts one manually. Up to 20 concurrent subagents by default (w30). Desktop shows them in a **tasks pane** ("subagents, background shell commands, and dynamic workflows... Click any entry to see its output in the subagent pane or stop it"). Remote Control: from v2.1.243 (Aug 28) foreground subagent tool calls stream live to phone/web; background subagents "still show status only". (https://code.claude.com/docs/en/whats-new/2026-w33 , https://code.claude.com/docs/en/whats-new/2026-w30 , https://code.claude.com/docs/en/desktop , changelog Aug 28)
- **Dynamic workflows** [OBS]: Claude writes a JavaScript orchestration script (`agent()`, `pipeline()`, `parallel()`, `phase()`), runtime executes it in the background; intermediate results live in script variables, not context; runs are resumable/replayable (deterministic: `Date.now()`/`Math.random()` throw); caps 16 concurrent, 1000 agents/run; "Large workflow" warning at >25 agents or >1.5M projected tokens; saved runs become `/<name>` commands in `.claude/workflows/`; can ship in plugins; `ultracode` keyword or `/effort ultracode` makes Claude plan workflows for every substantive task. Desktop shows an approval card (name, phase list, token caution; Once/Always/Deny) and progress in the Background tasks pane. Constraint: "No mid-run user input — only agent permission prompts can pause a run." (https://code.claude.com/docs/en/workflows)
- **`/loop` and cron tools** [OBS]: `CronCreate/CronList/CronDelete`; session-scoped, fires only when idle, 7-day expiry, jitter; `/loop` with no prompt runs a built-in maintenance prompt ("tend to the current branch's PR: review comments, failed CI, merge conflicts; cleanup passes when nothing pending"), replaceable via `loop.md`; self-paced mode where Claude picks the next delay (1 min–1 h) and prints why. (https://code.claude.com/docs/en/scheduled-tasks)
- **`/goal`** [OBS]: "After every turn, a fast model checks whether the condition holds; if not, Claude starts another turn instead of handing control back." Works in interactive, `-p`, and Remote Control. (https://code.claude.com/docs/en/whats-new/2026-w20)
- **Side chat `/btw`** [OBS]: Desktop `Cmd+;` opens a side chat that reads the main thread but writes nothing back; not persisted to disk; local/SSH/WSL only. CLI `/btw` is "single-turn with no tool calls, but has full context" (power-user tips). Aug 2026 changelog: `/btw` history browsing via `Shift+←/→`, and `←` in a `/btw` panel inside `claude agents` returns to the list. (https://code.claude.com/docs/en/desktop , https://support.claude.com/en/articles/14554000-claude-code-power-user-tips , changelog Sept 1)

### 2.2 Between the sessions you run yourself

- **Automatic worktrees** [OBS]: Desktop gives every session its own worktree under `<root>/.claude/worktrees/` (configurable location + branch prefix; `.worktreeinclude` for gitignored files); archive icon removes the worktree; "Auto-archive after PR merge or close". Agent view does the same for background sessions but *lazily* ("Before editing files, Claude moves the session into an isolated git worktree") and instructs Claude to commit/push/draft-PR before finishing so work survives deletion. Remote Control server mode has `--spawn worktree` and a runtime `w` toggle. (desktop, agent-view, remote-control docs)
- **Cross-session messaging** [OBS]: tools `ListAgents` / `SendMessage`; `@name` typeahead to target a session (v2.1.232); delivery between tool calls, or starts a new turn if idle; `notify_when_idle` one-shot subscription ("Tell me when the migration session finishes"); inbound policy `accept | hold | refuse` (`crossSessionInbound`), default policy derived from the two sessions' permission-mode classes (bypass vs prompting), held messages need a human approval dialog with `dialogExpiry` (5 min); `isolatePeerMachines` forces approval before any message leaves the machine; loops throttled, bursts refused; cross-machine and cloud delivery only while connected to Remote Control. Desktop renders a received message "as a card labeled with the sending session's title and a link back"; CLI collapses to a one-line `Message from @sender: ...` preview (v2.1.247). Safety: a message "can't approve anything", "can't change configuration", commands in it don't run. (https://code.claude.com/docs/en/cross-session-messaging , https://code.claude.com/docs/en/desktop)
- **Claude as light-weight session manager (Desktop)** [OBS]: "Claude can list your other Code tab sessions, read what each has been doing, and send messages between them. Ask in plain language: 'which session touched the auth refactor?', 'what did the API session conclude?', 'tell the payments session the schema changed'." Also rename/archive (archive always asks, even in Bypass). Scope: only Desktop-run local/SSH/WSL sessions, not cloud/CLI/VS Code sessions, 20 most recent, never the asking session. (https://code.claude.com/docs/en/desktop)
- **Task chips** [OBS]: "When it notices something worth fixing that's out of scope for the current task, it offers the work as a task chip in the chat. Click the chip to start that work in a new session with its own worktree; Claude continues your current session uninterrupted." (https://code.claude.com/docs/en/desktop)
- **Agent view (`claude agents`)** [OBS]: dispatch input at the bottom (every prompt = a new session; `@repo` targets a sibling repo/worktree; `agent-name` first word or `@agent` runs a custom subagent as the session's main agent; `! cmd` runs a PTY shell job as a row; `/model opus` changes the dispatch default per view); `Ctrl+T` pin keeps the process alive while idle; `Ctrl+S` group by directory; filters `s:blocked`, `a:<agent>`, `#PR`; footer hint in normal sessions shows `← 2 agents` waiting on you; terminal notifications with `agent_needs_input` / `agent_completed` hook types; supervisor process survives shell close and sleep; `claude --bg`, `claude attach/logs/stop/rm`; `/bg` and `/fork` (copy a session into a background row, carrying model/mode/effort/grants). Aug 27 fix: "agent view resurrecting a weeks-old background session after the machine was off". (https://code.claude.com/docs/en/agent-view , changelog Aug 27)

### 2.3 Claude-supervised: agent teams (CLI, experimental)

**[OBS]** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; lead spawns named teammates (naming a subagent spawns a teammate); shared task list with dependencies and file-lock claiming; mailbox JSON per agent; teammates can self-claim; hooks `TeammateIdle`, `TaskCreated`, `TaskCompleted` as quality gates; teammate permission prompts bubble to the lead's terminal; plan approvals from teammates are auto-granted by the lead session; limitations: no resume with in-process teammates, task status lags, one team per session, no nested teams, lead fixed. Not available in Desktop or `-p`. Also note w33: task-tracking tools (`TaskCreate`, `TodoWrite`) are **off by default on Opus 4.8/Sonnet 5/Fable 5+** unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. (https://code.claude.com/docs/en/agent-teams , https://code.claude.com/docs/en/whats-new/2026-w33)

### 2.4 Above sessions: triggers and routing

- **Dispatch** [OBS]: lives in Cowork tab; pairing = Desktop app + mobile app, Pro/Max only (limited beta), machine must be awake; sessions it spawns show a **Dispatch badge** in the Code sidebar; push notification "when it finishes or needs your approval"; app approvals in Dispatch-spawned sessions expire after 30 min; memory carries across tasks; cannot start new threads. Changelog has "Fixed messages in Cowork Dispatch not getting delivered" (search snippet, fr changelog). (support article 13947068; https://code.claude.com/docs/en/desktop#sessions-from-dispatch)
- **Routines (cloud)** [OBS]: research preview; a saved prompt + repos + connectors + environment; triggers = schedule (min 1 h, stagger), **API** (`POST .../routines/<id>/fire` with per-routine bearer token, `text` payload wrapped in `<routine-fire-payload>` labeled untrusted so the prompt must opt in), **GitHub** (pull_request / release events with filters: author/title/body/base/head/labels/draft/merged). Runs autonomously "no permission-mode picker and no approval prompts"; each run = a session in the sidebar; "A green status... does not mean the task in your prompt succeeded." Managed from claude.ai/code/routines, Desktop **Routines** page (Cloud vs Local choice), or CLI `/schedule` (incl. `/schedule why did my nightly review do nothing this morning?` which reads run logs, v2.1.227). (https://code.claude.com/docs/en/routines)
- **Desktop scheduled tasks (local)** [OBS]: same Routines page, choose Local; per-task permission mode, model, folder, worktree toggle; new sessions appear under a **Scheduled** section in the sidebar with a desktop notification; missed runs → exactly one catch-up; per-task "Always allowed" panel to review/revoke saved approvals; a task can reschedule itself via `update_scheduled_task` MCP tool; stored as `~/.claude/scheduled-tasks/<name>/SKILL.md`; scheduled sessions cannot use the desktop cross-session messaging surface. (https://code.claude.com/docs/en/desktop-scheduled-tasks)
- **Cowork scheduled tasks** [OBS]: "Create with Claude" (Claude interviews you, then a Schedule confirm button) or manual modal (name, prompt, approval mode, cadence, model, folder); run remotely in the cloud; "Scheduled" sidebar shows upcoming/past runs; pause/resume/run-on-demand. (https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- **Channels** [OBS]: MCP servers that push events into an *already-running* session (`claude --channels plugin:telegram@...`); two-way chat bridge; sender allowlist via pairing code; optional **permission relay** capability so you can approve tool use from the chat app; `-p` mode disables tools that need terminal input so the session never stalls. (https://code.claude.com/docs/en/channels)
- **Auto-fix PR / CI status bar** [OBS]: Desktop shows a CI status bar after a PR opens; `Auto-fix` (read failure output, iterate) and `Auto-merge` (squash, needs repo setting) toggles; OS notification when CI finishes; optional auto-archive on merge/close. Web: auto-fix subscribes to GitHub events (review comments + check failures); "Ambiguous requests: ... Claude asks you before acting"; replies on GitHub under your account but labeled as Claude Code; `/autofix-pr` from CLI spawns a web session; from mobile "watch this PR and fix any CI failures". (https://code.claude.com/docs/en/desktop , https://code.claude.com/docs/en/claude-code-on-the-web)

### 2.5 Remote surfaces

- **Remote Control** [OBS]: `claude remote-control` server mode (URL + spacebar QR, `--spawn same-dir|worktree|session`, `--capacity 32`, `--name`, resume-after-stop for ~4 h); `/rc` in an existing session; auto-connect for all sessions (`remoteControlAtStartup`, project settings can only turn it *off*); session list on claude.ai/code and mobile Code tab ("computer icon with a green status dot when online"); connected device "shows any subagents and workflows the session already has running... Stop one of them from the device, and Claude Code stops that task"; diff pane computed on the local machine; model/effort pick from device; mid-turn prompts queued; **reconnect queue**: "While the connection is rebuilding, Claude Code queues messages, permission prompts, and status updates from subagents and workflows, and delivers them once the connection recovers"; **push notifications** decided by Claude ("typically... when a long-running task finishes or when it needs a decision"), suppressed while typing/focused in the terminal, `CLAUDE_CLIENT_PRESENCE_FILE` marker to suppress whenever you're at the machine; **session URL reminders** ("Still working — Check in from your phone" after a long turn; "Approve tool calls from your phone" after repeated permission prompts); forwarded dialogs expire after 5 min (`dialogExpiry`) except permission prompts and `AskUserQuestion`, which stay open; Trusted Devices org policy (biometric step-up every 18 h). Aug 26/31 fixes: RC sessions "never showing a permission prompt or the latest messages on the connected device after the CLI silently reconnected"; RC hosted by Desktop/VS Code "stalling for minutes after a tool finished when the connection to claude.ai was degraded". (https://code.claude.com/docs/en/remote-control , changelog)
- **Mobile app Code tab** [OBS]: thin client into cloud sessions, Remote Control, and Dispatch; deep links `claude://code`, `claude://code/{session-id}`, `claude://code/new?q=&repo=&branch=&mode=plan|code`, universal links at https://claude.ai/code/...; permission modes from phone: cloud = Accept edits/Plan/Auto, RC = Manual/Accept edits/Plan (no Bypass, no Auto for RC). (https://code.claude.com/docs/en/mobile , https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link)
- **Cloud vs Local vs SSH vs WSL** [OBS]: environment picker in the prompt area; cloud sessions continue after app close, support multiple repos with per-repo branch selectors, no `@mention`, no terminal/file pane, no plugin browser; SSH installs Claude Code on the remote automatically; managed settings can grey out Local. **Continue in** menu: "Claude Code on the Web" pushes branch, generates a conversation summary, creates a cloud session, offers to archive the local one (needs a clean tree; not for SSH); or "Your IDE". CLI equivalents: `claude --cloud`, `--teleport`, `/tasks`, and **`claude -p "msg" --cloud <session-id>`** which "queues the message into the session and exits without waiting" (usable from CI). (https://code.claude.com/docs/en/desktop , https://code.claude.com/docs/en/claude-code-on-the-web)

### 2.6 Changelog signal for the last ~3 months (June–Sept 2026), orchestration-relevant

[OBS] from https://code.claude.com/docs/en/changelog and the weekly digests:
- w27 (Jun 29–Jul 3): subagents background by default; Desktop on Linux beta.
- w28 (Jul 6–10): Desktop in-app browser; agent view rows get "a colored state word and a classifier-written headline instead of raw tool call text"; sessions linked to existing PRs in `claude agents`; "Background task notifications now explicitly state that no human input has occurred, preventing fabricated in-transcript approvals".
- w30 (Jul 20–24): Desktop iOS Simulator pane; 20 concurrent subagents default; `--max-budget-usd` caps subagents.
- w33 (Aug 10–14): Desktop "Auto-continue when limits reset" checkbox on the session-limit card; fork mode default; `@session` mentions; unique session names per machine; VS Code session groups.
- Aug 25–Sept 1: agent view fixes (dispatch permission mode inheritance, Completed ordering, "waiting to approve a message from another session, or who sent it"); `claude agents` `Ctrl+Enter` dispatch-and-attach; RC live streaming of foreground subagent tool calls; RC prompt-cache miss fix; `SendMessage` reply through Claude Desktop-delivered messages; `desktopSessionCleanupPeriodDays`; cross-session preview collapse; `/schedule` MCP explanation; Workflow tool prompt footprint cut from 5.7k to 1k tokens by moving authoring into a `workflow-authoring` skill.
Pattern [INF]: a large fraction of these entries are reliability fixes for *state sync* between supervisor/background sessions, the RC relay and the Desktop host — the same class of bugs very-happy's verify-queue is full of. Anthropic is paying the same tax.

---

## 3. First-principles judgment

### Does it reduce the operational context a human must hold?

**Where it genuinely does [OBS→INF]:**
1. **State-first grouping instead of transcript-first.** Agent view's `Needs input / Ready for review / Working / Completed` plus a one-line model-written headline and a PR label colored by CI state is the single biggest context-reducer in the whole product. The `← 2 agents` footer hint and the OS/terminal notifications typed `agent_needs_input` / `agent_completed` propagate that state into wherever you are. Desktop gets a weaker version (sidebar filters by status + Dispatch/Scheduled badges + OS notification when a session finishes while unviewed).
2. **Peek-and-reply without attaching.** Numbered choices for `AskUserQuestion`, `Tab` for a suggested reply, `!` for a shell command — the human answers the *question*, not the *session*.
3. **Isolation by default** (worktrees) removes the "will these two collide" worry, and the background-session exit rule (commit/push/draft PR before finishing) removes the "did I lose it" worry.
4. **Presence-aware notification** (skip push while typing in the terminal; marker file for "at the machine") and **queued delivery on reconnect** remove double-notifications and lost prompts.
5. **Messages between sessions arrive labeled, quoted, non-authoritative** (cannot approve, cannot change config, commands are inert), so the human does not need to police a fleet for injection.
6. **Routine "why did my nightly do nothing" is answerable in chat** (`/schedule why...`), and Desktop scheduled tasks list *skipped* runs with reasons.

**Where the human still babysits [OBS→INF]:**
1. **No cross-session state store above the session.** Nothing in Desktop/agent view holds "the project's goal", "who owns what", or a task board. Agent teams' shared task list is per-session, experimental, CLI-only, and the generic todo tools are now *off by default on the newest models*. Dispatch keeps memory but explicitly cannot manage multiple threads. The human is the task board.
2. **Permission prompts still block, one session at a time.** Teammate prompts bubble to the lead; background sessions sit in `Needs input`; forwarded non-permission dialogs expire in 5 min and take the no-action default; `requiresUserInteraction` MCP tools stall scheduled runs every time. There is no "approve this class for all my sessions today" affordance beyond static allow rules and auto mode.
3. **Green ≠ done.** Routines docs say it plainly; agent view's "Completed" collects finished, failed and stopped; workflow verification is only as good as the script. The human must still open the transcript to know whether the outcome is real.
4. **Surface fragmentation.** Desktop's cross-session surface sees only Desktop-run sessions; agent view sees only backgrounded sessions (foreground terminals are invisible until `←`); cloud sessions appear in `ListAgents` only while RC is connected; scheduled sessions can't message; Dispatch is Cowork-tab-only and Pro/Max-only. The human carries the map of which list shows which sessions.
5. **Merging/comparing fan-out results is manual.** `/batch` and workflows fan out; there is no first-class "compare these three candidate branches and pick one" surface; `/fork` explicitly makes copies independent.
6. **Dispatch outputs are pushed as artifacts, not tracked as work items**; there is no queue view of what Dispatch has spawned beyond the badge in the Code sidebar.

### What would a "virtual office of role-bots with a chief of staff" need?

| Need | Already in Anthropic's stack | Clearly lacking |
|---|---|---|
| Durable roles | Subagent definitions reusable as agent-view main agents (`claude --agent code-reviewer --bg`) and as teammates; plugins ship agents | No persistent identity/inbox per role across sessions; a role is a prompt file, not an actor with history |
| Chief of staff that routes | Dispatch routes to Code vs Cowork; task chips propose spin-offs | Dispatch cannot fan out, track, or re-plan; no multi-thread; Team/Enterprise excluded |
| Shared work ledger | Team task list (experimental); Desktop/agent-view PR labels | No project-level board shared by sessions, routines, and the human; todo tools off by default on new models |
| Inter-agent comms with guardrails | `SendMessage` with hold/refuse, quoting, no-approval rule; `notify_when_idle` | Plain text only; no structured handoff (branch, PR, findings) except inside teams |
| Event ingress | Routines (API/GitHub), channels (chat/webhooks), auto-fix PR | Channels need a running session; routines are per-user, no shared org routines; no Linear/Jira triggers (only via connectors inside the prompt) |
| Status roll-up for a human | Agent view headline + state groups; RC push "needs a decision" | No daily digest across sessions/routines/Dispatch; no cost/throughput per role |
| Approval delegation | Auto mode classifier; per-task Always-allowed panel; permission relay in channels | No "approve on behalf of me for N hours" or approval batching across sessions |

---

## 4. What very-happy could borrow (ranked by UX impact, all first-principles, not effort-bounded)

1. **Turn the session list into a state-grouped queue with model-written headlines.** Groups `Needs input / Ready for review / Working / Completed`, a one-line Haiku-class summary refreshed at turn end and every few minutes mid-turn, a PR chip colored by CI. Evidence: agent view docs. very-happy already has session metadata and a relay; the headline is one cheap side-call per turn end.
2. **Peek-and-reply.** From the list, expand a row to see the exact pending question/permission and answer inline (numbered choices, suggested reply, `!` shell). Evidence: agent view "Peek and reply"; RC "Approve tool calls from your phone".
3. **Presence-aware push + reconnect queue.** Suppress push while the web tab/terminal is focused (RC does this; marker-file idea generalizes to "any very-happy client focused"), and queue permission prompts/status while the socket rebuilds. Evidence: RC doc. Fits very-happy's existing resumeSync/liveness rules.
4. **Cross-session messaging with a quoting, non-authoritative envelope and `hold/refuse` policy.** The receiving session shows "Message from @sender" as a card with a link back; messages can't approve or change config; a `notify_when_idle` subscription replaces polling. Evidence: cross-session-messaging + desktop docs. This is the missing substrate for the owner's "assistant" screen.
5. **Task chips.** Let the agent propose out-of-scope work as a clickable chip that spawns a new session in its own worktree without derailing the current one. Evidence: desktop doc. Pairs naturally with very-happy's task board (chip → board card → session).
6. **Routines with three triggers (schedule / API bearer endpoint / GitHub event) and a run history that treats "green" as infra-only.** Evidence: routines doc, incl. the `<routine-fire-payload>` untrusted wrapper and "Run now with text". very-happy's daemon already runs on the owner's Mac, so local routines with worktree isolation + per-task "Always allowed" panel (desktop-scheduled-tasks doc) are the closer analog.
7. **Session URL reminders at the right moment.** "Still working — check in from your phone" after a long turn; "approve from your phone" after N prompts. Cheap, contextual, capped. Evidence: RC doc.
8. **`/btw` side chat as a pane that reads the thread and writes nothing back**, with history browsing. very-happy already has B-283; the borrowable part is the *non-persistence + Cmd+; ergonomics* and the `←` returning to the list.
9. **Continue-in / teleport as first-class moves** with a generated conversation summary and branch push. Evidence: desktop "Continue in" + web `--teleport`. For very-happy: move a session between machines (mac-office ↔ another daemon) with summary + branch.
10. **Deep links** (`app://code/new?q=&repo=&branch=&mode=plan`) so other tools (Slack, Linear, scripts) can open a prefilled new-session composer. Evidence: mobile deep-link article.
11. **Message-into-session from scripts** (`claude -p "msg" --cloud <id>` style; channel socket + token for hooks posting into their own session). Evidence: web doc, cross-session-messaging "inbox socket". very-happy's `docs/channels.md` spawn/send is close; the borrowable part is the *stdin/exit-without-waiting* ergonomics and the own-child verification.
12. **Dynamic-workflow progress view**: phases with agent counts, tokens, elapsed; pause/stop/restart per agent; "Large workflow" warning at 25 agents / 1.5M tokens; save-as-command. Evidence: workflows doc. Even if very-happy never runs scripts, the *phase → agent → result* drill-down is the right visualization for any fan-out.
13. **Per-task "Always allowed" review/revoke panel** for scheduled/unattended work. Evidence: desktop-scheduled-tasks doc.
14. **Auto-archive on PR merge/close + auto-fix/auto-merge toggles on a CI bar.** Evidence: desktop doc.

---

## 5. Anti-patterns to avoid (observed in Anthropic's own stack)

1. **Four overlapping "lists of sessions" with different membership** (Desktop sidebar vs agent view vs claude.ai/code vs `ListAgents`), each with caveats ("Claude doesn't see cloud sessions, or sessions you started from the terminal CLI... never lists the session you're asking from"). One registry, one list, one truth.
2. **Chief-of-staff that cannot hold more than one thread** (Dispatch: "no way to start a new thread or manage multiple threads") and is gated to a plan tier. A dispatcher without a queue becomes a chat.
3. **Silent-default expiry of forwarded dialogs** (5 min → no-action default) and "Completed" bucket that hides failed/stopped — both push the human back into transcripts to learn what happened.
4. **Turning off the shared task tools on the newest models by default** (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to re-enable) while the multi-agent story depends on a shared task list. very-happy's board should remain the agent-visible ledger regardless of model.
5. **Keyword-triggered heavyweight orchestration (`ultracode`)** that can fire from a pasted PR comment (fixed only in v2.1.210 by restricting to human-origin input). Orchestration escalation should be an explicit UI act.
6. **Notification-by-model-judgment only** (RC: "Claude decides when to push... there is no per-event configuration"). Pair model judgment with a small set of deterministic events (needs input, finished, failed) the user can toggle.

---

## 6. Open questions

- Whether Dispatch will get multi-thread or fan-out (docs say limited beta; no roadmap statement).
- Whether Anthropic will surface agent view inside Desktop (today Desktop has sidebar filters and a tasks pane, but no "needs input" grouping or headlines).
- Real-world latency/cost of the Haiku-class headline rewrites at scale (docs say one short request per turn end + every few minutes mid-turn).
- Whether cross-session messaging will carry structured payloads (branch/PR/findings) — today plain text only, team protocol messages stay inside teams.
- Whether routines will support shared/org-owned routines and non-GitHub issue-tracker triggers (today per-user, GitHub PR/release only).
- I could not verify Desktop screenshots of the task chip or the Dispatch badge; those are text-only observations.

---

## Sources (read 2026-09-03)

- https://code.claude.com/docs/en/desktop — Desktop reference: panes, diff comments + Review code, CI bar Auto-fix/Auto-merge, sidebar + worktrees, side chat, tasks pane, work across sessions (cross-session cards, safety behaviors), task chips, cloud sessions, Continue-in, Dispatch badge/30-min approvals, CLI comparison (agent teams not in Desktop).
- https://code.claude.com/docs/en/desktop-quickstart (seed URL `get-started-desktop` 404s; this is the live page) — three tabs, environment picker, first session.
- https://code.claude.com/docs/en/remote-control — server mode flags (`--spawn`, `--capacity`), QR, session list icon, subagent/workflow visibility + stop from device, reconnect queue, push notification rules and presence suppression, URL reminders, dialog expiry, Trusted Devices, "choose the right approach" table.
- https://code.claude.com/docs/en/claude-code-on-the-web — cloud environments, `--cloud`/`--teleport`, `claude -p --cloud <id>`, session sharing/archive/delete, auto-fix PR behavior.
- https://code.claude.com/docs/en/workflows (seed `dynamic-workflows` 404s; this is the live page) — script model, comparison table, approval card in Desktop, caps, resume, size guideline, save/plugin distribution.
- https://code.claude.com/docs/en/scheduled-tasks — `/loop`, cron tools, jitter, 7-day expiry, comparison with Desktop/cloud.
- https://code.claude.com/docs/en/changelog — Sept 1 and Aug 25–31 entries read in full; older fetched portion grepped for Desktop/Remote Control/Dispatch/agent-view/cross-session items. Not every June–August entry was read line by line.
- https://code.claude.com/docs/en/agents — four-way comparison of subagents / agent view / agent teams / workflows; `/batch`, `/fork`, `/subtask`.
- https://code.claude.com/docs/en/agent-view — rows, state icons, Haiku headlines, PR labels, peek/reply, attach, `←` backgrounding, dispatch syntax, `--bg`, worktree isolation rules, deletion rules, dispatch defaults (tail ~5% of the page truncated by the reader).
- https://code.claude.com/docs/en/cross-session-messaging — ListAgents/SendMessage, delivery, notify_when_idle, inbound controls, cross-machine transport, socket/token, limits.
- https://code.claude.com/docs/en/agent-teams — lead/teammates/task list/mailbox, hooks, permissions, limitations.
- https://code.claude.com/docs/en/routines — triggers (schedule/API/GitHub), fire payload wrapper, run history semantics, CLI `/schedule`.
- https://code.claude.com/docs/en/desktop-scheduled-tasks — local tasks, Scheduled sidebar section, missed-run catch-up, Always-allowed panel, self-rescheduling tool.
- https://code.claude.com/docs/en/channels — channel plugins, pairing allowlist, permission relay, comparison table.
- https://code.claude.com/docs/en/mobile — Code tab as thin client, permission modes from phone, attachments.
- https://code.claude.com/docs/en/platforms — surface table and "away from your terminal" table.
- https://code.claude.com/docs/en/whats-new/2026-w20 , 2026-w28 , 2026-w30 , 2026-w33 — dated feature digests (agent view launch May 2026; headline rows + PR links July; iOS simulator; fork default, auto-continue, @session mentions Aug).
- https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork (updated 2026-09-02) — Dispatch persistent thread, routing to Code/Cowork, outcome-only messaging, single-thread limitation, safety chain.
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork — Cowork scheduled tasks UI (Create with Claude / manual, Scheduled sidebar, pause/run now).
- https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile — Cowork surfaces matrix, what requires the desktop app, move between surfaces, phone notification on finish/needs input.
- https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link (May 6, 2026) — `claude://code` deep links and universal links.
- https://support.claude.com/en/articles/14554000-claude-code-power-user-tips — team practices: 3–5 parallel worktree sessions, `/batch`, `/btw` semantics, `/loop` vs `/schedule`, Dispatch description, iMessage plugin.
- https://code.claude.com/docs/llms.txt — docs index used to locate live slugs after two seed URLs 404'd.

Raw page dumps kept under `~/code/github/skills/tmp/vh-competitor-ux/research/competitors/claude-code-desktop-rc/raw/`.
