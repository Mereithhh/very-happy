# Codex wrapper 对齐 Orca 第二批：轮中插话、子 agent 归属、进程树回收

- 状态：Implemented（本 PR）；发布后改 Shipped
- 关联 backlog：B-628（承接 B-625 spec 的三条「非目标」）
- 包：`packages/happy-cli`（`src/codex/codexAppServerClient.ts`、`runCodex.ts`、`utils/sessionProtocolMapper.ts`、
  新增 `codexChildThreads.ts`、`codexProcessTree.ts`）、`packages/happy-wire`（常量 `CODEX_STEER_CAPABILITY`）、
  `packages/happy-web-v2`（`screens/session/steerSupport.ts`、`AgentInput.tsx` 一行）
- 参照：stablyai/orca `src/main/codex/`（MIT；只借做法，不拷代码）：
  `codex-structured-turn-start.ts`（steer）、`codex-structured-turn-open-wait.ts`（等轮打开 5 s）、
  `codex-subagent-activity.ts` / `codex-collab-agent-tool-call.ts` / `codex-subagent-linkage.ts`（子 thread 归属与命名）、
  `codex-app-server-process-tree-kill.ts`（进程树）

## 背景

B-625 把一轮的开始/结束按 thread 作用域修好后，还剩 Orca 做了、我们没做的三件事：

1. **轮中插话**。网页在 agent 干活时发的消息只能排队到下一轮（B-509），而 Codex app-server 自 0.148 起有
   `turn/steer`：把消息追加进正在跑的这一轮，模型在下一次调用前就读到。Claude 会话早有同样的能力
   （`claude-steer-v1` + `meta.delivery === 'steer'`），Codex 会话的网页上没有「插话」按钮。
2. **子 agent 的 item 扁平进主对话**。`spawn_agent` 开出的子 thread 和主 thread 共用一条 stdout；
   B-625 只隔离了生命周期帧，子 thread 的 `item/*`（命令、消息、补丁）仍被当成主 agent 自己做的渲染，
   读者分不清谁做了什么；子 thread 的 `thread/tokenUsage/updated` 还会覆盖会话自己的上下文用量。
3. **停 app-server 只杀根进程**。npm 装的 `codex` 是 node 启动器 + 原生子进程（启动器转发 SIGTERM，但
   SIGKILL 没人能转发）；Windows 下 cross-spawn 经 cmd.exe 跑 `codex.cmd`，`proc.kill()` 只终结 cmd.exe，
   node 与原生 app-server 成游离进程。

## 目标

- 网页上 Codex 会话排队中的消息有「插话」，点了就进当前轮；Codex 接不了时退回排队，行为与今天一致。
- 子 thread 的 item 归到它自己的子代理卡片（复用现有 session protocol 的 `subagent` 信封，与 Claude Task
  子代理同一套网页 UI），卡片标题是它领到的任务，子 thread 自己的 `turn/completed` 收卡。
- 强制停止 app-server 时把启动器的直接子进程一起收掉；Windows 用 `taskkill /T`。

## 非目标

- 子 thread 的 reasoning / mcpToolCall 在 v2 raw 模式下本来就不转发，不在本项补。
- 孙 thread（子 agent 再 spawn）只按它自己的 thread id 归属，不画层级（wire 只有一级 `subagent`）。
- 杀 app-server 自己起的 shell 命令（孙进程）：Orca 也只到直接子进程，app-server 自己回收。

## 现状事实（代码已确认）

- codex 0.154.0：`turn/steer` 参数 `{threadId, expectedTurnId, clientUserMessageId?, input}`，应答 `{turnId}`
  （`app-server-protocol/src/protocol/v2/turn.rs` `TurnSteerParams`，无 `deny_unknown_fields`）；拒绝都是
  -32600 invalid_request：「no active turn to steer」「expected active turn id `x` but found `y`」
  「cannot steer a review/compact turn」（`app-server/src/request_processors/turn_processor.rs turn_steer_inner`）。
  没有该方法的旧版回 -32601。Codex 在收任何 input 之前就拒绝（expectedTurnId 是前置条件），所以非 `steered`
  的结果一律等于「没送进去」。
- 被 steer 的 input 进 `pending_input`，模型下一次调用前取走，并以 `item/completed` 的 `userMessage`
  （带 `clientId` = 我们的 `clientUserMessageId`）回显（`v2/item.rs ThreadItem::UserMessage.client_id`）。
  这一轮被打断/失败时未回显的 input 不会被这一轮读到（Orca：「that turn ending unechoed withdraws it」）。
- `turn/start` 在飞但 `turn/started` 未到时 steer 会被拒（no active turn）；Orca 等轮打开最多 5 s
  （`CODEX_TURN_OPEN_WAIT_MS`）。
- 网页：`AgentInput.tsx` 已有 `delivery: 'queue' | 'steer'`，排队行的「插话」按钮 = 从队列（本地或服务端
  prompt-queue）取下后以 `delivery:'steer'` 直接发送；`supportsSteer` 原来写死 Claude + `claude-steer-v1`。
  steer 发送不带 `queuedAt`。
- 网页：session protocol 的 `subagent`（cuid2）信封 + `{t:'start', description?}` / `{t:'stop', status?}`
  已被 reducer 做成子代理卡片（`typesRaw.ts normalizeSessionEnvelope`、`reducer.ts` 'subagent' 事件合并，
  `subagentSummary.ts` 用 `description` 作标题）。Codex mapper 已有 provider-subagent → cuid 的映射与
  `start`/`stop` 发射（`sessionProtocolMapper.ts maybeEmitSubagentStart`），只是 client 从不给 item 事件
  标 `subagent`。
- Codex 命名子 agent 的两种 item（Orca 对 0.152–0.155 实测）：`collabAgentToolCall` `spawnAgent` 结束时
  `receiverThreadIds` 才有子 thread id，旁边是 `prompt`；`subAgentActivity` 带 `agentThreadId` + `agentPath`
  （`/root/list_directory`，叶子是唯一标签，`/root` 是主轮自己）。
- 本机实测（macOS，npm 装的 codex 0.154.0）：SIGKILL 启动器后原生 app-server 1.5 s 内自行退出；Windows
  没有实测（无机器），按 cross-spawn 与 cmd.exe 的既知行为处理。
- 仓内已有 `taskkill /T /F` + 进程组杀的先例（`worktree/setupRunner.ts`、`update/npmInstall.ts`）。

## 设计

### 1. 轮中插话（`turn/steer`）

- wrapper 在 session capabilities 加 `codex-steer-v1`（happy-wire `CODEX_STEER_CAPABILITY`）。
- `runCodex` 的 `onUserMessage`：`meta.delivery === 'steer'` 且不是 `/clear` → `steerIntoRunningTurn`：
  只在 `turnActive && !abortInProgress && !shouldExit` 时尝试；附件先 stage，图片走 `localImage`，其余并进
  文本；`client.steerTurn({text, images, clientId: localKey})`。`steered` → 结束；其它结果 → 删掉 stage
  的副本、照旧 `enqueueCodexUserText`（下一轮，B-509 语义不变）。这条消息带来的 model/effort/permissionMode
  已经写进 current*，从下一次 `turn/start` 起生效（Claude 的 steer 同样保留运行中的 model）。
- `CodexAppServerClient.steerTurn`：
  - `steerUnsupported`（该进程收到过 -32601）→ `unsupported`，不再发请求；respawn 时清零（codex 可能升级了）。
  - 等待轮打开（`turn/started` 已到且有 `_turnId`）最多 5 s（`waitForTurnOpen`，`markPendingTurnStarted` /
    `resolvePendingTurn` 释放）；超时或轮已结束 → `no-turn`。`pendingInterrupt` 在飞 → `no-turn`。
  - 发 `turn/steer {threadId, expectedTurnId: _turnId, clientUserMessageId, input}`；成功记
    `steeredAwaitingEcho[clientId] = turnId`。
  - JSON-RPC 错误：-32601 → `unsupported`（记住）；其它带 code → `refused`；传输错误 → `failed`。
    `request()` 的拒绝错误现在挂 `jsonRpcCode`。
- 回显：own thread 的 `item/completed` `userMessage.clientId` 命中 → 从 `steeredAwaitingEcho` 删除；不渲染
  （用户消息网页已有）。
- 这一轮**非正常结束**（interrupted / failed / 看门狗放弃 / 进程退出 / disconnect / clearThreadState）时仍未回显的 →
  事件 `steer_dropped {client_ids}` → runner `sendQueueCancelReason(ids, 'aborted')`，网页按 B-332 把该消息
  标为「aborted」可见，而不是看起来已答复。一轮 **completed** 却未回显：Codex 在结束前会取尽 pending input
  （`core/src/session/turn.rs`），所以这只可能是某个接受 steer 但回显不带 `clientId` 的 codex 版本——只记 debug
  不报，宁可漏一次「未送达」也不把模型读过的消息标成没送达（review 发现 3）。

### 2. 子 thread 的 item 归子代理卡片

- client：`childItemFields(params)` = 帧的 `threadId` 不是自己的 → `{subagent: <childThreadId>, subagent_label?}`，
  附在 `exec_command_begin/end`、`patch_apply_begin/end`、`agent_message`、`collab_agent_item` 事件上。
  标签来自 `codexChildAnnouncements`（`codexChildThreads.ts`）：spawnAgent 的 prompt 头 ≤80 字一行，或
  `agentPath` 叶子；最多记 128 个。
- 子 thread 的 `turn/completed` → 事件 `subagent_turn_end {subagent, status}`。
- 子 thread 的 `thread/tokenUsage/updated` 不再转发（它是每 thread 的累计值，会盖掉会话自己的）。
- mapper：`maybeEmitSubagentStart` 带 `description: label`；名字晚于子 thread 第一条 item 到达时（父的 spawn 调用
  结束才带 receiverThreadIds，而子 thread 已在跑）对已开卡的子代理补发一次带 `description` 的 `start`
  （`labeledSubagents` 状态；网页 reducer 取较新事件的字段，status 仍 running）；`subagent_turn_end` → 对已 active 的子代理发
  `{t:'stop', status}` 并从 started/active 移除（同一子 thread 下一轮再来 item 会再发 `start`，cuid 不变，
  网页 reducer 以较新事件为准）；`collab_agent_item` 带 `subagent` 时嵌进子卡片。主轮结束仍对所有 active
  子代理兜底发 `stop`（原逻辑）。

### 3. 进程树

- `codexProcessTree.ts`：`stopCodexProcess`（POSIX：stdin EOF + SIGTERM；Windows：只 stdin EOF，因为
  `kill` 只会终结根 cmd.exe 让树游离）；2 s 后 `killCodexProcessTree`：Node 已见到退出（`exitCode`/`signalCode`
  非空）则不动——pid 可能已被复用；pid 只用于回收直接子进程，且只在 Node 仍持有活 ChildProcess 时（没有
  `exitCode` 字段的句柄只走根 kill）；根一律经 `proc.kill('SIGKILL')`（退出后是 no-op）。POSIX
  `pkill -KILL -P <pid>` 再杀根；Windows `taskkill /pid <pid> /t /f`，起不来或非 0 退出则杀根。
- `disconnectInternal` 改用这两个函数（空闲释放、强制重启、退出三条路径共用）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web × 新 CLI（≥0.2.176）× codex ≥ 0.148 | 排队消息有「插话」→ `turn/steer`；子 agent 卡片；进程树回收 |
| 新 web × 新 CLI × codex < 0.148（无 turn/steer） | 第一次插话得 -32601 → 该进程内不再尝试，消息照旧排队到下一轮；按钮仍在（网页只认 capability） |
| 新 web × 旧 CLI（≤0.2.175） | 无 `codex-steer-v1` → 没有插话按钮，与今天完全一致；子 agent 仍扁平 |
| 旧 web × 新 CLI | 旧 web 不会给 Codex 发 `delivery:'steer'` → steer 路径不触发；子代理 `start/stop` 信封旧 web 本来就会渲染（Claude 子代理同一协议）；`description` 是既有可选字段 |
| 任何 web × 新 CLI × legacy `codex/event` 的 codex | 无 raw item 帧 → 不标 subagent；steer -32601 → 排队 |
| 服务器 | 无改动；`queue-cancel reason='aborted'` 是既有 B-332 信封 |

发布顺序：web 与 CLI 互不依赖（网页按 capability 显示，CLI 不要求新 web）。按 PROCESS 默认先 server/Web
（`deploy-hwsg.yml rollout=switch`）后 CLI（tag v0.2.176 → publish → promote）。运行中的老 wrapper 要
「重启会话」才换代码。

## 风险

- 插话后立刻「停止」：消息未被模型读到 → 标 aborted，用户需重发（与 Orca 一致；不自动重发，避免
  重复执行）。
- codex 某版本 `turn/start` 在飞超过 5 s 才 `turn/started`（如 B-461 释放后的冷启动）：插话退回排队，不丢。
- Windows 的 taskkill 路径无真机验证（登记 V-181 ④）。
- 子 thread 第一条 item 之前的 spawnAgent 若因历史压缩没见过，卡片无标题（通用「子代理」），仍归属正确。

## 验收标准

- `codexAppServerClient.test.ts` B-628 六例：steer 参数形状 + 回显不报丢；等轮打开再 steer、打断后报
  `steer_dropped`；拒绝/不支持的分类与记忆；看门狗放弃的轮报丢、completed 无回显不报；不带 threadId 的帧不打标且
  tokenUsage 照转；子 thread item 带 subagent 与标签、子轮结束事件、子 tokenUsage 不转发。
  `sessionProtocolMapper.test.ts` B-628 八例（含名字晚到补发、父轮结束兜底 stop 与下一轮新 id）。
  `codexSteer.test.ts`（runner 的 steer-or-queue 可执行用例）、`codexChildThreads.test.ts`、
  `codexProcessTree.test.ts` 纯函数。`__tests__/codexSteerWiring.test.ts` 源码断言（mutation-check）。
  web `steerSupport.test.ts`。
- CLI/web 门禁全绿；design-lint 零新增。

## 留真机验证项

- V-181：真实 Codex 会话插话（见 verify-queue）、插话后停止的标记、真实 spawn_agent 子卡片、Windows 停止后无游离 codex 进程。
