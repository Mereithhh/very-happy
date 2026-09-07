# Claude Code Desktop + Remote Control + Web + Cowork/Dispatch — Feature & Surface Inventory

- Researched for: very-happy (veryhappy.dev) first-principles UX comparison
- Lens: feature & surface inventory
- Date of research: 2026-09-03 (all sources read that day; source dates noted in Sources)
- Method: official docs at code.claude.com (raw `.md` where possible), support.claude.com articles, the Claude Code changelog (v2.1.186 → v2.1.258, 2026-06-22 → 2026-09-01) and the "What's new" weekly digests (weeks 27–34). No repo cloning, no screenshots of authenticated UI.
- Confidence legend: **[O]** = observed in official docs/changelog text; **[I]** = inferred from multiple docs statements or absence of documentation. Nothing here is marketing copy; the aim is mechanism and user-visible behaviour.

---

## 1. Surface map

Claude Code is one engine with five user-facing surfaces plus a "dispatcher" thread. The product's own framing: the Claude mobile app "is a client for Claude Code sessions rather than a place where code runs" ([mobile](https://code.claude.com/docs/en/mobile)).

| Surface | Where Claude executes | Unit of work | What the surface uniquely gives you |
| --- | --- | --- | --- |
| **Desktop app → Code tab** (macOS/Windows/Linux beta) | Local machine, Cloud VM, SSH host, or WSL distro — chosen per session | Session (= chat + project folder + code changes; local sessions get an automatic git worktree) | Pane layout (chat, diff, browser, terminal, file, plan, tasks, subagent, iOS Simulator), inline diff comments + "Review code", CI status bar with auto-fix/auto-merge, side chat, cross-session messaging, task chips, connectors/plugins UI, computer use, Dispatch badge, local scheduled tasks. [O] [desktop](https://code.claude.com/docs/en/desktop) |
| **claude.ai/code (web)** | Cloud VM (Anthropic-managed or self-hosted runner) for cloud sessions; **or** the user's own machine when the session is a Remote Control session | Session (cloud: repo(s) + branch; RC: the local CLI/VS Code/Desktop session) | Session sidebar with archive/filter, diff view with inline comments and "Create PR", share links, routines page, Auto-fix PR, teleport to terminal. [O] [web](https://code.claude.com/docs/en/claude-code-on-the-web), [web-quickstart](https://code.claude.com/docs/en/web-quickstart) |
| **Mobile app → Code tab** (iOS/Android) | Same as web: cloud sessions or Remote Control; plus Dispatch → Desktop | Session; Dispatch is one persistent thread | Session list with online dots, device cards for machines running `claude remote-control` (start a session on that machine from the phone, Aug 2026), photo/file attach, push notifications, `claude://code/...` deep links. [O] [mobile](https://code.claude.com/docs/en/mobile), [w34](https://code.claude.com/docs/en/whats-new/2026-w34) |
| **CLI / VS Code / JetBrains** | Local | Session; `claude agents` = background sessions dashboard | Full feature set, `/remote-control`, `/btw`, `/fork`, `/bg`, agent view, `--cloud`, `--teleport`, channels. [O] [platforms](https://code.claude.com/docs/en/platforms) |
| **Cowork tab → Dispatch** (Desktop + mobile, Pro/Max only) | Desktop machine (must be awake) | One persistent thread that spawns Code or Cowork sessions | Message a task from phone; Dispatch decides whether it is dev work → Code session (shown with a **Dispatch** badge in the Code sidebar) or knowledge work → Cowork. [O] [Dispatch article](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork) |

Desktop has no terminal-style scripting (`--print`/SDK not available) and no agent teams; it does run dynamic workflows. [O] [desktop § Feature comparison](https://code.claude.com/docs/en/desktop)

## 2. Unit of work and session lifecycle

**Unit of work = session.** In Desktop "each conversation is a session: it has its own chat history, project folder, and code changes." Cloud sessions add one or more repositories (each with its own branch selector). [O]

| Lifecycle step | Desktop (local) | Cloud (web/mobile/Desktop-Cloud) | Remote Control (local session viewed remotely) |
| --- | --- | --- | --- |
| **Create** | `+ New session` / Cmd+N; configure environment, folder, model, permission mode before first message. Also via Dispatch, task chips, scheduled tasks, or `/desktop` from the CLI (moves a CLI session into Desktop and exits the CLI). | Pick repo(s)+branch, mode, type prompt. Also `claude --cloud`, `/autofix-pr`, routines, Slack/Claude Tag, prefilled URL (`?prompt=&repositories=&environment=`). | `claude remote-control` (server mode, up to 32 concurrent sessions, `--spawn worktree` per session), `claude --remote-control`, `/remote-control` mid-session, VS Code `/rc`; auto-connect toggle for every session. Since Aug 2026 the phone can start a session on any machine running server mode (device card → pick directory). |
| **Name** | Rename by clicking the title in the session toolbar. Auto-titles are short noun phrases ("Login button bug", v2.1.234) and match conversation language. | Auto-title after first prompt; `/rename <name>` works from web/mobile. | Title precedence: `--name` → `/rename` → last meaningful message → `hostname-graceful-unicorn`. Renaming from claude.ai also renames the CLI session (v2.1.221+). |
| **Resume** | Click in sidebar (equivalent of `--resume`). Desktop-written sessions exempt from the 30-day transcript cleanup while they are in the app (v2.1.248). | Reopen from sidebar; expired VM is re-provisioned with history restored (background work lost). Answer a pending question up to environment expiry. | `claude remote-control` / `--continue` / `--session-id` bring sessions back **for about four hours** after the server stopped; `--resume` reattaches to the existing claude.ai session rather than creating a new one (v2.1.232). |
| **Archive / delete** | Hover → archive icon (also removes the worktree); "Auto-archive after PR merge or close" setting; Claude can archive on request but always asks first, even in Bypass mode. | Archive from sidebar; delete (confirm) from archived filter or session menu; archived sessions can't accept messages. | Compaction or `/resume` mid-connection mints a new server session and archives the stale one; taking over from another device is explicit and the terminal says which happened. |
| **Fork / branch** | `/fork` copies the conversation into a new background session in its own worktree (v2.1.208+/2.1.232 default fork subagents). | n/a | `claude --resume <id> --fork-session`, `/branch`. |
| **Hand off between surfaces** | **Continue in** menu → "Claude Code on the Web" (pushes branch, generates a summary, creates a cloud session with full context; needs clean tree; not for SSH) or "Your IDE". | `--teleport` / `/teleport` / `/tasks` → `t` / web "Open in > Terminal" pulls a cloud session into a terminal (branch checkout + full history); the terminal copy diverges. Cloud session doc prints the exact teleport command on request. | Terminal ↔ phone ↔ browser are the same session; "the web and mobile interfaces are a window into that local session." A teleported session can be re-exposed with `/remote-control`. |

All lifecycle claims [O] from [desktop](https://code.claude.com/docs/en/desktop), [web](https://code.claude.com/docs/en/claude-code-on-the-web), [remote-control](https://code.claude.com/docs/en/remote-control), [changelog](https://code.claude.com/docs/en/changelog).

## 3. Multi-session handling

- **Sidebar**: lists sessions, filters by status/project/environment, group by project; Ctrl+Tab cycles; **Cmd-click opens a second session in a split pane** (clicking another session replaces the focused pane). [O]
- **Transcript view modes**: Normal (tool calls collapsed), Verbose (every step), Summary ("only Claude's final responses and the changes it made"), documented explicitly for "when you're running multiple sessions and want to scan results quickly." [O]
- **Cross-session awareness (Desktop surface)**: Claude can list the 20 most recently active Desktop-run sessions, read what each did, rename/archive them, and message them. Messages arrive in the target as "a card labeled with the sending session's title and a link back"; if the receiver is mid-task the message is held until the turn finishes; replies flow back. Scope limit: Claude sees only sessions the Desktop app itself runs (local/SSH/WSL) — not cloud, CLI or VS Code sessions, "so with nine terminal worktrees open and two desktop sessions, Claude … reports the one other desktop session." [O]
- **Cross-session messaging (engine level, v2.1.224+)**: `ListAgents` / `SendMessage`; local delivery over per-session sockets, cross-machine via the Remote Control connection, cloud via Anthropic servers. `@`-mention of a session in the composer (v2.1.232). Inbound policy `accept | hold | refuse`; default holds messages between bypass-permissions and prompting sessions and shows an approval dialog (5-minute expiry). Incoming message renders as a dim one-line preview `› Message from @api-worker: … (ctrl+o to expand)`. Loop throttling, 50-message queue, size caps. [O] [cross-session-messaging](https://code.claude.com/docs/en/cross-session-messaging)
- **Task chips**: "When it notices something worth fixing that's out of scope for the current task, it offers the work as a task chip in the chat. Click the chip to start that work in a new session with its own worktree." [O]
- **Tasks pane**: background work inside the current session — subagents, background shell commands, dynamic workflows; click to open output in the subagent pane or stop it. [O]
- **Agent view (CLI only, research preview)**: `claude agents` — one screen for all background sessions grouped Pinned / Ready for review / Needs input / Working / Completed; each row has a Haiku-written one-line headline refreshed ≤ every 15 s, a PR chip (`#N` / `!N`) coloured by CI/review state, peek panel with numbered-choice replies, attach/detach. Not in Desktop. [O] [agent-view](https://code.claude.com/docs/en/agent-view)

## 4. Worktree / isolation model

- Desktop: "For Git repositories, each session gets its own isolated copy of your project using Git worktrees." Stored under `<project>/.claude/worktrees/` (configurable), optional branch prefix, `.worktreeinclude` to copy gitignored files (e.g. `.env`). Archiving removes the worktree. [O]
- Remote Control server mode: `--spawn same-dir | worktree | session`; `w` toggles at runtime; the pre-created session stays in the current directory. [O]
- Cloud: each session is a fresh clone in an isolated VM with per-environment network access, setup script, env vars; credentials stay outside the sandbox behind a proxy. [O]
- Scheduled Desktop tasks default to the working directory including uncommitted changes; a per-task worktree toggle exists. [O]
- Background/agent-view sessions block writes to the shared checkout until moved into a worktree; Claude is instructed to commit/push or open a draft PR before finishing so work survives deletion. [O]

## 5. Diff and review

- Diff stats indicator (`+12 -1`) → diff viewer with file list left, changes right. Click any line → comment box; **Cmd+Enter submits all comments at once**; Claude applies and a new diff appears. On the web the comments "queue up until you send your next message, then they're bundled with it." [O]
- **Review code** button: Claude reviews the current diffs and leaves comments in the diff view, scoped to "compile errors, definite logic errors, security vulnerabilities, and obvious bugs", explicitly not style or linter issues. [O]
- Manual mode: per-change Accept/Reject before files are written. [O]
- Remote Control diff pane: computed on the local machine on request; if the tree is clean it shows the branch's changes since it diverged from the default branch (v2.1.247 extended this to `/remote-control`-started sessions). [O]
- **CI status bar** appears in the session after a PR is opened; polls via `gh`; **Auto-fix** (reads failure output and iterates) and **Auto-merge** (squash; requires repo auto-merge setting) toggles; desktop notification when CI finishes. Web Auto-fix additionally subscribes to GitHub events (review comments + check failures), asks before acting on ambiguous review comments, replies on GitHub under your account but labelled as Claude Code; cannot react to merge conflicts (no webhook). [O]
- Web "Create PR" offers full PR, draft, or GitHub compose page with generated title/body. [O]
- `/code-review`, `/ultrareview` (cloud multi-agent), Claude Security plugin exist as adjuncts. [O]

## 6. Terminal, file, browser, simulator panes

- **Terminal pane**: local sessions only; opens in the session's working dir and shares Claude's environment; multiple tabs; right-click folder → "Open in terminal". **Not available in cloud or SSH sessions, and not exposed to phone/web.** [O] [I: RC surfaces no terminal; the RC page lists diff/tasks/model/effort but no terminal]
- **File pane**: local + SSH; spot edits with Save/Discard, on-disk-change warning, copy path; right-click → Attach as context / Open in VS Code, Cursor, Zed / Show in Finder. [O]
- **Browser pane**: tabbed, clean profile; auto-starts dev server from `.claude/launch.json`; **auto-verify on by default** (screenshots, DOM inspection, clicks, form fill after every edit); external sites gated by per-site Allow once / Always allow / Deny cards and safety classifiers in every mode. [O]
- **iOS Simulator pane** (macOS, public beta since week 30): opens automatically when Claude runs the app; separate simulator per session. [O]
- **Plan pane, tasks pane, subagent pane**: plan review, background tasks, subagent output. [O]

## 7. Permissions and approvals

| Mode | Desktop local | Cloud | Remote Control from phone/web |
| --- | --- | --- | --- |
| Manual (`default`) | yes | no (edits pre-approved; dropdown shows Accept edits) | yes |
| Accept edits | yes | yes | yes |
| Plan | yes (per-session only, not remembered per folder) | yes | yes |
| Auto (classifier) | yes; default for new sessions on Pro/Max/Team since 2026-08-14 | yes | **not selectable from the app** |
| Bypass | behind Settings toggle (Pro/Max) or org policy | no | not selectable; the session never reports Bypass to claude.ai |
| `dontAsk` | CLI only | ignored | — |

[O] [desktop](https://code.claude.com/docs/en/desktop), [permission-modes](https://code.claude.com/docs/en/permission-modes), [mobile](https://code.claude.com/docs/en/mobile)

- Mode picked in the selector is remembered **per folder** and overrides `defaultMode`. [O]
- Desktop actions that always ask regardless of mode: archiving a session, computer-use app access ("Allow for this session" / Deny; 30 minutes in Dispatch-spawned sessions), external-site actions flagged by classifiers. [O]
- Permission prompts and `AskUserQuestion` stay open on remote devices until answered; other forwarded dialogs expire after 5 minutes (`dialogExpiry`). [O]
- Scheduled Desktop tasks accumulate an "Always allowed" list from Run-now approvals, reviewable/revocable on the task page. [O]

## 8. Notifications

- Desktop: OS notification when a Code session finishes a task "and you aren't currently viewing that session"; when CI finishes; when a scheduled task fires or a catch-up run starts. [O]
- **Mobile push (Remote Control)**: Claude decides when to push (long task finished, needs a decision); user can ask "notify me when the tests finish"; two on/off toggles only, no per-event config. **Presence suppression**: pushes are skipped while you are typing in/focused on the connected terminal; `CLAUDE_CLIENT_PRESENCE_FILE` extends suppression to "any time you are at the machine" via a screen-lock listener. [O]
- **Session URL reminders** in the terminal: a "Still working — Check in from your phone" notice on long turns and "Approve tool calls from your phone" after repeated permission prompts; server-tuned, appear only a few times, cannot be configured. [O]
- Dispatch: push when a spawned task finishes or needs approval. [O]
- Agent view: terminal notification channel + `Notification` hook types `agent_needs_input` / `agent_completed`. [O]

## 9. Attachments

- Desktop: `@file` autocomplete (local/SSH only), attach images/PDFs/other files, drag-and-drop. CLI has no file attachments. [O]
- Mobile/web → Remote Control: photos are seen directly and also saved under `~/.claude/uploads/` with the path told to Claude; other files are downloaded to the machine and passed as `@` references; attachments without caption fixed in v2.1.202. [O]
- Files Claude sends to the user from Desktop/VS Code-hosted RC sessions upload so they open on phone/web (v2.1.234). [O]
- Voice: support article states "Voice mode is available to all users, including Claude Code Desktop and Cowork"; CLI has `/voice` dictation. [O — support article; Desktop Code-tab specifics not documented in code.claude.com pages I read: I]

## 10. Remote Control specifics (the closest analogue to very-happy)

- Connection: local process makes outbound HTTPS only, registers with Anthropic API and polls; transcript stored on Anthropic servers while connected; multiple short-lived scoped credentials; Trusted Devices (biometric step-up every 18 h) is an org option. [O]
- Discovery: session URL, QR code (spacebar in server mode), or the session list on claude.ai/code / Code tab; RC sessions "show a computer icon with a green status dot when online"; offline within seconds of CLI exit (v2.1.236). [O]
- Sync semantics: conversation and subagent/workflow progress stay in sync across devices; foreground subagent tool calls stream live to clients (v2.1.251), background ones show status only; connecting device sees already-running subagents/workflows and can stop them; compaction progress and `/clear` propagate; `/resume` in the terminal switches which conversation the phone sees without history. [O]
- **Reconnect queueing**: "While the connection is rebuilding, Claude Code queues messages, permission prompts, and status updates from subagents and workflows, and delivers them once the connection recovers." Mid-turn prompts from a device are queued and kept in the transcript. Interactive sessions retry indefinitely; server mode gives up after ~10 min; 403s tolerated 3 min; presence-heartbeat failure tolerated 30 min. [O]
- Model/effort picked on the phone apply to the local session and are shown in the terminal; `/model x` from the device also sets the default. [O]
- Commands from phone/web: text-output commands work; picker commands take arguments (`/model sonnet`); `/plugin`, `/resume` are local-only. [O]
- Takeover: a second terminal resuming the same conversation does not steal RC; the failure indicator says whether the session was taken over, ended, archived or deleted elsewhere and suppresses the reconnect hint in those cases. [O]
- Constraints: one remote session per interactive process (server mode for many); claude.ai subscription only (no API key, no `ANTHROPIC_BASE_URL` gateway, no Bedrock/Vertex/Foundry); telemetry-disable env vars also disable RC; ZDR orgs excluded. [O]

## 11. Cloud sessions (Claude Code on the web)

- GitHub required (App or `/web-setup` gh-token sync); non-GitHub repos can be bundled (<100 MB, credentials filtered) but cannot push back. [O]
- `claude --cloud` shows a live provisioning checklist and queues typed messages until ready; `claude -p "msg" --cloud <id>` posts one follow-up from any machine (JSON output). [O]
- Sharing: Private/Public (Pro/Max) or Private/Team (Team/Enterprise); recipients see latest state without live updates; optional repository-access verification. [O]
- Environment expiry: idle VMs are reclaimed; reopening restores history but not background work. [O]
- Auto-fix PR from web, `/autofix-pr` in terminal, or by telling the mobile app to "watch this PR". [O]

## 12. Dispatch (Cowork)

- One persistent thread reachable from phone or desktop; "This thread doesn't reset"; no way to create multiple threads. Claude classifies the task and spawns Code or Cowork sessions, which appear in their sidebars; the thread receives the outcome "rather than showing you every step". Push on completion/approval. Requires Pro/Max, Desktop awake and open (a cloud Cowork session is the alternative). Memory persists across tasks and is user-editable. [O] [Dispatch article](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork)
- Positioning table in docs: Dispatch = "Delegating work while you're away, minimal setup"; Remote Control = "Steering in-progress work from another device". [O]

## 13. Automation

| Mechanism | Runs on | Triggers | Notable UX mechanics |
| --- | --- | --- | --- |
| **Desktop scheduled tasks** (Routines page → Local) | Your machine while app open & awake | Manual / hourly / daily / weekdays / weekly; NL for custom | Fresh session per run under a **Scheduled** sidebar section; per-task permission mode, model, folder, worktree toggle; deterministic few-minute stagger; **one catch-up run** for the most recent missed fire (last 7 days) on wake, with notification; run history shows skip reasons (asleep, previous run still running); "Always allowed" panel; task can reschedule itself via `update_scheduled_task`; prompt stored as `~/.claude/scheduled-tasks/<name>/SKILL.md`. [O] [desktop-scheduled-tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) |
| **Routines** (claude.ai/code/routines, Desktop → Cloud, `/schedule`) | Cloud VM / self-hosted runner | Schedule (≥1 h), one-off timestamp, **API POST `/fire` with bearer token and untrusted `text` payload**, GitHub events | No permission prompts at all; each run is a session with a URL; per-account, not shared; daily run cap. [O] [routines](https://code.claude.com/docs/en/routines) |
| **`/loop` / CronCreate** | Inside a CLI session | interval or Claude-chosen cadence | Session-scoped, 7-day expiry, `loop.md` default prompt, `Esc` stops self-paced loops. [O] [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) |
| **Channels** | Local CLI | Telegram/Discord/iMessage/webhooks via MCP channel plugins | Push events into a running session. [O] [platforms](https://code.claude.com/docs/en/platforms) |
| **Deep links / prefill** | Mobile + web | `claude://code/new?q=&repo=&branch=&mode=`, `https://claude.ai/code?prompt=&repositories=&environment=`, `prompt_url` | Enables "open Claude from your issue tracker" buttons. [O] [mobile link article](https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link), [web-quickstart](https://code.claude.com/docs/en/web-quickstart) |
| **Dynamic workflows** | CLI/Desktop/SDK | `ultracode` keyword, `/deep-research`, saved commands | Desktop shows an approval card (Once/Always/Deny) and progress in the Background tasks pane. [O] [workflows](https://code.claude.com/docs/en/workflows) |

## 14. Integrations

- Connectors (MCP with GUI setup) for local/SSH sessions: Google Calendar, Slack, GitHub, Linear, Notion, …; managed under **Customize** in the sidebar, synced via claude.ai account; not available in cloud/WSL sessions (routines pick connectors at creation). [O]
- Plugin browser (official marketplace) in Desktop; cloud sessions need `enabledPlugins` in repo settings or account-synced plugins. [O]
- MCP from `claude_desktop_config.json`, `~/.claude.json`, `.mcp.json` all load into local Code sessions. [O]
- GitHub App / `gh` for cloud; Slack app and Claude Tag; GitHub Actions / GitLab CI. [O]

## 15. Pricing / auth constraints

- Code tab, cloud sessions, Remote Control: Pro, Max, Team, Enterprise. API keys and third-party providers are excluded from Remote Control, cloud, teleport and Dispatch. Dispatch and computer use: Pro/Max only. Remote Control left research preview in Aug 2026. Team/Enterprise owners toggle RC, web, routines, bypass mode centrally. Cloud usage counts against plan limits with no separate compute charge. [O]
- Desktop auto-continue: on hitting a session limit, the limit card offers "Auto-continue when limits reset" and shows the retry time (not for weekly limits). [O] [w33](https://code.claude.com/docs/en/whats-new/2026-w33)

## 16. Changelog: last ~3 months of surface UX changes (2026-06-22 → 2026-09-01)

- **v2.1.187 (06-23)**: `/btw` gains ←/→ browsing of earlier answers; v2.1.212 makes bare `/btw` reopen the last exchange; v2.1.257 moves history keys to Shift+←/→. [O]
- **v2.1.196 (06-29)**: Remote Control disabled when `ANTHROPIC_BASE_URL` is non-Anthropic. [O]
- **Week 27 (06-29→07-03)**: Desktop on Linux beta; subagents background by default. [O]
- **v2.1.202 (07-06)**: RC fixes — commands from mobile/web, caption-less attachments, wrong permission-mode label. [O]
- **v2.1.205–2.1.208 (07-08→07-14)**: background-task panels on web/mobile get full task state; RC clients attaching mid-session now see background agents/workflow progress; "Claude Browser" pane rename reserved. [O]
- **Week 28 (07-06→07-10)**: Desktop in-app browser for external sites; agent view rows get state word + classifier headline. [O]
- **v2.1.214 (07-18)**: "session ready" push no longer fires for sessions without explicit RC. [O]
- **v2.1.217 (07-21)**: late-joining RC viewers now see pending permission prompts. [O]
- **Week 30 (07-20→07-24)**: iOS Simulator pane in Desktop (public beta). [O]
- **v2.1.221–2.1.224 (08-04→08-07)**: rename from Desktop/claude.ai syncs to CLI; RC workspace diff uses raw git blobs; **cross-session messaging ships (v2.1.224)** plus `crossSessionInbound`/`dialogExpiry`; self-hosted environments; RC connection failures get a persistent indicator with reconnect shortcut; compaction progress and `/clear` propagate to attached clients; stale server sessions archived rather than left dead. [O]
- **v2.1.225 (08-08)**: photos from the app shown to Claude directly; SendMessage can start conversations with RC sessions on other machines. [O]
- **v2.1.228–2.1.229 (08-11/12)**: cross-session messages render inline with sender; `ListAgents` marks `offline`/`cloud`; VS Code `/btw` panel resizable. [O]
- **v2.1.232 (08-13)**: Desktop/IDE-hosted RC sessions reattach instead of creating a new claude.ai session each resume; RC reconnects for ~30 min after blips; terminal explains takeover/ended/deleted; `@`-mention sessions. [O]
- **Week 33 (08-10→08-14)**: Desktop "Auto-continue when limits reset"; fork mode default. [O]
- **v2.1.234 (08-17)**: files sent to the user from Desktop/VS Code-hosted RC sessions open on phone/web; permission mode and effort sync both ways with phone/web; short auto-titles. [O]
- **Week 34 (08-17→08-21)**: `claude remote-control` machines appear as **device cards** in the mobile Code tab; RC out of research preview; `/design` in CLI+Desktop. [O]
- **v2.1.236–2.1.239 (08-19→08-21)**: RC marks sessions offline within seconds; per-task Stop from the RC tasks panel works on CLI-hosted sessions; mid-turn RC messages no longer vanish; model picks from phone update the terminal; uploaded images carry a saved path. [O]
- **v2.1.243–2.1.248 (08-25→08-27)**: `--teleport` offers stash; RC diff for `/remote-control`-started sessions; Desktop sessions exempt from 30-day cleanup; RC sometimes missing prompts after silent reconnect fixed. [O]
- **v2.1.251–2.1.258 (08-28→09-01)**: foreground subagent tool calls stream live to RC clients; VS Code RC banner → footer pill; Desktop-hosted RC stalls fixed; RC consent prompt dismissal no longer counts as consent; RC sessions started from the app now honour the selected model; stopping a background command from the tasks panel is reported to Claude. [O]
- Release notes (support.claude.com): 06-25 Trusted Devices for Remote Control; 07-07 Cowork on web and mobile (sessions run in the cloud, one home for Chat+Cowork); 08-25 memory across chat and Cowork. [O]

## 17. What very-happy does NOT have that this product has

1. Diff pane with per-line comments batched into the next message, plus a one-click "Review code" self-review pass (Desktop + web). [O]
2. CI status bar inside the session with Auto-fix / Auto-merge toggles, CI-finished notification, and auto-archive on PR merge/close. [O]
3. Automatic per-session git worktrees (with branch prefix, `.worktreeinclude`, archive-removes-worktree) and split view of two sessions. [O]
4. Cross-session messaging with attribution cards, hold/approve inbound policy, `@session` mentions, and Claude-driven "check on / message / archive my other sessions". [O]
5. Task chips: agent-suggested out-of-scope work that spawns a new isolated session on click. [O]
6. Transcript view modes (Normal / Verbose / Summary) designed for scanning many sessions. [O]
7. Browser pane with auto-verify after every edit, `launch.json` dev-server management, per-site permission cards; iOS Simulator pane. [O]
8. Cloud sessions in isolated VMs with `--cloud`, teleport in both directions, session share links, environment configs. [O]
9. Durable automation: Desktop scheduled tasks (catch-up runs, per-task allowlist, run history with skip reasons) and cloud routines with API and GitHub triggers. [O]
10. Presence-aware mobile push (skip while typing/focused; presence file) and in-terminal "check in from your phone" nudges. [O]
11. Explicit reconnect queueing contract: messages, permission prompts and subagent status queued during a drop; mid-turn messages persisted; offline-within-seconds. [O]
12. Deep links / prefilled new-session URLs (`claude://code/new?q=…&repo=…`, `claude.ai/code?prompt=…`). [O]
13. Auto-generated short session titles synced across CLI, Desktop and claude.ai; rename anywhere propagates. [O]
14. Usage ring (context per session + plan usage) and "Auto-continue when limits reset". [O]
15. Connectors and plugin marketplace UI (GitHub, Slack, Linear, Notion) and computer use with per-app tiers. [O]
16. Dispatch: a persistent phone-reachable dispatcher that spawns Code sessions and notifies on completion. [O]
17. Subagent/workflow visibility from phone with per-task Stop; foreground subagent tool calls streamed live. [O]
18. A CLI dashboard (`claude agents`) with state-grouped rows, model-written headlines, PR chips coloured by CI state, and peek-and-reply. [O — CLI only]

## 18. What this product lacks that very-happy has

1. **Durable remote web terminal (tmux) from any browser/phone**: Desktop's terminal is a local-only pane; Remote Control and cloud sessions expose no terminal to the phone or web; SSH sessions have no terminal pane. [O for the absence in docs; I for "no way at all"]
2. **Attach to an existing tmux session / arbitrary shell on the daemon machine** from the web (B-273/280–282). Not present anywhere in the inventory. [I]
3. **Self-hosted relay with owner-controlled auth and storage**: Remote Control requires a claude.ai subscription, `api.anthropic.com` (no gateway/base URL), telemetry enabled, and stores transcripts on Anthropic servers; ZDR orgs are excluded; RC sessions resume only ~4 h after the server stops. very-happy runs on the owner's server with account/password login and no such coupling. [O]
4. **Multiple agent backends in one client** (Claude SDK sessions plus Codex/ACP sessions). The Claude surfaces are Claude-only. [I]
5. **First-class task board and notes surfaces** attached to the same workspace. No kanban/board or notes surface exists in Code tab, web or mobile; agent view is a CLI table. [I]
6. **Web-side permission-mode enforcement and capability-gated UI by session** (`yoloEnforcement`, `metadata.capabilities`). Claude's phone/web cannot even select Auto/Bypass for RC sessions and relies on the CLI to report modes. [O]
7. **Machine page with daemon/Claude auth diagnostics** (`daemonState.claudeAuth`); the closest analogue is the new device card, which only starts sessions. [O for device card; I for absence of diagnostics]
8. **Unified session list across hosts**: Desktop's cross-session surface cannot see CLI/VS Code/cloud sessions; agent view cannot see interactive sessions until backgrounded; very-happy's list is one relay-wide list per machine. [O]
9. **No 30-day transcript cleanup / no environment expiry** for the owner's own data (Desktop sessions are exempt only while in the app; cloud VMs expire). [O]
10. **Blue/green self-managed releases and update modal with stacked unread versions** — irrelevant to Anthropic's hosted product but part of very-happy's ownership story. [I]

## Sources (all read 2026-09-03)

| URL | Page date / version | What it evidenced |
| --- | --- | --- |
| https://code.claude.com/docs/en/desktop | current docs (mentions v2.1.234, Desktop 1.37937.0) | Panes, diff comments, Review code, CI bar, worktrees, split view, view modes, side chat, tasks pane, cross-session surface, task chips, Continue in, Dispatch badge, connectors/plugins, environments, permission modes, computer use, CLI comparison |
| https://code.claude.com/docs/en/desktop-quickstart | current | Three tabs (Chat/Cowork/Code), first-session flow, Manual-mode accept/reject |
| https://code.claude.com/docs/en/remote-control | current (mentions v2.1.248) | Server/interactive/`/rc` modes, flags, title precedence, what connected devices see, reconnect queueing, push notifications + presence suppression, URL reminders, Trusted Devices, limitations, comparison table |
| https://code.claude.com/docs/en/claude-code-on-the-web | current | Cloud environments, GitHub auth, `--cloud`, bundle upload, follow-ups via `-p --cloud`, teleport, sharing, archive/delete, Auto-fix PR, isolation, expiry |
| https://code.claude.com/docs/en/web-quickstart | current | Surface comparison table, prefill URL params, diff comments queued into next message, Create PR options, session keeps running after tab close |
| https://code.claude.com/docs/en/mobile | current | Mobile = client for cloud/RC/Dispatch; Code tab; attachments; push; permission-mode limits from the app |
| https://code.claude.com/docs/en/platforms | current | Platform table; "work when you are away" table (Dispatch/RC/Channels/Slack/self-hosted/scheduled) |
| https://code.claude.com/docs/en/scheduled-tasks | current | `/loop`, cron tools, jitter, 7-day expiry, comparison table |
| https://code.claude.com/docs/en/desktop-scheduled-tasks | current (Desktop ≥1.1.5368) | Routines page Local vs Cloud, schedule presets, Scheduled sidebar section, catch-up run, permissions "Always allowed", run history, self-rescheduling |
| https://code.claude.com/docs/en/routines | research preview | Triggers (schedule/API/GitHub), `/fire` endpoint, no permission prompts, per-account |
| https://code.claude.com/docs/en/cross-session-messaging | current (v2.1.224–2.1.251 notes) | ListAgents/SendMessage, `@` mentions, delivery/hold/refuse, message rendering, cross-machine routing, limits |
| https://code.claude.com/docs/en/workflows | current | Dynamic workflows; Desktop approval card and Background tasks pane |
| https://code.claude.com/docs/en/agent-view | research preview | State groups, Haiku row summaries, PR chips, peek panel, isolation and deletion rules |
| https://code.claude.com/docs/en/permission-modes | current | Mode availability per surface (Desktop / web+mobile / RC) |
| https://code.claude.com/docs/en/changelog (fetched as changelog.md) | v2.1.186 (2026-06-22) → v2.1.258 (2026-09-01) | All version-tagged items in §16 |
| https://code.claude.com/docs/en/whats-new and weekly pages 2026-w27, w28, w30, w32, w33, w34 | weeks of 2026-06-29 → 2026-08-21 | Desktop Linux, in-app browser, iOS Simulator, cross-session messaging, auto mode default, Desktop auto-continue, device cards / RC GA |
| https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork | updated 2026-09-02 ("yesterday") | Dispatch mechanics, single persistent thread, Pro/Max, desktop-awake requirement, limitations |
| https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile | updated week of 2026-08-31 | Cowork cloud sessions across surfaces; what needs the desktop app; per-surface feature table |
| https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork | updated week of 2026-08-31 | Cowork scheduled tasks run in cloud; create with Claude vs manual; pause/resume/run now |
| https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link | 2026-05-06 | `claude://code`, `/code/{id}`, `/code/new?q=&repo=&branch=&mode=`, universal links |
| https://support.claude.com/en/articles/14554000-claude-code-power-user-tips | updated 2026-08-26 | Voice mode on Desktop/Cowork, `/btw` single-turn no-tools, `/branch`, teleport, iMessage plugin, Dispatch description |
| https://support.claude.com/en/articles/12138966-release-notes | entries 2026-06 → 2026-09-01 | Trusted Devices (06-25), Cowork on web/mobile (07-07), memory in Cowork (08-25), Dispatch research preview (03-17), computer use + Dispatch (03-23) |
| https://support.claude.com/en/collections/9387080-claude-mobile-apps | collection index | Confirms mobile article set (no dedicated "Code tab" article beyond deep links) |
