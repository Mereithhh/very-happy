# `/btw` 侧问（side question）：不打断主对话的旁路问答

> 状态：Shipped（commit `9d3a101f`，PR #143，2026-09-02 合入 main；web `main@892be05e` + CLI v0.2.100 已于 2026-09-02 发布）；2026-09-22 B-480 修订提示词形状与并发语义（见「B-480 修订」），CLI v0.2.146 发布（v0.2.145 因 npm 平台包 staged 作废）；B-482 改走进程内 `side_question` 控制请求（已合入，待发布）；2026-11-02 B-861 加 Codex、刷新保留、运行中入口、转成分叉会话（见文末「B-861 修订」）
> 日期：2026-09-02 ｜ 关联 backlog：B-283 ｜ 出处：Owner 2026-09-02「给 claude code sdk session 支持类似 btw 命令的能力」

## 背景

Claude Code CLI 2.1.x 自带 `/btw <question>`：在主任务跑着的时候问一个旁路小问题，
答案显示在侧面板、**不进主对话上下文**、**不能用工具**、单轮直接作答（二进制字符串
`Use /btw to ask a quick side question without interrupting Claude's current work` /
`Side questions cannot use tools` / `maxTurns:1, skipTranscript`）。SDK/remote 路径没有这个
能力（CLI 自己都提示 `This remote connection doesn't support side questions`）。
web 用户在等 agent 干活时想顺口问一句「这个报错啥意思」只能开新会话或打断当前 turn。

## 目标

1. 结构化会话（Claude flavor）里输入 `/btw` 或 `/btw 问题` → 打开右侧「侧问」面板；面板里可以连续问答。
2. 会话头部有一个按钮，点一下即开面板。
3. 侧问在 CLI wrapper 里用**独立的 SDK `query()`** 回答：fork 主 Claude 会话拿到完整上下文，
   但不写主会话 transcript、不出现在主对话消息流、禁用全部工具、单轮。
4. 主 turn 正在跑时也能问（并发第二个 claude 子进程），互不干扰。
5. 旧 CLI（无 capability）打开面板时明确提示需升级，`/btw` 文本绝不发到主对话。

## 非目标

- 不做 token 级推送流式（server/relay 无通用 session→user 推送通道；本版用轮询取渐进文本）。
- ~~不持久化侧问历史~~（B-861 起同一浏览器内刷新保留，跨设备仍不同步）。
- 不支持 gemini/acp/pi/mirror 会话（B-861 起支持 Codex）。
- 不给侧问开工具或 MCP。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| remote 路径 `query()` 适配层；`QueryOptions` 缺 `forkSession/tools/persistSession/includePartialMessages` | `packages/happy-cli/src/claude/sdk/query.ts:15-125`、`sdk/types.ts:36-67` |
| SDK `tools: []` 关闭全部内置工具；`forkSession` 配 `resume` 派生新 session id；`persistSession:false` 不落盘 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1457,1526,1612` |
| 当前 Claude session id：`Session.sessionId`（`onSessionFound` 同步写 `metadata.claudeSessionId`） | `packages/happy-cli/src/claude/session.ts:34,256-270` |
| 会话级 RPC 纯请求/响应、无流；server 与 relay 两端 RPC 超时都是 **30s** | `api/rpc/RpcHandlerManager.ts:60-92`；`happy-server/sources/app/api/socket/rpcHandler.ts:18`、`relay.ts:10` |
| capability 唯一写点 | `packages/happy-cli/src/claude/runClaude.ts:184` |
| `currentModel` 等 per-process 模式状态 | `runClaude.ts:610-620` |
| web 会话面板由 URL `?panel=` 驱动，右侧 `<aside class="sd-files">` 已有拖宽/窄屏遮罩 | `happy-web-v2/src/screens/session/sessionPanelState.ts`、`SessionDetailScreen.tsx:31-36,119-139`、`session.css:54-95` |
| 斜杠命令只做补全，`doSend` 无本地拦截，文本原样发给 CLI | `AgentInput.tsx:318-`、`slashSuggestions.ts`、`sync/suggestionCommandItems.ts` |
| web 侧 `sessionRPC` 默认超时 300s，但受 server 30s 限制 | `sync/apiSocket.ts:236,241` |

## 设计

### CLI（wrapper 进程内）

- 新模块 `claude/sideQuestion.ts`：
  - `buildSideQuestionPrompt(question, history)` 纯函数：把此前侧问问答按
    `Earlier side questions` 段落拼进 prompt（Claude CLI 的 `btwHistory` 等价物由 web 持有、随请求带来）。
  - `SIDE_QUESTION_REMINDER`：Claude Code 2.1.x `/btw` 的原话 `<system-reminder>`，放在**用户消息里、紧贴问题**（B-480 前只有 `appendSystemPrompt` 一句，压不住上下文，见下）；`SIDE_QUESTION_SYSTEM_PROMPT` 只剩一句 system 尾注。
  - `runSideQuestion({ query, question, history, resumeSessionId, cwd, model, signal, onText })`：
    `query()` 选项 = `{ cwd, resume, forkSession: true, persistSession: false, tools: [], mcpServers: {}, strictMcpConfig: true, maxTurns: 1, includePartialMessages: true, permissionMode: 'default', canCallTool: deny, appendSystemPrompt }`；
    从 `stream_event` 的 `text_delta` 累积渐进文本，`assistant` 文本块为最终答案，`result.subtype!=='success'` 抛错。
    `resumeSessionId` 为空（主会话还没跑过第一轮）时不 resume、无上下文直接答。
- 新模块 `claude/registerSideQuestionHandler.ts`（纯注册函数，deps 注入，可单测）：
  - RPC `btw-ask {question, history?}` → 立即返回 `{ requestId }`，后台跑 `runSideQuestion`；同一会话同一时刻只有一个在跑——**新的 ask 取代（abort）在跑的那条**（B-480 前是 `throw 'already running'`）。
  - RPC `btw-poll {requestId}` → `{ status: 'running'|'done'|'error'|'cancelled', text, error?, startedAt, finishedAt? }`（渐进 text）。
  - RPC `btw-cancel {requestId}` → abort。
  - 已完成结果保留 5 分钟后丢弃（web 拿到 done 就本地持有）。
- `runClaude.ts:184` capability 追加 `'claude-btw-v1'`；注册点放在 `currentModel` 声明之后，deps：
  `getClaudeSessionId`（**只认 live `currentSession.sessionId`**，且经 `claudeCheckSession` 确认 transcript 已落盘，否则无上下文作答——server metadata 里的 `claudeSessionId` 在 `/clear` 后是旧的，不能用）、`getModel: () => currentModel`、`cwd`、`getEnv: () => options.claudeEnvVars`（`--claude-env` 的 provider/凭据在 local 模式只进主 Claude 的 spawn env，fork 必须显式带上）、`settingsPath`（`{"disableAllHooks":true}` 的临时 settings：Claude CLI 自己的 `/btw` 在进程内跑不触发 hook，我们的 fork 是新进程，否则每次侧问都会放一遍用户的 SessionStart/Stop/SessionEnd hook）。
- 兜底：CLI 侧每个侧问 10 分钟 wall-clock 上限（web 断连不发 cancel 时自动释放 slot）；web 侧 poll 连续 5 次失败或 ask 往返期间被取消，都会补发 `btw-cancel`。
- RPC 错误语义：handler 抛错 ≠ RPC reject，`RpcHandlerManager` 以正常 ack 回 `{error}`——web 三个 wrapper 必须检查 `error` 字段并抛出（ops.ts 兄弟 wrapper 同款），否则 store 会把它当成功载荷。
- `sdk/types.ts` + `sdk/query.ts`：`QueryOptions` 增 `forkSession/tools/persistSession/includePartialMessages`，一一透传。

### Web

- `sessionPanelState.ts`：`SessionPanelTab` 增 `'btw'`（`?panel=btw`）。`SessionDetailScreen` 里 `panelTab==='btw'` 时右侧 aside 渲染 `BtwPanel`（复用 `.sd-files` 几何、拖宽、窄屏遮罩），否则 `FilesPanel`；files 按钮的 active 态只认 files 三个 tab。
- `ChatHeader`：files 按钮左侧新增「侧问」图标按钮（`MessageCircleQuestion`），非 mirror 时显示；`aria-pressed` = 面板开。
- `AgentInput`：`routeBtw(text)` 在 **doSend 与 sendQueuedItem 两个出口**都拦截（排队释放/编辑排队项/插队/持久化队列重载都经 `sendQueuedItem`），只对 `canOfferBtw`（Claude flavor）会话生效，codex/gemini 原样发送；通过 `openBtwPanel(sessionId, question?)`（window 事件 `vh:btw-open`）打开面板，面板已开时 `replace` 而不是 push history；有问题且 wrapper 支持、无进行中侧问 → 直接发问，否则停进面板 draft 不丢字。Claude flavor 的斜杠补全列表前置 `btw` 项，CLI 自带的 builtin `btw` 进 `IGNORED_COMMANDS` 防重复行。
- `?panel=btw` 只在 `btwAllowed`（非 mirror + Claude flavor）时挂载面板，其他会话上的该 URL 视为无面板。
- `sync/btwStore.ts`（zustand，内存）：按 sessionId 存 `exchanges[]`、`pending`、`draft`；`ask()` 调 `ops.sessionBtwAsk` 后每 1s `sessionBtwPoll` 直到终态；`cancel()`。面板关闭不打断轮询（Claude CLI 的「panel torn down; question handed on」语义）。
- `ops.ts`：`sessionBtwAsk/Poll/Cancel` 三个 typed wrapper。
- 无 capability（`metadata.capabilities` 不含 `claude-btw-v1`）：面板可开、输入禁用、显示「当前会话的 CLI 不支持侧问，升级后新建会话」。
- 渲染：问题为用户气泡（mono 时间戳），答案 `Markdown` + `MarkdownPathProvider`；运行中 `StatusDot thinking pulse` + 秒表；Enter 发送、Shift+Enter 换行。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 CLI 会话 | 无 capability → 面板提示升级；`/btw` 不发到主对话 |
| 旧 web + 新 CLI | 多一个 capability 字符串被忽略；`/btw` 文本会发给 SDK（与现状相同） |
| 新 web + 新 CLI | 全功能 |

server 无改动。发布顺序：web（镜像）→ CLI patch 版；存量 wrapper 不受益（铁律 7/14），需新建会话验收。回滚点：web 回上一镜像即可，CLI 保留新 RPC 无害。

## 风险

1. **fork 读取正在写入的主 transcript**：主 turn 进行中 fork 拿到的是截至当下的部分上下文——接受，这正是 CLI `/btw` 的语义。
2. **`persistSession:false` 与 `resume+forkSession` 组合**：2026-09-02 已用真实会话 probe（SDK 0.3.232）实证——fork 拿到完整上下文、`tools=0`、19 个 text delta 流式、projects 目录 JSONL 数不变；本地全栈（standalone server + dev web + 隔离 home 的 worktree daemon）真机跑通主 turn 进行中提问、历史续问、取消、关闭/重开保留历史，主会话 JSONL 无侧问痕迹。
3. **并发第二个 claude 进程内存/费用**：单轮无工具，但每次侧问都是一次全上下文请求（probe 一次 ~$5.7 的大会话 cost 口径），同会话同时只跑一个；用户可见文案已注明「不进主对话」。
4. **RPC 30s 上限**：ask 即返、poll 每次 <1s，规避。
5. **`process.env` 共享**：side 路径不写 `process.env`。

## 验收标准

- [x] `sdk/query.test.ts`：新 4 个选项透传。
- [x] `sideQuestion.test.ts`：prompt 拼接、流式累积、`result` 错误映射、无 resume 分支。
- [x] `registerSideQuestionHandler.test.ts`：ask→poll→done、busy 拒绝、cancel、结果过期。
- [x] web：`sessionPanelState.test.ts` 增 btw；`btwCommand.test.ts`（`/btw` 解析）；`btwStore.test.ts`（轮询到终态、cancel）；`agentInputQueue.test.ts` 式源码守卫（doSend 拦截存在）。
- [x] 全部门禁绿；`node dist/index.mjs --version` 冒烟。
- [x] 真机（本地全栈）：新建 remote 会话 → 主 turn 跑动时 `/btw` 提问得到答案且主对话无新增消息。

## 留真机验证项

- 窄屏（<860px）面板全屏遮罩下的 IME 输入与 Enter 发送。

## B-480 修订（2026-09-22，Yue DENG 实报）

现象：问「现在在干嘛呢」「怎么没有动静了」，答「抱歉，上一条我只说了没做。现在真的起：」然后没有下文；另报「失败率挺高」。

真因（本机 SDK 0.3.267 对真实 transcript 复现，`sideQuestion.test.ts` 钉住措辞）：

| 提示词形状 | 同一 transcript 问「现在在干嘛呢」 |
|---|---|
| 只有 `appendSystemPrompt` 一句（B-283 原版） | 「会话重启了…**我先核实磁盘上到底留下了什么,再决定怎么续。**」——当成主对话下一轮，要去调工具；fork 无工具 ⇒ 文本停在承诺处 |
| Claude Code `/btw` 原话 reminder 放用户消息里紧贴问题 | 「主线上已经跑完了,当前没有在跑的任务。刚做完的：…现在在等你决定下一步：…」 |

- reminder 原文取自 CLI 2.1.267 二进制里的 `LOe()`（`strings` 可见）：独立轻量实例、主 agent 未被打断、不要提「被打断/之前在做」、没有工具、单次回复、NEVER「Let me check…」。历史问答块仍在 reminder 之前，reminder 是模型读到的最后一段指令。
- **主 turn 正在跑工具时 fork**：transcript 末尾是没有 tool_result 的 `tool_use`，本机截断 transcript 实测 CLI resume 自己补 interrupted 占位后正常作答；不是失败源，但模型会把它描述成「上个进程退出时被中断」，可接受。
- 并发语义：页面刷新/换 tab 后 btwStore（内存）丢 requestId，永远发不出 `btw-cancel`；旧行为是再问就 `already running`，最长撑到 10 min 上限。现在 `btw-ask` 遇到在跑的 slot 直接 abort 它并标 `cancelled`，新问题接管。web 自身仍有「本页有 running 就不发」的守卫，所以只有丢状态的客户端会走到这条。
- 模型仍去调工具（理论上 `tools: []` 下不会，MCP 也被 `strictMcpConfig` 清空）：不再把 `error_max_turns` 当失败，按 Claude Code 回 `(The model tried to call X instead of answering directly. Try rephrasing or ask in the main conversation.)`；`system/api_error` 的 `error.formatted` 进错误文案。
- 仅 CLI 改动；存量 wrapper 不受益（铁律 14），需新建会话或重启会话。

## B-482 修订（2026-09-22）：走 Claude Code 自己的进程内 `/btw`

Owner 问「有啥办法能做到和 claude code 的逻辑一样」。答案是有现成通道：

- 运行中的 `claude` 进程在 SDK stdio 的控制请求分发链里处理 `side_question`（2.1.267 二进制，与 `interrupt` / `set_model` / `get_context_usage` 同一条 `else if (kt.request.subtype === …)`）。入参 `{question, history?: [{question, response, fallback_notice?}]}`，回 `{response, synthetic, refusal_fallback?}`；进度 `system/control_request_progress {status: 'started' | 'api_retry'}`（sdk.d.ts 注明「currently only side_question」）；SDK `Query.request()` 的 AbortSignal 会发 `control_cancel_request`，CLI 按 request_id abort。Remote Control 瘦客户端的 `/btw`（`thinClientDispatch: "control-request"`）走的就是它。
- 它用进程内实时 messages（`dt`），主 turn 在跑时复用在跑的 query 上下文（`p4e()`），然后调 `/btw` 本地路径同一个函数（`LOe`）：同一段 reminder、同一个 fork、无工具、单轮、不落盘、同款 "(The model tried to call X…)"、refusal fallback。

实现（仅 CLI；RPC `btw-ask/poll/cancel` 形状不变，web 零改动）：

| 层 | 改动 |
|---|---|
| `claudeRemote.ts` | `onQueryReady` 多暴露 `sideQuestion(request, signal)` = `(response as any).request({subtype:'side_question', ...request}, {signal})` 的 `.response`。`request` 是 SDK 内部通用发送器（typed 方法全是它包的），公开类型没列这个 subtype |
| `claudeRemoteLauncher.ts` | Query 就绪时 `session.setSideQuestionLive({ask, canControl})`，Query 结束 `finally` 置空 |
| `session.ts` | 新增 `setSideQuestionLive / getSideQuestionLive`，`cleanup` 置空 |
| `sideQuestion.ts` | `runSideQuestionLive(ask, input)`：history `{question, answer}` → `{question, response}`（同样 12 条 / 2000 字裁剪）；`response` 空 → 抛「without a result」；`refusal_fallback.content` 前置 `⚠ …`；结果带 `mode: 'live'`。`isUnsupportedSideQuestionError` 识别老 CLI 的 unknown-subtype |
| `registerSideQuestionHandler.ts` | `getLiveQuery` dep；有 live 且 `canControl()` → live，否则 fork；live 因 unknown subtype 失败（且未取消）→ fork，其它 live 错误原样报错；ack 多 `mode` 字段 |
| `runClaude.ts` | `getLiveQuery: () => currentSession?.getSideQuestionLive() ?? null`（local 模式永远 null） |

兜底矩阵：

| 情况 | 路径 |
|---|---|
| remote 模式、Query 存活、不在 SDK 回调里 | live |
| 首轮前 / Query 重建间隙 / local 模式 | fork（B-283 + B-480 的路径） |
| wrapper 正停在 canUseTool / elicitation 回调里（铁律 8） | fork |
| wrapper 的 SDK 太老，CLI 回 unknown subtype | 首次 live 失败后 fork |

与 B-280 版本的差异：上下文从「磁盘 transcript + resume 补 interrupted 占位」变成进程内实时消息（不再说「上个进程被中断」）；没有 token 级渐进文本（Claude Code 本地 `/btw` 也是整段回）；不再多起一个 claude 进程，hooks 问题不复存在。

验证：本机 SDK 0.3.267 裸 Query 探针（`scratchpad/probe3.mjs`）——主 turn 跑 Bash 时问「现在在干嘛呢」3.5s 答出正在跑什么；turn 结束后与带历史再问正常；每次 `control_request_progress started` 先到。`claudeRemote.test.ts` 锁控制请求形状，`registerSideQuestionHandler.test.ts` 锁 live 优先与三种回退，`sideQuestion.test.ts` 锁 history 映射 / 取消 / 空答 / refusal 前缀。真机 V-158。

## B-861 修订（2026-11-02）：侧聊——Codex、刷新保留、运行中入口、转成分叉会话

需求：Jinghui LU「主分支在跑的时候，同时 side chat」。UI 与文档统一叫「侧聊 / Side chat」，命令仍是 `/btw`，RPC 名不变。

### Codex：临时线程作答（仅 CLI 新增；RPC 形状不变）

实测 Codex 0.154（`vh-team-B-861/codex-probe1.log`、`codex-probe2.log`，隔离 `CODEX_HOME`）：

| 探针 | 结果 |
|---|---|
| 第二个 app-server 在主轮运行中 `thread/fork {ephemeral:true}` | 拒绝：`ephemeral paginated thread/fork requires excludeTurns: true`；加 `excludeTurns:true` 后 156ms 成功，`path:null` |
| 在 fork 上 `turn/start` 问暗号 / 追问 | 2.9s 答对；追问正确（上下文含进行中轮次，显示为 `interrupted`） |
| 主线程 rollout | 侧聊前后：之前内容是之后的前缀，新增行全部是主会话自己的；`sessions/` 文件数不变 |
| 主轮 | 完整跑完（`LONG-DONE`），未被打断 |
| 首轮还在跑时 fork | 成功且带上下文（暗号答对） |

实现：

| 层 | 改动 |
|---|---|
| `codexAppServerClient.ts` | `onRawNotification`；`openSideThread`（有主线程 → `thread/fork`，否则 `thread/start`；都 `ephemeral`、`excludeTurns`、`sandbox: read-only`、`approvalPolicy: never`、`features.hooks=false`、账号 `modelProvider`/config）；`startSideTurn` / `interruptSideTurn`。均不碰 `_threadId/_turnId`，不影响重连 resume |
| `codexSideQuestion.ts` | `runCodexSideQuestion`：每问一个新 `CodexAppServerClient`（同 sandboxConfig + 账号 overrides）→ fork → 单轮 → `disconnect` 停掉该 app-server（临时线程随之消失）。只收 side 线程的通知；`item/agentMessage/delta` 渐进文本；出现非消息/推理条目（命令、MCP、web 搜索…）立即 `turn/interrupt` 并回 Claude 同款 `(The model tried to call …)`；fork 失败（rollout 未落盘）→ 无上下文临时线程，`hadContext:false` |
| `registerSideQuestionHandler.ts` | `getMainStatus` dep；poll 回 `hadContext`（Codex 回退后纠正 ack） |
| `runCodex.ts` | 注册 `btw-ask/poll/cancel`；capability `codex-btw-v1`（wire `CODEX_BTW_CAPABILITY`） |
| 提示词 | `SIDE_QUESTION_SYSTEM_PROMPT` 加一句：最新一步可能还没结果——仍在跑或等审批，不要说成被中断。主会话有待审批请求时，wrapper 把 `<main-session-status>`（工具 + 命令）放在 reminder 前（Claude fork 路径与 Codex 都用）。实测前：Claude/Codex 都答「命令被中止」；后：「在等你批准，尚未执行」 |

不变：Claude 仍是 B-482 live 优先、fork 兜底。新的 ask 取代在跑的（Codex 侧 abort → interrupt + 停 app-server）。

### Web

- `canOfferBtw` 认 Codex；`supportsBtw` 按 flavor 查 `claude-btw-v1` / `codex-btw-v1`。旧 Codex wrapper：面板可开、输入禁用、提示升级；`/btw` 不发进主线程。
- 持久化：`btwStore` 按会话写 `localStorage['vh.btw.v1:<sessionId>']`（最近 50 条，单答 2 万字截断，含 draft）。首次读该会话时 hydrate（内存优先；`setDraft`/`ask` 前先 hydrate，避免覆盖已存记录）。刷新时还在跑的那条若有 requestId 就续 poll（CLI 留 5 分钟），没有则标为已停止。读写全部 try/catch，失败退回纯内存。「清空」删 key。**不跨设备同步**（不上服务器）。
- 入口：主会话运行中（`isAgentWorkLive`）输入框 Stop 左侧「侧聊 / Side chat」中性描边胶囊，tooltip「主会话跑着也能问，不会打断它」，触屏 44px；仅 `btwAllowed`（Claude/Codex、非镜像、非他人分享）。
- 「转成分叉会话 / Continue as fork」：面板底部，有侧聊记录时显示；走 B-860 `forkWholeSession`（运行中只带已完成轮次），预填最后一条侧聊问题（取代运行中那条的预填），运行中照常弹「只含已完成部分」提示。复用 `useStartSessionFork`（⋯ 菜单同一路径）。

### 兼容与发布顺序

| Web | CLI | Claude | Codex |
|---|---|---|---|
| 新 | 新 | 全功能 | 全功能 |
| 新 | 旧（实测 0.2.193） | 侧聊可用 + 入口 + 刷新保留 | 入口在，面板提示升级 CLI，`/btw` 不进主对话，pageerror 0 |
| 旧 | 新 | 同旧版 | `/btw` 文本照旧发给 Codex；多出的 capability 被忽略 |

server 不变。先 server/Web（镜像）后 CLI；Codex 侧聊需要新 CLI 起的会话（铁律 14）。「转成分叉会话」依赖 B-860 的 RPC（同批 CLI）。

### 验收（隔离 daemon，证据 `~/code/github/skills/tmp/vh-team-B-861/`）

- Codex（`e2e-codex-desk.log`）/ Claude（`e2e-claude-desk.log`）：主轮 100s sleep 中侧聊答对暗号（Codex 4.7s / Claude 2.6s），追问倒写、引用首问都对；刷新后 3 条仍在；rollout/transcript 前缀不变、无侧聊字样，主轮 LONG-DONE；「转成分叉会话」预填最后一问，新会话用工具跑了 `ls`。
- 边界：Codex 首轮（`edge-codex-first.log`）；权限挂起（`edge-perm3*.log`，请求侧聊前后都在，批准后跑完）；连问取代（`edge-codex-supersede.log`：first=cancelled、second=done，侧 app-server 全退）；账号绑定（`edge-acct.log`：侧 app-server 无本机 key 仍答对；账号 key 换成坏的 → 401，不回落；恢复后正常）。
- 手机 coarse 中英：入口 44×72 / 44×100，无横向溢出（`mobile.log`、`shots/mobile-*`）。新 Web + 0.2.193（`compat-193.log`）。

### 已知边界

- Claude 账号绑定沿用 B-850a（live 路径同进程；fork 路径带账号 `apiKeyHelper`），本次未另做真机。
- 侧聊记录只在当前浏览器；换设备或清站点数据就没了。
