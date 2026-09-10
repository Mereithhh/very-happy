# Unified coding-agent status

Status: Shipped · B-452 · 2026-09-10

## Baseline before this change
- `Sidebar.tsx` renders separate left raw `thinking`/presence/terminal dots and right board lifecycle/unread indicators.
- `boardItems.ts:classifySession` bypasses `agentLiveness.ts` and heartbeat expiry.
- `webTerminal.ts:classifyPane` considers bare node a Claude idle process and generic y/n prose an input request, before checking identity.
- Claude remote, Codex runCodex and Pi runAcp publish 2s thinking heartbeats. ACP already holds thinking across the whole prompt (B-376); do not regress to text-gap detection. Codex has task_started/task_complete/turn_aborted plus finally cleanup.
- Terminal snapshots currently push only on changes, so snapshot age alone cannot be used as a lease.

## Model
Separate agent identity, connection/observation freshness, execution and unread. Left icon is neutral and describes chat/terminal, using distinct neutral Claude/Codex/Pi terminal symbols and agent names in accessible labels. One right status slot: actionable input > confirmed running > unread > unavailable/unknown > blank idle. Unread remains stored independently and visible even when the machine later disconnects (B-312); its tooltip also includes unknown/offline availability.

UI sessions reuse `isAgentWorkLive` and the existing heartbeat lease; no screen owns another thinking classifier. Board and sidebar use the same result. Permission requests remain higher priority than running only while online/fresh.

Terminal classification is a pure adapter per Claude/Codex/Pi. Foreground identity is required before interpreting each agent's footer/dialog. Generic node, old scrollback, unknown TUI, failed probe must not become Claude/working/input. Pi startup help includes interrupt instructions and cannot count as a running footer. Claude mirror adoption stays behind its separate existing confidence gate; Codex/Pi detection does not create Claude mirrors.

Add optional `agentKind` (string, readers whitelist) and `agentObservedAt` (number) to terminal list items, retain the existing agentState enum (unknown remains absent). Identity also participates in list signature. Successful probes contribute a 10s timestamp bucket, matching the existing 10s tracker: this renews state even without output. Failed probes omit status and timestamp. Web uses receipt-time lease keyed by terminal, renewed only for a new probe timestamp, TTL45s (> tracker10s + handover10s + reconnect/debounce). It reuses existing suspended-clock behavior; no new visibility or reconnect listeners. Old daemons have unknown freshness, never manufacture fresh terminal work from them.

## Compatibility and release
New Web + old CLI: preserves entries, displays unknown observation/identity where absent. Old Web + new CLI: ignores additive fields, reads existing state values. New CLI schema accepts new fields through daemonState. Server stores opaque machine state, no database migration or wire envelope changes. Publish Web/server first, then a new CLI after all gates; existing wrappers retain their loaded code. No production deployment is implied by local implementation/preview.

## Verification
Table-driven six-path lifecycle coverage: start/tool gap/input/end/abort/crash/disconnect/restore, unknown agent, generic node/shell prose, cold snapshot, expired observation, same-status heartbeat, agent swap. Actual installed TUI/source evidence records supported markers; customized or unrecognized interfaces remain unknown. Neutral icons and a single fixed status slot verified in light/dark and coarse 320/390px. Preserve unread independently, tags, shortcuts and existing sidebar operations.

## Local evidence
- Pi 0.84.4 standard editor observed in an isolated `PI_CODING_AGENT_DIR` with `--no-session --no-extensions --no-tools`; no model request sent. Standard spinner and extension selector markers checked against the installed Pi component sources. Custom renderers still degrade to unknown.
- Same-agent continuity also gates daemon webhook transitions; an agent swap or >45s observation gap establishes a new baseline.
- Existing Claude-only terminal scroll control and mirror adoption remain Claude-only even when Pi/Codex become detectable.
- Sidebar harness `/dev/sidebar` uses the actual Sidebar and stores with labeled example data. Terminal push-schema fields are additive. No production state was changed.

## Real runtime verification follow-up
Actual local relay + independent CLI home tests run Claude Code 2.1.267, Codex 0.153.4 (subsequent approval probe 0.154.0), and Pi 0.84.4. Harmless sleep tools exercised UI wrappers and real tmux screens. UI heartbeat running→idle and pending permission/user-question records were observed for all three; these are distinct from fixture coverage.

Runtime findings: tmux reports both Node-launched agents as `node`; Pi's normal footer can use decimal `1.0M`; Codex can hide context percentage; Pi model selection and Claude translated questions differ from generic approval text. The adapters cover these observed forms. A single bounded `ps` snapshot per terminal-list read resolves Node process-tree identity using executable positions only; argv is not persisted or sent to Web. Foreground shell still wins after agent exit.

Codex and ACP wrappers previously exited on SIGTERM without publishing session death. They now route SIGTERM/SIGINT through the same idempotent shutdown as archive/RPC, and remove listeners during normal cleanup. SIGKILL/network loss still rely on the existing lease and are not represented as successful completion.

The real Stop-button RPC probe exposed a Pi/ACP bug: AcpBackend.cancel emitted backend `stopped`, causing runAcp to terminate and an early pending-turn rejection to escape before sendPrompt settled. User cancellation now emits idle (the backend stays alive), the runner ends the turn as cancelled, and pending-turn failures are observed immediately while still awaited for cleanup. Regression coverage requires a second prompt in the same session after cancellation.

### Verified runtime scope
- UI wrappers: all three completed harmless sleep requests and emitted running→idle heartbeats. Codex/Pi tool approval and Claude AskUserQuestion produced pending input records. Stop retained Claude/Codex sessions; after the fix Pi also returned idle and answered `AFTER_CANCEL_OK` in the same session.
- Real private tmux: all three exposed running/idle; Claude translated questions, Codex command approval and Pi model picker exposed needs_input. Cold capture and opened/headless probes agreed on idle/input/identity; Pi returning to a retained shell exposed shell, not the previous agent.
- SIGTERM: new Codex/ACP wrappers emitted inactive within one second, matching the Claude path. SIGKILL, network partition and non-macOS/custom-theme runtimes are not claimed as newly live-tested; their fallback remains lease expiry/unknown.
- Final local checks: CLI 237 files / 2,134 cases; Web 321 files / 2,781 cases; CLI build and Web typecheck passed. All local probe wrappers and private tmux sessions were cleaned up; production was not touched.

## Release evidence
PR #348 merged as `c7db3fc2ff5074df8bd28756bad3f6d9e26c89a4`. Web assets at veryhappy.dev expose the new neutral identity and single-status CSS. CLI `v0.2.134` was published from that commit, all six Linux/macOS/Windows × Node 20/24 smoke jobs passed, and npm latest plus the public recommendation both report 0.2.134. mac-office runs 0.2.134 under launchd; a real central `list-terminals` RPC returned fresh observation timestamps and Claude identity after upgrade (the previous version returned neither). Existing business wrappers were preserved.

The initial production workflow lost its remote process after the public switch: blue served the target and green was drained, but state.env still described green. After confirming no deployment process remained and cancelling the stalled workflow, recovery revalidated blue readiness and public assets, used the existing release functions to stop drained green and atomically commit state, and retained c014708e as rollback. This was a recovered deployment, not a successful initial workflow run.
