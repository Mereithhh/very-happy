# very-happy 「工作流抽象层」现状：meta assistant / board / todos / notes / channels

> 只读取证，基线 `main@796565d5`（2026-09-03）。目的：给「chief-of-staff bot / 虚拟办公室角色 bot / 后续 harness」的第一性原理比较提供准确的现状底图。
> 结论先行，证据带路径。未核验的推断标 **[推断]**。

## 0. 结论

1. **今天的 meta assistant = 一台机器上常驻的一个普通 Claude Code session**（cwd `~/.happy/assistant`，metadata `variant:'assistant'`），外加 11 个只在该 variant 注册的 MCP 工具、一份 3.3KB 的 CLAUDE.md 人设，以及一个专用的全屏语音 UI（`/assistant`）。它不是 server 侧服务、没有事件循环、没有独立记忆系统——它「知道」的一切都来自它主动调用工具去查。
2. **硬证据表明它只在上线当天（2026-08-13）被用过**：`~/.claude/projects/-Users-jojo--happy-assistant/` 下 9 份 JSONL 全部落在 8-13；`~/.happy/assistant/memory/personal.md` 仍是 315 字节的种子模板（两段「（暂无）」），`memory/journal/` 目录为空；`~/.happy/sessions.json` 里 0 条 `variant:assistant`；8-24 起的 daemon 日志（`~/.happy/logs`，1318 个文件）里 0 条 assistant spawn / report 记录。
3. **不用的根因不是「做得粗」，而是结构性的**：（a）它的视野比侧栏窄（只看本机 daemon 登记过的会话、≤14 天、列表最近 15 条；看不到 board/todo/notes/notifications/其他机器）；（b）没有收件箱——唯一的主动通道 `[系统通报]` 仅覆盖它自己 spawn 的会话，且它的回复被 `isHiddenSession` 从通知 feed 里过滤，`/assistant` 页不开就等于没说；（c）记忆纪律「默认不写」导致零积累，「新对话」= 整个上下文丢弃；（d）派活原语弱（只能 directory+prompt 起 Claude，不能起 Codex、不能带权限模式/env/tag/board task）；（e）问一句要付一整个 Claude Code turn + REST 拉转写 + TTS 的延迟，而它能回答的「谁在等我」侧栏 attention/unread 与 board lifecycle 已经零延迟可视化；（f）入口是与主工作面割裂的 Siri 形态（AppLayout 的 sibling 路由，无侧栏、无看板、只显示最近一轮）。
4. **可复用的原语其实很多**：daemon spawn（agent/env/resume/fork/permissionMode/variant/spawnedBy）、`very-happy spawn/send` CLI、session REST 读写 + 本机 session key、account webhook 出站 + `/v1/webhook/notify`、`report_progress` 自报 → `metadata.board`、`metadata.summary/tags/capabilities/completedAt`、KV（board tasks / notes / terminal registry）、machine registry（`cliAvailability`、`daemonState.claudeAuth/webTerminals`）、通知 feed（4 种 notifType）、B-260 子代理生命周期 wire、`/btw` 旁路 query 三件套。
5. **缺的是「账号级」而非「机器级」的抽象**：没有给 agent 用的跨机器会话/机器/board 读取 API、没有 agent 侧事件订阅、没有会话 outcome 的结构化表示、没有角色/身份模型、没有调度（定时/触发器）、没有把 assistant 接到 board/todo/notes 的任何一根线。

---

## 1. Meta assistant：它到底能做什么

### 1.1 跑在哪、怎么起、怎么保活

| 事实 | 位置 |
|---|---|
| web `/assistant` 打开时 find-or-spawn：`machineSpawnNewSession({ variant:'assistant', directory:'~/.happy/assistant', approvedNewDirectoryCreation:true, agent:'claude', forceNew?, permissionMode? })` | `packages/happy-web-v2/src/screens/assistant/AssistantScreen.tsx:119-157` |
| 机器选择：settings `assistantMachineId` → 唯一在线机器 → 多台在线时让用户选 → 无在线则 gate；**单机绑定，Phase 1 明确不做多机编排** | `src/assistant/assistantSession.ts:pickAssistantMachine`；spec 非目标 |
| CLI 版本门 `ASSISTANT_MIN_CLI_VERSION='0.2.34'`（老 daemon 会把它当普通会话起在默认 cwd、无工具） | `src/assistant/assistantConstants.ts`、`assistantSupport.ts` |
| daemon 侧：cwd 强制 `~/.happy/assistant`，首次 bootstrap `CLAUDE.md` + `memory/personal.md` + `memory/journal/`（只写缺失文件，永不覆盖）；per-machine 单例（in-flight 锁 → 存活进程 → `sessions.json` 持久条目经 `HAPPY_RECONNECT_*` + `--resume <claudeSessionId>` 重连 → 全新 spawn）；`forceNew` = 停旧进程 + 清持久条目 + 新起 | `packages/happy-cli/src/daemon/run.ts:318-460`、`src/assistant/bootstrap.ts` |
| 环境注入：`HAPPY_SESSION_VARIANT=assistant` → `runClaude.ts` 打 `metadata.variant`、启用工具面、`withAssistantDenylist` 拒 `Bash/Edit/Write/MultiEdit/NotebookEdit`（sticky，per-message override 只能加不能减） | `src/claude/runClaude.ts:89-104,619,648,778`；`src/assistant/dispatcherTools.ts` |
| 「新对话」= `forceNew` spawn 后 archive 旧会话；**上下文整体丢弃**（只有 auto-compact 与手动 journal 能留东西） | `AssistantScreen.tsx:426-451` |
| 权限：synced 设置 `assistantSkipPermissions` 默认 **true** → 以 bypassPermissions（yolo）起；关掉才 `permissionMode:'default'`，此时权限请求只在 `/assistant` 显示一个 banner 跳转到 `/session/<id>` 去批 | `src/sync/settings.ts:45,196`；`AssistantScreen.tsx:186-191,632-644` |
| 模型：spawn 参数不带 `--model`，用本机 claude 默认 | `daemon/run.ts:436-456` |

### 1.2 System prompt / 人设：三层叠加

1. **`~/.happy/assistant/CLAUDE.md`**（模板 `packages/happy-cli/src/assistant/templates.ts`，中文，3.3KB）：
   - 身份「very-happy 的调度中心（语音助手）」，回复要短、口语化、无 markdown（为 TTS 服务）；多选题用 `<options>` 块（UI 渲染成按钮、不朗读）。
   - 「任务盘点」= `sessions_list` + `terminals_list` 都查。
   - `[系统通报]` 处理：先 `session_read` 核实，再口头汇报一句结论，合并多条。
   - 工作模式「派活不动手」：核心动作 `session_spawn`；硬约束无 Bash/Edit/Write；「如果用户给出了自己的 skills 目录可以读，**不要猜测个人目录**」。
   - 贵操作（kill/archive/terminal_send submit）先复述再等确认——**只靠 prompt，没有工具级二次确认**。
   - 记忆纪律「**默认不写**」，≤2000 字符，条目带日期；compact 前 `journal_append`。
2. **BASE_SYSTEM_PROMPT + AGENT_GUIDANCE**（所有 happy 托管会话共用，含「新聊天必须 `change_title`」「用 `copy_to_clipboard`/`open_preview`/`report_progress`」）——assistant 也是普通 runClaude 会话，一样被追加 | `src/claude/utils/systemPrompt.ts`、`agentGuidance.ts`。
3. **`settingSources: ['user','project','local']`** → Owner 的 `~/.claude/CLAUDE.md`（全局 14-root agent-system 规则）与 user skills 对它可见 | `src/claude/sdk/query.ts:57`。**[推断]** 这意味着它的「人设」实际是 very-happy 模板 + Owner 全局规则的混合，而 spec 设想的「personal.md symlink 到 agent-system context」从未落地（personal.md 仍是种子）。

### 1.3 工具面（11 个，全部本地执行、即返）

| 工具 | 做什么 | 视野/边界 | 延迟/超时 |
|---|---|---|---|
| `sessions_list` | daemon `/list` 存活子进程 + `~/.happy/sessions.json` 最近 **15** 条（过滤 terminal-mirror） | **仅本机**；sessions.json 只含本 daemon 起过的、≤14 天的会话；输出只有 id/title/cwd/agent/pid/url，**无状态（thinking/权限/board/progress）** | 本地 |
| `session_read(id, limit≤100)` | REST `GET /v3/sessions/:id/messages` + 本地 key 解密 → 角色化转写（user/assistant/[tool]/[service]/[turn status]），每行截 500 字、参数截 160 字、丢 thinking/tool-result | **只能读本机 daemon 登记过 key 的会话**（本机 web/CLI/终端起的都算，但 ≤14 天；**其他机器的会话读不了**，报「No local key」） | axios 15s |
| `session_send(id, text)` | `sendUserMessage()` 走服务器 outbox，即返不等回复 | 同上需 key | 即返 |
| `session_spawn(directory, prompt?)` | daemon `POST /spawn-session {directory, spawnedBy:'assistant'}`，可选等 key（15s）后发首条 prompt | **agent 固定 claude**；不能传 permissionMode/env/model/title/tags/resume/fork/parent；`~` 展开、必须绝对路径 | 等 key ≤15s |
| `session_kill` / `session_archive` | daemon stop（SIGTERM）/ REST archive | 破坏性，靠 prompt 口头确认 | 10s |
| `terminals_list` / `terminal_read(lines≤2000)` / `terminal_send(text, submit=false)` | `tmux list-sessions` 过滤 `vh-*` / `capture-pane` / bracketed paste（submit 才回车） | 本机 tmux | 3s |
| `memory_update(section, content)` | 替换/追加 `memory/personal.md` 的 `## section` | 软上限 2000 字符（只警告不拒绝） | 本地 |
| `journal_append(content)` | 追加 `memory/journal/YYYY-MM-DD.md` | 只追加 | 本地 |

保留的内置工具：Read/Grep/Glob、Web 工具、Task 子代理；拒绝 Bash/Edit/Write。
源码：`packages/happy-cli/src/assistant/assistantTools.ts`、`terminals.ts`、`transcript.ts`、`memory.ts`；注册点 `src/claude/utils/startHappyServer.ts:174-176`。

**它没有的工具**（对比它「调度中心」的定位）：机器列表、board tasks 读写、todo provider、notes、通知 feed、git/diff/PR 状态、`report_progress` 的读取、跨机器 spawn、起 Codex/Gemini/ACP、定时/延后。

### 1.4 它看到什么上下文

- 启动时：CLAUDE.md + Owner 全局 CLAUDE.md + `memory/`（需自己 Read/Grep）。**没有任何自动注入的当前状态**（不带「现在有 N 个会话在跑、M 个在等你」）。
- 运行中：只有它主动 `sessions_list`/`terminals_list`/`session_read` 拉到的东西；以及 daemon 推来的 `[系统通报]`。
- 它看不到 web 端 store 里的任何派生信息：board lifecycle（running/waiting/done）、attention/unread、`metadata.board.progress`、`metadata.summary` 以外的 title、tags、机器在线状态、其他机器的会话。

### 1.5 结果怎么回来

1. **对话回复**：普通 session 消息 → web `useSessionMessages` → `deriveAssistantExchange` 只取**最新一轮**（user 一行 + assistant 一段 + 最新一个工具 ticker）→ TTS 朗读（≤2000 字、句边界截断）。完整历史要开「文字记录」侧栏或直接进 `/session/<id>`（会话在所有列表里隐藏，只留直达 URL 审计）| `src/assistant/assistantView.ts`、`AssistantScreen.tsx:176-213`。
2. **主动汇报 `[系统通报]`（B-069）**：被 spawn 的会话进程在 turn-end 且 idle、无待批权限、非用户接管时 POST daemon `/session-event`；daemon 用纯函数 `decideAssistantReport` 决定是否向助手会话发一条 user 消息 `[系统通报] 会话「title」已完成/等待输入（id）。请用 session_read 核实……` | `src/claude/session.ts:178-227`、`src/daemon/assistantReport.ts`、`run.ts:1282-1350`。门槛：
   - 只对 `spawnedBy==='assistant'`（即经 `session_spawn` 起的）的会话；**用户自己开的会话、web/CLI 起的会话、终端 needs_input 一律不通报**；
   - 本机必须有存活的助手进程且 sessions.json 里有它的 key，否则静默跳过；
   - 每会话 5 分钟冷却；
   - 助手收到后要再跑一整个 turn（`session_read` + 组织一句话）。
3. **通知面**：助手会话被 `isHiddenSession` 过滤——`useNotificationFeed.ts:96`、`sync.ts:3001` 都跳过它 → **它的回复/汇报不进铃铛、不发系统通知、不进 next-session 轮转**。`/assistant` 不在前台就听不到任何东西。
4. **webhook**：助手派出的会话与普通会话一样触发账号 webhook（completed/permission），带 `session: <id>` trailer；助手自身不参与。

### 1.6 延迟（结构性，仓库内无实测数字）

按住说话 → ElevenLabs STT（可流式部分转写）→ `sync.sendMessage` → 助手 Claude turn（模型 + 至少一次工具：`sessions_list` 本地 / `session_read` REST 15s 上限 + 解密）→ 文本 → ElevenLabs TTS（flash，流式或整段）。每个问题都是一整个 Claude Code turn；每条 `[系统通报]` 又是一个 turn。verify-queue V-033 的验收口径是「任务完成后 ≤1min 助手开口」、V-032 是「长回复 <1s 出声」——都还在待验证队列，未清账。

### 1.7 入口与形态

- 侧栏 header 的 AudioLines 按钮、⌘K「切换到语音助手」、直达 `/assistant` | `Sidebar.tsx:837-845`、`CommandPalette.tsx:264-270`、`AppRoot.tsx:205-207`。
- 路由是 AppLayout 的 **sibling**（无侧栏、无看板、无会话列表），设计目标是「移动端 Siri 形态」；桌面同布局居中限宽 | spec §3。
- 页面只显示最近一轮 + 工具 ticker + `<options>` 按钮；文字输入是兜底。

### 1.8 使用证据（mac-office，只读）

| 证据 | 观察 |
|---|---|
| `~/.happy/assistant/CLAUDE.md` | 3346 B，mtime 2026-08-13 15:03（模板版本） |
| `~/.happy/assistant/memory/personal.md` | 315 B，mtime 2026-08-13 11:53，内容 = 种子模板（两段「（暂无）」） |
| `~/.happy/assistant/memory/journal/` | 空目录 |
| `~/.claude/projects/-Users-jojo--happy-assistant/*.jsonl` | 9 份，全部 2026-08-13（11:53–20:15），最大 127KB |
| `~/.happy/sessions.json` | 0 条 `"variant":"assistant"`（14 天清理已过） |
| `~/.happy/logs/`（2026-08-24 起，1318 文件） | 0 条 `variant=assistant` / `Assistant report sent` / `Re-attaching assistant` |
| `docs/verify-queue.md` | V-022~026、V-032~034、V-040 的助手真机项自 8-13/8-14 起一直未清 |
| `docs/backlog.md` | B-051 done；B-057 里攒着 B-051 的 cleanup 债；此后无任何助手相关 feat/bug 条目 |

---

## 2. 其余工作流原语：board / todos / notes / channels / 通知 / 侧栏

### 2.1 Task Board（`/board`，spec `2026-08-task-board.md`、`2026-08-board-task-lifecycle.md`，Shipped）

- **统一状态模型** `buildBoardItems`：chat session + 终端 → 四态（attention/working/idle/ended）作角标；默认视图是**生命周期三列**：进行中 / 等我看（permission > review > blocked > needsInput > idle「跑完待收」> ended > machineOffline）/ 已完成（24h 窗）。Owner 管理哲学：「以任务是否完成做管理，不以 claude 状态做管理；claude 跑完 ≠ 完成，完成必须是人点 ✓」。
- **✓ 一键完成**：写 `metadata.completedAt` → kill-first archive → `POST /v1/webhook/notify` 发 `✅ 已完成 · <名>`（`rowActions.ts`）。
- **老板任务列表**：KV `vh.board-tasks.v1`（明文 base64 JSON，daemon 可读）+ 泳道分组 + Dispatch（`machineSpawnNewSession` 预填 description，spawn 后把 sessionId 写进任务映射）| `src/sync/boardTasks.ts`、`boardTaskOps.ts`。
- **进度信息两条来源**：① 会话自报 `report_progress(progress, attention)` → `metadata.board`（30s 节流、15min 新鲜期）| `agentGuidance.ts`、`boardReport.ts`；② 兜底 `boardAnalyzer`（daemon 起 `claude -p --model haiku`，5min/会话、30 次/小时/机器，机器本地 `boardLlm` 开关）。
- 侧栏「状态」视图和 attention 角标**直接消费 board 的 lifecycle 判定**，两处永不打架 | `sidebarStatusView.ts`、`sidebarAttention.ts`。
- 与助手**零接线**：助手无 board 工具；Dispatch 走 web，不经助手；`spawnedBy:'assistant'` 不写进 task 映射。

### 2.2 Todos（`/todos`，spec `2026-08-todo-provider.md`）

- 通用 provider 契约：机器本地 `~/.happy/settings.json` 配一条命令，`list|complete <id>|create <title>` argv 子命令、stdout JSON；三个机器 RPC `todo-list/complete/create`；**不落 server、不缓存、不轮询、不与 board 合并**。Owner 的 dida/tanka provider 在私有 skills repo。
- 对 agent 不可见：没有 MCP 工具读它；助手不知道它存在。

### 2.3 Notes（`/notes` + 右侧 dock，spec `2026-08-prompt-notes.md`）

- 定位「等 AI 干活时写下一步 prompt」：账号 KV `vh.note.v1.<id>`（≤32KB 纯文本，LWW），可绑定 session/终端，一键插入输入框（聊天 insertPreset / 终端 bracketed paste 不回车），跨端实时推送。
- 同样对 agent 不可见。

### 2.4 Channels（`docs/channels.md`、spec `2026-08-tanka-channel.md`，Shipped）

- **出站**：账号 webhook（一账号一 URL，events `completed|permission`；`⏸ 需要确认`/`❓ 等待回答`/`✅ 任务完成`；末行 `session: <id>` 稳定契约；`HAPPY_WEB_URL` 可加链接行；5s 超时不重试）。终端 agent-state 转换也走它（`/v1/webhook/notify` + `event`）。web 的 ✓ 也走 `/v1/webhook/notify`（手动通知不受 events 过滤，带 `task: <id>`）。
- **入站**：`very-happy spawn --dir --prompt[-file] --json`（daemon 本地控制口；exit 0/1/2）、`very-happy send --session --prompt[-file]`（不需要 daemon 活着，直接 REST outbox，但需本机 key）。
- **MCP**：托管 Claude 会话 `change_title/copy_to_clipboard/open_preview/report_progress`；Codex/Gemini/ACP bridge 少 `report_progress`；assistant variant 加 11 个；裸 `very-happy mcp` 只有 clipboard。
- 明确的非目标：「Routing chat through the in-product Claude coordinator. These are separate extension paths today.」——即 IM 通道与助手是两条互不相通的路。

### 2.5 通知收件箱（`screens/notifications/useInbox.ts`）

两条 lane 合并：daemon 产出的加密 feed（`permission_request|reply_done|input_needed|error`，`notificationProducer.ts`）+ 本地 board 生命周期转换；跨设备已读水位（KV）。**面向人，不面向 agent**；hidden session（assistant、mirror）被过滤。

### 2.6 侧栏分组与信号（`screens/sessions/sidebar*.ts`，spec `2026-08-workspace-context.md`）

- 三种镜头：workspace（key = `machineId + 标准化 path`，聊天与终端同组，组头可直达 Changes 面板）/ tag（首 tag，priority tag 置顶）/ 不分组；状态视图 = board lifecycle 的 running/waiting/已完成(今日)。
- 行信号两级：attention（accent，= board urgent band：permission/needsInput/review/blocked）> unread（跑完没看）。
- 机器是 row 的属性（`machineName · terminal` 副标题），不是一级对象；机器页 `/machine/:id` 另有（daemon 状态、Claude 登录状态、终端列表）。

### 2.7 `/btw` 侧问（spec `2026-09-btw-side-question.md`）与子代理生命周期（`2026-09-subagent-lifecycle.md`）

- `/btw`：wrapper 内 fork 主会话（`resume + forkSession + persistSession:false + tools:[] + maxTurns:1`），即返 id + 轮询；只对当前会话，不跨会话。
- B-260：`task_started/progress/notification` 上 wire（`agent{t:'start'|'progress'|'stop'}` 带 status/usage/result ≤16KB）——这是仓库里唯一一处「结构化的子任务结果」表示，但只限 Claude 内置 Agent 工具，不覆盖 happy session 级别。

---

## 3. 为什么不用：逐条归因 + 证据

| # | 痛点 | 证据 |
|---|---|---|
| P1 | **视野比侧栏窄**：只看本机 daemon 登记过的会话（≤14 天，列表只取最近 15 条）；不知道 board、todo、notes、通知、其他机器、会话实时状态（thinking/权限/progress）。问它「现在有哪些任务」得到的比侧栏一眼看到的少 | `assistantTools.ts:179-210`（`slice(0,15)`、`readPersistedSessions`）；`persistence.ts:496`（14 天）；`session_read` 的「No local key」分支 `:225-227`；工具列表无 board/todo/machine |
| P2 | **没有收件箱、几乎没有主动性**：唯一主动通道 `[系统通报]` 只覆盖它自己 `session_spawn` 的会话（`spawnedBy==='assistant'`），且要求助手进程活着、5 分钟冷却；用户/web/CLI 起的会话完成、权限请求、终端 needs_input、webhook 事件全都不到它这 | `assistantReport.ts:57-70`；`session.ts:222-227`（无 `HAPPY_SPAWNED_BY` 就不 POST） |
| P3 | **它说的话没人听得到**：助手会话是 hidden session，feed 通知与系统通知都跳过它；`/assistant` 不在前台 = 汇报落空 | `useNotificationFeed.ts:96`、`sync.ts:3001`、`assistantSession.ts:isHiddenSession` |
| P4 | **零记忆积累**：纪律「默认不写」+ 2000 字上限 + 无自动沉淀；实际 personal.md 是种子、journal 为空；「新对话」整体丢上下文 | §1.8 文件证据；`templates.ts:69-77`；`AssistantScreen.tsx:426-451` |
| P5 | **派活原语弱**：`session_spawn` 只有 `directory + prompt`；agent 固定 claude，不能起 Codex/Gemini/ACP；不能指定 permissionMode/model/env/title/tags/resume/fork；不与 board task 关联。而 web 的 spawn RPC 已支持 `agent/environmentVariables/resumeClaudeSessionId/resumeCodexThreadId/parentSessionId/forkedFromMessageId/variant/forceNew/permissionMode` | `controlClient.ts:113-124` vs `apiMachine.ts:343-352` |
| P6 | **看不到「结果」**：`session_read` 是截断转写（500 字/行、丢 tool-result），没有 diff/commit/测试/PR/`report_progress`/`completedAt` 的概念；助手只能复述最后几句 | `transcript.ts:732-733,760-837` |
| P7 | **交互形态与工作面割裂**：全屏语音台是 AppLayout 的 sibling，无侧栏/看板；只显示最近一轮；桌面主场景（侧栏 + 会话 + board）里没有助手的位置；与 `/btw`、notes、board dispatch 互不相通 | `AppRoot.tsx:205-207`；`AssistantScreen.tsx:1-10,176-184`；channels.md 非目标 |
| P8 | **延迟劣于直接看 UI**：每问一句 = 一整个 Claude turn + 工具 + TTS；主动汇报再一个 turn；而侧栏 attention/unread、board lifecycle 是 socket push 零延迟。V-032/033 延迟验收至今未清 | §1.6；`docs/verify-queue.md` V-032/033 |
| P9 | **高权限面默认 yolo、只靠口头确认**：kill/archive/terminal_send(submit) 的确认在 prompt 里；channels.md 自己也标注「treat that variant … as a high-privilege machine control surface」；且会话从列表隐藏，审计只能靠记住 `/session/<id>` | `settings.ts:196`；`templates.ts:64-67`；`docs/channels.md` MCP 矩阵 |
| P10 | **单机、单例、单 Claude**：绑定一台机器（多台需手选），不知道其他机器存在；Phase 1 非目标里明写「不做多机器编排」 | `pickAssistantMachine`；spec 非目标 |
| P11 | **身份未接入 Owner 的 agent-system**：spec 设想 personal.md symlink 到 agent-system context，未做；CLAUDE.md 反而要求「不要猜测个人目录」；实际人设 = 模板 + 全局 CLAUDE.md 的偶然叠加 | `templates.ts:59-60`；`query.ts:57`；§1.8 |
| P12 | **没有工作流状态机可依附**：task → session → outcome → done 的链条由人在 board 上手工维护；助手不能读写 board tasks（KV 明文 daemon 可读，但没工具），也不产出任何可被 board 消费的结构化事实 | `boardTasks.ts` 头注释；工具列表 |
| P13 | **语音优先假设与实际使用场景不符 [推断]**：Owner 的主场景是桌面多会话并行 + 手机看通知；按住说话在这两处都不是最省力的输入；模板刻意禁 markdown/列表也让文字模式的回答质量下降 | spec 背景「移动端体验优先」；`templates.ts:20-22` |

一句话：**它是一个「会用 tmux 和 REST 的 Claude」，不是一个「知道我在做什么」的秘书**。信息流是拉不是推，记忆是空的，出口是聋的，入口是偏的。

---

## 4. 可以直接复用的原语（chief-of-staff / 角色 bot 可站在上面）

### 4.1 执行与派活
- **daemon spawn**（machine RPC `spawn-happy-session` / 本地 `POST /spawn-session`）：`directory, agent(claude|codex|gemini|…), environmentVariables, permissionMode, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId, variant, forceNew, spawnedBy` | `apiMachine.ts:343`、`daemon/controlServer.ts:195-240`、`daemon/run.ts:spawnSessionImpl`。`variant` 是自由字符串（schema 注释：future variants pass through）——**角色 bot 可以直接用 `variant:'role:<name>'` 之类打标**，web 侧只需扩 `isHiddenSession`/分组。
- **`HAPPY_SPAWNED_BY` + `/session-event`**：已有「被派会话 → 回报 daemon → 转发给某个会话」的骨架（`assistantReport.ts` 纯函数 + `run.ts` sink），把 `spawnedBy` 泛化成「回报目标 session id」即可让任意 bot 收到它派出去的会话的完成/需输入事件。
- **CLI `very-happy spawn/send`**（`commands/spawn.ts`、`send.ts`）：脚本/定时器/IM 适配器可用；`send` 不依赖 daemon 存活。
- **session 单写者锁**（`utils/sessionLock.ts`）、respawn/resume（`specs/2026-09-session-respawn.md`）——bot 重启会话有安全路径。
- **`/btw` 三件套**（`sideQuestion.ts`：`resume+forkSession+persistSession:false`, `disableAllHooks`, `claudeEnvVars`）——「对某个会话问一句而不打扰它」已可复用于「秘书替我问进度」。

### 4.2 读取与观察
- **REST** `GET /v3/sessions/:id/messages`（before/after_seq 分页）+ 本机 key 解密（`sessionMessage.ts`、`transcript.ts` 的角色化转写）。限制：key 在 `sessions.json`（本机、14 天）。
- **session metadata**（`storageTypes.ts:MetadataSchema`）：`summary.text`（LLM 标题）、`name`、`path/machineId/host`、`flavor`、`variant`、`capabilities[]`、`permissionMode`、`tags[]`、`board{taskId,attention,progress,analyzedAt}`、`completedAt`、`parentSessionId`、`lifecycleState`、`archivedBy/archiveReason`、`claudeSessionId/codexThreadId`。这是最接近「会话事实表」的东西，随 sessions push 全端同步。
- **agentState**：`requests{tool,arguments,kind,createdAt}`、`completedRequests{status,mode}`、`controlledByUser`——「谁在等我批什么」的权威源。
- **machine registry**：`MachineMetadata{host,platform,happyCliVersion,cliAvailability{claude,codex,gemini,openclaw},resumeSupport}` + `daemonState{claudeAuth,webTerminals[]{id,title,cwd,agentState}}`。
- **tmux 观测**：`terminals.ts` 的 list/capture/paste；终端 agentState 四态推送；B-105 terminal-mirror 影子会话（手敲 claude 也有结构化转写）。
- **B-260 子代理 wire**：`agent{start|progress|stop}` 带 description/toolUses/lastTool/tokens/duration/status/result——结构化「子任务结果」的现成 schema，可作为 session 级 outcome 的原型。
- **`report_progress`** → `metadata.board`：agent 自报的 progress/attention 已是「让别人知道我在干嘛」的契约；只缺读取方。

### 4.3 状态与记忆
- **账号 KV**（`kvRoutes.ts`、`apiKv.ts`）：prefix list、bulk、CAS mutate、tombstone、`kv-batch-update` 广播；已承载 board tasks（`vh.board-tasks.v1`）、notes（`vh.note.v1.*`）、seen 水位。**server-trusted 明文 → daemon/bot 可读写**（boardAnalyzer 先例）。
- **board lifecycle 纯函数**（`boardItems.ts:lifecycleOf/buildLifecycleColumns/buildCompletedEntries`）：「等我看」的判定已是纯函数，可原样搬到 bot 侧做「今日站会」。
- **机器本地 settings**（`~/.happy/settings.json`：`boardLlm`、`todoProvider`）：bot 的高权限配置放这的先例与理由（web 不可写）。
- assistant home 的 `memory/` + `journal/` 文件形态与 `memory_update` 的段落式编辑（`memory.ts` 纯函数）。

### 4.4 通知与外联
- **feed**（`/v1/feed`，账号公钥加密，4 种 notifType）+ web 收件箱（两 lane 合并、跨设备已读）。
- **webhook 出站** + `/v1/webhook/notify`（manual/automatic、`session:`/`task:` trailer、`link`）。
- **IM 适配器模式**（channels.md 伪代码）：`[happy] task` → spawn；引用回复 → send。
- **LLM 旁路先例**：`claude -p --model haiku` 一次性子进程（`titleGenerator.ts`、`boardAnalyzer.ts`，30s、限频、失败吞掉）——bot 的廉价「判断」原语。

---

## 5. 缺什么（要做 chief-of-staff / 角色 bot 必须补的）

1. **账号级、面向 agent 的读取面**：现在 agent 只能读「本机有 key 的会话」。缺一个 bot 可调用的「列出全账号会话/机器/board/待批权限，并按 lifecycle 归类」的 API（web store 有这一切，但 agent 拿不到；server 侧则因 e2e 加密看不到 metadata 明文——本 fork 已声明 server 可信，这是可以打开的口子）。
2. **事件订阅（推）而非轮询（拉）**：bot 需要「会话完成 / 权限请求 / 终端 needs_input / 用户点 ✓ / webhook 事件 / 定时」的订阅；现有 `/session-event` 只覆盖 `spawnedBy` 一种关系，feed/webhook 面向人。
3. **会话 outcome 的结构化表示**：完成时的一段摘要 + 改动文件/commit/PR/测试结果 + 是否需要人。今天只有 `summary.text`（标题）、`board.progress`（一行）、`completedAt`（人点的）；B-260 的 `stop{status,result,usage}` 是最接近的形状，但只在子代理层。
4. **bot 的出口**：bot 说的话要能进收件箱/系统通知/webhook/IM，并能被「回复」路由回 bot（现在 hidden session 被所有出口过滤；IM 通道与 coordinator 是明确分开的两条路）。
5. **身份/角色模型**：`variant` 只是字符串，没有「角色 → 家目录/CLAUDE.md/工具面/权限/所属机器/回报对象」的登记表；没有多 bot 之间的关系（谁向谁汇报）。
6. **持久记忆与工作日志的自动沉淀**：现在靠 prompt 纪律「默认不写」；缺「每次派活/收货自动写一条」的机械化记录（board tasks KV 可以当这个账本，但没接）。
7. **调度**：无定时/延后/条件触发（roadmap「scheduled work and repeatable pipelines」仍在 idea 层）。
8. **跨机器路由**：spawn 只能指定机器 id；无「按 cliAvailability/负载/目录存在性选机器」的逻辑；助手只绑一台。
9. **审计与安全面**：高权限 bot 的操作记录（kill/archive/send 了什么）没有独立日志；yolo 默认；被隐藏的会话反而更难审计。
10. **与 board/todo/notes 的接线**：三者都是人手工面板，agent 一个都读不到；「Dispatch」在 board、「派活」在助手、「[happy] 指令」在 IM，三条路各自为政。
11. **UI 位置**：如果 bot 是「同事」，它需要出现在侧栏/看板/会话页里（有头像、有状态、可 @），而不是一个单独的语音台。

---

## 附：关键文件索引

- Web：`packages/happy-web-v2/src/screens/assistant/AssistantScreen.tsx`、`src/assistant/{assistantSession,assistantView,assistantConstants,assistantSupport}.ts`、`src/app/AppRoot.tsx:205`、`src/screens/sessions/{Sidebar.tsx,sidebarRows.ts,sidebarAttention.ts,sidebarStatusView.ts,sidebarWorkspaceGroups.ts,sidebarTagGroups.ts}`、`src/screens/board/boardItems.ts`、`src/sync/{boardTasks,boardTaskOps,storageTypes,useNotificationFeed}.ts`、`src/screens/notifications/useInbox.ts`
- CLI：`packages/happy-cli/src/assistant/{assistantTools,dispatcherTools,templates,bootstrap,memory,terminals,transcript,spawnDirectory,ids}.ts`、`src/daemon/{run.ts,assistantReport.ts,assistantSpawn.ts,controlServer.ts,controlClient.ts}`、`src/claude/{runClaude.ts,session.ts,sideQuestion.ts,notificationProducer.ts}`、`src/claude/utils/{startHappyServer,systemPrompt,agentGuidance,boardAnalyzer,boardReport}.ts`、`src/commands/{spawn,send,sessionMessage,mcp}.ts`
- Specs/docs：`specs/2026-08-voice-assistant.md`、`2026-08-agent-guidance.md`、`2026-08-task-board.md`、`2026-08-board-task-lifecycle.md`、`2026-08-todo-provider.md`、`2026-08-prompt-notes.md`、`2026-08-tanka-channel.md`、`2026-08-workspace-context.md`、`2026-09-btw-side-question.md`、`2026-09-subagent-lifecycle.md`、`docs/channels.md`、`docs/roadmap.md`（「Long-term concept: the virtual office」）
- 使用证据：`~/.happy/assistant/`、`~/.claude/projects/-Users-jojo--happy-assistant/`、`~/.happy/logs/`、`docs/verify-queue.md` V-022~026/V-032~034/V-040
