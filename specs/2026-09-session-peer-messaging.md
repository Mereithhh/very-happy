# 会话间消息与编辑冲突提示（Session peer messaging）

> 状态：Draft
> 日期：2026-09-25 ｜ 关联 backlog：B-497 ｜ 前身：[Automations](2026-09-automations.md)（B-496，同一批工具注入机制）、Teams 消息投递（`daemon/teams/worker.ts`）

## 背景

同一台机器上常有多个托管会话（Claude / Codex / pi，加上 Web 终端里手敲的 Claude 镜像会话）同时改同一个仓库。今天它们互相看不见：一个会话改了 `foo.ts`，另一个会话几分钟后也改，冲突要到 review 或 `git diff` 才暴露。Owner 口径：**不限制权限、不加锁**，目标是「一个会话改文件时发现别的会话也在改，两者能直接互相交流协商」，参考 Teams 的消息投递（同一条 REST 出站队列、正文带来源头、Web 特化卡片）。

## 目标

1. 任意托管会话能给同机另一会话发消息（MCP `session_message`；CLI `very-happy sessions message`），对方在自己的聊天里收到一条带发送方标记（标题、sessionId、cwd、agent）与回信方式的消息。
2. 任意托管会话能列出同机「邻居」（MCP `session_peers`；CLI `very-happy sessions peers`）：同 repo（含同一 repo 的其它 worktree）、同 cwd 或全机的活会话及各自最近编辑的文件。
3. daemon 记录本机每个活会话最近编辑的真实路径；第二个会话在窗口内编辑同一路径时，双方各收到一条冲突提示（谁、哪个文件、对方 sessionId、建议用 `session_message` 协商），同一对会话同一文件窗口内只提示一次。
4. Web 把 `session_message` / `session_peers` 工具调用渲染成 B-499 风格的内置工具视图，把会话消息 / 冲突提示渲染成可点跳转来源会话的卡片。
5. Claude / Codex / pi 三个托管 runner 与 assistant 变体工具面一致。

## 非目标

- 跨机器投递（需要 B-337 的账号内容密钥；本次对非本机会话返回明确错误）。
- 文件锁、编辑阻断、权限收窄。
- 镜像会话（Web 终端里手敲的 Claude）作为**收件方**：它没有 wrapper 消费队列，本次只作为编辑观测源与冲突提示中的「对方」，投递给它返回明确错误（`terminal mirror sessions cannot receive messages`）。
- Web 端发消息给会话的 UI（Web 已有普通聊天输入；本次只做展示）。
- 协议新字段：来源信息全放在正文头部（与 Teams 一致），`meta.sentFrom` 用新值 `session-peer`；wire schema 不改。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 托管 Claude 在进程内注册工具，`toolNames` 决定 SDK `allowedTools`（`mcp__happy__<name>`）；新工具必须进 `toolNames` | `packages/happy-cli/src/claude/utils/startHappyServer.ts:58-66,325-333`；`claude/runClaude.ts:1094` |
| Codex 走 stdio bridge，按名转发到会话进程的 HTTP MCP；bridge 只能有 3 个字面量 `registerTool(`（web 公共契约测试钉死），新工具族用「registrar helper + forward」模式 | `codex/happyMcpStdioBridge.ts:155-172`；`happy-web-v2/src/screens/public/publicContent.test.ts:291` |
| pi 通过 `HAPPY_MCP_URL` 的 `tools/list` 动态注册，无需逐工具接线 | `teams/resources.ts` `PI_TEAMS_EXTENSION` |
| B-496 的三 runner 可见性回归模式（源码断言 + docs/channels.md 矩阵） | `automations/toolSurface.test.ts` |
| 向会话投递用户消息的唯一原语：会话密钥加密 + `POST /v3/sessions/:id/messages`，`meta.sentFrom` 自由字符串，`meta.delivery: 'queue'|'steer'` | `commands/sessionMessage.ts:55-106`；`happy-wire/src/messageMeta.ts` |
| Teams 投递格式：正文头 `[Very Happy team message …; from …]` + footer，`sentFrom: 'team'`；Web 用 `presentTeamMessage` 解析头部渲染 `TeamMessageCard` | `daemon/teams/worker.ts:166-167`；`happy-web-v2/src/screens/session/teamMessage.ts`、`TeamMessageCard.tsx`、`MessageView.tsx:38-39` |
| daemon 已在自身进程内用 `sendUserMessage` 给会话投递（assistant 汇报），持有凭据与 `~/.happy/sessions.json` 的会话密钥 | `daemon/run.ts:1543-1548` |
| daemon 控制面：bearer token 的 loopback HTTP；`/list` 只回 `{startedBy, happySessionId, pid}`；`TrackedSession` 有 webhook 快照 `happySessionMetadataFromLocalWebhook`（含 `path`、`flavor`、`summary`） | `daemon/controlServer.ts:86-190`；`daemon/types.ts:19-43`；`daemon/run.ts:283-345` |
| wrapper→daemon 已有的上报客户端：`daemonPost` 不抛错、非 2xx 回 `{error}` | `daemon/controlClient.ts:18-75` |
| Claude 每条 transcript 行经 `sendClaudeSessionMessage` 时触发 `'claude-session-message'` 事件（remote SDK、local scanner、镜像 shadow client 三路都过），assistant 内容里的 `tool_use` 块带 `name` 与 `input.file_path` | `api/apiSession.ts:894-904`；`claude/runClaude.ts:489`；`mirror/mirrorManager.ts:162-168` |
| Codex 文件变更事件：`patch_apply_begin` 的 `changes` 以路径为 key | `codex/runCodex.ts:725-730`；`codex/codexAppServerClient.ts:91-130` |
| pi 编辑工具：ACP `tool-call` 的 `args.piTool ∈ {write, edit}`、`args.rawInput.path`，或 `args.locations[].path` | `agent/acp/sessionUpdateHandlers.ts:301-318`；`happy-web-v2/src/components/tools/piToolMapping.ts:57-88` |
| 镜像会话：daemon 内 shadow `ApiSessionClient`，`metadata.flavor='terminal-mirror'`、`metadata.path = 终端 cwd`，不是 daemon 子进程（不在 `/list`） | `mirror/mirrorManager.ts:325-341,362-380` |
| Web 内置工具视图：`BUILTIN_TOOL_NAMES` + `builtinToolSummary/Fields/Digest`，结果里的 sessionId 用 `/session/<id>` 链接 | `happy-web-v2/src/components/tools/builtinTools.ts` |
| 会话 CLI 的动作解析与帮助 | `commands/sessions.ts`；`sessions/sessionOps.ts` |
| Claude 子进程环境只有 `HAPPY_MANAGED=1`，没有 `HAPPY_SESSION_ID`（pi 子进程有） | `claude/runClaude.ts:84`；`agent/acp/runAcp.ts:648` |

## 设计

### 1. 消息格式（CLI 产生，Web 解析；单一事实源 `packages/happy-cli/src/sessions/peerMessage.ts`）

用户消息（`role: 'user'`）正文头一行 + 正文 + footer；`meta.sentFrom = 'session-peer'`。

会话消息：

```
[Very Happy session message <msgId> from "<title>" <fromSessionId>; agent <flavor>; cwd <cwd>; re <replyTo>]
<body>

This message comes from another agent session on this machine, not from the user. Reply with session_message(to: "<fromSessionId>") — or `very-happy sessions message <fromSessionId> "<text>"` — and keep coordinating there.
```

冲突提示（daemon 产生，`meta.delivery = 'steer'`，正在编辑的一方能在当前 turn 内收到；无活 turn 时按队列）：

```
[Very Happy edit conflict <noticeId>; file <realPath>; peer "<title>" <peerSessionId>; agent <flavor>; cwd <cwd>; peer edited <n>s ago]
Another session on this machine edited the same file within the last 30 minutes. Both sessions received this notice. No lock is held — coordinate before continuing: session_message(to: "<peerSessionId>", body: "…") saying what you are changing in <path> and asking what they are changing. If the peer is a terminal session (agent terminal-mirror), it cannot be messaged; the person at that terminal owns those edits.
```

头部字段用 `; ` 分隔、`key value` 形式，值里的 `"`/`;`/换行被替换为空格；`re <replyTo>` 与 `cwd` 可选。Web 只解析第一行，解析失败时按普通用户消息渲染（旧 Web 天然如此）。

### 2. `session_message` / `session_peers` 工具（`packages/happy-cli/src/sessions/peerTools.ts`）

- `SESSION_PEER_TOOL_NAMES = ['session_message', 'session_peers']`；schema 与执行分离（同 automations）。
- `session_message({ to, body, replyTo? })`：
  1. `to` 通过 `isValidSessionId`，且 ≠ 自己；
  2. `readPersistedSessions()[to]` 不存在 → 错误 `Session <id> is not on this machine (no local key); messaging sessions on other machines is not supported yet`；
  3. daemon `/peers` 里必须是活会话：不活 → 错误 `Session <id> is not running on this machine; nothing would read the message`；`kind: 'mirror'` → 错误 `terminal mirror sessions cannot receive messages`；
  4. 组装正文（发送方：`client.sessionId`、`getMetadata().summary?.text`、`.path`、`.flavor`），`sendUserMessage(to, persisted, text, 'session-message', { sentFrom: 'session-peer', localId: 'session-message-<msgId>' })`；
  5. 返回 `{ delivered: true, messageId, to, url }`。
- `session_peers({ scope?: 'repo' | 'cwd' | 'machine' })`（默认 `repo`）：daemon `/peers` → 每个活会话 `{ sessionId, kind: 'managed'|'mirror', pid?, cwd, flavor, title, variant?, url, edits: [{ path, tool, at }] }`；按 `resolveRepoIdentity(cwd)` 过滤：`repo` = git common dir 相同（主仓与其 worktree 互为邻居，`sameWorktree` 标注是否同一 toplevel）、`cwd` = 同一 cwd、`machine` = 全部；输出 `{ self, scope, peers }`。
- 注册：`startHappyServer` 里 `registerSessionPeerTools(mcp, createSessionPeerToolExecutor(client))`，`toolNames` 追加 `SESSION_PEER_TOOL_NAMES`；Codex bridge `registerSessionPeerTools(server, (name, args) => forwardTeam(name, args))`；pi 自动。assistant 变体沿用同一注册（工具对所有托管会话可用，与 B-496 同一信任层）。
- Claude 子进程增加 `HAPPY_SESSION_ID=<happy session id>`（在 loop 前注入 `claudeEnvVars`），让 Bash 里跑的 `very-happy sessions message` 能标出发送方；镜像 forwarder 已按 `HAPPY_MANAGED` 退出，不受影响。

### 3. CLI（`commands/sessions.ts`）

```
very-happy sessions peers [--scope repo|cwd|machine] [--cwd <dir>] [--json]
very-happy sessions message <id> <text> [--reply-to <msgId>] [--json]
```

- `peers` 的 self：`HAPPY_SESSION_ID` 所指会话（在托管会话的 shell 里）或 `--cwd`/进程 cwd。
- `message` 的发送方：`HAPPY_SESSION_ID` 所指会话（标题/cwd 取本机快照），否则 `cli`（title `cli <user>@<host>`，cwd 为进程 cwd）。同样要求目标活着且非镜像；错误进 stderr（`--json` 时 stdout 仍有 `{delivered:false,error}`），退出码 1。

### 4. 编辑观测（wrapper → daemon `/session-edit`）

- 上报体 `{ sessionId, path, tool, cwd? }`，best-effort、不等待；同一 wrapper 对同一路径 5s 内只报一次（`EditReporter` 纯函数节流）。
- Claude：`runClaude` 增加 `session.on('claude-session-message', …)` 监听，`extractClaudeEditPaths(body)`（纯函数）取 assistant `tool_use` 中 `Edit|Write|MultiEdit|NotebookEdit` 的 `file_path`/`notebook_path`。记的是**调用意图**而非成功结果：Edit 因内容陈旧失败正是冲突场景，此时也应提示。
- Codex：`patch_apply_begin` 的 `Object.keys(changes)`（`tool: 'CodexPatch'`）。
- pi：`tool-call` 事件 `extractAcpEditPaths(args)`：`piTool ∈ {write, edit}` 取 `rawInput.path`；否则 `kind === 'edit'` 取 `locations[].path`。
- 镜像会话：mirror manager 在 `sendMessages` 里对同一 `extractClaudeEditPaths` 取路径，直接调用 daemon 内的 tracker（sessionId = shadow session id，cwd = `binding.metadata.path`）。
- daemon 侧 `normalizeEditPath(path, cwd)`：相对路径按 cwd 解析，再取最长存在祖先的 `realpath` + 余下部分，保证同一真实文件一个 key、不同 worktree 不同 key。

### 5. daemon 冲突表（`daemon/peerEdits.ts`，纯逻辑）

- `EditConflictTracker({ windowMs = 30min })`：`record({ sessionId, path, tool, at }, isLive)` → 保存 `(path → Map<sessionId, {tool, at}>)`，返回窗口内、仍活着、且 `(pair, path)` 未在窗口内提示过的其它会话；`editsOf(sessionId, now)`、`forget(sessionId)`、`prune(now)`。
- 活会话判定 = daemon 子进程表里的 `happySessionId` ∪ 镜像 active binding。子进程退出 / 镜像 end 时 `forget`。
- 通知：对每个冲突，daemon 向**双方**各投一条冲突提示（`sendUserMessage`，`sentFrom: 'session-peer'`，`delivery: 'steer'`，`localId: 'edit-conflict-<noticeId>-<recipient>'`）；镜像会话跳过投递（正文里告知另一方）。投递失败只记日志。
- `/peers` 响应带 `edits`（窗口内、按时间倒序、最多 20 条）。

### 6. Web

- `screens/session/sessionPeerMessage.ts`：`presentSessionPeerMessage(message)`（`sentFrom === 'session-peer'` 且首行匹配）→ `{ kind: 'message'|'conflict', id, fromSessionId, fromTitle, agent, cwd, path?, replyTo?, body }`；`SessionPeerMessageCard`：来源行（标题 + agent + `/session/<id>` 链接）、冲突时的文件路径、正文折叠原文（沿用 `teamMessage.css` 的结构与 token）。
- `builtinTools.ts`：`BUILTIN_TOOL_NAMES` 增 `session_message`、`session_peers`；summary：`session_message` = `to <shortId> · <body>`，`session_peers` = scope；fields：to / replyTo / body、scope；digest：`session_message` 链接目标会话，`session_peers` 列出邻居行（标题 · agent · cwd · 最近编辑 n 个文件）并逐个链接。
- i18n：`_default.ts` 与 `zh-Hans.ts` 增 labels/fields/卡片文案。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 Web + 新 CLI | 会话消息按普通用户气泡显示（头部可读）；工具调用走通用渲染 |
| 新 Web + 旧 CLI | 无 `session-peer` 消息，卡片代码不触发 |
| 新 wrapper + 旧 daemon | `/session-edit`、`/peers` 404 → wrapper 忽略上报；工具返回 `daemon does not support session peers; restart the daemon on CLI ≥ <ver>` |
| 新 daemon + 旧 wrapper | 无上报，无冲突提示；`/peers` 仍能列会话（无 edits） |

wire 无改动。发布顺序：server/Web 随下一次 switch（只含展示），CLI 随下一版；两者独立可发。回滚点：CLI 固定上一版即可，消息文本无持久化格式。

## 风险

1. **冲突提示打断正在进行的 turn**（steer）：只在同一对会话同一文件窗口内提示一次；无活 turn 时退化为队列。接受。
2. **给空闲会话投递会起新 turn 消耗 token**：这是 Owner 要的「双方都知道」；窗口去重限制频率。接受。
3. **daemon 在自身进程内发 REST**：与 assistant 汇报同一路径，失败只记日志，不影响会话。
4. **路径归一失败**（文件不存在、权限）：退化为 `path.resolve(cwd, p)`，不抛错。
5. **`HAPPY_SESSION_ID` 注入 Claude 子进程**：只有 teams/todo 客户端读它且均在 `HAPPY_MANAGED=1` 下不注册；已核对 `commands/mcp.ts:151`。
6. **与 B-501（`send` 对失效会话误报 delivered）并行**：本 spec 不改 `commands/send.ts`、`commands/sessionMessage.ts`，只 import `sendUserMessage`；活性检查自带。

## 验收标准

- [ ] `session_message` / `session_peers` 在 Claude（进程内）、Codex（bridge 转发）、pi（tools/list）三路可见；源码断言回归测试 + `docs/channels.md` 矩阵。
- [ ] `very-happy sessions peers|message` 解析、帮助、退出码有单测。
- [ ] `EditConflictTracker`：窗口、去重、活会话过滤、forget、prune 单测；`normalizeEditPath`、`resolveRepoIdentity`（普通 repo、worktree `.git` 文件、非 repo）单测；三 runner 的路径提取纯函数单测。
- [ ] daemon `/session-edit`、`/peers` 路由测试（token 门 + 载荷）。
- [ ] Web：`presentSessionPeerMessage` 解析/回退单测；builtinTools 覆盖新工具；vitest / vite build / tsc 全绿。
- [ ] 隔离 `HAPPY_HOME_DIR` + standalone server：两个真 Claude 会话同 repo 编辑同一文件 → 双方收到冲突提示，其中一方用 `session_message` 回信、对方收到；证据 `~/code/github/skills/tmp/vh-automation/b497-e2e.md`。

## 留真机验证项

- Web 卡片在手机宽度下的折叠与链接可点（浏览器可验，不进 verify queue）。
