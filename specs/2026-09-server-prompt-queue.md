# 服务端 prompt 队列（Server-side prompt queue）

> 状态：Final
> 日期：2026-09-27 ｜ 关联 backlog：B-509 ｜ 出处/前身：B-322（tab-local 队列无出口）、B-332（queue-cancel 墓碑）、`c04d26a41` 原生 Claude Queue/Steer（#82）

## 背景

Owner 在网页里排队一条 prompt 后关掉网页，下一条永远不会自动发出。原因是 prompt 队列
目前是**纯前端实现**：排队项只活在当前标签页的 React state + `localStorage`，由该标签页
观察到 `isWorking` 变 false 后逐条 `sync.sendMessage`。没有标签页在看，就没有人放行。

要求改为 server/wrapper 侧队列：排队的 prompt 立即持久化到服务端；当前 turn 结束后由
wrapper 按序取下一条执行；关掉所有前端也照常；wrapper 离线时队列保留，恢复后继续。

## 目标

1. 排队即落服务端（per-session 队列表），任何一端刷新/关闭都不丢。
2. 当前 turn 结束后 wrapper 自动取队头执行，**一 turn 一条**（保持今天 tab-local 队列的
   逐条语义，不是 `MessageQueue2` 的同 hash 合并批）。
3. Web 队列 UI 改为展示/编辑/删除/重排服务端队列，多端一致。
4. 同一条不重复执行（队列项 `localId` = 落库消息 `localId`，server 端 `@@unique`）。
5. 与 Steer / Stop / 权限回调分通道（关键约束 8）：队列只走「turn 结束后普通消息」；Steer 仍是
   `meta.delivery:'steer'` 直发；Stop 不动服务端队列。
6. Claude / Codex / pi(ACP) 三 runner 语义一致：都在「输入队列空且在等下一条」时取队头。

## 非目标

- 不改 `MessageQueue2` 的同 hash 合并批语义（wrapper 在飞时直接 `sendMessage` 的消息仍按现状合并）。
- 带附件的排队项不进服务端队列（仍走今天的 tab-local 内存队列，不持久化，和现状一致）。
- 不做跨 session 队列、不做定时发送（那是 Automations，B-496）。
- 不让 server 判 turn 边界（turn-end 是加密 envelope，server 只见密文；铁律 20 单写者——只有
  wrapper 知道自己是否空闲）。
- Claude 本地模式（终端接管，`controlledByUser`）下不取队列：终端在飞时无 turn 边界可判；切回
  remote 后照常。

## 现状事实（代码已确认，基线 `origin/main@20bffc178`）

| 事实 | 位置 |
|---|---|
| 队列状态是 `AgentInput` 组件内 `useState`，初值来自 `localStorage`（mmkv shim）key `queued-messages-v1`；无 zustand store、无跨标签页同步、无重排 | `packages/happy-web-v2/src/screens/session/AgentInput.tsx:130-147`、`sync/persistence.ts:154-167` |
| 放行条件：`gate==='send' && phase==='idle' && !isWorking && !editing`，每 turn 放一条；`isWorking` 由 presence+thinking+心跳租约算出 | `screens/session/queuedMessages.ts:54-61`、`AgentInput.tsx:532-554`、`sync/agentLiveness.ts:48-55` |
| 放行 = `sync.sendMessage(sessionId, text, {delivery:'queue', modeMeta})` → 加密 → `pendingOutbox` → relay / `POST /v3/sessions/:id/messages` | `AgentInput.tsx:382-393`、`sync/sync.ts:709-917`、`sync/sync.ts:2074-2098` |
| 关标签页无任何队列 flush；只有通用 `beforeunload` 提示 | `app/viewShortcuts.ts:196-224` |
| wire 已有 `meta.delivery: 'queue'\|'steer'`（omit/queue = 等 turn 结束，steer = 进当前 turn） | `packages/happy-wire/src/messageMeta.ts:12-13` |
| wrapper 收到用户消息：`delivery==='steer' && remote` 且有活 turn 且 mode hash 匹配才 `trySteer`（SDK 流 `priority:'now'` 注入），否则 `messageQueue.push` | `packages/happy-cli/src/claude/runClaude.ts:967-983`、`claude/claudeRemote.ts:257-269`、`claude/session.ts:180-183` |
| Claude 只在 SDK `result` 之后调 `opts.nextMessage()`；`MessageQueue2.collectBatch` 把同 hash 的全部排队项用 `\n` 合并成**一个** turn | `claude/claudeRemote.ts:386-461`、`utils/MessageQueue2.ts:306-355` |
| Codex / ACP 无 steer；循环 `waitForMessagesAndGetAsString` → 跑完一 turn → 再等；mid-turn 到达的消息同样合并进下一批 | `codex/runCodex.ts:870-1025`、`agent/acp/runAcp.ts:1153-1215` |
| 三个 runner 用同一个 `ApiSessionClient`（socket `update` 分发、`routeIncomingMessage`、`lastSeq`） | `api/apiSession.ts:153-300`、`:523-530` |
| 新进程 resume：cursor 种子 = server 快照 `seq`，离线期间落库的消息**被跳过**，带 `queuedAt` 且在最后一个 turn-end 之后的打 `queue-cancel(restarted)` 墓碑；ACP 每次新 session 无 resume | `claude/runClaude.ts:305-351`、`api/apiSession.ts:837-890`、`codex/runCodex.ts:222-240`、`agent/acp/runAcp.ts:498` |
| server 端消息内容是不透明密文 `{t:'encrypted',c}`；`storeSessionMessages` 在 `inTx` 内锁 Session 行、按 `(sessionId, localId)` 去重、只对新行计费与分配 seq | `packages/happy-server/sources/app/api/sessionMessageStore.ts:41-135`、`prisma/schema.prisma:226-239` |
| `inTx` = `db.$transaction(Serializable)` + P2034/40001 重试，不支持嵌套 | `sources/storage/inTx.ts:30-55` |
| 同 session 广播用 `recipientFilter {type:'all-interested-in-session'}` = session room（wrapper）+ user-scoped（web） | `sources/app/events/eventRouter.ts:320-335`、`routes/v3SessionRoutes.ts:176-190` |
| 老 web 对未知 `update.body.t` 只 `console.log` 后丢弃；老 wrapper 的 `update` 处理是 if/else，未知 t 直接忽略 | `happy-web-v2/src/sync/sync.ts:2508-2519`、`happy-cli/src/api/apiSession.ts:239-300` |
| server 不存 turn 状态：`session-alive.thinking` 只走 ephemeral | `sources/app/api/socket/sessionUpdateHandler.ts:113-171` |
| Web 按 `metadata.capabilities` 判 wrapper 能力（关键约束 14）；Claude 现发 `claude-steer-v1` 等，Codex/ACP 未发任何 capability | `claude/runClaude.ts:198`、`AgentInput.tsx:225-227` |
| B-507：background tasks 只影响 daemon 升级/自动归档闸门，不影响 `onTurnEnd`/`thinking`；turn 在 `result` 即结束 | `claude/claudeRemoteLauncher.ts:643-680`、`daemon/run.ts:1784,1858,1879` |
| 近期 migration 都是手写紧凑 SQL | `prisma/migrations/20260925120000_automations/migration.sql` |

## 设计

### 1. 存储：`SessionPromptQueueItem`（server，新增表 + 手写 migration）

```prisma
model SessionPromptQueueItem {
  id        String   @id @default(cuid())
  sessionId String
  session   Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  localId   String            // = 派发后落库消息的 localId（幂等锚点）
  position  Int               // 队内顺序；append = max+1，重排改写 1..n
  /// [SessionMessageContent]
  content   Json              // 与 SessionMessage.content 同形：{ t:'encrypted', c }，server 不解密
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([sessionId, localId])
  @@index([sessionId, position])
}
```

内容由 web 用 session 密钥加密，就是它本来要 `sendMessage` 的那条 `RawRecord`
（`role:'user'`，`meta` 带 `sentFrom`/`permissionMode`/`model`/`effort`；**不带** `queuedAt`、
不带 `delivery`）。派发时 server 把它原样变成一条 `SessionMessage`，所以 wrapper 收到的
和用户此刻手敲的完全一样。

上限：每 session 50 条（`prompt_queue_full` 409），单条 ≤ `SESSION_MESSAGE_CONTENT_MAX_BYTES`。

### 2. 路由（server，`routes/promptQueueRoutes.ts` + `app/promptQueue/store.ts`）

全部 `app.authenticate` + session 归属校验（404），路径前缀 `/v1/sessions/:sessionId/prompt-queue`：

| 方法 | 作用 | 返回 |
|---|---|---|
| `GET` | 列表（position ASC, createdAt ASC） | `{ items }` |
| `POST {localId, content}` | 追加；同 `localId` 已存在则返回已有项（幂等） | `{ item, items }` |
| `PATCH /:itemId {content}` | 改正文（web 重新加密）；已派发 → 404 `prompt_queue_item_gone` | `{ item, items }` |
| `DELETE /:itemId` | 删除；已不存在 → `removed:false`（幂等 200） | `{ removed, items }` |
| `PUT /order {ids}` | 按给定顺序改写 position；未列出的项保持相对顺序排在后面 | `{ items }` |
| `POST /dispatch` | **wrapper 用**：一个 `inTx` 内取队头（`FOR UPDATE`）→ `storeSessionMessagesInTx` 落库（localId = item.localId）→ 删除该项；`afterTx` 广播 `new-message` + `prompt-queue` | `{ dispatched: {itemId, localId, messageId, seq} \| null, remaining }` |

`storeSessionMessages` 拆成 `storeSessionMessagesInTx(tx, options)` + 外层 `inTx` 壳，外部
行为不变（现有 v3/socket 调用方零改动），dispatch 复用同一段落库逻辑（去重、计费、seq）。

每次变更（POST/PATCH/DELETE/PUT/dispatch）广播一条 `update`：

```ts
{ t: 'prompt-queue', sid, items: [{ id, localId, position, content, createdAt, updatedAt }] }
```

recipient `all-interested-in-session`（web 与 wrapper 都收）。快照式（队列 ≤ 50 条、密文小），
客户端不需要增量合并。

### 3. wrapper：`utils/promptQueueDrain.ts`（纯状态机）+ `ApiSessionClient` 挂载

```ts
class PromptQueueDrain {
  constructor(deps: { isIdle: () => boolean; dispatch: () => Promise<DispatchResult>; now?: () => number });
  onIdle(): void            // runner 在空队列上开始等下一条（MessageQueue2.setOnWait）
  onQueueChanged(n): void   // 收到 prompt-queue update；n>0 且 idle 时立刻派发
  onInbound(localId): void  // routeIncomingMessage 看到派发出的消息 → 清 inflight
  maybeDispatch(): Promise<void>
}
```

- 触发点三个：① runner 在空队列上等（`MessageQueue2.setOnWait`，Claude remote 的 `nextMessage`、
  Codex/ACP 主循环都经过它）；② `update.t==='prompt-queue'`；③ 启动后 socket 首次 `connect`
  （resume 后立即续跑）。
- 守卫：`isIdle()`（`messageQueue.size()===0 && messageQueue.isWaiting()`）、无 inflight、未被
  404 禁用。派发成功后记 `inflight={localId}`，直到 `onInbound(localId)`（消息经 socket/catch-up
  路由进 `MessageQueue2`）或 20 s 超时才允许下一次。消息进队列后 `size()>0`，自然不 idle；turn
  跑完 runner 再次空等 → ① 再触发 → 取下一条。**这就是「一 turn 一条」的来源**：队头进
  `MessageQueue2` 时队列必空，`collectBatch` 无可合并对象。
- **echo 先于 HTTP 响应**（首轮隔离实测抓到）：dispatch 事务提交后 `new-message` 经 socket 到达
  wrapper 常常早于 HTTP 响应，`onInbound` 先于 `dispatched` 结果——若此时才记 inflight，队列会卡到
  20 s 超时且无人再触发。所以 drain 记录「dispatch 进行中到达的 localId」，响应回来时已到达的不再记
  inflight；真记了 inflight 的也自带一个超时后的重检定时器（`schedule`），不依赖外部事件。
- `dispatch` 404 → 老 server，`disabled=true`，本进程不再尝试（新 CLI 对老 server 零副作用）。
- 其它 HTTP 错误：指数退避（1s→30s）后允许重试，不刷日志风暴。
- `routeIncomingMessage` 处调用 `onInbound(sourceLocalId)`。
- 三 runner 接线一致：`const drain = session.attachPromptQueueDrain({ isIdle })` +
  `messageQueue.setOnWait(() => drain.onIdle())`。Claude 本地模式没有 waiter → 不派发（非目标）。
- capability：Claude `capabilities` 追加 `'prompt-queue-v1'`；Codex / ACP 的 `createSessionMetadata`
  也写 `capabilities: ['prompt-queue-v1']`（它们此前没有该字段；web 侧 schema 已是 `string[]`）。

### 4. Web

- `sync/apiTypes.ts`：`ApiPromptQueueUpdateSchema` 加入 `ApiUpdateSchema` union。
- `sync/promptQueue.ts`（新，zustand 小 store，不碰 `storage.ts`）：
  `usePromptQueue(sessionId)` → `{ items: {id, localId, text, modeMeta, createdAt}[], status:'idle'|'loading'|'ready'|'unsupported' }`；
  `loadPromptQueue`、`enqueuePrompt(sessionId, text, modeMeta)`、`updatePromptText`、`removePrompt`、
  `movePrompt(sessionId, id, -1|+1)`、`applyPromptQueueUpdate(body)`（解密每项 `content` 取 text/meta）。
  服务端 404 → `unsupported`（老 server），本 session 回落 tab-local 路径。
- `sync/outboundUserRecord.ts`（新纯函数）：把 `sync.sendMessage` 里构造用户 `RawRecord` 的那段
  抽出来，`sendMessage` 与 `enqueuePrompt` 共用（保证派发后与手敲消息同形）。
- `sync/sync.ts`：`handleUpdate` 加一分支 `prompt-queue` → `applyPromptQueueUpdate`。
- `AgentInput.tsx`：
  - `serverQueue = supportsServerPromptQueue(session) && status !== 'unsupported'`
    （`metadata.capabilities` 含 `prompt-queue-v1`，关键约束 14）。
  - 提交：`serverQueue && !attachments && (isWorking || gate==='restore-first')` → `enqueuePrompt`
    （失败 toast + 保留草稿）；否则走原路径。`restore-first` 时照旧触发 `restoreSession`。
  - 队列区：`serverQueue` 时渲染 store 的 items（编辑 → PATCH、删除 → DELETE、上移/下移 → PUT
    order、「调整方向」→ 先 DELETE 成功再 `sendMessage(..., 'steer')`，DELETE 返回
    `removed:false` 说明已派发，放弃 steer 并提示）；旧路径 UI 原样保留给老 wrapper / 带附件项。
  - 放行 effect 只作用于 tab-local `queued`（老 wrapper / 附件项），`serverQueue` 下服务端队列由
    wrapper 派发，web 不放行。
  - 挂载时一次性迁移：`serverQueue` 且 `localStorage` 里有该 session 的旧项 → 逐条 `enqueuePrompt`
    后清本地。
  - 文案：「仅此设备」提示在 `serverQueue` 下改为「已保存到服务端，关掉网页也会依次发送」。

### 5. 语义边界

- **Queue / Steer / Stop 分通道**：服务端队列只产生「turn 结束后」的普通消息；Steer 仍是直发
  `delivery:'steer'`；Stop（abort）不清空服务端队列——runner 中断后空等 → 取下一条，和今天
  tab-local 队列在 `isWorking` 变 false 后放行的行为一致；用户想停住整个队列就删项。
- **B-507 后台任务**：turn 在 SDK `result` 即结束，后台任务不阻塞派发（与 Claude Code 原生队列
  一致；后台任务完成通知各自起 turn）。
- **权限/提问挂起**：runner 在等权限回调时 `MessageQueue2` 没有 waiter（turn 未结束）→ 不派发。
- **mode 变更需要 relaunch**：派发进 `MessageQueue2` 的项若 hash 不同会被 park + relaunch，
  与手敲消息相同。
- **重复执行**：`(sessionId, localId)` 唯一 + dispatch 单事务 + wrapper inflight 守卫。
- **wrapper 离线**：无人调 dispatch，队列原样保留；新进程 resume 后首个空等即续跑。派发前的项
  不受 B-332 `restarted` 墓碑影响（它们还不是消息）。

## 兼容矩阵与发布顺序

| web | server | wrapper | 行为 |
|---|---|---|---|
| 新 | 新 | 新（有 `prompt-queue-v1`） | 服务端队列 |
| 新 | 新 | 老（无 capability） | tab-local 队列（现状） |
| 新 | 老 | 任意 | `POST` 404 → `unsupported` → tab-local 队列 |
| 老 | 新 | 新 | 老 web 继续 tab-local；未知 `prompt-queue` update 被 zod 拒绝后丢弃（仅 console） |
| 任意 | 老 | 新 | dispatch 404 → drain 禁用，其余不变 |

发布顺序：server → web → CLI（默认顺序即可：capability 由新 wrapper 才发；server 先上使路由存在）。
回滚点：server/Web 回 blue 槽；CLI `advance-auto-update.sh <上一版>`。表在回滚后闲置无害。

migration 新增表：发布前在 vh-sg 设置 `VH_RELEASE_MIGRATIONS_REVIEWED=<目标 commit>`（纯 expand）。

## 风险

1. **inflight 消息因 socket 掉线迟到** → 20 s 后允许派发下一条，两条可能在 `MessageQueue2` 合并成
   一 turn。缓解：catch-up fetch 按 seq 有序；仅在断网窗口发生；接受。
2. **老 web 控制台噪音**（未知 update 类型每次打印）→ 只影响 console；web 先于 CLI 发布，窗口短。
3. **`storeSessionMessages` 拆分** 触及消息落库主路径 → 外层壳保持签名，`v3SessionRoutes.test.ts`
   与 `sessionMessageStore` 现有测试覆盖；PGlite 集成测试覆盖 dispatch。
4. **本地模式不派发** → 文档化非目标；web 对 `controlledByUser` 已单独处理。
5. **Stop 后自动续队** → 与现状一致；spec 明示。
6. **resume 起步的同时派发**：新 wrapper 首次空等即取队头，若 `--resume` 附带的 prompt 同一瞬间到达且 mode hash 相同，两者按既有
   `collectBatch` 语义合并成一 turn（隔离实测：hash 不同时各起一 turn）。与两条直发消息同时到达的行为一致；接受。

## 验收标准

- [ ] server：GET/POST/PATCH/DELETE/PUT order/dispatch 路由测试（归属 404、幂等 localId、上限 409、
      已派发项 404/removed:false）；PGlite 集成：dispatch 原子（消息落库 + 项删除 + 两条广播，
      重复 dispatch 不重复落库）。
- [ ] CLI：`promptQueueDrain.test.ts` 机制级（idle 才派发、inflight 守卫、超时释放、404 禁用、
      queue-changed 触发）；`MessageQueue2` `setOnWait/isWaiting` 测试；三 runner 接线源码断言 +
      mutation-check。
- [ ] Web：`promptQueue` store 测试（解密/排序/unsupported 回落）；`AgentInput` 提交分支测试
      （serverQueue 走 enqueue、附件走本地、老 wrapper 走本地）；mutation-check。
- [ ] 全量门禁绿；隔离环境真 claude：排 3 条 → 关闭全部 web → 三条依次各起一 turn 执行完，
      transcript 顺序正确、无重复；期间 wrapper 重启一次队列续跑。
- [ ] 发布：server/Web switch、CLI tag、dev-sg systemd 升级、Mac vh-update。

## 留真机验证项

- 手机 Safari 关闭标签页后队列继续（自动化只能验桌面 Chromium 关闭）。
