# Unified coding-agent status

Status: Final · B-452 · 2026-09-10

## Confirmed current behavior
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
