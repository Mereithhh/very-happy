# Claude Code wrapper 对齐 Orca：轮结束判据、退出原因、重试可见、控制请求截止、Stop 回收插话

- 状态：Shipped（PR #568 → `main@ddc0bd458`，CLI v0.2.177；真机项 V-182）
- 日期：2026-10-19 ｜ 关联 backlog：B-631（承接 B-625 / B-628 的 Codex 同批思路）
- 包：仅 `packages/happy-cli`（`src/claude/claudeRemote.ts`、`claudeRemoteLauncher.ts`、`claudeLocalLauncher.ts`、
  `turnSteering.ts`、`runClaude.ts`、`session.ts`、`sdk/query.ts`、`utils/permissionHandler.ts`；
  新增纯函数模块 `claudeTurnEnd.ts`、`claudeCommandLifecycle.ts`、`claudeProcessExit.ts`、`claudeSystemNotices.ts`、`utils/withTimeout.ts`）
- 参照：stablyai/orca `src/main/claude/`（MIT；只借做法，不拷代码）：`claude-session-state-turn-over.ts`、
  `claude-structured-journal-translation.ts:796-804`、`claude-open-turn.ts`、`claude-stream-json-connection.ts:116-133`、
  `claude-api-retry-row.ts`、`claude-informational-row.ts`、`claude-agent-sdk-control-requests.ts`、
  `claude-structured-control-actions.ts:26-63`、`claude-command-lifecycle.ts`、`claude-structured-launch-resolution.ts:33`

## 背景

B-625/B-628 把 Codex wrapper 对照 Orca 修了一遍。Claude 这边的 wrapper 有同形的五处：

1. **没有 `result` 的轮永远「在跑」**。thinking 只在 `result` 和 Query 结束时翻 false，下一条消息只在 `result` 后派发；
   Claude Code 自己有权威的轮结束信号 `system/session_state_changed state=idle`，我们既没启用也没读。
2. **进程退出原因被吞**。SDK 抛出的错误已经带 `exited with code N. stderr: …`，launcher 却固定写
   `Process exited unexpectedly`，turn-end 不带 `error`。
3. **重试与警告不可见**。`system/api_retry`（HTTP 529/429 退避）和 level=warning 的 `system/informational`（hook 拦截理由）
   在 `OutgoingMessageQueue` 被整类丢掉，用户只看到转圈。
4. **控制请求无截止**。stop 按钮先 `await interrupt()`、推下一条前 `await setModel()`、live 切权限模式 `await setPermissionMode()`
   都没有超时；CLI 一旦卡住，停止按钮和 RPC 一起挂死。
5. **Stop 不回收已排队的插话；插话没有 uuid 不可追踪**。`interrupt()` 的回执被丢弃；steer 以 `priority:'now'` 推入但不带 uuid，
   被 Stop 扫掉时网页上仍像已送达。

## 目标

- idle 是轮结束的权威信号：有 `result` 时 idle 去重，没有 `result` 时 idle 关轮（completed，无判决）并派发下一条。
- 任何进程退出给用户一行可读原因（code/signal + stderr 尾），turn-end 带 `error`。
- api_retry 第一次就看得见，同一串重试不刷屏；warning 级 informational 落一条 session event。
- interrupt 8 s、setModel 30 s、setPermissionMode 15 s 有界；超时各走既有兜底（硬中止 / 沿用旧模型 / RPC 返回 error），
  且不假装请求没发出去：权限模式超时后向 SDK 补发旧模式，模型超时后下个边界无条件重发。
- 所有带 uuid 推入的用户消息（prompt 与插话）都被追踪；Stop 用 `interrupt({cancelQueued:true})`（能力存在时）或回执
  `still_queued` 逐条 `cancel_async_message`；被 CLI 确认「从未运行」的消息打 B-332 `queue-cancel reason=aborted` 墓碑。

## 非目标

- 进程树回收（Orca `claude-agent-sdk-exit-proof.ts`）、投递确认、下线模型自愈：留后续。
- 不改 server / web / wire schema；不改 `docs/backlog.md`、changelog。
- `priority:'now'` 插话在 Claude Code 2.1.296 上的「抢占」语义（见现状事实 ⑦）是既有行为，本项不改。
- 本地模式（`claudeLocal`，stdio 继承）拿不到 stderr 尾，只补 code/signal。

## 现状事实（代码已确认）

| # | 事实 | 位置 |
|---|---|---|
| ① | wrapper 跑的 Claude Code 是 SDK 自带的（manifest 2.1.296，init `claude_code_version: "2.1.296"`），不是用户机上的 `claude`（2.1.302）；我们不传 `pathToClaudeCodeExecutable` | `node_modules/@anthropic-ai/claude-agent-sdk/manifest.json`；探针 2026-10-19 |
| ② | init `capabilities`（2.1.296）：`interrupt_receipt_v1, interrupt_cancel_queued_v1, interrupt_send_now_v1, msg_lifecycle_v1, request_marker_lists_v1, sdk_mcp_tools_list_changed, sdk_mcp_manifests, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1` | 探针 `skills/tmp/vh-orca-lessons/b631-scratch/probe/run-*.log` |
| ③ | CLI 只在环境变量 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 置位时把 `session_state_changed` 发给消费者；SDK 默认替子进程设 `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`，CLI 据此发带 `sdk_host_only:true` 的同帧，SDK 内部消费后 `continue`，**不 yield** | CLI 二进制 `if(a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)ki({…})else if(a.CLAUDE_CODE_SDK_READS_SESSION_STATE)ki({…,sdk_host_only:!0})`；sdk.mjs `if("sdk_host_only"in e&&e.sdk_host_only===!0)continue`；Orca `claude-structured-launch-resolution.ts:33` 设同一变量 |
| ④ | 一轮的帧序（探针）：`session_state_changed running` → `command_lifecycle queued` → `started` → `system/init` → … → `result` → `command_lifecycle completed` → `session_state_changed idle`；进程启动到第一条消息之间**没有** idle；`requires_action` 不是结束（Orca 同判） | 探针日志；`sdk.d.ts:5925` |
| ⑤ | `command_lifecycle` 是**顶层** `type:'command_lifecycle'` 帧（不是 system 子类型）：`command_uuid`、`state ∈ queued/started/completed/cancelled/discarded/refused`、`uuid`、`session_id`；只对带 uuid 的命令发；不在 d.ts 的 `SDKMessage` 联合里 | CLI 二进制 schema `QF`；`sdk.d.ts:5383` |
| ⑥ | `interrupt({cancelQueued:true})` 运行时可用（d.ts 只声明 `interrupt()`），回执 `{still_queued:[], cancelled:[q1]}`，每个被扫掉的命令另发 `command_lifecycle cancelled`；正在跑的那条命令在 `result` 后也收到 `cancelled`。普通 `interrupt()` 回执 `{still_queued:[q1]}`，随后 `cancelAsyncMessage(q1)` 返回 **false**（drain loop 10 ms 内已 `started`，q1 作为独立一轮跑完）—— d.ts 对 `still_queued` 的「probing the queue after the interrupted result always loses the race」实测成立 | sdk.mjs `async interrupt(e){…cancel_queued…}`、`cancelAsyncMessage`；探针 `run-plain.log` |
| ⑦ | 我们的 steer（`priority:'now'`）在 2.1.296 上**抢占**了尚未输出文本的轮：原轮立刻 `result subtype=success terminal_reason=aborted_streaming`、原命令 `cancelled`，steer 作为新一轮 `started`→`init`；抢占轮的 result **后面没有 idle** | 探针 `run-cancel-queued.log +9189ms` |
| ⑧ | SDK 进程退出错误文案：`Claude Code process exited with code ${code}. stderr: ${tail}` / `Claude Code process terminated by signal ${signal}. stderr: …`，从 `for await` 抛出 | sdk.mjs `getProcessExitError` / `formatStderrTail` |
| ⑨ | thinking 只在 init（547）/ result（598）/ finally（706）翻；下一条消息只在 result 后派发（649）；`interrupt: async () => { await response.interrupt(); }`（452）丢回执；steer 不带 uuid（463-475）；`await response.setModel(...)`（662）无界；`withTimeout` 是模块私有（27） | `src/claude/claudeRemote.ts` |
| ⑩ | `doAbort` 先 `await turnSteering.interruptTurn()`（155，无界）再 `waitForThinkingToStop(4000)`；catch（795-807）固定文案、`closeClaudeSessionTurn('failed')` 不带 error | `src/claude/claudeRemoteLauncher.ts` |
| ⑪ | `ExitCodeError` 分支（135-147）只 `closeClaudeSessionTurn('failed')`、不发事件；signal 分支（148-150）固定文案 | `src/claude/claudeLocalLauncher.ts` |
| ⑫ | `steer()` / `interruptTurn()` 直接 `await interrupt()`，无截止 | `src/claude/turnSteering.ts:15-43` |
| ⑬ | `applyLivePermissionMode` 末尾 `await this.setPermissionModeCallback(mode)`（180）无界，失败会回滚 `permissionMode` 并抛出；RPC handler 抛错 → `{ error }`（铁律 17） | `src/claude/utils/permissionHandler.ts`；`src/api/rpc/RpcHandlerManager.ts:116-121` |
| ⑭ | 除 `task_*` 外 system 帧在出站队列整类丢弃；mapper 的 system 分支只做 task 生命周期 | `src/claude/utils/OutgoingMessageQueue.ts:12,128`；`utils/sessionProtocolMapper.ts:687-693` |
| ⑮ | `trySteer` 调用方手里有 `message.localKey`；`ClaudeSteerInput` 没有该字段 | `src/claude/runClaude.ts:1109-1125`；`session.ts:15-19` |
| ⑯ | `sendQueueCancelReason(localKeys, 'aborted')` 与 `sendSessionEvent({type:'message', message, kind?})` 已存在；web 的 message 事件 schema 声明 `kind: z.string().optional()` | `src/api/apiSession.ts:938,1124`；`packages/happy-web-v2/src/sync/typesRaw.ts:24-27` |
| ⑰ | 网页 localKey 经 B-528 已作 prompt 的 transcript uuid（`promptUuid` 只放行真 UUID） | `claudeRemote.ts:36-40`；`claudeRemoteLauncher.ts:200-209` |

## 设计

### 1. idle 是轮结束（`claudeTurnEnd.ts` + `claudeRemote.ts` + `sdk/query.ts`）

- `sdk/query.ts` 给子进程环境补 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`（操作者已显式设置则不覆盖）。这是帧能到我们手里的前提（事实 ③）；
  SDK 自己的 run-end 逻辑不受影响（两种变量它都处理）。
- 纯状态机 `createClaudeTurnTracker()`，区分「wrapper 已推」与「CLI 已宣告」（review 2）：
  - `pushed()`：我们把一条用户消息交给了 Query → `pending`。这还不是一轮：CLI 要先取走它。
  - `announced()`（`init`）与 `running` → `open`（幂等），清 `pending`。
  - `onResult()`：`open || pending` → 关闭并返回 true，同时 `idleOwed += 1`（这条 result 之后应有一个 idle）；都不是 → false（idle 已先关过，不重复）。
  - `onSessionState('idle')`：`idleOwed > 0` → 扣一次、返回 `duplicate`（正常 result 后的 idle）；否则 **`open`** → 关闭、返回 `end`（没有 result 的结束）；否则（含只 `pending`）`ignore`。
    CLI 的状态通知器有多个 idle 发射点且不做同态去重（prompt 结算 flipBackFromRequiresAction、task 状态订阅、decideIdleReport），
    一条多余的 idle 落在「wrapper 已推 N+1、CLI 尚未 running/init」的窗口里（现实触发：权限弹窗期间按 Stop 且队列有后续消息）
    不得把 N+1 关掉——只有 CLI 宣告过的轮才能被 idle 结束。
  - `onSessionState('running')`：`idleOwed = 0` 并打开。流里 `running(N+1)` 只会在 `idle(N)` 之后出现，所以到了 running 还欠着的 idle 永远不会来（事实 ⑦ 的抢占轮正是这种 result 没有 idle 的形状），清零即可。
  - `requires_action` → `ignore`（轮停在用户身上，不是结束）。
  - 为什么用计数而不是「idle 时 thinking 是否为 true」：`result(N)` 之后 wrapper 异步拉下一条并立刻 `thinking=true`，而 `idle(N)` 可能晚于这次 push 才被 for-await 读到；只看 thinking 会把 N+1 当成结束。计数只依赖流内顺序（result 先于它自己的 idle，idle 先于下一个 running），与 push 时机无关。
- `claudeRemote.ts`：
  - `result` 分支：`turn.onResult()` 为 true 才 `onReady(result)` + 拉下一条；timing 日志、/compact 完成通知照旧；OAuth 回收判定抽成 `recycleIfPoisoned(result?)`。
  - `session_state_changed`：`end` → `updateThinking(false)`、清 `isCompactCommand`、`onReady(undefined)`（launcher 现有逻辑按 completed 关轮、发 done 推送；若 stop 在飞则仍按 consumeInterrupted 关为 cancelled），然后**同样经 `recycleIfPoisoned()`**：本轮有 `authentication_failed` 的 assistant 帧就结束 Query（review nit 5：中毒的 Query 不能因为没有 result 就留下来重放错误），否则拉下一条。`duplicate`/`ignore` → 只记 debug。
  - 拉下一条改为单飞（`pullNextMessage`）：同一时刻只允许一个 `nextMessage()` 在等。今天两个 result（抢占场景）会挂两个等待者，把两条排队消息背靠背推进 CLI；B-509 语义是一轮边界一条。
  - mapper 不改：轮在 mapper 里由 launcher 的 `closeClaudeSessionTurn` 关（与 result 路径相同），idle 帧本身在出站队列被丢弃，不进 transcript。

### 2. 进程退出原因（`claudeProcessExit.ts`）

- `describeClaudeProcessExit(error)` 一行文案：`Process exited unexpectedly (code 1): <stderr 尾>` / `… (signal SIGKILL): <尾>` /
  `Process exited unexpectedly: <其它错误原文>` / `Process exited unexpectedly`。去 ANSI、折空白、尾部最多 400 字（更长保留**末** 400 字并以 `…` 开头）。
  识别 SDK 文案（事实 ⑧）与本地模式的 `ExitCodeError`（`Process exited with code: N`）/ `Process terminated with signal: SIGX`。
- 网页只显示一行（review 3）：web 会把失败 turn-end 的 `error` 渲染成一行（`reducer`/`typesRaw` 既有逻辑），而没有开轮时
  `closeTurn` 什么都不发（mapper `closeTurn` 的 `currentTurnId` 守卫）。`apiSession.closeClaudeSessionTurn` 改为返回「是否真发了 turn-end」，
  两个 launcher 只在它返回 false 时才发 `sendSessionEvent({type:'message', message, kind:'claude-process-exit'})`。
- `claudeRemoteLauncher` catch：`closeClaudeSessionTurn('failed', { error })` → 未开轮才发事件 → `session.onSessionError(message)`；EDE-only 噪音分支不变。
- `claudeLocalLauncher`：`ExitCodeError` 两条分支同上；signal 分支（本来就不关轮）的事件改为带 signal 的文案。

### 3. api_retry / warning 可见（`claudeSystemNotices.ts`）

- `describeClaudeApiRetry(frame)`：`Claude is retrying after HTTP 529 overloaded (attempt 2/10, next retry in 8s)`；`error_status` 为 null 时
  `Claude is retrying after a connection error (…)`；`error` 字段按 snake_case 转词（`rate_limit` → `rate limit`，`unknown` 省略）。
- `createClaudeApiRetryGate({ minIntervalMs: 60_000 })`：同一串重试（attempt 递增）只持久化首条，之后每 ≥60 s 再持久化一条；attempt 不递增视为新一串（Orca `createClaudeApiRetryRuns` 的判据）；轮结束 `reset()`。
  未持久化的尝试只进 Ink 状态行与 debug 日志。不借 StreamRelay 进度帧：wire 的 `status` 是枚举（`requesting|compacting`），加值会被旧 web 的 zod 整帧丢弃；而重试期间 SDK 本来就在报 `status: requesting`。
- `describeClaudeInformational(frame)`：仅 `level === 'warning'` 且有正文 → 正文（≤500 字）；`info/notice/suggestion` 是会话 chrome，不落行。
- 接线在 `claudeRemoteLauncher.onMessage`：`sendSessionEvent({type:'message', message, kind:'claude-api-retry' | 'claude-warning'})`。`kind` 是既有可选字段（事实 ⑯），web 可据此单独样式（本项不改 web）。

### 4. 控制请求截止（`utils/withTimeout.ts`）

- `withTimeout` 从 `claudeRemote.ts` 抽到 `utils/withTimeout.ts`（行为不变：输家的晚到拒绝已被处理）；超时抛 `TimeoutError`，
  让调用方分得清「CLI 拒绝了」和「CLI 没答、请求可能迟到落地」。
- `turnSteering`：`createTurnSteeringController({ interruptTimeoutMs = 8000 })`，`steer()`/`interruptTurn()` 都经 `withTimeout`；超时 = 抛错 →
  `doAbort` 现有 catch 走硬中止；`steer` RPC 返回 error。8 s 而非 3 s（review 7）：硬中止等于进程重启（新 transcript id，
  `doAbort` 自述的 restore 风险），CLI 刷 transcript / GC 卡几秒的情形应该等它，不该杀它。
- `claudeRemote` 推下一条前 `withTimeout(response.setModel(...), 30_000)`：超时进现有 catch → `modelSwitchFailureNotice` session event，沿用旧模型继续推；
  并置哨兵 `modelUnconfirmed`（review 4）：迟到的 `set_model` 可能已落地而 `mode.model` 仍是旧值，于是**下个边界无条件重发**该轮想要的模型
  （即便与上一轮相同），成功后清哨兵。中间那一轮 `modelIsDefault` 可能与 init.model 不一致，接受（下一轮即自愈）。
- `permissionHandler.applyLivePermissionMode` 与 deferred 路径：`withTimeout(this.setPermissionModeCallback(mode), 15_000)`；超时抛错 → 现有回滚 `permissionMode` → RPC `{ error }`（铁律 17）。15 s 是为了让错误在 relay 30 s 上限内回到网页。
  回滚不只回滚本地（review 4）：`TimeoutError` 时再 fire-and-forget 发一次 `setPermissionModeCallback(previousMode)`，结果只记日志——
  挂着的请求若迟到落地（如 bypassPermissions 之后不再问 can_use_tool），SDK 与 wrapper 会重新一致；控制请求走 stdin FIFO，
  之后用户的新选择仍排在它后面、仍然胜出。CLI 明确拒绝（非超时）时没有在飞的请求，不补发。

### 5. Stop 回收插话 + 插话可追踪（`claudeCommandLifecycle.ts`）

- `ClaudeSteerInput.localKey?`；`runClaude` 传 `message.localKey`；launcher 传给 `q.steer(message, mode, localKey)`；`claudeRemote.steer` 用
  `promptUuid(localKey)` 作 `uuid`（非 UUID 的 localKey 不加 uuid = 现状）。
- **所有**带 uuid 推入的用户消息都 `commandTracker.track(uuid)`——首条 prompt、`pullNextMessage` 推的 prompt、插话（review 1）。
  场景：轮 N 被插话 S 抢占 → result(N) 让 wrapper 拉下一条 → 用户的普通消息 M 被推入、CLI 排队（S 仍在跑）→ 按 Stop →
  `cancelQueued` 回执 `cancelled:[M]`：M 从未运行，必须打墓碑，否则网页显示已送达而消息静默消失。追踪集上限 256（老 CLI 不发 lifecycle，不能随会话无限增长）。
- `sdkToLogConverter` 对顶层 `command_lifecycle` 帧返回 null（review nit 6）：它以前落进 `default` 分支原样进出站队列被持久化；
  生命周期追踪在 `claudeRemote` 的 for-await 里直接读帧，不经过转换器。
- init 的 `capabilities` 记入 `cliCapabilities`。`interrupt()`：有 `interrupt_cancel_queued_v1` → `interrupt({cancelQueued:true})`（窄类型断言，d.ts 未声明）；
  否则普通 `interrupt()`，回执 `still_queued` 中我们追踪的 uuid 逐条 `cancelAsyncMessage`（运行时方法，同样窄断言；返回 false = 已开跑，不打墓碑）。
  回执 `cancelled` ∩ 追踪集 → 报丢。老 CLI 回执为 undefined → 什么都不扫（现状）。
- `readClaudeCommandLifecycle(frame)` 读顶层 `command_lifecycle`（事实 ⑤）。`createClaudeCommandTracker()`：`started` 记为已开跑；`completed` 移除；
  `cancelled/discarded/refused` **且未见 `started`** → 判决「从未运行」→ 报丢；已 `started` 后的 `cancelled` 只移除不报（它所在的轮被 Stop 中止，网页已有「Aborted by user」；模型可能已读到，Orca 同判「doubt, never a verdict」）。
- 报丢 → `claudeRemote` 新回调 `onCommandsDropped(uuids)` → launcher `session.client.sendQueueCancelReason(uuids, 'aborted')`（B-332 墓碑，web 已识别，对任意 inputState 生效）。同一 uuid 只报一次。
- Query 结束时不扫残留（老 CLI 不发 lifecycle 帧，扫了会把送达的消息标成丢弃）。

## 兼容矩阵与发布顺序

「CLI」指 very-happy-cli wrapper；Claude Code 版本由 SDK 依赖钉死（0.3.296 → 2.1.296，事实 ①）。

| 组合 | 行为 |
|---|---|
| 新 CLI × 新 web/server | 全部五项生效。对外只用既有信封：session event `type:'message'`（`kind` 可选）、turn-end 既有可选 `error`、B-332 `queue-cancel reason='aborted'`；server 零改动 |
| 新 CLI × 旧 web/server | 同上；旧 web 剥掉 `kind` 后照常渲染文字；`queue-cancel` 自 B-332 起已识别；无新 wire 字段 |
| 旧 CLI（不升级）× 任何 web/server | 完全不变：纯 CLI 内部状态机与文案，无 metadata/wire 变化 |
| 新 CLI × Claude Code 不发 `session_state_changed`（SDK 钉的版本被改旧 / 操作者把 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 设空） | 无 idle 帧 → 轮只由 result 结束 = 今天的行为 |
| 新 CLI × Claude Code 有 `interrupt_receipt_v1` 无 `interrupt_cancel_queued_v1` | 普通 interrupt + 逐条 `cancel_async_message` 尽力而为（事实 ⑥ 的竞态：返回 false 的不打墓碑） |
| 新 CLI × Claude Code 无回执（`interrupt()` 解析为 undefined） | 不扫；插话 uuid 只用于 transcript |
| 新 CLI × Claude Code 无 `msg_lifecycle_v1` | 无 lifecycle 帧 → 墓碑只来自回执 `cancelled` |

发布顺序：只发 CLI（tag → npm → promote）；server/web 不动。运行中的老 wrapper 要「重启会话」才换代码。
回滚点：上一 CLI 版本重装 + `daemon start`。

## 风险

1. **idle 计数漂移**：某个 Claude Code 版本在 result 后既不发 idle 也不在下一轮前发 running → 欠账吞掉一次真正的无 result 结束 → 该轮退回今天的「挂住」，不比现状差；running 一到即清零。
2. **抢占语义**（事实 ⑦）：插话让尚未出文本的轮以 `success/aborted_streaming` 结束并触发 done 推送，这是现状；本项的单飞拉取让这种场景只推一条排队消息，不再两条背靠背。
3. **lifecycle 判决保守**：`started` 后被 Stop 扫掉的消息不打墓碑（模型可能已读到），用户需自行重发；与 Orca 一致。
4. **setPermissionMode 15 s**：CLI 正常几 ms 应答；真卡住时 RPC 得到 error 而非挂到 relay 30 s；补发旧模式本身也可能挂着，只记日志。
5. 探针跑在 haiku + 空 settingSources 上，未覆盖 hooks/MCP 很多的会话里 idle 相对 result 的延迟；设计不依赖延迟大小。
6. **多余 idle 落在已宣告、仍在跑的轮里**（CLI 发射点无同态去重）会被当成结束：turn-end + done 推送 + 提前拉下一条（进 CLI 队列，等当前轮完再跑，不丢）。
   review 判定现实窗口是「已推未宣告」（已堵住）；mapper 遇到后续输出会 `ensureTurn` 重开轮，不丢内容。接受。
7. **interrupt 8 s**：Stop 按钮在 CLI 真卡死时多等 5 s 才硬中止；换来 transcript 刷盘 / GC 停顿期间不被误杀重启。

## 验收标准

- [x] `claudeTurnEnd.test.ts`：result→idle 去重、无 result 的 idle 关已宣告的轮、已推未宣告的轮不被晚到/多余 idle 关掉（`pushed; onResult; pushed; idle→duplicate; idle→ignore; running; idle→end`）、running 清欠账、无宣告的 result 容忍、requires_action/启动前 idle 忽略。
- [x] `claudeRemote.test.ts` B-631：idle 无 result → thinking false + onReady(undefined) 一次 + 拉下一条；result+idle 只关一次；晚到 idle 与多余 idle 都不关已推未宣告的轮；interrupt 按能力带 `cancelQueued`、回执 `cancelled` 报丢（插话与排队 prompt 皆然）；无能力时 `cancelAsyncMessage` 只对 true 报丢；老 CLI 无回执不报；steer 带 localKey uuid；lifecycle 未 started 的 cancelled 报丢、started 后不报；setModel 超时沿用旧模型并通知且下个边界重发；idle 结束 + authentication_failed 帧 → 回收 Query。
- [x] `claudeProcessExit.test.ts`、`claudeSystemNotices.test.ts`、`claudeCommandLifecycle.test.ts`（含追踪集上限）、`utils/withTimeout.test.ts`（含 `TimeoutError`）纯函数用例；`sdkToLogConverter.test.ts`：`command_lifecycle` 不入 transcript。
- [x] `turnSteering.test.ts`：interrupt 8 s 超时拒绝且标记清空；`permissionHandler.test.ts`：live 切换超时 → 拒绝、本地回滚并向 SDK 补发旧模式，拒绝（非超时）不补发；`claudeLocalLauncher.test.ts`：ExitCodeError 开轮时只走 turn-end、未开轮时只走事件，signal 文案；`apiSession.test.ts`：`closeClaudeSessionTurn` 返回是否真发了 turn-end。
- [x] `sdk/query.test.ts`：子进程 env 带 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 且不覆盖显式值。
- [x] `claudeOrcaAlignWiring.test.ts` 源码断言全部过 `scripts/dev/mutation-check.mjs`。
- [x] `tsc --noEmit` 零错误；`pnpm build` + `node dist/index.mjs --version`；gitleaks 零报错。

## 留真机验证项

- 真会话：stop 一个正在重试 529 的轮，确认「Claude is retrying…」一条可见、停止后无残留转圈。
- 真会话：hook 拦截 prompt（UserPromptSubmit block）时网页出现 warning 文案。
- 真会话：插话后立刻 Stop，排队中的插话显示为「停止时丢弃」而非已送达。
