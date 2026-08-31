# Web 回前台重同步（唯一 resume 入口 + socket 存活探测 + 终端 catch-up 调度）

> 状态：Final
> 日期：2026-08-31 ｜ 关联 backlog：B-259 ｜ 出处：Owner 实报「移动端从后台切回前台，终端 session 不刷新、普通会话进度不更新，有时要手动刷新页面」；方案经 3 轮对抗 review（记录见会话临时目录 `web-resume-sync/plan-v1..v3.md`、`review-r1..r3.md`，不进 repo）

## 背景

移动端 Web（iOS Safari/PWA、Android Chrome）后台一段时间再回前台：终端画面停在旧内容，
Claude 会话看不到 agent 后台期间的进展；手动刷新页面后一切正常 ⇒ 服务端状态没问题，
问题全在 Web 客户端对「socket 是否还活着」与「什么时候重拉」的判断。

调查中被推翻的第一直觉：「回前台后最长 60s 才断开重连」。socket.io-client 每次 emit 都会检查
`engine._hasPingExpired()`（用 `Date.now()` 比较，不受页面冻结影响），所以**后台 ≥ 最后一次
ping + 60s 的僵尸连接在回前台的第一次 emit 就会被关掉并自动重连**。真正的洞有两个：

1. **长后台**：自动重连 `recovered=false` → `onReconnected` 全量 invalidate，**但从不重拉当前
   会话的消息**（注释引用的「SessionView 在 realtimeStatus 变化时调 onSessionVisible」在 web-v2
   不存在），而 `onWebResume` 又被 `document.hasFocus()` 门住（iOS 回前台 hasFocus 常为 false、
   window focus 不触发）。agent 在后台期间已经完成 → 不再有新消息触发 seq 缺口重拉 → 聊天停在旧消息。
2. **短后台（<60s）**：连接半开（`connected===true` 但收不到包），engine ping 定时器到点才关，
   此时 server 侧断线通常 <30s → `recovered=true` → **不触发 `onReconnected`** → 终端没有任何
   catch-up 触发（visibility 那次 catch-up 已挂在僵尸链路上，等 60s RPC 超时后静默放弃）。

## 目标

- 回前台**立刻**、不依赖 socket 状态地刷新当前视图（会话列表、当前会话消息、机器、artifacts）并
  触发终端 catch-up。
- 回前台后对控制 socket 与已连 regional relay 做**一次**存活探测，死链路 5s 内强制重连。
- `recovered=true` 的重连也做有界重拉；`onReconnected` 补上当前会话消息。
- 终端 catch-up 失败不再静默放弃：退避重试；relay 重建 / 回退 legacy 是重同步点。
- 零协议改动、零 server/CLI 改动（server 只改一条过期注释）；桌面用户切 tab 的开销**下降**。

## 非目标

- 不改 server `pingInterval/pingTimeout`（会波及 daemon 与权限 RPC 的判死阈值）。
- 不引入新 wire 事件/字段（server 已有可 ack 的 `ping`，relay 已有 `relay-ping`）。
- 不自动重放被强制重连 reject 的在途 RPC（daemon 可能已执行）。
- 不修 `thinking` 在会话后台死亡时可能永久 true 的既有缺陷（另立 backlog）。
- 不动终端 catch-up 的 RPC/apply 主体与 outChain 顺序。

## 现状事实（代码已确认，基线 `main@89ed7561`）

| 事实 | 位置 |
|---|---|
| resume 重同步只在 `getCurrentAppState()` 从 background→active 时触发；active = visible && `document.hasFocus()` | `packages/happy-web-v2/src/sync/sync.ts:231-257`，`src/sync/apiSocket.ts:25-35` |
| web 上 AppState shim 的 'active' 也是 visible && hasFocus，`sync.ts:179-215` 的 10 个 invalidate 在 web 同样会跑 ⇒ 一次 resume 三条平行路径 | `src/shims/react-native.ts:21-56` |
| `onReconnected` 只在 `!socket.recovered` 时触发；不重拉当前会话消息 | `src/sync/apiSocket.ts:526-535`，`src/sync/sync.ts:2297-2318` |
| `SessionDetailScreen` 只在 `[id]` 变化时调 `onSessionVisible`；无任何 screen 消费 `realtimeStatus` | `src/screens/session/SessionDetailScreen.tsx:47-56` |
| `Socket.emit` 每次检查 `engine._hasPingExpired()`；过期则 `nextTick(() => _onClose('ping timeout'))`（nextTick = `Promise.resolve().then`）；`_onClose` → manager `onclose` → socket `onclose` 全程同步 ⇒ 一个微任务后 `connected===false` | socket.io-client 4.8.3 `build/esm/socket.js:236-273`，engine.io-client 6.6.4 `build/esm/socket.js:373-384, 503-537`，`globals.js:1-9`，`manager.js:176-180, 299-311` |
| `socket.connect()` 在 manager 退避中（`_reconnecting`）是 no-op；`disconnect()` 清退避定时器并 reject 在途 ack（`_clearAcks`，不含 sendBuffer 中未发出的包）；客户端主动 disconnect 的重连恒 `recovered=false` | socket.io-client `socket.js:185-192, 459-470, 648-660`，`manager.js:280-284` |
| server 对所有 clientType 注册可 ack 的 `ping`（handler 第一个参数就是 callback，**不能带 payload**）；CLI 已在用 | `packages/happy-server/sources/app/api/socket/pingHandler.ts`，`socket.ts:375`，`packages/happy-cli/src/api/apiSession.ts:1105` |
| relay 对每条连接注册 `relay-ping` ack；web relay socket `reconnection:false`，掉线只标 legacy fallback + 30s 冷却，不触发任何 catch-up | `packages/happy-server/sources/relay.ts:116-121`，`src/sync/apiSocket.ts:472-504` |
| relay `disconnect` 处理器第一行按 map 身份判断，先摘 map 则整段跳过（含状态回写） | `src/sync/apiSocket.ts:499-504` |
| `machineRPC`/`sessionRPC` 在 `await encryptRaw` 后不再检查 relay 是否仍连接；死 relay 上的包进 sendBuffer 永不发出，直到 ack 定时器（60s）reject | `src/sync/apiSocket.ts:301-336, 212-261` |
| 终端 catch-up 的 open-terminal RPC 在 outChain 内 await，快照 `term.reset()` 依赖「restore 先于在途 live 写入」不变量；失败 `if (!res.success) return` 静默；`catchUpAgain` 重跑丢掉 `opts`（forceSnapshot） | `src/screens/terminal/WebTerminalScreen.tsx:1238-1293, 967-975, 1001-1012`，`termStreamSync.ts:89-93` |
| `thinking` 靠 REST 刷不回：`fetchSessions` 写 `thinking:false` 后被 `preserveSessionActivityFromStore` 保住本地旧值；唯一收敛来源是 CLI 每 2s 的 keepAlive | `src/sync/sync.ts:1110-1118`，`src/sync/sessionSnapshot.ts:7-17`，`packages/happy-cli/src/claude/session.ts:112-116` |
| server `connectionStateRecovery` 已开（30s），注释「Currently OFF」过期 | `packages/happy-server/sources/app/api/socket.ts:56-70` |
| server 与 web 同一不可变镜像，「新 Web + 旧 server」只在蓝绿切换瞬间存在 | AGENTS.md 铁律 5 |

## 设计

### A. 唯一 resume 入口 — `src/sync/resumeSync.ts`（纯函数）

- `decideResume(state, event, now)`：hidden→visible 边沿；`pageshow` 仅 `persisted===true`；`online` 仅当
  visible；Chromium Page Lifecycle `resume`；1s 去抖。**不看 hasFocus**。首次加载无边沿不触发。
- `sync.ts`：web 分支只保留 `sendAppState(getCurrentAppState())` 广播（推送抑制语义不变）；resume 由
  `attachResumeListeners` 驱动 `onWebResume`；AppState shim 'active' 分支在 web 不再 invalidate。
- `onWebResume` 立即并行：① REST 集合 `sessionsSync` + `onSessionVisible(current)` + `machinesSync` +
  `artifactsSync`（purchases/profile/pushToken/nativeUpdate/friends/feed 只随全量 reconnect）；②
  `sync.onResume` 监听者（终端 `scheduleFit()` + catchUp）；③ `apiSocket.checkLiveness()`。
- 桌面 alt-tab（visibility 不变）不再触发刷新：**有意为之**，socket 活着时实时事件覆盖。

### B. 存活判定 — `src/sync/socketLiveness.ts`（纯函数）+ `apiSocket.checkLiveness()`

控制 socket，同一宏任务内固定顺序：`sendAppState()`（一次 emit）→ `await Promise.resolve()` → 读
`socket.connected`：
- `!connected` 或 `handoverInFlight` → `skip`（manager 自动重连在跑；handover 落定后补跑一次）。
- `connected` → `socket.timeout(5000).emitWithAck('ping')`（无 payload）。ack → alive。否则（超时或
  reject 一律）**再校验** `this.socket===socket && socket.connected && !handoverInFlight` 才 `disconnect();
  connect()`；否则 none。并发调用共享同一次运行（每次 resume 至多一次动作）。
- 5s 而不是 3s：蜂窝无线电唤醒 0.5–2s + RTT；误判代价是 reject 所有在途 ack + 全量重拉。
- **不用入站包判活**：出站单向死（浏览器 WebSocket CLOSING 时 `send()` 静默丢弃）时入站仍有包。
- relay（每 machine 一条）：对已连 relay `relay-ping` 同样「emit → 微任务 → 读 connected」再等 ack；死亡
  固定顺序 `relaySockets.delete` → `relayRetryAfter.delete` → `updateRelayStatus(connecting)` → `close()`
  → `ensureMachineRelay({strictPing})`；新 socket 连接后 `relay-ping` 再失败 → 常规 30s 冷却（封顶）。
  `relayConnecting` 在途 → 跳过。
- `machineRPC`/`sessionRPC`：`await encryptRaw` 后、emit 前再读 `relaySocket.connected`，false 改走控制
  socket（尚未发出任何包，无双执行）；catch 里冷却/fallback 只在 `relaySocket === relaySockets.get(machineId)` 时写。
- `auth` 改函数形式：重连时 appState/token 最新。

### C. 触发互斥表

| 事件 | 动作 |
|---|---|
| resume 边沿 | A 的 REST 集合 + 终端 catchUp + liveness（只一次） |
| `connect` && recovered=false | 既有 `onReconnected` 全量 **+ `onSessionVisible(current)`** |
| `connect` && recovered=true | 新 `apiSocket.onRecovered` → sessions + current + machines + 终端 catchUp |
| relay `→connected`、`connected→fallback` | 终端 catchUp（调度器对 1s 内刚成功去重） |
| handover 落定 | 补跑一次 liveness |

四场景（长后台 / 短后台死 TCP / 短后台健康 / 干净关闭 recovered）逐一模拟：每端点 ≤2 次 fetch，无「都不刷新」的洞。

### D. 终端 catch-up — `src/screens/terminal/termCatchUpScheduler.ts`（纯函数）

- RPC **留在 outChain 内**（移出会让快照 `term.reset()` 抹掉在途 live 输出且永不重放）；只加
  `timeoutMs: 10_000`（`machineOpenTerminal` 第三参透传 `machineRPC`）。
- 调度状态机 idle/inflight/backoff/gone：在途时合并一次 `again`（forceSnapshot 取 OR）；失败退避
  1→2→4→8→15s 封顶、最多 8 次；`again` 合并进重试而非立即再发（单一重试源）；新触发重置退避；
  非 forceSnapshot 触发在上次成功 1s 内去重。RPC/apply 主体一字不动。
- 触发源：resume、`onReconnected`、`onRecovered`、relay 两条边。

### 被否方案（留档）

- `lastPacketAt` 陈旧即强制重连：排队的 ping 帧与 visibilitychange 派发顺序无保证，会误杀健康连接。
- `hiddenFor ≥ 60s` 规则：用错时钟（engine 看的是最后一次被 JS 处理的 ping）。
- 把 open-terminal RPC 移出 outChain：破坏快照不变量（blocker）。
- 新增 `client-ping` / `server-hello caps`：server 早有 `ping` ack，且同镜像不需要能力协商。
- 收紧 server ping 参数：波及 daemon 与权限 RPC。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 任何已部署/可回滚 server | `ping` ack 早已存在；无新 wire 字段 |
| 新 Web + 旧 daemon | catchUp 仍是既有 `open-terminal`；daemon 双发 control+relay，`shouldIgnoreLegacyRealtime` + seq dup/gap 去重；<0.2.29 daemon 把退避重试计为新 subscriber（可接受） |
| 旧 Web + 新 server | 同今日 |
| polling transport | manager ping/packet 同样到达 |
| 桌面切 tab | 一次 REST 集合 + 1 RTT 探活（今天是 12 个 invalidate） |
| release handover | 期间跳过；落定后补一次 |
| recovery 开/关 | 关 ⇒ recovered 恒 false ⇒ 全量 |

发布：web 单包，随完整镜像蓝绿切换；不涉及 CLI/daemon，不需要 `vh-update`。回滚点：上一镜像。

## 风险

1. 终端调度器重写（桌面每次切 tab / gap 都经过）—— 缓解：RPC/apply 主体不动，只抽「发起/again/退避」；
   纯函数测试覆盖 again∧forceSnapshot、失败不双发、三个终止条件。
2. 误判死链路 → reject 所有在途 ack（bash 300s sessionRPC、fs、权限 RPC）—— 缓解：5s 探活 + 再校验 +
   每次 resume 一次动作；verboseLogging 打 `forcing reconnect`。
3. 强制重连后 server 侧旧 socket 残留 ≤60s，参与 push 抑制判断 —— 接受。
4. iOS `hasFocus()` 行为未在真机核实 —— 设计已不依赖它；verify-queue 抓一次事件顺序。
5. socket.io 小版本改 nextTick/`_hasPingExpired` 语义 —— 缓解：真 socket.io 集成测试锁住。

## 验收标准

- [ ] 纯函数测试：`resumeSync`（边沿/去抖/pageshow persisted/online 门控/hasFocus 无关）、`socketLiveness`
      （skip/alive/reconnect/再校验）、`termCatchUpScheduler`（again 带 forceSnapshot、失败退避不双发、gone/aborted、去重、封顶）。
- [ ] `apiSocketLiveness.test.ts`：alive 不重连；超时且仍连接 → 恰一次 disconnect+connect（并发共享）；
      reject 且已断 → 不重连；emit 已关 engine → 不探活；relay 重建状态序列 connected→connecting→connected、
      无 30s 冷却；strictPing 封顶；encrypt 后 relay 断开改走控制 socket；recovered 触发 onRecovered。
- [ ] `socketIoResume.integration.test.ts`（真 socket.io）：无 payload `ping` 得 `{}`、带 payload 无 ack；
      ping-expired 后一次 emit 一个微任务内 `connected===false` 且自动重连；退避中 `disconnect();connect()`
      立即 open 且 `_reconnecting=false`；强制断开 reject 在途 ack、sendBuffer 包连接后送达；主动 disconnect
      ⇒ `recovered=false`、transport 掉线窗口内 ⇒ `recovered=true`。
- [ ] `onReconnected` 重拉当前会话消息；`onRecovered` 有界集；web 上 AppState 'active' 不再 invalidate。
- [ ] 门禁：web vitest / vite build / tsc 0；server tsc。
- [x] 本地 E2E（headless Chrome 151 + standalone server + 隔离 daemon，CDP 观测 console/REST/WS 帧 + 截图对照 tmux，2026-08-31）：
      短后台健康 → 一组 REST + `ping` ack、无重连；renderer SIGSTOP 25s → 同上不误杀；server SIGSTOP（死链路）→ 5.3s 恰一次强制重连、恢复后全量集 + 终端补齐；
      renderer SIGSTOP 70s（iOS 式长后台）→ 1.7s 重连 recovered=false 全量集；CDP 冻结 15s（Android 式）→ 1.8s 重连 **recovered=true** 走 `onRecovered` 有界集 + catch-up，终端与 tmux 一致。
      未覆盖：真实 iOS/Android（V-105）、Claude 会话消息 forward-fetch（本地无会话）。

## 留真机验证项

- iOS Safari 与 PWA：锁屏 1min / 5min 回来，终端画面与 Claude 会话 ≤10s 内追平，不刷新页面。
- Android Chrome：切后台 1min / 10min 同上。
- Safari 远程调试抓一次回前台事件顺序（`visibilitychange` / `pageshow` / `focus` 与 `hasFocus()` 值）留档。
