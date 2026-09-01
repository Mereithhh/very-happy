# 权限模式 CLI 侧真相与陈旧快照防护（B-262 第二批）

> 状态：Final
> 日期：2026-09-01 ｜ 关联 backlog：B-262 ｜ 前身：`specs/2026-08-permission-mode-source-of-truth.md`（B-258）及其「Web 代批与执法边界」一节（B-262 第一批）

## 背景

第一批（Web 单包）解决了「选了 yolo 仍弹审批」对任何 CLI 版本的可见性与兜底。本批修 CLI 侧四个在四轮对抗 review 里核实、但只有新 CLI 才能修的缺口：

1. CLI 上报的 `metadata.permissionMode` 是**意图**，不是 Claude Code 实际生效的模式；`~/.claude/settings.json` 的 `permissions.deny/ask/defaultMode/disableBypassPermissionsMode` 可让 SDK 无视我们请求的 bypass，而 Web 显示 yolo（`claudeRemote.ts` 不读 `system/init.permissionMode`）。
2. 普通工具 approve 带 `mode` 时，`handlePermissionResponse` 在 canUseTool 回调内 `await setPermissionModeCallback()`——嵌套 SDK control request 排在本回调响应之后，失败即把用户已批准的工具 **deny**（铁律 8 缺口，自 v0.2.79 起）。
3. 队列消息在入队时快照 `mode.permissionMode`；空闲 RPC 切到 yolo 后，下一条排队消息把 handler 拉回 plan（`claudeRemoteLauncher.ts` 的 `nextMessage` 用消息快照 `handleModeChange`）。同样，消息 meta 若早于最近一次显式切换也会回退。
4. reconnect（`HAPPY_RECONNECT_SESSION_ID`）路径只写 lifecycle，不重发本进程的模式。

## 目标

- `metadata.permissionMode` = Claude Code 生效模式（SDK `system/init` 为准）；意图与生效不一致时日志告警，Web 显示 conflict 态。
- approve-with-mode 立即放行工具、本地切模式、SDK control request 延后到回调结束后发出。
- 显式切换（RPC / plan 批准 / approve-with-mode）之后，已排队消息与更早的 meta 不得把模式拉回。
- reconnect 进程重新发布自己的模式。
- 零 wire 改动；旧 Web 无感知。

## 非目标

- 不加新 metadata 字段（`permissionModeReason` 需 Web schema 先登记，另议）；不做 `dontAsk/auto` 支持（B-263）；不改 RPC 通道的降级保护（Web 侧已保证 A6 只升不降，用户显式选 default 必须生效）；不改 `resume` 路径（daemon 已透传 `--permission-mode`，Web 无调用者）。

## 现状事实（代码已确认，基线 `main@78c37a84`）

| 事实 | 位置 |
|---|---|
| `SDKSystemMessage(system/init).permissionMode: PermissionMode` 必填；`result.permission_denials` 是自动拒绝的权威记录 | sdk.d.ts 0.3.232 `:4707`、`:4549` |
| `claudeRemote.ts` 的 init 处理只取 tools/slash/mcp/skills/model | `claudeRemote.ts:222-241` |
| `publishPermissionMode` 用进程内 `publishedPermissionMode` 去重 | `runClaude.ts:545-553` |
| 普通工具 approve 带 mode 在回调内 await SDK，失败 deny | `permissionHandler.ts:270-282` |
| 队列项 `mode/modeHash` 入队快照；`commitPermissionMode` 只改当前 `mode/modeHash` | `MessageQueue2.ts:52`、`claudeRemoteLauncher.ts:372-382`、`:404/:419` |
| reconnect 只写 lifecycleState/archivedBy/queueCancellation | `runClaude.ts:303-308` |
| `Metadata.permissionMode` 是 `string` | `api/types.ts:442` |

## 设计

- **B2 真相**：`ClaudeSdkMetadata.permissionMode` 透传 `system/init.permissionMode`；launcher 新回调 `onEffectivePermissionMode`（经 `loop.ts` 透传）；runClaude 用纯函数 `reconcilePublishedPermissionMode({intent, published, effective})` 决定是否发布：effective ≠ published 时发布 effective；effective ≠ intent 时 `logger.warn` 指向 settings。本地 enforcer 保持 intent（后续显式切换照常重发）。`result.permission_denials` 非空时 warn。
- **B3 铁律 8**：普通工具 approve 带 mode → 本地 `permissionMode = mode`、`deferredPermissionMode = mode`、`onModeChanged`，立即 resolve allow；SDK control request由既有 `scheduleDeferredPermissionModeUpdate`（`permission` RPC handler 末尾已调用）在回调结束后发出；SDK 失败只记日志，不影响已批准工具。
- **B4 陈旧快照**：`commitPermissionMode` 用纯函数 `rewriteQueuedPermissionMode(queue.queue, hasher, nextMode)` 重写所有已排队项与 `pending` 的 `permissionMode`/hash；runClaude 记录 `lastExplicitModeSwitchAt`（onPermissionModeChange），消息 `createdAt` 早于它的 `meta.permissionMode` 忽略（日志）。
- **B5 reconnect**：重连 updateMetadata 追加 `permissionMode: mapToClaudeMode(initial)`。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI + 新 Web | conflict 态可见（`· CLI: default`）；approve-with-mode 不再 deny；队列不回退 |
| 新 CLI + 旧 Web | `permissionMode` 是既有字段，值可能出现 `dontAsk/auto`（SDK 词汇）——旧 Web 只显示，不影响发送 |
| 旧 CLI + 新 Web | 第一批兜底不变 |
无新 wire 字段；发布顺序 Web 已先行，本批随 CLI tag。CLI 变更影响 daemon 行为（handover 后新会话生效；存量 wrapper 不热替换，铁律 7）。

## 风险

1. settings 禁用 bypass 的机器，Web 会显示 `CLI: default` 且第一批的执法仍会代批（用户意图 yolo）——可接受：Happy 卡本就只在 handler 非 bypass 时产生。
2. `system/init` 只在 query 创建时发；`setPermissionMode` 后不重发 → 中途切换后的 effective 未知，仍以意图发布（已有行为）。
3. 队列重写改变了「不同模式不混批」的 hash 语义：显式切换后所有排队项统一为新模式，符合用户意图。

## 验收标准

- [ ] `reconcilePublishedPermissionMode` 三例；`rewriteQueuedPermissionMode` 两例；permissionHandler approve-with-mode 两例（立即放行、SDK 延后、失败不 deny）。
- [ ] CLI 门禁：build + unit + `--version` 冒烟。
- [ ] 发布 CLI 后用**新开**会话验证：`~/.claude/settings.json` 临时加 `permissions.disableBypassPermissionsMode: "disable"` → Web 显示 `· CLI: default` 并 warn；去掉后恢复 confirmed。

## 留真机验证项

- 新会话 approve-with-mode 路径：在 default 模式下弹 Bash 卡 → Web 以 `approved_for_session`（或带 mode 的批准）批准 → 工具执行且后续不再问；SDK 失败注入（断网）时工具仍执行。
