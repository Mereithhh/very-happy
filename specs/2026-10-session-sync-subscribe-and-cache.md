# 会话消息同步 v1：快照对账订阅 + 本机持久化（PR-5 / PR-6）

> 状态：已批准（Owner 2026-10-25，6 项取舍按推荐，见 §16），实施中：5a #754、6a #756 已合入、5b B-812、6b B-814；修订见 §15（当前 r3）
> 日期：2026-10-25 ｜ 关联 backlog：B-807（本 spec）；前置 B-803/B-804/B-805（止血 PR-1～3）；相关 B-802、B-799、B-801、B-806、B-711、B-494、B-513、B-516、B-722
> 出处：B-802 调研报告（下称 REPORT）§4.2 与设计评审（下称 DESIGN-REVIEW）§5～6；两份记录在会话临时目录，不进 repo
> 基线：`origin/main@bc28d577`（含 #740 B-799、#741 B-801）。B-802 报告里的行号基于 `e273b309`，本文新增的行号基于 `bc28d577`。
> 路径缩写：`W`=`packages/happy-web-v2/src`，`S`=`packages/happy-server/sources`，`C`=`packages/happy-cli/src`，`WR`=`packages/happy-wire/src`。时间一律 SGT。

---

## 0. 一页结论

1. **前提**：PR-1～3 已上线。也就是说：REST 有 10s 超时和代次取消；会话锁不跨网络；lastSeq 只增不减；回前台、重连时会显示「同步中」；prompt queue 会重拉；「每条消息一次 GET」已去掉。止血之后，症状 A/B 的**最坏时延**从「不受控」降到「超时 + 重试」约 10–12s。本 spec 要解决的是剩下的四件事：
   - 回前台的补拉仍走 HTTP 连接池，可能落在死连接上，要等 10s 超时；
   - 「已经是最新」只是假设，没有证据；
   - 补拉入口分散在 6 处，新功能容易漏掉；
   - 冷启动和刷新全靠网络，刷新后未发出的消息会丢。
2. **PR-5 订阅协议，推荐 v1「对账式订阅」**：新增 socket RPC `sync-hello`（批量）和 `session-subscribe`（单会话）。服务端在**一条 SQL 语句的同一快照**里读出 head 和 `seq>afterSeq` 的增量，作为 ack 返回。实时推送**沿用现有 `update/new-message`**，不新增推送事件。
   - **原子性**：Web socket 从连接建立起就在 `user:<uid>:user-scoped` 房间里（`S/app/events/eventRouter.ts:277-278`），所有 new-message 都是事务提交之后才 emit（`S/app/api/routes/v3SessionRoutes.ts:161-196`、`S/app/promptQueue/store.ts:211-212` `afterTx`）。所以「快照语句开始之后才提交的消息，一定会推到这个 socket」。在快照开始前已提交的消息，一定在快照里。两者之间没有缝隙，最多重复一条，由 seq 去重。
   - **为什么不一步做到 DESIGN-REVIEW 原方案的专属订阅房间（`session-messages` + `session-head`）**：Web 侧栏的 thinking 状态依赖每条 new-message 的明文生命周期事件（`W/sync/sync.ts:2909-2990`）。服务端不解密内容，单靠 head 通知做不了这个。专属房间还会让每条消息多一次 Redis XADD，把 B-494 的 recovery 时间窗压缩一半。这两个事件的 wire 在 §2.4 定义并预留，作为 v2，触发条件写在 §7。
3. **PR-6 IndexedDB**：按账号分库，存每会话最近 300 条**密文**和连续段游标，另存持久 outbox；不缓存会话 DEK（r2，§5.4）。冷启动先用缓存渲染，再用 `sync-hello` 对账。LRU 上限为 30 个会话、40MB。缓存任何不一致都按会话清除并回到首屏路径，缓存只影响速度，不影响正确性。
4. **Web 单一合并入口** `mergeSessionMessages(sid, batch, source)`，加每会话状态机 `cold → loading → live ⇄ syncing → stale`。所有来源（缓存、ack、推送、发送 ack、relay committed、翻页、REST 兜底）都只走这一个入口。
5. **工作量**：约 9–13 个 agent 工作日，可两条线并行，日历时间约 1.5–2 周（依据见 §11）。分 6 个 PR，每个都可以单独回滚。除可选的 PR-7 外，**全程不发 CLI**。

---

## 1. 背景、目标、非目标

### 1.1 背景（止血上线后仍存在的问题）

| # | 问题 | 证据 |
|---|---|---|
| R1 | 回前台的补拉走 `fetch`，浏览器会复用连接池里的半死 TCP。PR-1 之后最坏要等 10s 超时再重试 | B6：回前台的 GET 落在死连接，REPORT §2；PR-1 的默认超时为 10s |
| R2 | 「live」只是推断：没有 ack，就无法区分「已最新」和「推送丢了」。只有等下一条消息到达时发现 gap，才会补 | 通知不落库、不可重放：`eventRouter.ts:394-408`（B-802 基线）；commit 与 emit 是两步（`v3SessionRoutes.ts:161-196`），进程在两步之间崩溃时那条推送就永久丢失 |
| R3 | 补拉入口有 6 个：resume、reconnect、recovered、gap、进入会话，再加 PR-3 之后保留的心跳。prompt queue 就是漏掉其中一个入口的例子 | DESIGN-REVIEW §2.5；`W/sync/sync.ts:374,411,2816-2858,3014` |
| R4 | 冷启动和刷新都要从网络拉首屏，约 110–330KB，加 3 次往返 | DESIGN-REVIEW §2.3-3/5 |
| R5 | outbox 只在内存（`W/sync/sync.ts:215-216`），刷新、iOS 回收页面或崩溃后，pending 消息丢失 | DESIGN-REVIEW §2.4 |
| R6 | 内存里的 `sessionMessages` 不驱逐（DESIGN-REVIEW §1.5），开过的长会话一直常驻 | `W/sync/storage.ts`（B-802 基线 :786-793） |

### 1.2 目标（可验证）

- G1：回前台、重连、蓝绿切换后，当前会话在**网络可用时 ≤ 1.5s**（P95，本地 e2e 可控代理 RTT=150ms）追平；链路死掉时 ≤ 6s（5s ack 超时 + 重连）。比 PR-1 的「10s + 重试」更短。
- G2：进入 `live` 必须有服务端 head 作证，不再是推断：ack `ok` 且 `hasMore=false`，并且 `headSeq ≥ 本次请求的 afterSeq`。此时 Web 把 lastSeq 直接推进到 `headSeq`（`lastSeq := max(lastSeq, headSeq)`），承认 `(max(messages.seq), headSeq]` 之间可能有永远不存在的 seq（历史空洞，§4.2.1）。**不要求** `max(messages.seq) == headSeq`。
- G2a：存在 seq 空洞的老会话也必须能进入 `live`，每次触发只发 1 次 subscribe，不循环重试（§9 有测试）。
- G3：补拉只剩一个调度入口 `SessionSyncScheduler`，所有触发源都只把事件交给它。
- G4：冷启动或刷新时，有缓存的会话在 **≤ 300ms**（从 app 可交互算起，中端 Android）渲染缓存，再对账。
- G5：刷新或页面被回收后，未确认的发送仍然可见，并按 §5.5 的规则补发，不重复（localId 幂等）。
- G6：旧 CLI、旧 Web、蓝绿切换窗口、回滚，在任意组合下都不丢消息（§6 矩阵逐行有测试）。

### 1.3 非目标

- 不改 `update/new-message`、REST `/v3/.../messages` 的语义和字段。旧端的行为完全不变。
- 不改 CLI，不发 CLI。CLI 改用订阅、outbox 落盘是可选的 PR-7，不在本 spec 验收范围内。CLI 游标问题由 B-806（PR-4）单独处理。
- 不做账号级游标或 updates 表（理由见 DESIGN-REVIEW §5.4）。
- 不做 transcript 虚拟化（B-733 线）。不缓存 prompt queue（快照沿用 PR-2）。不缓存流式草稿帧 `session-stream`。
- 不迁移 B-801 的待建会话存储（`W/sync/persistence.ts:172-185` localStorage）。PR-6 只按 localId 和它对齐（§5.5.4）。
- 不做端到端加密改造：缓存的是服务端下发的同一份密文。

---

## 2. 现状事实（代码已确认，`bc28d577`）

| 事实 | 位置 |
|---|---|
| 消息写入：同一事务里，先锁 Account，再 `SELECT … FOR UPDATE` 锁 Session 行，再分配 seq、插入行。localId 已存在的行原样返回，不再插入 | `S/app/api/sessionMessageStore.ts:61-148` |
| 写入后的 emit 都在提交之后：v3 POST 在 `storeSessionMessages` 返回后循环 emit；prompt-queue 出队用 `afterTx`；share driver 写入同样在提交后 emit | `S/app/api/routes/v3SessionRoutes.ts:161-196`；`S/app/promptQueue/store.ts:211-212`（`afterTx`）；`S/app/session/sessionShares.ts:395-411` |
| new-message 一共 4 个 emit 点：v3 POST、socket `message`、prompt-queue 出队、share driver | `git grep buildNewMessageUpdate`：`v3SessionRoutes.ts:185`、`socket/sessionUpdateHandler.ts:223`、`promptQueue/store.ts:211`、`session/sessionShares.ts:410` |
| Web 是 user-scoped 连接，连接时加入 `user:<uid>:user-scoped`；`all-interested-in-session` 发往会话房间 ∪ user-scoped 房间 | `S/app/events/eventRouter.ts:277-281,383-387`；`S/app/api/socket.ts:320-390` |
| grantee 的 new-message 由 fan-out 转发到 `user:<grantee>:user-scoped` | `sessionShares.ts:453,468` |
| 读权限：owner 或 active grant，REST GET 用 `resolveSessionAccess` | `v3SessionRoutes.ts:88`；`sessionShares.ts:75` |
| 多进程：设置 REDIS_URL 时挂 Redis streams adapter，publish、poll、restore 三条连接分开；stream `vh:socket.io`，MAXLEN≈2 万 | `S/app/api/socket.ts:122-150`；`socket/boundedStreamsAdapter.ts:1-40` |
| `connectionStateRecovery` 30s 已开启（会恢复房间成员并重放），B-494 对扫描量设了上限，超限返回 `recovered=false` | `socket.ts:80-100`；`boundedStreamsAdapter.ts` |
| 蓝绿：`POST /_vh/release/drain` 让旧槽 `io.local.emit('server-draining')`；新连接到达时也补发一次；`/disconnect` 强制断开本槽所有 socket | `S/app/release/releaseCoordinator.ts:110-178` |
| Web 交接：先连 candidate，连上后切 `this.socket`，跑所有 reconnectedListeners，再断旧 socket | `W/sync/apiSocket.ts:898-903,934-967` |
| 生产拓扑：vh-sg 单机上固定 blue:3101 / green:3102 两个槽，共用 RDS（经 pgbouncer）和 ElastiCache Redis；Caddy 原子切换 | `docs/operations.md:16-21,65-67,155-175` |
| B-711：停旧槽后仍有约 2s 的探测超时，原因是重连风暴压住新槽（todo） | `docs/backlog.md:65` |
| Web 收到 new-message 后，用明文判断 turn-start/turn-end，并写 thinking 和 heartbeat，**对未打开的会话同样生效** | `W/sync/sync.ts:2909-2990` |
| Web 发送 ack 时只沿连续段推进 lastSeq（B-513） | `W/sync/outbox.ts:150` `advanceLastSeq` |
| outbox 只在内存：`pendingOutbox`、`outboxRecords` | `W/sync/sync.ts:215-216` |
| 多标签页存活检测：Web Locks 优先，BroadcastChannel 兜底；B-516 用它判定 pending session 的归属 | `W/sync/tabLiveness.ts:1-40`；`W/sync/pendingSessionsRuntime.ts:14,62` |
| `idb-keyval` 已在依赖里，但 src 没有任何引用；也没有任何 IndexedDB 用法 | `packages/happy-web-v2/package.json:36`；`git grep -i indexedDB` 为空 |
| 会话 DEK 来自会话列表，客户端用 AES256 解密 | `W/sync/encryption/encryption.ts:59-107` |
| 登录凭据明文存在 localStorage | `W/auth/tokenStorage.ts:15-44` |

---

## 3. Wire 定义（`WR/syncProtocol.ts`，新文件）

### 3.1 约定

- 新事件只挂在 **user-scoped socket**（Web）。session-scoped（CLI）和 machine-scoped 连接即使发了也不处理，返回 `{ok:false, error:'unsupported_client'}`。
- 所有 schema 遵守 AGENTS 铁律 4、14：新字段一律 `.optional()`，读取端忽略未知字段；枚举类字段用 `z.string()` 加读取白名单，不用 `z.enum`，否则一个未知值会让整条消息被丢弃。
- 协议版本：`v: 1`。服务端 ack 回 `v`（取服务端支持的最大版本与客户端版本中较小的那个）。客户端看到 `v` 缺失或 `v<1`，视为不支持。
- 消息体 `SyncMessage` 与 REST `toResponseMessage` **完全相同**（`v3SessionRoutes.ts:52-61`）：`{ id, seq, content, localId, createdAt, updatedAt }`。合并入口不需要区分来源格式。

### 3.2 `sync-hello`（C→S，带 ack）

连接或重连成功后、回前台、交接 candidate 连上时各发一次，**一次带上所有订阅**。

```ts
// request
{ v: 1,
  subs: Array<{ sid: string;
                afterSeq: number | null;   // null = 冷：要最新页（等价 before_seq=MAX）
                limit?: number }>;         // 默认 200，上限 500
  reason?: string }                         // 'connect'|'resume'|'handover'|'retry'，仅诊断
// subs ≤ 16，超出部分返回 too_many_subscriptions
// schema 硬上限 subs.max(64)：超过 64 个时 schema 不通过，整体回 invalid_request（不逐条返回）

// ack（成功）
{ ok: true, v: 1, serverTime: number,
  limits: { maxSubs: 16, maxLimit: 500, gapThreshold: 500 },
  results: SubResult[] }                    // 与 subs 一一对应，顺序相同

// ack（整体失败）
{ ok: false, error: HelloError, retryAfterMs?: number }
```

### 3.3 `session-subscribe` / `session-unsubscribe`（C→S，带 ack）

进入会话、请求增量、gap 补齐时使用。语义等价于只含一个 sub 的 hello。

```ts
// subscribe request
{ v: 1, sid: string, afterSeq: number | null, limit?: number }
// ack → SubResult

// unsubscribe request
{ v: 1, sid: string }
// ack → { ok: true }
```

```ts
type SubResult =
  | { sid: string; ok: true;
      headSeq: number;            // 同一快照中 Session.seq 的原值，server 不修补；可能 > max(messages.seq)（§4.2.1）
      messages: SyncMessage[];    // seq 升序；afterSeq=null 或 gapTooLarge 时为最新页
      hasMore: boolean;           // 前向还有更多，继续用 afterSeq=最后一条的 seq；messages 为空（体积预算耗尽，§4.4）时沿用本次请求的 afterSeq；false 表示 (afterSeq, headSeq] 内存在的消息已全部给出
      gapTooLarge?: true;         // headSeq-afterSeq > gapThreshold：messages 是最新页，不是增量
      oldestSeq?: number }        // messages 为最新页时，页内最小 seq
  | { sid: string; ok: false; error: SubError; retryAfterMs?: number };
```

### 3.4 错误码

| 码 | 级别 | 含义 | 客户端动作 |
|---|---|---|---|
| `disabled` | hello | 服务端开关已关（§6.1） | 本连接期间进入 legacy 模式，下一次 connect 再试 |
| `unsupported_client` | hello/sub | 非 user-scoped 连接 | 视同 disabled |
| `invalid_request` | hello/sub | schema 不符 | 记日志，进入 legacy 模式（属于实现 bug，不重试） |
| `rate_limited` | hello/sub | 超过 per-socket 限额（§4.4） | 按 `retryAfterMs` 加 0–30% 抖动后重试，期间保持 `syncing` |
| `unavailable` | hello/sub | DB 超时或出错，或并发闸门排队超过 3s | 1s→2s→4s 退避重试；连续 3 次失败转 `stale`，同时用 REST 兜底一次 |
| `not_found` | sub | 会话不存在、已删除、无权限，或 grant 已撤销 | 停止订阅，交给现有的会话删除或无权限处理路径 |
| `too_many_subscriptions` | sub | 超过 16 个 | 退订最久未看的会话后重试 |
| （未知码） | hello/sub | 读取白名单之外的任何 `error` 值（新 server 加的码、拼写错误） | `readSyncError` 一律折算为 `unavailable`，按上面 `unavailable` 一行处理：退避重试，连续 3 次转 `stale` 并用 REST 兜底一次。5b 不另定规则 |

**ack 超时**：hello 和 subscribe 的 ack 等待 **5s**，与 `socketLiveness` 的 ping 超时一致（`W/sync/socketLiveness.ts:22`）。超时视为链路可疑：调用 `apiSocket.checkLiveness()`（铁律 13 的唯一入口），该会话转 `stale`。第一次连接时如果 hello **2s** 内没有 ack，**本连接**改用 legacy 模式。这是为了旧 server 或切换窗口：ack 晚到会被忽略，下一次 connect 再协商。

### 3.5 预留：v2 事件（本 spec 不实现，只定义以免将来冲突）

```ts
S→C  session-messages     { v:2, sid, headSeq, messages: SyncMessage[] }   // 只发给订阅房间
S→C  session-head         { v:2, sid, headSeq, updatedAt }                // 给未订阅会话的轻量通知
S→C  session-unsubscribed { v:2, sid, reason: 'revoked'|'deleted' }
```

v2 的启用条件和代价见 §7。v1 客户端遇到这些事件会忽略：`socket.onAny` 找不到 handler 就直接丢弃（`W/sync/apiSocket.ts:905-916`）。

---

## 4. Server 实现

### 4.1 订阅表（v1）

- 每个 socket 一份：`socket.data.syncSubs: Map<sid, { since: number, afterSeqAtAck: number }>`，**只在本槽进程内存里**，不跨槽，不落库，不写 Redis。
- 用途：限额（≤16）、指标、日志，以及将来 v2 加入房间时的依据。v1 的推送**不依赖**这张表（推送沿用 user-scoped 房间）。所以订阅表丢失（重连、换槽）不影响正确性，客户端每次 connect 都会用 hello 重建。
- 断开时自动随 `socket.data` 释放。没有清理任务，也不会泄漏。

### 4.2 快照原子性：先「在房间里」，再读 head

**不变量**：一个 user-scoped socket 在收到 hello 或 subscribe 之前，就已经在 `user:<uid>:user-scoped` 房间里（连接 handler 同步 join，`eventRouter.ts:277-278`）。grantee 的 socket 在自己的 user-scoped 房间里，fan-out 也发往这里（`sessionShares.ts:453`）。

**读法**：一条语句，同一个快照（READ COMMITTED 下单条语句只用一个快照），不开事务，对 pgbouncer transaction pooling 友好：

```sql
-- 增量（afterSeq 非空）
WITH h AS (SELECT "seq" AS head FROM "Session" WHERE "id" = $1)
SELECT h.head, m."id", m."seq", m."content", m."localId", m."createdAt", m."updatedAt"
FROM h LEFT JOIN LATERAL (
  SELECT * FROM "SessionMessage"
  WHERE "sessionId" = $1 AND "seq" > $2
  ORDER BY "seq" ASC LIMIT $3          -- $3 = limit+1，多取的一行用来判断 hasMore
) m ON true;
-- 冷/最新页：内层改 ORDER BY seq DESC LIMIT $3，结果在应用层反转
```

**证明**（每会话的情况）：

- 消息 M 的提交时刻 tc，快照开始时刻 ts。M 的 emit 时刻 te 一定晚于 tc（emit 在提交之后）。
- 如果 tc < ts：M 一定在快照里。seq 和插入在同一事务里，`Session.seq` 和 M 同时对快照可见。
- 如果 tc ≥ ts：te > tc ≥ ts，而这时 socket 已经在房间里，所以 M 一定会被推送到该 socket（除非 socket 断开，那会触发重连和 hello，或者 emit 丢失，见下）。
- 两种情况同时成立时（tc < ts ≤ te）是重复，客户端按 seq 和 id 去重。
- `head` 与 `messages` 来自同一快照，所以 `hasMore=false ⇒` 快照中所有满足 `afterSeq < seq ≤ head` 的消息都在 `messages` 里，且 `max(messages.seq) ≤ head`。**不保证** `max(messages.seq) == head`：老会话可能有 seq 空洞（§4.2.1），空洞对应的 seq 永远不会出现，所以客户端在 `hasMore=false` 时把 lastSeq 推进到 `head` 是安全的。
- 客户端只认两种不一致：
  - `head < 本次请求的 afterSeq`：本地超前于服务端（DB 恢复到更早时间点、会话重建），按 §6.2 第 10 行处理：作废该会话缓存，`afterSeq=null` 冷重拉。冷请求没有 afterSeq，不会再次触发这一条，所以不会循环。
  - 某条 `messages[i].seq > head` 或 `≤ afterSeq`：同一快照下不可能出现，属于 server bug，按 `unavailable` 处理（走 §3.4 的退避，连续 3 次转 `stale`）。
- 比较对象是**本次请求发出时的 afterSeq**，不是 ack 到达时的 lastSeq：ack 到达前，快照之后提交的消息可能已经由推送或 send-ack 把 lastSeq 推过了 `head`（推送和 ack 走同一 socket，但 emit 与 ack 回包谁先到不保证）。拿当前 lastSeq 比较会把这种正常竞态误判成不一致。

### 4.2.1 seq 空洞（历史数据，server 不修补）

- **来源**：上游 `86af26d4` 时代，`S/app/api/socket/sessionUpdateHandler.ts:210-221` 在事务外先 `allocateSessionSeq(sid)`（`Session.seq` 已 +1），再查 localId 去重、再单独 insert。localId 已存在（直接返回旧行）或 insert 失败时，已分配的 seq 不会回收，于是留下永久空洞：可能在中间（之后又有消息写入），也可能在尾部（`Session.seq > max(SessionMessage.seq)`）。
- **现状**：当前写入路径在同一事务里分配 seq 和插入（`S/app/api/sessionMessageStore.ts:61-148`，`allocateSessionSeqBatch(…, tx)`），回滚时 seq 一起回滚，`git grep allocateSessionSeq` 没有其他调用点。**新的空洞不会再产生**，但老会话里的空洞永久存在。
- **决定**：server 原样返回 `Session.seq`，不做回填、不改 head 定义、不写迁移。Web 以「服务端给出的范围」为准推进 lastSeq（§5.1 规则 3），不以「行是否连续」为准。
- **影响面**（实现者逐条核对）：
  - 尾部空洞：`hasMore=false` 时 lastSeq 推进到 head（§5.1 规则 5）。
  - 中间空洞：snapshot、rest、latest-page、older-page 都是服务端的范围结果，范围内缺的 seq 视为不存在，lastSeq、oldestSeq 跨过它（§5.1 规则 3）；IDB 连续段校验不能用「行数 == lastSeq-oldestSeq+1」（§5.4.2）。
  - push 或 send-ack 越过空洞时会触发一次重排缓冲加一次 subscribe，ack 空且 `hasMore=false`，lastSeq 推进后结束，不循环。这只在 lastSeq 落在空洞之前时发生，而 lastSeq 每次对账后都已推进到 head，所以实际很少出现。

**仍然可能丢的情况：emit 丢失**（进程在 commit 之后、emit 之前崩溃；adapter publish 失败）。v1 的兜底：

- 下一条消息到达时会形成 gap，进入补齐路径；
- 每次回前台、每次 connect 都会 hello，回执里的 head 会暴露缺口；
- 当前会话处于 `live` 且页面可见时，每 **120s** 做一次轻量 `session-subscribe`（通常回执为空，约 150B）。

这样「推送丢了却一直以为是最新」的最长时间是 120s。如果 Owner 想要更短，见 §16 取舍 5。

### 4.3 gapTooLarge

- 判定：`afterSeq != null && head - afterSeq > gapThreshold`，阈值 `SYNC_GAP_THRESHOLD`，默认 **500**，等于 REST `limit` 的上限（`v3SessionRoutes.ts:30`）。依据：生产每会话消息数 P50 228、P95 2147（DESIGN-REVIEW §2.3-3），500 条大约是正常使用中离开数小时的量。
- 行为：返回最新页（`limit` 默认 200），带 `gapTooLarge:true` 和 `oldestSeq`，不返回增量。客户端丢弃这个会话的旧窗口和缓存，以最新页作为新窗口，更早的历史靠向上翻页（现有 `before_seq` 路径，`W/sync/sync.ts` 的 loadOlder）。
- 不做「把 500+ 条全部补齐」，原因有三：解密 + 渲染 500 条在手机上会卡 1–3s；用户回来先看的是最新；中间的内容翻页就能看到。

### 4.4 限额与风暴保护（针对 B-711、B-494）

| 项 | 默认 | 理由 |
|---|---|---|
| `SYNC_HELLO_MAX_CONCURRENCY`（每槽） | 32 | 每槽并发执行的快照查询数。切流时 300–400 个连接同时 hello，排队不打穿 pgbouncer 连接池 |
| 排队超时 | 3s | 超过就回 `unavailable`，`retryAfterMs` = 500–1500ms 随机，把风暴摊开 |
| 快照 deadline（`snapshotTimeoutMs`） | 1.5s | 从拿到闸门槽位开始，覆盖一次 hello/subscribe 的全部快照语句。超时回 `unavailable`；槽位要等 DB 语句真正结束才释放，否则 DB 变慢时闸门会放进无上限的并发查询 |
| per-socket 速率 | 20 次 / 10s（hello 和 subscribe 合计） | 正常使用远低于这个值；防止客户端 bug 造成循环 |
| ack 体积上限 | 512KB（单个 hello 合计） | `maxHttpBufferSize` 是 1MiB（`socket.ts:84`）。超出时剩下的 sub 返回 `hasMore:true` 加已截断的 messages，客户端继续用 subscribe 拉。预算被前面的 sub 用完时，后面的 sub 可能是**空页且 `hasMore:true`**（最新页还不带 `oldestSeq`）；客户端继续拉时沿用本次请求里的 afterSeq（冷请求仍是 `null`），不要从空页推导 afterSeq |
| 每 sub `limit` | 默认 200，上限 500 | 与 REST 一致 |
| `subs` 数组长度 | schema 硬上限 64 | 超过回整体 `invalid_request`；17–64 个时按 §3.2 逐条回 `too_many_subscriptions`。防止超大请求在 schema 解析阶段就占用资源 |

hello 的 DB 代价：先用一条 `SELECT id, seq FROM "Session" WHERE id = ANY($1)` 批量拿到所有 head（≤16 个 id，走主键），**只对 `head > afterSeq` 的 sub** 再跑 §4.2 的增量语句。切流时绝大多数客户端没有增量，每个 hello 约等于 1 次主键查询。

### 4.5 鉴权与撤销

- 每次 subscribe 或 hello 的每个 sub 都调 `resolveSessionAccess(userId, sid)`（与 REST GET 同源，`sessionShares.ts:75`）。无权限返回 `not_found`，不区分「不存在」和「无权限」。
- 撤销 grant：v1 推送沿用 fan-out，撤销后 fan-out 自然停止（`activeGranteeIds` 缓存过期之后）。订阅表里残留的条目只影响计数。v2 需要额外的 `socketsLeave` 处理，见 §7。

### 4.6 多实例与蓝绿（B-711）

- **两个槽同时在线时**（shadow、drain 窗口）：两个槽共用 RDS 和 Redis stream。任一槽提交的消息，都由该槽 emit 到 Redis stream，再广播到另一槽上的 user-scoped 房间成员（`socket.ts:122-150`）。所以 hello 落在哪个槽都不影响 §4.2 的证明：快照读的是同一个 DB，推送走同一个 adapter。
- **旧槽是旧 release（没有 hello handler）**：落在旧槽上的新 Web 会因为 hello 2s 没有 ack 进入 legacy 模式（§6 第 4 行）。交接到新槽之后，下一次 connect 重新协商，回到订阅模式。
- **make-before-break 交接**：candidate 连上后，现有代码先跑 reconnectedListeners，再断开旧 socket（`apiSocket.ts:953-957`）。v1 把 hello 注册为 reconnectedListener 之一，所以「hello ack 完成后才断旧 socket」。交接期间两条 socket 都可能收到同一条 update。旧 socket 的 handler 会因为 `this.socket !== socket` 直接返回（`apiSocket.ts:899-900,906`），重复的部分由合并入口去重。
- **强制断开（`/disconnect`）和停旧槽之后**：客户端走普通重连，`connect → hello`。hello 在新槽受 §4.4 的并发闸门约束，切流风暴最多表现为「同步中」多显示 1–3s，不会把查询压到 DB。这与 B-711 互补：B-711 解决接入层可用，本 spec 保证接入后的同步不放大风暴。
- **recovered=true**：房间和错过的 update 由 socket.io 重放。客户端仍然发 hello，因为服务端还没察觉断线时发进死链路的事件不在重放里（`socket.ts:84-90` 注释）。这次 hello 通常没有增量，代价约等于 1 次主键查询。
- **回滚到旧镜像**：旧 server 不认识 hello。新 Web（可能被 SW 缓存）在 2s 后进入 legacy 模式，行为与今天相同（加上 PR-1～3）。

### 4.7 代码落点

| 文件 | 内容 |
|---|---|
| `WR/syncProtocol.ts`（新） | §3 的 zod schema 和类型，从 `WR/index.ts` 导出 |
| `S/app/api/socket/sessionSyncHandler.ts`（新） | hello、subscribe、unsubscribe 的 handler；并发闸门；速率限制；指标 |
| `S/app/session/sessionSyncSnapshot.ts`（新，纯函数加一条 SQL） | §4.2 的快照读和 §4.3 的 gap 判定，可单独测试 |
| `S/app/api/socket.ts` | 只对 user-scoped 连接注册 handler（与 `sessionStreamHandler` 等并列） |
| `S/app/monitoring/metrics2.ts` | `sync_hello_total{result}`、`sync_subscribe_total{result}`、`sync_snapshot_duration_seconds`、`sync_gap_too_large_total`、`sync_subscriptions`（gauge）、`sync_hello_queue_wait_seconds` |

**后续项（r2 记录，未在 5a 实现）**：Grafana 新增 Sync 面板，展示上面这组指标。它是阶段 1 的观察项（§8 门槛「`sync_snapshot_duration` P95 < 30ms」），应随阶段 1 上线一起做，否则只能手写 PromQL 去看。读图注意：`sync_hello_queue_wait_seconds` 的 bucket 上限是 3s，排队超时的样本全部落在 `+Inf`，这是预期行为。
| `docs/monitoring` 看板 | 新增一行 Sync 面板（metrics skill） |

---

## 5. Web 实现

### 5.1 单一合并入口

```ts
// W/sync/sessionMerge.ts（新，纯函数核心 + sync.ts 薄封装）
type MergeSource =
  | 'cache'          // IndexedDB 读出
  | 'snapshot'       // hello/subscribe ack 的增量
  | 'latest-page'    // ack 中的 afterSeq=null 或 gapTooLarge
  | 'push'           // update/new-message（legacy 推送，也是 v1 唯一的推送）
  | 'send-ack'       // POST /v3 返回的 {id, seq, localId}
  | 'relay-committed'// session-message-committed（W/sync/sync.ts:2811）
  | 'older-page'     // before_seq 翻页
  | 'rest';          // legacy 模式或 REST 兜底的 after_seq

mergeSessionMessages(sid, batch: SyncMessage[] | SendAck[], source, meta?: { headSeq?: number; afterSeq?: number | null; hasMore?: boolean; generation: number })
  → { applied: number; lastSeq: number | undefined; gap: { from: number; to: number } | null }
```

规则（全部在会话锁内执行，锁只包住合并这一步，**不包网络**，沿用 PR-1）：

1. **代次过滤**：`meta.generation < state.generation` 的 snapshot、latest-page、rest 结果直接丢弃。这些是被取消的旧请求，晚到不能覆盖新状态。push、send-ack、relay-committed 不受代次限制，它们是实时事实。
2. **排序与去重**：入口处 `sortIncomingBySeq`（铁律 15）。已知 id 或已知 seq 跳过；localId 与乐观消息匹配时确认回显（复用 `reducer.ts` 现有逻辑，B-802 基线 :514-563）。
3. **lastSeq**：按来源分两类推进（seq 空洞见 §4.2.1）。
   - **点状来源**（push、send-ack、relay-committed、cache）：只沿**连续段**推进，复用 B-513 的 `advanceLastSeq`（`W/sync/outbox.ts:150`）。越过 lastSeq+1 的进入规则 4 的重排缓冲。
   - **范围来源**（snapshot、rest、latest-page、older-page）：服务端返回的是「该范围内存在的全部消息」，范围内缺的 seq 视为不存在，不算 gap。snapshot、rest 把 lastSeq 推进到 `max(本批 seq)`；`hasMore=false` 时再按规则 5 推进到 `headSeq`。older-page 把 oldestSeq 下移到 `min(本批 seq)`。
   - `latest-page` 重置窗口：`lastSeq = headSeq`（不是 `max(本批 seq)`，原因同规则 5），`oldestSeq = min`，丢弃旧窗口（只发生在 cold 或 gapTooLarge 时）。
   - 范围推进后，重排缓冲里 `seq ≤ 新 lastSeq` 的条目直接合并并清除，对应的 gap 计时器取消。
4. **gap**：push 或 send-ack 让 `seq > lastSeq+1` 时，先放进**重排缓冲**，等 **400ms**。原因是两个槽、不同请求的 emit 在 Redis stream 里的顺序不一定等于 commit 顺序。到期仍有缺口，就交给调度器发 `session-subscribe(afterSeq=lastSeq)`。
5. **head 校验**（`meta` 需带上本次请求的 `afterSeq`）：
   - `headSeq < meta.afterSeq`：本地超前于服务端（DB 恢复、会话重建），这个会话的缓存作废，按 cold（`afterSeq=null`）重拉，§6.2 第 10 行。这是**唯一**的「head 不一致」判定。
   - 否则，`hasMore=false` 时 `lastSeq := max(lastSeq, headSeq)`，这就是 **live 的证据**，状态机据此进入 `live`。`max(messages.seq) < headSeq` 是历史空洞（§4.2.1），不是不一致，不重试。
   - ack 回来时 lastSeq 已经大于 `headSeq`（推送先到，§4.2 末条）属于正常竞态：lastSeq 不回退，照常进入 `live`。
6. **副作用只对「新事实」生效**：turn-start/turn-end 推导 thinking、`recordHeartbeat`、`applySessions` 侧栏更新（`W/sync/sync.ts:2950-2990`），只在 source ∈ {push, snapshot, rest} 且 seq > 合并前的 lastSeq 时执行。`cache` 和 `older-page` 绝不触发，否则冷启动时一条陈旧的 turn-start 会让会话看起来一直在思考。
7. **写缓存**：合并成功后，把 applied 的消息异步交给 `SyncCache.put`（§5.4），不 await，不阻塞 UI。

**迁移约束**：现有 `handleUpdate` new-message 分支（`W/sync/sync.ts:2909`）、`fetchMessages`、`applyFetchedMessages`、发送 ack、relay committed、loadOlder，统一改成调用 `mergeSessionMessages`。PR-5b 加一条源码断言测试：`sync.ts` 中 `storage.getState().applyMessages`（或等价写 store 的调用）只能出现在 `sessionMerge` 里，并用 mutation-check 验证这条断言。

### 5.2 调度器（唯一的补拉入口）

`SessionSyncScheduler` 接收事件，决定发 hello、subscribe 还是 REST：

| 触发 | 动作 |
|---|---|
| `connect`（含 recovered、交接 candidate） | `sync-hello(subs = 当前订阅集)`，`reason=connect/handover` |
| `resumeSync` 边沿（铁律 13：只从 `sync.onWebResume` 进入） | 订阅模式：`sync-hello(reason=resume)`，ack 本身就是活性证明；ack 超时则调 `checkLiveness()`。legacy 模式：沿用 PR-1 的 restart |
| 打开会话 | 如果不在订阅集里，加入并 `session-subscribe(afterSeq = 缓存的 lastSeq ?? null)` |
| 离开会话 | 保留订阅 **5 分钟**（来回切换不必重拉），超时后退订；订阅集最多 8 个，按最近查看时间淘汰 |
| 重排缓冲到期仍有缺口 | `session-subscribe(afterSeq=lastSeq)` |
| `hasMore=true` | 继续 subscribe，直到 `hasMore=false` |
| `hasMore=false` 且 `max(messages.seq) < headSeq`（历史空洞） | **不发任何请求**：lastSeq 已按 §5.1 规则 5 推进到 head，进入 `live` |
| `headSeq < 请求 afterSeq` | 作废缓存，发 1 次 `session-subscribe(afterSeq=null)`；冷请求不会再触发这一条 |
| live 且可见，每 120s | `session-subscribe(afterSeq=lastSeq)`（§4.2 的兜底） |
| 离线（`isNetworkOffline()`） | 什么都不发，转 `stale(offline)`；恢复在线后由 connect 或 resume 触发 |
| 用户点「重试」 | 代次 +1，立即 hello |

**未订阅的会话**仍然通过 legacy `update/new-message` 收消息，用于侧栏、未读和 thinking；PR-3 之后只标 stale，不预取。打开这个会话时才 subscribe。

### 5.3 每会话状态机

```
state = { mode: 'subscribe'|'legacy', phase, generation, lastSeq?, oldestSeq?, headSeq?, since, reorder?: {from,to,deadline}, error? }
phase ∈ cold | loading | live | syncing | stale
```

| 当前 | 事件 | 下一 | 说明 |
|---|---|---|---|
| (none) | OPEN，没有缓存 | loading | 发 subscribe(null) |
| (none) | OPEN，缓存命中 | syncing | 先渲染缓存（source=cache），再发 subscribe(lastSeq) |
| loading/syncing | ACK ok，`!hasMore` 且 `headSeq ≥ 请求 afterSeq`（cold 请求恒成立） | **live** | 先 `lastSeq := max(lastSeq, headSeq)`，再进入 live。live 只有这一条进入路径（G2）。`max(messages.seq) < headSeq` 的空洞会话同样走这里，不重试（G2a） |
| loading/syncing | ACK ok，`headSeq < 请求 afterSeq` | loading | 作废该会话缓存，发 subscribe(null)，§6.2 第 10 行 |
| loading/syncing | ACK ok，`hasMore` | 不变 | 继续拉 |
| loading/syncing | ACK `gapTooLarge` | syncing→live | 重置窗口，按最新页处理，然后照常校验 head |
| live | PUSH 连续 | live | — |
| live | PUSH 出现 gap，重排缓冲到期 | syncing | 发 subscribe |
| live | RESUME / CONNECT | syncing | hello |
| 任意 | SOCKET_DOWN 或 OFFLINE | stale(reason) | 保留数据 |
| syncing | ACK 超时（5s） | stale(timeout) | 调 `checkLiveness()`；连接恢复后自动重试 |
| syncing | ACK `unavailable` 连续 3 次 | stale(server) | REST 兜底一次（PR-1 路径，10s 超时） |
| stale | CONNECT、ONLINE 或 RETRY | syncing | 代次 +1 |
| 任意 | ACK `disabled` 或首次 hello 2s 无 ack | mode=legacy | 当前连接期间保持 legacy，phase 按 PR-1～3 的旧逻辑 |
| 任意 | ACK `not_found` | (removed) | 交给现有的删除或无权限路径 |

**UI 映射**沿用 PR-2 的组件和文案，不新增状态源，并与 B-799 的 `beginNetworkSync` 共用：

| phase | 聊天区 |
|---|---|
| loading | 现有首屏 loading |
| syncing | 底部细条「同步中…」，超过 300ms 才显示（PR-2） |
| stale(timeout/server) 超过 3s | 「连接不稳定 · 重试」（PR-2） |
| stale(offline) | 交给 B-799 离线条，聊天区不再重复提示 |
| live | 不显示 |

outbox 中的消息在任何 phase 都显示（§5.5），不受同步状态影响。

### 5.4 IndexedDB 消息缓存（PR-6a）

**库**：`vh-sync-<sha256(accountId) 前 16 位>`，每个账号一个库。账号切换时互不可见；退出登录时删除本机所有 `vh-sync-*` 库。实现用原生 IDB 加一层约 150 行的薄封装（`W/sync/cache/idb.ts`）。`idb-keyval` 只支持单一 key-value store，不够用，所以不使用它；也不为此引入新的运行时依赖。测试用 `fake-indexeddb` 作为 devDependency（属于功能依赖，不是一次性工具，不违反铁律 3）。

**schema v1**：

| store | key | value | index |
|---|---|---|---|
| `meta` | `'meta'` | `{ schema: 1, accountHash, createdAt, lastCleanupAt, appBuild }` | — |
| `sessions` | `sid` | `{ sid, lastSeq, oldestSeq, headSeqSeen, count, bytes, lastAccessAt, cachedAt }`（`count` 即 rowCount，见下文「写入」；r2 起不含 `dek`） | `lastAccessAt` |
| `messages` | `[sid, seq]` | `SyncMessage`（服务端原样密文 `content`）加 `sid` | — |
| `outbox` | `localId` | §5.5 | `sid`、`ownerTabId` |

- **只缓存连续段**：`messages` 里每个会话只有一段 `[oldestSeq, lastSeq]`。「连续」指这一段**已被服务端范围结果完整覆盖**（§5.1 规则 3），不是「每个 seq 都有一行」：老会话可能有永久空洞（§4.2.1），所以行数可以小于 `lastSeq-oldestSeq+1`。`sessions.lastSeq` 存的是合并后的 lastSeq，可能等于 head 而大于最后一行的 seq。older-page 向下扩展这一段，latest-page 重置这一段（先 `delete` 整个会话，再 put）。
- **写入**：合并后异步批量 put，每 250ms 或满 50 条 flush 一次，一次 readwrite 事务。写入失败不影响 UI，只记一次指标。
- **rowCount**：每次改动一个会话的段（flush、older-page 扩展、latest-page 重置、按行数裁剪、LRU 删除），都在**同一个 readwrite 事务**里把 `sessions.count` 写成该段在 `messages` 中的实际行数。行与 count 同事务提交，所以正常情况下二者永远一致；读取时用它区分「服务端本来就有的空洞」和「本地丢行」（§5.4.2）。
- **读取**：OPEN 时在 `IDBKeyRange.bound([sid, oldestSeq], [sid, lastSeq])` 上开 `prev` 方向游标，取最新 300 行。不用 `[lastSeq-299, lastSeq]` 的 seq 区间：有空洞时会少于 300 行，尾部空洞较大时甚至可能读不到。
- **锚点校验（6a 在 legacy REST 下的对账）**：6a 可以先于 5b 上线，这时没有 hello/subscribe，legacy REST `after_seq` 不返回 head，不能按 §5.1 规则 5 用 `headSeq < 请求 afterSeq` 判断缓存是否超前。所以缓存命中（`CacheHit`）除 `rows/oldestSeq/lastSeq` 外，额外带上段内最新一行的 `lastRowSeq` 和 `lastId`（`lastSeq` 可能已推进到 head、大于 `lastRowSeq`，见上文「只缓存连续段」）。渲染缓存后，第一次前向请求改用 `after_seq = lastRowSeq - 1`，取服务端返回的 `seq = lastRowSeq` 那一行比对：
  - 这一行不存在 → `behind`：服务端落后于缓存（DB 恢复到更早时间点、会话重建）；
  - 这一行存在但 `id ≠ lastId` → `mismatch`：同一 seq 是另一条消息；
  - 两种情况都按 §5.4.2 删除该会话缓存、重置内存窗口，改走 cold；`ok` 时这一页中 `seq > lastSeq` 的部分作为第一页增量继续前向拉取。
  
  这个探针只多取 1 行，不额外发请求。5b 上线后，订阅模式由 head 校验（§5.1 规则 5）覆盖同一类问题，legacy 模式和 REST 兜底继续用锚点校验。
- **不缓存 DEK**（r2 决定，替代 r0「推荐缓存」；取舍见 §16 取舍 1）：冷启动时要等 `/v2/sessions` 返回、拿到 DEK 之后才能解密渲染缓存。不缓存的理由有两条：(1) 安全：IDB 里只留服务端原样密文，单拿到 IDB 文件读不出内容，退出登录前离线可读的时间窗不扩大；(2) 收益小：B-813 实测冷启动的瓶颈在应用启动和首次渲染，缓存 DEK 只省约 1 个 RTT。

### 5.4.1 LRU 与容量

| 上限 | 默认 | 依据 |
|---|---|---|
| 会话数 | 30 | 活跃 team 场景，单客户端同时有 6 个以上活跃会话（DESIGN-REVIEW §2.3-1），30 留出约 5 倍余量 |
| 每会话条数 | 最近 300 | 与首屏「1–3 页、100–300 条」对齐（`W/sync/historyWindow.ts`） |
| 总字节 | 40MB | 30 × 300 × P95 2.8KB ≈ 25MB，再留余量；iOS Safari 单源配额通常远大于这个值 |

- 淘汰按 `sessions.lastAccessAt` 从旧到新，**有 outbox 记录的会话不淘汰**。
- 触发：每次 put flush 之后，如果距上次清理超过 60s，用 `requestIdleCallback` 计算并删除；打开 app 时也跑一次。
- 每会话超过 300 **行**时，只保留最新 300 行，`oldestSeq` 上移到保留行中最小的 seq（按行数裁剪，不按 seq 区间，理由同「读取」）。
- `QuotaExceededError`：先淘汰一半会话，重试一次；仍然失败就本页生命周期内禁用缓存写（读仍可用），记指标。
- **内存 LRU（PR-6c）**：有了缓存，内存里的 `sessionMessages` 可以驱逐。非当前、非订阅集、10 分钟未访问的会话，在超过 12 个时释放 reducer 状态，再次打开时从缓存恢复（约 10–40ms）。这解决 R6。

### 5.4.2 损坏与不一致的恢复（缓存只影响速度，不影响正确性）

| 检测 | 处理 |
|---|---|
| `indexedDB.open` 抛错或 `onblocked` 超过 3s（隐私模式、配额、其他标签页持有旧版本） | 本标签页无缓存运行（行为等于今天加 PR-1～5） |
| `meta.schema` 与代码不一致，或 `upgradeneeded` 中途失败 | `deleteDatabase` 后重建；重建失败就无缓存运行 |
| 读出的记录过不了 `SyncMessage` schema，或解密失败 | 删除这个**会话**的缓存，回到 cold 路径 |
| 段越界：有行的 seq 不在 `[oldestSeq, lastSeq]` 内，或行数 > `lastSeq-oldestSeq+1`，或 seq 重复。**行数小于**区间长度不算损坏（历史空洞，§4.2.1） | 删除该会话的缓存 |
| **行数与 rowCount 不一致**：该会话在 `messages` 中的实际行数（`IDBObjectStore.count`）≠ `sessions.count`。rowCount 与行同事务写入（§5.4「rowCount」），所以不一致只能是本地丢行或写坏。区别于历史空洞：空洞是服务端本来就没有的 seq，行数小于区间长度但等于 rowCount，不算损坏 | 判为本地损坏：删除该会话的缓存，本次改走网络（cold） |
| 锚点校验 `behind`：`after_seq=lastRowSeq-1` 的结果里没有 `seq=lastRowSeq` 这一行（§5.4「锚点校验」） | 删除该会话的缓存，重置内存窗口，cold 重拉 |
| 锚点校验 `mismatch`：`seq=lastRowSeq` 那一行的 `id ≠ lastId` | 同上 |
| ack 显示 `headSeq < 请求 afterSeq`（§5.1-5，即缓存的 lastSeq 超前于服务端） | 删除该会话的缓存，cold 重拉 |
| 同一 seq 的服务端 id 与缓存 id 不同（ack 增量与缓存重叠时检查） | 删除该会话的缓存，cold 重拉 |
| 会话被删除，或收到 `not_found` | 删除该会话的缓存和 outbox（outbox 先转 failed 并提示，见 §5.5） |
| 任何一次缓存读写超过 2s | 视为卡死，本页禁用缓存 |

每种恢复路径都有单测（fake-indexeddb 注入坏数据），e2e 覆盖「篡改一个会话的缓存后刷新」。

### 5.5 持久 outbox（PR-6b）

#### 5.5.1 记录

```ts
OutboxRow = {
  localId: string;                 // 主键，等于服务端幂等键
  sid: string;
  body: string;                    // 已加密的 POST 内容，重发时字节完全相同
  displayText: string;             // 用于渲染乐观气泡（与 B-722 现有乐观消息同源）
  createdAt: number;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  seq?: number;                    // sent 后由 send-ack 写入
  attempts: number;
  lastError?: string;
  ownerTabId: string;              // B-516 tabLiveness 的 tab id
  group?: string;                  // 与现有 outboxRecords 的 group 一致
}
```

#### 5.5.2 生命周期

`queued(offline) → sending → sent(seq) → (合并看到同一 localId 或 seq) 删除`，失败为 `failed`。

- 顺序：先按 B-722 在点击栈里画出乐观气泡，再加密，再写 IDB，最后 POST。IDB 写入不阻塞首帧，但 **POST 必须在 IDB 写入完成之后发出**。否则 POST 成功了、页面却在写入前被杀，刷新后这条消息在本地就完全没有记录；虽然服务端已有，不会丢，但用户会短暂看不到。实现上二者在同一个微任务链里，延迟约 1–5ms。
- 状态只在边沿写 IDB，不按心跳频繁写。

#### 5.5.3 启动与多标签页

- 启动时读出 `outbox` 里所有记录，按 `ownerTabId` 检查存活（`tabLiveness.isTabAlive`）。存活标签页的记录不动，那个标签页自己负责。主人已不在的记录，用 `withTabLock` 接管，模式与 B-516 `pendingSessionsRuntime.ts:62` 相同。
- 接管后的处理按年龄（取舍见 §16 取舍 2）：
  - `createdAt` 距今 ≤ **10 分钟**：自动重发，复用同一个 localId；服务端已存在时返回原 seq 且不再 emit（`sessionMessageStore.ts:87-107`），所以不会重复。
  - 超过 10 分钟：转 `failed`，气泡显示「未发送 · 重发 / 丢弃」。理由是 agent 指令有时效性，一小时前的「继续」不应该在用户不知情时被执行。
- `sent` 状态的记录：等合并看到同一 localId 或 seq 后删除。启动时直接 subscribe 这些记录所属的会话，确认后删除。
- 其他标签页**不显示**本标签页的 pending（与今天一致）。消息被服务端接受后，所有标签页都通过推送看到。

#### 5.5.4 与 B-801 待建会话对齐

待建会话的首条消息仍由 `pendingSessions`（localStorage）负责。spawn 成功、拿到 sid 后，首条消息进入正常 outbox 时才写 IDB，localId 保持不变。PR-6b 不改 B-801 的存储，只加一条 e2e：「草稿首发后立刻刷新」，断言消息恰好出现一次。

#### 5.5.5 在内存中的位置

`pendingOutbox`、`outboxRecords`（`W/sync/sync.ts:215-216`）仍然是运行时的权威副本，IDB 只是它的持久镜像（write-through）。启动时用 IDB 填充它们。这样 PR-6b 对 B-722 的发送状态 UI 是零改动。

### 5.6 文件落点（Web）

| 文件 | PR |
|---|---|
| `W/sync/sessionMerge.ts`、`W/sync/sessionSyncState.ts`（纯函数加表驱动测试） | 5b |
| `W/sync/sessionSyncScheduler.ts` | 5b |
| `W/sync/apiSocket.ts`：hello 作为 reconnectedListener，交接时等 hello 完成 | 5b（**冲突热区**：先 `git log -5`） |
| `W/sync/sync.ts`：各写入点改为调用 merge | 5b（**冲突热区**） |
| `W/sync/cache/idb.ts`、`W/sync/cache/syncCache.ts`、`W/sync/cache/lru.ts` | 6a/6c |
| `W/sync/cache/outboxStore.ts` | 6b |
| `W/sync/storage.ts`：内存驱逐 | 6c（**冲突热区**） |

---

## 6. 开关与兼容矩阵

### 6.1 开关

| 开关 | 位置 | 效果 |
|---|---|---|
| `SYNC_SUBSCRIBE_DISABLED=1` | server env | hello 和 subscribe 立即回 `{ok:false, error:'disabled'}`，Web 全部进入 legacy。**这是主开关**，改 env 后重启槽即可，不需要换镜像 |
| `SYNC_SUBSCRIBE_ACCOUNTS=<id,…>` | server env | 设置后，只有名单内账号拿到 `ok:true`，其余账号视同 disabled。灰度用 |
| `SYNC_GAP_THRESHOLD`、`SYNC_HELLO_MAX_CONCURRENCY` | server env | §4.3、§4.4 |
| `vh.sync.cache=off` | Web localStorage（仅本机，不进 synced settings，见铁律 1） | 关闭 IDB 读写，并删除库 |
| `vh.sync.mode=legacy` | Web localStorage | 本机强制 legacy，用于排查 |

### 6.2 兼容矩阵（每行都有 §9 的测试）

| # | 组合 | 行为 | 风险 |
|---|---|---|---|
| 1 | 新 Web + 新 server + **旧 CLI** | CLI 继续用 `update`、REST 和 relay，没有任何变化；Web 走订阅 | 无 |
| 2 | 新 Web + 新 server + 新 CLI（PR-4） | 同上；PR-4 只改 CLI 本地游标规则 | 无 |
| 3 | **旧 Web**（SW 缓存的旧包）+ 新 server | 不发 hello，服务端也不会主动推任何新事件；行为与今天完全相同 | 无 |
| 4 | 新 Web + **旧 server**（切换窗口里连到旧槽，或回滚） | hello 2s 无 ack，本连接 legacy，相当于 PR-1～3 的行为；下次 connect 重新协商 | 首次进入多等 2s：最新页在这 2s 里并行用 REST 拉取，不阻塞首屏（§6.3） |
| 5 | 交接期间：旧 socket 在旧槽（旧 release）、candidate 在新槽 | candidate 连上后 hello 得到 ack；两条 socket 的重复 update 由 `this.socket` 判断和合并去重处理 | 无 |
| 6 | 交接期间：两槽都是新 release | 同 5；hello 落在新槽，快照读同一个 DB | 无 |
| 7 | `SYNC_SUBSCRIBE_DISABLED=1` | 全部 legacy；PR-6 缓存仍然可用（legacy 模式下合并入口相同，只是对账走 REST） | 无 |
| 8 | grantee（B-619）| 订阅鉴权用 `resolveSessionAccess`；推送仍走 fan-out | grant 撤销后，`activeGranteeIds` 缓存期内还可能收到推送（与今天相同） |
| 9 | 多标签页 | 每个标签页各自 hello；共用 IDB；outbox 按 ownerTabId 归属 | IDB 同时写同一 `[sid,seq]`，put 幂等，内容相同 |
| 10 | 新 Web 缓存 + server 数据被恢复到更早时间点 | ack 的 `headSeq < 请求 afterSeq`（即请求时的 lastSeq），作废该会话缓存并 cold 重拉一次（§5.1-5、§5.4.2）。这是唯一的 head 不一致判定 | 无；冷请求没有 afterSeq，不会循环 |
| 11 | 任意 Web + server，老会话有 seq 空洞（`Session.seq > max(SessionMessage.seq)` 或中间缺号，§4.2.1） | server 原样返回 head；新 Web 在 `hasMore=false` 时把 lastSeq 推进到 head，进入 live；旧 Web 和 legacy 模式行为与今天相同 | 无；空洞 seq 永远不会被推送，不会产生「等不到的 gap」 |

### 6.3 legacy 回退不能拖慢首屏

首次 connect 时，hello 和「最新页 REST」**不串行**：冷会话打开时，如果 hello 还没 ack，200ms 后并行发 PR-1 的 REST 首屏请求。两者谁先到都走合并入口，代次相同，结果按 seq 去重。这样第 4 行只多一点流量，不多时延。

### 6.4 发布顺序

server 与 Web 同镜像（铁律 5），所以 PR-5a（server）合入后，先以「Web 不调用」的状态上线一版，即服务端 handler 处于暗发布状态；然后才合 PR-5b。任何一步回滚都是回退镜像或设置 `SYNC_SUBSCRIBE_DISABLED=1`。不涉及 CLI。

---

## 7. 被否 / 延后的方案

| 方案 | 结论 | 理由 |
|---|---|---|
| **v2：专属订阅房间 `sync:sess:<sid>` + `session-messages`，legacy 推送用 `.except(room)` 排除已订阅 socket，未订阅会话只发 `session-head`** | **延后**。触发条件：单客户端同时活跃会话 ≥ 10 个时，推送流量成为瓶颈（看 PR-5a 的指标）；或者生命周期信号迁到 ephemeral 之后 | 每条消息多一次 XADD，stream 条数翻倍，B-494 MAXLEN=2 万对应的 recovery 时间窗减半；切流窗口里旧槽的 emit 不带 except，新 Web 仍要处理 legacy 推送，复杂度只增不减；`session-head` 不带明文，侧栏 thinking 会退化（`sync.ts:2950-2990`）。省下来的只是「推送给不在看的会话」的约 1.1KB/条 |
| 继续用 REST，只加 head 探针（`GET /v1/sessions/:id` 的 seq） | 否 | 仍然受 R1（HTTP 连接池死连接）影响；需要 2 个请求，不是原子的 |
| 账号级 seq 全局游标（Discord 式） | 否 | DESIGN-REVIEW §5.4 |
| 缓存解密后的明文 | 否 | 体积和安全都更差；解密 300 条只需要几十毫秒，不值得 |
| 缓存 DEK（r0 推荐） | 否（r2） | 安全：IDB 只留密文；收益小：实测冷启动瓶颈在应用启动和渲染，只省约 1 个 RTT（§5.4） |
| 用 `idb-keyval` | 否 | 只有单 store，没有范围查询和索引 |
| outbox 进 localStorage | 否 | 同步 API 会阻塞主线程；约 5MB 配额；无法和消息缓存放在同一个事务里 |

---

## 8. 分阶段上线

| 阶段 | PR | 内容 | 上线后观察 | 进入下一阶段的门槛 |
|---|---|---|---|---|
| 0 | — | PR-1～3 上线（前提）；记录基线：`after_seq` GET/分钟、回前台追平时间（e2e B3/B6）、首屏时间 | — | QA 用 `e2e/sync-resume.mjs` 验收通过 |
| 1 | **5a** server + wire | hello、subscribe 的 handler，限额，指标；Web 不调用 | 用 canary 脚本对生产 hello，确认 ack 和 `sync_snapshot_duration` P95 < 30ms | 1 次蓝绿切流期间，canary hello 持续成功 |
| 2 | **5b** Web 订阅 | 合并入口、状态机、调度器；`SYNC_SUBSCRIBE_ACCOUNTS=<Owner>` 灰度 | Owner 账号使用 2–3 天；`sync_hello_total{result!=ok}` < 1%；没有新的「消息看不见」反馈 | 去掉账号名单，全量 |
| 3 | **6a** 消息缓存 | 读写缓存加损坏恢复；默认开启 | 首屏时间、缓存命中率（Web 本地计数，可在调试面板查看）、`QuotaExceeded` 次数 | 一周内没有缓存相关缺陷 |
| 4 | **6b** 持久 outbox | 刷新后 pending 仍在；10 分钟规则 | 真机：iOS 杀后台后 pending 恢复 | — |
| 5 | **6c** 内存 LRU | 驱逐非活跃会话的 reducer 状态 | 长时间使用后的内存占用（Chrome heap snapshot） | — |
| 6（可选） | 7 | CLI 改用 subscribe、outbox 落盘；删除 Web legacy 中已不用的补拉入口 | 另立 spec | — |

每个阶段都单独发 server/Web 镜像。阶段 2 之后，legacy 路径保留至少 2 个版本，作为 `disabled` 时的回退。

---

## 9. 测试计划

### 9.1 Server（vitest + 真 Postgres，沿用 server 现有的测试基建）

1. **原子性**：在 handler 的「join 之后、快照之前」和「快照之后、ack 之前」注入可控延迟；并发写 N 条消息（多个 POST、prompt-queue 出队、share 写入四种 emit 源都覆盖）。断言：客户端收到的 `ack.messages ∪ push` 的 seq 集合等于 DB 中 `seq > afterSeq` 的全集，没有缺口。用随机交错跑 200 轮（属性测试）。
2. `head` 与 `messages` 的一致性：`hasMore=false ⇒` DB 中 `afterSeq < seq ≤ head` 的行全部返回，且 `max(seq) ≤ head`；`messages` 中没有 `seq > head` 或 `seq ≤ afterSeq` 的行。
2a. **seq 空洞 fixture**：直接写库构造 `Session.seq=12`、消息 seq 为 1–4、6–10（5 为中间空洞，11–12 为尾部空洞）。断言：`afterSeq=null`、`afterSeq=4`、`afterSeq=10`、`afterSeq=12` 都返回 `ok:true`、`headSeq=12`、`hasMore=false`，messages 分别为全部 9 行、6–10、空、空；server 不修改 `Session.seq`（请求前后读库相等）。
3. gapTooLarge 阈值边界（499、500、501）；冷请求（`afterSeq=null`）返回最新页且为升序。
4. 鉴权：owner、grantee、撤销后、已删除、跨账号，都返回正确结果；`not_found` 不泄露「存在但无权限」。
5. 限额：第 17 个 sub、速率超限、并发闸门排队超时都回正确错误码；并发闸门**不会**饿死（公平 FIFO）。`subs` 65 个时整体回 `invalid_request`，64 个时逐条回 `too_many_subscriptions`（r2）。快照超过 1.5s deadline 时回 `unavailable`，且闸门槽位要等 DB 语句结束才释放（注入慢查询，断言在途语句数不超过闸门上限）（r2）。
6. 体积截断：超过 512KB 时，`hasMore` 和截断位置正确。预算被前面的 sub 用完时，后续 sub 回 `messages:[]`、`hasMore:true`（最新页不带 `oldestSeq`）；用原请求的 afterSeq 重新 subscribe 能拿到完整结果（r2）。
7. 开关：`DISABLED`、`ACCOUNTS` 名单。
8. 非 user-scoped 连接返回 `unsupported_client`。
9. **跨槽**：两个 server 进程共用 Postgres 和 Redis（沿用 `deploy/integration-tests/missed-events.mjs` 的结构）。A 槽 hello，B 槽写入，断言推送到达且快照无缝。
10. mutation-check：去掉「快照读放在 join 之后」的保证（例如把 handler 改成先读后注册的变体），或者去掉 head 与 messages 同语句读取，测试 1 必须失败。

### 9.2 Web 单测（vitest，fake timers + fake socket + fake-indexeddb）

1. 状态机：§5.3 的表逐行驱动，每一行一个用例。
2. 合并入口属性测试：同一组消息按随机来源、随机顺序、随机重复投入，最终 store 必须等于「按 seq 去重排序后的全集」；lastSeq 只增不减；代次旧的结果不覆盖新结果。
3. 副作用：source=cache 或 older-page 时，**不**触发 thinking、heartbeat；push 新 seq 时触发。
4. 重排缓冲：先到 N+2，400ms 内再到 N+1 → 不发请求；超过 400ms → 发 1 次 subscribe。
5. legacy 回退：hello 2s 无 ack → legacy；ack 晚到被忽略；`disabled` → legacy。未知错误码（如 `error:'foo'`）折算为 `unavailable`，走退避，连续 3 次转 `stale` 并 REST 兜底一次（r2）。空页且 `hasMore:true` 时，下一次 subscribe 的 afterSeq 等于原请求的 afterSeq（冷请求仍为 `null`）（r2）。
6. 缓存：写入、读出往返；连续段维护；LRU 淘汰顺序；有 outbox 的会话不被淘汰；Quota 错误；§5.4.2 每一行的损坏注入。r2 补充：(a) 每种改段操作（flush、扩展、重置、裁剪、LRU 删除）之后 `sessions.count` 等于实际行数；(b) 删掉一行但不改 count → 判损坏、删缓存、走网络；有空洞但 count 一致 → 正常命中；(c) 锚点校验：fake REST 对 `after_seq=lastRowSeq-1` 回缺这一行 → `behind`，回同 seq 不同 id → `mismatch`，两者都删缓存、cold 重拉恰好 1 次；`ok` 时只把 `seq > lastSeq` 的部分合并为增量；(d) `sessions` 记录中没有 `dek` 字段，冷启动要等会话列表返回后才解密。
7. outbox：write-through；10 分钟规则（fake 时钟）；接管只接管主人已死的记录；`sent` 记录的确认与删除。
8. 源码断言：store 的写入只出现在 `sessionMerge`，用 mutation-check 验证。
9. **head 大于最新消息 seq 的老会话能进入 live，不循环**：fake socket 对 `subscribe(afterSeq=10)` 回 `{headSeq:12, messages:[], hasMore:false}`。断言：phase 进入 `live`，`lastSeq=12`；之后 fake 时钟推进 119s，subscribe/hello 总共只发了 1 次（即最初那次，120s 兜底之前没有额外请求）；没有进入 `stale`，没有 REST 兜底。同一用例再跑 cold 变体（`afterSeq=null` 返回 1–10、`headSeq=12`）和中间空洞变体（push 先到 N+2 越过空洞 N+1 → 400ms 后恰好 1 次 subscribe → 空 ack → live，不再请求）。mutation-check：把规则 5 改回「`max(messages.seq)==headSeq` 才 live」，本用例必须失败。
10. **head 不一致只认 `headSeq < 请求 afterSeq`**：(a) `subscribe(afterSeq=10)` 回 `headSeq=8` → 作废缓存，恰好 1 次 `subscribe(null)`，随后 live，不循环；(b) 竞态：`subscribe(afterSeq=10)` 发出后，push seq 11 先于 ack（`headSeq=10`）到达 → 不作废缓存，lastSeq 保持 11，进入 live。
11. 缓存有空洞时不判损坏：IDB 中会话段 `[1, 12]` 只有 9 行（同 §9.1-2a）→ 正常命中渲染；行数 > 区间长度或 seq 越界才删除（§5.4.2）。

### 9.3 e2e（扩展 PR-1 引入的 `packages/happy-web-v2/e2e/sync-resume.mjs`：standalone server + 隔离 daemon + Chromium + 可控 TCP 代理）

断言一律写具体数字。代理 RTT=150ms 时：

| 场景 | 断言 |
|---|---|
| B3、B6（切后台 + 在途请求冻结 + 死连接） | 订阅模式下，回前台到追平 ≤ 1.5s（链路可用时）；死 socket 时 ≤ 6s；全程「同步中」可见，追平后消失 |
| 断网重连（blackhole → heal 加 socket 强断） | 恢复后 ≤ 2s 追平；离线期间对端发的消息全部到达且顺序正确 |
| 切会话（A1：0/150/600ms 切走再切回） | 切回时 ≤ 300ms 渲染（来自订阅保留或缓存），不重复、不缺 |
| 双标签页（tab1 经代理、tab2 直连，互发 50 条） | 两端最终 seq 集合相等、顺序一致 |
| **蓝绿切换**：起两个 server 槽共用 DB 和 Redis，执行 drain、交接、停旧槽；切换期间对端持续发消息 | 无缺失；hello 在新槽 ack；「同步中」显示时长 ≤ 3s |
| **新 Web + 旧 server**：一个槽跑旧镜像 | 2s 后进入 legacy，消息照常；首屏不慢于基线加 200ms |
| hello 风暴：300 个 socket 同时 connect + hello | 全部在 10s 内得到 ok；`sync_hello_queue_wait` P95 < 2s；同一时间 DB 连接数不超过闸门上限 |
| 冷启动缓存：有缓存时刷新 | 可交互后 ≤ 300ms 出现缓存内容；随后对账，期间显示「同步中」 |
| 离线刷新 | 显示 B-799 离线条，不报错；缓存在网络恢复、会话列表返回后才显示（r3：r2 不缓存 DEK，离线拿不到会话列表就无法解密，`fetchMessages` 离线直接返回） |
| 缓存篡改：改坏一个会话的缓存后刷新 | 该会话走 cold 路径正确显示，其他会话的缓存仍然命中 |
| outbox：发送 POST 在途时关闭页面，再重开 | 消息恰好出现一次（服务端幂等）；10 分钟以上的记录显示「未发送」 |
| outbox：两个标签页，关掉主人标签页 | 另一个标签页接管并发出，恰好一次 |
| B-801：草稿首发后立刻刷新 | 恰好一次 |
| **seq 空洞老会话**：standalone server 上写入 10 条后，直接 SQL `UPDATE "Session" SET seq = seq + 2`（模拟 §4.2.1 的尾部空洞），刷新并打开该会话 | ≤ 1.5s 进入 live，「同步中」消失；之后 10s 内该会话的 subscribe/hello 不超过 1 次；对端再发 1 条（seq=13）时实时显示，不触发补拉 |
| gapTooLarge：离线期间对端写 600 条 | 回来直接显示最新页，向上滚动可以加载更早的消息，没有卡顿（主线程长任务 < 200ms） |

UI 部分（状态条）沿用 PR-2 已经通过的 device-shots 和 design lint；本 spec 不新增 UI 组件。

### 9.4 真机（verify-queue）

- iOS Safari / PWA 锁屏 1 分钟、5 分钟后回来：追平时间，以及「同步中」的显示。
- iOS 在后台被系统回收页面后重开：缓存是否秒开，pending 是否恢复。
- iOS 7 天未访问（非 PWA）后 IDB 被系统清除：确认会退回 cold 路径，不报错。浏览器无法模拟 ITP 的清除策略，所以只能真机验证。
- Android Chrome 后台 10 分钟后回来。

---

## 10. 性能预估

依据：生产 14 天统计（DESIGN-REVIEW §2.3-3：密文 P50 1094B、P95 2758B；每会话消息数 P50 228）；服务端时延（§2.2：`after_seq` P50 14.7ms、P95 29ms）；生产 `after_seq` 约 200–270 次/分钟（PR-3 之前）。

### 10.1 流量

| 项 | PR-1～3 之后 | 本 spec 之后 |
|---|---|---|
| 实时推送 | 每条约 1.3KB（密文加信封），发往该账号所有 Web socket | **不变**（v1 不改推送） |
| 回前台 | 1 次 REST GET（含 HTTP 头约 0.6KB）加增量 | 1 次 hello，约 0.2KB 加增量（多会话合并成一次）。省下的不是字节，而是死连接带来的等待（R1） |
| 重连、交接 | 每个当前会话 1 次 REST GET | 1 次 hello |
| live 兜底 | 无 | 每个可见会话每 120s 一次空 subscribe，约 150B，即每小时约 4.5KB |
| 冷启动、刷新 | 首屏 110–330KB | 有缓存时只拉增量，通常 < 5KB；缓存未命中时与今天相同 |
| 服务端 DB | 回前台、重连各 1 次范围查询 | hello 约 1 次主键批查；只有存在增量时才做范围查询 |

### 10.2 时延

| 场景 | PR-1～3 之后 | 本 spec 之后 |
|---|---|---|
| 健康链路回前台 | 1 RTT + 15ms + 解密，约 100–400ms | 相同，约 100–400ms（hello 就是那一个 RTT） |
| 回前台时 HTTP 连接池里是死连接（B6） | 最多 10s 超时 + 重试，约 10–12s | socket 刚经过活性验证，hello 不走 HTTP 连接池：约 100–400ms |
| socket 也死了 | 约 5s ping 超时 + 重连 + GET | 5s ack 超时 + 重连 + hello，约 6s |
| 冷启动首屏（有缓存，中端 Android） | 网络 3 RTT + 110–330KB 下载 + 解密，4G 下约 0.6–2s | IDB 读 300 条约 20–60ms，加解密约 30–80ms，**合计 ≤ 300ms**（G4），之后后台对账。不缓存 DEK（r2）：解密要等 `/v2/sessions` 返回，约多 1 个 RTT；实测这不是冷启动瓶颈 |
| 切回 5 分钟内看过的会话 | 内存命中，即时 | 相同；超过 5 分钟则由缓存命中，约 50–150ms |

以上数字是估算，PR-5b、PR-6a 的 PR 正文必须附实测值（e2e 计时，加一台中端 Android 真机）。

### 10.3 内存与存储

| 项 | 估算 |
|---|---|
| server 订阅表 | 每个 sub 约 100B；按 500 个 socket × 4 个 sub 算约 200KB，可忽略 |
| server 并发闸门 | 每槽最多 32 个在途查询，每个结果 ≤ 512KB，峰值 ≤ 16MB（实际几乎都是空增量） |
| Redis | v1 没有新增 XADD，与今天相同 |
| Web IDB | 典型：30 会话 × 300 条 × 1.1KB ≈ 10MB；上限 40MB |
| Web 内存（PR-6c 之后） | 只保留当前会话加至多 12 个热会话的 reducer 状态；今天是只增不减 |

---

## 11. 工作量估计

**依据**（本仓库同类 PR 的规模，`git show --shortstat`）：

| 参照 | 规模 | 相似点 |
|---|---|---|
| B-494 #416 `e4525396` | 9 文件，+906 | server socket 层新增 handler，附限额和指标，有跨进程测试 |
| B-799 #740 `293a4856` | 19 文件，+1075 | Web 同步状态与离线队列，附 e2e |
| B-722 #673 `dc80342a` | 26 文件，+1169 | outbox 与乐观发送状态 |
| B-516 #458 `9bf8ec09` | 37 文件，+2519 | 多标签页归属（tabLiveness）、持久化 pending |
| B-506 #444 `7e7db808` | 35 文件，+2218 | 跨包协议，附兼容处理 |

在这个团队里，上述 PR 从开工到 CI 全绿加 1–2 轮 review，约 1–2.5 个 agent 工作日。

| PR | 内容 | 预计规模 | 工作日 | 依据与风险 |
|---|---|---|---|---|
| 5a | wire + server handler + 限额 + 指标 + 跨槽测试 | 约 +900，10 文件 | 1.5–2 | 与 B-494 相当；SQL 和原子性测试是主要工作 |
| 5b | 合并入口 + 状态机 + 调度器 + 改造 sync.ts 写入点 + e2e（蓝绿、旧 server） | 约 +1500 / −400，20 文件 | **3–4** | 风险最高：`sync.ts` 有 3727 行，是冲突热区，涉及 6 个入口。e2e 需要起双槽 |
| 6a | IDB 封装 + 消息缓存 + LRU + 损坏恢复 | 约 +1100，12 文件 | 2 | 与 B-799 相当；fake-indexeddb 测试 |
| 6b | 持久 outbox + 多标签页接管 + 10 分钟规则 + B-801 对齐 | 约 +900，12 文件 | 1.5–2 | 复用 B-516 的 tabLiveness 模式，与 B-722 相当 |
| 6c | 内存驱逐 | 约 +300，5 文件 | 0.5–1 | `storage.ts` 冲突热区 |
| QA + 发布 | 每阶段一次 e2e 验收加真机队列 | — | 0.5–1 | — |
| **合计** | | | **9–13** | |

**并行**：5a 和 6a 没有文件交集，可以同时开工。5b 依赖 5a 上线；6b 依赖 6a。两条线并行时，日历时间约 **1.5–2 周**，其中包括阶段 2 的 2–3 天灰度。

---

## 12. 风险

1. **合并入口改造面大（5b）** → 先抽纯函数并做属性测试，再逐个入口迁移；源码断言保证没有旁路；`vh.sync.mode=legacy` 可在本机立即回退，server 开关可全局回退。
2. **重排缓冲 400ms 会掩盖真实的 gap** → 只延迟补齐，不丢消息；到期一定补拉。指标记录缓冲到期次数。
3. **切流时 hello 风暴** → 并发闸门、`retryAfterMs` 随机化；e2e 中的 300 socket 场景；与 B-711 分开观测（`sync_hello_queue_wait`）。
4. **缓存让旧数据「看起来是新的」** → 有缓存时进入 `syncing` 而不是 `live`，「同步中」条照常显示，live 只能由 head 证明（G2）。
5. **outbox 自动重发执行了过时的指令** → 10 分钟规则；超过的记录交给用户决定（§16 取舍 2）。
6. **共享电脑上残留聊天缓存** → 退出登录时删库；r2 起不缓存 DEK，IDB 中只有密文（§5.4）。
7. **iOS 非 PWA 7 天未访问后 IDB 被清除** → 只影响速度；outbox 的保证写明「尽力而为」。
8. **emit 丢失后最多 120s 才被发现**（§4.2）→ 接受，因为今天是「直到下一条消息」；Owner 可以选更短的间隔（§16 取舍 5）。

## 13. 验收标准

- [ ] §9.1 server 测试 1–10（含 2a 与 r2 对 5、6 的补充）全绿，原子性属性测试 200 轮不失败；mutation-check 通过。
- [ ] §9.2 Web 单测 1–11（含 r2 对 5、6 的补充）全绿；源码断言经 mutation-check 验证。
- [ ] §9.3 e2e 每行断言达标，PR 正文附改前改后数字（B3/B6 追平时间、首屏时间、hello 风暴等待时间）。
- [ ] §6.2 兼容矩阵每行都有对应测试或 e2e，PR 正文逐行勾选。
- [ ] 阶段门槛（§8）逐个满足后才进入下一阶段。
- [ ] 指标面板上线；`docs/monitoring` 已更新。
- [x] spec 入库为 `specs/2026-10-session-sync-subscribe-and-cache.md`；同次 PR 修正 `specs/2026-08-zero-downtime-release.md:105` 中过期的 recovery 描述（DESIGN-REVIEW §9）。

## 14. 留真机验证项

见 §9.4。shipped 后转入 `docs/verify-queue.md`。

---

## 15. 修订记录

| 版本 | 日期（SGT） | 修订人 | 内容 |
|---|---|---|---|
| r0 | 2026-10-25 | spec 作者 | 初稿；Owner 10-25 批准，6 项取舍按推荐 |
| r1 | 2026-10-25 | spec 作者（B-811 开工时提出，已采纳） | **seq 空洞**：上游 `86af26d4` 在事务外分配 seq，留下 `Session.seq > max(SessionMessage.seq)` 和中间缺号的永久空洞；原 §4.2「`hasMore=false ⇒ max(messages.seq)==head`，否则 unavailable」与原 G2「`headSeq==lastSeq` 才 live」会让这类会话永远进不了 live 并循环重试。决定：server 原样返回 `Session.seq`，不修补；Web 在 `hasMore=false` 时 `lastSeq := max(lastSeq, headSeq)`；唯一的 head 不一致判定是 `headSeq < 请求 afterSeq`（§6.2 第 10 行）。同时明确用**请求时的 afterSeq** 而不是 ack 到达时的 lastSeq 比较，避免「推送先于 ack 到达」被误判。改动：§1.2 G2/G2a；§3.3 字段注释；§4.2 证明与不一致判定，新增 §4.2.1；§5.1 规则 3（点状 vs 范围来源）、规则 5、`meta` 增加 `afterSeq`/`hasMore`；§5.2 两行；§5.3 状态机两行；§5.4 连续段定义、读取方式、按行数裁剪；§5.4.2 段校验改为越界判定；§6.2 第 10 行改写、新增第 11 行；§9.1-2 改写、新增 2a；§9.2 新增 9–11；§9.3 新增「seq 空洞老会话」e2e；§13 测试编号。**对实现的影响**：B-811（5a）只需保证 head 原样返回和 §9.1-2a；B-813（6a）需按新的 §5.4、§5.4.2 实现读取、裁剪和段校验 |
| r2 | 2026-10-25 | spec 作者（#754 review 建议 S2/S3/S5/S6/S8，以及 B-813 实现时的决定；已采纳） | **只改文档，不改协议和 head 判定**。来自 #754 review：S2 `subs` schema 硬上限 64，超过整体回 `invalid_request`（§3.2、§4.4）；S3 未知错误码一律折算为 `unavailable`（§3.4）；S5 体积预算耗尽时可能回「空页且 `hasMore=true`」，继续拉取沿用请求的 afterSeq（§3.3 注释、§4.4）；S6 快照 deadline 1.5s，槽位等语句结束才释放（§4.4）；S8 Grafana Sync 面板记为阶段 1 后续项（§4.7）。来自 B-813：(1) 6a 走 legacy REST，拿不到 head，`CacheHit` 额外带 `lastRowSeq/lastId`，用 `after_seq=lastRowSeq-1` 做锚点校验，缺行判 `behind`、id 不同判 `mismatch`，两者都删缓存 cold 重拉（§5.4、§5.4.2）；(2) 段落落盘时同事务写 rowCount（`sessions.count`），读取时实际行数 ≠ rowCount 判本地损坏、改走网络，以此区分历史空洞和本地丢行（§5.4、§5.4.2）；(3) **不缓存 DEK**，推翻 r0 的「推荐缓存」：安全上 IDB 只留密文，且实测冷启动瓶颈在应用启动和渲染，缓存 DEK 只省约 1 个 RTT（§5.4 schema 去掉 `dek`，§7 新增否决行，§0 第 3 条、§10.2、§12-6 同步）。测试：§9.1-5、§9.1-6、§9.2-5、§9.2-6 补充对应用例，§13 同步 |
| r3 | 2026-10-25 | spec 作者（#756 review 建议 S7；已采纳） | **只改文档**。§9.3「离线刷新」的预期从「缓存照常显示」改为「显示 B-799 离线条，不报错；缓存在网络恢复、会话列表返回后才显示」。原写法与 r2「不缓存 DEK」冲突：离线时 `/v2/sessions` 拿不到，DEK 不可用，缓存无法解密；6a 实现中 `fetchMessages` 离线直接返回（`W/sync/sync.ts`）。离线可读缓存需要缓存 DEK，已在 r2 §7 否决，不在本 spec 范围 |
| 入库 | 2026-10-25 | spec 作者 | 正文与 r3 相同；去掉本机路径与内部称呼，补 §16 Owner 决定，状态改为实施中。同 PR 在 [web-resume-sync](2026-08-web-resume-sync.md) 与 [zero-downtime-release](2026-08-zero-downtime-release.md) 加交叉引用，并改正后者「现状事实」里过期的 recovery 描述 |

## 16. Owner 决定（2026-10-25，6 项均按推荐）

| # | 取舍 | 决定 | 落点 |
|---|---|---|---|
| 1 | 本机是否保存聊天记录 | 保存最近看过的 30 个会话、每会话最近 300 条，退出登录全部清除（r2 起只存密文、不缓存 DEK，离线不可读） | §5.4、§5.4.1 |
| 2 | 刷新/关页后未发出的消息是否自动补发 | 10 分钟内自动补发（localId 幂等）；更早的显示「未发送 · 重发 / 丢弃」 | §5.5.3 |
| 3 | 离开很久（> 500 条新消息） | 直接显示最新页，向上翻页加载更早内容 | §4.3 |
| 4 | 上线方式 | 先只对 Owner 账号灰度 2–3 天，再全量；服务端开关可一键回到 legacy | §6.1、§8 |
| 5 | 推送丢失的最长发现时间 | 2 分钟：live 且可见时每 120s 一次空 subscribe | §4.2、§5.2 |
| 6 | 范围 | v1 精简版：沿用现有推送，新增对账订阅与本机持久化；专属订阅房间延后为 v2 | §3.5、§7 |
