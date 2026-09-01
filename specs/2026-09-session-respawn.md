# 会话重生（session respawn）——让坏掉/旧代码的 daemon 会话安全换到新 CLI

> 状态：Final
> 日期：2026-09-01 ｜ 关联 backlog：B-264、B-266 ｜ 出处：3 轮对抗式 review（5 个 reviewer pass，草稿见 `skills/tmp/b264-session-auto-upgrade/`）

## 背景

CLI 升级只换 **daemon**：已在跑的每会话 wrapper（`happy claude --happy-starting-mode remote`，detached 子进程）被新 daemon **重新附着**，继续跑**旧代码**。新 CLI 的修复/能力对存量会话不生效，直到该 wrapper 被重新 spawn。

急性表现（B-266）：root daemon 上每个 remote/SDK 会话 0 秒即死（root 下 `--dangerously-skip-permissions` 被拒），web 显示「Agent 进程意外退出」。IS_SANDBOX 修复在 CLI 里，用户升级 daemon 后**存量坏会话仍坏**，因为其 wrapper 跑升级前的代码。用户很多，无法逐个 hand-hold。

3 轮对抗 review 的结论：**「零操作、全无缝地自动升级每个 live 会话」不值得做**——它需要跨 claude+codex 的 4-5 个 race-prone 子系统（会话进程写不了自己的状态文件、"consumed seq" 不可计算、daemon 看不到 busy 信号），收益却很边际。正确目标收窄为：**让坏会话安全换到新代码，且不需要用户逐个处理**。

## 目标

- 用户有坏会话时，能**一键**（或零点击，opt-in）让它换到新代码并恢复可用，覆盖全体用户、无需逐个 hand-hold。
- 提供一个**唯一、加固过的重生例程**，供「一键重启」与「可选自动愈合」共用，杜绝 double-spawn / 两写者 / 崩溃三进程等竞态。

## 非目标

- **不**追求 live-healthy-busy 会话的无损热升级（review 证明不划算，明确不做）。
- **不**触碰 healthy 存量会话（它们旧代码下工作正常，wrapper 下次自然死亡+resume 时或用户开新会话时自然换新）。
- 不做协作式 drain（cooperative drain，被 review 否决，架构上不可实现）。
- 不覆盖 local/交互会话（终端绑定）、web 终端 tmux（另有 auto-restore）、跨机迁移、以及「够不到从不升级 daemon 的机器」（另属 min-version 提醒项）。

## 现状事实（代码已确认，origin/main @ da6ab90c）

| 事实 | 位置 |
|---|---|
| 升级 handover：heartbeat 见 `dist/index.mjs` mtime 变→ `daemon start`+`exit(0)`，**不杀 wrapper**；新 daemon 按 hostPid 重附着 survivor | `daemon/run.ts:196-218,1230-1271` |
| reconnect **丢弃未消费入站消息**：每次 reconnect 调 `skipExistingMessages()`→`fetchMessages` `if(skipRouting) continue` 且把 `lastSeq` 跳到 server-max | `runClaude.ts:302`、`apiSession.ts:518-569` |
| daemon 对普通会话**无 busy/idle 信号**：`reportEventToDaemon` 受 `HAPPY_SPAWNED_BY` 门控（仅 assistant）；daemon 只存 `agentStateVersion`，从不解密 agentState | `session.ts:222`、`daemon/types.ts:8-14` |
| **本地** persisted metadata **从不带** `claudeSessionId`（webhook 快照早于 Claude 赋 id，后续更新只到 server） | `run.ts:386-388`、`session.ts:256` |
| `buildResumeLaunch` 对无 `claudeSessionId` 的会话**抛异常**，且盲目追加 `--resume`（无 JSONL 存在性检查） | `handleResumeCommand.ts:68,78` |
| 正确的带守卫 launch（`claudeSessionId && <id>.jsonl 存在 ? --resume : 复用行 fresh HAPPY_RECONNECT`）在 assistant 重附着路径 | `run.ts:388-421` |
| `resumeSession` **不停旧进程**就 spawn（double-spawn 隐患）；`stopSession` 同步 fire-and-forget，2s→SIGKILL | `run.ts:871-925,936-968`、`processTermination.ts:24-49` |
| 15s webhook 超时**不杀子进程**→重试即 double-spawn | `run.ts:826-833` |
| recovered survivor **无 exit 监听**、exit code 被丢弃；恢复只按 `metadata.hostPid` 匹配（live pid 无法反查 sessionId） | `run.ts:810,1224`、`sessionProcessRecovery.ts` |
| claude SIGTERM 已是**干净断连**（`cleanup({archive:false})`，无 processFailed）；红条仅由 launcher catch 的 `'Process exited unexpectedly'` 触发 | `runClaude.ts:962`、`claudeRemoteLauncher.ts:570`、web `serviceEvent.ts:25` |
| **codex 无 SIGTERM handler**（2s 后硬 SIGKILL，无 deactivate） | `runCodex.ts`（无 `process.on('SIG…')`） |
| web 重启入口现状：`machineResumeSession`→`resume-happy-session` RPC | web `ops.ts:860`、`run.ts:1157-1165` |

## 设计

四个独立、可分开发布的部件 + 一处删除。

### 部件 1（基础，共享）——加固的重生例程 `respawnSession(sessionId)`

一个例程，供「一键重启」与「可选自动愈合」共用。硬要求：

- **带守卫 launch**（不用 `buildResumeLaunch`）：抽出 assistant 重附着的守卫逻辑——`claudeSessionId && <id>.jsonl 存在 ? --resume : 复用行 fresh HAPPY_RECONNECT spawn`（`run.ts:388-421`）。正确覆盖「无 claudeSessionId」的坏会话。
- **按 `sessionId` 的单飞互斥锁**，且**下沉到 daemon handler 层**：sweep、`/session-event` handler、以及既有 app 的 `resumeSession`/`stopSession`/`spawnSession`/`resume-happy-session` RPC 全部经同一把锁——这样新「Restart」与旧 web「Resume」并发也不 double-spawn。tracking 以 sessionId 建索引（不只 pid）。
- **等待式停止**：promise 化的 `stopSessionAndWait`，从 `terminateProcess` 的 settle 回调 resolve；spawn 严格在旧进程确认退出之后。**reactivate 必须 server-monotonic**（非仅时序在后）：旧进程的 `deactivate` POST + 至多 10s `flush()` 可能在 2s grace 被 SIGKILL 截断并 reorder 到 successor reactivate 之后（否则行显示 inactive 但 successor 活着）；successor 激活带一个 server 不回退的版本，或首个 keepAlive 重置 active。无此则靠周期 keepAlive 自愈为一次短暂 offline——因此属 Piece 3 前的加固，不是 Piece 1/2 阻塞项。
- **不漏子进程**：webhook 超时分支里，在释放锁/重试前先杀掉已 spawn 的子进程（修 `run.ts:826`）。
- **崩溃安全 successor 追踪（硬要求，最高风险路径）**：spawn 时持久化 `{sessionId → successorPid, spawnedAt, attemptCount}`；重启时**基于该持久化记录**对账（successorPid 活着且是 happy 进程→采纳，否则可安全重生）——**不是**基于 live 进程（live pid 反查不出 sessionId；`recoverableSessionPid` 只匹配 stale `metadata.hostPid`）。做错这一步会产生**持久的两写者损坏**而非自愈抖动。先建先测：在 spawn 与 successor-webhook 之间注入 daemon SIGKILL。
- **熔断**：每会话每 daemon 生命周期最多 N 次重生（默认 3）+ 退避；超 N 放弃，留行给按需 resume + 发一条会话内提示。
- **内存感知并发上限**（`min(3, floor(freeMem/600MB))`），按机器串行。
- 重生后发一条 subtle 会话系统消息：**「会话已在更新后重启——未被回答的内容请重发」**（复数安全：reconnect 会丢**所有**未消费消息，不止一条；UI 诚实，不假装无感）。

### 部件 2（首发，安全）——失败事件上的一键「重启会话」

web 已收到 `processFailed`（「Agent 进程意外退出」，`serviceEvent.ts:25`）。在其上挂一个内联「重启会话」动作 → 调部件 1。特性：

- **正向失败信号**（会话真的报了启动失败）——无脆弱谓词，零误伤 healthy 会话。
- 逐会话、用户发起、一键——对用户近乎无缝，blast radius 为零。
- 泛化到 B-266 之外：任何启动失败的会话都获得恢复入口。
- **注意**坏会话 wrapper 是 **live** 进程（0 秒错后 `while(!exitReason)` catch→continue 存活），故部件 1 必须能**停掉一个活着的进程再重生**（今日 `resumeSession` 不停活进程——正是要修的点）。
- 无需 server kill-switch、无需 fleet gating——可在 B-265/B-266 合并后立即发。

### 部件 3（可选，零点击，opt-in，加固）——daemon 自动愈合已证坏的会话

给「连一键都嫌多」的 fleet。daemon 仅在**正向死亡/失败证据**下自动重生，绝不用「缺 id」（review F1/F2）：

- server metadata 已取且仍无 `claudeSessionId`，**且**
- 会话有 server 记录的启动失败事件（`processFailed`/"process exited unexpectedly"）且**无成功 assistant 轮**，**且**
- 会话 cwd 内**无 `*.jsonl`**，**且**
- wrapper 年龄超过首轮安全阈值，**且**
- **失败事件是最新的会话活动**（无 seq 更新于失败事件的入站用户消息）——排除「用户重发→第 2 轮刚起」这唯一会让 healthy 会话瞬时满足前四条的窗口。评估此条需 daemon **拉取并解密会话消息日志**（`/v3/sessions/{id}/messages`，daemon 持 `encryption.encryptionKey`）——今日只取 metadata，属新代码。

外加：
- **server 端 kill-switch 必须先落地**（`autoUpgradeSessions:false` 走 `fetchCliUpdateState` 策略通道，每 heartbeat 复查——当前 payload 固定 `status/recommendedVersion/minimumVersion`，是 schema 变更）。只有 per-host env brake 的 fleet 不得开启自动愈合。
- 每机 sweep 汇总（attempted/succeeded/failed/skipped）写入 machine metadata 供远程观测。
- codex 坏会话：**除非证明受影响否则不在范围**（B-266 是 claude-SDK-root bug）；若 codex 受影响，需先给 codex 加 SIGTERM handler 再走守卫 codex 路径。

### 部件 4（独立 bugfix，解耦）——resume 队列完整性

让 `--resume`/reconnect 停止静默丢弃未消费入站消息（现状事实第 2 行）。对既有 resume 特性本身就值得做；**不是**部件 1-3 的前置（坏会话无东西可丢；部件 1 的提示诚实告知用户重发）。设计（另 spec）：从轮末路径（`claudeRemoteLauncher.ts:527`，SDK 返回后）记 `ackedSeq`，给 `MessageQueue2` 项带上源 seq，resume 时从 `ackedSeq` 起路由而非整段 skip；与 `queueCancellation` 对账。

### 删除——协作式 drain（v2 Stage 2）

R2/R3 否决：架构不可实现（`persistSession` 仅 daemon 可写、逐项 consumed-seq 不可计算、`onChildExited` 对 recovered survivor 不触发），且相对「按需重启/下次自然轮换」收益边际。除非有具体投诉证明部件 1-3 不足，否则不做。

## 兼容矩阵与发布顺序

- **部件 1+2 跨包**（cli daemon + web）。新增 daemon RPC（如 `restart-session`）：旧 web 不认→无此按钮，行为不变；新 web 打旧 daemon（无 handler）→按钮报「不支持，请升级」，绝不 double-spawn（web 侧优雅降级）。旧 web「Resume」打新 daemon→经同一把锁，安全。
- **部件 1 的会话内提示**是一条普通 session 消息，旧 web 正常渲染。
- **部件 3** 依赖 server 策略字段（`autoUpgradeSessions`）——server→CLI 顺序；字段缺省=开关关闭（保守）。
- 发布顺序：先合 B-265/B-266 → 部件 1+2（web 随 server 镜像、CLI 发 tag）→ 部件 4（独立）→ 部件 3（server 策略字段先行）。
- 回滚点：部件 1+2 的 CLI 上一版 + web 上一 sha。

## 风险

1. **崩溃对账做错 = 持久两写者损坏**（最高风险）。缓解：基于持久化 `{sessionId→successorPid}` 记录对账，先建先测（注入 daemon SIGKILL）。
2. reactivate/deactivate 时序反转 → 行短暂 inactive。缓解：server-monotonic 激活；周期 keepAlive 自愈；Piece 3 前加固。
3. 部件 3 谓词误伤 healthy 会话。缓解：5 合取正向证据 + 「失败事件为最新活动」+ opt-in + server kill-switch 先行。
4. reconnect 丢多条未消费消息。缓解：部件 1 诚实提示（复数）；部件 4 根治（解耦）。
5. codex 未覆盖。缓解：明确非目标 + 附证据（B-266 为 claude-SDK-root）；受影响则先加 codex SIGTERM handler。
6. 熔断与用户狂点「重启」交互。缓解：熔断按会话计数 + 退避；按钮在重生进行中禁用。

## 验收标准

- [ ] 部件 1：`respawnSession` 停活进程→确认退出→守卫 launch→等待 webhook；无 claudeSessionId 走 fresh HAPPY_RECONNECT，有 id+jsonl 走 `--resume`。
- [ ] 部件 1：sessionId 单飞锁覆盖 sweep + `resume-happy-session`/`resumeSession`/`stopSession`/`spawnSession` 所有入口；并发不 double-spawn（单测）。
- [ ] 部件 1：webhook 超时杀子进程再重试（单测）。
- [ ] 部件 1：spawn 时持久化 successor 记录；模拟 spawn↔webhook 间 daemon 崩溃后重启不产生第三进程（单测）。
- [ ] 部件 1：熔断 N 次后停并发提示（单测）。
- [ ] 部件 2：web 在 `processFailed` 上渲染「重启会话」，点击经加固 RPC（非裸 resumeSession），能停活坏 wrapper 并重生；旧 daemon 优雅降级（单测 + 真机）。
- [ ] 部件 1：重生后会话内出现「重发未回答内容」提示。
- [ ] 门禁：happy-cli build+tsc+unit 全绿、`--version` 冒烟；happy-web-v2 vitest+build+tsc 0 错；happy-server（若动）tsc+vitest。

## 留真机验证项

- web「重启会话」在真机（含手机 PWA）上的观感与降级提示。
- 一次真实 root 机器上的坏会话经一键重启恢复可用（B-266 回归）。
