# 新会话秒开 + 发送确认态 + 去掉正文悬停时间

> 状态：Draft
> 日期：2026-09-30 ｜ 关联 backlog：B-512（新会话秒开）、B-513（发送确认态）、B-514（去掉正文悬停时间）

## 背景

Owner 2026-09-30：「每次启动新的 claude sdk session 都加载特别慢，希望尽量优化到秒开」「发送消息直接上屏，但这时消息还没发给后端，希望先 loading，真的发出去了再上屏；发消息也非常卡」「消息正文鼠标 hover 会展示时间，这个逻辑去掉」。

## 目标

1. **B-512**：Web 点新建 → 会话页可输入，在 dev-sg（主力 daemon 主机）上从现状 ~3–4 s 降到 ≤1.5 s（p50），daemon 侧 spawn RPC 耗时 ≤0.8 s。
2. **B-513**：用户消息在服务端确认落库前显示「发送中」（变淡 + 转圈），确认后才成为正常消息；超时/失败显示「发送失败」并可重试或放回输入框；常见路径不再白等中继超时。
3. **B-514**：正文、思考、事件、工具行的外层 `title` 悬停时间全部去掉；消息底部可见的 `HH:mm`（`<time>` 自身的完整时间悬停）保留。

## 非目标

- 预热 Claude 进程（SDK `startup()` / `WarmQuery`）缩短首 token：首条消息的 model/permission/appendSystemPrompt 在 spawn 时未知，不匹配要丢弃重开，且每个空闲会话多一个 Claude 进程与 SessionStart hooks。单独记 backlog，本批不做。
- daemon 预热 wrapper 进程池、daemon 代建 session 行（改 hostPid/metadata 归属，风险大于收益）。
- 乐观跳转（spawn 返回前先进 pending 会话页）。
- outbox 持久化到 localStorage（刷新前未确认消息丢失——现状即如此，本批只让它可见）。
- B-509 服务端队列行的乐观显示；消息列表虚拟化 / `applyMessages` 全量重排优化。
- 任何 wire/protocol 字段变更。

## 现状事实（代码已确认 / 实测）

| 事实 | 位置 / 证据 |
|---|---|
| dev-sg daemon spawn→webhook 2.6–3.6 s；其中 wrapper Node 冷启动（进程创建→首行日志）~2.2 s | dev-sg daemon 日志 04:04:29.094 Spawned → 子进程首行 04:04:31.342 → webhook 31.716 |
| `very-happy --version` dev-sg 2.1 s、主力 Mac 0.47 s；编译缓存仅省 ~10% | 实测 |
| 入口静态 import 全部依赖；单独 import 耗时（dev-sg）：ink 558 ms、sandbox-runtime 445 ms、inquirer 405 ms、MCP sdk 267 ms、claude-agent-sdk 249 ms、axios 211 ms | `dist/index.mjs` import 列表；逐包实测 |
| spawn 路径同步等待登录 shell 探测（`$SHELL -l -i -c`，超时 3 s，成功缓存 60 s） | `daemon/run.ts:430` → `agentHome/loginShellEnv.ts:19,78`、`agentHome/index.ts:36-38` |
| web spawn 不设 `TMUX_SESSION_NAME` 却仍跑 `isTmuxAvailable()` | `daemon/run.ts:754` |
| wrapper 在 daemon 已注册机器时仍串行 `getOrCreateMachine`（首个 HTTPS，含建连） | `claude/runClaude.ts:160` |
| session socket 在 webhook 之后才创建；首条消息等它连上（Mac 实测 1.18 s） | `runClaude.ts:322,342`、`apiSession.ts:184,200` |
| web `new-session` update 只触发全量 `GET /v1/sessions` 重拉，会话页 loader 等它 | `sync/sync.ts:2629-2631`、`SessionDetailScreen.tsx:150-157`；update 已带完整 session（server `eventRouter.ts:360-390`） |
| 乐观消息在加密后即入 store，`seq` 为空；服务端 ack（`{id,seq,localId}`）只用来推进 `sessionLastSeq` | `sync/sync.ts:888-914,2119-2129` |
| 消息模型无发送态，只有 `inputState: queued/canceled` | `typesMessage.ts:41`、`reducer.ts:1459-1487` |
| web outbox 失败无限退避重试，web 上从不判失败 | `sync.ts:517,593,2077-2147`、`utils/time.ts:41-68` |
| 中继投递：最多等 800 ms 建连 + 3 s ack 超时，失败才回落 HTTP | `apiSocket.ts:356-380,738` |
| 附件逐个串行上传后文字才入屏 | `sync.ts:813-879` |
| 悬停时间 = 外层 `.msg` 的 `title` | `MessageView.tsx:55,75,97,186,210,292,320,324,331,348,361,420`、`TeamMessageCard.tsx:19`、`SessionPeerMessageCard.tsx:21`、`SubagentDetail.tsx:97,124`、`ToolGroupView.tsx:149,169,177,261`；测试 `messageTimestamp.test.tsx:69-130`；设计文档 `docs/design-language.md:335,337` |

## 设计

> 2026-09-30 经两路对抗式 review 修订（启动侧 3 BLOCKER/7 MAJOR、发送侧 3+1 BLOCKER/8 MAJOR），下文为修订后方案。

### B-512 新会话秒开（daemon + CLI + web，无协议变更）

1. **入口瘦身 + 自检**
   - `dist/index.mjs` 变成小 stub：`module.enableCompileCache?.()`（Node ≥22.8 有；缓存目录 `$HAPPY_HOME_DIR/cache/compile`，不设 `NODE_COMPILE_CACHE` 环境变量以免泄漏给子进程）→ `--version` 快路径 → `await import('./main')`。
   - 新增隐藏 `--self-check`：`await import()` 全部懒加载模块（单一列表 + 单测保证 `src` 里每个 `import()` 目标都在列表里），`preflightNewBundle`、CI、release smoke、铁律 2 改用它（`--version` 不再加载模块图，不能再当自检）。
2. **切断把重模块拖进 wrapper 的静态链**
   - `initialMachineMetadata` 从 `daemon/run.ts` 抽到独立小模块；`detectCLIAvailability()` 改为 `startDaemon` 内惰性计算，不再是模块顶层副作用。
   - `ApiClient.machineSyncClient` 改异步（动态 import `./apiMachine`，其背后是 node-pty/xterm/sandbox-runtime/codex）；`PushNotificationClient` 首次发送时才 import `expo-server-sdk`（远程路径仍会用，只延迟不删除）。
   - ink/react 只在有 TTY 时 import；`claudeLocal`（sandbox-runtime）只在 local 模式 import；`claudeCliPath` 从不拖 sandbox 的位置取。
   - `runClaude` 在 `notifyDaemonSessionStarted` 之后才需要的一半（loop、MCP server、hook server、claude-agent-sdk）改为动态 import，并在 `getOrCreateSession` 期间并发预取。
3. **wrapper 启动路径**
   - `startedBy==='daemon'` 时跳过 `getOrCreateMachine`（Session 无机器外键、结果未被使用，daemon 已注册）与 `ensureDaemonRunning()`；终端启动保持原样。
   - `getEnvironmentInfo()` 移出 webhook 前路径。
   - 新会话在 `claimSessionOrExit` 之后立即创建 session socket（早于 daemon webhook POST）；重连/恢复路径保持原顺序。
4. **daemon spawn 路径**
   - agentHome：每次同步重读 settings（`claudeConfigDir` 立即生效），只有登录 shell 探测部分做 stale-while-revalidate；过期超 10 分钟仍同步等待；resume/restart 路径保持同步；后台刷新自带 `.catch`。
   - `TMUX_SESSION_NAME` 未设时不调 `isTmuxAvailable()`。
   - `[SPAWN TIMING]` 日志：request→probe→spawned→webhook 各阶段毫秒。
5. **web 直接落 `new-session` update**
   - `ApiUpdateNewSessionSchema` 补可选字段（dataEncryptionKey/metadata/agentState/seq 等，旧 server 不带则退回原 invalidate）；解密并 `encryption.initializeSessions` 后写入 store，尊重删除 tombstone；`invalidate()` 保留兜底。
   - `applySessions` 合并加版本守卫：已有条目 `metadataVersion`/`agentStateVersion` 更高时不回退（顺带修掉 refetch 回滚 metadata 的存量竞态）。
   - web 打点：点击 / RPC 发出 / RPC 返回 / 会话入 store / composer 挂载（`performance.mark`，dev 下打印）。

### B-513 发送确认态（仅 web）

1. **状态放 reducer**：`ReducerState` 增 `sendStates: Map<localId,'sending'|'failed'>` 与 `acked: Map<localId,{seq,realID}>`；`convertReducerMessageToMessage` 为用户文本与附件（file tool-call）输出 `sendState`。新 storage action `applyOutboxResult(sessionId,{acks,failures})` 在 `set()` 内更新 reducer 状态并只重转受影响 id。确认先于消息入 reducer 时，消息创建即为已确认。
2. **只回写 `seq`/`realID`**，不改 `id`、不改 `createdAt`（显示时间不变）；有 seq 后排序与 queued 释放按 seq（和刷新后一致），补测试。
3. **lastSeq 修正**：`flushOutbox` 只在 ack 的 seq 与 `sessionLastSeq` 连续时推进，否则 invalidate `messagesSync`（修掉 ack 越过在途 agent 消息导致丢消息的存量 bug）。回显到达 reducer 时（`reducer.ts:496/899` 与附件 tool-id 路径 `1003-1016`）同样清状态。
4. **乐观消息不再排在历史读取锁后面**：optimistic 批（无 seq）直接同步 apply，不进 `AsyncLock`；`fetchMessages` 的网络请求移到锁外、只锁 apply。
5. **失败判定**：
   - `apiSocket.request` 支持 `AbortSignal`，抛带 `status`/`code` 的类型化错误。
   - 每条在 outbox 的消息有 15 s 墙钟 deadline（到点 abort 在飞请求）；`navigator.onLine===false` 时暂停计时。
   - 不可重试：400、404、413、429+`message_count_quota_exceeded`、auth latch（401/403 停止时也必须把 sending 转 failed）。
   - outbox 按 ack 的 localId 集合移除，不再 `splice(0, batch.length)`。
   - 会话删除时清掉对应 send state。
6. **重试**：同 localId、同一用户回合内全部 localId（附件 + 文本）按原顺序重新入 outbox，**只走 HTTP**（避免 wrapper 重启后中继重复路由）。
7. **放回输入框**：仅文本（附件在发送后已释放）；只在确定未到达服务端（从未收到任何响应、且最后一次尝试明确失败）时允许，否则只给「重试」；经 `messageQuote.ts` 式事件总线交给已挂载的 composer，没有 composer 时不显示该按钮；移除本地消息但保留 localId 映射，迟到回显可复现。
8. **queued 交互**：sending/failed 的消息不参与 queued 释放 reconcile（仍在队列 dock）；dock 行同样显示发送中/失败。显示优先级 failed > sending > queued。
9. **UI**：sending = 变淡立即生效，转圈按 localId 计时 >150 ms 才出现；隐藏引用/编辑、保留复制；failed = `MessageActions` 内以「发送失败 · 重试 · 放回输入框」替换 `MessageTime`（danger token）。
10. **提速**：中继仅在已连接时用于首次投递、ack 超时 3 s → 1.5 s；附件 PUT 并发上限 3、保持顺序与部分失败语义。

### B-514 去掉正文悬停时间（仅 web）

实际机制是 `ChatList.tsx:323` 的 `MessageTimeTooltip`（读行 `title`，220 ms 气泡）。按 Owner 字面「消息正文」：
- 选择器去掉 `.msg`；`.msg` 行（用户/agent/思考/事件/team/peer）外层 `title` 全删，连带删除为阻断继承而设的 `title=""`（`SubagentDetail.tsx:76`、`TeamMessageCard.tsx:20`、`SessionPeerMessageCard.tsx:22`）。
- 保留：底部 `.msg-time`；工具行 `.tg-row/.tg-head/.tg-preview-row/.sa-brief`（没有可见时间，删了就再也看不到）。
- 同步 `messageHoverTime.test.ts`、`messageTimestamp.test.tsx`、`docs/design-language.md:335,337`。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web × 旧 server | ack 与回显格式未变，sendState 正常清除 |
| 新 web × 旧 daemon/CLI | spawn RPC 与 update 格式未变；只是没有 daemon 侧提速 |
| 旧 web × 新 daemon/CLI | 仅内部时序变化，RPC 返回形状不变 |

无协议字段、无 migration。顺序：web（B-513/514/512-5）与 CLI（B-512-1..4,6）独立发布，互不依赖。回滚：web `rollout=switch` 回上一槽；CLI 回上一个 npm 版本。

## 风险

1. **动态 import 让某条冷路径在运行时才崩**（铁律 2 同类）。缓解：只移动已知在 remote claude 路径不用的模块；CLI 全量单测 + `--version` + 隔离 `HAPPY_HOME_DIR` 跑 `daemon start`→web spawn→收发一条消息的冒烟。
2. **stale agentHome**：settings 每次同步读、仅登录 shell 探测部分 SWR、>10 分钟同步等、resume/restart 不走 SWR。剩余风险：10 分钟内在 shell rc 里改 `CLAUDE_CONFIG_DIR` 的第一次 spawn 用旧值，接受。
3. **daemon 启动时跳过 getOrCreateMachine**：Session 无机器外键（`schema.prisma:198-225`），结果未被使用；不做 fire-and-forget（未处理 rejection 会触发 archive 清理）。
4. **误判失败**：慢网下 15 s 内未确认被标 failed，而服务端其实已落库。缓解：此后回显到达仍会清除 failed（回显优先于本地判定）；重试走 localId 去重。
5. **sendState 与 inputState(queued) 叠加**：显示优先级 failed > sending > queued。
6. **中继超时缩短** 可能让远端机器多走一次 HTTP：localId 去重吸收，唯一代价是 CLI 侧可能收到一次回显（已有 `routedInboundLocalIds` 去重）。

## 验收标准

- [ ] dev-sg 上 `node dist/index.mjs --self-check` 通过；`[SPAWN TIMING]` spawned→webhook ≤0.8 s（现 ~2.6 s），同机负载下前后各 5 次。
- [ ] dev-sg daemon 日志 spawn RPC 收到→返回 ≤0.8 s（现 2.6–3.6 s），`[SPAWN TIMING]` 行可见。
- [ ] 浏览器实测：点新建到会话页 composer 可用 ≤1.5 s（Performance/时间戳记录）。
- [ ] 发送：发出瞬间气泡变淡；ack 后恢复正常且 `seq` 已回写；断开网络 15 s 后标失败，重试成功且服务端只有一条；放回输入框恢复文本。
- [ ] 回显早于 HTTP ack、HTTP ack 早于回显两种时序单测都清 sendState。
- [ ] 悬停正文/工具行无浏览器 tooltip，底部时间悬停仍显示完整时间。
- [ ] AGENTS.md 全部门禁绿；mutation-check 覆盖 sendState 清除与 agentHome SWR。

## 留真机验证项

- 移动端（coarse pointer）失败气泡按钮可点性、发送中观感。
