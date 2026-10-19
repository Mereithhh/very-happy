# Orca Sources

- repo: `https://github.com/stablyai/orca`（MIT）
- checkouts（repo 外，本机 skills repo 的 `tmp/`；按 `AGENTS.md` 不进本仓库）：
  - `~/code/github/skills/tmp/rea-orca/src/orca` @ `57a7c22d034ed5144a5eba1b509f3efaf68c02da`（2026-10-11；产品 / UX 三批 B-547～B-588 的参照）
  - `~/code/github/skills/tmp/vh-codex-thinking/orca-src/orca` @ `3501ea935dd3021d8aedd6c6c48fb221eafbb5bd`（2026-10-18，package.json 1.4.214；wrapper 对照 B-625 / B-628 / B-629 / B-630 / B-631）
- 产品层证据（onorca.dev 文档、GitHub releases v1.4.194/195）：[`../2026-09-ux-review/vendors/orca/`](../2026-09-ux-review/vendors/orca/)（2026-09-03）

## Files inspected（wrapper 对照，均为 `src/main/` 下相对路径）

- Codex（B-625）：`codex/codex-structured-journal-translation-turn-boundaries.ts`、`codex/codex-structured-turn-end-settlement.ts`、
  `codex/codex-structured-turn-open-wait.ts`、`codex/codex-background-task-frames.ts`、`codex/codex-app-server-connection.ts`
- Codex（B-628）：`codex/codex-structured-turn-start.ts`（steer）、`codex/codex-structured-turn-open-wait.ts`（等轮打开 5 s）、
  `codex/codex-subagent-activity.ts`、`codex/codex-collab-agent-tool-call.ts`、`codex/codex-subagent-linkage.ts`（子 thread 归属与命名）、
  `codex/codex-app-server-process-tree-kill.ts`
- ACP / pi / Gemini（B-629、B-630）：`acp/acp-agent-connection.ts`、`acp/acp-json-rpc-peer.ts`、`acp/acp-structured-turns.ts`、
  `acp/acp-turn-failures.ts`、`acp/acp-structured-session-adapter.ts`、`acp/acp-oversized-lines.ts`、`acp/acp-peer-limits.ts`、
  `acp/acp-structured-stop.ts`；`pi/rpc-turns.ts`、`pi/rpc-retry-activity.ts`
- Claude Code（B-631）：`claude/claude-session-state-turn-over.ts`、`claude/claude-structured-journal-translation.ts`、`claude/claude-open-turn.ts`、
  `claude/claude-stream-json-connection.ts`、`claude/claude-api-retry-row.ts`、`claude/claude-informational-row.ts`、
  `claude/claude-agent-sdk-control-requests.ts`、`claude/claude-structured-control-actions.ts`、`claude/claude-command-lifecycle.ts`、
  `claude/claude-structured-launch-resolution.ts`

## 留后续时要看的文件

- B-632（pi steer / 对话框 / 子代理）：`pi/rpc-turns.ts` 的 streamingBehavior、`pi/rpc-extension-dialogs.ts`、`acp/acp-subagents.ts`
- B-633（pi 恢复）：`pi/rpc-launch.ts`（`--session` / `--fork`）、`acp/acp-session-reopen-failure.ts`
- B-634（Claude 进程树 / 投递确认 / 下线模型）：`claude/claude-agent-sdk-exit-proof.ts`、`claude/claude-agent-sdk-user-message-queue.ts`、
  `claude/claude-structured-retired-model.ts`

## 未对照的 agent 目录

`amp`、`antigravity`、`codebuddy`、`copilot`、`cursor`、`droid`、`gemini`（我方 Gemini 走 ACP 层对照，没看它的专用目录）、`kimi`、`kiro`、`opencode`。

## Notes

- 我方对 SDK 行为的结论都另做了探针（Claude Code 2.1.296 / Agent SDK 0.3.296、pi-acp 0.0.33、Gemini CLI 0.17.1），记在各 spec「现状事实」；
  Orca 的做法只决定「该不该有这个机制」，不替代探针。
