# Orca (stablyai/orca, onorca.dev) — Feature & Surface Inventory

Lens: FEATURE & SURFACE INVENTORY. Researched 2026-09-03 for very-happy (veryhappy.dev).
Evidence basis: 60+ pages (official docs at onorca.dev/docs, GitHub README, GitHub releases
v1.4.194/v1.4.195 dated 2026-09-01/02, repo `docs/reference/*.md`, changelog page, one third-party
write-up). Confidence tags: **[OBS]** = seen in docs/changelog/release notes; **[INF]** = inferred.

## 0. Identity in one paragraph

Orca is an MIT-licensed Electron desktop app (macOS/Windows/Linux; 59.9k GitHub stars, repo created
2026-03-17, ~daily releases, v1.4.195 on 2026-09-02) from Stably AI (YC) that positions itself as an
"ADE" — an IDE whose unit of work is a **git worktree** rather than a file or a chat thread. Each
worktree owns its branch, agent terminals, editor tabs, browser tabs and pane layout. Agents are
**any CLI agent running in a real xterm.js PTY** (30+ preconfigured; Claude Code and Codex get the
deepest hooks). Orca does not sell model access, hosting or seats: "There's no Orca login and no
per-seat pricing"; you bring your own Claude/Codex subscriptions. **[OBS]**

## 1. Surfaces

| Surface | What it is | Limits / notes | Evidence |
|---|---|---|---|
| Desktop app (Electron) | Primary surface: sidebar of projects→worktrees, pane tree (terminal/editor/diff/browser/PR tabs), status bar (usage, accounts, SSH status, caffeinate), right sidebar (Agent Session History, Ports), left entries Tasks / Automations / Agents feed / Agent Dashboard / Artifacts / Skills | Requires Electron even on headless servers (Xvfb) | docs/model/*, docs/settings, headless-linux-server.md |
| Headless runtime `orca serve` | Same runtime without a window on a Linux VPS/VM; prints a pairing URL + JSON ready contract; systemd recipe; state in service-user home | `systemctl restart` kills live PTYs/agents (layout+scrollback persist); no auto-update in headless mode | headless-linux-server.md |
| Remote Orca Server (paired) | Another Orca desktop or `orca serve` **owns** projects/worktrees/PTYs/accounts; laptop, web, mobile, automation pair to it via revocable per-client access links over Tailscale/LAN | Credentials/CLIs must be installed on the server; "Add account" disabled from remote client (use `orca account add` on host) | docs/remote-servers, docs/ways-to-run |
| SSH worktrees | Laptop Orca owns runtime; worktree+agents run on SSH host; editor/diff/browser stay local; relay installed on host; PTYs leased with 5-min grace; Ports tab auto-forwards | Needs node-pty build toolchain on Linux hosts | docs/ssh |
| Cloud VM / per-workspace env (experimental) | `orca.yaml` recipe boots a sandbox/VM/Docker per worktree (Vercel Sandbox, Fly, Modal, SSH, Docker); connection via `orca serve` pairing or SSH | BYO provider account | docs/ways-to-run |
| Mobile companion (iOS App Store/TestFlight, Android APK) | Pairs to a desktop or remote server; lists worktrees across all hosts; agent status; scrollback; reply/attach photo/dictate; Chat UI; Source Control (stage/commit); create workspace; account switcher + usage; push on agent finish; Quick Commands | "Read-mostly remote control"; desktop must be running; LAN pairing drops when desktop closes; Orca Relay (sign-in required) is the alternative path | docs/mobile |
| Web client (paired) | Mentioned only in passing: `webClientUrl` in `orca serve` JSON; "paired web clients" hide Caffeinate; no Download action | Not a documented first-class surface **[INF: secondary, incomplete]** | headless-linux-server.md, docs/settings, docs/ssh |
| Orca CLI (`orca …`) | Scripts a running runtime: repos, worktrees, terminals (read/send/wait), files/diffs, browser (goto/snapshot/click/fill), computer use, iOS/Android emulators, Linear, automations, artifacts, orchestration, skills | Ships with app; must be registered from Settings | docs/cli/* |
| Floating terminal / floating workspace | Global shell surface not tied to a worktree (`Cmd+Option+A`) | — | docs/terminal, docs/settings |

## 2. Unit of work and lifecycle

**Unit = worktree** (a real `git worktree` under Orca's managed dir). Hierarchy: Project (repo or
multi-repo project group) → worktree (a.k.a. workspace) → tabs (agent terminals, shells, editor,
diff, browser, PR). An **agent session** = one CLI agent in one terminal in one worktree. **[OBS]**

Per-worktree lifecycle (docs/model/worktrees): Create (name, start-from ref, optional
GitHub/Linear/Jira/GitLab link, "Run on" host, agent, Advanced: explicit branch name, parent
workspace) → Work → Review (diff vs start-from ref, annotations, attribution) → Ship (commit, push,
PR, checks) → Archive/delete (one click removes dir + branch; "preserved branches" review if
unmerged). Creation runs in the background with a progress row; unnamed worktrees get marine-creature
names; Slack-style `:emoji:` names are supported and rewritten to shortcodes for branch names.

Bootstrapping a clean checkout: Worktree Shared Paths (APFS clone/symlink), `orca.yaml
worktree.sharedDirectories`, `.worktreeinclude` (copy `.env` etc.), and Repository hooks (auto-run
`pnpm install` on create). **[OBS]**

Session lifecycle (docs/model/agents-sessions): Launch (agent combobox spawns CLI with full-autonomy
flag) → Work (state from OSC title + Orca-managed status hooks) → Idle (fires agent-finished
notification) → Exit (Restart chip rehydrates same agent/cwd/account).

| Lifecycle op | How Orca does it | Evidence |
|---|---|---|
| Create | Sidebar `+`, `Cmd-J` "Create worktree" row from an unmatched query, from a GitHub/Linear/Jira issue card, from mobile, from CLI `orca worktree create --agent codex --prompt …` | worktrees, quick-open, mobile, cli/reference |
| Name/rename | Inline double-click rename; conversation name from Claude/Codex "AI Vault" title on tab; manual rename wins | worktrees, terminal |
| Resume | Agent Session History panel scans `~/.claude`, `~/.codex`, Cursor, OpenCode… and runs `claude --resume <id>` etc. in a fresh terminal; Hibernation auto-resumes with same flags on reopen; Restart chip | session-history, hibernation |
| Fork / handoff | "Continue in New Session…" starts a fresh agent (same or different CLI) with a bounded handoff prompt from the transcript; original untouched | agents/codex |
| Archive/sleep/delete | Right-click → archive / sleep / delete; Sleep/Delete with Descendants; multi-select; Resource Manager cleanup across hosts | worktrees, hibernation |
| Cross-device handoff | Remote Orca Server keeps sessions; reconnecting client returns to server-owned workspace/tab/pane state; mobile Chat UI is "a view over the paired desktop session" | remote-servers, mobile |
| Restore after quit | Daemon owns PTYs: Cmd-Q, crash, auto-update keep agents running; host reboot kills agents but restores layout+scrollback | session-restore |

## 3. Multi-session handling ("tracked in one place")

- **Sidebar**: projects → worktrees; cards show inline agent rows with state glyphs; unread worktrees
  are **bolded, not badged**; pin; header filter (hide sleeping / default-branch / automation-created
  / CLI-created / other-client / detached HEAD); host badges. **[OBS]**
- **State vocabulary** (shared across sidebar, tabs, dashboard, palette): spinner = working; amber
  `?` = waiting on you (permission/input); emerald check/dot = done; red = blocked/failed; gray =
  idle; none = unrecognized CLI. Nine badges get hover tooltips (changelog). Nested Codex Task
  subagents / Claude Agent Teams teammates appear as expandable child rows. **[OBS]**
- **Agent Dashboard** (experimental): kanban with **Needs You / Working / Done / (Idle hidden by
  default)** columns, search, project/workspace-status/PR-status filters, cards tinted amber for
  Needs You and green for Done, in-window or pop-out. **[OBS]**
- **Agents feed**: chronological threaded feed of completions, blocking questions, new worktrees,
  last-response preview; running agents pinned on top; unread badge. **[OBS]**
- **Jump Palette `Cmd-J`**: empty query shows "Recent Chats & Terminals" ranked needs-you → done →
  idle with `Cmd-1..6`; the tab you are already on is omitted; Tab opens host/project filters;
  Shift-Enter opens in a split. **[OBS]**
- **Worktree checkpoints**: free-text comment + workspace status (`todo/in-progress/in-review/
  completed`) shown on the card; agents write it via `orca worktree set --comment …` ("keep humans
  in the loop without forcing chat"). Landing mock shows cards like "claude · refactoring v3 mock…".
- **Hibernation**: after 30 min (1 min–24 h) done-and-untouched background agents are stopped and
  auto-resumed with `--resume` when the worktree is reopened; never while mobile is driving the
  terminal or an orchestration dispatch is unsettled. **[OBS]**

## 4. Worktree/isolation model — fan-out & compare

The hero recipe ("Race three agents on the same task"): create 3 worktrees from the same start-from
ref, launch a different agent in each, paste the same prompt, split panes to watch, review each
diff, annotate the winner, commit/push/PR from it, delete the losers (branch goes with them). There
is **no automatic diff-vs-diff comparison, scoring or merge tool** — "compare and merge the winner"
is a human reading three separate diff views. **[OBS + INF]** Parent/child worktree nesting exists
(sidebar only, no git semantics) and orchestration `worker-start --worktree new-child` creates
children. Landing mock shows "Splitting auth rewrite into 2 PRs… 2 children · Creating workspaces…".

## 5. Diff & review

- Diff viewer: combined diff (staged+unstaged+untracked) vs start-from ref, retargetable to any
  commit/branch; line numbers; image diffs (side-by-side/swipe/onion); HTML preview beside diff;
  three-way merge-conflict UI; stage by hunk/line; file tree; `j/k n/p s c` keys. **[OBS]**
- **Annotate AI Diff**: `+` in gutter or `c` → markdown comment pinned to line, tracked across
  edits; **Send to agent** composes ONE line-anchored batch prompt and opens a "Send notes to" menu
  of the worktree's agents (or start a new one); comments persist after revision; Resolve collapses;
  unresolved ones ride the next batch. Rationale stated: batching avoids the agent "swinging back
  and forth". **[OBS]**
- Attribution: per-line AI vs human provenance recorded when an agent writes through its tooling;
  human edits flip it back; local-only, exportable. **[OBS]**
- Markdown review notes on rendered text (`Cmd+Shift+A`). **[OBS]**
- Source Control panel: stage/discard, Generate commit message with AI, Fix with AI on hook
  failure (repair prompt only, never bypass), Push / force-with-lease as explicit separate action,
  Create PR with AI-generated title/body, stacked GitHub PRs, auto-merge/merge-queue, Resolve with
  AI for conflicts, code breakdown chip (source/tests/generated). Per-repo **action recipes** choose
  agent/args/prompt template for each AI action. **[OBS]**

## 6. Terminal integration

xterm.js (VS Code's) with WebGL, kitty keyboard protocol (real Shift+Enter), OSC 52 clipboard on
by default, OSC 8 link action popover (Orca browser / system browser / copy), find-in-scrollback,
Ghostty/Warp theme import, splits inside tabs, per-worktree pane tree with pinned boundaries,
scrollback restore, "Copy Context" (bounded transcript to clipboard), Quick Commands (saved shell
commands and agent prompts, global/project scope, per-host collections, synced to mobile).
**Agents are opaque PTYs**: state is inferred from OSC title sequences and Orca-installed status
hooks; "if you don't see status indicators, the agent CLI in that session isn't one Orca
recognizes — start it through the agent combobox". **[OBS]**

**Chat UI (experimental)** layers a decoded transcript + composer over the same PTY for Claude,
Codex, Grok, OMP; "the terminal remains the source of truth". A separate "updated structured native
chat" keeps session state in Orca — **only for new local Codex sessions on macOS/Linux**; Windows/
WSL/remote/SSH stay terminal-backed. Composer: `/` slash catalog per agent, model/effort pills probed
from the installed CLI, AskUserQuestion/permission cards rendered with Submit, image attachments
(release v1.4.195 adds paste + previews). **[OBS]** Consequence: nothing like a server-side,
queryable message log; history is whatever the agent CLI wrote to disk plus terminal scrollback.

## 7. Permissions / approvals

Default launch is **full autonomy**: `--dangerously-skip-permissions` (Claude), `--dangerously-
bypass-approvals-and-sandbox` (Codex), `--yolo` (Gemini/Cursor/…) — "the worktree itself is the
sandbox". Settings → Agents → Agent Permissions flips all uncustomized agents between **Yolo** and
**Manual**; per-agent launch-arg overrides opt out of migrations. In Manual mode approvals are the
CLI's own TUI prompts; Orca surfaces them only as the amber "needs you" state, a Chat UI card, or a
mobile "reply `yes`/`continue`". Orchestration adds coordinator-level **decision gates** and
`orca orchestration ask --options …` for worker→coordinator questions. Landing mock: "awaiting
permission · sudo apt install" on a card. **[OBS]** No server-side policy, no per-tool allowlist UI
in Orca itself. **[INF]**

## 8. Notifications & unread

Agent-finished ping on working→idle (system notification + sound + worktree chip; custom sound file
and volume per category; PR check failures; update available). Persistent header bell with
cross-worktree unread list; click jumps to worktree+pane; right-click **mark unread**; macOS Dock
badge mirrors unread count. Mobile push mirrors desktop. Agents feed is the catch-up surface.
Sidebar: unread = bold. Tabs: "completed-but-unread" state. **[OBS]**

## 9. Attachments & input

Drag files/images from Finder onto an agent terminal (paths pasted; uploaded first for SSH),
into markdown editor, into file tree. Design Mode attachment (HTML neighborhood + computed CSS +
cropped screenshot + source map line). Linear issue images/media auto-included in launch prompt.
Mobile: photo/file attach, mic dictation, `@` file mentions. Desktop **voice dictation** with
on-device models (Parakeet, Zipformer, SenseVoice, Whisper) or cloud OpenAI; toggle/hold modes;
sound-reactive visualizer. **[OBS]**

## 10. Browser, Design Mode, computer use

Per-worktree embedded Chromium (tabs scoped and restored per worktree; cookie import from
Chrome/Edge; profiles with isolated partitions/UA/viewport; device emulation; downloads shelf;
remote-page rendering locally with traffic through server/SSH host). **Design Mode**: toggle,
hover-highlight, click element → attachment into active agent terminal → type the change → agent
edits → hot reload → click again. Browser also scriptable by agents (`orca snapshot/click/fill/
wait/screenshot/console/network`). **Computer use** (`orca computer …`) via accessibility trees
for native apps; iOS Simulator and Android (adb/scrcpy) bridges. **[OBS]**

## 11. Integrations

GitHub (OAuth via `gh`; PRs, checks with job logs, reviews/comments/reactions, issues with
timeline, Projects "Tasks" view, auto-merge, stacks, "Fix broken checks"), GitLab (MRs, pipelines
incl. child jobs), Bitbucket Cloud, Azure DevOps, Gitea (PRs in sidebar), Linear (drawer, create
worktree from issue with Linear's branch name, edit fields, `orca linear` CLI + skill), Jira (Cloud
and Server/DC, multi-site). MCP servers registered under Settings → Integrations → MCP appear in
agent CLIs. No Slack/Discord/webhook outbound documented. **[OBS]**

## 12. Automation

- **Orca CLI** for agents (skills `orca-cli`, `orchestration`, `computer-use`, `orca-linear`,
  emulators, `orca-per-workspace-env`; hybrid stubs that load version-matched guides from the
  binary via `orca skills get`).
- **Orchestration**: Run (namespace + inbox) → Tasks (spec, deps, status) → Dispatches (one attempt
  on a terminal) → workers send `worker_done`/`heartbeat`/`ask`; decision gates; group addresses
  `@all/@idle/@claude/@codex`; federated workers on other hosts via `--on`. Task IDs printed in
  terminals are clickable → focus the assigned terminal. **[OBS]**
- **Scheduled automations**: presets/cron/RRULE + timezone, `--precheck` shell probe, target repo
  or existing worktree, `--reuse-session`, missed-run grace, cross-host table, run history + Rerun.
- **Artifacts**: publish HTML/MD as public links through an Orca account (opt-in gate). **[OBS]**
- **Plugins** (experimental, marketplaces). **[OBS]**

## 13. Auth, pricing, privacy

Free, MIT. No Orca login for core use; an **Orca account** exists only for Orca Relay (mobile
pairing path) and Artifacts. Anonymous PostHog telemetry with `DO_NOT_TRACK` opt-out; "No user
account information (Orca has no account system)". Enterprise page: SOC 2 *readiness*, rollout
guidance, "no model in the middle". Auth to agents is the CLIs' own; multi-account Claude/Codex via
isolated homes + credential pointer rewrite (swap is instant, running sessions keep old account).
Usage/rate-limit numbers are read from `~/.claude`/`~/.codex` on disk (no API calls), 5h/daily/
weekly windows, 80% warning chip, "% used vs % remaining", estimated cost with "inferred pricing".
**[OBS]**

## 14. What very-happy does NOT have that Orca has

1. Worktree as the unit of work: create-from-issue, start-from picker, shared paths/`.worktreeinclude`,
   background creation, one-click delete of dir+branch, parent/child nesting, N-way fan-out recipe.
2. In-app diff viewer with hunk/line staging, image diffs, conflict UI, HTML preview beside diff.
3. Annotate AI Diff: line-anchored comments → single batched prompt → agent; persistent/resolvable.
4. AI-vs-human line attribution.
5. Commit/push/PR/checks/auto-merge/stacked PRs in-app; AI commit messages & PR bodies; Fix with AI
   on hook failure; Resolve with AI for conflicts; per-repo action recipes.
6. GitHub/GitLab/Bitbucket/Azure/Gitea PR state on the card; GitHub Projects/Linear/Jira drawers.
7. Per-worktree embedded browser + Design Mode + browser profiles + agent-scriptable browser.
8. Usage & rate-limit roster in the status bar; multi-account hot-swap; mobile "use reset credit".
9. Attention model: Needs You / Working / Done kanban, Agents feed, bell with mark-unread, Dock
   badge, `Cmd-J` recents ranked needs-you-first with digit shortcuts.
10. Agent-writable worktree status comment + workspace status on the card (CLI checkpoint).
11. Agent Session History (scan every CLI's on-disk transcripts, resume any), hibernation
    auto-sleep/resume, "Continue in New Session" handoff.
12. Quick Commands (saved shell commands + agent prompts, synced to mobile).
13. Any-CLI-agent support (30+), Codex multi-home, Cursor CLI, Grok pickers.
14. Orchestration runs/tasks/dispatch/gates and scheduled automations with precheck.
15. Native mobile apps with push, dictation, file tree, source control; on-device voice dictation.
16. SSH worktrees with port forwarding, Cloud-VM recipes, computer use, mobile emulators, artifacts.
17. Split-pane tab tree per workspace with pinned boundaries and full layout restore.

## 15. What Orca lacks that very-happy has

1. A **structured, server-persisted transcript** as the source of truth (SDK messages, tool
   blocks, diffs rendered as cards, queryable history) — Orca's chat is a decoded overlay on a PTY,
   experimental, and structured-native only for local Codex on macOS/Linux.
2. **Web/PWA as the primary surface from any browser**; Orca is an Electron desktop app whose
   paired web client is undocumented and feature-gapped.
3. First-class **permission requests** with structured approve/deny, permission modes, server-side
   enforcement (yoloEnforcement) — Orca defaults to bypass flags and otherwise leaves you with TUI
   prompts.
4. A **relay server with its own auth** reachable over the public internet (Orca requires Tailscale/
   LAN pairing; Relay only for mobile and requires sign-in).
5. **Durable tmux-backed remote terminals** attachable from any browser, including attaching
   existing user tmux sessions (B-273); Orca's PTYs die on host reboot/`systemctl restart`, and
   SSH leases have a 5-min grace.
6. Product-owned **task board, notes, /btw side-questions, meta assistant/dispatcher**; Orca
   offloads tasks to GitHub Projects/Linear/Jira and has no side-question fork (only "Copy Context"
   and "Continue in New Session").
7. SDK-level control channels (Queue / Steer / Stop) and Claude auth preflight/diagnostics.
8. Codex via ACP as a structured session (Orca runs Codex in a PTY; structured only experimentally).

## Sources (all read 2026-09-03)

- https://github.com/stablyai/orca — README: feature list, supported agents, install, MIT; repo meta via API (59,879 stars, created 2026-03-17, pushed 2026-09-02).
- https://github.com/stablyai/orca/releases — v1.4.195 (2026-09-02) and v1.4.194 (2026-09-01) notes: native chat image paste/previews, worktree-create perf, relay/daemon PTY reaping, docs published with releases.
- https://onorca.dev/ — landing: sidebar/card mock (agent status lines, "awaiting permission"), review mock (notes → Send notes to Claude/Codex), "Where should the agent run?" picker, testimonials.
- https://onorca.dev/docs — "What is Orca": positioning, not-a-VPS product.
- https://onorca.dev/docs/first-session — 3-agent race walkthrough, marine-creature names, default agent.
- https://onorca.dev/docs/model/worktrees — worktree model, lifecycle, shared paths, sidebar filters, multi-select, preserved branches, project groups, non-Orca worktrees.
- https://onorca.dev/docs/model/tabs-panes-splits — pane tree, splits, per-worktree layout.
- https://onorca.dev/docs/model/agents-sessions — state glyphs, Agent Dashboard columns, yolo launch defaults, Restart chip, lifecycle.
- https://onorca.dev/docs/model/session-restore — daemon-owned PTYs, what survives quit vs reboot.
- https://onorca.dev/docs/model/quick-open — Cmd-P, omnibox, Cmd-J recents ranking, digit shortcuts, create-worktree row.
- https://onorca.dev/docs/agents/supported — agent table, permission-bypass defaults, Yolo/Manual switch.
- https://onorca.dev/docs/agents/claude-code — Claude integration: status-line hook, account swap, subagents/teams rows.
- https://onorca.dev/docs/agents/codex — Codex homes, nested Task subagents, Continue in New Session.
- https://onorca.dev/docs/agents/native-chat — Chat UI experimental, terminal is source of truth, structured chat scope, question cards.
- https://onorca.dev/docs/agents/session-history — transcript scan/resume across CLIs.
- https://onorca.dev/docs/agents/hibernation — auto-sleep conditions and resume.
- https://onorca.dev/docs/agents/usage-tracking — local usage files, windows, 80% chip, roster popover, estimated cost.
- https://onorca.dev/docs/agents/codex-hot-swap — account switcher mechanics.
- https://onorca.dev/docs/agents/hooks-memory — status hooks, worktree setup hooks, endpoint persistence.
- https://onorca.dev/docs/review/diff-viewer — diff features and keys.
- https://onorca.dev/docs/review/annotate-ai-diff — batch review loop.
- https://onorca.dev/docs/review/attribution — AI/human line provenance.
- https://onorca.dev/docs/review/commit-push — commit/push/PR, AI actions, action recipes, force-with-lease.
- https://onorca.dev/docs/review/github — providers, checks, auto-merge, stacks, issues, Tasks.
- https://onorca.dev/docs/review/linear — Linear drawer, branch names, images in prompt, CLI.
- https://onorca.dev/docs/review/jira — Jira Cloud/Server, multi-site.
- https://onorca.dev/docs/editing/file-explorer — drag-drop to agent terminal, SSH upload.
- https://onorca.dev/docs/editing/monaco, /editing/markdown, /editing/viewers — editor, review notes, artifacts share, viewers.
- https://onorca.dev/docs/browser/overview — per-worktree browser, remote rendering, link routing, CLI automation.
- https://onorca.dev/docs/browser/design-mode — element capture contents.
- https://onorca.dev/docs/browser/profiles — profile isolation.
- https://onorca.dev/docs/terminal — xterm, kitty protocol, OSC 52/8, Copy Context, floating terminal, Quick Commands.
- https://onorca.dev/docs/ways-to-run — Local/SSH/Remote Server/Cloud VM comparison table ("Laptop, web, mobile, and automation can share the same runtime").
- https://onorca.dev/docs/ssh — SSH targets, leases, ports, host keys.
- https://onorca.dev/docs/remote-servers — pairing links, revocation, `orca serve`, mobile QR.
- https://onorca.dev/docs/cli/overview, /cli/reference — command surface, selectors, hosts, artifacts, accounts.
- https://onorca.dev/docs/cli/orchestration — Run/Task/Dispatch/gates/ask.
- https://onorca.dev/docs/cli/automations — schedules, precheck, reuse-session.
- https://onorca.dev/docs/cli/computer-use — accessibility-tree control.
- https://onorca.dev/docs/cli/worktree-checkpoints — agent-written comment/status.
- https://onorca.dev/docs/cli/skills — skills registry, MCP.
- https://onorca.dev/docs/mobile — companion capabilities, pairing, Relay, Chat UI, Quick Commands, reset credits.
- https://onorca.dev/docs/android-apk — APK sideload.
- https://onorca.dev/docs/notifications — pings, bell, mark unread, Dock badge, sounds.
- https://onorca.dev/docs/activity — Agents feed.
- https://onorca.dev/docs/recipes/parallel-agents, /review-ai-diff, /jump-worktrees, /design-mode-fix, /remote-worktrees — canonical workflows.
- https://onorca.dev/docs/settings — full settings map incl. Voice, Artifacts, Plugins, Experimental, Workspace Board shortcut.
- https://onorca.dev/docs/telemetry — anonymous PostHog telemetry, "no account system".
- https://onorca.dev/docs/install — channels (stable/RC), first-launch imports.
- https://onorca.dev/docs/troubleshooting — failure modes (agent won't start, SSH terminals, memory).
- https://onorca.dev/changelog — recent feature batches (Agent Dashboard, Chat UI, plugins, artifacts, stacked PRs, cross-host automations).
- https://onorca.dev/enterprise — SOC 2 readiness, local-first, no model in the middle.
- https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md — Xvfb/systemd, `webClientUrl`, PTYs die on service restart, no headless auto-update.
- https://github.com/stablyai/orca/blob/main/docs/reference/remote-wire-compatibility.md — mixed client/host versions are "the normal state"; capability negotiation rules; `agentWait` absent≠not-waiting.
- https://medium.com/@linz07m/orca-runs-five-coding-agents-at-once-then-lets-you-pick-the-winner-0cd3c9743119 (2026-07-16) — third-party: "no Orca login and no per-seat pricing", star growth.
