# OpenAI Codex (ChatGPT desktop app / Remote / cloud) — Feature & Surface Inventory

Lens: FEATURE & SURFACE INVENTORY. Researched 2026-09-03 from official docs (learn.chatgpt.com / developers.openai.com), OpenAI announcement posts, and the official changelog. Everything marked **[observed]** was read in those sources; **[inferred]** is my reading between the lines. Written for the very-happy (VH) owner as a first-principles UX comparison.

## 0. Naming timeline (verified)

| Date | Event | Source |
|---|---|---|
| 2026-02-02 | Standalone **Codex app** launches on macOS: project sidebar, thread list, review pane, worktrees, Automations, skills, voice dictation. | openai.com "Introducing the Codex app"; changelog 2026-02-02 |
| 2026-03-04 | Codex app on Windows (native sandbox); Local↔Worktree **Handoff** ships 03-03. | changelog / What's new |
| 2026-04-16 | "Codex for (almost) everything": computer use, in-app browser, image gen, memory, plugins, automations that reuse a thread, PR review comments, multi-terminal tabs, SSH devboxes (alpha). | openai.com post |
| 2026-05-14 | **Codex Remote** preview: ChatGPT mobile app drives a local Codex host over a "secure relay"; Remote SSH GA; hooks GA; access tokens. | openai.com "Work with Codex from anywhere" |
| 2026-06-25 | Codex Remote **GA**, authenticated one-to-one QR pairing per device/host. | changelog 2026-06-25 |
| 2026-07-09 | **Codex app merges into the new ChatGPT desktop app** (macOS/Windows; Linux preview 08-11). Old ChatGPT app renamed "ChatGPT Classic". Codex keeps a dedicated view, can be default view + app icon. Same day: "ChatGPT Work" agent + GPT-5.6. | openai.com "ChatGPT is now a partner for your most ambitious work"; changelog 26.707 |

Vocabulary in the docs has churned: Automations → "Scheduled tasks"; threads/tasks → "chats" (the docs keep anchors `#tasks`, `#threads`, `#manage-project-threads` for old links); "Sync" → "Handoff" (changelog 2026-02-03). The desktop app still uses `codex://threads/<thread-id>` and "Copy session ID" internally. **[observed]**

## 1. Surface inventory

| Surface | What it is | Can it drive a *local* machine? | Notes |
|---|---|---|---|
| **ChatGPT desktop app — Codex view** (macOS, Windows; Linux preview) | The former Codex app: project sidebar, chat list, review pane, integrated terminal, built-in browser, Scheduled, Skills, Plugins, Pets. | Yes (it *is* the host) | Chat / Work / Codex switcher (⌃1/⌃2/⌃3). Codex chats have their own sidebar/history; "Quick chat" opens a plain ChatGPT chat that does *not* appear in the Codex sidebar. **[observed]** |
| **Remote** in the **ChatGPT mobile app** (iOS/Android) | Phone client for chats running on a paired desktop host. | Yes, via the paired host | Not a standalone agent; "worktrees don't run locally on your phone". Host must be awake, online, app open. **[observed]** |
| **Desktop → desktop "Control other devices"** | Another Mac/PC running the desktop app can pick up a chat on a host. | Yes | "Availability can vary by rollout." **[observed]** |
| **ChatGPT web** (chatgpt.com) | Chat + ChatGPT Work (cloud) + Codex cloud task list (chatgpt.com/codex). | **No** — no local sandbox/approval selector; no Remote. | "ChatGPT web doesn't expose the local Codex sandbox or approval-mode selector." **[observed]**; no browser-based remote control of a host was found anywhere in the docs **[inferred gap]** |
| **Codex cloud** | OpenAI-managed containers per repo environment; PR flow; triggered from web, CLI (`codex cloud`), IDE, GitHub/GitLab/Linear/Slack. | n/a | Two-phase runtime (setup online, agent offline by default); container cache 12 h. **[observed]** |
| **Codex CLI** (`codex`) | Terminal TUI; `codex resume`, `/fork`, `/goal`, `/review`, `/permissions`, `/side`, `codex agents` dashboard (0.149), `@`-mention other tasks (0.150). | Yes | Can also attach to a remote app-server (`codex --remote ws://…`). **[observed]** |
| **IDE extension** | VS Code/JetBrains/Cursor/Windsurf; same app-server. | Yes | Local/Worktree/Cloud selector. |
| **Codex SDK / app-server / GitHub Action / hooks / MCP** | Programmatic surfaces. | Yes | app-server = JSON-RPC over stdio/ws/unix; the protocol powering the desktop app and IDE. **[observed]** |
| **Codex Micro** (hardware, Work Louder, 2026-07-15) | 6 Agent Keys lit by chat status (white idle / blue thinking / green complete-unread / amber requires input / red error), Command Keys (Fast, Approve, Decline, Fork, Mic, Send), dial (reasoning effort), stick (plan mode…). | via desktop | Physical "which agent needs me" panel. **[observed]** |

## 2. Unit of work

- **Chat** (formerly thread/task) is the unit. It carries transcript, working directory, run location (Local / Worktree / Cloud / a remote host), model + reasoning effort, permission mode, an optional **goal**, queued messages, side chats, subagent threads, and an associated managed worktree. **[observed]**
- **Project** groups chats. A *local project* attaches one or more folders (primary folder = cwd for new chats, Git ops, AGENTS.md/skills/config discovery; secondary folders readable/editable). Projects can be pinned; chats can be archived together per project. Standalone chats without a project exist (`/task`, ⌘⌥O). **[observed]**
- **Goal** (`/goal`): persistent objective that doubles as first prompt and completion criteria; progress row above the composer with pause / resume / edit / clear; persists for "hours or days". **[observed]**
- **Scheduled task** + **scheduled run** (each run either starts a new chat or returns to the same chat = "heartbeat"). **[observed]**
- **Subagent thread**: child threads shown as a panel above the composer (status, stop all, open one). **[observed]**
- **Side chat** (`/side`, ⌘⌥S): temporary parallel conversation that does not interrupt the main chat; on iOS it can be opened from selected transcript text. Direct analogue of VH `/btw`. **[observed]**

## 3. Session lifecycle

| Step | Desktop (Codex view) | Remote (mobile) |
|---|---|---|
| Create | New chat in project (⌘N); choose Local / Worktree (+ base branch, optional setup script) / Cloud (environment); `/project`, `/local`, `/worktree`, `/cloud`. Deep link `codex://new?prompt=&path=&originUrl=` prefills the composer (does not auto-send). | "New task": choose connected computer → project → Local/worktree + branch → model. iOS can choose branch, create worktree, run setup script. |
| Name | Auto-titled; rename ⌘⌥R; CLI 0.150 `/rename` suggests an editable title. | Rename in task menu. |
| Resume | Sidebar; Search chats matches content *and Git branch names*; `codex resume`. Handoff back to a worktree returns to the same worktree. | Task list, search across titles + content on the host; "Priority" view. |
| Fork | Fork from an earlier message (03-2026); `/fork` copies a local chat into a new chat **or worktree**; CLI temporary forks; iOS shows a link from a fork back to the origin. | Fork from task menu. |
| Hand off | Local ↔ Worktree (moves chat *and* code; Git only allows a branch checked out in one place); host ↔ host (moves chat + Git state to a matching saved project on the destination; interrupts a running turn; Codex can do it on request; not to cloud). | Phone controls whichever host runs the chat; "pick up work from another device". |
| Archive | ⌘⇧A; archiving deletes the Codex-managed worktree after a snapshot; restore from Settings › Archived chats. | Archive; browse archived. |
| Share | Read-only **snapshot** of a local thread (macOS): messages, reasoning summaries, images, diffs; *excludes* tool calls/shell commands/tool I/O; known secret patterns redacted; revocable in data controls; personal links are public-by-link. | — |
| Pin / unread | Pin (⌘⌥P), mark unread (⌘⇧U), pinned set synced desktop↔iOS (08-20). | Same, synced. |

## 4. Multi-session handling (the "operator" layer)

- **Activity view** (bell in sidebar, ⌘⌥U, 07-30): chats that are unread, running, or waiting for a response; filters Work / Chat / Pinned / Scheduled; Mark all as read. "Next chat needing attention" hotkey ⌘⌥A; "Clear all unread indicators" ⇧Esc; command menu has an Unread section. **[observed]**
- **Pets** (floating overlay): states Running / Needs input / Ready / Blocked; prioritises needs-input → blocked → ready → running; activity tray to pick a chat; can carry the Computer Use PiP window. Terminal pets exist but not inside tmux. **[observed]**
- **Codex Micro**: same status model on physical keys (default follows six most-recent chats; modes Pinned / Priority / Custom). **[observed]**
- Mobile **Priority view** (iOS 2026-09-01): running, unread, awaiting-response on top. **[observed]**
- **Follow-up behaviour**: while a run is active, a message either **Steers** (injected into current run) or **Queues** (waits for next run); default in Settings › General; queued messages sit above the composer where they can be edited, reordered, sent, deleted; queued prompts sync with the host from iOS and send even when the phone app is backgrounded. **[observed]**
- Pop-out chat window with Always-on-top. Go to chat 1–9 (⌘1–9). **[observed]**

## 5. Worktree / isolation model

- Worktree = Git worktree under `$CODEX_HOME/worktrees`, detached HEAD from the chosen branch's HEAD; uncommitted changes of the chosen branch are applied; `.worktreeinclude` lists ignored files (`.env` etc.) to copy; `AGENTS.override.md` auto-copied; symlinks skipped. **[observed]**
- **Local environment** (`.codex/` in repo, shareable): per-OS setup scripts run when a worktree is created; **Actions** (named commands with icons) appear in the app top bar and run in the integrated terminal (primary action ⌘⇧D). **[observed]**
- Codex-managed vs permanent worktrees; keep last 15 managed ones; never auto-delete if pinned / in progress / permanent; snapshot before deletion with "restore" offered when reopening the chat. "Create branch here" turns the worktree into a branch → commit/push/PR from the header. **[observed]**
- Leaky abstraction acknowledged in docs: users hit `fatal: 'feature/a' is already used by worktree at …` and are told to use Handoff instead. **[observed]**
- Cloud: isolated container per chat, env vars + setup-only secrets, network off in agent phase unless allowlisted, HTTP proxy for all egress. **[observed]**

## 6. Diff & code review

- **Review pane** (⌃⇧G / ⌘⌥B) reflects Git state, not only agent edits; scopes **Unstaged / Staged / Commit / Branch / Last turn**; multi-repo projects show each repo and "All repos" for Last turn. Stage/unstage/revert at diff / file / hunk level; commit, push, create PR in-app; click file → opens in chosen editor. Inline editing within diffs (07-09). **[observed]**
- **Inline comments** on lines feed back as review guidance; docs recommend a follow-up message like "Address the inline comments and keep the scope minimal". **[observed]**
- `/review`: "against a base branch" or "uncommitted changes"; findings as inline comments; can run detached in a separate chat (setting). **[observed]**
- **PR Chat**: sidebar shows PR context + reviewer comments (needs `gh` authenticated); ask Codex to address comments; inspect patches, edit/accept/reject. **[observed]**
- Mobile: changed files + diffs with +/- stats, expand/collapse all, staged/unstaged/branch/last-turn filters, inline review comments, line wrapping toggle. **[observed]**
- GitHub/GitLab cloud reviews: `@codex review` (P0/P1 only), automatic reviews per repo, `@codex security review`, `AGENTS.md` "## Code Review Rules" sections, `@codex fix the P1 issue` starts a cloud chat that can push. **[observed]**

## 7. Terminal integration

- One integrated terminal drawer **per chat**, scoped to that chat's project/worktree (⌃`, placement configurable, multiple tabs since 04-2026). Codex can **read the current terminal output** (a running dev server, a failed build) — the terminal is a context source, not just a tool. Actions run there. **[observed]**
- Remote (mobile) shows "terminal output" among reviewable outputs; nothing in the docs describes an interactive remote terminal from the phone. **[inferred: read-only]**
- CLI can attach to a remote app-server over WebSocket (`codex --remote wss://…`), experimental. **[observed]**

## 8. Permissions & approvals

- Two layers: **sandbox** (`read-only` / `workspace-write` / `danger-full-access`; OS-enforced Seatbelt / bwrap+seccomp / Windows sandbox) and **approval policy** (`untrusted` / `on-request` / `never`, plus granular categories). `.git`, `.agents`, `.codex` are read-only even inside writable roots. Network off by default in workspace-write; optional domain-allowlist proxy. **[observed]**
- Desktop picker beneath the composer: **Ask for approval** (always available), **Approve for me** (= Auto-review; must be enabled in settings), **Full access** (must be enabled; extra warning dialog, and a special warning for cyber models), plus named **permission profiles** (beta; filesystem + network rules, `extends`, deny-globs like `**/*.env`). Org `requirements.toml` can disable modes; disallowed modes appear disabled. **[observed]**
- **Auto-review**: a separate reviewer agent (open-source "guardian" policy) decides boundary-crossing requests (sandbox escalation, blocked network, edits outside roots, side-effecting MCP/app tools, new website for Computer Use); returns rationale + risk level; denial tells the main agent "don't work around it, find a materially safer path or ask"; circuit breaker (3 consecutive or 10/50 denials aborts the turn); `/approve` lets the user approve *one retry* of a recent denial; timeouts are not treated as unsafe. Shown in the app as review items with status Reviewing / Approved / Denied / Aborted / Timed out. Selecting a Daybreak (cyber) model auto-switches to Approve for me. **[observed]**
- Approval UI: Enter = approve, Esc = decline; ⌘Enter submits custom approval feedback; mobile card offers **Approve / Always approve / Tell Codex what to do / Deny** (the "tell it what to do" path is first-class). Approvals from *inactive subagent threads* surface with a source label and a key to jump to that thread. **[observed]**
- **Rules** allow/prompt/forbid command prefixes outside the sandbox; **hooks** (`PermissionRequest`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart/End`, `Interrupt`) can allow/deny/rewrite. **[observed]**
- Scheduled tasks run with `approval_policy = "never"` when policy allows, otherwise fall back to the selected mode. **[observed]**

## 9. Notifications

- Desktop: turn-completion alerts never / only-in-background / always; separate toggles for permission and question notifications; Activity view; pets. **[observed]**
- Mobile: push for completion / needs-attention; open a completed task directly from the iOS notification; Home Screen shortcuts, Spotlight, Siri Shortcuts entry points. **[observed]**
- Web: push / email / SMS per category. CLI: `notify` external program on turn completion. **[observed]**

## 10. Attachments & input modalities

- Any file type drag/drop (Shift-drag for images in the app), paste images; iOS: Photos/Camera pickers, recent-photos long-press, videos, attachments work across all hosts (09-01). **[observed]**
- **Appshots** (⌘⌘): frontmost window screenshot + accessible text (including off-screen text). **[observed]**
- **Voice**: dictation (with cleanup + custom dictionary) and full duplex **ChatGPT Voice** (GPT-Live) that can start/check/steer other threads by voice; available through Remote on iOS; separate voice allowance. **[observed]**
- Browser tab mentions via extension, in-app browser with page comments/annotations, Computer Use PiP, Record & Replay → skill. **[observed]**

## 11. Remote (phone → local machine) mechanism

- Host setup: Settings › Connections › "Control this Mac or PC" → approve → QR; phone scans, same account + workspace, MFA/SSO/passkey; one pairing per phone×host; sign-out turns Remote Control off (pairings kept). A "secure relay layer" keeps hosts reachable without exposing them; "keeps active session state and context synced". **[observed]**
- Everything comes from the host: repos, credentials, MCP servers, skills, plugins, browser, Computer Use, sandbox + approval settings. Updates back to the phone: screenshots, terminal output, diffs, test results, approvals. **[observed]**
- Host tiers recommended: your laptop (sleeps → stops), an always-on Mac mini / PC, or an SSH devbox reached *through* the desktop host. Mac laptop with lid closed needs external display + power. **[observed]**
- What the phone can do: start chats in host projects, continue, steer, answer questions, approve, review diffs/outputs, switch hosts, per-chat or cross-chat MCP approvals, voice, `/goal`, `/side`, fork, archive, workspace file browser, directory picker, model/reasoning/Fast changes scoped per task, optional Face ID lock. **[observed]**
- Reliability is a recurring changelog theme (reconnect, stuck Send, missing approvals, stale updates fixed in 08-07, 09-01). **[observed]**

## 12. Cloud tasks + integrations + automation

- Cloud list at chatgpt.com/codex shows per row: title, date, repo, branch (`codex/…`), +/- stats, status (Merged / Closed / Cancelled), Archive; tabs Chats / Code reviews / Security reviews / Archive. Result = summary + diff → open PR or follow up; `codex cloud` applies results locally. **[observed]**
- Triggers: GitHub (`@codex …` on PR/issue), GitLab beta (MR/issue), **Linear** (assign issue to Codex, `@Codex` comment, triage rules auto-delegate; posts progress + summary + chat link), **Slack** (`@Codex` in channel/thread reads thread history, replies with link + answer; admins can suppress answers). Environment is picked by best match or most-recent; repo pinned by naming it. **[observed]**
- **Scheduled tasks**: standalone (new chat per run, can span multiple projects, RRULE custom cadence) or **inside a chat** (heartbeat; minute-based intervals allowed); model/effort per task; local vs worktree; **Scheduled** view acts as an inbox with unread indicator for runs "with findings"; bulk mark-read/archive; created conversationally or by skills; `$skill-name` in the prompt; on web/mobile also **event triggers** (Gmail sender/subject, Slack channel, GitHub PR review/comment/commit/merge) with "Run now" and combined events. Desktop-project tasks need the app running. **[observed]**
- Programmatic: Codex SDK (TS/Python: start/continue/resume thread by ID, per-turn sandbox), app-server JSON-RPC, GitHub Action (`openai/codex-action@v1`, drop-sudo), `codex exec`, MCP client, hooks, `codex://` deep links (threads, settings, ssh add, automations create flow, plugin install). **[observed]**

## 13. Pricing / auth constraints

- Included in ChatGPT Free / Go ($8) / Plus ($20) / Pro ($100–200) / Business ($20–25 seat) / Enterprise; Work and Codex **share** one five-hour-window budget; cloud chats use GPT-5.6 Sol and cost more of the allowance; credits purchasable; API-key mode = local only (no cloud review/Slack/Linear). Linear/Slack integrations need paid plans. Remote GA "across all plans". Voice has a separate allowance. Region/rollout/workspace gates are pervasive. **[observed]**

## 14. What very-happy does NOT have that Codex has

1. Worktree as a first-class run location with base-branch picker, setup scripts, `.worktreeinclude`, auto-cleanup (15) + snapshot/restore, "Create branch here", and **Handoff** Local↔Worktree and host↔host.
2. A Git-state **review pane** (Unstaged/Staged/Commit/Branch/Last turn, multi-repo), per-hunk stage/revert, inline diff comments fed back to the agent, commit/push/PR from the client, PR Chat with reviewer comments.
3. **Scheduled tasks** (standalone + in-chat heartbeat, RRULE, event triggers) with a "Scheduled" inbox of runs-with-findings.
4. **Goal mode** with a persistent progress row (pause/resume/edit/clear).
5. **Approve for me** — a reviewer-agent middle ground between ask-every-time and yolo, with risk levels, rationale, circuit breaker, `/approve` one-retry.
6. Cross-chat attention layer: Activity view, "next needing attention" hotkey, mark-all-read, pets, Micro keys, mobile Priority view.
7. Explicit Steer vs Queue default plus an editable, reorderable queue above the composer, synced from mobile.
8. Cloud sandbox execution + PR flow + GitHub/GitLab/Linear/Slack triggers + code/security review bots.
9. Voice duplex, dictation dictionary, appshots, in-app browser with page comments, Computer Use, Record & Replay.
10. Read-only **shared thread snapshots** with secret redaction and revocable links.
11. `codex://` deep links to open a new chat with prompt + path; project multi-folder with primary folder; content + branch-name search; auto-title suggestions.
12. Memories / Computer History; local environment **Actions** as one-click commands in the top bar.
13. Native permission profiles with deny-globs and network allowlists enforced by an OS sandbox.

## 15. What Codex lacks that very-happy has

1. **A browser is not a control surface.** Remote is mobile-app-only (plus desktop→desktop); ChatGPT web cannot drive a local host, cannot show a local sandbox/approval selector, and there is no self-hostable relay. VH's web/PWA-from-anywhere is unique here. **[observed + inferred]**
2. **Durable remote terminals.** VH's tmux-backed web terminals survive disconnects and are interactive from any browser; Codex's integrated terminal lives inside the desktop app and mobile only sees terminal *output*. Attach-to-existing-tmux has no counterpart. **[inferred]**
3. **Host durability.** Codex Remote stops when the laptop sleeps / app closes and needs re-pairing rituals; VH's daemon + relay model is designed for an always-on machine without a GUI app. **[observed for Codex]**
4. **Self-hosted, own auth, own data.** No dependence on OpenAI account/workspace policies, region gates, or plan tiers.
5. **Engine-agnostic sessions**: Claude Code SDK sessions plus Codex/ACP sessions in one client; Codex only runs Codex (it can *import* from Claude Code/Cursor, not host them).
6. **Machine pairing for arbitrary Linux/macOS hosts** without a desktop GUI app (Codex desktop hosts are macOS/Windows; Linux app is preview and Remote hosts are macOS/Windows only). **[observed]**
7. Task board and notes inside the same client; outbound webhooks + inbound spawn/send/MCP contract (Codex has SDK/app-server but no team-facing webhook contract documented).
8. Full transparency of tool calls/shell commands in the transcript by design (Codex snapshots deliberately strip them; ChatGPT Work hides Git/shell details).

## Sources (all read 2026-09-03)

- https://developers.openai.com/codex/app — desktop app landing (now "ChatGPT desktop app"); nav shows current doc tree (Workflows, Environments, Permissions, Remote).
- https://developers.openai.com/codex/remote — Remote landing: task list mock (host filter, Pinned/Today), approval card (Approve / Always approve / Tell Codex what to do / Deny), diff card, new-task flow.
- https://developers.openai.com/codex/cloud — cloud landing: task list with repo/branch/±/status, environments table, GitHub/Linear/Slack triggers.
- https://developers.openai.com/codex/changelog — dated entries: 2026-09-01 iOS Priority view/queued prompts; 08-25 event triggers; 08-20 shared snapshots, pinned sync; 07-30 Activity view; 07-09 merge (26.707); 06-25 Remote GA + QR pairing; 06-18 host handoff; 06-09 iOS worktree/goal/inline comments; 05-21 goal mode GA/appshots; 02-02 launch.
- https://developers.openai.com/codex/llms.txt — doc index mapping to learn.chatgpt.com/docs/*.md.
- https://developers.openai.com/codex/app/worktrees — worktree mechanics, Handoff, `.worktreeinclude`, cleanup policy, snapshot/restore.
- https://developers.openai.com/codex/app/automations — scheduled tasks: standalone vs in-chat, RRULE, worktree/local, Scheduled inbox, approval_policy never, sample skills.
- https://learn.chatgpt.com/docs/projects.md — projects/chats, multi-folder primary, pin/rename/search/archive, Quick chat.
- https://learn.chatgpt.com/docs/long-running-work.md — /goal, progress row, parallel goals, prevent-sleep.
- https://learn.chatgpt.com/docs/notifications.md — desktop notification controls, Activity view, pets.
- https://learn.chatgpt.com/docs/integrated-terminal.md — per-chat terminal, agent reads output, Actions.
- https://learn.chatgpt.com/docs/code-review.md — review pane scopes, hunk staging, inline comments, PR reviews, detached review.
- https://learn.chatgpt.com/docs/environments/modes.md — Local / Worktree / Cloud selector.
- https://learn.chatgpt.com/docs/environments/local-environment.md — setup scripts, Actions, built-in Git tools.
- https://learn.chatgpt.com/docs/remote-connections.md — pairing, host types, host↔host handoff, SSH hosts, troubleshooting.
- https://learn.chatgpt.com/docs/permission-modes.md — Ask for approval / Approve for me / Full access enablement.
- https://learn.chatgpt.com/docs/sandboxing.md — sandbox modes, approval policies, approvals_reviewer.
- https://learn.chatgpt.com/docs/sandboxing/auto-review.md — reviewer agent flow, triggers, denial semantics, circuit breaker, /approve.
- https://learn.chatgpt.com/docs/permissions.md — permission profiles (beta), extends, deny-globs, network domains.
- https://learn.chatgpt.com/docs/agent-approvals-security.md — protected paths, network proxy, granular approval policy, OTel.
- https://learn.chatgpt.com/docs/environments/cloud-environment.md — container lifecycle, secrets, caching.
- https://learn.chatgpt.com/docs/reference/settings.md — follow-up behaviour, prevent sleep, profile insights, pop-out window.
- https://learn.chatgpt.com/docs/reference/commands.md — full shortcut tables, deep links (`codex://new?prompt=&path=`).
- https://learn.chatgpt.com/docs/reference/slash-commands.md — /approve /fork /goal /side /worktree /cloud etc.
- https://learn.chatgpt.com/docs/features/codex-micro.md — Agent Key status colours, Command Keys.
- https://learn.chatgpt.com/docs/pets.md — pet states and priority order.
- https://learn.chatgpt.com/docs/pricing.md — plans, shared Work/Codex budget, voice allowance.
- https://learn.chatgpt.com/docs/feature-maturity.md — maturity labels.
- https://learn.chatgpt.com/docs/whats-new.md — weekly digest Feb–Aug 2026 (fork from earlier message 03-2026, Activity view 07-30, Linux preview 08-11, event triggers 08-25).
- https://learn.chatgpt.com/docs/glossary.md — definitions of Chat, Handoff, Heartbeat, Finding, Codex-managed worktree.
- https://learn.chatgpt.com/docs/customization/memories.md — local memories, /memories.
- https://learn.chatgpt.com/docs/prompting.md — Steer vs Queue, plan/goal, cloud delegation flow.
- https://learn.chatgpt.com/docs/hooks.md — hook events and permission decisions.
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md — subagent panel, approvals from inactive threads.
- https://learn.chatgpt.com/docs/use-chatgpt.md — Chat/Work/Codex comparison, shared snapshot rules.
- https://learn.chatgpt.com/docs/codex/cli.md — resume, cloud, remote app-server.
- https://learn.chatgpt.com/docs/codex-sdk.md, https://learn.chatgpt.com/docs/app-server.md — programmatic surfaces.
- https://learn.chatgpt.com/docs/image-inputs.md, https://learn.chatgpt.com/docs/features/voice.md — attachments and voice.
- https://learn.chatgpt.com/docs/third-party/github.md, …/linear.md, …/slack.md, https://learn.chatgpt.com/docs/github-action.md — integrations.
- https://openai.com/index/introducing-the-codex-app (2026-02-02), https://openai.com/index/codex-for-almost-everything (2026-04-16), https://openai.com/index/work-with-codex-from-anywhere (2026-05-14), https://openai.com/index/chatgpt-for-your-most-ambitious-work (2026-07-09) — announcements and dates.
- https://community.openai.com/t/where-did-my-chatgpt-projects-go/1386177/16 and https://coursiv.io/blog/codex-merged-with-chatgpt-app — community confusion after the merge (Classic vs new app projects).
