# `/btw` 侧问（side question）：不打断主对话的旁路问答

> 状态：Final
> 日期：2026-09-02 ｜ 关联 backlog：B-279 ｜ 出处：Owner 2026-09-02「给 claude code sdk session 支持类似 btw 命令的能力」

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
- 不持久化侧问历史（刷新即丢；Claude CLI 也只在进程内保留 `btwHistory`）。
- 不支持 codex/gemini/acp/mirror 会话。
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
  - `SIDE_QUESTION_SYSTEM_PROMPT`：与 CLI 同义的 system-reminder 文案（直接单轮作答、不能用工具、基于当前对话上下文）。
  - `runSideQuestion({ query, question, history, resumeSessionId, cwd, model, signal, onText })`：
    `query()` 选项 = `{ cwd, resume, forkSession: true, persistSession: false, tools: [], mcpServers: {}, strictMcpConfig: true, maxTurns: 1, includePartialMessages: true, permissionMode: 'default', canCallTool: deny, appendSystemPrompt }`；
    从 `stream_event` 的 `text_delta` 累积渐进文本，`assistant` 文本块为最终答案，`result.subtype!=='success'` 抛错。
    `resumeSessionId` 为空（主会话还没跑过第一轮）时不 resume、无上下文直接答。
- 新模块 `claude/registerSideQuestionHandler.ts`（纯注册函数，deps 注入，可单测）：
  - RPC `btw-ask {question, history?}` → 立即返回 `{ requestId }`，后台跑 `runSideQuestion`；同一会话同一时刻只允许一个在跑（忙则 `throw`）。
  - RPC `btw-poll {requestId}` → `{ status: 'running'|'done'|'error'|'cancelled', text, error?, startedAt, finishedAt? }`（渐进 text）。
  - RPC `btw-cancel {requestId}` → abort。
  - 已完成结果保留 5 分钟后丢弃（web 拿到 done 就本地持有）。
- `runClaude.ts:184` capability 追加 `'claude-btw-v1'`；注册点放在 `currentModel` 声明之后，deps：
  `getClaudeSessionId: () => currentSession?.sessionId ?? session.getMetadata()?.claudeSessionId`、`getModel: () => currentModel`、`cwd: workingDirectory`。
- `sdk/types.ts` + `sdk/query.ts`：`QueryOptions` 增 `forkSession/tools/persistSession/includePartialMessages`，一一透传。

### Web

- `sessionPanelState.ts`：`SessionPanelTab` 增 `'btw'`（`?panel=btw`）。`SessionDetailScreen` 里 `panelTab==='btw'` 时右侧 aside 渲染 `BtwPanel`（复用 `.sd-files` 几何、拖宽、窄屏遮罩），否则 `FilesPanel`；files 按钮的 active 态只认 files 三个 tab。
- `ChatHeader`：files 按钮左侧新增「侧问」图标按钮（`MessageCircleQuestion`），非 mirror 时显示；`aria-pressed` = 面板开。
- `AgentInput.doSend`：`^/btw\b` 拦截 → 通过 `btwPanelState.openBtwPanel(sessionId, question?)`（window 事件 `vh:btw-open`，`SessionDetailScreen` 监听后 `setPanel('btw')`）；带问题则直接发问；**永不** `sendMessage`。Claude flavor 的斜杠补全列表前置 `btw` 项（描述文案 i18n）。
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
