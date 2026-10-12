# report_progress 全 runner 化 + phase；看板卡片最近一轮预览；中断/无更新文案

> 状态：Final
> 日期：2026-10-12 ｜ 关联 backlog：B-556（协议）、B-553（卡片预览，web-only）、B-558（文案，web + Codex 一处补发）｜ 出处：Orca 对照第二批（`AgentKanbanCard.tsx`、`AgentStateDot.tsx`）；`docs/competition/2026-09-ux-review/README.md` §T-03（:247「该句只能来自 report_progress 或 boardAnalyzer，不新增第三个写者」）、§G-03（:341「report_progress 没进 stdio bridge」）

## 背景

看板卡片的「在干什么」只有 `metadata.board.progress` 一个来源，写者是 agent 自报 `report_progress`（B-132）与 daemon
的 boardAnalyzer。前者只在托管 Claude 会话可用：stdio bridge 只转 `change_title` / `copy_to_clipboard` / `open_preview`，
`publicContent.test.ts` 甚至断言 bridge 不含它，于是 Codex / Gemini / ACP 会话永远没有自报进度。初稿曾提议新增
`set_status` 工具与 `metadata.selfStatus` 字段，被主 agent 否决（第三个写者，违反 T-03 的缓解约束），改为本方案。

## 目标

1. `report_progress` 对所有托管 runner 可用：Claude（in-process）、Codex / Gemini / ACP（stdio bridge 转发）、pi
   （`HAPPY_MCP_URL` `tools/list`）；Codex 与 pi 对它免审批（只写本会话 `metadata.board`，与 `change_title` 同级）。
2. 可选参数 `phase`（planning/implementing/testing/reviewing/blocked/done），存 `metadata.board.phase`；web 宽容解析，
   未知值当纯文本（铁律 14）。原有节流与 attention 跃迁语义不变（V-072 / V-076 不回归）。
3. Board 卡片与侧栏 tooltip 显示 `board.progress`（+phase）；会话不在跑或 `analyzedAt` 超过 30min → 弱化。
4. B-553：卡片显示「你：最后一句」1 行 + agent 对它的回复 2 行（去 markdown）；有待处理请求时显示问题摘要（`--warn`）。
5. B-558：用户停止导致的结束显示中性「已由你中断」，与「上一轮出错」区分；活性租约过期时在时间位写「N 无更新」。

## 非目标

- 不新增工具 / metadata 字段之外的写者；不改 system prompt（B-493：不强制调用）。`AGENT_GUIDANCE` 原样。
- 不做「完成染绿」（`--accent` 只表示 live）。
- 不为预览拉历史、不新增订阅；不碰 `sync/storage.ts` / `sync/sync.ts`。
- 不改活性判定（`agentLiveness.ts` / `agentStatus.ts` / 租约 TTL，铁律 13）。
- 不修 `useBoardItems.ts` 把新→旧消息传给 `currentTurnMessages` 的既有排序问题（主 agent 另立项）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude 用 `startHappyServer` 的 `toolNames` 生成 allowedTools | `happy-cli/src/claude/runClaude.ts:1242` |
| bridge 静态逐个注册转发，原先无 `report_progress`；`publicContent.test.ts` 曾断言其缺席 | `happy-cli/src/codex/happyMcpStdioBridge.ts`、`happy-web-v2/src/screens/public/publicContent.test.ts` |
| pi 扩展经 `tools/list` 动态注册，非 bypass 模式白名单已含 `report_progress` | `happy-cli/src/teams/resources.ts:66,106` |
| Codex 审批只对 `change_title` 自动放行 | `happy-cli/src/codex/utils/permissionHandler.ts` |
| 自报节流：首次接受；attention 变化绕过；否则 30s 最小间隔；15min 新鲜期压制 analyzer | `happy-cli/src/claude/utils/boardReport.ts` |
| boardAnalyzer 整体覆盖 `board`（不展开旧值），只在 runClaude 里跑 | `happy-cli/src/claude/utils/boardAnalyzer.ts:370` |
| web `MetadataSchema.board` 为普通 z.object：未声明字段 parse 时被剥、web 写回会删 | `happy-web-v2/src/sync/storageTypes.ts` |
| 用户停止在 transcript 留 `Aborted by user` / `Turn aborted` 服务事件，判据入口 `presentServiceEvent` | `screens/session/serviceEvent.ts`、`claude/claudeRemoteLauncher.ts:750,787` |
| storage 的 `sessionMessages[id].messages` 新→旧排序；仅本 tab 打开过或收到过新消息的会话才有 | `sync/storage.ts:25`、`sync/sync.ts` new-message → `onSessionVisible` |
| 待处理请求在 `agentState.requests`，随会话列表同步 | `sync/storageTypes.ts` |

## 设计

### 1. CLI：report_progress 一处 schema、全 runner

- `claude/utils/reportProgressTool.ts`：`registerReportProgressTool(server, execute)`，schema = `progress`、`attention?`、
  `phase?`（enum）。`startHappyServer` 用它注册（执行在本进程：规整、节流、写 `metadata.board`）；bridge 用同一函数注册、
  按名 `callTool` 转发到 HTTP server。pi 仍走 `tools/list`，自动看到 `phase`。
- 节流：`shouldAcceptSelfReport(state, now, attention, phase?)`——新 phase（与上次接受的不同）视为里程碑绕过节流；
  省略或重复的 phase 不绕过，所以 V-072 ③（<30s 连调两次同内容 → 第二次静默节流）不变；attention 跃迁照旧优先（V-076）。
- 写入：`board = { ...旧 board 去掉 phase, phase?（仅本次给出时）, attention, progress, analyzedAt, source }`——本次没给
  phase 就不保留旧 phase（防止旧标签配新文本）。analyzer 整体覆盖 board，天然不带 phase。
- Codex `ALWAYS_AUTO_APPROVE_NAMES` 加 `report_progress` / `mcp__happy__report_progress`（+ id 前缀），否则每个里程碑都会
  弹审批、把会话推进「等你」。裸名与 id 前缀只在 elicitation 的 `serverName` 为 `happy`（runCodex 的 `mcpServers` key，
  `HAPPY_MCP_SERVER_NAME`）时放行（`change_title` 同规则），其他 MCP server 的同名工具照常挂起审批。
- Gemini（ACP）白名单加 `report_progress` / `happy__report_progress` / `mcp__happy__report_progress` + id 前缀。ACP 的权限请求
  不带 server 名，裸名无法绑定到本 server——与既有 `change_title` 同一已接受限制。

### 2. Web 显示（B-556）

- schema：`board.phase: z.string().optional().catch(undefined)`（坏值只丢该字段；无 default）。
- `sync/boardProgress.ts`：`boardProgressView(board, { now, live })` → `{ text, phase | unknownPhase, updatedAt, stale }`。
  `live` = 看板 status ∈ {working, attention}（复用现有分类）；`stale = !live || now - analyzedAt > 30min`（缺时间戳视为
  stale；CLI 时钟超前按刚更新）。卡片：phase 标签 + 文本，stale 用 `--text-faint`，tooltip 写更新时间；侧栏状态位
  tooltip 追加「进度：…（可能已过时）」。

### 3. 卡片最近一轮预览（B-553）

- 数据：storage 已有消息（新→旧），每卡一个 selector，结果按 messages 数组引用缓存在 WeakMap；不进 `useBoardItems`
  （侧栏也消费它，流式 delta 不能重建侧栏）。未加载消息的会话不显示预览、不触发拉取。
- 扫描到最新一条「开启一轮的用户消息」为止：跳过排队/取消、task-notification、仅 harness 块；agent 文本跳过 thinking；
  只取该用户消息之后的回复。去 markdown 时行内代码先换占位符、其余规则后再还原（`*.ts`、`__init__`、`Array<string>` 保持原样）；
  截断按码点（不切半个代理对）。
- 问题摘要：取最早请求（与 `attentionSince` 共用同一个 `earliestPendingRequest`）——AskUserQuestion 第一问（+N）、
  elicitation/user_dialog 的 message、ExitPlanMode 计划首行、其它 `工具 · 命令/路径/URL`。

### 4. 中断与无更新（B-558）

- 同一次扫描得出本轮结局：最新服务事件 `presentServiceEvent` 判 `stopped` → 「已由你中断」；`error`/`agent-error`/
  `claude-auth` → 「上一轮出错」。仅替换 idle 卡的「跑完待收」徽标，中性 `--text-faint`。
- Codex：用户停止原先只留 `turn-end{cancelled}`，web 识别不到；现在 `handleAbort('user')`（abort RPC）在确实中断了一轮时
  补发与 Claude 一致的 `Aborted by user` session event（只是一条可见事件，不改 turn 生命周期）。kill / 信号 / 本地退出
  （`handleAbort('kill' | 'exit')`）不发，对齐 Claude 的 `!exitReason`。
- 「N 无更新」：status `unknown`（租约过期，判定不变）时时间位改写。N 的起点 = max(本 tab 最后收到该会话心跳的时刻
  `lastHeardAt`, 会话 `updatedAt`)。`heartbeatLease` 另存 `lastHeardAt`（租约过期不删、只读、不参与判活）；本 tab 从未
  收到过心跳则只写「无更新」不给时长。终端条目沿用其 activity 时间。侧栏 tooltip 同一规则。

## 兼容矩阵与发布顺序

「CLI」指该会话 wrapper 加载的代码（升级 daemon 不热替换已在跑的 wrapper）。server 对 metadata 透明，任意版本行为一致。

| wrapper(CLI) | Web | 行为 |
|---|---|---|
| 旧 | 旧 | 今天的行为 |
| 旧（Claude） | 新 | `report_progress` 无 phase → 卡片显示 progress（无标签），弱化规则生效 |
| 旧（Codex / Gemini / ACP） | 新 | 没有该工具 → 照旧只有 boardAnalyzer（如开启）推断；预览/问题摘要/中断文案照常（依赖已有消息与 agentState）。旧 Codex 中断无 `Aborted by user` 事件 → 回退「跑完待收」 |
| 旧（pi） | 新 | 已能经 `tools/list` 调 `report_progress`（无 phase） |
| 新 | 旧 | 旧 web parse 剥掉 `board.phase`，其余照旧；旧 web 改名/打标签会把 phase 从服务端删掉，下次自报恢复 |
| 新 | 新 | 全部 runner 可自报进度 + phase |
| 新 CLI | 旧 server | 可用（metadata 加密透传） |
| Codex 会话中途升级 npm | — | bridge 按会话启动时版本拉起；新 bridge 对旧 HTTP server 转发也只是同名工具，已存在 |

发布顺序无硬依赖；建议 server/Web 先（新 web 读 phase 且改名不删字段），再发 CLI。无 migration、无 wire 改动、无 capability。

## 风险

1. **Codex/Gemini 开始写进度后，看板 attention 列可能多出 `review`/`blocked`**：这是 G-03 想要的对等；节流与跃迁规则同 Claude。
2. **旧 web 删 phase**：见矩阵，接受。
3. **预览覆盖率**：冷会话无预览；接受（不拉历史）。
4. **中断判据依赖服务事件文本**：Claude / Gemini 已发；Codex 本次补发；其它 ACP 未覆盖则回退旧文案。
5. **lastHeardAt 是本 tab 观测时刻**：不同 tab 的「N」可能不同；只用于文案，不参与判活。

## 验收标准

- [x] bridge 经共享函数注册并转发 `report_progress`；Codex 自动放行；pi 免确认；源码断言过 mutation-check。
- [x] phase 进 schema、节流（新 phase 绕过 / 重复不绕过 / attention 优先）有单测；写入不保留旧 phase。
- [x] web `board.phase` 宽容解析、弱化规则、卡片/侧栏显示有单测与真浏览器取证。
- [x] 预览纯函数单测（新→旧、跳过规则、去 markdown 占位、码点截断、中断/失败识别）；问题摘要单测。
- [x] 「N 无更新」起点与「从未收到心跳」分支有单测；`agentLiveness`/租约测试不变全绿。
- [x] web 全量 vitest / tsc / vite build；CLI build + `--version` + 相关 vitest。

## 留真机验证项

- 真实 Codex / pi 会话里模型是否会在里程碑自发调用 `report_progress`（不强制，只能观察）。
