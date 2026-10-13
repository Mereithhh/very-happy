# 空闲 agent 自动休眠、打开时恢复

> 状态：Draft
> 日期：2026-10-13 ｜ 关联 backlog：B-587 ｜ 出处：Orca 对照第三轮（`AgentHibernationGate` / `agent-hibernation-planner` / `agent-hibernation-confirmation`）

## 背景

daemon 机器上每个 UI 会话都常驻一个 wrapper（very-happy 进程 + Claude SDK 子进程 / Codex app-server），
空闲几天也不退出。dev-sg / mac-office 上常年挂着几十个会话，内存被大量「早就聊完」的进程占住。
Orca 的做法是：agent 空闲超过阈值且两次采样状态一致时，停掉进程、留下可恢复锚点，用户回来时自动唤醒。

very-happy 已经有「停进程不归档」（铁律 7，`POST /deactivate`）和「原地恢复」（`resume-happy-session`，
单写者锁 铁律 20）两半，缺的是：**谁来判断空闲、怎么标记「已休眠」、怎么在打开/发消息时自动接上**，
以及最关键的——**不能误停正在被用的会话**。

## 目标

1. daemon 上的 UI agent 会话（Claude / Codex wrapper）在**严格空闲**超过阈值后被优雅停止，标记为「已休眠
   （可恢复）」，与 offline / 归档 / 崩溃区分。阈值是每台机器的设置项，默认 6 小时，可关闭。
2. 用户打开会话或在其中发消息时自动唤醒（复用 `resume-happy-session`），唤醒期间输入排队，
   体验上只多一个「正在唤醒…」状态；权限模式保持休眠前的值。
3. 休眠不发「完成」通知、不改未读、不归档；休眠期间别人发进来的消息在唤醒后照常处理（不丢）。
4. 兼容：旧 web 把休眠会话显示为 offline，现有「恢复」可用；新 web 连旧 CLI 不出现任何休眠 UI；
   不加 Prisma migration，不改 server。

## 非目标

- 不休眠 web 终端（tmux）会话、终端 mirror、用户在自己终端里直接跑的 `very-happy`（local 模式）。
- 不休眠 pi / gemini / openclaw 会话：web 的恢复只支持 claude / codex（`restoreEligibility`），休眠了就醒不过来。
- 不做「打开即预热」「按内存压力动态调阈值」「休眠前截断/压缩上下文」。
- 不改 server、不加 migration、不改 wire 包。
- 不修 Codex 在 SIGTERM 时把 metadata 盖成 `lifecycleState:'archived'` 的既有问题（见风险 R8），只保证休眠路径不走它。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 基础设施退出只标 offline（`session-end` + `POST /deactivate`），不归档；退出意图「先到者定」 | `happy-cli/src/claude/sessionExitLifecycle.ts`（`settleSessionOnExit` / `SessionExitGate`）；`claude/runClaude.ts:1198` SIGTERM → `cleanup({archive:false})` |
| Codex 的 SIGTERM/kill 走同一个 `handleKillSession`，会写 `lifecycleState:'archived'` | `codex/runCodex.ts:530-567`、`:577 processSignals:true` |
| 恢复 = daemon `resume-happy-session`：活进程幂等成功、按 session 单飞、`HAPPY_RECONNECT_*` 原地接回 | `daemon/run.ts:1151-1290` |
| 新 wrapper 持锁后 reactivate，并以 server 快照 seq 作为消息游标（不重放、不跳过） | `claude/runClaude.ts:324-345`、`codex/runCodex.ts:188-207`、`utils/reconnectSession.ts:applyServerSnapshot` |
| 重连后扫描「上一个 wrapper 内存队列里丢掉的排队消息」并发 `queue-cancel(restarted)` | `api/apiSession.ts:943 cancelUndeliveredQueuedInputs`，调用 `runClaude.ts:432`、`runCodex.ts:245` |
| 重连首个 metadata 写入 = server 副本 + 本进程身份字段，其余 server 字段原样保留 | `utils/reconnectSession.ts:mergeReconnectMetadata` |
| daemon 已有每会话 turn 租约（`turn_started/ended`，150s TTL）与后台任务租约（含 async_launched 子代理） | `update/turnActivity.ts`、`update/backgroundTaskActivity.ts`、`claude/backgroundTasks.ts` |
| wrapper 每 2s keepAlive（thinking / 后台任务）；Claude 输入队列与 server prompt queue 的空闲判据 | `claude/session.ts:160`、`claude/runClaude.ts:721-727`（`messageQueue.size()===0 && isWaiting()`）、`api/apiSession.ts:581 promptQueueHasPending` |
| 待处理审批/提问在 `agentState.requests` | `claude/session.ts:255` |
| Automations：`send` 动作要求目标会话 live，否则 `session_not_live` 失败；sticky 会话不 live 就新开并删绑定 | `daemon/automations/runner.ts:294`、`:310-316` |
| Automations 列表与 sticky 绑定可由 daemon 用自己的 token 读 | `automations/client.ts:95 list(machineId)`、`:116 stickies(id)` |
| Teams 成员会话 `spawnedBy:'teams'` / `teamWorker.hasSession` | `daemon/run.ts:1487`、`:1522` |
| 外部派生会话（assistant / IM 桥 / scheduler）带 `HAPPY_SPAWNED_BY`，出生即打同名 tag | `utils/createSessionMetadata.ts:89 spawnOriginTags` |
| 恢复记录 `sessions.json` 14 天保留，按 `savedAt` 计 | `persistence.ts:588 SESSION_MAX_AGE_MS` |
| 机器本地设置先例（不走加密的 synced settings） | `persistence.ts:64 boardLlm`、`:71 claudeCredentialStore` + RPC `claude-auth-set-store` |
| daemonState 能力位约定：`{rpcAvailable, detectedAt}`，`detectedAt >= startedAt` 才可信，每次 connect 重盖 | `api/apiMachine.ts:1344-1376`、`api/types.ts DaemonStateSchema` |
| web：归档会话 composer 先恢复再排队（`restore-first`）；仅 offline 的会话直接发送 | `happy-web-v2/src/app/sessionRestoreRules.ts:84,153`、`screens/session/AgentInput.tsx:221,603-611`、`screens/session/queuedMessages.ts:canReleaseQueuedMessage` |
| web：offline/归档会话横幅 + 「恢复」按钮；侧栏行 Restore；命令面板 Restore | `screens/session/SessionArchivedBanner.tsx`、`SessionDetailScreen.tsx:267`、`screens/sessions/Sidebar.tsx:1568` |
| web MetadataSchema 会剥除未声明字段（web 写 metadata 时会删掉它们） | `sync/storageTypes.ts:8`，写路径 `sync/ops.ts sessionApplyMetadata` |
| 未读来自通知收件箱，不看 metadata / active | `sync/notificationInbox.ts`、`sync/notificationUnreadMarks.ts` |
| 「固定/置顶」：web 只有遗留 `pinnedRows` 与手动排序 `sidebarOrder`，都是加密 synced settings，daemon 读不到 | `screens/sessions/sidebarPins.ts`、`sidebarOrder.ts` |

## 设计

### 1. 职责划分：daemon 判定、wrapper 执行并复核

daemon 看不到 wrapper 内部状态（输入队列、审批、最近活动），wrapper 看不到机器级政策（设置、Teams、
Automations）。所以拆成一次本地问答：

```
wrapper（每 checkMs 一次，仅空闲时）── POST /session-hibernate-check {本地快照} ──▶ daemon
daemon：政策 + 排除名单 + 自己的 turn/后台租约 + 快照 → {hibernate, reason, nextCheckMs}
wrapper：hibernate=true → 立即用同一纯函数复核本地状态 → 提交休眠（§3）
```

- 只有**声明了能力**的新 wrapper 才会来问；旧 wrapper 永不被休眠（安全默认）。daemon 不发信号、不杀进程，
  因此 Windows/macOS/Linux 行为一致，也不存在「旧 wrapper 收到不认识的信号直接死掉」的风险。
- 旧 daemon 没有该路由 → 404 → wrapper 退避到 30 分钟再试，不报错。

### 2. 严格判据（纯函数 `hibernation/hibernationPolicy.ts`，wrapper/daemon 共用）

**wrapper 本地（`evaluateWrapperIdle`）全部满足才算空闲：**

| 条件 | 来源 |
|---|---|
| 不在 turn 中（thinking=false） | Claude `Session.thinking` / Codex `thinking \|\| turnActive` |
| 输入队列为空且 runner 在等下一条（Claude `isWaiting()`） | `MessageQueue2` |
| server prompt queue 无待派发项 | `promptQueueHasPending()` |
| 无待处理审批/提问（`agentState.requests` 为空） | agentState |
| 无运行中的后台任务 / async_launched 子代理 | `Session.backgroundTasks` |
| 未被标「保持唤醒」（`metadata.keepAwake !== true`） | metadata |
| 远程模式、daemon 启动（`startedBy==='daemon'`），非 assistant variant，无 spawn 来源 | 启动参数 / env |
| `now - lastActivityAt >= idleMs` | §2.1 |

**daemon（`decideDaemonHibernation`）在此之上再要求：**

- 机器政策开启（`idleMs > 0`）；
- 该 sessionId 有本 daemon 追踪的活 wrapper 且 pid 与上报一致；flavor ∈ {claude, codex}；
- daemon 自己的 `turnActivity` 无活 turn、`backgroundTasks.count == 0`；
- 不是 Teams 成员（`spawnedBy==='teams'` 或 `teamWorker.hasSession`）、不是 automation/assistant 派生
  （tracked/上报的 `spawnedBy` 非空，或 tags 含 `teams`/`automation`/`assistant`）；
- 不是任何 Automation 的复用目标：`send.sessionId` 或任一 sticky 绑定（`list(machineId)` + `stickies(id)`，
  10 分钟缓存；网络/5xx 失败则**本轮一律不休眠**，404=服务器无 automations=空集）；
- 上报的 `lastActivityAt` 满足阈值，且**两次连续上报的状态签名相同**（Orca 的 confirmation：
  `lastActivityAt|keepAwake|flavor` 的签名，第一次只登记，第二次一致才放行）；
- 全机同一时刻最多 1 个休眠在途（串行，避免一次性停一片）。

拒绝时返回 `reason` 与 `nextCheckMs`（未到阈值时 = 剩余时间，且不小于 checkMs），wrapper 据此调度下一次。

#### 2.1 「最近活动」

`ApiSessionClient.lastActivityAt` = max(进程启动、收到任一入站用户消息、发出任一 agent 消息、keepAlive 时
thinking=true 或后台任务非空、agentState 出现 requests)。web 只是「打开看了」不算活动（Orca 也只认输入/输出），
所以一个开着但 6 小时没人动的标签页里的会话照样会休眠——打开它的页面会显示「已休眠」，发消息即唤醒。

### 3. 提交休眠（wrapper，`hibernate` 退出意图）

`SessionExitIntent` 加第三种 `'hibernate'`，走与 `offline` 相同的服务端路径（`session-end` + `POST /deactivate`，
**绝不** `/archive`），先多写一个 metadata 戳。顺序：

1. `exitGate.claim('hibernate')`（先到者定；之后来的 SIGTERM/归档都被忽略，反之亦然）；
2. `beginHibernationCommit()`：记下「提交开始后是否又路由了入站用户消息」；
3. `flush()` outbox；复核 §2 本地判据 + 提交窗口内无入站 → 否则**放弃休眠**、释放 exitGate、继续运行；
4. `freezeInbound()`：之后到达的用户消息不再路由（留给下一个 wrapper 重放）；
5. 写 `metadata.hibernation = { at, seq: lastSeq, idleMs, v: 1 }`；
6. `settleSessionOnExit(..., 'offline')`、flush、close、退出码 0。

daemon 在 `onChildExited` 时若该会话刚被批准休眠：恢复记录写 `hibernatedAt`，保留期从 14 天延到 90 天
（`persistence.ts`；旧 CLI 读到会忽略该字段，按 14 天剪，属降级可接受）。

不发通知：offline 路径本来就不产生 `reply_done/input_needed`；不改 `lifecycleState`、不碰 `archivedAt`。

### 4. 唤醒与「不丢消息」

- 新 wrapper 重连（`HAPPY_RECONNECT_*`）后，若 server metadata 带 `hibernation.seq` 且小于快照 seq：
  把消息游标退回 `hibernation.seq`（只重放休眠之后进来的记录，正常路由），并**跳过**
  `cancelUndeliveredQueuedInputs`（休眠的前提就是内存队列为空，没有可宣告丢失的项；若不跳过会把要重放的
  排队消息同时 tombstone 掉）。
- `mergeReconnectMetadata` 清掉 `hibernation` 键（新 CLI 才有）。
- 唤醒时 web 把 `metadata.permissionMode` 作为 resume RPC 的 `permissionMode` 传入（daemon 已有白名单
  `sanitizeSpawnPermissionMode`），header 不会在唤醒后跳回 default。

### 5. web

- `app/sessionHibernation.ts`（纯）：`isHibernated(session)` = `!active && archivedAt == null &&
  metadata.hibernation.at 为数 && activeAt <= at + 5min`（最后一条防止降级到旧 CLI 后遗留的戳把普通 offline
  误标成休眠）；`hibernationSupported(daemonState)`（`agentHibernation.detectedAt >= startedAt`）。
- composer：`composerGate` 对休眠会话返回 `restore-first`（沿用归档恢复的排队/释放机制，唤醒并 online 后释放）。
- 打开即唤醒：`SessionDetailScreen` 挂载/切换到一个休眠会话且机器在线时调用 `restoreSession` 一次
  （按 `sessionId + hibernation.at` 去重，失败不重试，由横幅「重试」接管）；另外若 `session.seq > hibernation.seq`
  （休眠后有新记录进来，比如休眠瞬间发出的消息）也唤醒一次。
- 横幅：休眠态显示「已休眠以释放内存 · 发消息或点唤醒」，进行中显示「正在唤醒…」，按钮「唤醒」。
- 侧栏：休眠行用 `Moon` 图标、提示「已休眠」（替代 offline 的 Unplug），Restore 按钮照旧。
- 会话 ⋯ 菜单：「保持唤醒」勾选项，仅当 `metadata.capabilities` 含 `agent-hibernation-v1` 时出现；写
  `metadata.keepAwake`（`sessionApplyMetadata`）。
- 机器页：「空闲休眠」分组（关闭 / 1 / 3 / 6 / 12 / 24 小时），仅 `hibernationSupported` 时出现；RPC
  `agent-hibernation-set {idleMs}`。
- `MetadataSchema` 增加 `hibernation`（passthrough + catch）与 `keepAwake: boolean.optional()`，web 写 metadata
  时不再剥掉它们。

### 6. 设置

机器本地 `settings.json` 的 `agentHibernationIdleMs`：缺省 = 6h，`0` = 关闭，web 设置范围 1–24h。
env `HAPPY_HIBERNATE_IDLE_MS`（覆盖设置，测试用，可到秒级）、`HAPPY_HIBERNATE_CHECK_MS`（wrapper 采样周期，
默认 5 分钟，下限 1s）。daemonState 发布 `agentHibernation: { idleMs, rpcAvailable, detectedAt }`，每次 connect
重盖（同其他能力位的信任规则）。

被否方案：
- **web synced settings**：加密，CLI 读不到（`boardLlm` 同理已有先例）。
- **daemon 发 SIGTERM**：现有 offline 路径区分不了休眠，且 Codex SIGTERM 会盖 archived 戳；daemon 也看不到
  输入队列/审批，判据做不严。
- **daemon 发 SIGUSR2**：旧 wrapper 不认识会被默认动作直接杀死；Windows 无此信号。
- **server 记 hibernated 列**：要 migration，挡别人发布；metadata 足够。

## 兼容矩阵与发布顺序

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 旧 | 任意 | 任意 | 无能力位、无 check-in → 永不休眠；新 web 无任何休眠 UI（按 capabilities / daemonState 判） |
| 新 daemon + 旧 wrapper | 任意 | 任意 | 旧 wrapper 不来问 → 不休眠；机器页可见设置（只影响新 wrapper） |
| 旧 daemon + 新 wrapper | 任意 | 任意 | `/session-hibernate-check` 404 → wrapper 退避 30min，不休眠 |
| 新 | 旧/新 | 旧 | 休眠会话 = offline（非归档），横幅「恢复」/侧栏 Restore 可唤醒；旧 web 直接发的消息留在 server，唤醒后被重放处理（§4）；旧 web 改名会剥掉 `hibernation`/`keepAwake`（R5） |
| 新 | 旧/新 | 新 | 完整体验：打开/发消息自动唤醒、排队、保持唤醒、机器设置 |
| 新休眠 → 降级旧 CLI 恢复 | 任意 | 新 | 旧 CLI 不清 `hibernation` 戳；会话 active 时 web 不看它；之后若再 offline，`activeAt` 已晚于戳 → 不误判为休眠。旧 CLI 不重放休眠期间的消息（同今天 offline） |

server：零改动（metadata 是不透明加密串，`/deactivate` 已存在）。wire：零改动。
发布顺序：server/web 先（新 web 对旧 CLI 无感）→ CLI。回滚：CLI 回旧版 = 不再休眠，已休眠会话用「恢复」照常接回；
web 回滚 = 显示为 offline + 恢复。

## 风险

1. **误停正在用的会话**：判据多层 AND + 两次签名确认 + wrapper 提交前复核 + 提交窗口入站检测；任何一层不确定都不休眠。
2. **休眠瞬间到达的消息**：提交窗口内到达 → 放弃休眠；freeze 之后到达 → seq 大于戳，唤醒时重放；新 web 还会因 `session.seq > hibernation.seq` 主动唤醒。
3. **Automations 列表拉取失败**：本轮整体不休眠（fail-closed）。
4. **恢复记录过期**：休眠记录保留 90 天；Claude transcript 被 Claude Code 自己清理（默认 30 天）时，恢复走既有「新对话 + 历史仍可见」降级。
5. **旧 web 写 metadata 剥字段**：`keepAwake` 可能被旧 web 改名清掉 → 会话可能被休眠，但可唤醒；新 web 全量发布后消失。接受。
6. **唤醒时延**：Claude resume 冷启动约数秒；横幅显示「正在唤醒…」，输入排队。接受。
7. **外部派生会话 resume 后丢失 spawnedBy**：额外用 tags 兜底（`teams/automation/assistant`）；其他外部来源（如 `--spawned-by tanka`）首个 wrapper 带 env 时不休眠，resume 后若用户删了 tag 则可能被休眠——它们靠 REST 发消息，唤醒后会被重放，不丢。接受。
8. **Codex SIGTERM 盖 archived 戳**（既有问题）：休眠走独立路径不经过它；本 spec 不修，记录在报告。

## 验收标准

- [ ] 纯函数单测：wrapper 判据每一条单独翻转都拒绝；daemon 判据（政策关、Teams、automation 绑定、spawn 来源、活 turn、后台任务、签名首次/变化、automations 未知、串行）各有用例。
- [ ] 提交流程单测：提交窗口内有入站 → 放弃且 exitGate 释放；成功路径写戳顺序（flush → 戳 → deactivate，绝不 archive）。
- [ ] 重连单测：带 `hibernation.seq` 时游标回退、跳过 cancel 扫描、`mergeReconnectMetadata` 清戳。
- [ ] web 单测：`isHibernated`（含降级防误判）、`composerGate`、`hibernationSupported`、自动唤醒去重。
- [ ] 实跑（独立 HAPPY_HOME_DIR，阈值秒级）：休眠 → web 显示「已休眠」→ 发消息 → 唤醒 → 回复正常；daemon 日志显示走的是 deactivate。
- [ ] 旧 web 语义验证：休眠会话 `active=false, archivedAt=null`，横幅「恢复」可唤醒。
- [ ] 真浏览器 1280 / 390（coarse）× 亮/暗：横幅、侧栏月亮图标、机器页设置、⋯ 菜单保持唤醒。
- [ ] cli build + `--version`、web tsc/vitest/vite build、design-lint、gitleaks 零错误。

## 留真机验证项

- dev-sg / mac-office 上 6 小时真实阈值的内存释放量与唤醒时延（浏览器验不了长时间与真实内存）。
