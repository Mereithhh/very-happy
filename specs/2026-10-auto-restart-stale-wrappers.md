# CLI 升级后自动原地重启旧 wrapper 会话

> 状态：Final（实现见 PR）
> 日期：2026-10-31 ｜ 关联 backlog：B-852 ｜ 前身：B-462（StaleWrapperBanner）、B-264（`restart-session`）、B-487（ModelSupportBanner）、B-587（休眠 check-in）

## 背景

CLI 升级（自动或手动）后 daemon 走 staged handover，但**正在运行的 wrapper 继续执行旧代码**（铁律 7：handover 不热替换存量 wrapper）。
新 wrapper 侧修复（例如 0.2.189 的 Codex 中断后保持权限）要等会话重启才生效。现在由 Web 横幅（B-462 / B-487）让用户自己点「重启」，
Owner 10-31：「用户也不知道该不该点……如果判断这个对话可以重启，就自动给它重启」。

## 目标

1. daemon 自己判断：会话 wrapper 版本旧于 daemon 版本，且下列**安全条件全部满足**时，自动执行与手动点击相同的原地重启（`restartSession`，历史保留）。Web 不开也工作。
2. 条件不满足就等，满足后再重启；不打扰用户。只有确实需要人决定（wrapper 不上报状态 / 失败 / 长时间等不到空闲）时 Web 才出横幅并保留手动按钮。
3. 自动重启后会话里出现一条不打扰的服务提示：「已更新到 x.y.z（会话已原地重启，历史保留）」。
4. 每台机器可在机器页关闭（默认开）。
5. 错峰（并发上限）、失败退避、绝不循环重启。

## 非目标

- 不热替换 wrapper 代码（仍是停旧→起新）。
- 不重启 web 终端（tmux）、terminal-mirror、用户在终端里直接跑的 local 模式会话、assistant 变体。
- 不给旧 wrapper 补上报能力（旧代码改不了）：旧 wrapper 只能靠它们已有的 B-587 check-in。
- Codex「CLI 已更新但 app-server 仍旧」（B-487 `codex-gpt6` restart）只对本版之后起的 wrapper 自动化（需要 wrapper 上报它启动时的 Codex 版本，见 §2.3）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 手动重启 = 停旧 wrapper 树、等退出、按 server metadata `--resume` 重新拉起，同 session row（HAPPY_RECONNECT_*） | `packages/happy-cli/src/daemon/run.ts` `restartSessionImpl` |
| 手动重启受每 session 每 daemon 生命周期 3 次熔断 | `daemon/restartBreaker.ts` `DEFAULT_MAX_RESTARTS` |
| UI 会话 wrapper（Claude：daemon+remote+非 assistant；Codex：daemon+无 TTY+非 assistant）每 5 分钟在**本地空闲**时向 daemon POST `/session-hibernate-check`，带完整状态快照（thinking / 队列 / waitingForInput / 待审批 / 后台任务 / 定时唤醒 / lastActivityAt / uiSession） | `hibernation/hibernationProbe.ts` `tick`；`claude/runClaude.ts`、`codex/runCodex.ts` `hibernationSnapshot` |
| check-in 只在 B-587（≥ v0.2.167）wrapper 里存在；teams / automation（`spawnedBy`）在 wrapper 本地就被拒、从不 POST | `hibernationProbe.ts` `evaluateWrapperIdle(snapshot, 1, now)` 门 |
| wrapper 每次调用都重新读 daemon state 文件，handover 后旧 wrapper 能找到新 daemon | `daemon/controlClient.ts` `daemonPost` |
| handover 后旧 wrapper 被重新收养进 `pidToTrackedSession`，metadata.version 是 wrapper 自己的版本 | `run.ts` 启动收养；`utils/createSessionMetadata.ts` |
| daemon 侧还有 turn 租约与后台任务租约 | `update/turnActivity.ts`、`BackgroundTaskTracker` |
| 退出时（SIGTERM）≥ v0.2.180 的 wrapper 写 exitCursor，重启后重放其后的输入（B-679） | `utils/reconnectSession.ts` |
| team 成员退出会给 lead 发 "Agent X: exited" 系统消息；重启后 scope 文件同 task/attempt，待投消息在 wrapper 回来后照常投递 | `daemon/teams/worker.ts`；server `teams/reducer.ts` |
| automation 进行中的 run 若 wrapper 退出会判 `session_exited` 失败；空闲 send/sticky 目标无影响 | `daemon/automations/runner.ts` `hasSession` / `monitor` |
| pi（acp）有 thinking / 队列 / 待审批状态但没有 check-in；`--resume <piSessionId>` → pi-acp `session/load` | `agent/acp/runAcp.ts`；`daemon/resumePrecheck.ts` |
| Web 渲染 `event.message` 的 `kind`（例：`claude-auth-failed`），未知 kind 退化为灰色服务行 | `happy-web-v2/src/screens/session/MessageView.tsx` `AgentEventBlock` |

## 设计

### 1. 触发点：wrapper 的 check-in（新鲜的空闲证明）

daemon 本身看不到 wrapper 的内存队列、待审批、后台 shell。唯一新鲜、完整的空闲证据是 wrapper 自己发来的 check-in 快照，而且 wrapper
只在本地判断空闲时才发。所以**自动重启的判定在 daemon 收到 check-in 的那一刻做**：快照就是此刻的状态，判定通过后立即停旧 wrapper。

- 旧 wrapper（≥ v0.2.167 的 UI Claude/Codex 会话）：已有 check-in，直接受益。
- 本版之后的 wrapper：快照只要满足「静止」（下表 1–6）就上报，不再要求休眠专属条件（spawn 来源、keep-awake、resumable），从而 teams / automation 会话也能被评估；同时上报能力 `auto-restart-v1`。休眠判定仍由 `decideDaemonHibernation` 全量执行，行为不变。
- pi：本版起 pi wrapper 也做同样的上报（flavor `acp`，休眠规则天然拒绝 `unsupported-flavor`，只用于自动重启）。

### 2. 安全条件（全部满足才重启；任一未知即视为不满足）

代码：`packages/happy-cli/src/update/autoRestartPolicy.ts` `decideAutoRestart`，每条对应一个拒绝原因。

| # | 条件 | 来源 | 拒绝原因 |
|---|---|---|---|
| 0 | 机器开关开启 | daemon 设置 `autoRestartSessions`（默认开） | `disabled` |
| 0 | wrapper 版本 < daemon 版本（或 §2.3 agent 版本落后） | 收养/webhook metadata.version | `not-stale` |
| 0 | daemon 跟踪着这个 pid 的活 wrapper | `pidToTrackedSession` | `not-tracked` |
| 1 | 没有进行中的 turn | 快照 `thinking` + daemon turn 租约 | `turn-active` |
| 2 | 没有待处理的权限请求/提问 | 快照 `pendingRequests` | `pending-request` |
| 3 | 消息队列为空、runner 停在等下一条消息 | 快照 `queuedInputs`（含 server prompt 队列）/ `waitingForInput` | `queued-input` |
| 4 | 不是本地终端模式 | 快照 `uiSession`（daemon 拉起 + remote + 非 `controlledByUser`），非 assistant 变体 | `local-terminal` / `assistant` |
| 5 | 没有后台任务 / 子 agent / 定时唤醒 | 快照 `backgroundTasks`（Claude 后台 shell + 子 agent；Codex 子线程）+ daemon 后台租约 + `scheduledWakeups` | `background-tasks` / `scheduled-wakeup` |
| 6 | 最近 **N = 10 分钟**没有用户输入或 agent 活动 | 快照 `lastActivityAt` | `recent-activity` |
| 7 | automation 没有进行中的 run（空闲 send/sticky 目标可以重启） | `automationRunner.hasSession` | `automation-running` |
| 8 | 能保住历史：flavor ∈ {claude, codex, acp}，且 `resumePrecheck` 通过（有 backend id、目录在、Claude transcript 在盘上） | **server 上的 metadata**（与 `restartSessionImpl` 同源）+ 本地磁盘；daemon 本地那份是 spawn webhook 时的快照，常常还没有 `claudeSessionId`（实测踩到） | `unsupported-flavor` / `not-resumable` |
| 9 | wrapper 不在退出中 | 快照 `exiting` | `exiting` |
| 10 | 机器级错峰：同时最多 1 个自动重启，两次之间 ≥ 15 s | 调度器 | `machine-busy` |
| 11 | 该 session 不在失败退避期、未放弃 | 调度器 | `backoff` / `gave-up` |

**N = 10 分钟的理由**：读完回复再打字的间隔绝大多数在几分钟内；10 分钟远离「正准备发消息」。即便撞上，重启只要几秒，期间发出的消息
落在 server 上，新 wrapper 按 exitCursor 重放（B-679），不会丢，只是晚几秒。更长（如 30 分钟）会让活跃使用的会话迟迟拿不到修复。

**团队成员**：不另设限制——turn 进行中（条件 1）不碰，空闲可以重启。重启沿用 B-730 `teamRelaunchEnvFor`（同 task/attempt 的 scope），
待投消息 5 s tick 内照常投递。自动重启的那次退出**不再**向 lead 报 `exited`（否则每次升级 lead 都收到一条「Agent exited」噪声）。

### 2.3 Codex agent 版本落后（B-487 `codex-gpt6` restart）

本版起 Codex wrapper 在快照里带 `agentVersion`（启动 app-server 时 `codex --version` 的结果）。daemon 用自己 `agentVersions`
快照里已安装的 Codex 版本比较，已安装 > 运行中即视为「落后」，同样走上述条件。旧 wrapper 不带该字段 → 不触发，横幅保持手动。

### 3. 调度、错峰、退避

代码：`packages/happy-cli/src/daemon/autoRestart.ts`。

- 并发上限 `AUTO_RESTART_MAX_CONCURRENT = 1`，间隔 `AUTO_RESTART_MIN_GAP_MS = 15 s`；被错峰挡住的会话回复 `nextCheckMs` = 15–45 s 抖动，wrapper 很快再来。34 个会话最快约 9 分钟走完，实际受各自 5 分钟 check-in 节奏自然打散。
- 回复的 `nextCheckMs` 取 min(休眠节奏, 自动重启节奏, **10 分钟上限**)：`recent-activity` → 到 10 分钟静止点；其他拒绝 → 休眠节奏。上限 `AUTO_RESTART_RECHECK_CAP_MS` 对**所有** wrapper 生效，**开关关闭时也生效**（QA25 P2-3：关闭期间 check-in 的 wrapper 曾拿到休眠节奏，生产默认 6 h，重新打开后长时间不被评估；代价只是关闭时每 10 分钟多一次本机 check-in）：休眠单独会把下次 check-in 排到数小时后（「阈值 − 已空闲」），有了上限，下一次升级后每个 wrapper 10 分钟内一定会被看一次。
- 每个 (session, 目标版本) 最多 **2 次**尝试；第 1 次失败退避 10 分钟，第 2 次失败放弃（`gave-up`），回到手动按钮并带失败原因。成功后 wrapper 版本 = daemon 版本，不再落后，天然不会再触发；另有按 (session, 目标版本) 的去重兜底，绝不循环。
- **离线失败**（QA25 P2-2）：旧 wrapper 已停、新 wrapper 没起来（如启动即退出），会话离线、不会再 check-in。规则：
  1. 立即发布 `failed`（`offline: true`，`reason` = 失败原因），sweep 与 wrapper 退出都不删它；会话重新在线（Restore、手动拉起、daemon 重试成功）时才清除。daemon 重启后不保留（下一次升级重新开始）。
  2. 第 1 次离线失败后带 `retryAt` = 失败时刻 + 10 分钟（同一退避），到点 daemon 自己重试一次，前提全部成立：开关开；本机没有该会话的 wrapper；server 上该会话 `active=false` 且未归档（用户没有 Restore / 归档 / 在别处续上）；机器名额空闲（否则 15–30 s 后再看）。任一不成立就不重试，去掉 `retryAt`，交给 Restore。
  3. 第 2 次失败 → `failed` 无 `retryAt`，交给 Restore；绝不第 3 次。
  4. Web：离线会话的 Restore 横幅显示「自动更新失败（原因），会话已离线。约 HH:mm 会自动再试一次，也可以现在恢复」/ 最后一次后「点恢复继续」，按钮仍是 Restore。
  - 选择重试而不是直接交给 Restore 的理由：启动失败可能是瞬时的（安装中途、磁盘/网络抖动）；server 侧 active/archived 检查保证不会把用户已处理（恢复/归档）的会话再拉起来。
- 成功的判定：`restartSession` 返回 success（新 wrapper 已 webhook）且新 wrapper 版本不再落后。
- 自动重启不计入手动重启的 3 次熔断（各自独立上限），避免自动那一次吃掉用户的手动额度。
- 决定与占用机器名额（inFlight / lastStartedAt）同步完成，中间没有 await：两个会话同时通过便宜规则时也只会启动一个（单测覆盖）。
- 停旧 wrapper 前最后再查一次 daemon 的 turn / 后台租约与 automation run，任一变化就放弃这次（等下次 check-in）。

### 4. 状态发布与 Web

daemon 把落后会话的状态发到 `daemonState.autoRestart`（签名去重，变化才写；同一能力的 restamp 规则：`detectedAt >= startedAt` 才可信）：

```ts
autoRestart: {
  enabled: boolean, rpcAvailable: true, detectedAt: number,
  sessions: { [sessionId]: {
    state: 'waiting' | 'restarting' | 'failed' | 'manual',
    reason?: string,         // 最近一次拒绝原因 / 失败原因
    since: number,           // 首次发现落后的时间（开关关闭/重开不重置，QA25 P2-3）
    target: string,          // 要更新到的版本
    offline?: true,          // failed：旧 wrapper 已停、新的没起来（§3 离线失败）
    retryAt?: number,        // 离线失败：daemon 会在这个时刻自己再试一次；无 = 交给 Restore
  } },
}
```

`manual` = 该 wrapper 不会上报（旧于 B-587、assistant、终端 local、teams/automation 的旧 wrapper、pi 旧 wrapper），daemon 永远等不到证明，
直接交给人。

终端会话（QA25 P2-1）：从终端启动的 wrapper（`metadata.startedBy = 'terminal'`）不跑 probe、永远不 check-in，sweep 直接判 `manual`（reason `local-terminal`），不再进 `waiting/awaiting-check-in`。用 wrapper 自己的 `startedBy`，不用 daemon 的 tracked.startedBy（升级时 daemon 重启后会变成 persisted/recovered）。daemon 拉起后切到本地控制（`controlledByUser`）的 Claude 会话仍会 check-in，`uiSession=false` 即判 `local-terminal` → `manual`。

`since` 按 (session, 目标版本) 记一次：开关关闭期间不发布状态，但计时保留；重新打开后沿用原 `since`，不会把 60 分钟长等待横幅往后推。

Web 规则（`happy-web-v2/src/app/autoRestartPolicy.ts` `restartBannerMode`）：

| daemon / 状态 | 横幅 |
|---|---|
| 旧 daemon（无 `autoRestart`）或开关关闭 | 原 B-462/B-487 横幅（手动） |
| `manual` | 原横幅（手动），立即显示；`local-terminal` 时写明「在你的终端里运行，不会自动更新」 |
| `failed` + `offline`（会话离线） | Restore 横幅写明自动更新失败原因与是否会自动再试（§3） |
| `failed` | 横幅：「自动更新失败：<原因>」+ 手动重启 |
| `waiting` 且等待 < 60 分钟、`restarting` | 不显示 |
| `waiting` 且等待 ≥ 60 分钟 | 横幅说明为什么还没更新（例：「有后台任务在运行，空闲后会自动更新」）+ 手动重启 |
| 机器 daemon 启动不到 3 分钟、尚未发布该会话状态 | 不显示（等 daemon 分类） |

B-487 `claude-opus-55` restart 由 wrapper 版本落后引起，走同一规则；`codex-gpt6` restart 只有在 daemon 已把该会话列入（§2.3）时才隐藏。

### 5. 服务提示

daemon 重启时给新 wrapper 带 `HAPPY_AUTO_RESTARTED_FROM=<旧版本>`；新 wrapper（新代码）连上后发一条
`{ type: 'message', kind: 'session-auto-updated', message: 'Updated to Very Happy <新版本> (session restarted in place, history kept)' }`。
新 Web 按 `kind` 渲染本地化灰色服务行（不触发通知、不改未读）；旧 Web 显示英文原文灰色行。该事件不进入 agent 上下文。

### 6. 开关

机器页「会话自动更新」：开（默认）/ 关。RPC `auto-restart-set { enabled }`，存在 daemon settings `autoRestartSessions`，与 B-587 休眠阈值同样模式。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 daemon + 旧 wrapper（≥0.2.167 UI） | 已有 check-in 触发自动重启 |
| 新 daemon + 旧 wrapper（teams/automation/pi/assistant/<0.2.167） | `manual`，横幅同今天 |
| 旧 daemon + 新 wrapper | 新 wrapper 多发的 check-in 被旧 daemon 拒（`spawn-origin`/`teams`/`unsupported-flavor`），无副作用；多出的 `agentVersion` 字段被 `.passthrough()` 接受 |
| 新 Web + 旧 daemon | 无 `autoRestart` → 原横幅 |
| 旧 Web + 新 daemon | 原横幅照常出现（点了也能用）；自动重启后横幅自然消失；服务提示显示英文 |

不加 server 字段、不加 migration。发布：Web（镜像）与 CLI 互不依赖；CLI 发布后机器自动升级即生效（自动重启的是升级后仍在跑的旧 wrapper）。

## 风险

1. **check-in 与停进程之间的毫秒级竞态**：快照通过后到 SIGTERM 之间若恰有消息到达并开始 turn，turn 会被打断。缓解：10 分钟静止门让概率极低；停前再查 daemon 租约；消息本身不丢（B-679 exitCursor 重放，wrapper ≥ 0.2.180）。接受。
2. **旧 wrapper check-in 节奏**：旧 daemon 曾回复的 `nextCheckMs` 可能长达「休眠阈值 − 已空闲时长」（默认最多 6 h），这类会话要等到那次 check-in 才会被重启。接受：此前它们会一直旧下去；最迟到休眠点。
3. **prompt cache**：重启后 Claude `--resume` 重新加载 transcript；若新 wrapper 改了系统提示 / MCP 工具清单，首轮 cache 可能部分失效（实测见 PR）。只发生在空闲 ≥10 分钟之后，此时 5 分钟 TTL 的 cache 本就过期。
4. **重启失败**：最多 2 次，之后回到手动按钮并显示原因；永不循环。旧 wrapper 已停后的失败（会话离线）同样最多 2 次，Restore 横幅显示原因（§3 离线失败）。

## 实测（2026-10-31，隔离 daemon + standalone server，`HAPPY_AUTO_RESTART_QUIET_MS=90000`）

第一轮 0.2.189（npm 原版）→ 新 daemon：

| 会话 | 升级时状态 | 结果 |
|---|---|---|
| a1 Claude | 空闲 | 首次 check-in 即重启；问「第一条消息让你回什么」答对；同一 transcript，cache_read 27.1k→30.2k |
| a5 Codex | 空闲 | 重启；上下文在；同一 rollout，cached 12224/12514 |
| a2 / a4 Claude | 后台 shell（sleep 600 / 480） | 等到后台任务结束后才重启 |
| a8 Claude | 前台 turn（500 s） | turn 结束后才重启 |
| a3 Claude | AskUserQuestion 待回答 | 一直不动；在 Web 回答后约 2 分钟重启，权限模式 `default` 保留 |
| a6 Claude `--spawned-by automation`（旧 wrapper） | 空闲 | 不动，Web 显示原手动横幅（旧 wrapper 不上报） |
| a7 pi（旧 wrapper） | 空闲 | 同上 |

第二轮新 wrapper → 再升级：automation sticky 会话、team lead、team 成员、pi、上一轮的 7 个会话全部在约 7 分钟内依次重启（间隔 20–50 s，一次一个）；
重启后 `auto run` 仍落在同一 sticky 会话，lead 给成员发 team_message 成员照常回复且能调 team 工具，lead 没收到 "exited"；
pi 问答上下文在；进行中的 automation run（b4，前台 10 分钟）没被打断，run 结束 `done` 后 1.8 分钟才重启。
Web：重启后会话里两行灰色服务提示（中英），机器页「会话自动更新」开关经真 RPC 写入 `autoRestartSessions`。

首次实测发现并已修：① 用 daemon 本地 metadata 判 resumable 导致全部判 `not-resumable` → 改用 server metadata；② 机器名额在 setImmediate 里才占，两个会话可能同时重启 → 改为同步占位。

## 验收标准

- [ ] 条件逐条在 `decideAutoRestart` 有拒绝原因与单测；源码接线测试过 mutation-check。
- [ ] 隔离 daemon：旧 CLI 起空闲 / turn 中 / 待审批 / 后台 shell / 团队成员 / 自动化会话 → 升级 → 空闲的被自动重启（wrapper 版本变新、历史在），不安全的保持，条件满足后再重启。
- [ ] Web：自动重启后服务提示；横幅只在 manual / failed / 长等待时出现；机器页开关；桌面 + 手机、中英文截图。
