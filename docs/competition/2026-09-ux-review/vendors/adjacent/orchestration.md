# Adjacent references — workflow abstraction & orchestration (FUTURE thinking)

Lens: how each product abstracts "work" above a single chat — parallel agents, subagents and their visibility, cross-session messaging, an agent that manages agents, scheduled/triggered work, automation surfaces, roles/bots — and whether the mental model actually reduces the operational context a human must hold.

Research date: 2026-09-03. Everything below is marked **OBSERVED** (seen in official docs/changelogs/announcements, or a named third-party hands-on) or **INFERRED** (my reading). This is future-direction input for very-happy, not a spec.

---

## 0. What "grok bot" most plausibly refers to

The owner's note ("参考 grok bot，进一步抽象用户的工作流…做成机器人视角，或者叫 chief staff…虚拟办公室，创建虚拟 bot，每一个 bot 有不同的职能") maps almost verbatim onto one product. Candidates, ranked:

1. **Grok Bot (xAI, beta launched 2026-08-11)** — OBSERVED. "AI teammates you can give real work to": named persistent Bots on a shared cloud computer, group chats of 2–6 Bots, Bot-to-Bot async handoffs, routines, approvals. The launch post literally describes the pattern the owner wants: "People inside SpaceXAI often run multiple Bots in parallel, with one to manage the others. A chief of staff sits on top, with a specialist for each lane: inbox management, expenses, recruiting, bug fixes, or operations." ([introducing-grok-bot](https://x.ai/news/introducing-grok-bot)). The official use-case doc has a "Chief of Staff" role template ([use-cases](https://docs.x.ai/grok-bot/use-cases)). **This is the reference.**
2. **Grok Automations (grok.com, 2026-07-16)** — OBSERVED. Scheduled/email-triggered jobs inside the Grok chat app; each run "opens a real conversation" saved to run history ([grok-automations](https://x.ai/news/grok-automations)). A precursor to Bot routines, not a bot persona.
3. **Grok Build (coding CLI, beta 2026-05-25)** — OBSERVED. A Claude-Code-class harness with parallel subagents in worktrees, `/tasks`, `/workflows` dashboard, ACP. Relevant for the *harness* half of the question, not the persona half.
4. **Grok Companions (Ani/Valentine, July 2025)** — OBSERVED only via search snippets: 3D persona companions; a 2026-08 snippet says xAI is retiring them. Persona-as-entertainment, no workflow abstraction. Not the reference.

---

## 1. Grok Bot — "a small team with one shared computer"

### Mental model sold
"Message it like a teammate", "come back only when your approval is needed", "you're not the middleman". A **Bot = name + job + its own conversation + durable memory**, all Bots share **one user-scoped cloud VM** (files, browser logins, CLI creds) but each gets **its own screen** for parallel computer use ([overview](https://docs.x.ai/grok-bot/overview), [faq](https://docs.x.ai/grok-bot/faq)). Explicitly: "Do not use separate Bots as a security boundary."

### Mechanisms (OBSERVED)
- **Role definition lives in two places**: the Bot *description* holds standing rules ("Never send external messages without approval"); the *conversation* holds task-specific instructions. Docs tell you to promote durable preferences into the description as you discover them ([bots](https://docs.x.ai/grok-bot/bots)).
- **Chief of Staff is a role template, not a system primitive.** Its job: "a source-linked digest of what changed and what needs attention… For each item, include the source, why it matters, the proposed next step, and whether I owe a decision. Do not send messages or change meetings." Then "Tune the Bot by marking what was useful and what was noise. Then schedule the digest" ([use-cases](https://docs.x.ai/grok-bot/use-cases)). Third-party confirmation: "There is no manager Bot type… A 'chief of staff' is just a role you write into a description field" ([eesel](https://www.eesel.ai/blog/grok-bot)).
- **Group chats (2–6 Bots)**: write normally and Bots decide who answers; `@Bot` to assign; `@everyone` sparingly. Kickoff pattern: "@Researcher gather… @Writer turn… @Reviewer check… Do not publish anything." Bot-to-Bot handoff is an async message that **wakes the receiving Bot**; handoffs are visible in the transcript. Docs warn: "Ask for a single owner at each stage. Too many parallel handoffs can create duplicate work and noisy updates" ([chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)).
- **Bots can propose creating Bots**: "Your existing Bots can also suggest or create a focused Bot when a job should have a long-lived owner. Ask before creating several Bots if you want to keep the roster small." Cap 50 Bots+groups per account ([bots](https://docs.x.ai/grok-bot/bots)).
- **Steering**: a direct human message "takes priority over background work and can redirect the current turn"; "Stop now" halts but does not undo ([chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)).
- **Skill vs routine**: skill = how to do a task (shared across Bots); routine = one Bot + when (schedule or event). Ladder: one-off task → correct until reviewable → save as skill → test on second input → routine only when retries/failure cases are defined. **Teach a task** records ≤10 min of browser interaction into a *draft* skill. Event triggers come from Cursor account integrations (Slack message, GitHub notification). **"Test run performs real work"** — no dry run. 50 routines/Bot, 20 run records each; app may **pause routines after a long absence** if you don't respond ([skills-routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)).
- **Approvals**: boundary is set in the request + description; UI offers Allow once / Deny / Always allow. **Auto Review** rules: Require-Approval always stops, Always-Allow proceeds "only when the automated review does not identify another reason to stop"; Require wins on conflict; rules are per-desktop, model-based, "should complement, not replace, least privilege". "An approval controls the proposed action. It does not reverse work already completed." Passwords/2FA/CAPTCHA go through a **computer takeover** handoff, never chat. Local-machine execution defaults to "Ask every time" ([approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)).
- **Attention model**: the Bot list distinguishes **Needs attention** (question, approval, or handoff), **Unread activity** (new result), **Working/typing**; per-Bot OS notification switch fires when that Bot "finishes or needs input"; notifications suppressed while app focused, badge still shows ([settings-and-notifications](https://docs.x.ai/grok-bot/settings-and-notifications)).
- **Memory**: per-Bot "stable preferences, role context, summaries of prior work"; cross-Bot context moves only via shared files, browser sessions, group messages, direct handoffs. No memory inspection/export documented ([faq](https://docs.x.ai/grok-bot/faq); [vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown)).
- **Cost/limits**: standalone $200/mo, bundled with Cursor/SuperGrok tiers; weekly usage pool; third-party tests hit weekly limits mid-swarm and the swarm "gets stuck mid-task" ([composio](https://composio.dev/content/guide-to-frok-bot), [vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown)).

### First-principles judgement (INFERRED)
- The persona layer is *thin* (a description field + a separate conversation + separate memory) but it is exactly what makes the product feel like delegation rather than prompting: each Bot is a **stable address** you can @-mention, an **owner** of a routine, and a **row with an attention state**. That triple is the real abstraction.
- Where the human still babysits: approving (no product-enforced always-stop list), teaching (skills start as drafts), re-testing routines after any site/connector change, watching weekly usage, and — critically — nothing in the product prevents duplicate work across Bots except advice ("single owner per stage").
- "Chief of staff" reduces context only because it is *scheduled* and *source-linked* and asks "do I owe a decision?" — i.e. it converts a fleet into a **decision inbox**. That is the borrowable insight, not the persona cosmetics.

---

## 2. Grok Build — the harness half (subagents as tasks with a dashboard)

OBSERVED: Rust TUI (Apache-2.0 source published, with in-tree ports of openai/codex and sst/opencode tool implementations) ([github](https://github.com/xai-org/grok-build)). Runs interactive, headless (`-p`, streaming-json) or via ACP ([overview](https://docs.x.ai/build/overview)). Subagents "run in parallel… each child runs in parallel with its own context window… launch subagents in their own worktrees"; plan mode blocks edits until approval; ambiguous tasks get a multiple-choice Q&A ([x.ai/build](https://x.ai/build)).

Orchestration surface in the TUI ([modes-and-commands](https://docs.x.ai/build/modes-and-commands), [changelog](https://x.ai/build/changelog)):
- `/tasks` lists background tasks, subagents, scheduled tasks; the tasks pane groups **Subagents → Tasks → Watchers** (changelog 2026-05-30); idle row says "1 subagent still running".
- `/workflows` is a **fullscreen live run dashboard**; `/create-workflow` has Grok author a `.rhai` script (fan-out, verify, scope) saved per project/user; `/deep-research` is a built-in background workflow.
- `/fork` = "branch the current session into a peer agent"; `/sessions` opens the **Agent Dashboard** (2026-07-09); `/goal` slash command; `/loop [interval]`; `/btw` side question; `/personas`, `/agents`.
- Auto mode uses a classifier to auto-approve safe tools; always-approve still honours deny rules and hooks.

INFERRED: Grok Build shows the convergence point every harness is reaching — background tasks, subagents, watchers and scheduled loops are **one ledger with one dashboard**, and orchestration is scripted (deterministic file) rather than improvised by the model. Same idea appears in pi-subagents' `SubagentWorkflow` and OpenClaw's automations.

---

## 3. Claude Cowork Dispatch + scheduled tasks — "one thread, a router, outcomes only"

OBSERVED ([Dispatch](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork), updated 2026-09-02):
- "Instead of starting a new session for each task, you have a **single persistent thread** with Claude. This thread doesn't reset."
- "When you assign a task, Claude figures out what kind of work is needed and **spins up the right session**. Development tasks run in Claude Code; knowledge work runs in Cowork. These sessions appear in their respective sidebars."
- "Claude messages you the **outcome** (a spreadsheet, a memo… a pull request) rather than showing you every step." Push when done or when "Claude needs your go-ahead."
- Runs on the desktop (must be awake) — distinct from cloud sessions; limitation: **no multiple threads**; memory carries across sessions and is user-editable.

OBSERVED ([scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)): each scheduled task "runs as its own Cowork session"; runs remotely; "Scheduled" sidebar lists upcoming/past runs; two creation paths — **Create with Claude** (asks multiple-choice questions, then outputs name/schedule/what it does, you click "Schedule") or **Set up manually** (name, prompt, approval mode, cadence, model, folder); a task needing local files "will only run locally".

INFERRED: Dispatch is the purest "chief of staff" UI in the set — a dispatcher thread that owns routing to *typed* workers (Code vs Cowork) and reports outcomes. Its weakness is the flip side: one thread means no parallel conversations, and you don't see the fleet unless you open the sidebars. For very-happy, the important observation is that the **dispatcher and the worker sessions are different surfaces linked by a spawn edge**, not one blended transcript.

---

## 4. ChatGPT — Scheduled page as inbox, event triggers, Pulse briefs, workspace agents

OBSERVED ([tasks help](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt), updated ~2026-08-28):
- **Scheduled** page = create/review/pause/resume/edit/delete; open from Settings or from a conversation's "See scheduled tasks". Notifications push/email.
- **Event-triggered tasks** (Gmail/Slack/GitHub) run in **Work**: "Review **Trigger**, **Condition**, and **Prompt**"; Slack needs `@ChatGPT` in each monitored channel; GitHub responds to PR activity. Up to 30/hr, 720/day across tasks; events may be grouped.
- "Actions that require approval may **pause the task**" until reviewed.
- **Monitoring tasks** "check for changes and send a notification when a relevant update occurs. They can use information from previous runs and stop when a defined end condition is met."
- Task **sharing** = link to a snapshot (title, instructions, schedule, tz) — no history, no credentials; recipient schedules their own copy.
- Limits per plan (3/5/10/15 active tasks); Codex automations are separate.

OBSERVED ([Pulse](https://openai.com/index/introducing-chatgpt-pulse), 2025-09-25): nightly async research from memory + chats + connected Calendar/Gmail → morning **topical cards**; "curate" to steer; thumbs up/down; each update "available for that day only unless you save it as a chat or ask a follow-up".

OBSERVED ([ChatGPT Work](https://openai.com/index/chatgpt-for-your-most-ambitious-work), 2026-07-09; [workspace agents](https://openai.com/index/introducing-workspace-agents-in-chatgpt), 2026-04-22): Work is a distinct surface next to Chat and Codex; "You decide what it can access, when it should check in, and when it needs your approval". Workspace agents are shared org-level agents "powered by Codex in the cloud", built by describing a workflow, can run on a schedule or be **deployed in Slack**, require approval for sensitive steps (edit spreadsheet, send email, add calendar event), with run analytics and templates.

INFERRED: OpenAI's abstraction is **task-as-object** (trigger/condition/prompt, run history, pause state, share link) rather than bot-as-persona. Pulse is the cleanest example of "proactive brief" UX: ephemeral cards you promote into durable work by acting on them. Both are worth stealing without the persona wrapper.

---

## 5. OpenClaw — a gateway where agents, sessions, channels and automations are all first-class

OpenClaw is the most complete *self-hosted* model of the "virtual office", so this section is longer.

### Mental model (OBSERVED)
"The Gateway is the single source of truth for sessions, routing, and channel connections" ([docs home](https://docs.openclaw.ai/)). Architecture case: **trusted gateway, untrusted/movable execution, policy enforced in code**; sandboxing off by default; "the same product runs as a personal assistant on one laptop and as a hardened team deployment, with configuration as the only difference" ([why-openclaw](https://docs.openclaw.ai/start/why-openclaw)). pi.dev cites OpenClaw as its real-world SDK integration; OpenClaw also runs Claude Code / Codex / Gemini CLI as ACP harness sessions.

### Agents = persona scopes; bindings = routing (OBSERVED)
- An **agent** is "the full per-persona scope: workspace files, auth profiles, model registry, and session store". Workspace bootstrap files: `AGENTS.md` (operating instructions + memory), `SOUL.md` (persona, boundaries, tone), `IDENTITY.md` (name/vibe/emoji), `USER.md`, `MEMORY.md` ([agent](https://docs.openclaw.ai/concepts/agent)).
- A **binding** maps (channel, account, peer/guild/team) → agent, deterministic, most-specific wins; e.g. WhatsApp → fast everyday agent, Telegram → Opus "deep work" agent, one family group → sandboxed agent with a tool allowlist ([multi-agent](https://docs.openclaw.ai/concepts/multi-agent)).
- **Agent provenance**: OpenClaw records whether an agent was created by operator, agent, or install; "a configured agent can ask OpenClaw to create another agent… creates the agent only after operator approval"; `openclaw agents list --tree` shows the creation tree.

### The main session as "Home" — where the fleet converges (OBSERVED)
- "every direct message you send it… lands in one rolling conversation: the main session… There is one brain, and this is where it thinks." In the web app it is the **Home** page; forks appear under Threads, group chats under Groups, coding sessions under Coding ([main-session](https://docs.openclaw.ai/concepts/main-session)).
- What flows in: **group activity** as "compact notices — coalesced per conversation, never one wake-up per message"; **background work** ("sub-agents and spawned sessions announce their results back to the session that started them"); **heartbeats**.
- **Heartbeat** = scheduled main-session turn whose contract is "If nothing needs attention, reply `NO_REPLY`"; a `heartbeat_respond` tool with `notify:false` keeps silent but is "remembered as bounded internal context for the next user turn"; active hours; deferred while other work runs; explicitly "does not infer or repeat old tasks from prior chats" ([heartbeat](https://docs.openclaw.ai/gateway/heartbeat)).

### Automations (OBSERVED, [cron-jobs](https://docs.openclaw.ai/automation/cron-jobs))
- Schedule kinds: `at`, `every`, `cron`, `on-exit` (fires when a watched command exits), `stream` (fires from batched stdout lines of a supervised process). **Trigger scripts** are headless condition watchers with persisted `state` (e.g. "fire only when PR CI status differs from last evaluation").
- Payload kinds: system event (into main session, no model call), agent message (model turn), command (no model), script (code-mode, tool budget). Session targets: `main`, `isolated` (`cron:<jobId>`), `current`, `session:custom-id`.
- **Promotion instead of authoring**: "When you ask for substantially the same job several times, the agent offers to turn it into a schedule… The confirmation restates the schedule and the task in plain words… Confirm that sentence, not a cron expression." On confirm it creates the job **enabled**, immediately runs it once **as a visible test** delivered to the same thread, and removes it if the test fails. Rationale: "Nothing supervises a disabled job."
- Failing jobs auto-disable after repeated errors with owner notified; **pacing** lets the job propose its own `next_check`; `/loop [interval] <prompt>` binds a recurring job to the current conversation.

### Sub-agents and cross-session messaging (OBSERVED)
- `sessions_spawn` returns immediately; completion is **push-based**: "do not poll… check status on-demand only when debugging". Parent calls `sessions_yield` to end its turn and receive the child result as the next message. The completion handoff carries `Result`, `Status`, token stats, and "a review instruction telling the requester agent to verify the result before deciding whether the original task is done" ([subagents](https://docs.openclaw.ai/tools/subagents)).
- `delegationMode: prefer` tells the main agent to "stay responsive and delegate anything more involved than a direct reply"; hidden subagents are for legwork, `visible: true` puts a child in the sidebar when "the user will watch or return to" it. Nested depth is configurable; native sub-agents "do not get the message tool" — only the parent talks to humans.
- Undeliverable results are **retained 7 days** and appear blocked on the Tasks page with retry/dismiss.
- `sessions_send` runs another session (fire-and-forget or wait), with an optional bounded **reply-back loop** (`REPLY_SKIP` to stop) and `watch:true`. Inter-session text is marked `[Inter-session message … isUser=false]` so the receiver treats it as data. `sessions_list` supports "mailbox-style triage" (derived title, last-message preview, run status). `sessions` tool can `assign_owner` (human or agent — "display and responsibility, not access control") and manage sidebar groups. UI-only tools `suggest_task` / `dismiss_task` exist for task suggestions ([session-tool](https://docs.openclaw.ai/concepts/session-tool)).
- **Session state awareness**: a durable per-session signal log (`human_direct_message`, `goal_changed`, `child_spawned`, `run_completed/failed`, `compacted`); parents are auto-watchers of children; a watcher gets **one coalesced notice** ("Session X changed (other actor). Reconcile before acting: session_status … changesSince 12") with self-suppression and a frozen watermark; reconciliation is an exact typed delta ([session-state](https://docs.openclaw.ai/concepts/session-state)). This is the machinery a "chief of staff" needs when a human jumps into a worker session directly.

### Control UI (OBSERVED, [control-ui](https://docs.openclaw.ai/web/control-ui), [dashboards](https://docs.openclaw.ai/web/dashboards))
- Each running session shows a **live digest headline** (model's "safe preamble" immediately, a utility model's richer digest later) that also becomes the sidebar subtitle and is shared with the iOS/Android lists; a **session rail** pill expands to assessment, plan progress, PRs, elapsed time, and a read-only **side chat** (`/btw`, `/side`) that answers questions about the session without interrupting it.
- Pending approvals contribute an **attention chip** above the sidebar footer, linking to an Approvals page; inline approvals from another session are labelled "Approval requested by session <title>".
- **Tasks tab**: background tasks and subagents with elapsed timer, tool-use count, current tool, stop; parent sessions have expandable child rows; Automations page has stat cards (count, failing, next wake) + run history.
- Every thread has "two faces": chat and a **dashboard** of agent-built sandboxed widgets that survive `/new`; widget clicks reach the agent "quietly as session notices".
- Sessions carry "an immutable creator, an assignable owner, and the people who actually prompted"; broker-created PRs link back to the session ([why-openclaw](https://docs.openclaw.ai/start/why-openclaw)).

### ACP harness sessions (OBSERVED, [acp-agents](https://docs.openclaw.ai/tools/acp-agents))
`/acp spawn claude --bind here` pins a chat conversation to a Claude Code ACP session; persistent vs oneshot; agents can have `runtime.type="acp"` defaults; parent-owned one-shot ACP runs "are background children, similar to sub-agents" reporting through the same completion path. `pi` is registered as an acpx backend but "is not a coding harness in the same sense".

### Judgement (INFERRED)
OpenClaw is the one product here that made the *orchestration layer* the product: agents, sessions, conversations, tasks, automations and approvals are separate typed objects with a shared ledger, and the human's context is explicitly funneled into one place (Home + attention chip + Tasks). The cost is configuration surface (JSON5 bindings, sandbox posture, tool profiles) and that the "chief of staff" is still a prompt (`delegationMode`, heartbeat scratch) sitting on a very good substrate. It is closest to what a "virtual office" needs, and it already treats Claude Code as one worker type among several.

---

## 6. pi — what a harness gives you, and role-bots on pi vs on the Claude Code SDK

OBSERVED:
- Packages: `pi-ai` (unified multi-provider LLM API), `pi-agent-core` (agent loop, tool calling, state), `pi-coding-agent` (CLI + SDK + RPC), `pi-tui`, `pi-telemetry`. **No built-in permission system** — "By default, it runs with the permissions of the user"; containerise via Gondolin micro-VM, Docker, or OpenShell ([repo](https://github.com/badlogic/pi-mono)).
- "Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package"; four modes — interactive, print/JSON, **RPC** (JSONL over stdin/stdout), **SDK**; 15+ providers; sessions stored as **trees** with `/tree`, `/fork`, `/clone`, branch summaries; steer (`Enter`) vs follow-up (`Alt+Enter`) ([pi.dev](https://pi.dev), [sessions](https://pi.dev/docs/latest/sessions)).
- SDK: `createAgentSession()` → `AgentSession` with `prompt/steer/followUp/subscribe/navigateTree/compact/abort`; `AgentSessionRuntime` owns `newSession/switchSession/fork/importFromJsonl`; a typed event stream (`tool_execution_*`, `turn_*`, `queue_update`, compaction, retries) ([sdk](https://pi.dev/docs/latest/sdk)).
- Extensions: `tool_call` can **block or mutate** a call (`permission-gate.ts`, `protected-paths.ts` examples), `before_agent_start` injects context, `context` filters history, custom tools/commands/shortcuts, `ctx.ui` widgets/status/dialogs; in RPC mode UI dialogs become an `extension_ui_request/response` sub-protocol so a remote client can answer them ([extensions](https://pi.dev/docs/latest/extensions), [rpc](https://pi.dev/docs/latest/rpc)).
- Ecosystem (catalog, 2026-09-03): `@tintinweb/pi-subagents` (~48K/mo) gives Claude-Code-style `Agent` tool, background parallelism with concurrency cap, **FleetView**, live widget, conversation viewer with inline steering, custom agent types in `.pi/agents/*.md`, nested subagents with depth cap and privilege allowlist, `@agent` mentions that spawn/resume/steer, deterministic `SubagentWorkflow` scripts (`agent/parallel/pipeline`, gates like `npm test`), worktree isolation, a `schedule` field on `Agent` (cron/interval/one-shot, session-scoped), event bus + cross-extension RPC ([pi-subagents](https://github.com/tintinweb/pi-subagents)). Also `@chankov/agent-fleet` ("Pi as the primary runtime, Herdr as the workspace control plane…"), `pi-memory`, `pi-multikey`, `pi-tasks` ([packages](https://pi.dev/packages)).
- `pi-chat`: Discord/Telegram → one sandboxed pi session per channel in a Gondolin VM, account/channel memory files, agent-created skills, encrypted secret exchange, tmux-managed workers with a `chat_workers` tool "exposed to an orchestrating pi agent" ([pi-chat](https://github.com/earendil-works/pi-chat)).

INFERRED — building role-bots on pi vs on Claude Code SDK:
- **What pi gives**: full ownership of the loop (system prompt, context assembly, compaction, tool policy, model routing per role), a stable typed event stream for a web renderer, tree sessions (branch/compare/merge is native), multi-provider (a cheap model for digests, a strong one for code), and an extension API where "permission gate", "subagent", "scheduler" are ordinary modules — so very-happy's wire schema could be the *only* protocol. Cost: you re-own everything Claude Code gives free (tool implementations, hooks, skills discovery, plan mode, MCP, subscription auth, model-side prompt caching tuned for CC), and pi has no permission system unless you write one.
- **What Claude Code SDK gives**: the best-tuned coding worker with permission callbacks, hooks, subagents and `/btw`-style side queries already proven in very-happy (铁律 8/18). Cost: role-bots must live *outside* the harness (metadata, capabilities), you cannot change the loop, one provider.
- The realistic split seen in the field (OpenClaw, Grok Build via ACP, pi-subagents) is **a control plane that owns roles/routing/attention, and typed workers underneath** — Claude Code via SDK/ACP for code, a pi (or pi-agent-core) session for chief-of-staff/digest roles where you want cheap models, injected context and no filesystem risk. Nothing observed argues for replacing Claude Code as the code worker; everything argues for not making it the chief of staff.

---

## 7. Cross-cutting judgement: does the abstraction reduce the human's operational context?

| Product | Mental model | Reduces context by… | Human still babysits… |
|---|---|---|---|
| Grok Bot | team of teammates on one computer | stable addresses + attention states (needs-attention / unread / working) + scheduled source-linked digests | approvals (advice-based), duplicate work across Bots, re-testing routines, usage limits |
| Grok Build | one TUI, tasks ledger + workflows dashboard | typed ledger of subagents/tasks/watchers; scripted fan-out | reading each subagent; plan approval; no cross-machine view |
| Cowork Dispatch | one thread + router + outcomes | dispatcher decides Code vs Cowork; outcome-only messaging; push on done/needs go-ahead | desktop must be awake; single thread; fleet only in sidebars |
| ChatGPT tasks/Pulse/Work | task-as-object; daily cards | Scheduled page as inbox; trigger/condition/prompt; approvals pause; ephemeral cards | curating Pulse; per-plan caps; no cross-task view of *decisions* |
| OpenClaw | gateway control plane; Home converges | Home + heartbeat NO_REPLY + attention chip + Tasks ledger + state watchers; promotion-with-test-run | config; chief of staff is still a prompt; sandbox off by default |
| pi | minimal harness + packages | FleetView + @agent mentions + scripted workflows (extension) | everything policy-shaped is DIY |

INFERRED constants across all six:
1. **A role/bot is (address, standing rules, owner-of-routines, attention state, memory) — nothing more is needed to feel like delegation.**
2. **The thing that actually removes babysitting is a decision inbox**: items that say source / why it matters / proposed next step / *do I owe a decision*. Grok's chief-of-staff template, OpenClaw's heartbeat contract and attention chip, ChatGPT's "approval pauses the task", Cowork's "push when needs go-ahead" all converge here.
3. **Completion must be push, not poll, and it must carry a review instruction** (OpenClaw), otherwise the manager agent either spams or trusts blindly.
4. **Promote, don't author**: routines come from work already done (OpenClaw promotion + visible test run; Grok "save the process as a skill"; Cowork "Create with Claude"). Cron expressions are never the primary UI.
5. **A human entering a worker session must invalidate the manager's assumptions** (OpenClaw signal log). Without it a chief of staff is dangerous.

---

## 8. Mapping to very-happy (what exists, what is missing) — INFERRED, FUTURE

Already there (per repo knowledge): sessions as structured chat, durable tmux terminals, machine pairing, permission requests, task board, notes, notifications, `/btw` side questions, Codex/ACP sessions, a Claude-powered "assistant" screen considered weak.

What a "virtual office of role-bots with a chief of staff" would need that very-happy already has: session objects with metadata/capabilities, permission request plumbing (the approval primitive), a relay that can fan events to a web client, a task board (a place for a decision inbox to live), `/btw` (OpenClaw's side chat equivalent).

What it clearly lacks (and which the references show as load-bearing):
- **Role objects** with standing rules, owner, memory scope and an attention state; sessions today are per-run, not per-role.
- **Attention model** across sessions: needs-attention / unread-result / working, plus one chip for pending approvals.
- **Scheduler with promotion + visible test run** and run history (Grok/Cowork/ChatGPT/OpenClaw all have a "Scheduled" page).
- **Cross-session messaging and push completion with review instruction** — the meta "assistant" cannot manage anything without `sessions_spawn/send/yield` equivalents and a signal log.
- **A digest surface** (OpenClaw session rail headline; Pulse cards) so a manager can summarise the fleet without opening transcripts.
- **Typed workers**: Claude Code SDK for code, something cheaper/looser (pi-agent-core or plain API) for chief-of-staff/digest roles.

---

## 9. Borrowable ideas (ranked by UX impact)

1. **Decision inbox as the chief of staff's only output** — every item: source link, why it matters, proposed next step, "do I owe a decision?" (Grok use-cases; OpenClaw heartbeat NO_REPLY).
2. **Attention states on every session/bot row** — needs-attention vs unread-result vs working, plus a single pending-approvals chip (Grok settings; OpenClaw control UI).
3. **Push-based completion with a review instruction** and `yield` semantics for the manager agent (OpenClaw subagents).
4. **Promotion, not authoring, for routines** — "you asked for this three times; every weekday 07:00 I will …" + immediate visible test run, created enabled (OpenClaw cron; Grok skill→routine ladder).
5. **Live digest headline per session** that doubles as sidebar subtitle and mobile list text (OpenClaw control UI).
6. **Session state signal log + one coalesced notice** when a human touches a worker session (OpenClaw session-state).
7. **Role = description with standing rules, separate from task messages; bots may propose new bots but only with approval** (Grok bots; OpenClaw agent provenance).
8. **Dispatcher chooses worker type** (Code vs knowledge) and reports outcomes, not steps (Cowork Dispatch).
9. **Trigger / Condition / Prompt as the triple for event-driven work**, with "approval pauses the task" (ChatGPT tasks; OpenClaw trigger scripts with persisted state).
10. **Group thread with @-addressed bots and visible handoffs, single owner per stage** (Grok chat-and-collaboration).
11. **Ephemeral daily cards that become durable only when acted on** (Pulse).
12. **Fleet view + @agent mentions from the composer** to steer a running subagent without polluting the main chat (pi-subagents FleetView).
13. **Two faces per thread: chat and an agent-built dashboard of widgets** whose interactions reach the agent as quiet notices (OpenClaw dashboards).

## 10. Anti-patterns to avoid

- **Persona without mechanism** — a "chief of staff" that is only a description field with no scheduler, inbox or signal log (eesel on Grok: "just a role you write into a description field"; the current very-happy assistant screen is in this state).
- **Advice-based approvals** — boundaries in free text with model-based auto-review and no product-enforced always-stop list; "approval does not reverse work already completed", "test run performs real work" (Grok approvals/routines).
- **Shared credentials across bots** presented as a team — "do not use separate Bots as a security boundary" (Grok overview/approvals).
- **Manager that polls** or dumps raw child transcripts into its context (explicitly warned against by OpenClaw subagents).
- **Single-thread dispatcher** with no parallel conversations (Cowork Dispatch limitation).
- **Disabled-pending-approval jobs** that nothing supervises (OpenClaw's stated rationale for creating jobs enabled with a test run).

## 11. Open questions

- Should very-happy's role-bots be *sessions with a role tag* or a new object that owns sessions? OpenClaw chose agent = persona scope with its own session store; Grok chose bot = one long conversation. Which survives `/clear`, compaction and daemon handover better in very-happy's session model?
- Where does the chief-of-staff loop run — on mac-office daemon (near the workers, like Dispatch) or in the relay (always-on, like OpenClaw Gateway / Grok cloud)? Push notifications and heartbeats favour the relay; tool access favours the daemon.
- Is the Claude Code SDK acceptable for the manager role (cost, one provider, no context injection) or does the manager warrant pi-agent-core / raw API with a cheap model?
- How much of OpenClaw's session tools (`sessions_spawn/send/yield/list`, signal log) can be expressed as very-happy wire messages without adopting its gateway?
- What is the minimum "attention model" that works on a PWA with unreliable push (very-happy has no native app)?

---

## Sources (all read 2026-09-03)

xAI / Grok
- https://x.ai/bot — Grok Bot product page: teach a task, group chats, role cards incl. Chief of Staff, plan tiers.
- https://x.ai/news/introducing-grok-bot — 2026-08-11 launch post: chief-of-staff-over-specialists pattern, Bots message each other, group chats, "come back only when approval needed".
- https://docs.x.ai/grok-bot/overview — Bot definition; shared user-scoped computer, per-Bot screen, not a security boundary.
- https://docs.x.ai/grok-bot/use-cases — official role templates; Chief of Staff spec ("whether I owe a decision"); 7-step ladder to a durable Bot.
- https://docs.x.ai/grok-bot/chat-and-collaboration — @mentions, 2–6 Bot groups, async handoffs wake Bots, threads/reactions, redirect/Stop semantics.
- https://docs.x.ai/grok-bot/bots — description vs message split; pin/hide/duplicate/share; 50-cap; Bots may propose new Bots; team-of-Bots guidance.
- https://docs.x.ai/grok-bot/skills-routines-and-automations — skill vs routine; Teach a task ≤10 min; event triggers; test run is real; 50 routines/Bot, 20 runs; pause after absence.
- https://docs.x.ai/grok-bot/approvals-security-and-privacy — Allow once/Deny/Always allow; Auto Review rule precedence; approvals don't reverse; secure handoff; local execution default.
- https://docs.x.ai/grok-bot/settings-and-notifications — attention states (needs attention / unread / working); per-Bot notification switch.
- https://docs.x.ai/grok-bot/faq — one computer-use task per Bot screen; memory model; billing pools.
- https://x.ai/news/grok-bot-and-x — 2026-08-29 X connector/plugin.
- https://x.ai/news/grok-automations — 2026-07-16 Automations in Grok chat: schedules + email triggers, every run a conversation, report-back choices.
- https://x.ai/build — Grok Build features: parallel subagents in worktrees, plan mode, Q&A.
- https://x.ai/news/grok-build-cli — 2026-05-25 Grok Build launch: subagents, worktrees, headless, ACP.
- https://docs.x.ai/build/overview — TUI / headless / ACP modes.
- https://docs.x.ai/build/modes-and-commands — /tasks, /workflows dashboard, /create-workflow (.rhai), /fork peer agent, /goal, /loop, /btw, auto mode classifier.
- https://x.ai/build/changelog — dated entries: Subagents→Tasks→Watchers grouping (2026-05-30), /sessions → Agent Dashboard and /goal (2026-07-09), 1.0.12 (2026-08-27).
- https://github.com/xai-org/grok-build — Rust source, Apache-2.0, ported codex/opencode tool implementations.
- Grok Companions: search snippets only (layer3labs 2026-08-29; x.com 2026-08-02) — persona companions launched July 2025, retirement announced 2026.

Anthropic
- https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork — Dispatch: single persistent thread, router spins Code vs Cowork sessions, outcome messaging, push on done/needs go-ahead, desktop-awake requirement, no multiple threads.
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork — each run its own Cowork session, remote execution, Scheduled sidebar, Create-with-Claude vs manual (approval mode, cadence, model, folder).

OpenAI
- https://help.openai.com/en/articles/10291617-tasks-in-chatgpt — Scheduled page; event-triggered tasks (Trigger/Condition/Prompt) in Work; approvals pause; monitoring tasks; share-as-snapshot; per-plan caps.
- https://openai.com/index/introducing-chatgpt-pulse — 2025-09-25: nightly research → morning cards, curate, ephemeral unless saved.
- https://openai.com/index/chatgpt-for-your-most-ambitious-work — 2026-07-09 ChatGPT Work: Chat/Work/Codex surfaces, check-in/approval controls, scheduled tasks with computer use, Sites.
- https://openai.com/index/introducing-workspace-agents-in-chatgpt — 2026-04-22: shared org agents on Codex cloud, schedules, Slack deployment, approval for sensitive steps, analytics.

pi
- https://github.com/badlogic/pi-mono (→ earendil-works/pi) — package layout; no built-in permission system; containerisation patterns.
- https://pi.dev — four modes, skips subagents/plan mode by design, tree sessions, OpenClaw as SDK integration, steer vs follow-up.
- https://pi.dev/docs/latest — documentation index (SDK, RPC, JSON events, session format).
- https://pi.dev/docs/latest/sdk — AgentSession / AgentSessionRuntime APIs and event list.
- https://pi.dev/docs/latest/rpc — JSONL RPC, extension UI request/response sub-protocol, get_state.
- https://pi.dev/docs/latest/extensions — tool_call block/mutate, context injection, UI, lifecycle diagram, permission-gate example.
- https://pi.dev/docs/latest/sessions — /tree, /fork, /clone, branch summaries.
- https://pi.dev/packages — catalog: pi-subagents, agent-fleet, pi-memory, pi-tasks, dynamic workflows.
- https://github.com/tintinweb/pi-subagents — FleetView, @agent mentions, SubagentWorkflow scripts, nested depth, schedule field, event bus, worktrees.
- https://github.com/earendil-works/pi-chat — Discord/Telegram → sandboxed pi session per channel, memory files, tmux workers, chat_workers tool for an orchestrating agent.

OpenClaw
- https://docs.openclaw.ai/ — self-hosted gateway, multi-channel, Control UI.
- https://docs.openclaw.ai/gateway — runtime model, WS control plane, two-stage agent runs, event list, no replay.
- https://docs.openclaw.ai/concepts/agent — bootstrap files (SOUL/IDENTITY/USER/AGENTS/MEMORY), steering/queue modes.
- https://docs.openclaw.ai/concepts/multi-agent — agent = persona scope; bindings; agent provenance; per-agent sandbox/tools.
- https://docs.openclaw.ai/concepts/session — routing table, DM scope, incognito, reset policies, restart recovery.
- https://docs.openclaw.ai/concepts/main-session — Home; group notices coalesced; background work reports back; memory layers.
- https://docs.openclaw.ai/gateway/heartbeat — NO_REPLY contract, heartbeat_respond, active hours, scratch checklist.
- https://docs.openclaw.ai/automation/cron-jobs — schedule kinds, trigger scripts, payloads, session styles, promotion with visible test run, pacing, /loop.
- https://docs.openclaw.ai/tools/subagents — sessions_spawn/yield, push completion with review instruction, visible children, delegationMode, retention of blocked results.
- https://docs.openclaw.ai/concepts/session-tool — sessions_list triage fields, sessions_send reply-back loop and watch, assign_owner, groups, suggest_task/dismiss_task.
- https://docs.openclaw.ai/concepts/session-state — signal log, watchers, coalesced notice, changesSince.
- https://docs.openclaw.ai/tools/acp-agents — Claude Code etc. as ACP harness sessions, bind to conversation, persistent/oneshot, parent-owned children.
- https://docs.openclaw.ai/web/control-ui — digest headline, session rail, side chat, attention chip, Tasks tab, automations cards, sidebar buckets.
- https://docs.openclaw.ai/web/dashboards — two faces per thread; widget notices.
- https://docs.openclaw.ai/start/why-openclaw — trust boundary/policy-as-code; session creator/owner/prompters; sandbox off by default.

Third-party (hands-on, dated)
- https://composio.dev/content/guide-to-frok-bot — 2026-08-20: shared VM model, swarm simulation, weekly limit stalls.
- https://www.vellum.ai/blog/official-grok-bot-breakdown — 2026-08-20: $200 standalone, no memory inspection, MCP must be public, limited channels.
- https://www.eesel.ai/blog/grok-bot — 2026-08-12: "no manager Bot type", approval model as advice, no dry run, limits.
- https://flaviocopes.com/grok-bot — 2026-08-22 (upd. 08-30): component list; "fresh focused Bot for recurring job, planning stays with chief of staff" (snippet).
