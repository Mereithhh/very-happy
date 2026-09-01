# 归档恢复：对话原地复活 + 终端归档可恢复

> 状态：Final（4 轮对抗式 review：v1→v4，第 4 轮无 P0/P1；review 记录见 `~/code/github/skills/tmp/archive-restore/`）
> 日期：2026-09-01 ｜ 关联 backlog：B-265（新）｜ 前身：`2026-08-archive-only.md`（B-083）、`2026-08-session-archive-lifecycle.md`（B-177）、`2026-08-terminal-tombstones.md`（B-149）、`2026-08-terminal-auto-restore.md`（B-150）、`2026-08-terminal-tags.md`（B-216，tags 链路已合入 #58）

## 背景

- Web 自 B-083 起 archive-only：对话归档后只能翻历史，**没有恢复入口**。机制其实齐了——server `POST /unarchive`、
  daemon `resume-happy-session`（同一 happy session 原地复活 + `claude --resume`）、web `machineResumeSession`——
  但 web-v2 **零调用**（只有废弃的 happy-app 用过；`sessionInfo.resumeSession*` 文案是孤儿）。
- 归档会话里发消息是黑洞：消息落 server，CLI 重连时 `skipExistingMessages` 从 seq 0 分页跳过全史，这条永远不被处理。
- 终端：关闭 = tmux kill + 7 天墓碑 + closed 记录（本机 `closed-terminals.json`，40 条）。归档视图能「在原目录继续会话」，
  但那是**新 id 的新终端**：标题、标签、侧栏顺序/置顶全丢。Owner 的心智模型是「删了也在归档里，能恢复」。

## 目标

1. **P0 对话恢复**：归档视图每行、归档会话详情页、命令面板都有「恢复」；点一下原 happy session 原地复活
   （同 id、同 URL、历史不丢），上线后直接续聊。失败原因明确（见 A5 映射表）。
2. **P0 归档会话里发消息不再黑洞**：只对**真归档**（`archivedAt != null`）的会话拦截：发送 = 先恢复、草稿保留、
   CLI 就绪后自动发出；失败草稿仍在。**暂时离线**（`archivedAt == null && !active`，10 min 无心跳）的会话行为不变（直发，进程重连后照收）。
3. **P1 终端归档可恢复**：关闭终端即进入归档（沿用「已结束终端」记录）；归档行「恢复」= **同 id、同标题（含手动改名标记）、
   同标签、同 cwd** 重建 tmux 并注入 `claude --resume`（有会话时）。旧 daemon 零延迟退回现有「同目录新终端」。
4. 新逻辑纯函数 + 单测；跨包写兼容矩阵；不新增轮询/常驻进程/依赖。

## 非目标

- 不恢复 tmux scrollback / 已死进程；不做批量恢复；不做「从归档永久删除」/数据保留（B-025）。
- 不解决归档列表 150 条上限 / 无分页（B-083 已接受；另立项）。详情页 URL 可达但 store 无该会话时维持现状（loading）。
- 不做跨机器恢复；不做 gemini / openclaw / acp 的恢复（`buildResumeLaunch` 只认 claude/codex），这些行不显示恢复。
- 不改 archive 语义（server 先落库再 kill，B-177）。
- 终端恢复后 claude 的 mirror 会话是**新的**（`mirrorManager` bind 永远 `getOrCreateSession`）：归档行的「查看结构化历史」仍指旧 mirror，新对话在新 mirror。本期写明，不做 mirror 复用。
- 归档 → 恢复 → 恢复窗口内用户再次归档（≤ 数秒、需主动操作）可能被子进程的 `reactivateSession` 撤销：接受。

## 现状事实（代码已确认，基线 `da6ab90c`）

| 事实 | 位置 |
|---|---|
| `archivedAt` 是 server-owned 归档意图；`/v1/sessions` **不返回**它；web `Session` 无该字段；归档视图 = `!active` | `sessionRoutes.ts:20-46`、`sidebarRows.ts:23`、`storageTypes.ts` |
| `!active` 有两种来源：真归档（`archivedAt` 非空）与 10 min 无心跳超时（`archivedAt` 仍 null） | `presence/timeout.ts:10-30` |
| `POST /unarchive` 已存在：`archivedAt=null, active=false`，不发事件；archive 路由发 `session-archive`（session room + machine-scoped）+ ephemeral activity，**web 没有收到 archivedAt 的渠道** | `sessionRoutes.ts:369-417`、`eventRouter.ts:255-262` |
| 无 `GET /v1/sessions/:id`；daemon `fetchServerSessionMetadata` 用 150 条列表 | `sessionRoutes.ts`、`run.ts:855-869` |
| 归档会话的 CLI socket 被拒；presence flush 不复活归档行 | `socketIdentity.ts:18-25`、`presence/sessionCache.ts:19-24` |
| web `machineResumeSession` = unarchive → RPC → 失败回滚 re-archive；零调用；daemon `throw` 到 web 是 `{error}`（无 `type`） | `ops.ts:860-872`、`sessionResumeFlow.ts`、`RpcHandlerManager.ts:87-92`、`ops.ts:399-405`（machineOpenTerminal 已有规范化先例） |
| 未注册的 machine RPC：server 等 `RPC_RECONNECT_GRACE_MS`=15 s 才回 `RPC method not available` | `rpcHandler.ts:34,296-305`、`fsOps.ts:11-13` |
| daemon `resumeSession`：要求 tracked（live 或 `sessions.json` 预热）、有 encryption；`needsFetch` 实际恒真（webhook 元数据无 claudeSessionId）→ 走 150 条列表；不查活进程、不查 JSONL；`model`/`permissionMode` 未 sanitize 直接进 argv | `run.ts:871-932`、`runClaude.ts:161-197`、`run.ts:316-320`（spawn 路径有 sanitize） |
| `spawnTrackedHappyProcess` 先按 pid 登记、`happySessionId` 等 webhook（≤15 s）才填；已有 `createSpawnGate` 先例 | `run.ts:798-834,297-308` |
| `sessions.json` 条目 `savedAt` 只在 webhook 刷新，14 天后剪掉 | `persistence.ts:489-518`、`run.ts:239-249` |
| CLI 重连：`lastSeq` 固定从 0 起（`HAPPY_RECONNECT_SEQ` 未用于此）；skip pass 按 100 条分页拉全史；期间到达的 socket `update` 仅 `invalidate`，合并后从 skip 后的 `lastSeq` 起 → **丢** | `apiSession.ts:131,139-144,225-228,516-580` |
| 中继路径 `session-message-deliver` 不受 skip 影响立即路由；web 先走 relay，失败回落中心 POST | `apiSession.ts:666-706`、`sync.ts:2036-2040` |
| 首个 keepAlive 构造即发（volatile）+2 s 周期，与 skip pass 无序 | `claude/session.ts:112-116` |
| web `presence = active ? 'online' : activeAt`；`Session.metadataVersion` 可用 | `storage.ts:69-72`、`storageTypes.ts` |
| CLI 收到 `session-archive` 后 `cleanup({archive:true})`：盖 `lifecycleState:'archived'`/`archivedBy:'cli'`/`archiveReason` + `POST /archive`；重连路径清 `archivedBy` 不清 `archiveReason` | `runClaude.ts:884-931,298-311` |
| `AgentInput.canSend` 不看 presence/active；组件 `key={id}` 切会话即重挂 | `AgentInput.tsx:551`、`SessionDetailScreen.tsx:80-100` |
| 侧栏 order/pins 每 60 s 扫描，`valid` 只含 active 会话 + 活终端，连续两次缺席即 prune | `Sidebar.tsx:590-620`、`sidebarOrder.ts:179-190` |
| 终端关闭：查 `info` → kill+verify → `recordClosed`（title/cwd/mirror/claudeSessionId，**无 tags、无 manual**）→ 墓碑 → 缺席传播 | `webTerminal.ts:2559-2609`、`closedTerminals.ts:22-58` |
| **tmux 存在时墓碑不挡任何 open**：attach-only 只看 has-session；create 命中墓碑但 tmux 在则 attach | `webTerminal.ts:1945-1971` |
| auto-restore 冷建走 daemon 内部 `tmux new-session -d`，不经 open 守卫，不打 manual 标记 | `webTerminal.ts:1756-1790` |
| `lastSeenInfo` 只存 title/cwd（`noteSeen` 丢了 `manual`/tags）；list 行已解析 `@vh_title_manual` 与 `@vh_tags`；`validateTerminalTags` 存在 | `webTerminal.ts:1295,1505-1508,690-698,2825-2841` |
| closed 记录三处白名单：CLI `sanitizeClosedTerminals`、`ClosedTerminalRecordSchema`（默认 strip）、web `closedTerminalsOf` | `closedTerminals.ts:98-125`、`api/types.ts:201-224`、web `closedTerminals.ts:56-78` |
| web 终端 `remove` overlay 最长藏行 30 s；`WebTerminalScreen` 对无 meta 的 tid 可 attach | `terminalPushOps.ts:90,159-161,208-213`、`WebTerminalScreen.tsx:173-178` |
| `resumeSupport` 在 `MachineMetadataSchema`（web 侧严格 zod 会 strip）；`daemonState` 在 web 是 `any` 透传，且 connect 时整体前传、带 `startedAt` | `api/types.ts:157-163`、web `storageTypes.ts:209-249`、`apiMachine.ts:874-884` |
| tags 跨设备链路已合入（#58）；B-216 backlog 行「doing」已过期，无并行 worktree | `git log 4491b756`、`git worktree list` |

## 设计

### A. 对话恢复（P0）

**A1 server + wire（必需——是区分「归档」与「离线」的唯一判据）**
- `GET /v1/sessions` 投影加 `archivedAt: number | null`；web `Session` 类型、`fetchSessions` 映射、`storage.applySessions` 全部带上（否则全量 fetch 会抹掉）。
- happy-wire `UpdateSessionBodySchema` 加 `archivedAt: z.number().nullable().optional()`（web 的 `ApiUpdateSessionStateSchema` 来自 wire，默认 strip）。
- archive / unarchive 两个路由各 emit 一条 `update-session`（只带 `archivedAt`，不带 metadata/agentState；`allocateUserSeq` 分配 seq；
  recipientFilter `user-scoped-only`，不去戳正在退出的 CLI）。web 处理器：有 `archivedAt` 就写 store；顺手修存量 bug——`update-session` 不再把 user-level update seq 覆盖进 `session.seq`（`sync.ts:2619`，`sessionModeSync` 依赖该字段）。
- 新增 `GET /v1/sessions/:id`（同列表投影 + `seq` + `archivedAt`；`where {id, accountId}`），供 daemon/CLI 按 id 取 metadata、版本与当前 seq（摆脱 150 条上限）。
- 注：CLI 所有 cleanup 路径（含终端里 Ctrl-C）都 `POST /archive`，所以「Ctrl-C 结束的会话」也是 `archivedAt != null`——会显示恢复入口且可恢复（外部启动会话 webhook 带 encryption）。真正的「暂时离线」只剩 10 min 心跳超时。

**A2 web 恢复流**（新模块 `app/sessionRestore.ts` = 纯函数 + 薄 zustand store，按 sessionId 记 `{phase, startedAt, error, pendingText}`）
- `restoreEligibility(session, machines)`：`not-archived`（`archivedAt == null`）| `no-machine` | `machine-offline` |
  `unsupported-flavor` | `no-backend-id` | `{ok:true}`。**恢复入口只对 `archivedAt != null` 显示**。
- `restoreSession(id)`：`releaseSessionInactive(id)`（RPC 前）→ `phase:'spawning'` →
  `machineResumeSession`（现成；`commitSessionResume` 先把 `{error}` 规范化为 `{type:'error', errorMessage}`；machineRPC `timeoutMs: 35_000`，
  UI 15 s 后提示「机器未响应…」）→ 成功 `phase:'awaiting-online'`；失败 `phase:'failed', reason`。
- **就绪判据**：`presence==='online'` 持续 2 s（presence 只来自 CLI keepAlive → server ephemeral → web 2 s 去抖，恢复流**不**乐观置 active）。
  新 CLI 下 socket connect 后任何 seq > N 的消息都会被正常拉取/路由（A4.3），所以 online 即可发；旧 CLI 残留「首拉全史期间」窗口，接受。
  `awaiting-online` 超时 30 s → `failed:'timeout'`（文案：恢复未确认，稍后重试；若行已变绿可直接用）。
- 回滚语义：沿用 `commitSessionResume`（任何失败都 re-archive）。已知代价：webhook 超时（15 s）/daemon 中途重启时可能杀掉一次已成功的启动；
  或子进程随后 `reactivateSession` 自行复活（web 显示失败但行变绿）。两者都收敛到一致状态，接受并写进验收「异常路径」。
- 去抖：`phase ∈ {spawning, awaiting-ready}` 时入口禁用；跨 tab 不同步 store，靠 daemon 幂等（A4.1）。
- 入口：归档行主按钮（↻）+ 行菜单「恢复」；`SessionArchivedBanner`（详情页 `archivedAt != null && !mirror`：已归档 · [恢复] / 恢复中… / 失败原因 + 重试）；
  命令面板：当前会话 `archivedAt != null` 时「恢复当前会话」替换「归档当前会话」。
- 侧栏 order/pins prune 的 `valid` 集合改为「store 里所有会话（含归档）+ 活终端 + closed 记录里的终端 id」——否则恢复后顺序/置顶已被删。

**A3 归档会话里发送**（纯函数 `composerGate(session) → 'send' | 'restore-first'`；**复用既有 `queuedMessages` 队列**，不另起 pendingText）
- `archivedAt == null` → `'send'`（现状不变，含离线会话）。
- `archivedAt != null` → `'restore-first'`：composer 上方 notice「已归档 · 恢复后继续」；发送 = 入既有队列（文本持久化、附件内存态——刷新丢附件是队列现状）+ `restoreSession`。
- 队列释放判据改为纯函数 `canReleaseQueuedMessage(phase, isWorking, gate)`：`gate==='restore-first'` 或恢复进行中一律不释放；会话就绪（`archivedAt==null && presence online`）后由既有释放 effect 发出
  （effect deps 必须加 `gate`——归档会话 `isWorking` 恒 false，否则 gate 翻转不重跑；直发 handler 与 `sendQueuedItem` 都要按 gate 分支入队，不只 `canSend`）。
  这一条同时堵住现状 bug：归档会话 `isWorking=false`，旧队列会把消息直接 POST 进黑洞。
- 任何情况下不向 `archivedAt != null` 的会话写 server 消息（`canSend` 也看 gate）。

**A4 CLI（v0.2.92）**
1. `resumeSession` 幂等：`Map<sessionId, gate>`（`createSpawnGate` 是单槽，需按 key 建）；gate 内先查 `pidToTrackedSession` 中该 `happySessionId` 且 **`isPidAlive(pid)`** → 直接 `{type:'success'}`（外部启动会话退出不触发 `onChildExited`，死 pid 会留 60 s，必须探活；死 pid 顺手 `onChildExited`）。
2. 前置检查带固定前缀 `resume-precheck:<reason>`：`not-tracked`（含 14 天过期）| `no-encryption` | `no-backend-id` | `unsupported-flavor` | `missing-cwd` | `conversation-missing`（claude：`getProjectPath(path)/<uuid>.jsonl` 不存在；uuid 先按 `isClaudeSessionId` 校验）。`permissionMode` 过 `sanitizeSpawnPermissionMode`；`model` 过 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`，不匹配丢弃并 warn（今天原样进 argv，可被写成另一个 flag）。
3. 重连消息语义——**由 CLI 自己在一次 `GET /v1/sessions/:id` 里取 `seq` + metadata + metadataVersion**（`api.getSession(id)` 新增；用 `HAPPY_RECONNECT_ENCRYPTION_KEY` 解密），
   对 claude / codex 两条 reconnect 分支同改；daemon 侧不再另取 seq（`HAPPY_RECONNECT_SEQ` 保持现状，不再被信任为 lastSeq 真值）：
   - GET 成功：`lastSeq = server.seq`，**不调用** `skipExistingMessages()`；`ApiSessionClient` 构造器加**可选** `initialSeq` 入参，**只有 reconnect 路径传**
     （offline 重连用同一 tag 重试 `getOrCreateSession`，若无条件 `lastSeq = session.seq` 会跳掉期间 web 发的消息）。GET 同时带回 `agentState/agentStateVersion` 一并初始化（`HAPPY_RECONNECT_AGENT_STATE_VERSION` 同样陈旧）。
   - GET 404/401/403（旧 server）→ 立即退回今天的 `skipExistingMessages()` 全史跳过语义；网络/超时/5xx → 重试 3 次（0.5 s/1.5 s 退避，单次 4 s）再退回并 `logger.warn`
     （瞬断 + 立即连上 + 长会话时 skip pass 可超 2 s，丢的正是本 spec 要救的那条消息）。单测：首次 ECONNRESET、第二次成功 → 不 skip。
   - 这条规则必须对**所有** `HAPPY_RECONNECT_*` 发起路径成立：`resumeSession`（`run.ts:920`）与 daemon 重启后的 assistant 再附着（`run.ts:395-420`，其 env seq 是 webhook 时的陈旧值），否则会把自启动以来的全部用户消息当新消息重放给 claude。单测：env seq 陈旧 + server seq 真值 → 历史不路由。
   - socket `new-message` 的直路由门从 `lastSeq === 0` 改为 `initialFetchDone` 标志；`fetchMessages` 非 skip 分支按 `routedInboundLocalIds` 去重——否则首拉在途时到达的 N+1 会被路由两次。单测：预置 N + 并发 socket N+1 + 首拉返回 N+1 → 恰路由一次；并加「首拉在途 + CLI 自身 POST」用例钉住现状（`flushOutbox` 抬 lastSeq 的存量丢消息 bug 记 backlog，本期不恶化）。
   - `skipExistingMessages` 方法本身保留（`mirrorManager.ts:216,361` 仍用）。
   - 窗口：unarchive → CLI socket connect 首拉开始之间，由旧 web/其它设备直发的 seq ≤ N 消息会被跳过（新 web 不会发），写进矩阵。CLI 子进程自己也 `POST /unarchive`（`runClaude.ts:270`），A1 的 unarchive 事件会发两次，幂等无害。
4. 重连路径的 metadata 真值：用 A4.3 同一次 GET 的结果初始化 `this.metadata/this.metadataVersion`（404 → 保持本地，靠 version-mismatch 重试拉回）。
   **不得**把 server 端 metadataVersion 透传进 `HAPPY_RECONNECT_METADATA_VERSION`——今天首写必然 mismatch 才没用本地空壳覆盖 summary/tags/claudeSessionId，这是巧合不是设计。
   首写 handler = `(meta) => ({...meta, ...processIdentityFields(localMetadata), lifecycleState:'running', lifecycleStateSince, archivedBy: undefined, archiveReason: undefined})`——
   `meta` 是 handler 入参（mismatch 重跑时是 server 最新值），identity 来自闭包里的**本地** metadata 对象。
   `processIdentityFields` 固定列表：`hostPid/version/startedBy/startedFromDaemon/happyHomeDir/happyLibDir/happyToolsDir/capabilities/attachmentKinds/queueCancellation/sandbox/dangerouslySkipPermissions/os/host/homeDir/permissionMode`，
   **只拷贝本地非 `undefined` 的键**（codex 本地 metadata 没有 attachmentKinds/queueCancellation/capabilities/permissionMode，写 undefined 等于删 server 键）；codex reconnect 分支同样补发 `permissionMode`。
   反例断言（一律取 server）：`path/machineId/flavor/name/summary/tags/claudeSessionId/codexThreadId/terminalId/board/taskId/attention/tools/slashCommands/mcpServers/skills/models*/parentSessionId/forkedFromMessageId/variant`
   （reconnect 时 daemon env 无 `HAPPY_SPAWNED_BY`，本地 tags 为空，取 server 才不丢 'assistant' tag）。
   今天 mismatch 路径沿用旧进程的 `capabilities`/`version` 是存量缺陷，顺手修。单测：server 有 summary/tags/claudeSessionId 且 identity 取本地、undefined 不覆盖。
5. `fetchServerSessionMetadata` 优先 `GET /v1/sessions/:id`；resume 成功（webhook 回来）后 `persistSession` 刷新 `savedAt` + 把 server 侧 metadata（含 claudeSessionId）写回 sessions.json（**metadataVersion 字段维持 webhook 值**）；daemon 启动时对 live-recovered 会话同样 touch。14 天保留期不变，语义变为「自上次见活」。

**A5 错误 → reason 映射**（纯函数 `mapResumeError(text)`，单测覆盖新旧文本）

| daemon 文本 | reason | web 文案要点 |
|---|---|---|
| `resume-precheck:not-tracked` / 旧 `is not tracked by this daemon` | not-tracked | 机器上的恢复信息已过期或不在这台机器 |
| `resume-precheck:no-encryption` / 旧 `no stored encryption data` | not-tracked | 同上 |
| `resume-precheck:no-backend-id` / 旧 `missing its Claude session ID` / `Codex thread ID` | no-backend-id | 没有可续的 agent 会话 |
| `resume-precheck:unsupported-flavor` / 旧 `unsupported flavor` | unsupported-flavor | 该 agent 不支持恢复 |
| `resume-precheck:missing-cwd` / 旧 `ENOENT` | missing-cwd | 原目录不存在 |
| `resume-precheck:conversation-missing` | conversation-missing | 对话文件已不在机器上 |
| `RPC method not available` / `RPC target disconnected` / 超时 | machine-unreachable | 机器未响应，稍后重试 |
| 其它 | unknown | 原文 |

### B. 终端归档可恢复（P1）

**B1 daemon**
- `parseSessionListLine` 已解析 `manual`/`tags`，但 `TerminalListItem`（push 行）无 `manual` → 加 `manual?: boolean`（旧 web 不 strip、自算 manual，无害）；`lastSeenInfo` / `LiveTerminalInfo` / `ClosedTerminalRecord` 加 `tags?`、`manual?`，
  普通 close 与 daemon-gap 两条路径都带上。改动点清单：`webTerminal.ts` `lastSeenInfo` 类型、`noteSeen`、`trackClosures.next` 与 closed 记录、`reconcileRestoredSnapshot`、`persistLiveSnapshot`、`killSession`；`liveTerminals.ts` `LiveTerminalInfo`、`sanitizeLiveSnapshot`、**`liveSnapshotChanged`（tags/manual 变化也要触发落盘）**；
  `closedTerminals.ts` `sanitizeClosedTerminals`；`types.ts` 两个 schema；web `closedTerminalsOf`。tags 读回时过 `validateTerminalTags`。无新 tmux 调用。auto-restore（B-150）的候选/计划也带 manual/tags 走同一 `createDetachedTerminal`。
- 纯函数 `planTerminalRestore(record, {tmuxAlive, cwdExists, jsonlExists}) → {kind:'already-live'} | {kind:'error', reason} | {kind:'create', id, cwd, title, manual, tags, command?}`；
  `command` 只在 `isClaudeSessionId(record.claudeSessionId) && jsonlExists` 时为 `claude --resume <id>`（同 auto-restore 候选的 JSONL 前置检查）。
- 抽 auto-restore 冷建为共享 `createDetachedTerminal(plan)`（同一套 create-only env），增加 `manual` → 写 `@vh_title_manual`、`tags` → 写 `@vh_tags`。
- 新 RPC `restore-terminal {terminalId}`：`terminalId` 先过 `/^[a-zA-Z0-9_-]{1,64}$/`（同 setTitle/setTags；不匹配 → `error:'invalid-id'`，不查记录不碰 tmux）→ 查 closed 记录（无 → `error:'no-record'`）→ `planTerminalRestore` → 执行 → 成功 `kickListRefresh`
  （closed 记录由现有 `pruneClosedAgainstLive` 下一 tick 自动移除；**不删墓碑**——tmux 在时墓碑不挡 attach，删了反而让 7 天内旧客户端 legacy-create 复活）。幂等：`already-live` 也回 success。
- daemonState（`any` 透传；`MachineMetadata` 在 web 是严格 zod 会 strip）加 `terminalRestore: { rpcAvailable: true, detectedAt }`，daemon 每次 connect 与 `webTerminals.updatedAt` 同一写刷新 `detectedAt`；
  web 只信 `detectedAt >= daemonState.startedAt`（同 `trustedWebTerminals` 规则），否则 CLI 降级后旗标随 daemonState 前传残留。
- `kill-terminal` 不变。

**B2 web**
- `ops.machineRestoreTerminal(machineId, terminalId) → {ok:true} | {ok:false, reason:'unsupported'|'no-record'|'missing-cwd'|'error'}`；
  **是否支持看 daemonState 标记，不靠错误串**（避免 15 s 空等）；`RPC method not available`/`Method not found` 只作兜底 → `unsupported`。
- 归档行主按钮：机器在线且标记可信 → `machineRestoreTerminal`；成功 → `useTerminalSessions.adopt(id, {machineId, title, tags})`（新接口：带 id 的 `created` overlay，与 `create()` 同 TTL，让行立刻出现且 push 到达前不闪回机器名，
  并顺手删 `overlay.removed[id]`——关→恢复落在同一 push 周期内时它还在，会藏行 ≤30 s；**不**写 `renames`，`pruneOverlay` 会把 push 里不存在的 id 剪掉）。恢复行按 tmux 新 `created` 时间落在侧栏顶部（旧 order 条目已被 prune，接受）→ `navigate('/terminal/<m>?tid=<id>')`（attach 路径，tmux 已在）；
  `unsupported`/无标记 → 现有 `createTerminalAt(cwd, claudeSessionId)`；`no-record`/`missing-cwd`/`invalid-id` → alert。
- 行副标题显示 tags chip（复用现有渲染）。
- `terminal.closeMessage`：「终端会移入归档，可从归档恢复（同目录、同标题、同标签）；有 agent 会话记录时会自动 `claude --resume` 接回；屏幕内容不保留。」

### 被否方案

- 恢复 = 新建会话 + `resumeClaudeSessionId`（fork 路径）：产生第二个 happy session、历史分家、侧栏双行；原地复活已有且保 id/URL。
- 发送时先写 server 再恢复：消息被 skip 或堆在 server 无人处理。
- 用 `lifecycleState==='running'` 当就绪判据：服务器上多半本来就是 running，任何 metadata bump 都会误判。
- 专用 `metadata.resumeReadyAt` 就绪标记（v2）：lastSeq 预置 + 去掉 skip + 首拉门控后，connect 之后的消息都不会丢，presence online 已足够；web `MetadataSchema` 是严格 zod 还得加字段，砍。
- 另起 `pendingText` store（v2）：与既有持久化队列并行两套机制互不知情，砍，改队列释放判据。
- 恢复走 `open-terminal fresh=1` 复用旧 id：无 title/tags 回写、无幂等语义、与 open 守卫纠缠。
- 靠 `Method not found` 探测旧 daemon：未注册方法在 server 侧要等 15 s。
- 删墓碑：无必要且回退 B-149 的安全修复。
- 把 closed 记录搬到 server：更好但要新表+迁移，另立项。
- `SESSION_MAX_AGE_MS` 拉长：不解决真因（claudeSessionId 未回写 + 150 条上限），只让文件变大。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 server | 无 `archivedAt` → 全部视为「未归档」：不显示恢复入口、composer 不拦截（= 现状）；`GET /v1/sessions/:id` 404 → daemon/CLI 回落列表 |
| 新 web + 旧 CLI（≤0.2.91） | 对话恢复可用（RPC 早已存在）；无幂等 gate → web 去抖兜底，双端同点可能双开（老 bug，新 CLI 修）；skip pass 拉全史期间发的消息可能丢（会话越长窗口越大，秒级）；旧错误文本走回退映射；无 `terminalRestore` 标记 → 终端退回新终端，零延迟 |
| 旧 web + 新 CLI/server | `update-session` 多出的 `archivedAt` 被 wire zod strip（处理器对无 metadata 的 update 已有回落，不清空）；唯一可见变化是归档会话 `updatedAt` 被 bump；`tags`/`manual`/`terminalRestore` 被白名单忽略；新 RPC 无人调 |
| 新 CLI + 旧 server | `GET /v1/sessions/:id` 404 → 回落列表/0；unarchive→GET 窗口内其它设备直发的 seq ≤ N 消息被跳过 |
| 回滚 | web 回滚：入口消失、store 是内存态；CLI 回滚：记录多出的字段被旧 sanitize 丢弃；server 回滚：投影字段消失，web 退回「未归档」视角 |

发布顺序：wire build → server → web → CLI（v0.2.92）→ `vh-update`。P0 在 server+web 发布当天可用（旧 CLI 有上表的残留竞争）。

## 风险

1. 恢复后消息被 skip → `lastSeq` 从当前 seq 起 + `resumeReadyAt` 判据 + 不向归档会话直写；旧 CLI 残留秒级窗口，接受并写明。
2. 双击/多端同时恢复 → web 去抖 + daemon in-flight gate + live-pid 幂等。
3. 回滚杀掉一次成功启动 / 子进程自行复活 → 状态自洽（要么归档要么活），接受。
4. claude 起来即退（JSONL 被删/cwd 没了）→ 前置检查；旧 CLI 靠超时报错。
5. `claude --resume` 内存（≈400MB/个）→ 只逐个点。
6. closed 记录里的 tags/title 来自本机文件 → 写回前 `validateTerminalTags`、title 走既有 `setTitle` 路径。
7. `restore-terminal` 与 `killSession` 竞争同一 id → 两者都以 tmux `has-session` 为真值，planTerminalRestore 幂等。
8. 侧栏 prune 放宽 → order/pins 条目寿命变长（上限已有），接受。
9. `isPidAlive` 的 pid 60 s 内复用误判 already-live → web 超时且不回滚，留下 unarchived+offline（用户可再归档/重试）。概率极低，接受。

## 验收标准

- [ ] wire：`UpdateSessionBodySchema.archivedAt` 可选；server：`/v1/sessions` 与 `/v1/sessions/:id` 返回 `archivedAt`/`seq`；archive/unarchive 各 emit 带 `archivedAt`、有 user seq 的 `update-session`（spec 测试）
- [ ] web：`sessionRestore.test.ts` 覆盖 eligibility 全部 reason、online-2s 就绪、两段超时、`{error}` 规范化、A5 映射表新旧文本
- [ ] web：`composerGate` 两态；`canReleaseQueuedMessage` 带 gate（归档会话不释放，就绪后释放）；归档会话发送不写 server（回归：现状队列直发黑洞）
- [ ] web：`update-session` 不再覆盖 `session.seq`（回归）；`archivedAt` 经 fetch/diff/update 三条路径进 store
- [ ] web：三个入口共用 `restoreSession`；离线未归档会话**不**被拦截、不显示恢复（回归）
- [ ] web：order/pins 对归档会话不 prune（回归）
- [ ] web：`closedTerminalsOf` 解析 `tags`/`manual`；`machineRestoreTerminal` 按标记分流（旧 daemon 不发 RPC）
- [ ] cli：`resumeSession` gate/`isPidAlive` 幂等/前置检查前缀/sanitize 单测；`lastSeq` 预置 + 首拉门控 + 去重单测（N+1 恰路由一次）；重连首写不丢 server 字段单测；`planTerminalRestore` 单测（含 JSONL 缺失不注入）；`restore-terminal` isolatedTmux 集成（同 id/title/manual/tags/幂等/墓碑保留/invalid-id）
- [ ] 门禁全绿 + `--version` 冒烟
- [ ] 异常路径手测：webhook 超时后的回滚 → 会话回到归档态（daemon 重连时 `reconcileArchivedSessions` 也会杀掉子进程，可作证据）；双端同点只起一个进程
- [ ] 真机：归档 → 恢复 → 续聊（新 CLI）；关闭终端 → 恢复 → 同 id/标题/标签 + claude 续上

## 留真机验证项

- 详情页 banner 状态切换与侧栏行变绿的观感；恢复后 order/pins 保持
- 终端恢复后 xterm 首帧、手动标题不被覆盖、tags chip
