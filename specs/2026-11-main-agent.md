# 主 agent（Main Agent）P1：入口、工具面、安全闸与 skills

> 状态：Draft（方向已由账号 Owner 11-11 拍板，见「拍板结论」；接口待 Lead 审定后转 Final）｜ backlog：B-910（方案）、B-916a/b/c（P1 实现）
> 本文件是 B-916a / B-916b / B-916c 三方的**接口契约**，实现与本文冲突时先改本文
> 关联：[2026-08-voice-assistant](2026-08-voice-assistant.md)（B-051 助手）、[2026-10-owner-briefing](2026-10-owner-briefing.md)（B-766 汇报板）、[2026-11-issues](2026-11-issues.md)、[2026-09-automations](2026-09-automations.md)
> 基线：main 4730fa970

## 0. 结论

主 agent = 把现有 B-051 / B-063 助手（`metadata.variant='assistant'` 的机器侧 Claude Code 会话）升级成**每个账号一个、侧栏常驻**的总入口。它什么都可以聊；需要动手的活交给 Teams Lead、独立会话或自动化，自己只读、只派、只汇报。VH 不自研 agent loop，只加三样东西：

1. **入口**（B-916a）：侧栏常驻 + ⌘K + 设置页。第一期只做文字入口，不做语音。
2. **工具面**（B-916b）：写操作只回回执、读操作有上限的 MCP 工具；补上 issue / todo / 项目 / 汇报板 / 收尾交接 / 重启。
3. **安全闸与 skills**（B-916c）：主 agent 硬禁出站工具（闸 1）；派活类工具带 `risk`，非 `none` 先出汇报板 decision 卡，批准后才派（闸 2）；托管 skill + CLAUDE.md 托管段 + `skillRoots` 挂载。

## 拍板结论（11-11）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 跑在哪台机器 | 常开的 Linux 开发机；由 KV 指针记录，设置页可改 |
| 2 | 数量 | 每账号一个，跨项目调度 |
| 3 | 能聊什么 / 与 Lead 的关系 | 什么都可以聊。只给各团队 Lead 派活、可发起 Lead 轮换，不兼任 Lead，不直接给成员派活 |
| 4 | 语音 | 第一期不做。现有 `/assistant` 语音页保持原样 |
| 5 | 安全闸 | 闸 1 硬禁出站工具 + 闸 2 派活标风险出 decision 卡（本文 §4） |
| 6 | 收尾 | 不做全自动收尾；只提醒，由用户勾选后批量收尾（P2） |

## 1. 现状（main 4730fa970，代码已核实）

| 能力 | 位置 |
|---|---|
| 助手会话 spawn、单例、cwd `~/.happy/assistant/` | `happy-cli/src/daemon/assistantSpawn.ts`、`assistant/bootstrap.ts` |
| 角色模板（只在首次写入，之后不覆盖） | `assistant/templates.ts` |
| Bash / Edit / Write / MultiEdit / NotebookEdit 在 SDK 层禁用 | `assistant/dispatcherTools.ts`（`withAssistantDenylist`） |
| 助手 MCP 11 个：`sessions_list / session_read / session_send / session_spawn / session_kill / session_archive / terminals_list / terminal_read / terminal_send / memory_update / journal_append` | `assistant/assistantTools.ts`，仅 `assistant && !VH_TEAM_SCOPE_FILE` 注册 |
| `owner_board_*` 只注册给团队 Lead | `attention/leadBoard.ts` `toolsExposed()` |
| Web `/assistant` 只有路由，侧栏和 ⌘K 没有入口 | `web-v2/src/app/AppRoot.tsx` |

缺口：没有入口；单机绑定；汇报板只给 Lead；禁了 Bash 后 todo / issue 新建指派 / 项目日志用不了；工具返回不设上限；用户级 MCP 里的出站工具（发消息、发帖、发布类）在助手会话里照样能调。

## 2. 数据：账号 KV（B-916a / B-916b / B-916c 共用）

两把 KV 都沿用 `vh.board-tasks.v1` 的约定：值是 **UTF-8 JSON 的 base64**，server 可信存储，Web 和 CLI 都用账号 token 读写 `/v1/kv`。读端对未知字段忽略，对缺失或不合法的字段按默认值处理，**不因单个字段坏掉而整体失败**。

### 2.1 `vh.main-agent.v1` —— 账号的主 agent 是哪个会话

```jsonc
{
  "v": 1,
  "machineId": "<machine id>",     // 主 agent 所在机器
  "sessionId": "<session id>|null", // 当前主 agent 会话；null = 该机器上还没起过
  "generation": 3,                  // 每次新开对话 / 轮换 +1
  "updatedAt": 1794334927713        // epoch ms
}
```

- 写：**daemon（B-916b）**在主 agent spawn、`forceNew`、重连到另一个会话后写入；Web 设置页改机器时写 `machineId` 并把 `sessionId` 置 null（B-916a）。写用 KV 的 version 做乐观并发，冲突时重读后再写一次，仍冲突放弃（下次 spawn 会再写）。
- 读：Web 先读指针找主 agent；指针缺失、机器不在线列表里、或 server 没有 KV 时，退回现有 `assistantMachineId` + `pickAssistantMachine` 逻辑。
- 「每账号一个」由指针保证：daemon spawn 主 agent 前先读指针，`machineId` 不是本机时拒绝（错误码 `main_agent_on_other_machine`，回执带对方 machineId），Web 显示「主 agent 在另一台机器上，去设置里改」。

### 2.2 `vh.main-agent-config.v1` —— 主 agent 配置

```jsonc
{
  "v": 1,
  "skillRoots": ["~/skills"],             // ≤16 项；每项 ≤512 字符；绝对路径或 ~ 开头
  "deniedTools": ["mcp__*__*archive*"],   // 闸 1 的追加模式，≤64 项；格式见 §4.1
  "safety": {                             // B-922，见 §4.4；缺省 = 宽松
    "v": 1,
    "preset": "loose",                    // strict | standard | loose
    "overrides": { "bash": false },       // 可选，逐项覆盖预设
    "allowedTools": ["mcp__chat__send_message"] // 「以后都允许」的工具全名，≤64 项
  },
  "quietHours": { "enabled": true, "start": "00:30", "end": "08:30", "tz": null }, // B-924；缺省 = 00:30–08:30 启用，tz null = 主 agent 机器本地时间
  "quietHours": { "enabled": true, "start": "00:30", "end": "08:30", "tz": "UTC" }, // B-924，见 §10.4
  "updatedAt": 1794334927713
}
```

- 写：Web 设置页（B-916a）。读：主 agent wrapper 启动时（B-916c），以及每次新开对话时。
- 本机补充文件 `~/.happy/assistant/config.json`，同一格式。两处**取并集**：`skillRoots` 去重合并，`deniedTools` 去重合并。没有任何一处能减少默认禁用表。
- 公开仓里的默认值是**空**：`skillRoots: []`，`deniedTools: []`。
- 不合法的项单独丢弃并在 wrapper 日志里记一行（不回显内容），其余照常生效。
- `quietHours`（B-924）：宽松读法，单项不合法就用默认值；schema 在 happy-wire `parseMainAgentQuietHours`。它不是安全设置，服务端「改松」检查不比较它。
- `safety` 段例外（B-922）：它的 schema 在 happy-wire `mainAgentSafety.ts`，读法是 **fail-closed**——`v≠1`、未知 preset、未知字段、非法取值、KV 请求失败或值不是 JSON，整段按「严格」处理（`allowedTools` 也不算）。本机 `config.json` 里的 `safety` 只能逐项改严，它的 `allowedTools` 不生效（主 agent 若开了 Bash，可能自己写这个文件）。B-916c 及更早的 CLI 不认识这段，照旧按严格运行。

## 3. 工具面（B-916b 实现，B-916c 加闸）

### 3.1 原则

- 写操作只回回执：`{ok:true, id, title?, url?, state}`，**≤400 字符**；失败 `{ok:false, error}` ≤400 字符。
- 上限**只对主 agent 会话生效**（`variant='assistant'` 且不在团队范围内）；普通会话的工具返回不变。
- 读操作分页：列表单行 ≤160 字符、整体 **≤4,000 字符**，按整行截断；正文类读取（会话、终端）**≤8,000 字符**。超限时回执末尾写明「已截断，用 cursor=<n> 继续」，`cursor` 是可选参数，含义为**字符偏移**（从截断处继续）。
- 超限在 CLI 工具层截断（新 wrapper）；server 侧回执截断是前置依赖 B-911，未落地时只靠 CLI 层。
- 带副作用的工具都接受 `requestId`（幂等）；超时不等于没做，先查再重试。
- 新工具都要进 `startHappyServer` 的 `toolNames`（自动放行列表），并且只在 `assistant && !VH_TEAM_SCOPE_FILE` 时注册。

### 3.2 工具清单（P1）

「闸 2」列 = 该工具是否必须带 `risk`（§4.2）。

| 工具 | 参数 | 回执 / 上限 | 闸 2 |
|---|---|---|---|
| `sessions_list` | `filter?: {machineId?, projectId?, state?}`、`cursor?`、`limit?≤50` | 4K | — |
| `session_read` | `sessionId`、`limit?≤20`、`cursor?` | 8K | — |
| `session_send` | `sessionId`、`text`、`risk`、`requestId?` | 400 | **是** |
| `session_spawn` | `directory`、`prompt?`、`title?`、`agent?: 'claude'\|'codex'\|'pi'`、`projectId?`、`risk`、`requestId?` | 400 | **是** |
| `session_kill` / `session_archive` | `sessionId` | 400 | — |
| `terminals_list` / `terminal_read` | 同现有，加上限 | 4K / 8K | — |
| `terminal_send` | 同现有 + `risk` | 400 | **是** |
| `owner_board_post / update / resolve / list` | 同 W0 `OwnerBoard*InputSchema`；主 agent 发的项 `source='agent'` | 400 / 4K | — |
| `issue_list` | `scope?: 'account'`（主 agent 默认 account）、`status?`、`projectId?`、`cursor?` | 4K | — |
| `issue_create` | `title`、`description?`、`projectId?`、`priority?`、`labels?`、`requestId?` | 400 | — |
| `issue_assign` | `issueId`（或 `key: 'VH-N'`）、`assignee: {agent, machineId?, directory?, model?}`、`requestId?` | 400 | — |
| `todo_list / todo_add / todo_complete` | 与 `very-happy todo` 同一套 API | 4K / 400 | — |
| `project_list` | `cursor?` | 4K | — |
| `project_context` / `project_note` | 现有参数 + `projectId?`（主 agent 必填） | 4K / 400 | — |
| `session_wrapup` | `sessionId`（用账号的收尾模板，与会话里按「收尾」相同） | `{ok, sessionId, state:'queued'\|'running'}`；拒绝 `{ok:false, sessionId, error}` | — |
| `session_handoff` | `from`、`to?`（缺省 = 新会话：在 `from` 的目录、本机先起一个同 agent 的会话）、`note?` | `{ok, from, to, state}` ≤400 | — |
| `session_restart` | `sessionId`、`when: 'idle'\|'now'`（仅本机会话） | `{ok, sessionId, scheduled, already?, targetVersion?}` | — |
| `teams_list` | `cursor?` | 4K：id / 名称 / 项目 / Lead botId / 在途任务数 | — |
| `lead_delegate` | `teamId`、`goal`、`acceptance: string[]`（1–32）、`note?`、`risk`、`requestId` | `{ok, as:'owner', via:'main-agent', team, lead, leadSessionId, state:'delivered'}` ≤400 | **是** |
| `lead_message` | `teamId`、`body`、`taskId?`（只作正文引用）、`risk`、`requestId` | 同上 | **是** |
| `automation_create` / `automation_update` | 现有参数 + `risk` | 400 | **是** |
| `session_message` | 现有参数 + `risk` | 400 | **是** |
| `dispatch_approved` | `approvalId` | 400 | —（§4.2 的执行入口） |
| `boards_read`（B-924） | `teamId?`、`perTeam?≤25`（默认 10）、`needsOwner?` | 4K：每个团队一段（Lead、未关项数、最新 N 条），其余放 other；只读 | — |
| `sessions_search`（B-924） | `projectId?`、`state?: active\|inactive\|api_error\|needs_owner\|archived`、`flavor?`、`q?`、`limit?≤50`（默认 20） | 4K：id / 状态 / 标题 / agent / 目录；账号级，不列主 agent 自己 | — |
| `wrapup_suggest`（B-924） | `sessions: [{sessionId, title?, reason}]`（1–20）、`requestId?` | 400：`{ok, boardItemId, created, state:'awaiting_owner'}`；只发一张多选决定卡，不收尾任何会话 | — |
| `wrapup_selected`（B-924） | `boardItemId` | 400：`{ok, boardItemId, queued, note}`；只对 Owner 勾选的会话调 `session_wrapup` 后端 | — |
| `automation_list / get / runs / pause / resume / run`（现有） | 现有参数 | 4K / 8K / 400 | create / update 过闸 2；其余见 §10.5 |

- `session_wrapup / session_handoff / session_restart` 对接 B-915、B-911（B-919，`assistant/mainAgentLifecycle.ts`，startHappyServer 在主 agent 会话上 `installSessionLifecycle`）；未安装时回执 `{ok:false, error:'not_available'}`。收尾、交接走 `@/wrapup/request`，与会话里按「收尾」「交接给…」和 `very-happy sessions wrapup|handoff` 同一轮；回执只有 id 与状态，不带对方会话内容。三者只在 Owner 明确要求时对点名的会话调用（决策 6），没有定时或自动调用路径。
- `session_restart` 走本机 daemon 的 `/session-restart-owner`（新路由，旧 daemon 404 → `daemon-too-old`，不会被当成立即重启）：`idle` = Owner 的「本轮结束后重启」队列（B-911）；`now` = 先过同一套会话守卫（不在线、本人终端、assistant、不支持的 agent、不报回合的旧 wrapper 都拒），再按 idle 队列自己的就绪规则 `idleRestartReady` 判断（回合、后台任务、automation run、排队中的升级、距最后一次回合边沿未满静默期，任一成立即 `busy:<原因>` 拒绝；只去掉观察窗），最后以 B-894 `ifIdle` 重启（停之前再查一次回合与后台任务），不打断。
- daemon 刚启动或交接后不满一个 lease（65 s）时，它还不知道会话是否在忙（turnActive=false、backgroundTasks=0、无回合边沿只说明未知），此时 `now` 返回 `busy:observing`，建议用 `when=idle`。
- 重复 requestId：收尾与交接给已有会话时，localId 已在会话最近消息里就不再发送，回执带 `deduped: true`（state 取那次请求的卡片：running / done，否则 queued）；`to: 'new'` 的 requestId → 新会话记在 `<HAPPY_HOME>/assistant/handoff-new.json`（7 天、200 条），wrapper 重启后重试返回同一个新会话并带 `deduped: true`。`from` / `to` 是主 agent 自己时直接拒绝。
- **给团队派活 = 投递进 Lead 会话，不是建任务**：主 agent 不属于任何团队，不用会话作用域的 `team_delegate / team_message`。`teams_list` 找到团队后，`lead_delegate` / `lead_message` 把原文（首行固定 `[Very Happy main agent → Lead]`，随后 goal、acceptance 列表、note；或 body）**投递进该团队 Lead 的会话**，走 B-506 投递链路（与 `session_send` 同一条路），由 Lead 自己调 `team_delegate` 拆给成员。主 agent 拿不到 taskId；进度由 Lead 回报，或主 agent 用 `session_read` 读 Lead 会话。Lead 不可达或投递失败：`{ok:false, error:'lead_unreachable'}`。不走账号级 owner actor 的 `/v1/teams/:id/actions`（reducer 的 `bot_busy` 检查会拒绝向挂着根任务的 Lead 派活；不填 assignee 又会新建 managed worker，绕过 Lead）。
- **项目日志作者**：`project_note(projectId, …)` 以**主 agent 会话自己的身份**写（authorSessionId = 主 agent 会话），**不得以账号 Owner 身份代写**（项目日志代谢会把 Owner 条目当作 Owner 本人的意思）。server 侧放宽一处权限：会话是本账号 KV `vh.main-agent.v1.sessionId` 指向的主 agent 会话时，允许它在本账号任意项目写 note（B-916b 实现）。

## 4. 安全闸（B-916c）

### 4.1 闸 1：出站工具禁用表

**定义**。出站 = 发到 VH 之外、他人可见：IM / 邮件 / 短信、代码托管平台的评论 / PR / issue、公开推送、包发布、对外分享；以及生产部署类动作。

**格式**。禁用表是一组**名称模式**（字符串），匹配对象是 SDK 里的工具全名：内建工具是 `Bash`、`WebFetch` 这样的名字，MCP 工具是 `mcp__<server>__<tool>`。

- 唯一的通配符是 `*`（匹配任意长度，含空串）；其余字符按字面匹配；**大小写不敏感**；整串匹配（隐含首尾锚定）。
- 合法字符：`[A-Za-z0-9_.*-]`，长度 1–128。不合法的项丢弃。
- 模式里**不写任何具体 IM 或服务名**；默认表全部是动词模式：

```text
mcp__*__*send*        mcp__*__*post*        mcp__*__*reply*       mcp__*__*publish*
mcp__*__*deploy*      mcp__*__*add_message* mcp__*__*create_message*
mcp__*__*comment*     mcp__*__*push*        mcp__*__*merge*       mcp__*__*release*
mcp__*__*invite*      mcp__*__*share*       mcp__*__*email*       mcp__*__*sms*
mcp__*__*forward*     mcp__*__*broadcast*   mcp__*__*notify*      mcp__*__*upload*
mcp__*__*create_issue* mcp__*__*pull_request* mcp__*__*rollback*
```

- **VH 自己的 MCP server（`mcp__happy__*`）不受默认表约束**：它的会话间派活由闸 2 管。用户在设置里追加的模式对所有工具生效（包括 `mcp__happy__*`）。
- **其他 MCP server 默认拒绝（fail-closed，QA77 #5）**：动词子串表会漏掉 `create_or_update_file`、`kubectl_apply`、`execute_sql`、`browser_click`、`tweet` 这类名字。主 agent 的定位是只读、只派活，所以 `mcp__<非 happy>__<tool>` 只有同时满足以下条件才放行：`<tool>` 的第一个词（按 `_`、`-`、camelCase 切分）是只读动词 `list / get / search / read / query / describe / fetch / find / show / view / lookup / count` 之一；名字里任何位置都不含写类动词（`create / update / upsert / delete / remove / write / set / put / patch / post / send / reply / publish / deploy / apply / exec / execute / run / push / merge / upload / invite / share / add / edit / move / rename / approve / close / archive / click / type / fill / submit / tweet / comment / notify / forward / install / kill / stop / start / restart / rollback / release / scale / drop / truncate / insert / grant`，例：`get_or_create_label` 仍拒）；默认表与用户表都不命中。
- 生效表 = 内建禁用（B-063 的 5 个）∪ 默认表 ∪ 第三方 MCP 默认拒绝 ∪ KV `deniedTools` ∪ 本机 `config.json` `deniedTools`。`deniedTools` 只能加严。B-922 起，默认表与第三方 MCP 的处理由 §4.4 的安全设置决定（严格预设 = 本节原样）；内建禁用和用户追加的模式始终硬拒。

**执行点**（两层，都在 SDK 层，与权限模式无关）：

1. `disallowedTools`：表里**不含通配**的项、以及形如 `mcp__<server>__*` / `mcp__<server>` 的整 server 项，直接合进 SDK `disallowedTools`（SDK 原生支持这两种写法），模型看不到这些工具。
2. `PreToolUse` hook（SDK `hooks` 回调，`bypassPermissions` 下同样执行）：每次工具调用按完整表匹配，命中即 `permissionDecision:'deny'`，原因文本固定为「主 agent 不能直接对外发送或做生产写入；请用派活工具并标 risk，或出 decision 卡」。模型据此改走闸 2。

**能力位**。wrapper 生效后在 session metadata `capabilities` 加 `main-agent-gates-v1`；Web（B-916a）只在有这个能力位时把「出站禁用表」设置项显示为已生效，否则提示升级 CLI。

### 4.2 闸 2：派活前分级（`risk`）

**字段**。§3.2 中「闸 2 = 是」的工具，主 agent 调用时**必须**带：

```ts
risk: 'none' | 'external' | 'production'
```

| 值 | 含义 | 例子 |
|---|---|---|
| `none` | 只在 VH 内部或本机，不对外可见 | 「查一下 X 为什么挂了」「写个周报草稿（只写不发）」「在本地仓库改代码、跑测试」 |
| `external` | 结果会发到 VH 之外、他人可见 | 给某人发消息 / 邮件、发 PR / issue 评论、公开 push、发包、对外分享链接 |
| `production` | 写生产数据或基础设施 | 生产 DB / k8s / 云资源写、部署与回滚、生产主机全局安装 |

缺 `risk` 或值不在枚举内：回执 `{ok:false, error:'risk_required'}`，不派。

**复核**。工具层对「要交给另一个执行者的文字」（见下表 `payload` 列）再跑两道分类，取三者最高：

1. 关键词规则（同步、无网络）：中英文动词表，如「发给 / 发消息 / 回复 / 群里 / 邮件 / send / reply / post / publish / deploy / 上线 / 生产 / 回滚 / merge」。只会把等级往上提。
2. haiku 一次性分类：沿用 daemon `claude -p --model haiku` 的先例（`titleGenerator.ts` 的 `runClaudeOneShot`），输入 = 工具名 + payload 前 2,000 字符，输出一个词 `none|external|production`。超时 20 秒；失败或输出不合法时**不降级**，按前两者的结果处理。

| 工具 | payload |
|---|---|
| `session_spawn` | `prompt` |
| `session_send` | `text` |
| `terminal_send` | `text` |
| `lead_delegate` / `team_delegate` | `goal` + `acceptance` |
| `lead_message` / `team_message` | `body` |
| `session_message` | `body` |
| `automation_create` / `automation_update` | `action.prompt`；`action` 是脚本时取 argv 拼接 |

**决策卡**。最终等级为 `none` → 直接执行。否则不执行，改为：

1. 把调用（工具名 + 参数 + 最终等级）存到 `~/.happy/main-agent-approvals/pending-dispatch/<approvalId>.json`（0600；B-922 起移出主 agent 的工作目录 `~/.happy/assistant`），`approvalId` 为随机 UUID，记录参数的 sha256。
2. 往汇报板发一张卡（W0 `AttentionItemPost`）：

```jsonc
{
  "sessionId": "<主 agent 会话>",
  "source": "agent",
  "kind": "decision",
  "key": "main-agent-dispatch:<approvalId>",
  "title": "主 agent 想派活（external）：<payload 首行 ≤60 字>",
  "bodyMd": "工具：session_spawn\n风险：external（声明 none，复核 external）\n内容：<payload 前 1,500 字>",
  "options": [
    { "id": "approve", "label": "批准执行" },
    { "id": "draft",   "label": "只出草稿", "recommended": true },
    { "id": "drop",    "label": "放弃" }
  ]
}
```

3. 回执：`{ok:true, state:'awaiting_decision', approvalId, boardItemId}`。主 agent 应告诉用户「已放到需要我决策」，不要重复贴内容。

**批准后执行**。用户在汇报板选择后，server 把选择写入卡片（`resolvedBy='owner'`、`ownerChoice`），Web 同时往主 agent 会话发一条 board 消息（localId 前缀 `board-`，B-766 现有机制）把它唤醒；只调 owner-respond API 不会唤醒会话，主 agent 下一回合的汇报板摘要里同样能看到。主 agent 调 `dispatch_approved({approvalId})`，工具层：

1. 读 pending 文件（入参是 `approvalId`；只有卡片 id 时可传 `boardItemId`，由闸 2 在自己的 pending 记录里反查 approvalId，之后校验不变）；不存在，或其中没有 `boardItemId` / 卡面 hash（发卡失败）→ `{ok:false, error:'approval_not_found'}`，**不跳过校验**（QA77 #3）。
2. 按 `boardItemId` 读回卡片，key 必须是 `main-agent-dispatch:<approvalId>`；卡片仍 open → `awaiting_decision`。
3. **卡面绑定**（QA77 P1）：发卡时按 server 存下的卡片算 `sha256({key, title, body_md, options[].id+label})` 存进 pending；此时重算，不一致 → `{ok:false, error:'card_tampered'}`。改标题、改正文、对调按钮 label 都会被拒。
4. 要求 `resolvedBy='owner'`，否则 `not_approved`；参数 sha256 与 pending 不一致 → `approval_mismatch`（防止批 A 派 B）。
5. **只派一次**（QA77 #4）：先用 `O_EXCL` 建 `<approvalId>.inflight`，建不成 → `{ok:true, state:'already_dispatched'}`；派发失败（工具回错或抛错）删掉标记，可重试；成功后写 `<approvalId>.done.json`，再调回执上一次结果。
6. 按选择执行：
   - `ownerChoice='approve'` → 原样执行存下的调用，payload 前加一行 `本任务已获批：<链接>`；
   - `ownerChoice='draft'` → **不派会话**，回执 `{ok:true, state:'draft_only'}`，主 agent 在对话里给出草稿（只出草稿 = 什么都不交给别的执行者）；
   - `ownerChoice='drop'` → 不执行，回执 `{ok:true, state:'dropped'}`；
   - 其他选择 → `not_approved`。

**写保护**（QA77 #2）：主 agent 会话的 `owner_board_post / update / resolve` 一律拒绝 key 前缀 `main-agent-dispatch:` 的卡（先 trim 再转小写比较）（post 看 key；update / resolve 看本地 pending 记录和读回的卡片 key，读不到按拒绝处理），回执 `{ok:false, error:'reserved_card'}`。这类卡只由闸 2 内部路径发出，不经过 MCP 工具。server 侧无法区分同一个账号 token 下「闸 2 内部」与「主 agent 的 MCP 工具」两种来源（两者都是本机 wrapper 用账号 token 调同一个 `/v1/attention-items`），所以不加 server 拒绝，靠第 3 步卡面绑定兜底。

链接格式：`<webappUrl>/session/<主 agent sessionId>?panel=board`，后面跟 ` （决策 <boardItemId>）`。

**汇报板不可用时**（旧 server / 开关关闭）：非 `none` 一律拒绝执行，回执 `{ok:false, error:'board_unavailable'}`。不回退成直接执行。

### 4.3 已知漏口

- 被派会话如果是 `bypassPermissions`，它自己能不能对外发送 VH 管不住；闸 2 只保证「派之前用户看过」。被派会话的 PreToolUse 出站拦截放 P3。
- 关键词和 haiku 都可能漏判：用户的决策卡是最后一道人工关口，但前提是有一道判成非 `none`。
- owner-respond 只接受浏览器登录（B-921 `requireHumanOwner`）：机器上的账号 token 调它会被拒（403 `owner_login_required`），所以本机进程不能替 Owner 在卡上做选择。
- B-922：开了 Bash 的主 agent 能直接调外部接口，出站分类管不住它；Web 在该项旁写明风险，默认关。
- B-922：**本机审批记录的边界**。闸 1 / 闸 2 的 pending 记录和 `.inflight` 标记都在本机（`~/.happy/main-agent-approvals/`），同一个 OS 用户的进程能伪造或删除后重放；拿机器 token 走 REST 也能自己发一张保留前缀的卡并互换标签（`RESERVED_CARD_KEY_PREFIXES` 含 `main-agent-tool:` 只挡 `owner_board_*` 工具，不挡 REST）。
  - **主 agent 自己伪造不了**，前提是 Bash 和改文件都关着（三档默认）。B-922 为此补了两条（QA P2-2）：① Bash 关时 `terminal_send` 无论 risk 怎么判一律出卡——往打开的 Web 终端里发内容等于有了 shell；② 任何档位下，**整个 HAPPY_HOME（`~/.happy` 与 `$HAPPY_HOME_DIR`，按真实路径解析，防 `..` 与符号链接；目标还不存在的悬空软链也跟过去检查，最多 8 跳，QA-U r2 P3-3）对主 agent 的文件工具关闭**：读（Read / Grep / Glob）只放行 `assistant/CLAUDE.md`、`assistant/memory/**`（含 journal）和 `uploads/chat/**`（聊天附件），Grep / Glob 的搜索根（Glob 含 pattern 的固定前缀）不在这些路径里、或包含 HAPPY_HOME（`~`、`/`、不带 path 时的工作目录 `assistant/`）一律拒绝；写（Edit / Write / MultiEdit / NotebookEdit）在 HAPPY_HOME 下全部拒绝，白名单也不能写（`memory_update` / `journal_append` 是 wrapper 里写的 MCP 工具，不受影响）。凭据（access.key、agent.key）、daemon 状态、审批记录、收尾卡 hash（`wrapup-cards/`）、跟进台账（`followups.json`）、precheck 账本等都被覆盖，以后新增的记录文件也自动受保护；token 和 secret 不会进模型上下文。审批记录挪到 `~/.happy/main-agent-approvals/`。
  - 打开 Bash 或改文件后，主 agent 就具备上面这些能力，本机审批记录和「先问我」卡片都不再可靠；只有服务端检查（机器 token 不能改松配置、always 授权有时效且只兑现一次）和 Owner 本人在 Web 上的批准还算数。Web 的开关说明如实写了这一点。
  - 已知边界：**硬链接**和原文件是同一个 inode，路径上看不出来，hook 拦不住（QA-U r2 实测 Read/Grep 能经硬链接读到 `followups.json`）。建硬链接需要 shell，所以这和「打开 Bash 后本机记录不可靠」是同一条边界，不单独处理。
  - 同一个系统用户下的其他进程仍然可以伪造本机审批记录；服务端加固（保留前缀与卡面绑定在服务端校验）归 B-927。
  - 严格档因此有两处有意的变化（相对 B-916c）：`terminal_send` 在 `risk=none` 时也出卡；HAPPY_HOME 对文件工具关闭（只读白名单）。其余逐字不变。
- B-922：「人 vs 机器」用 B-921 的 `requestTokenKind`（token 带登录会话 = 人）；登录会话出现前签发的旧 Web token 算机器，只能改严，Web 会提示去已登录的浏览器里改或重新登录。
- 闸只装在 Claude 主 agent 上（`runClaude` 构建运行时）。pi / ACP 的 assistant variant 不注册主 agent 账号级工具和上限，只保留 B-051 的旧会话工具（QA77 #6）。

### 4.4 安全设置：预设、逐项覆盖与 ask（B-922）

Owner 11-11：「主 agent 的安全阀太严格了……可以让用户配置」。配置在 §2.2 的 `safety` 段。

**工具分类**（只对非 `mcp__happy__*` 的 MCP 工具；内建和用户追加模式不受影响）：

- 只读：§4.1 的只读判定通过，且不命中默认表 → 永远直接用。
- 生产类：`<tool>` 含 `deploy / release / rollback / publish`，或按词切分后含 `apply / scale / drop / truncate / migrate / rollout / terminate / destroy`。
- 出站类：命中 §4.1 默认表，且不是生产类。
- 其他写：上面都不是、又不是只读的第三方 MCP 工具。
- 只读名字里碰巧含默认表动词（如 `list_deployments`）：这一类设为「禁用」时拒，否则直接用。

**各预设的行为**：

| 类别 | 严格（= B-916c） | 标准 | 宽松（新默认，Owner 11-11） |
|---|---|---|---|
| 内建 Bash | 禁用 | 禁用 | 禁用（高级里可开） |
| 内建 Edit / Write / MultiEdit / NotebookEdit | 禁用 | 禁用 | 禁用（高级里可开） |
| 用户追加的 `deniedTools` | 禁用 | 禁用 | 禁用 |
| `mcp__happy__*` | 直接用（闸 2 管派活） | 同左 | 同左 |
| 第三方只读工具 | 直接用 | 直接用 | 直接用 |
| 第三方生产类 | 禁用 | 先问 | 先问 |
| 第三方出站类 | 禁用 | 先问 | 直接用 |
| 第三方其他写 | 禁用 | 先问 | 直接用 |
| 闸 2 `risk=external` | 先问 | 先问 | 直接派 |
| 闸 2 `risk=production` | 先问 | 先问 | 先问 |

没有 `safety` 段的账号用默认「宽松」；保存过档位的按保存的走。`automation_run / resume / fire` 三档都不过闸 2（只运行 Owner 已建好的自动化；严格档必须与 B-916c 逐字一致，而它们在 B-916c 本来就不过闸）；`automation_create / update` 维持 §4.2 的 risk 规则。

逐项覆盖（`overrides`）键：`production / outbound / thirdPartyWrite`（`deny|ask|allow`）、`dispatchExternal / dispatchProduction`（`ask|direct`）、`bash / fileEdits`（布尔）。`allowedTools` 只把「先问」变成「直接用」，永远不解除「禁用」。

与派工描述的边界调整（理由）：宽松档的「先问」不只看 deploy / release / rollback / publish 四个子串，还加了 `apply / scale / drop / truncate / migrate / rollout / terminate / destroy` 这些整词——`kubectl_apply`、`drop_table` 这类名字不含那四个词，但同样是生产写；宽松档的 Bash 默认仍关，只能在高级里手动打开（Bash 能绕过所有出站规则）。

**ask（闸 1）**。PreToolUse 判为「先问」时：

1. 参数 `tool_input` 按闸 2 的 `canonicalArgsHash(tool, input)` 取指纹；`~/.happy/main-agent-approvals/pending-tool/<hash>.json` 没有记录 → 发卡并拒绝本次调用。卡：`key = main-agent-tool:<approvalId>:<toolName>`，标题「主 agent 想调用 <tool>」，正文 = 工具名、参数指纹前 12 位、参数 JSON 摘要（≤1,500 字），选项 `once 批准这一次 / always 以后都允许这个工具 / deny 拒绝`；卡面文字跟账号的 `preferredLanguage`（没设即「自动」或读不到 → 中文，与闸 2 卡、原因行一致；不看本机 locale，daemon 常是 `LANG=C.UTF-8`，QA-U r2 P3-2），选项 id 不变。拒绝原因告诉模型「已出卡，先停下告诉用户；批准后用完全相同的参数再调一次」。
2. 再次同参数调用：用闸 2 与 `very-happy settings` 共用的校验（`attention/ownerApproval.ts` 的 `ownerDecision`：key、已关闭、`cardFaceHash` 不变、`resolvedBy='owner'`）。还开着 → 仍拒（等待）；卡没了 / 被改 / 不是 Owner 关的 → 作废并重新出卡。
3. `once` / `always` → 用 `O_EXCL` 建 `<approvalId>.inflight`（共用的 `approvalClaims`），建成才放行，**只放这一次**，记录随即删除，同参数下一次重新出卡；并发同参数调用只有一个通过。`always` 另把工具加进内存 allow 集，并以机器 token 写入 KV `safety.allowedTools`（`persistAllowedTool`，乐观并发；段读不懂时不写）。`deny` → 拒绝并提示不要重试。
4. 汇报板不可用或抛错 → 拒绝（fail-closed），原因写明没执行。
5. `main-agent-tool:` 与 `main-agent-dispatch:`、`settings-change:` 同为保留前缀（`RESERVED_CARD_KEY_PREFIXES`）：主 agent 的 `owner_board_*` 不能新建、修改或关闭这类卡。

**闸 2**。`effectiveRisk` 得出 `external` / `production` 后，对应项为 `direct` 时直接执行原 handler（日志记一行），否则照 §4.2 出卡。

**真正的边界是服务端检查 + Owner 的批准卡**：本机 `config.json` 只能逐项改严（主 agent 若开了 Bash 能改这个文件，所以它不能放松任何东西）；放松只能通过账号 KV，而账号 KV 的放松只接受浏览器登录的 Owner，或 Owner 在卡上选了「以后都允许」的那个工具。

**只有 Owner 本人能改松**。server `POST /v1/kv`：请求 token 被 `requestTokenKind`（`app/auth/tokenKind.ts`，B-921 定义，与 owner-respond 共用：token 带登录会话 id 即为人）判为机器时，对 `vh.main-agent-config.*` 的每个写入用 happy-wire `mainAgentConfigLoosening(旧值, 新值)` 比较：任何一项变松、删掉 `deniedTools`、删除整个值（回落到默认宽松）、写入非 JSON / 非对象、`safety` 段读不懂（未知版本、字段或取值，按「更宽松」处理）→ `422 {error:'main_agent_config_owner_only', key}`。唯一例外：只新增 `allowedTools`，且每个新增工具都有本账号一张 `main-agent-tool:*:<tool>` 卡被 Owner 以 `always` 关闭（这就是第 3 步的写入）。收紧不限；`quietHours`、`skillRoots` 等其他字段不比较。**always 授权有时效且只兑现一次**（QA P2-1）：服务端自持 KV 记录 `vh.main-agent-grants.v1`（任何客户端 token 写它都 `422 server_owned_kv_key`），记着已兑现的卡 id，以及人类写入「收回」了什么：`toolRevokedAt[key][tool]` = 最近一次把该工具从 `allowedTools` 移除的时间，`humanWriteAt[key]` = 最近一次整体收紧该 key 的时间（预设/单项改严、新增 `deniedTools`、删除整个值、写入读不懂的值）。一张 always 卡只有 `resolvedAt` 晚于这两个时间、且没兑现过时才算数；没收回该工具的人类写入（改 quietHours、移除别的工具、改松）不作废旧卡（QA-U r2 P3-1：Owner 点了「以后都允许」、主 agent 重试前改了一次设置，授权照样写进去）。人类写入前先记时间（之后写失败也只会让旧卡提前作废，更严），机器写入成功后再记兑现。Owner 在 Web 上移除一个已允许的工具后，旧卡再也加不回它；CLI 写入被 422 拒绝时日志记 `persist: refused`（不是 `unavailable`）。`POST /v1/kv/bulk` 是批量读，不写，无需检查。用 422 而不是 403：Web 的 `isAuthFailure` 把 401/403 都当认证失败处理（403 不会登出，但也不是「写入被拒」的语义）。

**能力位**。wrapper 在 session `capabilities` 加 `main-agent-safety-v2`，daemon 在 `daemonState` 加 `mainAgentSafety`。Web 设置 → 主 agent → 安全只在主 agent 所在机器有 `mainAgentSafety` 时显示预设与高级项，否则提示升级 CLI（旧 CLI 按严格运行）。

**生效时机**。主 agent wrapper 启动时读取（新开对话即新进程）；「以后都允许」在当前进程立即生效。

## 5. Skills（B-916c）

| 层 | 内容 | 位置 |
|---|---|---|
| L1 VH 自带 | `very-happy-main-agent`（主 agent 手册：派活规则、risk 判定、工具上限、汇报格式）；另引用已有的 `very-happy-teams`、`very-happy-automations` | `installManagedSkill` 写到 `~/.local/share/very-happy/skills/<name>/SKILL.md`（B-496 机制，不碰宿主 skills 目录） |
| L2 用户挂载 | `skillRoots`（§2.2） | 用户机器上的任意目录 |
| L3 项目级 | 各仓库自己的 `.agents/skills` | 派到该项目的会话自己读 |

**托管段**。主 agent 家目录 `~/.happy/assistant/CLAUDE.md` 里有一段由 VH 管理：

```markdown
<!-- vh:managed:main-agent:begin -->
…（L1 skill 的绝对路径、L2 skillRoots 列表、闸 1/闸 2 摘要）…
<!-- vh:managed:main-agent:end -->
```

- 每次主 agent wrapper 启动时重新渲染并**只替换这一段**；段外内容属于用户，不动。旧文件没有这段时追加到文件末尾；标记残缺（只有 begin 或只有 end）时不改文件，日志记一行。
- `skillRoots` 生效方式：① 展开 `~` 后写进托管段，告诉主 agent「检索领域知识时先在这些目录里 Grep / Glob `SKILL.md`」；② 同时作为 SDK `additionalDirectories` 传入，使 Read / Grep / Glob 在任何权限模式下都能访问。不存在的目录跳过并在段里标「（不存在）」。
- 公开仓只放 L1 内容和空配置；模板、SKILL.md 不出现任何具体 IM、组织名、域名、人名，由仓库敏感词守卫（`sensitiveTerms.test.ts`）覆盖。

## 6. Web（B-916a）

- 侧栏顶部固定「主 agent」入口（决策 A1 那一排），状态点：idle / 在想 / 离线。同一个会话，不是新会话。
- **桌面是布局里的一栏（B-923，取代 B-916a 的悬浮抽屉）**：在壳的主行最右（详情 | 笔记 | 主 agent），挤窄会话区、不遮挡。规则在 `screens/mainAgent/mainAgentDock.ts`：主行（侧栏右侧）≥ 972px 才停靠，否则（窄窗口、手机）打开 `/main-agent` 全屏页；宽度 [320, min(560, 主行 − 6 − 646)]，默认 400，会话区至少留 646px——会话自己的右侧工作区面板（文件 / 预览 / 汇报板）上限是「容器 − 326px」，所以对话与工作区面板各 ≥ 320px，不重叠、不横向滚动；笔记 dock 同排时（`dockLayout`）优先级是：会话区预留 > 主 agent 栏（先收窄到 320）> 笔记 dock（再收窄到 300）；还放不下时笔记 dock 让位（保持挂载、不显示），栏顶提示一行并给「收起主 agent」，收起后笔记回来。任何面板都不会被压到最小宽度以下。输入框草稿存在 store（`composerDraft`），栏位卸载、换到全屏页都不丢。开关与宽度按设备存 localStorage `vh.main-agent-dock.v1`。侧栏入口、⌘K「打开 / 关闭主 agent」、⌘⇧E 都是开关；拖柄支持拖动、键盘、双击恢复默认，拖到 200px 以下松手收起。
- **工具调用特化展示（B-923）**：消息流里主 agent 的工具按语义渲染成卡片（`screens/mainAgent/toolCards/`），回执字段以 CLI 实际返回为准；闸 1 拦截按 PreToolUse 拒绝原因识别，闸 2 决策卡按 `state:'awaiting_decision'` 与 `dispatch_approved` 回执识别；未识别的工具走通用行。全部形态见 `/dev/main-agent-tools`。
- ⌘K「问主 agent…」直接把输入发过去。
- 设置页：机器（写 `vh.main-agent.v1.machineId`）、`skillRoots`、追加禁用模式（写 `vh.main-agent-config.v1`），按 §2.2 校验后再写。
- 会话仍 `isHiddenSession`（不进会话列表和看板）；`metadata.variant` 仍是 `'assistant'`，不改值。
- 旧 CLI（无 `main-agent-gates-v1` 能力位，或不支持 assistant）：入口显示，点开提示升级，不盲 spawn。

## 7. 文件归属（三方并行，冲突时由集成人 B-916c 整合）

| 归属 | 文件 |
|---|---|
| B-916a | `happy-web-v2/src/screens/assistant/**`、侧栏 / ⌘K 入口、设置页新组件、Web 侧 KV 读写 |
| B-916b | `happy-cli/src/assistant/assistantTools.ts`、新工具模块（issue / todo / project / board 放开 / 收尾交接重启）、daemon 写 `vh.main-agent.v1` |
| B-916c | `happy-cli/src/assistant/gates/**`（闸 1、闸 2、分类器、`dispatch_approved`）、`assistant/bootstrap.ts`、`assistant/templates.ts`、`assistant/mainAgentSkill.ts`、`claude/sdk/query.ts` 与 `claudeRemote*.ts` 的 hooks / additionalDirectories 透传、本 spec |

闸 2 的接法（代替「每个工具自己调 DispatchGate(req)」的钩子写法）：B-916c 在 `startHappyServer` 里给主 agent 会话建一个包装过的注册器 `dispatchRegistrar = mainAgent.gate.wrap(mcp)`（`assistant/gates/dispatchGate.ts`），团队、自动化、会话互发和助手工具都经它注册。§3.2 中「闸 2 = 是」的工具名一经它注册，就自动多一个必填 `risk` 参数并被拦截；`none` 时调用原 handler，且传进去的 args **不含** `risk`。因此：

- B-916b 的新工具（`lead_delegate`、`lead_message` 等）只要用传入的注册器（类型 `AssistantToolRegistrar`）注册，并使用 §4.2 表里的字段名（`goal` / `acceptance` / `body` / `prompt` / `text`），就不用自己处理 `risk`；**不要**在 inputSchema 里再声明 `risk`。
- 新增派活类工具时，在 `DISPATCH_TOOL_PAYLOADS` 里加一行（工具名 → payload 取法），并同步本 spec §3.2 / §4.2。

## 8. 兼容与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 旧 CLI | 入口显示，点开提示升级；不盲 spawn |
| 新 Web + 新 CLI + 旧 server（无 KV / 无汇报板） | Web 退回 `assistantMachineId`；闸 2 遇到非 `none` 一律 `board_unavailable` 拒绝 |
| 旧 Web + 新 CLI | 旧 `/assistant` 照常；新工具与闸在会话内生效 |
| 存量旧 wrapper | 没有新工具和闸；随 B-911 / 自动重启换到新版本 |
| B-922 新 Web + 旧 CLI（无 `mainAgentSafety`） | 安全一节提示升级；旧 CLI 不认 `safety` 段，按严格运行 |
| B-922 新 CLI + 旧 server（无守卫） | 设置照常生效；机器 token 改松不会被拒（守卫随 server 发布） |
| B-922 新 CLI + 旧 Web（B-916a） | 旧 Web 写配置时保留未知字段，`safety` 不丢；没有设置入口，默认宽松 |
| B-922 新 server + 旧 CLI | 旧 CLI 只读配置，不受影响 |

- 不改 wire schema、不加 server 路由、不加迁移：KV 用现有 `/v1/kv`，汇报板用现有 `source='agent'`；派给 Lead 是投递进 Lead 会话（B-506 链路），**不改 reducer、不走 owner actor 的 teams actions**。
- **一处 server 权限放宽**（B-916b）：主 agent 会话（以 KV `vh.main-agent.v1.sessionId` 判定）可在本账号任意项目以自己身份写 project note。旧 server 上该写入被拒，工具回执 `{ok:false, error:'project_not_member'}`，不回退成 Owner 身份。
- 发布顺序：Web 与 CLI 可独立发布；默认先 server/Web 后 CLI。B-922 必须先 server/Web（守卫先在），再 CLI（新默认「宽松」随 CLI 生效）。

## 9. P1 验收（不含语音）

- [ ] 手机（窄屏 + `pointer: coarse`）和桌面都能从侧栏一键打开主 agent 并用文字对话；无横向滚动，键盘不遮挡（css-probe 取证）。
- [ ] 「帮我在 X 项目开个会话做 Y」→ 新会话带正确标题和项目，回执 ≤400 字符。
- [ ] 「把 VH-12 指给 codex」「加个 todo」「这个项目最近日志说了啥」都能完成。
- [ ] 「帮我给 A 发消息说…」→ 不发送，汇报板出 decision 卡；批准后才派会话执行；被派会话 prompt 带批准链接。
- [ ] 主 agent 会话里出站类 MCP 工具被 SDK 拒绝（单测 + 隔离 `HAPPY_HOME_DIR` 实跑 probe）。
- [ ] 所有工具回执 / 列表超限单测（含 mutation-check）。
- [ ] 挂一个测试目录为 `skillRoots` 后，主 agent 能检索到其中内容。
- [ ] 敏感词守卫通过：模板与 SKILL.md 无个人 / 组织信息。
- [ ] 旧 CLI 机器上 Web 提示升级，不盲 spawn；四包门禁全绿。

## 10. P2 A 批：会主动、管收尾（B-924）

### 10.1 自动化把主 agent 作为目标

- `send` 动作二选一：`sessionId`，或 `target: 'main-agent'`（`AUTOMATION_SEND_TARGETS`）。存的是 `target`，每次 run 被 daemon 领取（claim）时 server 读 KV `vh.main-agent.v1` 解析成当时的 `sessionId`，下发给 daemon 的是普通 `send`（旧 daemon 照常执行）；主 agent 换会话 / 新对话后自动化不用改。
- 指针指向别的机器：这次 run 和自动化的 `machineId` 一起改到那台机器（version +1），由那台 daemon 领取。没有主 agent（无指针、会话不属于本账号）：run 记 `failed`，`error = attention = main_agent_unavailable`，不下发。
- 入口：CLI `very-happy auto create --send-main-agent --prompt …`；MCP `automation_create` 的 `action: {kind:'send', target:'main-agent', prompt}`；Web 自动化表单「发送到 → 主 agent」。
- precheck 沿用 B-548：exit 0 才叫醒主 agent（stdout 追加进 prompt）；其它退出码记 `skipped`，0 token。`command[0] = 'very-happy'` 时 daemon 用自身 CLI 执行（不依赖 PATH）。

### 10.2 默认自动化

| 名称 | 触发 | precheck（`very-happy main-agent precheck <kind>`） | 主 agent 做什么 | 默认 |
|---|---|---|---|---|
| `main-agent-brief` | cron `0 9 * * *`，机器 / 浏览器时区 | 总是通过；输出快照：各团队在途 / 待验收、汇报板待 Owner 项、卡住的会话、24 小时内失败的自动化、可收尾会话 | 一张 `report` 卡（`notify:true`，推送一次） | 开 |
| `main-agent-stuck` | 每 60 分钟 | 找以 API Error 结束（B-913 `turnFailure`）或回合中 ≥3 小时无新消息、无后台任务的会话；**只有没报过的**才通过 | 每个会话一张 decision 卡（发「继续」/ 我自己看 / 不用管），Owner 选「继续」后才 `session_send` | 开 |
| `main-agent-wrapup` | cron `30 23 * * *` | 找闲置 ≥12 小时、非团队 bot、非主 agent、无待处理请求、还没上过收尾卡的会话；**只有没建议过的**才通过 | `wrapup_suggest` 发一张多选卡 | 开（只出卡） |

- 定义在 `happy-wire/src/mainAgentAutomations.ts`，CLI 和 Web 共用。「开」= 自动化存在且 active；「关」= pause（不删，run 记录保留）；不存在时打开 = 新建。
- daemon 在本机第一次启动主 agent 时装一次（`~/.happy/assistant/default-automations.json` 记标记）；Owner 之后删掉的不会自动重建，设置页「恢复默认自动化」可手动建回缺的那几条。CLI：`very-happy main-agent automations [list|install|on <kind>|off <kind>]`；Web：设置 → 主 agent。
- 「没报过」= 本机 `~/.happy/assistant/precheck-<kind>.json` 的已报键（7 天后忘掉）。precheck 通过后若主 agent 那一轮失败，这批要等 7 天或新变化才会再报（已知取舍）。

### 10.3 提醒收尾：多选决定卡

- decision 卡可带 `payload: {v:1, type:'select', items:[{id, label, detail?, ref?, checked}]}`（≤20 项）。Owner 在卡片 open 时用 `owner-respond {action:'check'}` 勾选，然后选「收尾所选」或「这次不用」；卡片关闭后不能再勾。
- `wrapup_selected(boardItemId)` 只在以下全部成立时执行：卡片是本会话发的、key 前缀 `main-agent-wrapup:`、带 select payload、`state=resolved` 且 `resolvedBy=owner`、`ownerChoice='wrapup'`；然后只对 `checked` 的项逐个调 B-919 的收尾后端（requestId = `<卡片>:<会话>`，重试不重复）。其它情况一律拒绝，不调用。
- 硬闸：自动化发起的回合（该回合的 prompt localId 全是 `automation-…`）里 `session_wrapup / session_handoff` 回 `owner_request_required`。Web 选项消息带 `wrapup_selected boardItemId=…`，主 agent 下一回合按它执行。
- 没有任何定时或自动路径会收尾会话（单测覆盖：8 条拒绝路径、只收尾勾选的 1 个、precheck / 扫描 / 默认自动化代码不引用收尾后端）。

### 10.4 推送与免打扰

- 汇报板 post 加可选 `notify`：只对 `report` 生效，且只有发卡会话是本账号主 agent（KV 指针）时生效 —— 早报因此推送一次；Lead 等其它会话的 `notify` 被忽略。
- 免打扰：`vh.main-agent-config.v1.quietHours {enabled,start,end,tz}`，读法与 B-922 相同（缺省 00:30–08:30 启用，`tz:null` = 机器本地时间）。server 不知道机器时区，所以 `tz` 为空时不判定；daemon 首次安装默认自动化时把机器时区写进去（已有时区就不动），设置页显示并可改时区（改时区同时改早报 / 收尾两条 cron 的 tz）。主 agent 发的卡在时段内照常上板、**不推送**，并占掉这张卡的推送名额（之后编辑不会在半夜补推）。其它会话的推送不受影响。

### 10.5 管理自动化的写入

- `automation_create / automation_update` 已过闸 2（§4.2，payload 取 `action.prompt`）。`pause / resume / run / fire` 不带新 prompt，按 B-922 的可配置闸接入（字段由 B-922 定）；本批不改 `gates/*`。

### 10.6 兼容与发布顺序（server → web → CLI）

| 组合 | 行为 |
|---|---|
| 旧 server + 新 CLI / Web | `target` 被 zod 剥掉后缺 `sessionId` → 创建 400；`notify`、select payload 被拒或忽略；`main-agent precheck` 照常 |
| 新 server + 旧 daemon | 收到的是已解析 `sessionId` 的普通 send，照常执行 |
| 新 server 回滚到旧 server | 存量 `target` 自动化下发时缺 `sessionId`，旧 daemon 报错失败（不会发错会话） |
| 旧 Web | 不认识 select payload：多选卡显示为普通 decision 卡（只能选项、不能勾），`wrapup_selected` 因无勾选而不收尾任何会话 |

