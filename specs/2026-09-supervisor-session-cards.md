# 角色感知的会话卡片：supervisor / pi 会话里的 tick、决策、账本与代理工具

> 状态：Final（2026-09-04 Owner「按计划继续」即定稿；实现见 B-353 PR）
> 日期：2026-09-04 ｜ 关联 backlog：B-353 ｜ 出处：Owner 2026-09-04「对于不同角色的 veryhappy session 是不是可以针对性渲染一些卡片视图，我看有一些 toolcall 或者 user input 还是文本或者 json」

## 背景

vh-supervisor（`github.com/Mereithhh/vh-supervisor`）把 very-happy 当执行/观察面：一个常驻 pi
元会话（tag `supervisor`，`HAPPY_SESSION_VARIANT=assistant`）收 `vh-tick` 报告、记账、派发；被派的
pi 会话跑在 `pi-vh` 下（permission-gate + very-happy-bridge）。这些会话在 web 里目前长这样：

- 元会话收到的 tick 是一条以 `[vh-tick <iso>]` 开头的 **user 文本**（markdown 列表）；
- 元会话的决策是回复末尾的一个 **fenced ```json 块**（`[{taskId, action, reason, citedAcceptance…}]`）；
- `vh-ledger add/decide/bind` 是 **bash 工具行**，参数是一长串 argv；
- 元会话调用的 `session_spawn/session_send/session_read/sessions_list/…`（经 bridge 代理）和
  worker 里 pi 自己的 `bash/read/edit`，在 web 里**全部**显示为同一种 `execute` / `other` 行——
  只有 ACP 的 `kind`，没有工具名、没有结构化参数。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| ACP runner 把 ACP `tool_call.kind` 当成 `toolName` 发给 server（`toolName: toolKindStr \|\| 'unknown'`），`update.title`、`rawInput`、`_meta` 一律丢弃；args 只从 `content` 里猜 | `packages/happy-cli/src/agent/acp/sessionUpdateHandlers.ts:307-312, 447` |
| web 的工具渲染按工具名查 `knownTools`（`Bash/Read/Edit/…/execute/change_title…`），未命中走通用行 | `packages/happy-web-v2/src/components/tools/knownTools.tsx:57`（键列表）、`ToolView.tsx` |
| ACP `execute` 已有一个通用渲染（显示 command），`change_title` 是 hidden/minimal | `knownTools.tsx:646, 582` |
| 会话角色可从 metadata 判：`tags`（`spawnOriginTags`，来源 `--spawned-by`）、`variant`/`HAPPY_SESSION_VARIANT`、`flavor:'acp'` | `packages/happy-cli/src/utils/createSessionMetadata.ts:82`（B-343 后非 Claude meta 会话保留 origin tag） |
| user 消息里的 harness 块过滤先例（`<task-notification>` 等）说明"按文本模式识别一类消息并特殊渲染"已有基础设施 | `packages/happy-web-v2/src/screens/session/harness.ts:16-18` |
| e2e 实测 pi-acp 的 `tool_call`：`title` = 命令/简述（如 `echo vh-probe-ok`），`kind` = `execute`；权限请求 `pending[].tool` 恒为 `other` | `skills/tmp/vh-supervisor/e2e-report.md` S2、`probe.mjs` 输出 |
| vh-supervisor 侧契约：tick 报文头 `[vh-tick <iso>] N item (…)`，每项 `## n. <kind> — T-xxx "<goal>" (autonomy: …, status: …)`；决策 JSON schema 见 charter §3 | `vh-supervisor/src/tickRender.js`、`charter/SUPERVISOR.md` |

## 目标

1. **元会话（supervisor）**：tick 报告渲染成"待决事项卡片列表"（每项：kind 徽标 dispatch/checkin/permission/review/missing、任务 id+目标、会话链接、验收条目、pending 请求与等待时长）；决策 JSON 块渲染成"决策卡片"（action 徽标、reason、引用的验收条目高亮、执行的命令）；`vh-ledger` 调用折叠成一行"账本：T-012 ← accept（引用 0,2）"。
2. **所有 pi 会话**：pi 的 `bash/read/edit/write` 复用现有 `Bash/Read/Edit/Write` 渲染（命令高亮、diff 视图），不再是裸 `execute`；bridge 代理的 very-happy 工具（`session_spawn/send/read/kill/archive`、`sessions_list`、`change_title`、`report_progress`）各有专用卡片（spawn → 目标会话链接 chip；read → 折叠 transcript；sessions_list → 表格）。
3. **权限卡片**：pi 的 ask 卡片显示 gate 的规则 id 与理由（现在只有 "other"）。
4. 旧 CLI / 非 pi 会话零回归：识别不到就回落今天的渲染。

## 非目标

- 不做新的服务端字段或新轮询；不改 wire schema（V1 只把 ACP 已有字段透传进现有 `tool-call` 消息的 args）。
- 不在 web 里解释 ledger 文件（只渲染会话里出现的信息）。
- 不做 Task Board 的 supervisor 视图（另立 spec）。

## 设计

### A. CLI：ACP tool-call 保真透传（前置，小改，happy-cli 单包）

`sessionUpdateHandlers.ts` 的 `tool-call` 事件 args 增加：`acpTitle`（`update.title`）、`acpKind`、
`rawInput`（若 ACP 给了）、`piTool`（从 pi-acp 的 `_meta` 或 `rawInput.toolName` 取；实现前先跑一次
`probe.mjs` 打出 pi-acp 的完整 `tool_call` 载荷确认字段名——**不要猜**）。`toolName` 保持 `kind`
以免破坏老 web；新字段全部可选（铁律 4）。权限请求同理：`permission-request` 带上 ACP
`toolCall.title/kind` 与 pi-acp 转出的 confirm 标题（gate 的规则 id 与理由就在那里）。

### B. Web：按会话角色 + 工具身份渲染（web 单包，纯函数可测）

- `sessionRole.ts`（纯函数）：`metadata.tags` 含 `supervisor` → `supervisor`；`flavor==='acp' && piTool 出现过` → `pi`；否则 `default`。
- `knownTools` 新增 pi 工具映射：`piTool` 为 `bash/read/edit/write/grep/find/ls` 时**复用**现有 `Bash/Read/Edit/Write/Grep/Glob/LS` 的渲染器（参数字段名对齐：pi 的 `command/path/oldText/newText`）；bridge 工具各一个条目。
- `supervisorCards.ts`（纯函数）：解析 `[vh-tick …]` user 文本 → `TickReport{items[]}`；解析 assistant 末尾 fenced json → `DecisionBlock[]`（schema 校验失败 → 原样渲染）；解析 `vh-ledger` 命令 argv → `LedgerOp`。三个解析器都以 vh-supervisor 的 `tickRender` 输出与 charter schema 为 fixture。
- 渲染组件：`TickReportCard`、`DecisionCard`、`LedgerOpRow`、`SessionSpawnCard`（链接到目标会话，B-069 汇报也能挂在这）、`SessionsListTable`。Console 设计语言：卡片坐在 bg 台阶上、等宽显示 id/tag、accent 只表示 live/attention。

### C. 兼容矩阵

| web \ CLI | 旧（无 piTool） | 新 |
|---|---|---|
| 旧 | 今天的样子 | 多余 args 被忽略 |
| 新 | pi 工具仍显示为 `execute`（无 piTool 就回落）；supervisor 文本卡片**照常生效**（只依赖消息文本） | 全量 |

## 验收

- 单测：三个解析器（含畸形输入回落）、`sessionRole`、pi→known 工具参数映射；`publicContent.test.ts` 若源码断言 CLI 文件需同步。
- 隔离全栈：`spawn --agent pi` 跑一个 `vh-ledger add` + `vh-tick --apply` 循环，web 上元会话看到 tick 卡片与决策卡片，worker 会话看到 Bash/Edit 卡片，权限卡片显示 gate 规则 id。
- 老 web + 新 CLI、新 web + 老 CLI 各开一次会话无报错。

## 风险与取舍

- 文本模式识别（tick 头、json 块）与 vh-supervisor 的输出格式耦合：以 vh-supervisor 的 `tickRender` 测试输出为共享 fixture，两边同时改。
- pi-acp 的 `_meta` 字段是第三方约定，可能变：`piTool` 缺失只降级不报错。
