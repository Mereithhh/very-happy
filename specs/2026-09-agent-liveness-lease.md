# 活性租约与队列出边（B-320 / B-322）

状态：**已实现并合入 main**（#225、#228），CLI 侧两项延后（B-332 / B-333）。
起因：两位用户在「Coding Agent 接入交流群」实报，同一天。

> Simon DU：「好像有 bash command 在运行我的新发的就会 queue，但我再开一个新的 chrome tab 就好了」
> 另一位：「会话模式如果有 bash command 在运行我的新发的就会 queue，**有时候会一直卡住，点停止也无法停止**」

## 判据：三轮对抗 review 逐轮推翻的结论

**每一轮都推翻了上一轮的因果链，最终定稿与最初诊断没有一条重合。** 记在这里是为了让下一个
agent 不必重跑这三轮。被证否的假设：

| 假设 | 为什么错 |
|---|---|
| 幽灵 running tool 让消息**入队** | `SessionLiveStatusBar` 在 `agentLive === false` 时整条不渲染，所以截图里能看到 `Bash · 3294m` 就证明那一刻 `thinking === true`——入队是 by design |
| CLI 没有路径回头补写 `tool_result` | `claudeRemoteLauncher` 的 launch `finally` 里 `generateInterruptedToolResult` 一直在补（`86af26d4`，2026-01-27）。幽灵**只**来自 `finally` 跑不到的死法：SIGKILL/OOM/断电/睡死 |
| 幽灵要往上滚才会复发 | `prefetchOlderMessagesInBackground` 无人干预回填到 seq 1 |
| 旧 tab 跑的是旧 bundle | `installStaleBundleReload` 自 2026-08-12 就在；而且**前提本身是误读**——`3294m` 是 `runningTool.startedAt`，即服务端 transcript 里那条 tool_use 的时间戳，**不是 tab 年龄** |
| 给 `runningTool` 加 turn 作用域能修 | `sync.sendMessage` 发出前就乐观入库一条**无 seq 的 user-text**，`currentTurnMessages` 会立刻把正在跑的工具切进「上一轮」——而「用户开口」正是本 bug 的触发条件 |

**通用教训**：诊断活性类 bug 时，界面上的时长有三种互不相同的来源——transcript 里的
`startedAt`（服务端历史）、`thinkingStartedAt`（**本 tab 观测到边沿的时刻**）、以及真实 turn
年龄。把前两种当第三种，会得出「这个 tab 开了 55 小时」这类完全错误的前提（本次连踩两次）。

## 真因（两条独立的钉死）

### ① 活性是闩锁，不是租约

`preserveSessionActivityFromStore` 让 REST 快照**永远无法**把本地的 `thinking:true` 降回
false，只有 ephemeral activity 或 turn 生命周期事件能。于是 wrapper 被硬杀之后 presence 还是
online、thinking 还是 true，而服务端 presence 超时是 10min 阈值 + 60s 轮询：**最长约 11 分钟
UI 一直说在跑**——停止按钮悬在一个无事可停的会话上，输入被扣住。

而 keepAlive 本来就是标准的 lease/heartbeat：**五个 runner（claude/codex/gemini/openclaw/acp）
全部每 2000ms 发一次、`false` 也发**，自 2026-01 建仓起未变。缺的只是过期判定。

### ② `waiting-start` 是一个没有出边的状态

`deliveryPhaseRef` 唯一的出路要求观测到 `isWorking === true` 至少一次，即假定「刚放出去的
消息一定会让 agent 开工」。三条路径让它永远等不到：

1. `sync.sendMessage` 在缺 session / encryption key 时 `console.error` + **return 不抛**
   ——释放 effect 的 `.catch` 不触发，phase 永远卡住，**消息本身还静默丢了**；
2. 队首是 `/btw` ——`sendQueuedItem` 打开面板后 return，不发送不抛；
3. durable 写入成功但没有活 wrapper。

三者都表现为「`QUEUED N · this device` 常驻、点什么都不动、**换个 tab 就好**」——新 mount 让
ref 回 `idle`，持久化的队列立刻冲出去。**这就是用户那句「开个新 chrome tab 就好了」的机制**，
它不依赖冷启动竞态，是确定性的。

## 实现约束（`sync/heartbeatLease.ts`，每条都对应一个反例）

- **TTL 25s**，必须大于本端已知最坏正常重连间隔。四个数：keepAlive 走 `volatile.emit`
  断开即丢、CLI 主控制 socket 是 `reconnection: false` + 手写 3s 轮询、蓝绿 handover 上限
  10s、web 侧 activity 累加器 2s debounce。**3×2s 会在每次瞬断和每次发版上假过期。**
  改 TTL 前先把这四个数重新量一遍。
- **本端 socket 断开或标签页不可见时停表。** 冻结的标签页**收不到 `disconnect` 事件**，
  `socketStatus` 会一直停在 `'connected'`——只看它会在它唯一该管用的场景失灵。停表用
  「把计时起点推到当前」实现，恢复后自动获得完整一个 TTL，不需要第二个 grace 常量，
  也不需要再挂一个 visibility 监听（铁律 13）。
- **每会话一次性 timer，不用全局 ticker。** 心跳停止按定义不产生任何 store 变更、不触发
  re-render，而 web 上 `sessionsSync` **没有任何周期性轮询**（只在 init / resume / socket
  connect / new-session 触发），指望「下次 REST 把 thinking 冲掉」永远不会发生。全局
  `setInterval` 在后台被节流、回前台**成批补跑**，会把所有会话同时判死。
- **状态放模块级 Map，不进 store**（先例 `sessionArchiveHold.ts`）：`applySessions` 每次重建
  `sessionListViewData`，2s 一写正是 B-311 治的病。
- **刻意不写回 `session.thinking`。** 写回会命中 `storage.ts` 的未读转移（`thinking → false`
  且 presence 仍 online ⇒ 误标未读、落 MMKV 红点），而那条路径**今天在硬死场景下从不误报**
  ——写回等于引入一个新的误报。同理避开 `thinkingStartedAt` 归零重数。
- `thinking` 有**第二个写者**（`sync.ts` 的 task lifecycle 事件），它不带心跳；不在那里也盖戳
  的话，每个 turn 开头会闪一下不活。

## 兼容性

**版本无关**，对存量 wrapper 立即生效。keepAlive 的 2000ms 间隔在所有已发布版本里都一样，
所以线上任何 CLI 版本都喂得动租约。误判风险不在版本而在链路，由 TTL 与停表两条覆盖。

`ops.ts` 补 `throwIfRpcError` 同样安全：它只在 `error` 是**非空字符串**时抛，老 CLI 成功时返回
`undefined` ⇒ 不抛；而老 CLI 在 handler 抛错时本来就返回 `{ error }`，所以只是把一直存在的
错误显出来，不会凭空造错。

## 刻意没做的（连同否决理由）

- **给 `runningTool` 加 turn 作用域**：见上表，会在实报场景本身把状态条打瞎。已删除该方案。
- **在线会话不再本地扣留输入**（把排序交给 CLI 的 `MessageQueue2`）：方向对，但它把
  「我这条消息还在排队吗」建立在**推断出来的 turn-end 边界**上——一个缺席判据，外加一次
  **跨机墙钟比较**（`queuedAt` 是浏览器 `Date.now()`，`boundary.createdAt` 是服务端 DB 事务
  时间戳）。而且乐观消息**永远拿不到 seq**（回声到达时 reducer 两处都 `continue`），所以
  seq 分支对本设备消息不可达。另有六种 turn 终止不产生边界（`/clear`、`/compact`、首帧
  assistant 之前就死、会话接管、wrapper crash、Gemini 队列非空时抑制 `ready`），而取消按钮
  的门 `metadata.queueCancellation` **只有 Claude 广播** ⇒ Codex/Gemini/OpenClaw 用户的消息
  会永久停在「Queued」框里且无法删除。**在 B-327 落地之前不要做这一步。**

## 延后项

- **B-332**：CLI 在清空队列时发 `queue-cancel` tombstone（`pushIsolateAndClear` / `reset()` /
  `skipExistingMessages` 三处）。不改协议、不要能力位、旧 web 已经会渲染 `canceled`。
  这才是「消息被静默销毁却显示成已投递」的真正解——**发布集合做不到这件事**，因为
  「id 从集合里消失」对「被正常消费」和「被销毁」是同一个观测。
- **B-333**：CLI 在 2s 心跳上发布 `MessageQueue2` 的 `sourceId` 集合。**服务端会丢字段**
  （`sessionUpdateHandler` 的 `session-alive` handler 签名封闭，`buildSessionActivityEphemeral`
  重建一个全新 5 字段对象）⇒ 三包改动，铁律 5 钉死顺序 server+web → CLI。七件套缺一不做：
  ① server 转发；② 集合与租约戳共用同一个 `Session` 之外的 Record（进 `Session` 会被 REST
  快照覆盖成 undefined，每次刷新闪一下「已投递」）；③ 深度封顶（`session-alive` 目前无速率/
  体积计费）；④ **能力位按 runner**（`sourceId` 只有 claude 路径传，codex 的接口签名里压根没
  这个参数）；⑤「能力位说会发但连续 N 个心跳没带」自动降级；⑥ file 项归属规则（附件从不经过
  `MessageQueue2`，否则同一条消息文字「排队中」、图片「已投递」）；⑦ `inputState` 只能有一个
  写者，两套共存会让消息在 transcript 里闪现／消失。
  **必须写进实现：「不在集合里」只表示「不在排队」，不表示「已被处理」；销毁必须有自己的
  tombstone。** 否则下一个人会把它当投递回执用。

## 顺带记下的既存缺陷（未修）

- **AskUserQuestion 的选项答案今天就被误标排队**：`MessageView.tsx` 的 `onOption` 用
  `source: 'chat'`，而 `queuedAtForSend` 只豁免 `'question'` ⇒ 答案被标 queued 并从 transcript
  消失（`ChatList` 按 `inputState !== undefined` 过滤）直到 turn 结束。自愈快所以没人报。
- **跨 tab 重复发送**：持久化队列 mount 时读一次、变化时整表覆写，无 `storage` 事件、无
  BroadcastChannel。开第二个 tab ⇒ 两个 tab 各持同一条消息，turn 一结束各发一次——而
  「开新 tab」正是用户被建议的 workaround。
- **`state.turnEnds` 只 push 从不剪枝**，长会话 O(turns)×O(inputs) 每批开销。
- **服务端消息内容加密存储**（`SessionMessage.content` = `{t:'encrypted', c:…}`），
  所以这类问题**做不了服务端取证**，只能靠本地复现。
