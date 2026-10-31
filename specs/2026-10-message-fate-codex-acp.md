# 用户消息只有三种结局：Codex / ACP 的取出后丢失窗口（B-854）

状态：Final（随 PR 实现）· 关联：B-854，承接 B-853（#815）、B-332、B-505

## 目标

任何 agent 上，用户发出的消息只有三种结局：**执行了**、**仍在排队**、**`queue-cancel` tombstone（「未执行 · 原因」+「放回输入框」）**。不允许第四种：消息被 runner 从队列取出后，既不在队列、也没到 agent，随报错或进程一起消失。

## 现状事实（修前，代码已确认）

| 窗口 | 位置 | 现象 |
|---|---|---|
| Codex D1 | `runCodex.ts` 主循环 catch | effort 不受支持（`unsupportedEffortReason` 抛错）、`ensureConnected`、`startThread`、`turn/start` 被拒：只发 `Codex error:` 事件，消息无 tombstone，Web 仍按「已发送」显示 |
| Codex D2 | `handleKillSession` | 预检中 kill/SIGTERM：`process.exit`，持有的批次与 `messageQueue` 剩余项都不报 |
| ACP A1 | `runAcp.ts` 主循环 catch | `restartBackend`、mode/model/effort 切换、prompt 构建失败：只报 turn 失败 |
| ACP A2 | kill handler / `stopRunnerFromBackendStatus` / finally | 只 `messageQueue.close()`，剩余项不报；ACP 从未 `setOnDiscard`；finally 无条件 `lifecycleState: 'archived'`（违反 AGENTS 7：SIGTERM 也归档） |
| Web | `reducer.ts reconcileQueuedInput` | 发给空闲 agent 的消息没有 `queuedAt`，历史页先到 tombstone 时不会被标 canceled |
| Web | `undeliveredPromptId` | 被 tombstone 的离线消息仍显示「已保存 · 会话恢复后送达」 |

## 设计

- **`HeldInput`**（`utils/heldInput.ts`）：从 `hold(batch.sourceIds)`（出队）到 `delivered()`（Codex `turn/start` 被接受 = 新 `sendTurnAndWait({ onTurnStarted })`；ACP 发出 `session/prompt` 前；Codex `/clear` 本地处理、`/compact` 连上 app-server 后）之间持有 key；`drop(reason)` 幂等发 tombstone。turn 自己的 catch 与退出路径谁先到谁报。
- **`MessageQueue2.discardAll(reason)`**：退出时把剩余项按原因报出并清空。
- **原因**：新增 `failed`（取出后没能交给 agent）；kill/归档 → `aborted`；SIGTERM/SIGINT → `restarted`；ACP backend 首次启动前停止 → `failed`；runner 意外结束 → ACP `failed`、Codex 退出循环 `aborted`。
- **Codex kill 顺序**：tombstone 在 `handleAbort` **之前**发（daemon stop 在 SIGTERM 后 2 s SIGKILL，abort 宽限 3 s），并置 `terminating`，预检结束后不再启动这一轮。
- **ACP 退出意图**（`acpExit.ts`）：只有用户 kill/归档才打 archived；信号、backend 起不来、意外结束都只 `sendSessionDeath` + `POST /deactivate`（与 Codex/Claude 的 B-505 一致）。backend 起不来时额外发一条原因事件。
- **附件准备失败**（两 runner 的 `.catch`）：同样补 `failed` tombstone。
- **`ApiSessionClient.close()` 后不再重连**：socket 自己的 `io client disconnect` 曾触发 `startSmartReconnect`，ACP runner 结束后（不调 `process.exit`）被重新连上的 socket 吊住，成为对 daemon/Web 仍 `active` 的僵尸 wrapper（实测 A2 SIGTERM 时发现；Codex/Claude 被 `process.exit` 掩盖）。
- **Web**：`discardedReasonKey` 认 `failed`（文案「未执行 · 没能交给 agent（原因见报错）」）；reducer 对无 `queuedAt` 的输入也应用带 reason 的 CLI tombstone；被 tombstone 的消息不再显示「恢复后送达」。

## 兼容矩阵与发布顺序

`reason` 在 wire 上是普通字符串（铁律 14）：

| | 旧 Web | 新 Web |
|---|---|---|
| 旧 CLI | 不变 | 不变 |
| 新 CLI | `failed` 显示通用「未执行 · 被 agent 从队列里丢弃」，仍可放回（#815 起） | 专用文案 |

无 schema 变更，顺序任意；Web 需含 #815 的「放回输入框」。

## 未覆盖 / 风险

- **SIGKILL / 崩溃**：进程来不及发 tombstone。会话被续上时由下一个 wrapper 的 `cancelUndeliveredQueuedInputs`（B-332 ③）补 `restarted`；被归档且没有下一个 wrapper 时仍无 tombstone（需 server/daemon 侧兜底，记 backlog）。
- `turn/start` 已写出但响应前 app-server 崩溃：按「未执行」报，实际可能已部分执行（罕见，宁可让用户可重发）。
- SIGTERM 时排队消息现在是 tombstone `restarted`，没有在下一个 wrapper 里自动重放（可借 B-679 exitCursor 做，另立条目）。

## 不修：CLI spawn 首条 prompt 不带 appendSystemPrompt → Web 首条必 relaunch

`very-happy spawn --prompt`（以及 team/automation）的首条消息没有 Web 的 `appendSystemPrompt`，Query 以「无 append」启动；Web 发的第一条带 append → `claudeModeHash` 变 → park + relaunch 一次冷启动。两个可行方案都不安全：

1. CLI 首条也填 Web 的 append（prewarm 缓存里有）：Web 的 prompt 要求模型在回答末尾输出 `<options>` XML 和 ```draft 块；automation/team 的调用方按纯文本读答案（Tanka 代答、`sessions read --answer`），会被污染。
2. append 改为首次出现时注入用户消息、不进 hash：改动 B-853 刚修过的 park/hash 路径，且 system prompt 变成 user 内容，语义不同。

代价只是 Web 首次接手 CLI 会话时多一次冷启动（续接同一 transcript，不丢上下文）。建议另立条目按方案 2 出 spec。

## 验收

- 单测：`heldInput.test.ts`、`MessageQueue2.test.ts`（discardAll）、`acpExit.test.ts`、`codexAppServerClient.test.ts`（onTurnStarted）、接线断言 `codexHeldInputWiring.test.ts` / `acpHeldInputWiring.test.ts`（mutation-check）、Web `reducer.spec.ts`、`discardedInput.test.ts`、`sendStatus.test.tsx`。
- 隔离实测（独立 server/web/daemon + codex/pi-acp 故障注入 shim）：D1 effort、D1 app-server 起不来、D2 归档、D2 SIGTERM、A1 backend 重启失败、A2 归档、A2 SIGTERM、A2 backend 首启失败——每种 Web 都显示「未执行 · 原因」，「放回输入框」回填原文；SIGTERM / backend 失败的会话 `archived=false`。
