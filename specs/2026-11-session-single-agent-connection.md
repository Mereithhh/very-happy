# 每个会话只允许一个 agent 连接生效（B-864）

> 状态：Final（随实现 PR 定稿；合并后回标 Shipped）
> 日期：2026-11-02 ｜ 关联 backlog：B-864 ｜ 前身：B-272 [单写者锁](2026-09-session-single-writer-lock.md)
> 代码：`happy-server/sources/app/api/socket/sessionAgentExclusivity.ts`、`socket.ts`、`relay.ts`；
> `happy-cli/src/api/agentInstance.ts`、`api/apiSession.ts`、各 runner 的 `superseded` 退出；
> `utils/sessionLock.ts`（claim 串行化）、`daemon/controlClient.ts` + `persistence.ts`（daemon 防分裂）

## 事故

Xu CHEN 11-02 20:32：会话里的 agent 说「已经有另一个会话在做这件事」——另一个 Claude 进程
（claude session `81074a3a…`）对话记录与本会话相同、收到了同一条消息、已改文件并在 9 台 ECS 上起了校准，
会话列表里看不到它。B-272 的单写者锁只在一台机器、一个 `HAPPY_HOME_DIR` 内有效，且 read→check→write
不原子；server 从不过问同一会话挂了几个 agent 连接：谁连进 `user:U:session:S` 房间，谁就收到每条用户消息。

## 能给同一 happySessionId 起第二个 wrapper 的路径

所有 daemon 路径都经 `HAPPY_RECONNECT_*` 交接，runner 先 `claimSessionOrExit`（takeover）再连 socket。

| 路径 | 防重 | 漏洞 |
|---|---|---|
| resume-happy-session（恢复、休眠唤醒、`send --resume`、automation） | per-session gate；锁/hostPid/命令行认领未跟踪 wrapper | 已 spawn 未回 webhook 的 wrapper 对另一个 gate 不可见 |
| restart-session / B-852 自动重启 / B-850 切账号 | gate `replace`；`stopSessionAndWait` 停整棵树 | 停 8 s 不掉仍 spawn；**两个 daemon 各有一套调度与 pid 表** |
| assistant 重附着（B-051） | `assistantSpawnGate` | 与 `resumeGates` 不是同一个 gate |
| 启动/handover 认领 | 锁 → hostPid → 命令行 | 发现重复只记日志，不收敛 |
| 终端 `very-happy resume` / `claude --resume` | 新 happy id | 不附着原会话（不是本问题） |
| 分叉（Web、`spawn --fork`、B-860、B-861 转分叉）、btw 侧聊 | 新 happy id / `persistSession:false` 无工具 | 不收原会话消息（不是本问题） |

锁本身的洞：① **非原子**：两个 takeover 方看到同一持有者，都等它退出、都写记录、都连上；
② **按 `HAPPY_HOME_DIR` 分目录**，不同 home 互相看不见；③ takeover 用单进程 `terminateProcess`，
需 SIGKILL 时 Claude 子进程成孤儿（daemon 的 `terminateProcessTree` 没这个问题）。

**daemon 分裂（已稳定复现）**：`checkIfDaemonRunningAndCleanupStaleState` 对一个 PID 活着、但 `/list`
2 s 内没回的 daemon（升级时 event loop 忙、笔记本唤醒）**删掉它的 state 和 lock**；随后的
`daemon start` / `ensureDaemonRunning` 拿到新锁，第二个 daemon 起来。两者共用 machineId 与
`sessions.json`、各跑一套自动重启；旧 daemon 下一次心跳发现「别的 daemon」自杀，**清理时又删掉新 daemon 的
state/lock**，新 daemon 随即也自杀（证据 `vh-team-B-864/ev/before/*-daemon.log`）。

Claude Code 2.1.304 实测 `--resume` 沿用原 session id，「新 id + 相同记录」只出自分叉类复制；Xu 机器上的
真实路径要等他的 `daemon list`/`ps`/daemon 日志确认（见 PR「未证实」）。

## 不变式与执法

**一个会话同一时刻只有一个 agent 连接生效，最新启动的 wrapper 进程获胜。**

握手（session-scoped socket、release-handover 候选 socket、regional relay socket）带上进程身份：

```
auth.agentInstance   每个 wrapper 进程一个随机 UUID
auth.agentStartedAt  进程启动时间（performance.timeOrigin，整数 ms）
```

按**进程启动时间**而不是连接先后排序：陈旧 wrapper 重连时是被拒，不会反过来踢掉新的（无乒乓）；两个副本同时裁决结论一致。

| 新连接 | 已在房间 | 结果 |
|---|---|---|
| 有身份 | 同 instance（handover 候选、断线重连） | 放行，不踢 |
| 有身份 | 更早启动的、旧 CLI（无身份） | 放行；旧的收到 `session-superseded` 后断开 |
| 有身份 | 更晚启动的 | 拒绝（`connect_error: Session superseded`） |
| 旧 CLI | 有身份的 | 拒绝：旧 CLI 每 ~3 s 重试也进不来，不再收消息 |
| 旧 CLI | 只有旧 CLI | 不变（B-864 前的行为） |
| 非 wrapper（无身份且 happyClient 不是 `cli-coding-session/`，如 happy-agent 原型） | — | 不参与 |

- **两处执法**：middleware `admit`（入房间前；陈旧者从未进房间，收不到一条消息）+ 连接后 `afterJoin`
  （两个新连接同时过 middleware 互相看不见；入房间后再裁决一次，后检查的一方必然看见先进来的）。
  房间查询走 adapter `fetchSockets`（跨副本，2 s 超时，失败放行——连通优先）。
- **relay**：同规则，在本进程房间里同步裁决后才 `join`；旧 relay 的「最新连接获胜」仅保留给旧 CLI 之间。
- **CLI**：收到 `session-superseded` 或 `connect_error: Session superseded` → 记日志 + stderr、冻结入站、关 socket、
  不再重连、发 `superseded`；runner 以新的退出意图 `superseded` 退出：停 agent 与子进程，**不写任何生命周期**
  （无 metadata 戳、无 session-end、无 deactivate/archive——会话属于继任者；B-272 事故第 4 条的反面）。
  Claude/Codex/Gemini/ACP/OpenClaw 都接上；hibernation 决策窗口里它优先于其他被推迟的退出。
- **日志**：server `warn` `event=session-agent-superseded`，`status=evicted|rejected`，`stale`/`winner` 的
  `startedAt` 与 `client` 版本（socketId 哈希）；`rejected` 每会话每分钟最多一行；指标
  `session_agent_superseded_total{outcome}`。CLI wrapper 日志 `[API] [SUPERSEDED] …`。

## 根因修复（CLI）

- `checkIfDaemonRunningAndCleanupStaleState`：探测**超时**＝忙，返回「在跑」且不动 state/lock；只有端口无人监听
  （拒绝/重置）才判定 PID 被复用并清理。`daemonProbeFailure` 分类。
- daemon 自我清理（关机、handover）只删**自己的** state 与 lock（`clearDaemonState(process.pid)`、
  `releaseDaemonLock` 比对锁文件 pid）；发现「别的 daemon」后本轮心跳不再写回自己的 state。
- `acquireSessionLock` 用 `<id>.json.claim`（O_EXCL，持 pid，死进程残留自动清）串行化整个 check→terminate→write：
  后来的 claimant 等前一个完成，再把它当持有者接管；等满 15 s 仍被占则让位。

## 兼容矩阵与发布顺序

| server | CLI | 行为 |
|---|---|---|
| 新 | 新 | 完整：新踢旧、陈旧者退出 |
| 新 | 旧 | 旧 CLI 之间不变；旧 CLI 与新 CLI 同会话时旧的被踢且重连被拒（进程留着但不收不执行） |
| 旧 | 新 | 旧 server 忽略多余握手字段；只剩 CLI 侧根因修复 |

协议只加字段与一个事件，双向兼容。**先发 server（含 relay）再发 CLI**；CLI 的根因修复不依赖 server。

## 验收（隔离 standalone server + daemon，证据 `~/code/github/skills/tmp/vh-team-B-864/`）

- [x] 修前：卡住 daemon 3 s + `daemon start` → 两个 daemon（`ev/before/*-daemon.log`），随后互相删 state 全部退出
- [x] 修前：同一会话两个 wrapper（第二个来自另一 `HAPPY_HOME_DIR`，锁看不见）同一毫秒都收到同一条消息（`ev/before/receipts.txt`）
- [x] 修后：同样卡住 + `daemon start` → 仍只有一个 daemon（`ev/after-busy-daemon-start.txt`）
- [x] 修后：新 wrapper 上线，旧的 2 s 内收到 superseded、无生命周期写入退出，消息只到新的；旧 CLI 被踢后重连被拒、不再收消息；旧 CLI 单独运行正常收消息（`ev/after/`）
- [x] 机制测试：`sessionAgentExclusivity.spec.ts`（矩阵）、`.integration.spec.ts`（真 socket.io：接管/陈旧重连/同进程 handover/旧 CLI/并发）、`relay.spec.ts`、
  CLI `apiSession.test.ts`、`sessionLock.test.ts`（并发 takeover）、`controlClient.test.ts`（忙 vs 无人监听）、`persistence.daemonOwnership.test.ts`、`sessionExitLifecycle.test.ts`、`codexTermination.test.ts`
