# Agent 自报状态 `set_status` + 看板卡片最近一轮预览 + 中断/无更新文案

> 状态：Draft
> 日期：2026-10-12 ｜ 关联 backlog：B-556（主体，协议）、B-553（看板卡片预览，web-only）、B-558（文案，web-only）｜ 出处：Orca 对照第二批（`AgentKanbanCard.tsx`、`AgentStateDot.tsx`）

## 背景

看板卡片今天只能告诉用户「在跑 / 等你 / 跑完待收」，至于**在干什么**，要么靠 daemon 侧 haiku 猜的
`metadata.board.progress`（B-132 前身、opt-in、最长 15 分钟一猜），要么点进会话读 transcript。
Orca 的看板卡片同时给出三样东西：agent 自己声明的阶段、最近一轮「你说了什么 / 它回了什么」、
以及待回答问题的摘要。本 spec 定 B-556 的协议部分（新 MCP 工具 + metadata 可选字段），并顺带
记录 B-553 / B-558 两个 web-only 改动的判据，因为三者落在同一张卡片上。

## 目标

1. 新增 happy MCP 工具 `set_status`（Claude / Codex / pi / 其它 ACP runner 都能调用），把
   `{ text ≤120 字, phase?, updatedAt }` 写进 session metadata 的可选字段 `selfStatus`。
2. Board 卡片与侧栏状态 tooltip 显示 `selfStatus`；会话已不在跑或 >30min 未更新时弱化显示。
   未知 phase 当纯文本显示（铁律 14）。
3. 旧 CLI 无此工具 → 看板照旧显示 LLM 推断的 `board.progress`；旧 web 忽略新字段，不报错。
4. B-553：卡片显示「你：最后一句」1 行 + 「agent 最后回复」2 行（去 markdown、截断）；有待回答的
   权限请求 / AskUserQuestion 时显示问题摘要块（`--warn`）。
5. B-558：用户主动停止导致的结束显示中性灰「已由你中断」，与「上一轮出错」文案区分；状态未知
   （活性租约过期）时在时间位写「N 无更新」而不是下结论。

## 非目标

- 不强制 agent 调用：不改 system prompt / `AGENT_GUIDANCE`，只在工具描述里写何时有用（B-493 教训：
  固定指令让每个会话多两轮工具调用，成本 +17%）。
- 不做「完成染绿」（`--accent` 只表示 live，设计契约）。
- 不新增订阅、不为预览拉全量历史、不碰 `sync/storage.ts` / `sync/sync.ts`。
- 不改活性计算（`agentLiveness.ts` / `agentStatus.ts` 的判定不动，铁律 13）。
- 不替换 `report_progress` / `boardAnalyzer`；两者并存，见「与 report_progress 的关系」。
- 手打在 web 终端里的裸 agent（`very-happy mcp` stdio，非托管会话）不提供 `set_status`：它没有 session metadata 可写。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 所有托管 runner 共用 `startHappyServer` 的 HTTP MCP；Claude 用其 `toolNames` 生成 `allowedTools`，漏登记 = 工具被 SDK 拒用 | `happy-cli/src/claude/utils/startHappyServer.ts:328`、`claude/runClaude.ts:1242` |
| Codex / Gemini / 非 pi ACP 走 stdio bridge，bridge **静态**逐个注册转发工具（`report_progress` 至今没被转发） | `happy-cli/src/codex/happyMcpStdioBridge.ts` |
| pi-acp 不透传 MCP（铁律 21），pi 扩展经 `HAPPY_MCP_URL` 调 `tools/list` **动态**注册；非 bypass 模式下只有白名单工具免确认 | `happy-cli/src/teams/resources.ts:66,106` |
| 非 Claude runner 都调 `startHappyServer(session, …)`（铁律 22） | `codex/runCodex.ts:787`、`agent/acp/runAcp.ts:633`、`gemini/runGemini.ts:512` |
| CLI `updateMetadata` 带版本 CAS + 账号级限速退避（B-307），是 fire-and-forget | `happy-cli/src/api/apiSession.ts:1362` |
| server 只存加密 metadata 字符串，不解析字段 | 现有 `update-metadata` 路径（无 schema） |
| web `MetadataSchema` 是普通 `z.object`：未声明字段在 parse 时被剥掉，web 的 rename/tag 写回会把它从服务端也删掉 | `happy-web-v2/src/sync/storageTypes.ts:8`、`startHappyServer.ts` 中 `source: 'self-report'` 注释 |
| 看板已显示 `board.progress`（LLM 推断/自报） | `screens/board/boardItems.ts:280`、`BoardCard.tsx` `.bd-card-progress` |
| 用户停止的 turn 在 transcript 里留下 `Aborted by user` / `Turn aborted` 服务事件，web 判据唯一入口是 `presentServiceEvent` → `stopped` | `screens/session/serviceEvent.ts:46`、`claude/claudeRemoteLauncher.ts:750,787`、`gemini/runGemini.ts:1170` |
| 失败 turn 的 `ready{status:'failed'}` 由 reducer 转成可见事件消息（错误文本或 `Turn failed`） | `sync/reducer/reducer.ts:588` |
| storage 的 `sessionMessages[id].messages` 是**新→旧**排序；只有本 tab 打开过或收到过新消息的会话才有 | `sync/storage.ts:25`、`sync/sync.ts:2822`（`onSessionVisible`） |
| 待处理请求在 `session.agentState.requests`（`tool/arguments/kind/createdAt`），随会话列表同步，不依赖消息 | `sync/storageTypes.ts:179` |

## 设计

### 1. 协议：metadata 可选字段 `selfStatus`

```ts
selfStatus?: {
  text: string;        // 单行，≤120 字符（CLI 截断）
  phase?: string;      // 写入方建议值：planning|implementing|testing|reviewing|blocked|done
  updatedAt: number;   // CLI 写入时刻（ms）
}
```

- 字段名刻意不用 `agentStatus`：web 已有 `sync/agentStatus.ts`（执行态）与 `agentState`，避免三者混淆。
- web schema：`z.object({ text: z.string(), phase: z.string().optional(), updatedAt: z.number() }).passthrough().optional().catch(undefined)`。
  `phase` 是 string 不是 enum：未来 CLI 新增 phase，旧 web 解析不失败，只是按纯文本显示（铁律 14）。
  `.catch(undefined)`：形状不对时只丢这个字段，不让整份 metadata parse 失败。声明它也保证新 web 的
  rename/tag 写回不会把字段删掉。不加 `.default()`（铁律 1）。

### 2. CLI：`set_status` 工具

- 注册在 `startHappyServer`（所有托管 runner 共用），名称 `set_status`，同时进 `toolNames`（Claude allowedTools）、
  stdio bridge 转发（Codex/Gemini/ACP）、pi 免确认白名单（与 `report_progress`/`change_title` 同级，只写本会话 metadata）。
- 入参：`text: string`（必填）、`phase?: enum(planning, implementing, testing, reviewing, blocked, done)`。
  工具 schema 用 enum 引导模型；CLI 侧对 text 规整成单行、去首尾空白、>120 截断加 `…`；空串返回错误。
- 写入合并（不是丢弃）：同一会话两次写入间隔 <10s 时，只保留最新值，在窗口结束时写一次（trailing）；
  与上次已写入值完全相同且 <60s 时跳过。理由：metadata 写入走账号级限速桶（B-307），而丢弃会让卡片停在旧文案。
  纯逻辑在 `claude/utils/selfStatus.ts`，带单测。
- 工具描述只写用途与时机（「长任务里阶段切换时调用一次；不要每个工具调用都报；纯问答不用调」），
  **不改 system prompt**。

### 3. Web 显示（B-556）

纯函数 `sync/selfStatus.ts`：`selfStatusView(raw, { now, live })` → `{ text, phase, knownPhase, stale, updatedAt } | null`。

- `live` = 看板 status ∈ {working, attention}（即执行态 running/background/input，复用现有分类，不另算活性）。
- `stale` = `!live || now - updatedAt > 30min`（时钟回拨：`updatedAt > now` 视为刚更新，不算 stale）。
- 已知 phase 走 i18n 标签；未知 phase 原样作纯文本前缀。
- 卡片：一行「phase 标签 + text」，stale 时用 `--text-faint` 并在 tooltip 注明更新时间。
  与 LLM `board.progress` 的取舍：selfStatus 新鲜 → 只显示 selfStatus；否则若 progress 比 selfStatus 新（或无
  selfStatus）→ 显示 progress；否则显示弱化的 selfStatus。
- 侧栏：状态位 tooltip 追加「Agent：text」（stale 时附「（可能已过时）」）；只有 selfStatus、状态位为空时也给 tooltip。

### 4. 卡片最近一轮预览（B-553，web-only）

- 数据：storage 已有的 `sessionMessages[id].messages`（新→旧），每张会话卡一个 `storage` selector，
  结果按 messages 数组引用缓存在 `WeakMap`（同 `useBoardItems.runningBackgroundCounts` 先例）。
  **不进 `useBoardItems`**：侧栏也消费它，流式 delta 会让整个侧栏重建。没加载过消息的会话不显示预览（不触发拉取）。
- 扫描从最新往旧，到第一条「开启 turn 的用户消息」为止：用户文本跳过排队中/已取消、task-notification、
  只有 harness 块的消息；agent 文本跳过 thinking；去 markdown（代码块→`[code]`、强调、链接、列表符、
  `<options>`/`<attached_files>`），压单行、上限 300 字符，显示由 CSS line-clamp 1/2 行截断。
- agent 回复只取**该用户消息之后**的；还没回复则不显示 agent 行（避免把上一轮回复当这一轮）。
- 问题摘要：仅当卡片是 attention 且来自真实待处理请求时，取最早一个请求：
  AskUserQuestion → 第一个问题（多问附 `+N`）；elicitation/user_dialog → `message`；ExitPlanMode → 计划首行；
  其它 → `工具名 · 命令/路径/URL`。块用 `--warn` 文本 + `--warn-dim` 底（warn = 等待授权，已登记语义）。

### 5. 中断与无更新文案（B-558，web-only）

- 同一次扫描得出本轮结局：最新的服务事件若 `presentServiceEvent` 判为 `stopped` → `interrupted`；
  判为 `error` / `agent-error` / `claude-auth` → `failed`。只有卡片处于 idle（跑完待收）时才用它替换
  「跑完待收」徽标：`interrupted` → 「已由你中断」，`failed` → 「上一轮出错」；均为中性 `--text-faint`，不加新颜色。
- status `unknown`（租约过期，`agentStatus.ts` 已判定）时：徽标去掉「状态未知」的结论式长句，时间位改写为
  「{时长} 无更新」，完整解释放 tooltip；旧 daemon 估计态保留其说明。侧栏 unknown tooltip 同理前置「{时长} 无更新」。
- 活性判定一行不改：只改呈现。

### 与 report_progress 的关系

`report_progress`（B-132）写 `board.progress/attention`，同时压制 boardAnalyzer，`attention` 会把卡片放进
「等你」列——它是**分类信号**。`set_status` 只是**展示信号**，不影响分栏、不压制 analyzer。两者并存，
后续若要合并，由 Owner 拍板（风险 3）。

## 兼容矩阵与发布顺序

server 对 metadata 透明，表中 server 新旧行为一致，故按 CLI × Web 列；「CLI」指**该会话 wrapper 加载的代码**
（升级 daemon 不会热替换已在跑的 wrapper）。

| wrapper(CLI) | Web | 行为 |
|---|---|---|
| 旧 | 旧 | 今天的行为 |
| 旧 | 新 | 无 `selfStatus` → 卡片显示 LLM `board.progress`（如有）；预览/问题摘要/中断文案照常（只依赖已有消息与 agentState） |
| 新 | 旧 | 旧 web parse 剥掉 `selfStatus`，不报错；旧 web 改名/打标签会把字段从服务端删掉 → 直到 agent 下次 `set_status` 前不显示（仅影响新 web 用户的显示，无错误状态） |
| 新 | 新 | 卡片/侧栏显示自报状态，按 30min / 非 live 弱化 |
| 新 CLI | 旧 server | 可用：metadata 加密透传，server 不看字段 |
| Codex 会话中途升级 npm 包 | — | bridge 在会话启动时按当时版本拉起；若新 bridge 对旧 HTTP server 转发 `set_status`，只在模型真的调用时返回工具错误，不影响会话 |

发布顺序：无硬依赖。建议 server/Web 先（新 web 能读、且改名不删字段），再发 CLI；回滚任一方都退化为上表某一行。
不需要 Prisma migration、不改 wire、不加 capability（web 不向 CLI 发任何新请求）。

## 风险

1. **agent 刷写**：模型把 `set_status` 当日志逐步调用 → 账号限速桶压力。缓解：10s trailing 合并 + 相同值 60s 去重 +
   描述明写「阶段切换时」；最坏每会话 6 次/分钟。
2. **旧 web 删字段**：见兼容矩阵第 3 行。接受：仅显示缺失，下一次自报恢复。
3. **与 report_progress 语义重叠**：两个工具都是「告诉看板你在干嘛」，模型可能二选一或都调。接受本期并存；
   描述里区分「展示阶段」与「需要用户注意」。
4. **预览覆盖率**：没在本 tab 加载过消息的会话无预览（刷新后的冷会话）。接受：不为预览拉历史；会话一有新消息就自动加载。
5. **中断判据依赖服务事件文本**：旧 Codex 的 `turn-end{cancelled}` 若不带 `Turn aborted` 文本则识别不到，回退为「跑完待收」（今天的行为）。
6. **stale 判据用 CLI 时钟**：`updatedAt` 来自 CLI 机器，与浏览器有偏差；30min 量级下偏差可忽略，回拨按「刚更新」处理。

## 验收标准

- [ ] CLI：`set_status` 出现在 `toolNames`、stdio bridge、pi 免确认白名单；单测覆盖 text 规整/截断/空串、phase、合并与去重。
- [ ] CLI：`startHappyServer` 未改 system prompt；`pnpm -C packages/happy-cli build` + `--version` 冒烟通过。
- [ ] Web：`selfStatus` schema 宽容（未知 phase、坏形状不影响 metadata parse），单测覆盖 stale 判据与 progress 取舍。
- [ ] Web：卡片预览纯函数单测（新→旧扫描、排队/通知/thinking 跳过、去 markdown、无回复时不显示 agent 行、中断/失败识别）。
- [ ] Web：问题摘要单测（AskUserQuestion / elicitation / Bash / 无请求）。
- [ ] Web：unknown 时间位「N 无更新」、中断「已由你中断」中英文案；`agentLiveness`/`agentStatus` 测试不变全绿。
- [ ] 真浏览器 1280 与 390(coarse) × 亮/暗验收卡片，css-probe 取证。

## 留真机验证项

- 真实 Claude / Codex / pi 会话里模型是否会在合适时机自发调用 `set_status`（不强制，只能观察）。
