# 会话后台任务状态显式上报（Background task state）

> 状态：Final（实现随本 spec 同 PR）
> 日期：2026-09-25 ｜ 关联 backlog：B-507 ｜ 前身：[活性租约](2026-09-agent-liveness-lease.md)（B-320/B-322）、[子代理生命周期](2026-09-subagent-lifecycle.md)（B-260-P2）、[统一状态](2026-09-unified-agent-status.md)（B-452）、B-466（turn 在飞闸门）、B-471（Stop 停后台任务）、[Automations](2026-09-automations.md)（B-496 完成判定）

## 背景

Claude 的一个 turn 结束后，会话里仍可能有活在跑：`async_launched` 后台子代理、`run_in_background` 的 Bash、Monitor、
workflow 等后台任务。它们完成时会向会话投递 `task_notification`，Claude 再起一个新 turn 处理。今天没有任何出口把
「turn 已结束但还有后台任务」显式说出来：

- `very-happy sessions list/read --json` 只有 `turn.ended`、`pending`、`updatedAt`；
- daemon `/list` 只有 pid；B-466 的 `TurnActivityTracker` 只看 turn 边沿；
- Web 只在**当前 turn 的转录卡片**里数 running 子代理（B-295），用户再开口即失效，Bash 后台命令和 Monitor 根本没有卡；
- Automations 的 run 在 `turn-end` 后即判 `done`，后台任务的结果落在 run 之外；
- 私有层两处自动归档（tanka-autopilot-gc、session-harvest）只能靠 `updatedAt` 近因兜底，注释里明写「剩余风险 =
  后台任务静默跑超过 idleMs」。Owner 的 PR#631 会话正是这样被误归档的。

## 目标

1. wrapper 追踪每会话在飞后台任务（id、类型、描述、开始时间），随既有 2s 心跳与 `agentState` 上报，带新鲜度租约：
   wrapper 断连/被杀后读者在有界时间内回到「无后台任务」，旧端忽略新字段。
2. turn 结束但后台任务在跑时，会话状态为「后台运行中」（Web 侧栏/看板显示「后台任务 N 个」），不是 idle。
3. `sessions list`（本机）/`sessions list --all`/`sessions read --json` 带 `backgroundTasks`（计数 + 明细）；daemon `/list` 同。
4. Automations run 在后台任务未完时不判 done；B-466 自动升级/交接闸门把有后台任务视为忙。
5. 私有层两处自动归档改为读取新字段：有后台任务 → 不归档（本 repo 只提供字段；改动在 skills repo）。

## 非目标

- 不给后台任务做新的 Web 面板/卡片（B-260-P2 的子代理卡与 Bash 机器行不变）。
- 不改 `sessions read --wait` 的退出条件（仍是 `turn-end`；调用方按需再看 `backgroundTasks`）。
- Codex / pi(ACP) / Gemini 没有跨 turn 的后台任务机制（Codex 的 `task_started/task_complete` 是 turn 本身），本次只
  由 Claude runner 产生该信号；其它 runner 不带字段 = 0（读者按「无后台任务」处理）。
- 不加 DB migration、不改 wire 消息 envelope。

## 现状事实（代码已确认，基线 `origin/main@d76bdffff`）

| 事实 | 位置 |
|---|---|
| SDK 0.3.281 有 level 信号 `system/background_tasks_changed`（REPLACE 语义：每次给出全部在飞后台任务 `{task_id, task_type, description, ambient?}`，文档明说「只需要知道有没有后台工作的消费者应整体替换集合而不是配对边沿」；进程重启后须清空）；边沿信号 `task_started{is_backgrounded?, ambient?, skip_transcript?}` / `task_updated.patch{is_backgrounded?, status?}` / `task_notification{status}`；`ambient` 任务「不算活动，宿主应从活动指示里排除」 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3553-3580, 5765-5875` |
| 前台 Agent 的 `tool_use_result.status === 'async_launched'` = 该子代理转后台（老路径） | `claude/utils/subagentLifecycle.ts:41-48`；mapper `sessionProtocolMapper.ts:884-890` |
| `runtimeControls.observe` 已按边沿记 `tasks`（供 stop-task / B-471），但前台完成不产生 task_notification ⇒ 它的 running 不是「后台在飞」 | `claude/runtimeControls.ts:38-47` |
| 所有 SDK 消息先经 `runtimeControls.observe`；query 就绪/结束 `setQuery(q)/setQuery(null)` | `claude/claudeRemoteLauncher.ts:253, 571, 697` |
| `Session.thinking` 由 `onThinkingChange` 写，每 2s `client.keepAlive(thinking, mode)` | `claude/session.ts:129-131, 168-177` |
| `ApiSessionClient.keepAlive` 走 `socket.volatile.emit('session-alive', {sid, time, thinking, mode})`，并喂 B-466 `TurnReporter`（边沿 + 60s 续租 → daemon `/session-event`） | `api/apiSession.ts:1022-1040`；`update/turnActivity.ts` |
| server `session-alive` handler 只取 `sid/thinking`，B-484 `SessionActivityRelayGate` 按 `thinking` 合并转发（busy 4s / idle 30s），`buildSessionActivityEphemeral(sid, active, activeAt, thinking)` 重建 5 字段对象 | `happy-server/sources/app/api/socket/sessionUpdateHandler.ts:113-160`；`presence/sessionActivityRelayGate.ts`；`events/eventRouter.ts:531-539` |
| Web `ApiEphemeralActivityUpdateSchema` 严格 5 字段；`handleEphemeralUpdate` 在累加器之前 `recordHeartbeat(id, thinking)`（租约 25s，断连/隐藏停表，只有 thinking 才武装 timer） | `happy-web-v2/src/sync/apiTypes.ts:186-192`；`sync.ts:3153-3160`；`heartbeatLease.ts` |
| 活性唯一判据 `isAgentWorkLive`（铁律 13）；状态词汇 `sessionExecution` → `running/input/idle/unknown/offline`；看板 `classifySession` 与侧栏 `executionByKey` 共用一个分类 | `sync/agentLiveness.ts`；`sync/agentStatus.ts:4-13`；`screens/board/boardItems.ts:184-198`；`Sidebar.tsx:382-383` |
| `agentState` 为会话密钥加密、版本 CAS 的服务端存储；CLI `updateAgentState` 带锁；`sessions list --all` 已解密 agentState 取 `pending`；Web `AgentStateSchema` 是严格 `z.object`（未知字段被剥） | `api/apiSession.ts:1255-1280`；`sessions/sessionOps.ts:229-256`；`happy-web-v2/src/sync/storageTypes.ts:135-161`、`encryption/sessionEncryption.ts:213` |
| daemon `/list` 只回 `{startedBy, happySessionId, pid}`；CLI `sessions list`/`read` 的 `live` 来自它；`/session-event` 的 `event` 是封闭 enum（旧 daemon 对未知值回 400，wrapper 侧 `daemonPost` 吞成 `{error}`） | `daemon/controlServer.ts:144-201`；`sessions/sessionOps.ts:78-160`；`daemon/controlClient.ts:224-232` |
| B-466 闸门：`idle: () => !turnActivity.hasActiveTurn()`，交接前两处同判；wrapper 退出 `turnActivity.forget` | `daemon/run.ts:1764, 1838, 1859, 1473` |
| Automations 完成判定：`turnActive` 下降沿或周期读 log，`turn.ended` 即 done | `daemon/automations/runner.ts:271-298` |

## 设计

### 1. wrapper：`claude/backgroundTasks.ts`（纯函数，无 I/O）

`createBackgroundTaskTracker()`：

- `observe(message, now)`：
  - `system/background_tasks_changed` → **整体替换**：保留已知条目的 `startedAt`，新条目 `startedAt = now`；`ambient` 条目排除。
  - `system/task_started` 且 `is_backgrounded === true` 且非 `ambient`/`skip_transcript` → 加入；`task_updated.patch.is_backgrounded === true` → 加入（描述取先前 `task_started` 记下的前台条目）；`patch.status ∈ {completed, failed, killed}` → 移除。
  - `system/task_notification` → 移除。
  - `user` 消息里 `tool_use_result.status === 'async_launched'` 的 `tool_result` → 把对应 `tool_use_id` 的前台任务标为后台（老 CLI 无 level 信号时的兜底）。
  - 边沿与 level 都应用：两者对同一转换的结果一致（level 先到则边沿是幂等重放；边沿先到则 level 覆盖为同一集合），不会互相打架。
- `reset()`：query 重建/结束时清空（SDK 文档要求，且新进程的 task_id 与旧集合无关）。
- `list()`：按 `startedAt` 升序，≤ 50 条；`description` 截到 200 字；`type` 直接用 `task_type`（`local_bash`/`local_agent`/`monitor`/…）。
- 变化判定 `sameTasks(a, b)` 只比 id 集合与描述，供调用方决定是否发边沿。

接线：`claudeRemoteLauncher.onMessage` 里 `runtimeControls.observe` 旁边 `backgroundTasks.observe`；`onQueryReady`/`finally setQuery(null)` 处 `reset`；每次 observe 后 `session.setBackgroundTasks(tracker.list())`（`Session` 只在集合变化时触发一次立即心跳）。

### 2. 上报三条腿（`ApiSessionClient.keepAlive(thinking, mode, backgroundTasks?)`）

`update/backgroundTaskActivity.ts`（与 B-466 `turnActivity.ts` 同模式，纯逻辑 + 测试）：

- **心跳**：`session-alive` 多带 `backgroundTasks: number`（只在 Claude runner 传入时带；其它 runner 不带）。老 server 忽略。
- **daemon**：`BackgroundTaskReporter.observe(tasks, now)` 在集合变化时、以及非空期间每 60s（租约）返回 `publish`，wrapper 随即
  `POST /session-event {event:'background_tasks', backgroundTasks:[…]}`。老 daemon 回 400，忽略。
- **agentState**：同一 `publish` 时机 `updateAgentState(s => ({...s, backgroundTasks: tasks.length ? { updatedAt: now, tasks } : undefined}))`。
  集合非空每 60s 一次 CAS 写（有后台任务的会话很少，可接受）；清空时删字段。

### 3. 读者的新鲜度规则（每个读者都有过期条件，铁律 13）

| 读者 | 信号 | 过期 |
|---|---|---|
| Web | 心跳 `backgroundTasks` 计数，`recordBackgroundTasks(id, n)` 存模块级 Map，`recordHeartbeat` 在 `thinking \|\| n>0` 时武装 timer | 与 thinking 同一租约（25s、断连/隐藏停表）；`active:false` 的广播（session-end/归档/超时）不带字段 ⇒ 计数归零 |
| daemon | `/session-event background_tasks` → `BackgroundTaskTracker`（TTL 150s，续租 60s） | TTL 过期或 wrapper 退出 `forget` |
| CLI `sessions list`（本机）/`read` | daemon `/list` 的 `backgroundTasks` | 由 daemon TTL 保证 |
| CLI `sessions list --all` | 解密 `agentState.backgroundTasks` | `row.active !== true` 或 `now - updatedAt > 150s` ⇒ `count:0, stale:true`（同机时钟；跨机行本就不可解密） |

server 侧 B-484 合并门：key 从 `thinking` 变为 `(thinking, backgroundTasks)`，计数变化即边沿立即转发；`backgroundTasks>0`
按 busy 间隔（4s）转发，保证 Web 租约不假过期。`buildSessionActivityEphemeral` 多一个可选 `backgroundTasks` 参数，
不带时不输出字段（老 Web 的严格 schema 不会因此拒收——`z.object` 默认剥离未知键）。

### 4. 出口

- **Web**：`AgentExecution` 加 `'background'`；`sessionExecution` 在非 running 且 fresh 且 `backgroundTasks>0` 时返回它；
  看板 `classifySession` → `status:'working'` + `backgroundTasks:n`（lifecycle 仍 running，不进「等我看」）；侧栏 `executionByKey`
  对带 `backgroundTasks` 的 working 项给 `'background'`，状态槽显示「后台任务 N 个」（tooltip/aria），图标沿用 Spinner；
  看板卡片脚注显示同一句。`isAgentWorkLive` 不变——后台任务不等于 turn 在飞，输入不该被扣住。
  `AgentStateSchema` 加 `backgroundTasks` 使新 Web 读得到明细（tooltip 列前 3 条描述）。
- **CLI**：`SessionSummary.backgroundTasks?: { count, tasks[], reportedAt?, stale? }`；`sessions list` 文本行加 `background=N`；
  `--all` 状态词加 `[background]`；`sessions read --json` 的 `summary` 同 `list`。`docs/channels.md` 记字段。
- **daemon**：`/list` 每个 child 加可选 `backgroundTasks`；`idle`/交接闸门加 `!backgroundTasks.hasAny()`；
  Automations runner 新依赖 `backgroundTasks(sessionId): number`，turn 已结束但计数 >0 时不 finish（下一次后台任务完成会触发新 turn，
  落沿后再读 log；wrapper 退出仍按原逻辑收尾）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI + 旧 server | 心跳多余字段被忽略；agentState 正常写（不透明密文）；Web 拿不到心跳计数 ⇒ 无「后台」状态；`sessions list --all` 仍能从 agentState 读 |
| 新 server + 旧 Web | `activity` 多出的 `backgroundTasks` 被 zod 剥离；`agentState.backgroundTasks` 被剥离；行为同今天 |
| 新 Web + 旧 CLI | 没有字段 ⇒ 计数 0 ⇒ 沿用 B-295 的当前 turn 子代理卡判据 |
| 新 wrapper + 旧 daemon | `/session-event background_tasks` 400 被吞；`/list` 无字段；闸门/Automations 行为同今天 |
| 新 daemon + 旧 wrapper | 不上报 ⇒ 不算忙（与 B-466 同口径：交接本来不杀 wrapper） |
| 旧 GC 脚本 + 新 CLI | 多出的 JSON 字段被忽略 |

发布顺序：server/Web 同镜像先发（心跳转发 + 显示），再 CLI tag；升级 daemon 后**新建**会话才有 wrapper 侧上报（handover 不热替换 wrapper）。
回滚点：server/Web 上一 release SHA；CLI 上一 tag。

## 风险

1. **`background_tasks_changed` 在旧 Claude Code 运行时不存在**：边沿路径兜底（task_started.is_backgrounded / async_launched / task_notification），一条 `task_notification` 丢失会让集合残留——由 level 信号纠正，且 wrapper 退出/重启即清空；接受。
2. **永不结束的后台任务（Monitor 常驻）让 Automations run 永远 running**：这是「不在后台任务未完时判 done」的直接后果；runner 每次跳过时记一次 debug，run 仍受服务端 `maxRuntimeMs` 约束。接受，写进 channels.md。
3. **agentState 每 60s 一次 CAS 写**：只在集合非空时；与既有权限请求写同一把锁。接受。
4. **Web 冷启动**：新 tab 要等下一次心跳转发（有后台任务时 ≤4s）才显示；期间沿用旧判据。接受。
5. 并行 B-505 也在改 `controlServer.ts /list` 与 `run.ts`：本 PR 的新增字段/依赖独立成行，冲突为相邻行级。

## 验收标准

- [ ] tracker 单测：level 替换、ambient 排除、边沿加入/移除、async_launched 兜底、reset、截断上限。
- [ ] reporter/tracker 单测：边沿 + 60s 续租；daemon TTL 150s；forget。
- [ ] apiSession：心跳带计数；publish 时 POST daemon + 写 agentState；源码断言 + mutation-check。
- [ ] server：gate 计数边沿 + busy 间隔；handler 转发字段；不带字段的调用不输出键。
- [ ] Web：schema 接收；租约武装/归零；`sessionExecution` → background；看板/侧栏显示；i18n 中英。
- [ ] CLI：`/list` 字段；`sessions list/read/--all` 字段与 stale；文本行。
- [ ] Automations runner：turn 结束但 backgroundTasks>0 不 finish，归零后 finish。
- [ ] B-466 闸门源码断言 + mutation-check。
- [ ] 隔离 HAPPY_HOME_DIR 真 claude 实测：`run_in_background` 长命令 + 后台子代理 → `sessions list --json`/daemon `/list`/心跳 显示计数，结束后清零。
- [ ] 门禁全绿；`docs/channels.md`、backlog、changelog。

## 留真机验证项

- Web 侧栏/看板在真实会话上显示「后台任务 N 个」并在任务结束后消失（Chromium 本地可验，真机 V- 项见 verify-queue）。
