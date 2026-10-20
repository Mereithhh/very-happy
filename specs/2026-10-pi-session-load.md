# pi 重启后接回原会话（pi-acp `session/load`）

- 状态：Implemented（PR 待合并）
- 日期：2026-10-21 ｜ 关联 backlog：B-633（B-629 的遗留：`2026-10-acp-wrappers-orca-align.md` §遗留）
- 包：`packages/happy-cli`（AcpBackend / runAcp / piRunnerArgs / daemon resume）、`packages/happy-web-v2`（MetadataSchema、恢复按钮规则）
- 参照：Orca `src/main/pi/rpc-launch.ts`（`--session`）、`src/main/acp/acp-session-reopen-failure.ts`（失败只一行提示）

## 背景

B-629 之后，pi 进程死亡由 wrapper `restartBackend()` 新开 session 并提示「失忆」；wrapper 本身重启（daemon resume / 网页 Restore）则直接以
`unsupported-flavor` 拒绝。pi-acp 0.0.33 在 initialize 里声明 `agentCapabilities.loadSession: true`，`session/load` 按 sessionId
在自己的 map / pi 会话目录里找到 sessionFile，用 `pi --mode rpc --session <file>` 重开，并在应答前把整段历史以
`user_message_chunk` / `agent_message_chunk` / `tool_call` 回放一遍。

## 设计

| 部位 | 改动 |
|---|---|
| `AgentBackend.startSession(prompt?, { loadSessionId })` | 返回 `agentSessionId`；要求 load 时返回 `resumed: 'loaded' \| 'fresh'` 与 `loadFailure` |
| `AcpBackend` | 有 `loadSessionId` 且 agent 声明 `loadSession` → `session/load`（60 s）；期间丢弃对话类更新（历史已在网页 transcript），config/mode/model/commands 仍生效；失败（含 JSON-RPC 错误对象）→ 记原因后 `session/new` |
| `runAcp` | pi 把 `agentSessionId` 写进 metadata `piSessionId`；agent 死亡后的重启先 load；HAPPY_RECONNECT_* 重连同一会话行（照 runCodex：claim 锁 takeover、reactivate、服务端快照定 seq、mergeReconnectMetadata）；重连时沿用已发布的 `permissionMode` |
| 提示（`piRestartNotice`） | 接回：`pi was restarted after its process exited and reopened the earlier conversation.`；接不回：一行说明原因 + 失忆；daemon resume 接回时不提示 |
| `very-happy pi --resume <id>` | `sanitizeAgentSessionId` 限字符集，不会被当成 flag |
| daemon | `resumePrecheck`：`flavor=acp` 且有 `piSessionId` → 只查 cwd；`buildResumeLaunch` → `pi --started-by daemon --resume <id>` |
| Web | `MetadataSchema.piSessionId`（防止网页改名等写 metadata 时剥掉字段，铁律 14）；`restoreEligibility` / `canOfferRestore` 对 acp+piSessionId 放行 |

为什么用 `piSessionId` 而不是通用 `acpSessionId`：`acp` flavor 也用于 `very-happy acp <cmd>` 任意 ACP agent，daemon 无法从 flavor 知道该起哪个 runner；
只有 pi runner 写这个字段，字段本身就是「这是 pi，可以 `pi --resume`」的标记。

## 兼容矩阵与发布顺序

| | 旧 Web | 新 Web |
|---|---|---|
| 旧 CLI（daemon+wrapper） | 不变 | pi 会话无 `piSessionId` → 不显示 Restore（与现状同） |
| 新 CLI | 旧 Web 不认 `piSessionId`：改名等写 metadata 会剥掉它 → 下次 resume 退回 unsupported（不出错）；agent 死亡重启仍走 wrapper 内存里的 id | 完整 |

- 新 Web + 旧 daemon 但新 wrapper：不存在常态组合（wrapper 由同机 daemon 的安装 spawn）；若出现，daemon 回 `unsupported-flavor`，网页按既有映射提示。
- 发布顺序：Web 与 CLI 任意顺序；建议先 Web（保住字段），再 CLI。

## 验收

- [x] `AcpBackend.lifecycle.test.ts`（真子进程 fake agent）：load 已知会话 → `loaded`，回放的对话不外发、commands/models 照发，之后的实时更新照常；未知 id → `fresh` + 原因；不声明 loadSession → `fresh`；普通启动返回 agentSessionId。
- [x] `runAcp.test.ts`：metadata 写 `piSessionId`；agent 死后重启带 `loadSessionId` 并发「reopened」；resume 未接回时一行提示。
- [x] `acpSessionResume.test.ts`、`piRunnerArgs.test.ts`、`resumePrecheck.test.ts`、`handleResumeCommand.test.ts`、web `sessionRestore.test.ts`。
- [x] 隔离 `HAPPY_HOME_DIR` daemon + standalone server + 真 pi 1.1.0 / pi-acp 0.0.33：记暗号 → `kill -9` pi-acp → 下一问答出暗号（main：`UNKNOWN`）；`sessions stop` → `send --resume` → 答出暗号，回合正常结束（main：`resume-precheck:unsupported-flavor`）。

## 留待

- pi 会话文件被删除时 pi-acp 报 `Unknown sessionId`，wrapper 开新会话并提示失忆（已覆盖）；不做跨机器恢复（pi 会话文件在原机器）。
