# Paseo (paseo.sh) — Feature & Surface Inventory

Lens: FEATURE & SURFACE INVENTORY. Researched 2026-09-03 for very-happy (veryhappy.dev).
Latest Paseo release at time of reading: **v0.7.2 (2026-09-02)**; desktop download links point at v0.7.2; App Store shows 0.7.2 "1h ago".

Legend: **[O]** = observed in official docs / changelog / screenshot / store listing; **[I]** = inferred from those sources (not stated outright). Every claim carries a source in the Sources section (S-n).

Note for the Owner: `specs/2026-08-workspace-context.md` (B-208) already cites an earlier "Paseo 产品/源码只读研究" (2026-08-26). This inventory is doc/changelog-based only (no repo clone) and is current to v0.7.2.

---

## 1. Positioning in one paragraph

Paseo is a **daemon-first control plane**: a Node daemon on the machine that owns the agent processes, worktrees, terminals, dev-server proxies, schedules, and plugins; desktop (Electron, mac/linux/win), native mobile (Expo/React Native, iOS/Android), web (hosted app.paseo.sh or daemon-served), CLI, MCP and TypeScript SDK are all thin clients over one WebSocket API. [O, S1, S5, S14] It runs the provider CLIs you already have (Claude Code via the Agent SDK, Codex, OpenCode, Pi, OMP natively; ~35 more via ACP; custom CLI providers) and does not proxy model calls. [O, S1, S21] The unit of work is the **workspace** (a directory + optional managed worktree) containing multiple **sessions** (agent chats, terminals, browsers, diffs, plugin panels) as tabs. [O, S6] Hub is a separate, optional, multi-tenant service (self-host free, hosted €15/seat/month) that turns GitHub/Slack/Discord events into agent runs on your daemons via YAML workflows. [O, S17, S18]

## 2. What Paseo says about Happy Coder (very-happy's upstream) [O, S4]

| Dimension | Paseo's claim about itself | Paseo's claim about Happy Coder |
|---|---|---|
| Architecture | Daemon owns agent lifecycle, worktree, dev servers | Wraps the agent CLI on your laptop, syncs via E2E relay |
| Providers | Claude Code, Codex, OpenCode, Pi native + 30+ ACP + custom | Claude Code, Codex only |
| Desktop | macOS, Linux, Windows | macOS only |
| Native mobile | iOS, Android | iOS, Android |
| Split panes / terminal / browser preview | Yes / Yes / Yes | Yes / Yes / Yes ("conversations beside files, diffs, terminals, and previews") |
| GitHub workflow in app | Commit, push, PR, checks, reviews, merge | "—" (none) |
| Worktrees | Managed lifecycle (create, setup hooks, teardown, remove on archive) | "Existing worktree paths" only; does not create/manage lifecycle |
| Per-worktree dev-server URLs | Yes | — |
| CLI | run, `--host`, ls, send, schedule, loop | Launch and control sessions; "does not document schedules or loops" |
| Application plugins | Server code + native client components | No |
| Voice | Local or cloud speech | Yes |

The page concedes Happy has voice, native mobile and split-pane layouts; the attack surface is **GitHub/PR flow, worktree lifecycle, multi-provider, plugins, schedules and desktop OS coverage**. Several of these do not map to very-happy as-is (very-happy is web/PWA only, server-trusted, single-owner), but the PR flow, worktree lifecycle and scheduling gaps are real for very-happy too (see §16).

## 3. Surface inventory

| Surface | Status | Notes |
|---|---|---|
| Desktop app (Electron; mac/linux/win) | [O] primary | Bundles the daemon; hosts browser tabs for agent browser tools (desktop-only feature) [O, S24]; multi-window; custom win/linux window controls (0.6.0). Author switched from Tauri to Electron for notifications + daemon bundling [O, S28]. |
| Native mobile (iOS/Android, Expo) | [O] | Store listing claims push notifications, voice, worktrees/diffs/ship from app [O, S26]. Claims "full feature parity with desktop" on homepage [O, S1]; observed exceptions in §14. Also F-Droid metadata (0.7.0). |
| Web app | [O] | Hosted app.paseo.sh, or daemon-served (`paseo daemon start --web-ui`, same-origin auto-connect; static files served before auth by design) [O, S14]. |
| CLI (`@getpaseo/cli`) | [O] | "Same interface exposed by the daemon's API": run/ls/attach/send/logs/wait/stop, project/workspace/script/plugin/schedule/permit/agent mode/detach/daemon/hub; `--host` accepts host:port, unix socket, `ssh://`, or a relay pairing-offer URL [O, S8, S12]. |
| MCP server (daemon) | [O] | Injected into every new agent when "Enable Paseo tools" is on; tools for agents, workspaces, scripts, terminals, schedules/heartbeats, providers, permissions, browser, `speak` [O, S9]. |
| TypeScript SDK (`@getpaseo/client`) | [O] | Create workspaces/agents, wait for finish, list, archive; agents created by SDK appear in the app [O, S20]. |
| Hub (web dashboard + `paseo hub` CLI) | [O] | Separate service; Activity, Configuration, Daemons, Apps screens [O, S17, S18, S19]. |
| VS Code extension | [O] | Listed as related project `paseo-vscode` in README [O, S5]. |
| Docker image | [O] | Daemon + bundled web UI, non-root user, `PASEO_PASSWORD` [O, S2, S13]. |

## 4. Object model and unit of work [O, S6, S7]

```
Host (daemon, named + coloured)          # multiple hosts visible in one sidebar (0.1.102)
└─ Project (git repo / GitHub project / any directory)
   └─ Workspace  (isolation = local | worktree; has title, branch, status, diffStat, labels)
      └─ Sessions as tabs: agent chat(s), terminal(s), browser tab(s), Diff tab, file editor, plugin panels
         └─ Agent: provider/model/mode/thinking, parentAgentId (subagents), labels
```

- "Paseo is organized around workspaces, not chats." A workspace can hold several agents at once (implement + review + terminal + browser). [O, S6]
- Workspace **status enum** (from plugin SDK snapshot): `needs_input | failed | running | attention | done`; agent `attentionReason`: `finished | error | permission`. [O, S16]
- Sidebar groups by status: **Waiting on you / Ready to review / Working / Done** (0.1.90, #1317), with "mark as read" for ready-to-review/failed rows. [O, S10, S3-screenshot shows "Ready to review / Working / Done"]
- Multiple workspaces may point at the same directory (0.1.97 "Simplify workspace model"); the same repo added on two machines collapses into one project (0.2.4). [O, S10]

## 5. Session lifecycle

| Step | Paseo behaviour | Evidence |
|---|---|---|
| Create | "New workspace" screen: pick project (fuzzy search, ⌘P to switch), isolation (local / worktree: branch-off from base incl. local-vs-origin choice, checkout branch, checkout PR by number or pasted PR link), provider/model/mode/thinking (remembers last choices; host-wide **agent profiles**), optional terminal at creation; drafts persist across project/host switches and archiving. Workspace can exist without an agent. Clone a GitHub repo or create a folder from Add Project. | [O, S6, S10 0.1.91/0.1.97/0.1.104/0.1.108/0.3.0/0.4.0] |
| Name | Title + branch slug auto-generated from first prompt by a small model (haiku → gpt-5.4-mini → minimax → nemotron fallback chain, per-project wording instructions in `paseo.json`); agents may rename the workspace once they understand the task; user can rename workspace/terminal/agent tab; option to show branch instead of title. | [O, S22, S10] |
| Resume / import | Import existing Claude/Codex/OpenCode/Pi sessions started in a terminal, with full timeline (`paseo import --provider <name> <id>`); copy Pi resume command to go back to the terminal. Idle agents release their process and resume on demand (0.2.0). | [O, S10 0.1.71/0.1.79/0.2.0] |
| Fork | Fork chat into a new tab or a **new worktree**; fork while running; fork from a failed turn; fork across providers ("fork the entire convo history to a new harness when I exhaust the quota" — store review). | [O, S10 0.1.102/0.1.107/0.1.108/0.3.0; S26] |
| Rewind | "Rewind chat **or files** from any user message" (0.1.82); Codex rewind on paginated threads fixed 0.7.2. | [O, S10, S11] |
| Steering vs queue | Setting: Enter while running either interrupts immediately or queues; 0.5.0 added **active-turn steering** for Claude/Codex/OpenCode (0.7.2 for Pi) so a message reaches the running turn without interrupting. Mid-turn mode/thinking changes are labelled "applies next turn". | [O, S10 0.1.51/0.5.0/0.1.98; S11] |
| Archive / History | Archive workspace (confirm if uncommitted/unpushed work); worktree torn down after last workspace archived; **History** screen searchable by workspace/agent/branch; reopen archived workspace even after worktree removal; archived agent callout with unarchive; auto-archive PR workspaces after merge (host setting). Archive is optimistic with rollback. | [O, S6, S10 0.1.67/0.1.76/0.1.90/0.1.97/0.3.0] |
| Hand-off between devices | State lives in the daemon; every client sees the same workspaces/agents; cached projects/workspaces/timelines restore immediately while hosts reconnect (0.5.0); "Open existing agents from Paseo links or the CLI" (0.2.0). Store review (Aug 17) complains mobile returns to home and loses projects after backgrounding — parity is not fully there. | [O, S10; S26] |
| Hand-off between agents | `/paseo-handoff` skill writes a self-contained briefing and starts another provider (optionally in a worktree); `/paseo-advisor`, `/paseo-committee`. | [O, S23] |
| Subagents | Paseo subagents (any provider, full sessions, can receive follow-ups) vs native provider subagents (read-only timelines); both in a **Subagents track/pill above the composer**; detach a subagent to top-level; "Archive finished" archives all finished subagents; parent gets notified when child finishes/errors/needs permission. | [O, S15, S10 0.1.53/0.1.98/0.5.0] |

## 6. Multi-session handling (sidebar and navigation) [O, S10, S3]

- Status-grouped sidebar (§4), unread marks, **Pinned** section with drag reorder, **labels** for organisation/filtering, project filter, collapse per project, per-row badges (host, PR number + checks, scripts), host name + colour, "show branch names instead of titles".
- **Command Center (⌘K)**: search workspaces/agents/history, PR/MR number search, switch model/reasoning/mode/plan/fast, git and workspace actions, layout/pane actions, plugin items; sidebar grouping inside it. **⌘P** workspace file search; **⌘O** open project from anywhere; numbered workspace shortcuts; Shift+Tab cycles agent modes; shortcuts remappable and searchable.
- Split panes (⌘D vertical, ⌘⇧D horizontal), tabs per workspace, "New tab" chooser, drag files/diffs/agents/terminals/PRs/plugin panels into panes (0.6.0), workspace focus mode, multiple desktop windows.
- Only the active workspace's screens are retained for speed; recent chats stay live in background (0.3.0).
- Home screen with quick tiles (add project, import session, providers, pair device).

## 7. Agent thread view [O, S3 screenshot, S10]

Observed in the homepage mockup (built from real product states) and matching changelog entries:

- Header: workspace tabs row (`Codex`, `Claude Code`, `npm run dev`, `https://localhost:3000`), **Commit** button and run/service controls top-right, right pane tabs **Files / Changes / PR #3981**, branch selector, "Uncommitted +1.9k −684" folder tree with per-file stats.
- Timeline: assistant summary bullets, "Worked for 31m 46s" per turn, a **"Create a PR"** action button, then "PR opened: … https://github.com/…/pull/3981 … Ready for review", "Worked for 1m 18s".
- Pills above the composer: **6/6 tasks**, **3 subagents**, **+1.9k −684** (live task progress, subagent track, live change count — 0.4.0/0.5.0).
- Composer placeholder: "Message the agent, tag @files, or use /commands and /skills"; footer pill `GPT-5.6-Sol · Medium · Full access` (model · thinking · permission mode).
- Other timeline features: permission cards (with provider-specific action names), question cards (one at a time), plan cards with provider actions ("Implement"/"Deny"), collapsed tool-call groups (setting), "always expand reasoning" setting, inline images with lightbox/zoom-pan, Mermaid diagrams, context meter ring + provider usage bars that warn near limits, jump between prompts, copy with formatting, steady-rate streaming, 32k-char cap per assistant message (0.7.2), readable rendering of Paseo tool calls, plugin-transformed timeline rows.

## 8. Worktree / isolation model [O, S6, S7]

- Isolation modes: **local** (existing dir) or **worktree** (managed under `$PASEO_HOME/worktrees/<hash>/<slug>`, configurable root). Modes: branch-off (base default `origin/main`; docs warn local `main` is stale), checkout-branch, checkout-pr (GitHub + GitLab/Gitea/Forgejo/Codeberg).
- `paseo.json` in repo root (read from the committed base branch): `worktree.setup` / `teardown` scripts with `$PASEO_SOURCE_CHECKOUT_PATH`, auto-opened `terminals`, named `scripts`, and **services** supervised by the daemon with per-worktree ports (`$PASEO_PORT`, range or external `portScript`) and a deterministic reverse-proxy hostname `http://<script>--<branch>--<project>.localhost:<daemon-port>` (WebSocket-capable, service-to-service env vars). Public service proxy links exist (0.1.89).
- Worktree removed after the last workspace using it is archived; setup tabs appear only on failure (0.5.0).
- Git-less directories work; worktrees optional.

## 9. Diff, review and Git/GitHub [O, S10, S3]

- **Changes** view: collapsible folder tree or flat list, standalone Diff tabs or persisted inline-diff mode, scroll order matches tree, large diffs bounded (0.7.2 fix), **inline review comments by tapping a line number** (0.1.65), add files to chat from Files/Changes, file/folder actions, in-app **file editor** (web + desktop, 0.2.0), HTML/Markdown preview, syntax highlighting.
- **Commits** view: browse commit history, open individual commit diffs; branch switching with auto-stash; git signing respected (0.7.0 fix).
- **GitHub flow in app**: commit (generated message), push (shown before merge when ahead), create PR (generated title/body from diff; per-project instructions), PR panel with checks (outcome summaries, failure-first grouping; GitLab/Gitea manual/action-required states), reviews/threads, refresh button, **attach PR comments, reviews, threads and failed check logs to chat**, merge with method named (squash/merge/rebase), auto-merge surfaced, auto-archive after merge. Requires `gh` installed and authenticated.
- Attach GitHub issues/PRs to a prompt as context; pasted PR/MR links become a checkout option in New Workspace.

## 10. Terminal integration [O, S10, S6, S9]

- Terminals are daemon-managed sessions (dedicated worker process; snapshots restored on reconnect; configurable scrollback). No tmux is mentioned anywhere in docs [I: terminals are plain PTYs owned by the daemon, not tmux-backed].
- Available on desktop, web and **mobile** (new mobile terminal with selection/copy/paste, 0.3.0); iPad Ctrl+C; Shift+Enter handling.
- Terminal rows show whether their agent is working/idle/waiting; drop files onto terminal to insert paths; tap a path in terminal output to open it; reusable **terminal profiles** per host; terminals auto-opened from `paseo.json`; `paseo terminal` CLI and MCP `create_terminal / send_terminal_keys / capture_terminal` so agents can drive terminals.
- "Claude Code also works great inside the Paseo terminal" — the docs explicitly bless the plain-CLI path as an alternative to the structured chat. [O, S25]

## 11. Permissions / approvals [O, S9, S8, S10, S19]

- Permission requests render as cards in the thread; Claude, Codex (incl. MCP requests), OpenCode (session-wide approval option), Pi extension dialogs, ACP tool calls ("approve all ACP tool calls" setting) all normalised into the same prompt UI; stale cards cleaned on cancel (0.7.0).
- **Modes**: provider modes surfaced (plan, bypass, "Full access"; Codex sandbox modes), plus Paseo's own **Auto Review** mode (agent stops after each turn for review) (0.1.76); new Claude/Codex agents default to "safer automatic approval modes when supported" (0.2.0); Shift+Tab cycles; mode change remembered for new agents; changes mid-turn labelled "next turn".
- Out-of-app: `paseo permit ls / allow <id> / deny <id> --all`; MCP `list_pending_permissions` / `respond_to_permission`; child agents inherit unattended permissions across providers; parent agents are notified when a child needs approval.
- Hub: no common sandbox abstraction; per-provider native policy blocks (Codex `sandbox_mode`, Claude `disallowedTools`/`sandbox`, OpenCode `permission`), classifier-then-worker workflows to bound authority, `from_users` allowlists mandatory.
- The phrase "Design semantic permission system" appears **only as a workspace title in the homepage mockup** (a Done item), not as a documented feature. [O, S1/S3] It is plausibly an internal roadmap item [I].

## 12. Notifications [O, S10, S27, S26]

- Desktop notifications with sound and badge counts; **mobile push** ("Agent finished") from the store listing; in-app notifications route "to whichever surface you're actually looking at"; clicking a notification opens the correct workspace/agent (fixed 0.2.0); finish notifications include subagent results; Claude question notifications summarise the requested input.
- Attention model (from issue #1764): server computes a plan from client `appVisible` + `focusedAgentId` + a **180-second presence window**; push is suppressed if any client was active in the window. The issue documents that **permission/question prompts did not push** at that time (June 2026) — a known gap; whether fixed since is not visible in the changelog [I: unresolved].
- Paseo reused the notification requirement ("click the notification and land in the right place") as the reason to move to Electron. [O, S28]

## 13. Attachments and input [O, S10, S3, S16]

- Images: paste (desktop, mobile), drag/drop, picker (HEIC), inline render, lightbox/zoom; **any file** attachment (desktop 0.1.95, mobile 0.1.97); drop files into any composer; `@files` mentions (dot-folders, deep paths); `/commands` and `/skills` autocomplete from the provider (Claude skills, Codex, Pi, Kiro, OpenCode); PR comments/threads/check logs and GitHub issues as context; plugin **attachment sources** (search an external system, insert a text snapshot — the docs example is an issue tracker).
- Voice: **dictation** and **voice mode** (hidden agent session using your Claude/Codex/OpenCode; local Parakeet STT + Kokoro TTS ONNX on CPU by default, OpenAI optional; multilingual v3 model; `speak` MCP tool). Store review and README stress hands-free use.

## 14. Mobile parity — claim vs observed

- Claim: "The native mobile app has full feature parity with desktop." [O, S1]
- Observed exceptions: **browser tools are desktop-only** (daemon routes to a connected desktop app) [O, S24]; App Store review 2026-08-17 reports the app returning to home and losing projects after backgrounding [O, S26]; a long tail of mobile-specific fixes each release (composer/keyboard/sidebar/IME/JS stalls) [O, S10, S11]. Mobile does have terminal, file attach, command center, voice, diff review, PR actions (0.7.0 fix "mobile Changes and pull-request actions").

## 15. Integrations, automation, pricing, auth

| Area | Inventory |
|---|---|
| Forges | GitHub (via `gh`), GitLab, Gitea, Forgejo, Codeberg PR/MR + checks [O, S10 0.2.0] |
| Chat | Slack, Discord — **only through Hub** triggers/replies [O, S18] |
| Issue trackers | No native Linear/Jira; plugin attachment-source pattern shown with a generic issue tracker [O, S16] |
| Editors | Open in VS Code/Antigravity/Android Studio/etc., file managers; VS Code extension [O, S10, S5] |
| Automation | CLI (`--output-schema` JSON output, `wait`, `--background`), MCP (full catalog), SDK, **Schedules** (new agent per cron run; in-app Schedules screen, from chat, CLI, MCP) and **Heartbeats** (recurring prompt into the same agent), Hub YAML workflows (ordered steps, classifiers with enum-bounded outputs, `allow_outputs` reply capabilities, short-lived GitHub App tokens minted per step). `paseo loop` and `paseo chat` were removed in 0.4.0. [O, S8, S9, S17–S19, S10] |
| Orchestration skills | `/paseo`, `/paseo-handoff`, `/paseo-advisor`, `/paseo-committee`, installable from Host settings or `npx skills add getpaseo/paseo` [O, S23] |
| Metadata generation | Titles, branch names, commit messages, PR title/body via cheap-model fallback chain; per-project instruction overrides [O, S22] |
| Pricing | Free, no seat limits; **Apache-2.0 since 0.7.0 (2026-08-31)** — it was AGPL-3.0 as recently as v0.4.0 (third-party review) [O, S11, S29]. Hub hosted €15/seat/month (triggering users don't count as seats), free trial; self-hosted Hub free [O, S18]. |
| Auth | No account; daemon password (bcrypt, bearer/subprotocol; static web UI served pre-auth); relay E2E (Curve25519/NaCl box) **opt-in, off by default** with "QR is a password" warnings; SSH transport (0.7.0); Tailscale direct; DNS-rebinding host allowlist; provider credentials untouched (Claude OAuth in `~/.claude`) [O, S12, S13, S14] |
| Updates | Stable channel with 36-hour staged desktop rollout; beta channel; app stores lag; remote daemon update from the app [O, S30, S10] |
| i18n | Arabic, Chinese, English, French, Russian, Spanish, Japanese, Portuguese-BR, Korean [O, S10] |

## 16. What very-happy does NOT have that Paseo has

(Grounded against very-happy's `specs/` and `docs/backlog.md` as of 2026-09-03: B-042 worktree UI is `todo`; B-208 workspace/Changes view is `doing`; DiffView exists but no git write path; no schedules; voice exists as assistant/TTS.)

1. **Managed worktree lifecycle** — create from base/branch/PR, setup/teardown hooks, auto-teardown on archive, fork-into-worktree, auto-archive after merge. (very-happy: session in an existing path only, same as Happy.)
2. **Per-worktree supervised services with proxy URLs** (`web--branch--project.localhost`) and `paseo.json` scripts/terminals.
3. **Git write path in the UI**: commit (generated message), push, Create-PR (generated title/body), PR panel with checks/reviews/threads, merge, attach failed-check logs to chat; Commits history; branch switching with stash; file editor.
4. **Inline review comments on diff lines** sent back to the agent.
5. **Workspace status groups + unread** (Waiting on you / Ready to review / Working / Done), labels, pinned with drag reorder, per-row PR/checks badges, History search.
6. **Fork / rewind** of a conversation (new tab, new worktree, from a failed turn, across providers) and **import** of terminal-started sessions.
7. **Active-turn steering** as a distinct mode from queue (very-happy has Queue/Steer/Stop via SDK but exposes queue-first; see 铁律 8).
8. **Schedules + heartbeats** with an in-app Schedules screen, chat-created, CLI/MCP-managed, each run its own workspace.
9. **Agent-facing control plane** (MCP tools injected into every agent; CLI recognises calling agent; cross-provider subagents; detach; `--output-schema`; orchestration skills). very-happy's `/assistant` meta-agent is the closest analogue and is considered weak.
10. **Multi-provider** (Codex/OpenCode/Pi/ACP catalog/custom endpoints/multiple Claude profiles). very-happy has Codex/ACP sessions but nothing like a catalog or profiles.
11. **Application plugins** that add panels, sidebar items, slash commands, composer pills, timeline renderers, themes, attachment sources on all clients.
12. **Event triggers from GitHub/Slack/Discord** (Hub) with YAML workflows and scoped GitHub tokens. (very-happy has a webhook/spawn/MCP inbound contract per `docs/channels.md`, but not trigger→workflow routing.)
13. **In-app browser tabs driven by agents** (desktop only), accessibility-tree snapshots, logged-in state.
14. **Local-first speech** (on-device STT/TTS) and a voice mode that can launch/control agents; very-happy's voice uses cloud TTS (ElevenLabs) per backlog.
15. **Live task-progress / subagent / diff-stat pills** above the composer and "Worked for Xm" per turn.
16. Command Center with model/mode switching, PR-number search, layout actions; multiple desktop windows; split panes.
17. Native mobile apps with push notifications (very-happy is PWA; push depends on browser).
18. Provider usage/quota meters in-app (Claude weekly limits, Codex, Copilot, Cursor, Grok, Kimi…). very-happy B-211 "统一 Usage" is `doing`.

## 17. What Paseo lacks that very-happy has

1. **Durable tmux-backed remote terminals** with attach-to-existing-tmux, multi-device width reclaim, tombstones, auto-restore and single-writer locks (`specs/2026-09-attach-existing-tmux.md`, terminal-* specs). Paseo terminals are daemon PTY sessions; nothing in the docs suggests surviving a daemon restart or attaching to a user's tmux [I].
2. **Server-trusted account model** (own email/OTP login, no pairing QR, works from any browser with zero install). Paseo needs a daemon + pairing/password per host and a native/desktop client for the best experience; web is served from the daemon or app.paseo.sh.
3. **Web/PWA as the only client** — zero-install, always up-to-date, no app-store lag or 36-hour rollout; Paseo's web is explicitly the third surface and browser tools do not work there.
4. **Task board, notes, todos, prompt-notes** (`specs/2026-08-task-board.md`, `2026-08-prompt-notes.md`, `2026-08-todo-provider.md`) — Paseo has no board/notes/todo surface; the nearest is workspace labels and History.
5. **`/btw` side-question** (fork the live session context into a no-tool, non-persisted side answer, B-283). Paseo's `/paseo-advisor` spins a full second agent instead.
6. **Meta "assistant" screen** (voice dispatcher over sessions) — Paseo's voice mode is per-agent, not a global dispatcher (though weak in very-happy today).
7. **Structured permission-mode source-of-truth and web-side enforcement** (`yoloEnforcement.ts`, spec 2026-08-permission-mode-source-of-truth) — Paseo relies on provider modes plus an Auto Review mode; no documented equivalent to "web enforces the selected mode against old wrappers".
8. **Blue/green zero-downtime release of server+web as one image** and a documented ops runbook — Paseo ships desktop/CLI/store builds and had at least two updater incidents (0.1.109 manual reinstall; v0.7.1 published before its manifests).
9. **Tanka / custom channel integration** (`specs/2026-08-tanka-channel.md`) and inbound webhook/spawn contract without a separate multi-tenant Hub service.
10. **Session recoverability / respawn / single-writer lock semantics** as first-class specs; Paseo's docs cover Hub-dispatched idempotent re-create but not user-session recovery guarantees.
11. **Chinese-first UX and design-language contract** (Console/phosphor-teal) — Paseo is English-first with i18n bundles and plugin themes.

## 18. Anti-patterns / cautions observed

- **Plugins are trusted, unsandboxed daemon code** ("Trust every plugin you add" — runs with the daemon user's access); the whole extension story rests on that.
- **Relay was on by default until 0.3.0** and pairing links are password-equivalent; the docs now shout about it — a reminder to keep very-happy's account model rather than QR-pairing.
- **Feature velocity vs stability**: 0.1.108→0.1.109 broke the auto-updater; 0.7.1 shipped before updater manifests; mobile fixes dominate every release; a store review complains about lost session state. Very-happy's verify-queue discipline is a strength here.
- **Presence-window notification suppression** (180 s) silenced permission prompts — a concrete UX bug class to avoid when designing "don't double-notify" logic.
- **Sidebar model churn**: Side panel introduced in 0.5.0 was reverted in 0.6.0 for a fixed Explorer (Files + Changes); a user-directed empty panel tested worse than an opinionated default.

---

## Sources (all read 2026-09-03)

| # | URL | Evidenced |
|---|---|---|
| S1 | https://paseo.sh | Hero mockup (sidebar groups, Pinned, History, Schedules, thread view with tasks/subagents/diff pills, Create a PR, Files/Changes/Commits), FAQ (free, relay, worktrees, voice local-first), Hub/plugins/automation sections, "full feature parity" claim, "Design semantic permission sy…" workspace title |
| S2 | https://paseo.sh/docs | Install paths (desktop bundles daemon; CLI asks to enable relay; Docker), `gh` prerequisite for PR-aware worktrees |
| S3 | Screenshot of https://paseo.sh (first screen, via capture) | Visual confirmation of sidebar/thread/Changes layout and pills |
| S4 | https://paseo.sh/alternatives/happy-coder | Paseo vs Happy Coder comparison table and prose |
| S5 | https://github.com/getpaseo/paseo (README) | Package map (server/app Expo/cli/desktop Electron/relay/website), CLI/SDK/skills examples, paseo-vscode, Apache-2.0 |
| S6 | https://paseo.sh/docs/workspaces | Project→workspace→session model, isolation modes, CLI create |
| S7 | https://paseo.sh/docs/worktrees | Worktree layout, modes, `paseo.json` setup/teardown/scripts/services/ports/proxy/terminals |
| S8 | https://paseo.sh/docs/cli | Full CLI surface incl. permit, agent mode/detach, schedules, hub, `--host` relay/ssh, output-schema |
| S9 | https://paseo.sh/docs/mcp | MCP tool catalog (agents, workspaces, scripts, terminals, schedules/heartbeats, providers, permissions, browser, speak) |
| S10 | https://github.com/getpaseo/paseo/blob/main/CHANGELOG.md (raw) + https://paseo.sh/changelog | Dated feature introductions 0.1.30 → 0.7.2 (status groups #1317, inline diff comments #530, rewind #1154, fork, import, steering, auto review mode, notifications, labels, pinned, History, Commits, file editor, forges, loop removal) |
| S11 | https://github.com/getpaseo/paseo/releases | v0.5.x–v0.7.2 release notes (license change, SSH, plugin timeline, 32k cap, Explorer revert) |
| S12 | https://paseo.sh/docs/connectivity | SSH / relay (opt-in) / Tailscale setup |
| S13 | https://paseo.sh/docs/security | Relay E2E crypto, password auth, DNS-rebinding allowlist, Docker, provider auth untouched, Hub identities |
| S14 | https://paseo.sh/docs/web-ui | Daemon-served web UI, same-origin auto-connect, proxy/tunnel requirements |
| S15 | https://paseo.sh/docs/orchestration + https://paseo.sh/docs/orchestration-workflows | Paseo vs native subagents, Subagents track, heartbeats, detach |
| S16 | https://paseo.sh/docs/plugins + https://paseo.sh/docs/plugins/reference | Contribution types, workspace/agent status enums, attentionReason, attachment sources, themes, trust model |
| S17 | https://paseo.sh/docs/hub + https://paseo.sh/docs/hub/concepts + https://paseo.sh/docs/hub/daemons | Hub model, activation, daemon enrolment, idempotent dispatch, offline = fail |
| S18 | https://paseo.sh/hub + https://paseo.sh/docs/hub/hosted | Hosted €15/seat/month, self-host free, roadmap |
| S19 | https://paseo.sh/docs/hub/triggers + /hub/workflows + /hub/github + /hub/security | Events, mandatory from_users, steps/classifier/allow_outputs, scoped GitHub tokens, provider-native policies |
| S20 | https://paseo.sh/docs/sdk + https://paseo.sh/docs/sdk/workspaces | SDK surface |
| S21 | https://paseo.sh/docs/providers + /supported-providers + /custom-providers | Native vs ACP tiers, catalog, profiles, custom endpoints |
| S22 | https://paseo.sh/docs/metadata-generation | Title/branch/commit/PR generation and fallback chain |
| S23 | https://paseo.sh/docs/skills | Orchestration skills (/paseo, handoff, advisor, committee) |
| S24 | https://paseo.sh/docs/browser + https://paseo.sh/docs/browser-tools | Agent browser automation, desktop-only, a11y-tree snapshots |
| S25 | https://paseo.sh/docs/claude-code | Runs via Agent SDK; plan limits; "claude in the Paseo terminal" |
| S26 | https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924 | Store feature claims (push notifications, voice), 4.9★/75, version cadence, review re: lost session state (Aug 17) and fork-across-harness praise |
| S27 | https://github.com/getpaseo/paseo/issues/1764 | Notification attention policy (appVisible/focusedAgentId/180 s presence window), permission prompts not pushed |
| S28 | https://paseo.sh/blog/i-was-wrong-about-electron | Tauri→Electron rationale (notifications click-through, daemon bundling) |
| S29 | https://vibecodinghub.org/blog/paseo-review | Third-party review at v0.4.0 (AGPL at that time, ~14.1k stars) |
| S30 | https://paseo.sh/docs/updates | Stable/beta channels, 36-hour rollout, store lag |
| S31 | https://paseo.sh/alternatives/claude-desktop, /alternatives/codex-app, /alternatives/superset | Paseo's own comparison framing (panes, GitHub flow, per-worktree URLs, plugins) |
| S32 | https://paseo.sh/docs/voice | Local STT/TTS models, voice-mode architecture |
| S33 | https://paseo.sh/docs/configuration | config precedence, reload vs restart, relay default off, password |
| S34 | https://paseo.sh/docs/schedules + /schedules-chat | Schedules vs heartbeats, creation surfaces |
