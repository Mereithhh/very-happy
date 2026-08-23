# Happy Docs

This folder documents how Happy works internally, with a focus on protocol, backend architecture, deployment, and the CLI tool. Start here.

## 项目管理（本 fork，中文）

以文档为载体的项目管理体系，入口是仓库根 `CLAUDE.md`（agent 工作指南：门禁/铁律/热区）：

- `PROCESS.md`：迭代流程——批次制 / 质量门禁 / 发布 / 验收 / 沉淀。
- `backlog.md`：需求层，一切输入一项一行（主 agent 单写者；不用 GitHub Issues，理由见其头注）。
- `../specs/`：设计层，大改动前置 spec（模板与 draft→final→shipped 生命周期见 `specs/README.md`）。
- `verify-queue.md`：验收层，留真机验证项登记与清账。
- `channels.md`：对外集成契约（webhook 出站 + spawn/send/MCP 入站）。
- `development.md`：生产 Web V2 + standalone server + CLI 的本地开发路径。
- `operations.md`：Owner 运营的 hw-sg/mac-office 生产拓扑、发布与恢复 runbook（不含密钥值）。

`plans/` 是上游（slopus/happy）遗留的 plan 档案，只读；新设计一律进 `../specs/`。

## Index
- protocol.md: Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- realtime-sync-and-rpc.md: High-level overview of realtime socket management and RPC control flow.
- api.md: HTTP endpoints and authentication flows.
- encryption.md: Encryption boundaries and on-wire encoding.
- backend-architecture.md: Internal backend structure, data flow, and key subsystems.
- deployment.md: How to deploy the backend and required infrastructure.
- development.md: Canonical local loop for Web V2, standalone server, and CLI.
- operations.md: Maintainer production topology, deploy semantics, daemon startup, diagnosis, and rollback.
- cli-architecture.md: CLI and daemon architecture and how they interact with the server.
- multi-process.md: Deeper multi-replica Socket.IO + Redis streams behavior, failure modes, and integration-test history.
- dev-environments.md: Local `environments/data/` workflow, lab-rat project provisioning, `env:cli` passthrough behavior, and daemon usage.
- session-protocol.md: Unified encrypted chat event protocol.
- session-protocol-claude.md: Claude-specific session-protocol flow (local vs remote launchers, dedupe/restarts).
- plans/provider-envelope-redesign.md: Proposed replacement for the current provider/session envelope design.
- permission-resolution.md: State-based permission mode resolution across app and CLI (including sandbox behavior).
- happy-wire.md: Shared wire schemas/types package and migration notes.
- voice-architecture.md: ElevenLabs voice assistant integration, session routing, context batching, and VAD detection.
- research/: general research notes and exploratory writeups.
- competition/: competitor research, protocol analysis, and comparison notes.
- competition/AGENTS.md: structure and rules for storing competitor research results without committing raw checkouts.

## Conventions
- Paths and field names reflect the current implementation in `packages/happy-server`.
- Examples are illustrative; the canonical source is the code.
