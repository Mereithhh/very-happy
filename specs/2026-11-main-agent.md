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
  "updatedAt": 1794334927713
}
```

- 写：Web 设置页（B-916a）。读：主 agent wrapper 启动时（B-916c），以及每次新开对话时。
- 本机补充文件 `~/.happy/assistant/config.json`，同一格式。两处**取并集**：`skillRoots` 去重合并，`deniedTools` 去重合并。没有任何一处能减少默认禁用表。
- 公开仓里的默认值是**空**：`skillRoots: []`，`deniedTools: []`。
- 不合法的项单独丢弃并在 wrapper 日志里记一行（不回显内容），其余照常生效。

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
| `session_wrapup` | `sessionId`、`templateId?` | `{ok, sessionId, state:'queued'\|'running'}` | — |
| `session_handoff` | `from`、`to?`（缺省 = 新会话）、`note?` | 400 | — |
| `session_restart` | `sessionId`、`when: 'idle'\|'now'` | `{ok, sessionId, scheduled, targetVersion?}` | — |
| `teams_list` | `cursor?` | 4K：id / 名称 / 项目 / Lead botId / 在途任务数 | — |
| `lead_delegate` | `teamId`、`goal`、`acceptance: string[]`（1–32）、`risk`、`requestId` | 400 | **是** |
| `lead_message` | `teamId`、`taskId`、`body`、`risk`、`requestId` | 400 | **是** |
| `automation_create` / `automation_update` | 现有参数 + `risk` | 400 | **是** |
| `session_message` | 现有参数 + `risk` | 400 | **是** |
| `dispatch_approved` | `approvalId` | 400 | —（§4.2 的执行入口） |

- `session_wrapup / session_handoff / session_restart` 对接 B-915、B-911；对方接口未合入时 B-916b 先放 mock（回执 `{ok:false, error:'not_available'}`），接口落地后只改适配层。
- **给团队派活**：主 agent 不属于任何团队，不用会话作用域的 `team_delegate / team_message`（它们在主 agent 会话里本来就没有团队可用）。改用 `teams_list` + `lead_delegate` / `lead_message`：走账号级 `POST /v1/teams/:id/actions`，以 **owner actor** 身份执行；`lead_delegate` 的 assignee 由工具层强制为该团队的 root bot（Lead），`lead_message` 的 recipient 同样强制为 Lead，主 agent 不能直接派给成员；动作元数据带 `via: 'main-agent'`。
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
- 生效表 = 内建禁用（B-063 的 5 个）∪ 默认表 ∪ KV `deniedTools` ∪ 本机 `config.json` `deniedTools`。只能加严。

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

1. 把调用（工具名 + 参数 + 最终等级）存到 `~/.happy/assistant/pending-dispatch/<approvalId>.json`（0600），`approvalId` 为随机 UUID，记录参数的 sha256。
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

**批准后执行**。用户在汇报板选择后，server 把选择写入卡片并给主 agent 会话发一条 board 消息（现有机制）。主 agent 调 `dispatch_approved({approvalId})`，工具层：

1. 读 pending 文件；不存在 → `{ok:false, error:'approval_not_found'}`。
2. 读卡片（`owner_board_list state=all`，按 key 找），要求 `resolvedBy='owner'`：
   - `ownerChoice='approve'` → 原样执行存下的调用，payload 前加一行 `本任务已获批：<链接>`；
   - `ownerChoice='draft'` → 同样执行，前缀改为 `本任务已获批，但只出草稿、不得发送或发布：<链接>`；
   - `ownerChoice='drop'` → 不执行，回执 `{ok:true, state:'dropped'}`；
   - 卡片仍 open → `{ok:false, error:'awaiting_decision'}`；其他（被 lead / 系统关闭）→ `{ok:false, error:'not_approved'}`。
3. 执行前重新算参数 sha256，与 pending 记录不一致 → 拒绝（防止批 A 派 B）。
4. 执行成功后 pending 文件改名为 `<approvalId>.done.json`；同一个 `approvalId` 再调 → 回执上一次结果，不重复派。

链接格式：`<webappUrl>/session/<主 agent sessionId>?panel=board`，后面跟 ` （决策 <boardItemId>）`。

**汇报板不可用时**（旧 server / 开关关闭）：非 `none` 一律拒绝执行，回执 `{ok:false, error:'board_unavailable'}`。不回退成直接执行。

### 4.3 已知漏口

- 被派会话如果是 `bypassPermissions`，它自己能不能对外发送 VH 管不住；闸 2 只保证「派之前用户看过」。被派会话的 PreToolUse 出站拦截放 P3。
- 关键词和 haiku 都可能漏判：用户的决策卡是最后一道人工关口，但前提是有一道判成非 `none`。
- 账号 token 在机器上，理论上能直接调 owner-respond；主 agent 没有 Bash，也没有任何工具暴露这个接口。

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

- 侧栏顶部固定「主 agent」入口（决策 A1 那一排），状态点：idle / 在想 / 离线。点开：桌面右侧抽屉，`pointer: coarse` 下全屏页。同一个会话，不是新会话。
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

- 不改 wire schema、不加 server 路由、不加迁移：KV 用现有 `/v1/kv`，汇报板用现有 `source='agent'`，派给 Lead 用现有账号级 `/v1/teams/:id/actions`。
- **一处 server 权限放宽**（B-916b）：主 agent 会话（以 KV `vh.main-agent.v1.sessionId` 判定）可在本账号任意项目以自己身份写 project note。旧 server 上该写入被拒，工具回执 `{ok:false, error:'project_not_member'}`，不回退成 Owner 身份。
- 发布顺序：Web 与 CLI 可独立发布；默认先 server/Web 后 CLI。

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
