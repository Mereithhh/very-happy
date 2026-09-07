# OpenAI Codex (ChatGPT desktop app / Codex Remote / Codex cloud) — UX flows, interaction and visual design

Research date: 2026-09-03. Lens: user journeys, attention management, IA, interaction and visual language. Written for very-happy (self-hosted web client + relay for Claude Code). Every claim is tagged **[OBS]** (seen in official docs, changelog, screenshots or a dated first-hand account) or **[INF]** (my inference). Docs now live at learn.chatgpt.com; developers.openai.com/codex mirrors them.

## 0. Status check: what "the Codex app" is today

- **Feb 2 2026** Codex app for macOS launched as a "command center for agents" (threads organized by projects, worktrees, skills, Automations). Windows followed Mar 4. [OBS: openai.com/index/introducing-the-codex-app]
- **May 14 2026** Codex arrives inside the ChatGPT mobile app (preview, all plans incl. Free); mobile pairs to a Mac host over a "secure relay"; Remote SSH GA. [OBS: work-with-codex-from-anywhere]
- **May 29** Windows hosts can be remote-controlled (26.527). **Jun 25** Codex Remote GA with one-to-one authenticated QR pairing + DigitalOcean Droplet plugin. [OBS: changelog]
- **Jul 9 2026** The Codex app *became* the new ChatGPT desktop app (26.707): one shell, top-left switcher **ChatGPT ↔ Codex**, and inside ChatGPT a **Chat / Work** toggle. Codex keeps its own history and workflows; users can make Codex the default view and keep the Codex icon. Old ChatGPT app renamed "ChatGPT Classic". Also: edit code/markdown inline in diffs, PR Chat (review GitHub PRs in a side panel), multi-repo projects. [OBS: chatgpt-for-your-most-ambitious-work; help.openai.com/20001276; changelog 2026-07-09; @ajambrosino Jul 9]
- **Jul 30** Activity view (bell in sidebar, ⌘⌥U). **Aug 11** Linux preview + import from Claude Code/Cowork/Cursor. **Aug 20** read-only shared thread snapshots, pinned chats synced desktop↔iOS. **Aug 28** custom sidebar sections ("ask Codex to organize the sidebar"). **Sep 1** iOS 1.2026.237 adds a **Priority view** (running, unread, awaiting-response tasks pinned to top). [OBS: changelog; whats-new; @ajambrosino Aug 28]
- Terminology drift: docs now say **chat** for what was "thread"/"task"; glossary keeps *Task* = a defined outcome, *Thread* = app-server technical object, *Chat* = the saved space with context, results and actions. [OBS: glossary]

Verdict on the merge: real, dated Jul 9 2026, and it produced measurable confusion (community threads about missing projects, "can't find my codex threads", people uninstalling the old app before checking). [OBS: community.openai.com/t/1386177; LinkedIn snippet]

## 1. Unit of work and information architecture

**Unit of work = a chat (thread) that owns a run location.** When you start a Codex chat you choose where it runs — **Local** (your checkout), **Worktree** (Codex-managed git worktree, detached HEAD, from a chosen branch incl. uncommitted changes), **Cloud** (OpenAI container), or a saved **SSH host** project. [OBS: environments/modes; worktrees; remote-connections] The location is *mutable*: **Handoff** (chat header / footer run-location control) moves the chat **and its git state** Local↔Worktree and between hosts; Codex creates/reuses the worktree on the destination and interrupts a running response before transferring. Each chat remembers "its" worktree and goes back to it. [OBS: worktrees; remote-connections]

Layers above and below the chat:
- **Project** = one or more local folders (primary folder drives new chats, git ops and AGENTS.md/skills/config discovery; secondary folders are searchable/editable) or a ChatGPT project. Pin, rename, archive, search; **Quick chat** opens a plain ChatGPT chat that does *not* appear in the Codex sidebar. [OBS: projects]
- **Goal** (`/goal`) turns a chat into a persistent objective; a **progress row above the composer** offers pause / resume / edit / clear; "pause before you expect to lose connectivity". [OBS: long-running-work; slash-commands]
- **Side chat** (`/side`, ⌘⌥S) asks a question without interrupting the main run; on iOS side-chat messages now survive even after the chat can no longer reconnect. [OBS: slash-commands; changelog iOS 2026-09-01]
- **Fork** (`/fork`) copies a chat into a new local chat or worktree; forked conversations link back to the original. [OBS: slash-commands; iOS 1.2026.167]
- **Scheduled tasks** (ex-Automations): *standalone* (new chat per run; findings land in the **Scheduled** view which "acts as your inbox" with an unread indicator) or *in-chat* ("heartbeat" that returns to the same chat on a cadence, minute-based allowed). Runs go to a background worktree or the local project; run unattended with `approval_policy="never"` when policy allows. [OBS: automations]
- **Subagents** appear as a side panel ("3 working") with per-agent pills you can open to read reasoning; background subagents get stable identicons. [OBS: buildtolaunch Jul 22 screenshot description; changelog 26.527]

**Sidebar** (Codex view): product switcher top-left; Projects (pinnable, three-dot menu for permanent worktree / edit folders / archive chats); Chats with a filter icon (by project state vs Chronological); Pinned; Scheduled; Activity bell; Sites; Plugins; Skills; Profile/pet at the bottom; custom sections since Aug 28. Unread indicators per chat; ⇧Esc clears all unread; ⌘⇧U marks a chat unread. [OBS: troubleshooting; commands; changelog]

## 2. Journey: first run / onboarding

What stands between install and the first useful result (desktop, local):
1. Download, sign in with ChatGPT (API key also works with fewer features). [OBS: quickstart]
2. Pick **Codex** in the switcher, open a folder (⌘O) → local project. On launch Codex detects version control and recommends *Auto* for git folders and *read-only* for others; it "may start in read-only until you explicitly trust the working directory". [OBS: agent-approvals-security]
3. Type a prompt; choose Local/Worktree/Cloud below the composer. **Only "Ask for approval" is available by default** — "Approve for me" and "Full access" must be enabled in Settings › General › Permissions before they appear in the composer menu. [OBS: permission-modes; screenshot of the selector demo]
4. Optional: onboarding role picker tailors first-run suggestions (26.602); **Import from Claude Code / Cowork / Cursor** (instructions→AGENTS.md, settings.json→config.toml, skills, MCP, hooks, subagents, last-30-days chats, project folders) with a lower-left status card for items needing finish-setup. [OBS: import; changelog 26.608]
5. The app "picks up your session history and configuration from the Codex CLI and IDE extension". [OBS: introducing-the-codex-app]

Remote adds a second ritual: Settings › Connections › **Control this Mac or PC** › Set up → QR → phone confirms same account + workspace + MFA/SSO/passkey → host appears in the phone's **Remote** tab; then toggle "keep awake", Computer Use, Chrome extension. Every phone × host pair must be paired. [OBS: remote; remote-connections]

Cloud is the heaviest: connect GitHub/GitLab → create an **environment** (deps, setup script, env vars, secrets, internet allowlist) → first task. [OBS: cloud]

**Rating.** Excellent: the safe default is *productive* (workspace-write + on-request), so the first prompt already edits files without a permission storm; import-by-reuse and CLI history pickup mean day-one isn't empty. Friction: three separate onboarding rituals (local, remote, cloud); the "enable modes first" two-step is a discoverability tax justified by safety; the merge created a fourth ritual (find Codex behind the switcher, understand two histories, ChatGPT Classic). **Why:** onboarding cost scales with the number of *execution substrates* a product exposes; Codex exposes four and pays for each. [INF]

## 3. Journey: the daily loop (start, watch N agents, get pulled in, review, ship)

**Start.** ⌘N new chat in the current project; pick run location and branch; model + reasoning are one chip ("5.6 Sol Medium" in the composer demo); `/plan` then `/goal` for long work; Fast mode toggle; environment **Actions** (dev server, tests) are top-bar buttons that run in the integrated terminal (⌘⇧D runs action 1). [OBS: permission-modes screenshot; local-environment; commands]

**Watch N agents — one state model, many projections.** The states are **Running / Needs input / Ready (completed with unread) / Blocked (error)**. They are rendered identically by: sidebar unread dots; **Activity view** (bell, ⌘⌥U: chats that are unread, running or waiting; filters Work/Chat/Pinned/Scheduled; Mark all as read); the floating **pet** overlay across other apps, whose activity tray prioritizes *needs input → blocked → ready → running*; the **Codex Micro** keyboard's six Agent Keys (white idle, blue thinking, green complete+unread, amber requires input, red error; "Priority chats" mode puts waiting/unread/active first); and mobile's **Priority view**. Keyboard: ⌘⌥A "next chat needing attention", ⌘⌥1–6 recent chats, ⌘1–9 go to chat. [OBS: notifications; pets; codex-micro; commands; changelog iOS 2026-09-01]

**Get pulled in only when needed.** Notification policy is presence-aware: turn-completion alerts *never / only while the app is in the background / always*, with separate toggles for **permission** and **question** notifications. Unread noise is suppressed while a goal keeps running (26.608). Approvals: Enter approves, Esc declines, ⌘Enter submits custom approval feedback. "Follow-up behavior" setting decides whether a message sent mid-run **steers** the current run or **queues** for the next; iOS exposes the same Queue/Steer default. [OBS: notifications; settings; commands; changelog 26.616, iOS 1.2026.146]

Auto-review (**"Approve for me"**) swaps the human for a reviewer agent at the sandbox boundary; each request shows as an item with status *Reviewing / Approved / Denied / Aborted / Timed out* plus a risk level and user-authorization assessment; three consecutive denials abort the turn; `/approve` lets you override one denial for one retry. [OBS: auto-review; agent-approvals-security]

**Review** (see §5) and **ship**: commit, push, create PR from the review pane; PR Chat shows reviewer comments alongside the diff; cloud tasks end with "open a pull request". [OBS: local-environment; code-review; cloud]

**Rating.** Excellent: the attention model is *one* vocabulary projected into five surfaces, including two ambient ones (pet, hardware keys) that let you leave the app without losing the queue; "next needs-attention" as a keystroke is the single highest-leverage affordance for N-agent work. Friction: the vocabulary itself is only exposed as filters/colors — there is no documented "kanban by state" list (third-party control planes like Moshi/Pounce/Superset do show *Needs you / Working / Done* columns, which suggests users want it) [OBS: getmoshi; search snippets]; worktree-per-chat costs disk and setup (`.worktreeinclude`, setup scripts, a 15-worktree cap with snapshot-and-restore). **Why:** a supervisor's loop is bounded by how fast they can find the *next* thing that needs them; anything that adds a click between "notification" and "the approval button" is lost throughput. [INF]

## 4. Journey: mobile / away from desk (Codex Remote)

Model: **the phone is the control surface, the host is the computer.** The mobile app "loads the live state from that environment": all threads, approvals, plugins, project context; screenshots, terminal output, diffs, test results stream back. Files, credentials and permissions never leave the host; the relay keeps the host off the public internet (no inbound ports). [OBS: work-with-codex-from-anywhere; remote-connections; techtimes Jun 27]

What the docs' interactive phone mock shows (screenshot, developers.openai.com/codex/remote): a **Remote** screen with a row of **host chips** ("All", "MacBook", "Studio", …) each with a green online dot; sections **Pinned** and **Today**; task rows carrying small glyphs — a pin, a git-branch icon (the chat is on a branch/worktree), a spinner (running) and a blue dot (unread) — e.g. "Review the navigation update ● ", "Investigate reconnect behavior ◌". [OBS]

What you can do: start chats in host projects (choose branch, create a worktree, run the env setup script), continue/steer/queue, answer questions, approve or decline, review changed files with staged/unstaged/branch/last-turn filters and **inline review comments**, switch model/reasoning (a "compact composer gauge"), `/goal`, `/side`, fork, search tasks across titles *and content*, full-screen editor for long prompts, attach recent photos/videos, Face ID lock, per-host personality, Home-Screen shortcuts to Codex Remote, copy thread ID. Queued prompts sync to the host, stay editable, and send even if the app is backgrounded; long tasks show live working time. [OBS: changelog iOS 1.2026.146 → 1.2026.237]

How you know something needs you: push notifications when Codex completes a task or needs input; the Priority view; the unread dot. [OBS: remote-connections; techtimes]

What is deliberately **not** on mobile: Codex is "not selectable on web or mobile" as a standalone — only desktop Codex chats via Remote; worktrees don't run on the phone; no offline mode (host asleep = last known state); Computer Use on Windows needs an unlocked foreground session; a laptop with the lid closed drops remote unless an external display is attached. [OBS: help.openai 20001276; worktrees; remote-connections; ofox May 28]

**Rating.** Excellent: "same account + QR" pairing with no separate credential; approvals as first-class push actions; queue-vs-steer made explicit on the phone; Priority view; content search. Friction: the whole thing dies with the host ("keep it awake" is the user's job — a Mac mini or a Droplet is the recommended fix); third-party testers report diff reading beyond ~80 lines is painful and typing more than a paragraph is not viable; an approval card on a phone while distracted invites rubber-stamping (Axios/Kingy). **Why:** the phone is good at *decisions with small inputs* (approve, pick A/B, add a sentence) and bad at *comprehension of large outputs*; a mobile surface should therefore compress outputs (summaries, risk labels, "what changed" in one line) rather than shrink the desktop. [INF]

## 5. Journey: the review moment (diff, comments, CI, PR)

- **Review pane reflects git, not the agent**: it shows unstaged, staged, commit, **branch** (vs base) and **Last turn** (only the latest assistant turn) scopes; a repository selector for multi-folder projects ("All repos" for Last turn). [OBS: code-review]
- **Inline comments**: hover a line → "+" → write feedback → then send a message ("Address the inline comments and keep the scope minimal"); comments are treated as review guidance, line-specific. Collapsible inline review comments; **inline or detached** review mode. [OBS: code-review; changelog 26.406]
- **Git actions in the pane**: stage/unstage/revert at *entire-diff / file / hunk* granularity; commit; push (push modal offers choices); create PR. File name click opens your editor; ⌘-click a line opens it at that line. [OBS: code-review; changelog 26.409]
- **Turn summary card**: "Edited 13 files, +107 −416" with per-file diffs and **Undo** and **Review** buttons; files that were only *read* are also listed. [OBS: buildtolaunch Jul 22, screenshot description]
- **Edit in place**: since Jul 9 you can edit code/markdown directly in the diff and annotate a selection; the composer shows a "2 annotations" chip. [OBS: changelog 26.707; buildtolaunch]
- **PR Chat**: sidebar shows PR context and reviewer feedback (needs `gh auth login`); review pane shows comments alongside the diff; "fix the specific comments", inspect, stage, commit, push. PR page commenting and an activity timeline exist since 26.409. [OBS: code-review; changelog]
- **`/review`** runs a dedicated reviewer (against base branch or uncommitted) that reports prioritized findings *without touching the tree*; findings appear as inline comments. [OBS: code-review]
- **GitHub side**: `@codex review` posts a standard review flagging only P0/P1; automatic reviews per repo; `@codex fix the P1 issue` starts a cloud chat that can push to the branch; review rules live in `AGENTS.md` "## Code Review Rules". [OBS: third-party/github]
- CI status is not a documented pane; PR status shows in the sidebar (bug-fix notes mention "sidebar pull request status updates"). [OBS: changelog 26.616] [INF: CI is surfaced through PR status rather than a first-class CI view.]

**Rating.** Excellent: treating the pane as *git truth with a "Last turn" lens* resolves the classic "files I didn't ask for" confusion (it is literally a troubleshooting FAQ); hunk-level staging + inline comments make the review the *next prompt*. Friction: the review pane requires a git repo; inline comments still need an explicit follow-up message to take effect (two-step); PR features silently vanish if `gh` isn't authenticated. **Why:** review is where trust is built; the best affordance is one that converts a reading act (a line I dislike) into a writing act (a scoped instruction) without leaving the diff. [INF]

## 6. Journey: recovery (network drop, machine sleep, agent crashed)

- **Host sleep / app closed** → remote access stops immediately; docs push "Prevent sleep while running", lid-open-plus-power, external display, or an always-on machine. Signing out disables Remote Control but keeps pairings; "reconnects are more reliable, resolving stuck Send states, missing approvals, and stale task updates" (iOS Sep 1); "Improved recovery by preserving thread state across reconnects and host pairings across sign-out" (iOS Jul 6). [OBS: remote-connections; settings; changelog]
- **Stuck chat** checklist: (1) is it waiting for an approval? (2) open the terminal, run `git status`; (3) start a new, smaller chat. Terminal stuck: close, reopen with Ctrl+`, run `pwd`. [OBS: troubleshooting]
- **Lost prompt** (wrong target, cancelled worktree creation): ↑ in the empty composer restores the previous prompt. [OBS: troubleshooting; commands]
- **Deleted worktree**: Codex snapshots before auto-deleting and offers **Restore** when you reopen the chat. [OBS: worktrees]
- **Goal + connectivity**: pause before you lose connectivity; goals can resume blocked or usage-limited runs. [OBS: long-running-work; iOS 1.2026.195]
- **Auto-review runaway**: circuit breaker aborts the turn after repeated denials, with a warning. [OBS: auto-review]
- Feedback: `/feedback` attaches the session and returns a session ID; logs and transcripts are documented paths. [OBS: troubleshooting]

**Rating.** Excellent: the recovery affordances are *cheap and specific* (↑ restores prompt, snapshot restore, a three-step checklist). Friction: host durability is the user's problem — there is no daemon that survives the desktop app, and the CLI cannot be a Remote host; there is no documented "chat is Blocked because…" explanation surface beyond the state color. **Why:** durability that depends on a GUI process being open is a structural weakness for an "away from desk" story; very-happy's daemon+tmux model is the opposite trade. [INF]

## 7. Permission and approval UX (profile, sandbox, auto-review)

Two independent controls, shown that way: **sandbox** (read-only / workspace-write / danger-full-access; network off by default; protected `.git`, `.agents`, `.codex`) and **approval policy** (untrusted / on-request / never / granular). The composer control beneath the prompt lists **Ask for approval**, **Approve for me**, **Full access**, and **Custom (config.toml)**; the docs demo shows a mode card with three labeled cells `SANDBOX workspace-write · APPROVALS POLICY on-request · REVIEWER user`. Full access gets a model-specific warning and a dialog when combined with Ultra; Daybreak (security) models auto-switch to Approve-for-me. Rules allow/prompt/forbid command prefixes; MCP tools with destructive annotations always prompt; Computer Use website access has its own approvals that auto-review does not replace. [OBS: permission-modes screenshot; sandboxing; agent-approvals-security; auto-review; changelog 26.707]

**Why this is good UX:** it separates *what can physically happen* from *who decides*, so changing the reviewer never widens the blast radius — the docs say it explicitly ("a reviewer swap, not a permission grant"). The cost is vocabulary: users must learn sandbox mode, approval policy, reviewer, profile, rules. [INF]

## 8. Keyboard, command palette, terminal

⌘K / ⌘⇧P command menu; ⌘P file search; ⌘⇧E file tree; ⌃⇧G review tab; ⌘⌥B review panel; ⌘J bottom panel; Ctrl+` terminal (per-chat, scoped to project/worktree; tabs per thread; bottom or right panel; Codex can read its output); ⌘T browser tab; ⌘. browser browse/comment mode; ⌘⌘ Appshot; ⌃1/2/3 switch Chat/Work/Codex; ⌘⌥L copy chat deep link; `codex://threads/<id>`, `codex://new?prompt=&path=` deep links; shortcuts are searchable by name *or by pressing the keys*; **Search chats has no default shortcut**. [OBS: commands; integrated-terminal; settings]

## 9. Density and visual language

Directly observed is limited to docs demos and the docs' phone mock: neutral off-white surfaces, black pill buttons, small gray glyphs for state, a blue dot for unread, green dots for online hosts, mono only for the config-cell values. [OBS: screenshots] The app itself: Appearance settings let you choose a base theme, adjust **accent, background and foreground colors**, set separate **UI font and code font** (one code font shared by review pane, terminal and code blocks), and share a theme; a pop-out chat window with "Always on top"; inline visualizations and Mermaid; subagent identicons; a pixel-sprite pet; a "Thinking…" reduction ("more visibility into what the model is doing"). Third-party framing: "Codex is built to show you code, diffs, and PRs, while Work keeps those details abstracted away". [OBS: settings; troubleshooting; @ajambrosino Jul 9; buildtolaunch] I could not observe typography, dark/light defaults or density of the real app — see open questions.

## 10. Cloud + triggers (Slack / Linear / GitHub)

Slack: `@Codex` in a channel/thread → 👀 reaction → link to the cloud chat → result (and optionally an answer) posted back; environment chosen by best match, falling back to most recent. Linear: assign the issue to Codex or `@Codex` a comment; triage rules can auto-delegate; progress lands in the issue's Activity. GitHub: `@codex review`, `@codex fix…`, automatic reviews. Web/mobile scheduled tasks can trigger on Gmail/Slack/GitHub PR events (Aug 25). [OBS: third-party/slack; linear; github; changelog 2026-08-25] The UX pattern: **the issue tracker is the inbox and the cloud chat is the receipt** — you never leave the tool you were in. [INF]

## 11. What very-happy should take (summary; ranked detail in the structured output)

1. One attention vocabulary (Running / Needs input / Ready / Blocked + unread) as the sort key everywhere, plus a "next needs-attention" keystroke.
2. An Activity/Priority inbox that unifies sessions, terminals, permission requests and scheduled runs, with "mark all read".
3. Presence-aware notification policy with separate permission/question/completion toggles.
4. Review as git truth with a "Last turn" lens, hunk-level stage/revert, inline comments that become the next prompt, and an "Edited N files" card with Undo.
5. Run location as a mutable chat property (Local/Worktree/host) with Handoff and worktree snapshot/restore.
6. Explicit Steer vs Queue with queued prompts editable from the phone.
7. Mobile as a decision surface: host chips with online dots, Pinned/Today, glyph-level state, full-screen prompt editor, content search.

Anti-patterns to avoid: burying the coding workspace behind a general-purpose product switcher with split histories; making host durability the user's chore; building mascots before the state model; a two-step "enable in settings before it appears" for modes.

## Open questions

- Real desktop visual language (type scale, default theme, density, terminal styling) — unobserved; only theming capabilities and third-party descriptions.
- Is Activity view GA? Docs hedge "when Activity is available". Is Priority view desktop too or iOS-only?
- What exactly an approval card shows on the phone (raw command, diff, risk level?) — no first-party screenshot found.
- Android parity (pinned sync excludes Android as of Aug 20).
- Whether queued mobile prompts survive a host restart, and how the relay reports host-side failure vs network loss.

## Sources (all read 2026-09-03)

- https://developers.openai.com/codex/app — desktop app overview; get-started steps; Chat/Work/Codex; Quick chat.
- https://developers.openai.com/codex/remote (+ screenshot of the interactive phone mock) — Remote value props, setup steps, host chips / Pinned / Today / row glyphs.
- https://developers.openai.com/codex/cloud — cloud setup (GitHub/GitLab, environments), review summary+diff, open PR.
- https://developers.openai.com/codex/changelog — Sep 1 iOS 1.2026.237 (Priority view, queued prompt sync, working time), CLI 0.150–0.152, Aug 26 iOS 1.2026.230 (task search, effort gauge, full-screen editor).
- https://learn.chatgpt.com/docs/changelog — 2026-07-09 26.707 merge notes (PR Chat, inline annotations, Full-access warnings), 07-30 26.727 Activity view + multi-repo review, 07-23 26.715 Voice + multi-folder, iOS 07-06/07-13/07-20/07-27, 06-25 Remote GA + QR pairing, 06-18 26.616, 06-09 26.608 import, 06-01 terminal placement, 05-29 26.527 Windows remote, 05-21 26.519 goal mode/appshots, 04-09/04-10 review + PR board.
- https://developers.openai.com/codex/llms.txt — doc index (pages under Features/Workflows/Environments/etc.).
- https://developers.openai.com/codex/app/worktrees — Local/Worktree/Handoff, managed vs permanent, `.worktreeinclude`, 15-worktree cap, snapshot restore.
- https://developers.openai.com/codex/app/automations — standalone vs in-chat scheduled tasks, Scheduled inbox with unread, worktree vs local, `approval_policy="never"`.
- https://openai.com/index/introducing-the-codex-app (Feb 2 2026) — threads per project, worktrees, Automations review queue, skills, personality, sandbox defaults.
- https://openai.com/index/codex-for-almost-everything (Apr 16 2026) — computer use, in-app browser, PR comments, terminal tabs, SSH alpha, summary pane, memory, proactive suggestions.
- https://openai.com/index/work-with-codex-from-anywhere (May 14 2026) — mobile model, relay, what streams to the phone, Remote SSH GA.
- https://openai.com/index/chatgpt-for-your-most-ambitious-work (Jul 9 2026) — merge announcement, ChatGPT Classic, new Codex capabilities, Auto-review.
- https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app (updated ~Sep 1 2026) — migration paths, Codex not selectable on web/mobile, Remote tab.
- https://help.openai.com/en/articles/6825453-chatgpt-release-notes — Jul 9/Jul 16 desktop layout notes, Aug 20 Codex/ChatGPT updates.
- https://learn.chatgpt.com/docs/notifications.md — presence-aware alerts, permission/question toggles, Activity view, pet.
- https://learn.chatgpt.com/docs/long-running-work.md — `/goal`, progress row, side chat, pause before losing connectivity, Prevent sleep.
- https://learn.chatgpt.com/docs/projects.md — projects, primary/secondary folders, pin/rename/archive/search, Quick chat.
- https://learn.chatgpt.com/docs/integrated-terminal.md — per-chat terminal, Ctrl+`, actions, Codex reads output.
- https://learn.chatgpt.com/docs/code-review.md — review scopes, inline comments, PR reviews, staging/reverting, detached mode.
- https://learn.chatgpt.com/docs/permission-modes.md (+ screenshot of the selector demo) — modes, enable-first, sandbox vs approvals.
- https://learn.chatgpt.com/docs/features/codex-micro.md — Agent Key status colors, Approve/Decline keys, Priority chats mode.
- https://learn.chatgpt.com/docs/pets.md — Running/Needs input/Ready/Blocked, tray prioritization, reduced motion.
- https://learn.chatgpt.com/docs/environments/modes.md — Local/Worktree/Cloud selector.
- https://learn.chatgpt.com/docs/remote-connections.md — pairing, host requirements, what comes from the host, cross-host handoff, SSH, troubleshooting.
- https://learn.chatgpt.com/docs/sandboxing/auto-review.md — reviewer agent, triggers, denials, circuit breaker, `/approve`.
- https://learn.chatgpt.com/docs/reference/commands.md — full shortcut tables, deep links.
- https://learn.chatgpt.com/docs/third-party/slack.md, /linear.md, /github.md — trigger flows, P0/P1 reviews, triage rules.
- https://learn.chatgpt.com/docs/environments/local-environment.md — setup scripts, actions, built-in git tools.
- https://learn.chatgpt.com/docs/sandboxing.md and /docs/agent-approvals-security.md — sandbox modes, approval policies, reviewer, defaults, auto-review item statuses.
- https://learn.chatgpt.com/docs/quickstart.md — desktop/web setup steps.
- https://learn.chatgpt.com/docs/whats-new.md — weekly digest Jul 20–Aug 28 (Activity view, multi-repo review, import, snapshots, event triggers).
- https://learn.chatgpt.com/docs/use-chatgpt.md — Work vs Codex comparison table, shared snapshots.
- https://learn.chatgpt.com/docs/features.md — feature map.
- https://learn.chatgpt.com/docs/reference/settings.md — Prevent sleep, follow-up steer/queue, Appearance (colors, fonts), pop-out always-on-top.
- https://learn.chatgpt.com/docs/glossary.md — Chat/Task/Thread/Handoff/Heartbeat definitions.
- https://learn.chatgpt.com/docs/import.md — import from Claude Code/Cowork/Cursor, status card.
- https://learn.chatgpt.com/docs/reference/troubleshooting.md — stuck-state checklist, prompt recovery, sidebar filter, logs.
- https://learn.chatgpt.com/docs/reference/slash-commands.md — `/goal /side /fork /review /approve /worktree /cloud`.
- https://x.com/ajambrosino/status/2075274362501074944 (Jul 9 2026) — design intent of the merged app; https://x.com/ajambrosino/status/2093424927210893620 (Aug 28) — custom sidebar sections.
- https://buildtolaunch.substack.com/p/chatgpt-codex-guide-4-use-cases (Jul 22 2026) — first-hand descriptions of subagent panel, pet, "Add to chat", annotations chip, "Edited 13 files" card, archived-task restore.
- https://www.developersdigest.tech/blog/chatgpt-work-codex-desktop-app (Jul 9/15 2026) — mode table, merge framing.
- https://www.techtimes.com/articles/319201/20260627/... (Jun 27 2026) — Remote GA, relay/no inbound ports, host constraints, push notifications, steer.
- https://getmoshi.app/guides/codex (Jun 2026) — third-party phone control plane showing Needs you/Working/Done kanban and lock-screen approvals (used as evidence of user demand, not of Codex UI).
- https://ofox.ai/blog/codex-mobile-app-iphone-android-2026 (May 28 2026) and https://kingy.ai/news/codex-just-landed-in-the-chatgpt-mobile-app-... (May 14 2026) — hands-on limits of mobile review, rubber-stamping risk.
- https://community.openai.com/t/where-did-my-chatgpt-projects-go/1386177 (Jul 9–10 2026) — post-merge project/history confusion.
- https://latent.space/p/ainews-openai-codex-app-death-of (Feb 2 2026) — launch reception, worktree-as-parallelism primitive, "looking at code is optional".
- https://chatgpt.com/remote — Remote landing copy (progress, input, context, Work+Codex).
