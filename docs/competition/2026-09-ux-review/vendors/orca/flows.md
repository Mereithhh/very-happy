# Orca (stablyai/orca, onorca.dev) — UX flows, interaction & visual design

- Competitor: Orca, "the ADE for a fleet of parallel agents" (Stably AI, YC-backed, MIT). Desktop Electron app (macOS/Win/Linux), iOS/Android companion, `orca serve` headless runtime, browser "paired web client".
- Lens: UX flows, interaction and visual design, evaluated first-principles for very-happy.
- Read on: 2026-09-03. Latest release at read time: v1.4.195 (2026-09-02); the project ships a stable build almost daily, so feature lists drift fast. Every claim below is tagged OBSERVED (seen in official docs, changelog, release notes, screenshots, or GitHub issues) or INFERRED (my reasoning).
- Screenshots referenced are saved beside this file in `img/` (docs posters + README feature-wall + a fresh homepage capture).

## 1. Summary

Orca's central object is not the agent and not the conversation — it is the **git worktree**. A worktree owns its branch, its directory, its agent terminals, its editor/browser tabs, its diff, and its linked PR/issue; agents are **opaque PTYs** inside it whose state (working / needs-you / done / failed / idle) is *inferred* from OSC title sequences and Orca-installed hooks. Everything else in the product is an answer to "how do I keep 10–100 of these in my head": shared state glyphs across sidebar/tabs/dashboard/palette/mobile, an agent-finished notification bell with jump-to-pane, a chronological Agents feed for catch-up, an experimental kanban (Needs You / Working / Done / Idle), a Cmd-J jump palette whose empty state is a needs-you-first list of recent sessions, a batched line-comment review loop that returns to the agent, and a read-mostly phone app that mirrors state and lets you send `continue`/`yes`/free text. The visual language is dense, dark-by-default, mono-heavy, with colour reserved for state (amber = needs you, green = done/live, red = failed, gray = idle). The trade Orca makes — yolo permissions by default, terminal as source of truth, Chat UI as an experimental overlay — is exactly the inverse of very-happy's (SDK-structured chat, first-class permission requests, server owns sessions), which is why its attention-management and review surfaces are the most borrowable parts, and its agent model is the least.

## 2. Product model and information architecture (OBSERVED)

**Sidebar (left).** Nav rows `Tasks`, `Automations`, `Orca Mobile`, `Search` (opens the Cmd-J palette), then `Workspaces`/`Projects` with filter/folder/+ icons. Top-level rows are projects (one repo or a grouped folder of repos). Under each, worktree cards grouped `Pinned (3)` / `In progress (17)` (readme-hero.jpg). A card is three lines: state dot + name (+ `primary`/`Folder`/`expired` chips); repo chip + `user/branch` in mono; a third line that is either an agent-icon row or the **last message preview with age** ("continue · Done. PR #5225 is green and me… 4h"). Cards can expand `AGENTS (2)` to show one row per agent with its logo, a state glyph and the last prompt text (agent-statuses.jpg), and nested child worktrees (`2 children → pr-review-3337`). A linked PR renders as a `PR #1547 fix(codex): …` chip; failing GitHub checks as a red chip. Unread worktrees are **bolded, not badged** (docs/model/worktrees). Filter menu: hide sleeping / default-branch / automation-created / CLI-created / other-client / detached-HEAD workspaces; active filter count shows on the control.

**Center.** A tab strip per worktree; any tab type (terminal, editor, diff, browser, PR) splits with any other by dragging a tab to a pane edge; boundaries are saved per worktree and the whole pane tree swaps when you switch worktree. An active-tab colour bar marks the focused pane. Agent tabs show agent identity + live state (working / waiting / completed / completed-but-unread).

**Right.** File explorer, Agent Session History (on-disk transcripts, resumable), Ports (SSH), Checks.

**Status bar.** Per-provider usage segments (`Claude 78% 5h · 94% wk`, `Codex 100% 5h · 80% wk`), memory (`1.2 GB`), counts, `SSH Connected ●`, Caffeinate toggle, skill-update progress. Clicking usage opens a roster popover sorted tightest-limit-first; Claude/Codex rows drill into account switching.

**Global surfaces.** Header bell (unread across worktrees, macOS Dock badge mirror, right-click mark-unread), `Agents` feed (threaded events, running pinned on top, unread badge since last visit), experimental `Agent Dashboard` kanban (in-window or pop-out), floating terminal (`Cmd+Option+A`), Quick Commands (saved shell commands / agent prompts, global or per project, synced to mobile).

**Agent state vocabulary (docs/model/agents-sessions):** Spinner = working; amber `?` = waiting on you (permission / needs input) and the sidebar "Needs You" count; emerald check/dot = done; red dot = blocked/interrupted/failed; gray = idle (~30 min quiet); no indicator = plain shell. The same glyphs are used on tabs, sidebar rows, dashboard cards, palette rows and the phone. Changelog (late Aug 2026) adds a heartbeat glyph for background monitoring tasks and hover tooltips on all nine badges.

## 3. Journeys

### 3.1 First run / onboarding (OBSERVED unless noted)

Install via DMG/Homebrew/AppImage; first launch asks for home-directory access, offers to import `~/.claude`, `~/.codex` and Ghostty terminal settings, and lands on an empty screen with `Add Repo`. The "first 3-agent session" doc promises "empty app → three agents in parallel in under five minutes": Add Repo → `+` next to repo → Create Workspace modal (Repository combobox, optional name — blank names become marine creatures, Agent combobox pre-selected to the default, `Advanced` drawer, `Create Workspace ⌘↩`; global `⌘N`) → creation runs in the background with a progress row in the sidebar and a live setup panel in the tab, cancel/retry inline → a terminal opens with an **agent combobox** → repeat twice, paste the same prompt → drag tabs to split.

Prerequisites the user must already have: the agent CLIs installed and logged in; Orca does not authenticate anything. Every supported CLI is launched with its **permission-bypass flag pre-applied** (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`), on the argument that the worktree is the sandbox; a global Yolo/Manual switch exists in Settings → Agents.

Rating — excellent: the funnel has one concept to learn (worktree) and one modal; auto-naming and background creation remove two classic stalls (naming paralysis, waiting on `git worktree add`). Friction: the mental model tax is real for people not used to worktrees (third-party reviews name this as the recurring complaint); node_modules/.env do not follow into a fresh worktree, so the docs need three mechanisms (Shared Paths, `orca.yaml sharedDirectories`, `.worktreeinclude`) to make the "first agent" actually able to build — a hidden setup step that surfaces as the first failing prompt. Yolo-by-default means the first impression is "agents just go", which is delightful but silently removes the permission journey.

### 3.2 The daily loop (OBSERVED)

Start: session restore rehydrates open worktrees, splits, scrollback and focused tab; a background daemon owns PTYs, so agents kept running across a Cmd-Q, auto-update relaunch or app crash — a host reboot kills agents but the layout and last scrollback still return. Create from a task: the Tasks view shows GitHub Projects/issues/PRs and Linear/Jira in one table (github-linear.jpg: `All / Me / Me Board / Epics / PRs / Issues` tabs; TITLE / TYPE / ASSIGNEES / STATUS columns); "create worktree from card" opens the same composer prefilled and links the issue, and Linear's images ride into the prompt.

Watch N agents: split panes for the ones you care about; the sidebar's state dots for the rest. Get pulled in only when needed: an agent's working→idle transition fires system notification + sound + a chip on the worktree; the bell drains the queue, clicking jumps to worktree *and pane*. `Cmd-J` with an empty query lists up to six recent chats/terminals ranked needs-you → done → idle, omitting the idle tab you are already viewing, with `Cmd-1…6` digits, and the list is frozen while open so rows do not shuffle under the cursor. The Agents feed is the "I was away" surface: one chronological list of completions, blocking questions and new worktrees, each with a short preview of the last agent response, running threads pinned on top. The kanban puts Needs You cards in amber tint and Done cards in green; other states stay neutral so tint means "look here".

Idle hygiene: agent hibernation (experimental) stops done-and-untouched terminals after 30 min unless the worktree is foregrounded, has keystrokes, a mobile session, an unsettled orchestration dispatch, or live subagents; reopening the worktree silently relaunches with `claude --resume <id>`. Delete merged worktrees in one click (branch included), with a "Review N branches" toast if git refuses to drop unmerged ones.

Rating — excellent: the state vocabulary is *shared* across every surface, and the palette's empty state is a triage queue, not a search box; "jump to pane" is the correct atomic action for a notification. Friction (first principles): the same attention information is spread over five surfaces (bell, feed, kanban, sidebar dots, palette) with three of them gated behind Settings → Experimental; the user has to choose their own catch-up surface. State is heuristic: GitHub issue #11644 (open, 2026-07-31) shows the amber "needs you" glyph staying stuck after a permission was approved when hook events arrive out of order, so "jump to the pane to handle the request" lands on nothing to approve — the cost of inferring state from an opaque terminal. No presence-aware suppression is documented (INFERRED absent): a finished agent in the pane you are looking at still rings the bell.

### 3.3 Mobile / away-from-desk (OBSERVED)

Pairing: desktop shows a one-time code from the account/status menu (or `orca serve --mobile-pairing` prints a QR); phone `Pair` → paste/scan; Orca Relay (needs sign-in) or LAN/Tailscale address; the pairing establishes a per-device token; desktop stays source of truth. Closing the desktop app drops LAN sessions; a versioned mobile protocol blocks hosts that are too old and points you to the store.

Home screen (orca-mobile.jpg, mobile-companion-app-showcase.jpg): "Welcome back", three stat tiles (Agents spawned 5,065 · Agent time 26d 10h · PRs created 359), `DESKTOPS` host cards ("Host 1 · ● Connected · 200 worktrees · 47 active", "M1 Mini · home · Disconnected"), a `RESUME` card for the last worktree (`notes-feat · orca · refs/heads/…`), `TASKS` (GitHub · Linear), `ACCOUNT USAGE` rows with 5h and 7d green bars per account, `QUICK ACTIONS` "Pair Desktop" / "New Worktree". Pure black background, near-black cards with 1px borders, white numerals, small-caps gray section labels.

What you can do: see every worktree from every host in one list with working/done/waiting; hydrate scrollback; open a session as raw terminal or **Chat UI** (per-device default asked on first launch, per-tab override via long-press); send a short reply (`continue`, `yes`, free text), attach a photo, dictate; an accessory key row (Tab, Shift+Tab) and a **Live** mode where each keystroke streams to the PTY; Quick Commands; Source Control (stage/unstage/commit, link existing PR); switch the active agent account and spend a Codex "rate-limit reset" credit; create a workspace from GitHub/Linear/GitLab/branch/name (host picker if several desktops); browser pane in Web or Mobile viewport; push notifications on agent-finished mirroring desktop.

Deliberately not on mobile: editing files ("intentionally not a full editor — a remote control"), Design Mode, diff annotation, downloads; it is "read-mostly". Recovery: a stuck spinner is explained as a heartbeat mismatch — "force-refresh the worktree row"; auth-failed banner offers Retry → Re-pair → Remove host.

How you know something needs you: push on finish; the worktree list's waiting state; the AskUserQuestion card in Chat UI with a Submit button (docs say it "should" render, including for remote hosts). For raw-terminal permission prompts the answer is typing `y`/`yes` via quick replies — there is no structured approval object (INFERRED from the docs' wording).

Rating — excellent: the home screen is a genuine "state of my fleet" page (hosts → resume → usage → create), and the reply affordances are tuned for thumbs (canned replies, accessory keys, dictation, Live mode). Friction: pairing is a desktop-hosted flow with three transports and a Relay that users report failing (issues #10425 closed, #16448 open, 2026-08-25); the phone is only as alive as the desktop app; Chat UI is off by default so the first mobile experience is a raw TUI on a phone; approvals are text, not decisions.

### 3.4 The review moment (OBSERVED)

Every worktree has a combined diff against its start-from ref (staged + unstaged + untracked), file tree beside hunks, `j/k` files, `n/p` hunks, `s` stage hunk, `c` comment, image diffs (swipe/onion-skin), HTML "Open preview to the side", three-way merge-conflict UI, word-wrap. **Attribution** marks AI-written lines in the gutter (local only, flips to human on edit, exportable). **Annotate AI Diff** (annotate-ai-diff.jpg: `All Changes` tab, `8 changed files`, per-file `+8 −10`, `18 hidden lines` folds, side-by-side numbers, red/green rows, cursor on the gutter): hover → `+` → markdown comment, `Cmd-Enter` save; comments pin to lines and follow them across edits; **Send to agent** composes one line-anchored prompt for all comments and opens a `Send notes to` menu of the worktree's agents (or a new one). Threads persist after revision for verification; `Resolve` collapses; unresolved comments join the next batch. The doc explains the design: sending one at a time makes the agent swing back and forth; batching gives one round of thinking and a higher hit rate.

Ship: Source Control panel's primary button shifts with state (Stage → Commit → Push/Pull/Sync); `Generate with AI` commit message; `Fix with AI` on a failed pre-commit hook hands hook output + attempted message + staged list to the default agent with a repair-only prompt; `Force push with lease` is a separate labelled action, never a fallback; Create PR composer confirms base/title/body/draft, `Generate PR details with AI`, stacked PRs; PR view inline with checks, review threads, reactions, auto-merge/merge-queue; failing checks = red chip on the worktree and a `Fix broken checks` button that hands failed check names + links to an agent.

Rating — excellent: this is the strongest part of the product. Review is modelled as a *conversation with the diff* that ends in a single batched instruction, the diff keeps the comments as a verification checklist, and every failure (hook, checks, conflicts) has a one-click "hand this to an agent" with a bounded prompt. Friction: line-anchored comments live in Orca only (not in git, not in the PR); the review loop is per worktree, so comparing three racing agents is "open each diff" rather than a side-by-side compare; the winner-picking journey the marketing leads with has no dedicated compare surface (INFERRED from absence in docs).

### 3.5 Recovery (OBSERVED)

- App quit/crash/auto-update: daemon keeps PTYs; warm reattach on launch.
- Host reboot: agents gone, layout + scrollback back; a **Restart** chip appears on every exited agent tab (one click relaunches same agent, same cwd, same account), and the "Jump between 10 worktrees" recipe recommends mass-resuming via Restart after laptop sleep.
- SSH worktrees: status chip green/yellow/red on the card; disconnects do not kill agents; reconnect replays scrolling output and restores full-screen TUI panes from their rendered frame; an inline `Connect` control on the card; remote PTYs are leased by a relay on the host with a 5-minute grace, so closing the laptop app does not kill them.
- Remote Orca Server: server owns everything; reconnecting returns you to the server-owned workspace/tab/pane state without duplicating tabs.
- Hook endpoints are re-sourced from disk on every invocation so long-lived sessions keep reporting after an app restart.
- Hibernated sessions that cannot resume (transcript deleted, session id rotated) fall back to a fresh prompt with the old transcript still in Session History.

Rating — excellent: the docs are honest about what survives what, and the Restart chip makes recovery a per-session, visible, one-click action instead of a global "reconnect". Friction: the daemon dies with the host, so the "always-on" promise requires SSH or a second machine running `orca serve` — which is a separate product surface with its own pairing and Xvfb/systemd setup; the web client of a remote server is barely documented.

### 3.6 Design Mode and the per-worktree browser (OBSERVED)

Every worktree has an embedded Chromium pane (tabs scoped per worktree, cookies importable from Chrome/Edge, viewport emulation, profiles, downloads shelf). Design Mode toggle in the toolbar → hover highlights → click captures outer HTML + neighbourhood, computed CSS, cropped screenshot, and source file/line if a dev source map exists, and ships it into the *active agent terminal* as one attachment; the user then types the change; hot reload; click again to verify. Also scriptable by agents (`orca snapshot/click/fill/screenshot`). Rating: excellent as a loop (pointer replaces description); friction is that it only exists because a Chromium is embedded per worktree — the biggest RAM consumer per the troubleshooting page.

### 3.7 CLI for agents, orchestration, automations (OBSERVED)

`orca` ships with the app and is exposed to agents via installable skills (`orca-cli`, `orchestration`, `computer-use`, `orca-linear`, emulators). Agents can create worktrees, `terminal send --text continue --enter`, `terminal wait --for tui-idle`, open files/diffs, set a worktree comment (`worktree set --comment "reproduced bug"`, shown on the card), drive the browser, run scheduled automations (`--disabled` first, precheck probes, missed-run grace, reuse-session), and share HTML/Markdown artifacts. Orchestration is a Run / Task / Dispatch / Message / Decision-gate model with an inbox (`check --wait --ack`), worker `heartbeat` and `worker_done`, `ask` for blocking questions, and `task_…` ids printed in terminals that are clickable and focus the assigned terminal. Notably Orca has **no meta-assistant chat**: the "dispatcher" is a CLI any agent can use plus the inbox/feed/kanban for the human. Rating: this is the most complete "agents drive the IDE" surface I have seen; friction is that it is text-contract heavy (issues #13696, #11242 show inbox/idle-push edge cases clobbering user input).

### 3.8 Usage, rate limits, accounts (OBSERVED)

Reads local usage state (`~/.claude`, `~/.codex`, Gemini/OpenCode/Kimi/MiniMax) — no API calls, so freshness = the CLI's own bookkeeping. Status-bar segment per provider; popover roster tightest-first with 5h/daily/weekly windows and reset countdowns; warning chip at 80%; `% used` vs `% remaining` preference; multi-account hot-swap by rewriting the credential pointer (new sessions only; Restart chip preserves the account); Codex reset credits spendable from phone with a journal to prevent double-spend; estimated cost in Stats marked "inferred pricing".

### 3.9 Keyboard and palette (OBSERVED)

`Cmd-P` file quick-open (recency + match, gitignored as a second pass); `+` omnibox searches open tabs/files/URLs/agents and falls through to web search (`?` prefix); `Cmd-J` jump palette (worktrees, tabs, PR `#123`/MR `!123`, Recent Chats & Terminals with digit shortcuts, `Tab` for host/project filter chips, `Shift-Enter` opens in a split, "Create worktree" row when nothing matches); `Cmd-,` searchable settings; `Cmd-T` terminal, `Cmd-Alt-T` agent tab, `Cmd-\` / `Cmd-Shift-\` splits; `Cmd-Shift-]/[` tab cycling; `Cmd-Shift-A` add review note; `Cmd-Shift-Backspace` delete hovered workspace; a fully remappable keymap in `~/.orca/keybindings.json`. Diff: `j/k/n/p/s/c`. Deliberately unbound chords (Send Review Notes, Toggle Dashboard, Toggle Sleeping) avoid collisions.

## 4. Visual language and density (OBSERVED from screenshots)

Dark near-black chrome by default (light theme exists — parallel-worktrees.jpg and orca-cli.jpg are light-theme frames), sans UI at ~12–13px, mono for branches, paths, terminals and previews; 1px hairline borders; chips are low-contrast rounded rectangles (`orca`, `primary`, `Folder`, `PR #…`, `expired` in red). Colour carries state only: amber question glyph / amber card tint for needs-you, emerald dot/check/tint for done or connected, red for failed/expired/disconnected, purple only as the Orca brand dot on branch chips, provider logos (Claude sunburst, OpenAI, Grok) as identity marks. Terminal panes are dark in both themes and keep the CLI's own colours. Density is high — a 1280px-wide mock shows sidebar + two terminal panes + file tree + status bar; the sidebar card packs 3 lines plus an expandable agent list. The mobile app is even darker (pure black) with large white numerals and small-caps labels — a "dashboard", not a chat app. Marketing hero copy is "Ship 100x with the agent IDE"; the homepage tab row is telling about the intended IA: `Run a fleet of agents · Automate everything · Review AI output · Git integration · Work on-the-go`.

## 5. What "agents as opaque terminals" means for UX (OBSERVED + INFERRED)

Observed: any CLI works; state comes from OSC titles + hooks; the mobile app "hydrates scrollback"; Chat UI is an experimental decoding layer where "the terminal remains the source of truth" (Claude/Codex/Grok/OMP only; a separate stateful native chat exists only for new local Codex sessions on macOS/Linux); AskUserQuestion cards "should" render; "Copy Context" copies a bounded transcript; "Continue in New Session…" injects a bounded handoff prompt. Inferred consequences: (1) no first-class permission object, so Orca sidesteps it with yolo defaults and a text `yes`; (2) state can be wrong and stay wrong (issue #11644, mobile "stuck spinner"), so the product grows repair affordances (force-refresh, hover tooltips explaining glyphs); (3) previews are the last prompt/response text scraped from the pane, not tool-level structure; (4) sub-agents are shown as child rows that focus the *parent* terminal because they have no pane of their own; (5) transcript search/resume rides on the CLIs' own on-disk stores. The upside is breadth (35+ agents) and zero protocol work per agent; the downside is that every "understanding" feature is best-effort.

## 6. Journey scorecard

| Journey | Excellent | Friction | Why (first principles) |
|---|---|---|---|
| Onboarding | One concept, one modal, background create, auto-names | Worktree tax; gitignored deps missing; yolo hidden | Reduces decisions before first result; but moves cost to "why did my first build fail" |
| Daily loop | Shared state glyphs; palette = triage queue; jump-to-pane | 5 overlapping attention surfaces, 3 experimental; heuristic state | Consistency of vocabulary beats number of features; inference without ground truth erodes trust |
| Mobile | Fleet home screen; thumb-tuned replies; per-tab chat/terminal | Desktop-hosted pairing/Relay flakiness; TUI-by-default; approvals as text | A phone needs decisions and status, not a shell |
| Review | Batched comment loop; comments as verification list; one-click failure handoffs | Comments not portable to PR; no compare-N surface | Review as dialogue with the diff is the right abstraction |
| Recovery | Honest survival matrix; Restart chip; SSH lease | Daemon dies with host; remote server is a second product | Per-session visible recovery beats global reconnect |

## 7. Borrowable for very-happy (ranked by UX impact)

1. **One state vocabulary everywhere + a needs-you-first empty-state palette.** very-happy already has ground-truth state from the SDK; render it with one glyph set on session rows, tab title, PWA badge, machine page, and a `Cmd-J`-style palette whose empty query is "needs you → done → idle" with digit shortcuts and a frozen list. Evidence: docs/model/agents-sessions, docs/model/quick-open.
2. **An Inbox/feed as the catch-up surface, replacing the weak "assistant" screen.** Orca's answer to "dispatcher" is not a chat: a chronological feed of finished turns / blocking questions with a last-response preview, running sessions pinned, unread since last visit, click = jump to session *and* the exact request. Evidence: docs/activity, docs/notifications.
3. **Batched line-annotated review that returns to the agent as one prompt, with comments surviving revisions.** very-happy renders tool edits structurally; add a cumulative diff per session/branch with `c`-to-comment, "Send to agent", resolve, and unresolved-carry-forward. Evidence: docs/review/annotate-ai-diff, recipes/review-ai-diff.
4. **Mobile home = fleet state page.** Hosts with counts (connected / N sessions / N active), a Resume card, needs-you first, usage bars, two quick actions. very-happy's PWA can do this natively without pairing pain. Evidence: docs/mobile + orca-mobile.jpg.
5. **One-click failure handoffs with bounded prompts**: "Fix with AI" (hook failure), "Fix broken checks" (CI), "Resolve with AI" (conflicts), each shipping exactly the failure context and *not* asking the agent to bypass/commit/push. Evidence: docs/review/commit-push, docs/review/github.
6. **Per-session Restart/Resume chip + an honest survival matrix.** Show on the dead session exactly what survived (transcript yes / process no) and one action to relaunch with the same cwd/account. Evidence: docs/model/session-restore, docs/model/agents-sessions.
7. **Usage roster in the status bar** (B-211): compact segment per provider, popover tightest-first, 5h/weekly windows, 80% chip, %used/%remaining preference; mark inferred cost as inferred. Evidence: docs/agents/usage-tracking.
8. **Thumb-tuned reply affordances**: canned `continue`/`yes`, accessory key row, dictation, per-tab chat-vs-terminal override, image attachments as removable thumbnails. Evidence: docs/mobile.
9. **Task object = branch + session(s) + linked issue/PR, created from an issue with images in the prompt, background creation with progress row, one-click delete of losers.** For very-happy's task board: bind board cards to a session + branch + PR chip and show CI state as a red chip on the card. Evidence: docs/model/worktrees, docs/review/linear, readme-hero.jpg.
10. **Agents report into the UI via CLI**: `worktree set --comment`, clickable `task_…` handles that focus the owning terminal, `terminal wait --for tui-idle`. very-happy's channels/MCP could expose "set session note / status" and render it on the card. Evidence: docs/cli/overview, docs/cli/orchestration.
11. **Quick Commands** (saved shell commands and agent prompts, global/project scope, same list on phone). Evidence: docs/terminal, docs/mobile.
12. **Design Mode-style pointer capture** for the project's dev server (HTML + computed CSS + crop + source map line into the prompt). Web-only very-happy could do this in an iframe/bookmarklet against the dev server. Evidence: docs/browser/design-mode.
13. **Terminal link action popover** (open in app / system / copy resolved OSC-8 URL; already-open tab is activated instead of duplicated). Evidence: docs/terminal.
14. **Attribution gutter** (AI vs human lines) as a review prioritiser — very-happy has the ground truth from tool calls. Evidence: docs/review/attribution.

## 8. Anti-patterns (do not copy)

1. **Yolo permissions by default** (`--dangerously-skip-permissions` pre-applied). It designs away the approval journey instead of designing it; for a remote web client on a shared owner machine, the worktree is not a sandbox. Evidence: docs/agents/supported, docs/model/agents-sessions.
2. **Inferring agent state from the terminal** (OSC titles + hooks) and then adding repair UI (force-refresh, hover tooltips, sticky amber). very-happy's SDK state is a moat; never regress to heuristics for Codex/ACP either. Evidence: issue #11644, docs/mobile troubleshooting.
3. **Attention fragmented across many surfaces**, several gated as Experimental (Chat UI, Dashboard, hibernation, Activity page). Pick one triage surface and make the rest views of it. Evidence: docs/settings Experimental, docs/activity vs docs/notifications vs dashboard.
4. **Chat as an overlay on a PTY** ("terminal remains the source of truth", "should render the question card"). Lossy decoding produces "should" semantics. Evidence: docs/agents/native-chat.
5. **Desktop-hosted mobile pairing** where the phone dies with the desktop app and protocol mismatches block hosts. very-happy's server-owned session model is the right call; keep it. Evidence: docs/mobile pairing/troubleshooting, issues #10425/#16448.
6. **Settings sprawl from daily shipping** (the settings reference alone lists ~15 panes with modifier-click update channels). Rough edges are acknowledged by third-party reviewers. Evidence: docs/settings, agmazon review.

## 9. Open questions

- Does Chat UI decode from the PTY byte stream or from the CLI's on-disk JSONL? Docs say "structured transcript + composer for the same PTY" but Session History reads on-disk stores; fidelity of tool-call rendering is unknown.
- Is there any presence-aware suppression (no bell when the finished pane is focused/visible)? Not documented; only the palette omits the currently viewed idle tab.
- What does the "paired web client" of a Remote Orca Server look like and how much parity does it have (docs mention it only for missing Download)? A `webClientUrl` is emitted by `orca serve --json`.
- How do raw-terminal permission prompts (Manual mode) surface on mobile — only as scrollback + text reply?
- Is there a compare-N-diffs view for the "race three agents" journey, or is it always sequential per-worktree review?
- How reliable is Design Mode's source-map → file/line mapping outside Next/Vite dev builds?

## Sources (all read 2026-09-03)

- https://github.com/stablyai/orca — README: feature wall (mobile companion, parallel worktrees, terminal splits, design mode, GitHub & Linear, SSH, annotate diffs, drag files, CLI, quick open, account switcher, computer use, notifications/unread), 35+ agent list, install; hero + feature-wall images (readme-hero.jpg, mobile-companion-app-showcase.jpg, github-linear.jpg, parallel-worktrees.jpg, orca-cli.jpg).
- https://onorca.dev/ — homepage copy and app mock (homepage-screenshot.jpg): sidebar/worktree card anatomy, agent rows, status-bar usage segments, "Run a fleet / Automate / Review / Git / On-the-go" tabs.
- https://onorca.dev/docs — what Orca is/is not (not a model, not a hosted VPS, for people who read diffs).
- https://onorca.dev/docs/install — first-launch behaviour, update channels via modifier clicks.
- https://onorca.dev/docs/first-session — onboarding funnel, Create Workspace modal (default-agent-opening.jpg), split-pane hero (orca-split-screen.jpg).
- https://onorca.dev/docs/model/worktrees — worktree lifecycle, background creation, sidebar grouping/filters, bold-not-badge unread, shared paths, multi-select, preserved branches.
- https://onorca.dev/docs/model/tabs-panes-splits — tab/pane model, per-worktree layouts, tab chords.
- https://onorca.dev/docs/model/agents-sessions — state glyph vocabulary, Agent Dashboard kanban, yolo launch defaults, Restart chip, lifecycle (agent-statuses.jpg).
- https://onorca.dev/docs/model/session-restore — what survives quit/crash/update vs host reboot; daemon-owned PTYs.
- https://onorca.dev/docs/model/quick-open — Cmd-P, + omnibox, Cmd-J recents ranked needs-you first, digit shortcuts, frozen membership, host/project chips.
- https://onorca.dev/docs/notifications — agent-finished pings, bell, Dock badge, mark-unread, per-category tuning, custom sounds.
- https://onorca.dev/docs/activity — Agents feed contents, unread badge, jump-to-pane, running pinned on top.
- https://onorca.dev/docs/mobile — everything the phone can do, pairing, Chat UI on mobile, quick commands, account switcher, troubleshooting (orca-mobile.jpg).
- https://onorca.dev/docs/agents/native-chat — Chat UI is experimental, terminal is source of truth, composer pills, AskUserQuestion cards.
- https://onorca.dev/docs/agents/session-history — on-disk transcript scanning and resume commands.
- https://onorca.dev/docs/agents/hibernation — hibernation conditions and silent resume.
- https://onorca.dev/docs/agents/usage-tracking — usage roster, windows, 80% chip, inferred pricing.
- https://onorca.dev/docs/agents/codex-hot-swap and https://onorca.dev/docs/agents/codex and https://onorca.dev/docs/agents/claude-code — account hot-swap mechanics, Continue in New Session, nested subagents.
- https://onorca.dev/docs/agents/supported — permission-bypass defaults per agent, Yolo/Manual switch, agent table.
- https://onorca.dev/docs/agents/hooks-memory — status hooks, endpoint re-sourcing across restarts.
- https://onorca.dev/docs/review/diff-viewer — diff features and j/k/n/p/s/c keys.
- https://onorca.dev/docs/review/annotate-ai-diff — comment loop, batching rationale, Send notes to menu (annotate-ai-diff.jpg).
- https://onorca.dev/docs/review/attribution — AI/human line provenance.
- https://onorca.dev/docs/review/commit-push — state-shifting primary button, Fix with AI, force-with-lease, PR composer, action recipes.
- https://onorca.dev/docs/review/github — PR/checks/issues/Projects in-app, Fix broken checks, auto-merge, stacked PRs, red chip on failing checks.
- https://onorca.dev/docs/review/linear — Linear drawer, images into prompt, branch naming.
- https://onorca.dev/docs/browser/overview and https://onorca.dev/docs/browser/design-mode and https://onorca.dev/docs/recipes/design-mode-fix — embedded Chromium, Design Mode capture payload and loop (orca-design-mode.jpg).
- https://onorca.dev/docs/terminal — agent tab states, link action popover, floating terminal, Quick Commands, kitty protocol.
- https://onorca.dev/docs/editing/file-explorer — drag files onto agent terminal (SSH upload first).
- https://onorca.dev/docs/cli/overview, https://onorca.dev/docs/cli/orchestration, https://onorca.dev/docs/cli/automations, https://onorca.dev/docs/cli/computer-use, https://onorca.dev/docs/cli/skills — agent-driving CLI, Run/Task/Dispatch model, clickable task ids, automations, skills stubs.
- https://onorca.dev/docs/ways-to-run, https://onorca.dev/docs/remote-servers, https://onorca.dev/docs/ssh, https://onorca.dev/docs/recipes/remote-worktrees — local/SSH/server/VM modes, pairing links, SSH status chip and reconnect, PTY leases.
- https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md — `orca serve` on a VPS (Xvfb, systemd, ready JSON with pairing URL).
- https://onorca.dev/docs/recipes/parallel-agents, https://onorca.dev/docs/recipes/review-ai-diff, https://onorca.dev/docs/recipes/jump-worktrees — the canonical daily-loop recipes.
- https://onorca.dev/docs/settings — full settings map incl. Experimental (Activity page, Dashboard, Chat UI, hibernation), Notifications, Shortcuts.
- https://onorca.dev/docs/troubleshooting — performance guidance (close worktrees/browsers), restart chip as fix.
- https://onorca.dev/changelog — recent shipped features (heartbeat glyph + badge tooltips, draft review actions, Cmd+J recency, Agent Dashboard, Chat UI, artifacts).
- https://github.com/stablyai/orca/releases — v1.4.191–v1.4.195 (2026-08-28 → 2026-09-02) release notes via API: daily cadence, perf work on worktree create/diffs, native chat reliability.
- https://github.com/stablyai/orca/issues/11644 — sticky "needs you" after approval (state-inference failure); https://github.com/stablyai/orca/issues/979 — original request for distinct attention states; https://github.com/stablyai/orca/issues/3099 — request for chat-based UI; https://github.com/stablyai/orca/issues/10425 and https://github.com/stablyai/orca/issues/16448 — mobile relay/pairing failures.
- https://blog.margrop.net/en/post/orca-parallel-ai-agent-ide-review (2026-08-20) — hands-on: resource table (~2 GB per agent), worktree learning curve.
- https://agmazon.com/blog/articles/technology/202607/orca-ade-guide-en.html (2026-07) — community sentiment: worktree concept as recurring friction, yolo default risk, Electron weight, daily-ship rough edges.
