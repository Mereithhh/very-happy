# 子代理生命周期（B-260-P2）：task_* 事实源、状态跨 turn、结果上 wire

> 状态：Final
> 日期：2026-09-01 ｜ 关联 backlog：B-260 ｜ 前身：B-260 第一批（Web 指针行，`main@83b344b0`）；三轮对抗 review 记录见会话临时目录 `subagent-ux/`（不进 repo）

## 背景

第一批只做了诚实的指针行：不声称状态/耗时/结果，因为 CLI 把 SDK 的 `system/task_started|task_progress|task_notification` 全部丢弃（`sessionProtocolMapper.ts` 对 `system` 直接 return），Web 只能看到后台子代理的存根 `tool_result`（「Async agent launched…」）。本批把子代理的真实生命周期接上。

## 目标

- 卡片状态真实：启动 → 运行（工具数 / 最近工具 / tokens / 时长）→ 完成 | 失败 | 停止，**跨 turn 更新**，续接后可回到运行。
- 结果可见：后台完成 → 通知消息 `<result>` 块（≤16KB，`truncated` 标记）；前台完成 → `tool_use_result`（`AgentOutput`）。
- 老 Web / 老 CLI 互不破坏；不做 Subagents track（B-250）。

## 非目标

- `forwardSubagentText`（子代理文本/thinking 上 Web）默认关，作为独立开关另议；`agentProgressSummaries` 同。
- 不改 Codex mapper；不做 detach/编排；不改 B-211 用量分账。

## 现状事实（代码已确认，基线 `main@78c37a84`）

| 事实 | 位置 |
|---|---|
| mapper 丢弃所有 `system` 消息 | `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts:511-516` |
| Agent tool_use → `tool-call-start`（args 含 `sessionSubagent`）；tool_result（存根）→ `stop` + `tool-call-end` | `:552-580`、`:637-655` |
| `closeTurn → clearSubagentTracking()`；孤儿子消息进 `bufferSubagentMessages` 永不释放 | `:441`、`:496-502` |
| `SDKTaskStartedMessage { task_id, tool_use_id?, description, subagent_type?, task_type?, skip_transcript?, prompt? }`；`SDKTaskProgressMessage { task_id, tool_use_id?, description, subagent_type?, usage{total_tokens,tool_uses,duration_ms}, last_tool_name?, summary? }`；`SDKTaskNotificationMessage { task_id, tool_use_id?, status: completed|failed|stopped, output_file, summary, usage?, skip_transcript? }`；`SDKTaskUpdatedMessage.patch.status/is_backgrounded` | sdk.d.ts 0.3.232 `:4740-4830` |
| `SDKUserMessage.tool_use_result`（Agent 前台完成 = 子代理最终报告 + 运行总计）；`origin.kind === 'task-notification'` | `:4865-4875`、`:4308` |
| `AgentOutput` = `{ content[], totalToolUseCount, totalDurationMs, totalTokens, toolStats?, status: 'completed' } \| { status: 'async_launched' }` | sdk-tools.d.ts `:100-163` |
| `sdkToLogConverter` 不透传 `origin` / `tool_use_result`；`system` 帧全字段透传 | `sdkToLogConverter.ts:139-146`、`:202-210` |
| wire `tool-call-end` 只有 `call`；`agent{t:'start'\|'stop'}` 携 `subagent`；Web/wire 均 `discriminatedUnion('t')`——未知 `t` 只丢那一条（Web `normalizeRawMessage` null + warn），且 socket 快路径 null 会触发一次 REST 回拉（`sync.ts:2494-2510`） | `happy-wire/src/sessionProtocol.ts:36-38,115-118`；`typesRaw.ts:149-160,845-851` |
| `createEnvelope` 会 `.parse` 剥掉 wire 未声明字段 → 新字段必须同一构建声明在 happy-wire | `sessionProtocol.ts:164-175` |
| Web `MetadataSchema` 非 passthrough 且整体写回 → 不加新 metadata 字段 | `storageTypes.ts:7`、`ops.ts:1115-1130` |
| 通知 user 消息 `<result>` 实测 n=389：p50 3.3KB / p90 12KB / p99 29KB；`<status>` 8% 缺失；332/797 为 Bash 后台任务、53 为 Monitor | r3 统计 |
| Web `TurnActivityView` live→done 折叠一次不再自动展开；`sessionLive = thinking \|\| runningTool` | `TurnActivityView.tsx:34-38`、`ChatList.tsx:71` |

## 设计

### wire（happy-wire + Web `typesRaw` 副本同步）
- `agent{t:'start'}` 加可选 `description?: string`、`subagentType?: string`（首次 task_started 时携带）。
- **新 `agent{t:'progress'}`**：`{ subagent (cuid2), toolUses: number, lastTool?: string, totalTokens?: number, durationMs?: number, summary?: string }`。老 Web 丢该条并回拉一次 → CLI 节流：≥5s 且 `tool_uses` 变化才发。superRefine 要求 `subagent` 存在。
- `agent{t:'stop'}` 加可选 `status?: 'completed'|'failed'|'stopped'`、`result?: { text: string; truncated?: boolean }`、`usage?: { toolUses, totalTokens, durationMs }`。
- `tool-call-end` 加可选 `result?: { text: string; truncated?: boolean; isError?: boolean; stats?: { toolUses, durationMs, totalTokens, toolStats? } }`（仅 Agent/Task 且前台完成时填）。
- 老 Web：可选字段被 zod 剥掉；老 CLI：不发。无 `t` 以外的破坏。

### CLI（mapper + converter + launcher）
- converter 透传 `origin` 与 `tool_use_result`（运行时实证 `origin` 存在）。
- mapper 处理 `system`：
  - `task_started`：仅当 `tool_use_id ∈ 已见 Agent tool_use`（`task_type` 非 Agent、`skip_transcript` → 忽略）；映射 subagent cuid2，发 `start`（首次，带 description/subagentType）。
  - `task_progress`：节流后发 `progress`。
  - `task_notification`：发 `stop{status, usage}`；`result.text` 取**同一批到达的通知 user 消息**的 `<result>` 块（`origin.kind==='task-notification'`），剥 `[harness:…]` 前言与 `<usage>` 块，≤16KB + `truncated`；user 消息本身仍照发（Web 第一批已渲染机器行）。若通知 user 消息晚于 system 帧到达，`stop` 先发无 result，`result` 随后以**再发一次 `stop`**（同 subagent、同 status）补上——Web Phase 5 按 id 折叠，老 Web 单调 completed 不受影响。
  - `task_updated.patch.is_backgrounded` → 标记该子代理为后台（后续 tool_result 视为存根）；`background_tasks_changed` 集合里消失且未收到 notification → `stop{status:'stopped'}`。
- 存根判定：`tool_use_result.status === 'async_launched'` → 该 Agent 的 `tool-call-end` 不带 result、**不发 stop**（状态由 task_* 决定）；老路径（无 tool_use_result）沿用今日行为（发 stop）。
- 前台完成：`tool_use_result.status === 'completed'` → `tool-call-end.result`（content 的 text block 拼接、剥 trailer、≤16KB）+ `stop{status:'completed'}`。
- 跨 turn：provider→session subagent 映射进程内不释放；`closeTurn` 只清缓冲/started/active；缓冲上限 100 条、TTL 10 分钟后按顶层输出；`completed → running` 允许（续接：再次 task_started/progress 同 tool_use_id）。CLI 重启：映射丢失，老卡停在最后状态（矩阵）。
- 兼容老 JSONL 的 `Task` 名：mapper/launcher `'Task'` 特判改 Task|Agent 同路径（清理），改写既有 `sessionProtocolMapper.test.ts` 断言并说明。

### Web
- `typesRaw`：`progress` 事件 → `agent-event {type:'subagent-progress', id, toolUses, lastTool, totalTokens, durationMs, summary}`；`stop.status/result/usage`、`tool-call-end.result` 进 `tool-result.content`（string）。
- reducer：新索引 `sessionSubagent → Agent 卡内部 id`；agent 事件（start/progress/stop）改写卡的 `subagent` 状态字段（新 Phase 5 分支）：`{ status: running|completed|failed|stopped, toolUses, lastTool, totalTokens, durationMs, summary, result? }`；跨 turn 到达时更新早先 turn 的卡并标 changed；状态枚举允许 completed→running。
- `sessionLive` 纳入运行中 Agent 卡；折叠 turn 的 `.ta-head` chip 带运行态（accent 点，唯一 accent）。
- 指针行：状态点（运行 accent / 完成 ✓ / 失败 ✗ danger）、耗时、`n 次工具 · 最近：X`（优先 progress 的 lastTool）、结果 ≤3 行 + 展开、`+N −M`（有 toolStats 时）。`ToolRow` 接受外部 status。
- 兼容：无 task_* 的旧会话/旧 CLI 仍是第一批的诚实指针行。

## 兼容矩阵与发布顺序
| 组合 | 行为 |
|---|---|
| 新 Web + 旧 CLI | 第一批 UI；无状态/进度/结果 |
| 旧 Web（未刷新）+ 新 CLI | `progress` 逐条丢 + REST 回拉（节流后可接受）；`stop/tool-call-end` 新字段被剥；存根不发 stop → 药丸停在 running（接受） |
| 新 Web + 新 CLI | 真状态、结果、跨 turn 更新 |
| 后台 / 前台 | 后台：task_* + `<result>`；前台：tool_result/tool_use_result |
| 多次通知 / 续接 | completed → running → completed |
| Bash / Monitor 通知 | 仅机器行，不建卡 |
| CLI 重启 / handover | 映射丢失，老卡停在最后状态 |
| Codex / 镜像 | 不变 |
发布顺序：**Web 先**（同镜像，蓝绿）→ CLI tag。

## 风险
1. `progress` 让未刷新的老 Web 每条回拉一次——节流 + Web 先发把窗口压到切换瞬间。
2. `<result>` 与 system 帧到达顺序不定——用「stop 二次携带 result」兜底，Web 按 id 折叠。
3. 队列/续接状态机复杂——全部抽纯函数（`subagentLifecycle.ts`）单测。

## 验收标准
- [ ] wire：新字段/新 `t` 声明 + 旧 schema 剥字段 / 丢 progress 单测；Web `typesRaw` 副本同步。
- [ ] mapper：task_started/progress/notification → 事件；Bash/Monitor/skip_transcript 过滤；节流；存根不发 stop；前台 result；续接 completed→running；缓冲上限/TTL；`<result>` 提取与截断；stop 二次携带。
- [ ] converter 透传 origin/tool_use_result（含运行时实证）。
- [ ] reducer：跨 turn 改卡、状态枚举、`sessionLive`；指针行状态/结果渲染；designLanguage（accent 仅运行点）；390px。
- [ ] 门禁：wire/cli/web 全绿；CLI `--version` 冒烟。

## 留真机验证项
- 后台子代理：启动→进度→完成，卡状态与结果在跨 turn 后仍更新；续接后回到运行。
- 前台子代理（`run_in_background:false`）：结果与 `+N −M` 显示。
