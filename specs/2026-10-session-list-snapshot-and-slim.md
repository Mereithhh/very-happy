# 会话列表快照、离线翻看与列表瘦身（B-824 / B-826）

> 状态：Draft（待 review；实现等本 spec 合入后再派）
> 日期：2026-10-26 ｜ 关联 backlog：B-824（Part A）、B-826（Part B，只出设计，排进下一轮）；前置/相关 B-807、B-813（6a）、B-814（6b）、B-812（5b）、B-816、B-818、B-823（Q4 预取）、B-825（401 清主密钥）、B-490、B-619
> 关系：**推翻** [会话消息同步 v1](2026-10-session-sync-subscribe-and-cache.md)（下称 SYNC）r2「不缓存 DEK」和 r3「离线不可读」。依据是 Owner 2026-10-26 的决定：B-816 的中档方案（会话列表快照 + wrapped DEK + 离线翻看）和大改档里的「metadata 瘦身」都要做，安全缓解按推荐执行。SYNC 的其余内容（订阅协议、消息缓存、outbox）不变。
> 出处：B-816 调研报告（下称 REPORT）§1.3、§2、§3 中档与 L1；报告在会话临时目录，不进 repo
> 基线：`origin/main@6002e264`。路径缩写同 SYNC：`W`=`packages/happy-web-v2/src`，`S`=`packages/happy-server/sources`，`C`=`packages/happy-cli/src`。时间一律 SGT。

---

## 0. 一页结论

1. **Part A（B-824）**：把 `/v1/sessions` 的**原样行**（metadata / agentState 密文、wrapped DEK、seq、updatedAt 等）存进本机 IndexedDB 的独立库 `vh-sync-list-<accountHash>`。冷启动时先用本机快照把侧栏和会话页画出来，再用新的增量接口 `GET /v3/sessions/list?since=` 对账。效果：
   - 回访 composer 可交互：phone 约 2.5s → **约 1.8–2.0s**，桌面约 0.7s → **约 0.5s**；大账号（列表约 1.8MB）正常网络 phone 3.2s → 约 2.0s、桌面 1.5s → 约 0.5s，slow 4G 从「修完 B-818 后约 10s」→ 约 2.0s（REPORT §3 中档，按阶段拆分推算，PR 正文须附实测）。
   - 离线：断网刷新也能浏览会话列表，最近看过的 30 个会话能翻看缓存消息，发出的消息进入 6b outbox，恢复网络后发出。
2. **wrapped DEK 原样存，不另包一层不可导出的 WebCrypto key**。理由：同一个浏览器 profile 里 localStorage 已经有明文主密钥（`W/auth/tokenStorage.ts:15,30`），能读到 IDB 的攻击者也能读到它；不可导出 key 的材料同样落在 profile 目录里，挡不住拷盘，XSS 也能直接调用 `decrypt`（REPORT §2.3）。真正有效的是下面三条缓解。
3. **三条安全缓解（Owner 批准）**：
   - 退出登录：快照库与其他 `vh-sync-*` 一起删；删除被其他标签页挡住时记「待删」，下次启动先删、删完前不读（§6.1）。
   - 收到 401 或「已下线」（登录被吊销，socket 握手报 `Invalid authentication token`）：确认一次后立即清空所有 `vh-sync-*` 库，**并删除 `auth_credentials`**，修掉今天 401 不清主密钥的问题，与 B-825 共用一个 `purgeLocalAccountData` 入口（§6.2）。
   - 超过 30 天没有成功对账：整个快照与消息缓存作废删除（§6.3）。
4. **一致性**：快照只用来先画出来，不当事实。增量响应带当前列表窗口的成员摘要 `members: [id, updatedAt][]`，客户端合并后逐条比对；摘要能发现漏拉、删除、移出窗口和撤销共享，所以正确性不依赖时间游标，游标只省流量（§4）。归档、删除、撤销共享都在下一次对账收敛；撤销共享时连同该会话的 DEK、消息缓存和 outbox 一起删。
5. **Part B（B-826）**：列表请求加 `view=list`，服务端解开 metadata，去掉 `tools / slashCommands / skills / mcpServers / models / operatingModes / thoughtLevels` 和 agentState 的 `completedRequests`，用同一个 DEK 重新加密后下发（Very Happy 是服务端可信存储，B-619 已有同类路径）。打开会话或写 metadata 前，Web 用现有 `GET /v1/sessions/:id` 取完整版。**旧 CLI 不用改，旧 Web 不受影响**（不带 `view=list` 就拿完整行），不需要 DB 迁移。目标是把列表从约 1.8MB 降到约 0.2MB（估算，阶段 0 先用指标实测）。
6. **工作量**：Part A 约 5–7 个 agent 工作日（server 增量接口 1、Web 快照与启动路径 2、对账与离线 1–1.5、安全清理 1–1.5、e2e 与 QA 0.5–1）；Part B 约 3.5–5 个 agent 工作日。全程不发 CLI。

---

## 1. 背景、目标、非目标

### 1.1 背景

| # | 问题 | 证据 |
|---|---|---|
| P1 | 回访一定要等 `/v1/sessions` 返回、解出 DEK 才能画会话页和消息缓存：phone 回访 composer 2.5s 里，列表网络约 330ms（slow 4G）加上之后的解密渲染都在关键路径上 | REPORT §1.4；SYNC §5.4「不缓存 DEK」 |
| P2 | 离线刷新永远停在「正在加载消息…」：DEK 只在内存，离线拿不到列表就解不开 IDB 里的消息 | REPORT §0-5 截图；SYNC r3；`W/sync/sync.ts:2951-2958` 离线直接返回 |
| P3 | 大账号列表约 1.8MB（最新 150 个会话 metadata 合计 1.77MB），每次冷启动和 socket 首连都完整下载 | REPORT §1.3；`W/sync/sync.ts:549-555`（B-818 保留第二遍完整拉取，增量留给 Q4） |
| P4 | 401 只触发进程内 latch，不删 `auth_credentials`，也不删 IDB；主密钥一直留在 localStorage，直到用户手动退出 | `W/auth/authLatch.ts:11-17,52-59`；`W/auth/AuthContext.tsx:52-91` 只有 logout 删 |
| P5 | 退出登录时删库被其他标签页挡住会静默失败，库被保留 | `W/sync/cache/syncCache.ts:872-877` |

### 1.2 目标（可验证）

- A-G1：有快照时，回访 composer 可交互不等网络。phone（CPU ×4）约 1.8–2.0s，桌面约 0.5s；大账号在 slow 4G 下约 2.0s（§10，e2e 计时）。
- A-G2：离线刷新：列表可浏览；快照里有消息缓存的会话（≤30 个）能翻看；发送进入 outbox，恢复后按 SYNC §5.5 发出。
- A-G3：快照永远不会让过期状态「看起来是新的」：对账完成前显示「同步中」或离线条；对账后与服务端一致（成员摘要逐条相等）。
- A-G4：三条安全缓解都有自动化测试，401 后本机不再留有主密钥和任何 `vh-sync-*` 库（§6）。
- A-G5：旧 server、旧 Web、回滚的任意组合都不丢数据、不卡死（§7 矩阵）。
- B-G1：大账号列表响应 ≤ 约 250KB（未压缩，目标约 0.2MB），会话页功能不缺（slash 命令、模型选择、权限历史打开会话后完整可用）。
- B-G2：任何客户端都不会把瘦身版 metadata 写回服务端（Web 写入守卫 + 服务端拒绝）。

### 1.3 非目标

- 不改主密钥的存放方式（迁出 localStorage、WebAuthn PRF 绑定设备属于 REPORT L3，另立项）。
- 不做 CSP、`BrowserPreview` iframe 沙箱收紧（REPORT §2.3-5 建议单独立项，本 spec 只记录）。
- 不改 `update-session` / `new-session` 实时推送的字段，推送仍是完整 metadata。
- 不改 CLI。Part B 里「CLI 不再写大数组」「completedRequests 封顶」是可选的后续项（§12.4），不在验收范围。
- 不缓存解密后的明文 metadata，不缓存 raw DEK。

---

## 2. 现状事实（代码已确认，`6002e264`）

| 事实 | 位置 |
|---|---|
| `/v1/sessions`：本账号按 `updatedAt desc` 取 150 行，加上窗口外全部未归档的行（≤500，10-27 侧栏变少修复，`S/app/session/sessionListRows.ts`），再加共享给本账号的行；投影含 `id, seq, createdAt, updatedAt, active, activeAt, archivedAt, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey(base64)`，共享行另有 `share` 且 metadata 已脱敏重加密 | `S/app/api/routes/sessionRoutes.ts:19-60,81-108` |
| `/v1/sessions/:id`：与列表同一投影，grantee 走 grant | `sessionRoutes.ts:110-128` |
| `/v2/sessions?changedSince=`：按 `id desc` 分页（≤200），只按 `updatedAt > changedSince` 过滤；**不含 `archivedAt`、不含共享行、看不到删除** | `sessionRoutes.ts:182-273` |
| `Session.updatedAt` 是 Prisma `@updatedAt`：seq 分配（每条消息）、metadata/agentState 写入、归档/反归档、活跃度更新都走 Prisma `update/updateMany`，都会刷新它；唯一的 raw `UPDATE "Session"` 只写 `lastHappyClient` | `packages/happy-server/prisma/schema.prisma:246-264`；`S/storage/seq.ts:36-40`；`sessionRoutes.ts:429,477,502`；`S/app/presence/sessionCache.ts:218`；`S/app/api/socket/clientVersion.ts:56` |
| 撤销共享只改 `SessionGrant`，不碰 `Session` 行，所以 `updatedAt` 不变 | `S/app/session/sessionShares.ts` |
| Web 拉列表：`fetchSessions` 走 `hedgedRead` + `fetchWithDeadline`，`decodeSessionRows` 解 DEK 与 metadata，`applySessions` 写 store；首个列表落地即 `applyReady` | `W/sync/sync.ts:1900-1961,555-585` |
| wrapped DEK 格式：`0x00‖ephPub‖nonce‖crypto_box(dek)`，收件人是账号 content 公钥；客户端用由主密钥派生的 content 私钥解开 | `W/sync/sessionDecode.ts:44-67`；`W/sync/encryption/encryption.ts:197-217`；`S/app/session/sessionCrypto.ts:21,61-68` |
| 主密钥与 token 同存 `localStorage['auth_credentials']`，base64url 明文 | `W/auth/tokenStorage.ts:4,13-16,27-30` |
| 401 latch：当前 token 的第一个 401 触发，停同步、断 socket、弹重登；**不删凭据、不删 IDB** | `W/auth/authLatch.ts:52-59,140-152` |
| socket 握手 token 无效时 server 回 `connect_error: Invalid authentication token`；Web 只记 `error` 状态，**不触发 latch** | `S/app/api/socket.ts:256-260`；`W/sync/apiSocket.ts:926-935` |
| 退出登录：`clearSyncCacheOnLogout` 按前缀 `vh-sync-` 加 registry 删库；被挡住时吞掉错误 | `W/auth/AuthContext.tsx:52-91`；`W/sync/cache/syncCache.ts:860-880` |
| 消息缓存库 `DB_VERSION = 1`；打开遇到 `VersionError`（更新的 build 建的库）会**删库重建**；对端标签页 `onversionchange` 时关闭连接 | `W/sync/cache/syncCache.ts:31-32,494-503,789-792`；`W/sync/cache/idb.ts:94` |
| outbox 接管在首个列表落地之后跑，每 15s 一轮；会话不在 store 时先 `fetchSessionById`，只有 404 才删 | `W/sync/sync.ts:577-597`；SYNC §5.5.3 |
| metadata 里与侧栏无关的大数组：`models, operatingModes, thoughtLevels, tools, slashCommands, mcpServers, skills`；只在会话页（composer、模型选择、权限）读取 | `W/sync/storageTypes.ts:9-48`；读取方：`W/screens/session/AgentInput.tsx`、`W/sync/suggestionCommands.ts`、`W/sync/piModelOptions.ts`、`W/sync/messageMeta.ts`、`W/components/modelModeOptions.ts`、`W/app/modelSupportPolicy.ts` |
| agentState 的 `completedRequests` 由 CLI 只增不删（每次审批带完整工具参数），没有上限 | `C/utils/BasePermissionHandler.ts:112,171-185,221`；`W/sync/storageTypes.ts:219-223` |
| Web 写 metadata 是「以 store 里的 metadata 为底稿整份重写」，版本冲突时以服务端回包为底稿重放 | `W/sync/ops.ts:1517-1590` `sessionApplyMetadata` |
| 服务端能解开 metadata：B-619 用账号主密钥解 DEK、解密 metadata、脱敏后重加密给 grantee | `S/app/session/sessionCrypto.ts:1-24`；`sessionShares.ts:135-160,339-360` |

---

# Part A：会话列表快照与离线翻看（B-824）

## 3. 存储：`vh-sync-list-<accountHash>`

### 3.1 为什么是独立库，而不是给消息缓存库加 store

任务书写的是「vh-sync-* 新增 sessionList store」。本 spec 放进同一前缀下的**独立库**，名字仍以 `vh-sync-` 开头，退出登录、401 清理按前缀一并删除。不往现有库加 store 的原因：

1. 加 store 必须升 `DB_VERSION` 1→2。发布窗口里被 SW 缓存的旧标签页打开 v2 库会得到 `VersionError`，按现有逻辑**删库重建**（`syncCache.ts:494-503`），连同 6b 的 outbox 一起删掉，用户未发出的消息就丢了。
2. 升级还会被持有旧连接的标签页挡住（`IdbBlockedError`，SYNC §5.5.7 已因此避免升库）。
3. 隔离故障：消息缓存被判卡死（SYNC §5.4.2 r8）时不应连带列表快照，反之亦然。

### 3.2 schema（库版本 1）

| store | key | value |
|---|---|---|
| `meta` | `'meta'` | `{ schema: 1, accountHash, createdAt, lastReconciledAt, cursor, appBuild }` |
| `rows` | `id` | 服务端原样行：`{ id, seq, createdAt, updatedAt, active, activeAt, archivedAt, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, share?, metadataView?, agentStateView?, storedAt }` |

- `rows` 的值与 `/v1/sessions` 行**逐字段相同**（密文、base64 DEK 原样），只多 `storedAt` 和 Part B 的两个 view 标记。不存解密后的 metadata，不存 raw DEK，不存 `lastMessage`（恒为 null）。
- `accountHash` 与消息缓存同一算法（`sha256(accountId)` 前 16 位）。打开时 `meta.accountHash` 不等于当前账号就删库。
- `lastReconciledAt`：最近一次**成功对账**（§4.3 成员摘要全部一致）的本机时间，用于 30 天作废（§6.3）。
- `cursor`：最近一次对账响应给的游标（§4.1），同时镜像到 `localStorage['vh.sync.listCursor.<accountHash>']`，让 B-823 Q4 的预取在 IDB 打开前就能带上（§5.1）。游标只是时间戳，不敏感；清理时一起删。
- 容量：`rows` 只镜像当前列表窗口（本账号 ≤150 + 窗口外未归档 ≤500 + 共享行），上限 800 行，超过时按 `updatedAt` 从旧到新删。大账号约 1.8MB（Part B 后约 0.2MB），不计入消息缓存的 40MB。
- 写入：对账结果合并后，在一个 readwrite 事务里批量 put/delete，并在同一事务更新 `meta`。写入 2s 超时只跳过这一次（下次对账重写），连续 3 次才本页禁用快照写，规则同 SYNC §5.4.2 r8。

### 3.3 wrapped DEK 的存法与理由

- **存法**：`dataEncryptionKey` 原样存（服务端给的 base64 wrapped DEK），解开它需要由主密钥派生的 content 私钥，私钥只在内存。
- **不另包一层不可导出的 WebCrypto key**。REPORT §2.3 的结论成立，逐条：
  1. 同 profile 里 `auth_credentials` 已有明文主密钥，能读 IDB 的攻击者（本源 XSS，或拿到整个 profile 目录的人）也能读到它，进而解开任何 wrapped DEK；
  2. 不可导出的 CryptoKey 存进 IDB 时，密钥材料被序列化在 profile 目录里，没有操作系统级保护，拷盘时一起被拷走；
  3. XSS 不需要导出密钥，直接调用 `crypto.subtle.decrypt` 就能用；
  4. 这层包装唯一能挡的是「XSS 把 key 带走离线用」，而 XSS 本来就能直接读走明文主密钥。

  所以这层包装只增加实现和故障面（key 丢失、跨标签页同步），不降低风险。只有主密钥本身也迁到不可导出 key 或 WebAuthn PRF 时，它才有意义，那是 REPORT L3，另立项。
- **不存 raw DEK**：在同一 profile 里 raw 和 wrapped 等价（主密钥就在旁边），存 wrapped 不新增明文密钥材料落盘，也符合「IDB 只存服务端原样数据」的现有原则（`syncCache.ts` `toStoredRow`）。
- **legacy 会话**（`dataEncryptionKey = null`，内容直接用主密钥派生的密钥加密）：今天就能凭主密钥离线解密，行为不变。
- **唯一新增的风险**（REPORT §2.3 表第 3 行）：设备 profile 被整份拷走，而 token 已过期或被吊销、用户没有在这台设备上退出时，快照里的列表（≤150 个会话的路径、标题、摘要）和 ≤30 个会话 × ≤300 条消息可以完全离线解密。今天这些内容不在盘上（metadata）或解不开（消息缺 DEK）。§6 的三条缓解压缩这个窗口：设备联网一次收到 401 就清空；30 天没对账就作废；正常退出时删干净。

---

## 4. 增量接口与对账（server + Web）

### 4.1 `GET /v3/sessions/list`（新）

```ts
// query
{ since?: string;          // 上次响应的 cursor；缺省 = 全量
  view?: 'list' }           // Part B（B-826）；本阶段 server 忽略

// 200
{ v: 1,
  full: boolean,            // true：sessions 就是完整窗口（since 缺省、无法识别或过期时）
  sessions: SessionRow[],   // 与 /v1/sessions 行同一投影（含 archivedAt、share）；full=false 时只含变化的行
  members?: Array<[id: string, updatedAt: number]>,  // full=false 时必带：当前窗口的全部成员
  cursor: string }          // 下次的 since
```

- **窗口定义与 `/v1/sessions` 完全相同**：本账号按 `updatedAt desc` 取 150 行，加上窗口外全部未归档的行（≤500，`sessionListRows`），再加共享给本账号的行。未归档集合必须完整：只取 150 行时，大账号的活会话会被挤出窗口，每次新页面加载都先少后多（10-27 Owner 反馈）。所以快照、增量与旧接口对同一时刻给出同一集合。
- **`full=false` 的变化行**：`members` 里 `updatedAt > since − 5s` 的行（5s 重叠窗口，吸收「`updatedAt` 由应用时钟写入、提交稍晚」造成的乱序）。实现：先查一次窗口的 `id, updatedAt`（只取两列，走 `accountId + updatedAt`；索引是否存在由实现者核对，缺失时补索引属于 server 迁移，单独评审），再只对变化的 id 取完整投影；共享行只对变化的行做脱敏重加密（`redactedMetadataFor` 要解密，是共享行的主要开销）。
- **`cursor`**：`String(max(members.updatedAt))`，不透明，客户端只回传不解析。`since` 不是数字、或比当前时间新超过 1 天，服务端回 `full=true`。
- **为什么不复用 `/v2/sessions?changedSince`**：它按 id 分页、上限 200、没有 `archivedAt` 和共享行、看不到删除和撤销（§2），既不能替代 `/v1/sessions`，也无法证明快照完整。
- **体积**：`members` 每项约 40B，150+ 项约 6KB（br 后约 3KB）。没有变化时整个响应约 3–6KB，对比全量 23KB（小账号）到 1.8MB（大账号）。
- **压缩**：沿用 B-818 的 `responseCompression.ts`。
- **鉴权**：`app.authenticate`，401 走 §6.2。

### 4.2 客户端合并

对账结果走与今天 `fetchSessions` 相同的路径：`decodeSessionRows` → `preserveSessionBatchActivityFromStore` → `applySessions`，另加两条规则：

1. **版本不回退**：同一会话，`metadataVersion`、`agentStateVersion`、`seq` 各自取较大者对应的值，不能被更旧的行覆盖。实时推送可能先于对账响应到达，对账行不能把推送已经更新的字段改旧。（实现者先核对 `applySessions` 现状是否已经保证；没有就在合并纯函数里补上，并写表驱动测试。）
2. **成员收敛**：`full=true` 时，`rows` 里不在本次 `sessions` 中的行删除；`full=false` 时，不在 `members` 里的行删除。被删的行：
   - 带 `share` 的（撤销共享或会话被删）：同一事务删除该行（含 wrapped DEK），并调用消息缓存的「按会话删除」，删掉它的消息缓存和 outbox 行（访问权已失去，留着没有意义）。内存 store 同时移除该会话。
   - 本账号的：只从快照删除（可能只是归档后掉出 150 窗口，也可能被删除；未归档的行不会掉出窗口）。内存 store 维持今天的行为（今天全量拉取也不移除 store 里的旧会话）。消息缓存不立即删，由 LRU 淘汰；用户打开它时，SYNC §5.4.2 的 `not_found` 路径会删。这与 SYNC「不在列表里 ≠ 已删除」一致。

### 4.3 成员摘要校验（正确性的来源）

合并后，对 `members` 里每一项比较本地行的 `updatedAt`：

- 全部相等：对账成功，写 `meta.lastReconciledAt = now`、`meta.cursor`，并镜像游标到 localStorage；该次加载的列表状态从 `snapshot` 变为 `reconciled`。
- 有不相等或本地缺行的（漏拉：乱序提交超过 5s 重叠窗口、两次请求之间的并发写）：缺口 ≤10 个时逐个 `GET /v1/sessions/:id` 补齐后再校验一次；超过 10 个或补齐后仍不一致，退回一次 `full` 请求。`full` 之后不再循环。
- 摘要本身来自同一个请求，所以「有变化却没下发」一定会被发现。时间游标出错（时钟回拨、乱序提交）只会多拉，不会漏。

### 4.4 触发时机

| 时机 | 请求 |
|---|---|
| 冷启动 | 有快照（且游标与快照 `meta.cursor` 一致）：`since=cursor`；没有：全量。由 B-823 Q4 在 `main.tsx` 预取（§5.1） |
| socket 首次连上（`recovered=false`） | `since=cursor`。替代 B-818 保留的「第二遍完整拉取」（`sync.ts:549-555`），覆盖首个请求与 socket 订阅之间的窗口 |
| 重连、回前台（`sync.onWebResume`，铁律 13） | `since=cursor`，沿用 `sessionsSync` 的合并排队 |
| 其他调用 `sessionsSync.invalidate()` 的地方 | 同上，统一走增量；`fetchSessions` 内部决定 `since` 还是全量 |
| 旧 server（`/v3/sessions/list` 返回 404） | 本页加载内退回 `/v1/sessions` 全量，行为与今天相同；快照照常写（全量结果即完整窗口） |

---

## 5. Web 启动路径与离线翻看

### 5.1 冷启动顺序（有快照）

```
main.tsx           ─ 读凭据 → 预取 /v3/sessions/list?since=<localStorage 游标>（B-823 Q4，结果 promise 只用一次）
syncRestore        ─ Encryption.create（派生 content 私钥，约 70ms@phone）
  ├─ 并行：打开 vh-sync-list 库 → 30 天检查（§6.3）→ 读 rows → decodeSessionRows → applySessions(source='snapshot') → applyReady
  └─ 并行：消息缓存预读（SYNC §5.4 r8），DEK 已从快照就绪，不再等列表网络
预取结果到达        ─ 合并（§4.2）→ 成员校验（§4.3）→ 写快照
```

- **与 B-823 Q4 对齐**：预取与 `fetchSessions` 共用一个请求构造函数 `buildSessionListRequest(cursor | null)`。Q4 先合入时预取的是 `/v1/sessions` 全量；B-824 只改这个函数（有游标且 server 支持时走 `/v3?since`）。预取 promise 被 `fetchSessions` 消费一次后作废，401 照常触发 latch（§6.2）。
- **游标与快照不一致**（IDB 被系统清掉而 localStorage 还在、或反过来）：增量响应补不出完整窗口，丢弃它，改发一次全量。判定：快照 `meta.cursor !== 预取用的游标`，或快照库打不开。
- **谁先到**：快照先到就先画；网络先到（快照库还在打开，SYNC r8 记录过高负载机器上 IDB open 要 500–700ms）就直接用网络结果，库打开后只写不读。快照只能让首屏更快，不能因为等库变慢。
- **列表状态**：store 增加 `sessionListSource: 'snapshot' | 'reconciled'`。`snapshot` 期间：
  - 顶栏沿用 PR-2 的「同步中」细条（>300ms 才显示），离线时交给 B-799 离线条；
  - 快照行的 `active`、`activeAt`、agentState 都是旧值：在线点和「需要你」角标照常按快照显示，但 thinking、running 等实时状态只由推送推导（同 SYNC §5.1 规则 6），快照不触发副作用；
  - 快照行的 `seq` **不能当服务端 head 用**：任何拿 `session.seq` 与本地 lastSeq 比较的逻辑（未读、PR-3 的 stale 标记）在 `reconciled` 之前跳过快照行。实现者用 `git grep` 找出全部比较点并列在 PR 里。

### 5.2 离线翻看

- **列表**：离线冷启动走 §5.1 的快照分支，`applyReady` 不等网络。快照为空（首次登录、已作废）时行为与今天相同。
- **消息**：`fetchMessages` 离线时不再直接返回（`sync.ts:2951-2958`）。有消息缓存就按 SYNC §5.4 渲染缓存（source=`cache`），phase 进入 `stale(offline)`，不发锚点探针和网络请求；没有缓存的会话显示「离线 · 这个会话的内容没有缓存在本机」，不显示 loading 转圈。
- **能翻看的范围**：SYNC §5.4.1 的消息缓存上限：最近看过的 30 个会话，每个最近 300 条。不扩大。
- **发送**：composer 照常可用，消息进入 6b outbox（`queued` 落盘），气泡显示「离线 · 连接恢复后发送」（沿用 B-799 / B-722 文案与状态）。恢复网络后按 SYNC §5.5 发出，localId 幂等。agent 忙时走 SYNC §5.5.7 的 `kind:'queue'`。
- **刷新后**：outbox 行解密需要 DEK，现在离线也能从快照拿到，所以离线刷新后未发出的气泡也能显示。接管里需要网络的步骤（「先拉最新页」、`fetchSessionById`）离线时推迟到恢复在线，行保持被本 tab 占有（`outboxDeferred`）。10 分钟规则照旧从 `createdAt` 算：离线超过 10 分钟的行恢复后显示「未发送 · 重发 / 丢弃」，不自动发。
- **离线时的 metadata 写**（重命名、标记完成等）：今天走 socket，离线时本来就失败并提示；不变，不做离线写队列。

### 5.3 与 6a / 6b / 5b 的交互

| 模块 | 交互 | 规则 |
|---|---|---|
| 6a 消息缓存（SYNC §5.4） | DEK 从快照提前就绪，缓存渲染不再等列表网络；r8「DEK 到达时缓存还没读完就走网络最新页」仍成立 | 锚点探针照旧在线才发；快照不改变消息缓存的任何一致性规则。撤销共享时由快照合并调用消息缓存「按会话删除」（§4.2） |
| 6a 损坏恢复 | 快照库与消息库各自独立恢复：快照库打不开/schema 不符就删库重建或本页无快照，消息库照常 | 快照解码失败的单行跳过（`decodeSessionRows` 已是「一行坏不影响整批」），并从快照删除该行 |
| 6b outbox（SYNC §5.5） | 接管的前提「会话已在 store、密钥可用」现在可由快照满足 | 接管照常在首个列表（快照或网络）落地后开始；需要网络的步骤离线推迟（§5.2）；「不在快照里」不等于已删除，仍以 `fetchSessionById` 404 为准 |
| 6b 清理 | 401 / 退出 / 30 天作废会删 outbox | 这是安全缓解的代价，见 §6.4 |
| 5b 订阅（SYNC §5.1–5.3） | 打开会话时 subscribe 的 `afterSeq` 仍取消息缓存的 lastSeq，与快照无关；hello 只在 socket 连上后发 | 快照行的 `seq` 不进入合并入口，也不作为 head 证明（G2 只认 ack 的 headSeq）；快照期间打开的会话 phase 走 SYNC §5.3 的 `syncing`（有缓存）或 `loading` |
| 5b legacy / REST 兜底 | 不变 | — |

### 5.4 多标签页

- 每个标签页各自读快照、各自对账；`rows` 的 put 幂等（同 id 同内容），版本不回退规则在写入前比较 `metadataVersion/agentStateVersion/seq`，避免旧标签页把新行覆盖回旧值。
- **退出或清理后的残留写**：另一个标签页退出登录或清空之后，本标签页内存里还有 DEK，可能把快照库重新建出来。规则：每次快照写入前读一次 `localStorage['auth_credentials']`，token 不存在或与本标签页不同就放弃写入、关闭快照库连接。同时监听 `storage` 事件，`auth_credentials` 被删时本标签页停同步并跳登录页（`markProgrammaticReload` 后 reload）。

---

## 6. 安全缓解（Owner 批准的三条，加两条配套）

### 6.1 退出登录：一起删，删不掉就记「待删」

- `logout` 已有的 `clearSyncCacheOnLogout` 按 `vh-sync-` 前缀删，快照库自然在内。
- **删除被挡住**（另一个冻结的标签页持有连接，`OPEN_BLOCKED_MS` 内没删成）不再静默：把库名写进 `localStorage['vh.sync.purgePending']`。启动时在打开任何 `vh-sync-*` 库**之前**先处理待删列表；没删成就本页不读快照和消息缓存（无缓存运行），下次再试。
- 理由：今天删不掉影响不大（「登出已经删了凭据」，`syncCache.ts:876` 注释），但快照库里有 wrapped DEK，只要主密钥再次出现（同账号重新登录），残留库就能被解开；所以必须保证最终删除。

### 6.2 401 或「已下线」：确认后立即清空，并删除主密钥（与 B-825 对齐）

- **触发**：
  1. 现有 latch：当前 token 的 REST/axios 请求收到 401（`authLatch.ts:140-152,170-180`）。
  2. 新增：socket 握手 `connect_error` 的 message 为 `Invalid authentication token`，且握手用的就是当前 token。今天这条只记 `error` 状态（`apiSocket.ts:926-935`），改为同样 `tripAuthLatch({ status: 401, path: 'socket' })`。「已下线」指登录在别处被吊销或过期（`AccountLoginSession.revokedAt`/`expiresAt`，`S/app/auth/auth.ts:302-330`），表现就是这两种之一。
  3. 403 不触发（与 B-490 一致：403 可能只是「这个资源不允许」）。
- **确认一次再清**：latch 触发后，绕过 latch 守卫直接发一次 `GET /v1/account/profile`（带当前 token，5s 超时）：
  - 401 → 清空；
  - 200 → 不清（误判，记一条诊断日志和计数，latch 照旧要求刷新）；
  - 网络错误或超时 → 保持 latch，等下一次在线边沿再确认。
  确认是为了防止服务端故障（例如蓝绿切换时 `HANDY_MASTER_SECRET` 配错）造成全体用户本机数据被清。
- **清空内容**（统一入口 `purgeLocalAccountData(reason)`，logout 的本地部分也改为调用它）：
  1. 关闭并删除所有 `vh-sync-*` 库（消息缓存、outbox、列表快照），被挡住时按 §6.1 记待删；
  2. 删除 `localStorage['vh.sync.listCursor.*']`；
  3. `clearPersistence()`、`clearNotificationStateOnLogout()`（与 logout 相同）；
  4. **删除 `auth_credentials`**，即 B-825 要修的「401 不清主密钥」；
  5. UI：沿用 `AuthExpiredNotice`，文案改为「登录已失效，已清除本机缓存，请重新登录」；用户确认后进入登录页。
- **与 B-825 的分工**：`purgeLocalAccountData` 是两者共用的唯一入口。哪个 PR 先合入就由它建这个函数；另一个只往里加自己负责的那一项（B-825：凭据；B-824：快照库与游标）。两者的测试都断言「401 确认后 `auth_credentials` 与全部 `vh-sync-*` 都不存在」。

### 6.3 超过 30 天没有对账：缓存作废

- 打开快照库时检查 `meta.lastReconciledAt`：`now − lastReconciledAt > 30 天`，或 `lastReconciledAt > now + 1 天`（时钟被回拨/篡改），就删除**所有** `vh-sync-*` 库（快照、消息缓存、outbox），本次按无缓存启动。凭据不删：token 若仍有效，接下来照常全量拉取；若已失效，会走 §6.2。
- 30 天对应 Web 登录 token 的默认有效期（`LOGIN_SESSION_TTL_DAYS` 默认 30，REPORT §2.1）：超过这个时间还没联网成功过一次，大概率 token 已失效，留着缓存只剩风险。
- 消息缓存的会话与快照同生同灭：消息库自己不记对账时间，快照库作废时一起删，避免「列表没了、消息和 outbox 还在」的半状态。没有快照库的老用户（6a 已上线、B-824 未上线时写的消息库）第一次运行 B-824 时，快照库新建，`lastReconciledAt` 从首次对账开始计。

### 6.4 代价（写进 OWNER-SUMMARY）

- 401 确认后、30 天作废时，**outbox 里未发出的消息一并删除**。它们是用失效账号的 DEK 加密的，重新登录后理论上还能发，但留着就等于在一个已失效的设备上保留可解密内容。Owner 批准的口径是「立即清空」，这里照做。
- 误判 401 的影响被「确认一次」限制在服务端真的连续拒绝当前 token 的情况。

### 6.5 不在本 spec 内、但建议单独立项

- 全站 CSP（今天 `index.html`、Fastify、Caddy 都没配，且有 inline `__HAPPY_CONFIG__`）；`BrowserPreview` iframe 同时有 `allow-scripts` 和 `allow-same-origin`。它们对 XSS 面的影响比「存不存 DEK」大（REPORT §2.3-5）。
- 主密钥迁出 localStorage（REPORT L3）。

---

## 7. 兼容与发布

### 7.1 开关

| 开关 | 位置 | 效果 |
|---|---|---|
| `vh.sync.cache=off` | Web localStorage（同 SYNC §6.1） | 同时关闭快照读写并删库；仍走 `/v3` 增量（没有快照时就是全量） |
| `vh.sync.listSnapshot=off` | Web localStorage | 只关快照，消息缓存照常；排查用 |
| `SESSION_LIST_V3_DISABLED=1` | server env | `/v3/sessions/list` 返回 404，Web 退回 `/v1/sessions`；改 env 重启槽即可 |

### 7.2 兼容矩阵

| # | 组合 | 行为 | 风险 |
|---|---|---|---|
| 1 | 新 Web + 新 server | 快照 + `/v3` 增量 | — |
| 2 | 新 Web + **旧 server**（切换窗口连到旧槽、或回滚） | `/v3` 404 → 本页退回 `/v1` 全量；快照照常读写（全量就是完整窗口） | 无；首屏仍先用快照 |
| 3 | **旧 Web**（SW 缓存的旧包）+ 新 server | 不调 `/v3`，不读写快照库，行为同今天 | 无 |
| 4 | 新旧标签页并存 | 旧标签页不认识 `vh-sync-list-*`，不会打开、升级或重建它；消息库版本不变，不触发 §3.1 的删库重建 | 旧标签页的 logout 仍按前缀删全部 `vh-sync-*`（含快照库）——这是期望行为 |
| 5 | 旧 CLI | 不涉及 | 无 |
| 6 | grantee | 共享行在窗口里，撤销后从 `members` 消失 → 删行、删 DEK、删消息缓存（§4.2） | `activeGranteeIds` 缓存期内仍可能收到推送（与今天相同） |
| 7 | 回滚到不支持快照的 Web | 快照库残留在盘上，旧 Web 不读；退出登录时按前缀删 | 残留库在下一次退出或 30 天后（新 Web 再次上线时）清理；需要立刻清的场景（设备丢失）靠服务端吊销 token，新 Web 上线后首次联网即 §6.2 |

### 7.3 发布顺序

server 与 Web 同镜像（铁律 5）。阶段：

1. server：`/v3/sessions/list`（暗发布，Web 不调），canary 对比 `/v1` 与 `/v3?since` 的窗口集合一致；
2. Web：`/v3` 增量 + 401/已下线清理 + 待删机制（不含快照），先全量上线——它们本身就修 P3/P4/P5；
3. Web：快照读写 + 离线翻看，`vh.sync.listSnapshot` 默认开；Owner 账号先用 2–3 天（Web 侧按账号 id 白名单灰度，常量随镜像发布），再全量。

---

## 8. 被否 / 延后的方案（Part A）

| 方案 | 结论 | 理由 |
|---|---|---|
| wrapped DEK 再包一层不可导出 WebCrypto key | 否 | §3.3 |
| 存 raw DEK 或解密后的 metadata | 否 | 新增明文密钥/内容落盘，换来的只是省一次 `crypto_box_open`（150 个约 50–150ms@phone，REPORT §3 估算），与 B-826 瘦身后更不值 |
| sessionList 放进消息缓存库（升 DB_VERSION） | 否 | §3.1：旧标签页 `VersionError` 会删库重建并丢 outbox |
| 复用 `/v2/sessions?changedSince` | 否 | §4.1 |
| 只用时间游标、不带成员摘要 | 否 | 看不到删除、撤销共享、移出窗口，乱序提交可能漏行，正确性无法证明 |
| 401 不确认直接清 | 否 | 服务端故障会让所有用户本机数据被清（含未发出的消息） |

---

## 9. 测试计划（Part A）

### 9.1 Server（vitest + 真 Postgres）

1. `/v3/sessions/list` 全量：与 `/v1/sessions` 同一时刻的结果逐行相等（含共享行、`archivedAt`）。
2. 增量：写入消息、改 metadata、归档/反归档后，`since=上次 cursor` 只返回变化行，`members` 等于当前窗口；无变化时 `sessions=[]`。
3. 重叠窗口：构造 `updatedAt` 比 cursor 早 3s 但晚提交的行 → 在本次 `sessions` 里；早 10s → 不在 `sessions`，但 `members` 里它的 `updatedAt` 与客户端旧值不同（供 Web 测试 §9.2-3 使用）。
4. 共享：撤销 grant 后，grantee 的下一次增量 `members` 不含该会话；删除会话后 owner 的 `members` 不含它。
5. `since` 非法 / 未来时间 → `full=true`；`SESSION_LIST_V3_DISABLED=1` → 404。
6. 增量请求只对变化的共享行调用 `redactedMetadataFor`（spy 计数）。

### 9.2 Web 单测（vitest + fake-indexeddb + fake timers）

1. 快照库：写入/读出往返；`accountHash` 不符删库；schema 不符重建；单行解码失败只删该行；容量 400 行裁剪顺序。
2. 合并：版本不回退（推送先到、对账行更旧 → 不覆盖），表驱动；`full`/`members` 两种成员收敛；共享行被移除时调用消息缓存按会话删除和 outbox 删除，本账号行被移除时不删消息缓存。
3. 成员摘要：全部一致 → 写 `lastReconciledAt` 与游标；缺 ≤10 行 → 逐个 `GET /v1/sessions/:id` 后成功；>10 行或补后仍不一致 → 恰好 1 次 full，不循环。mutation-check：删掉摘要比对，用 §9.1-3 的「早 10s」行构造的用例必须失败。
4. 启动：有快照时 `applyReady` 不等网络（fake fetch 永不返回也能 ready）；网络先于快照库到达时不等库；游标与快照 `meta.cursor` 不一致 → 丢弃增量、发 1 次全量；`/v3` 404 → 本页退回 `/v1`。
5. 快照期间：`seq` 比较点跳过快照行（逐个调用点的用例）；快照不触发 thinking/heartbeat 副作用。
6. 离线：离线启动渲染快照列表；有缓存的会话渲染缓存且不发网络请求；无缓存的会话显示离线占位、不转圈；离线发送进入 outbox `queued`；离线刷新后 outbox 气泡可解密显示，接管里需要网络的步骤推迟到 `online`。
7. 安全：
   - (a) logout 删除快照库；删除被挡住 → `vh.sync.purgePending` 记录 → 下次启动先删，删不掉则本页不读任何 `vh-sync-*`；
   - (b) 401 确认后 `auth_credentials`、全部 `vh-sync-*`、`vh.sync.listCursor.*` 都不存在；确认请求 200 → 不清；确认请求网络失败 → 不清、在线边沿再确认；
   - (c) socket `connect_error: Invalid authentication token`（当前 token）触发 latch 与同样的清理；旧 token 的握手失败不触发；
   - (d) `lastReconciledAt` 31 天前 → 所有 `vh-sync-*` 删除、凭据保留；未来 2 天 → 同样作废；29 天 → 正常；
   - (e) 另一个标签页删了 `auth_credentials` 后，本标签页的快照写入放弃且不重建库。
   - 每条都做 mutation-check（去掉对应的删除步骤，测试必须失败）。

### 9.3 e2e（扩展 `packages/happy-web-v2/e2e/sync-resume.mjs`）

| 场景 | 断言 |
|---|---|
| 回访有快照（小账号，phone CPU×4 与 desktop，slow 4G 与正常） | composer 可交互时间附改前改后数字；phone ≤ 2.0s、desktop ≤ 0.6s（以 REPORT 同环境基线 2.5s / 0.7s 对比，允许 ±300ms 噪声） |
| 大账号 FAT_SLOW（150 会话 / 约 1.8MB，1.6Mbps） | 有快照时 composer ≤ 2.5s（phone）；增量请求字节 < 10KB |
| 离线刷新 | 列表可见；缓存会话显示缓存消息；无缓存会话显示离线占位；离线发送 → 恢复网络后恰好出现一次 |
| 归档 / 删除 / 撤销共享（另一端操作，本端刷新） | 本端先显示快照，对账后在 ≤ 1 次增量内收敛；撤销共享的会话消息缓存被删（读 IDB 断言） |
| 401（服务端吊销登录） | 刷新后确认请求 401 → IDB 无 `vh-sync-*`，localStorage 无 `auth_credentials`，显示重新登录 |
| 旧 server（`/v3` 404） | 退回全量，快照仍先显示，无报错 |

### 9.4 真机（verify-queue）

- iOS Safari / PWA：飞行模式下杀后台重开，列表与缓存会话可翻看；恢复网络后离线发出的消息恰好一次。
- iOS 7 天未访问后 IDB 被系统清除：退回无快照路径，不报错（浏览器无法模拟 ITP）。

---

## 10. 性能预估

> 数字来自 REPORT §1.4 的阶段拆分，除「今天」一列外全部是估算，实现 PR 必须附 e2e 实测。

| 场景 | 今天（REPORT 实测） | Part A 之后（估算） | Part A + B 之后（估算） |
|---|---|---|---|
| phone·4G·回访，小账号 | composer 2531ms | **约 1.8–2.0s**：省掉列表网络（约 330ms）与等待解密的串行段，剩下启动 chunk 执行 + 派生密钥约 1.25s、IDB 读列表 + 解 ≤150 个 DEK 约 50–150ms、首屏渲染约 0.5–0.9s | 同左（小账号列表本来就小） |
| desktop·正常·回访，小账号 | 702ms | **约 0.5s** | 同左 |
| phone·正常·回访，大账号 | 3207ms | 约 2.0s（快照里 1.8MB 解密在设备上仍有成本，约 100–200ms） | 约 1.9s（快照与增量都变小） |
| desktop·正常·回访，大账号 | 1497ms | 约 0.5s | 约 0.5s |
| phone·slow 4G·回访，大账号 | 进不去（B-818 修复后约 10s） | 约 2.0s（不等网络；增量响应 3–6KB） | 约 2.0s |
| 冷启动无快照，大账号 slow 4G | 约 10s（B-818 后） | 同左 | 约 2–3s（0.2MB 列表） |
| 离线刷新 | 一直「正在加载消息…」 | 列表可浏览，30 个会话可翻看 | 同左 |

存储：快照约 23KB（小账号）到 1.8MB（大账号，Part B 后约 0.2MB）。server：`/v3` 增量平常 1 条两列查询 + 少量变化行；Part B 冷派生每请求 ≤20 行（≤约 15ms CPU），之后命中缓存。

---

# Part B：列表 metadata 瘦身（B-826，只出设计）

## 11. 设计

### 11.1 选择：服务端派生「列表视图」，按需取完整版

- 列表请求带 `view=list`（`GET /v3/sessions/list?view=list`；`/v1/sessions` 不加此参数，保持原样）。服务端对每一行：
  1. 用账号主密钥派生 content 私钥，解开 wrapped DEK（与 B-619 `sessionCrypto.ts` 相同代码）；
  2. 解密 metadata，删掉 **黑名单字段** `tools, slashCommands, skills, mcpServers, models, operatingModes, thoughtLevels`，加标记 `_vhView: 'list'`；
  3. 用同一个 DEK 重新加密（AES-256-GCM，新 nonce），替换该行的 `metadata`；行上加明文 `metadataView: 'list'`；
  4. agentState 同理：删 `completedRequests`，加 `_vhView`，行上加 `agentStateView: 'list'`。
  `metadataVersion`、`agentStateVersion` 不变。
- **用黑名单而不是白名单**：新加的小字段（CLI 以后写的 capability、状态标记）默认透传，侧栏不会因为漏列字段而缺功能；黑名单只收「已知大、且只在会话页使用」的字段（§2 的读取方都在会话页）。实现者用 `git grep` 再核对一遍黑名单字段在会话页之外有没有读取方（例如命令面板、看板），有就改成 `ensureFullSession`（§11.2）或从黑名单拿掉，结果列在 PR 里。
- **不瘦身的行**（原样完整下发，行上不带 view 标记）：账号没有可用的 `AccountSecret`、legacy 无 DEK 的会话、解密失败、原 blob < 2KB（瘦了也省不了多少）。客户端把没有标记的行一律当完整版。
- 共享行：在已有的脱敏重加密（`redactedMetadataFor`）上顺带瘦身，不多一次解密。

### 11.2 Web：按需取完整版与写入守卫

- store 每个会话记 `metadataView: 'full' | 'list'`、`agentStateView`。来源：列表行按标记；`update-session` / `new-session` 推送、`GET /v1/sessions/:id` 都是完整版，收到后对应字段升级为 `full`（版本不回退规则照旧）。
- `ensureFullSession(sid)`：任一字段是 `list` 时发 `GET /v1/sessions/:id`（现有接口，`fetchSessionById` 已在用），合并后返回。调用点：
  - 打开会话（与消息补拉并行，不阻塞缓存渲染；composer 的 slash 命令、模型选择在完整版到达前显示加载态或沿用上次本机快照里的完整版）；
  - **所有 metadata 写入之前**：`sessionApplyMetadata` 以 store 里的 metadata 为底稿整份重写（`ops.ts:1517-1590`），底稿是列表视图就会把黑名单字段写没。规则：底稿 `metadataView !== 'full'` 时先 `ensureFullSession`；拿不到（离线、失败）就报错，不写。加源码断言测试：`sessionApplyMetadata` 的底稿读取必须经过 `ensureFullSession`，mutation-check 验证。
  - Web 不写 agentState（审批走 RPC），无需守卫；将来新增写入方须遵守同一规则。
- **服务端守卫**（兜底）：`update-metadata` 来自 user-scoped 连接（Web）时，服务端解密新值，含 `_vhView` 就拒绝，回 `{ result: 'error', error: 'list_view_write' }`；CLI（session-scoped）不检查。Web 写 metadata 是低频用户操作，多一次解密可以接受。agentState 同理。
- **快照（Part A）里存哪个版本**：同一 `metadataVersion` 不用列表视图覆盖完整版；更高版本的列表视图覆盖旧的完整版（新的优先）。最近打开过的会话通常留有完整版，离线时 composer 仍有 slash 命令；被列表视图覆盖的，离线时 slash 命令为空、提示「联网后可用」。

### 11.3 服务端开销与缓存

- 实测（dev-sg，32 核负载约 30，tweetnacl）：解 wrapped DEK 约 0.65ms/次；12KB metadata 解密 + JSON 处理 + 重加密约 0.08ms/行。150 行全冷约 110ms 同步 CPU，不能每次请求都做。
- **两层进程内 LRU**：
  - 会话 DEK：key = `sessionId + sha256(wrappedDek)`，DEK 对一个会话恒定，命中后不再做 `box.open`；
  - 列表视图结果：key = `(sessionId, metadataVersion)` / `(sessionId, agentStateVersion)`，值是重加密后的 blob（约 1–1.5KB），上限约 2 万条 / 30MB。
- **每请求冷派生上限 20 行**，超出的行本次原样完整下发（客户端照常处理混合结果），并在 `setImmediate` 分片里预热缓存，下一次请求命中。蓝绿两个槽各自一份缓存，切流后首个请求最多多 20 次冷派生。
- 配合 Part A 的增量接口，平常每次请求只有变化的几行需要派生。

### 11.4 指标（阶段 0 必须先上）

- `session_list_response_bytes{endpoint, view}`（histogram，未压缩字节）；
- `session_list_metadata_bytes{part="full"|"list"}`（每行瘦身前后字节，直方图）——用来在**不看任何内容**的前提下拿到真实压缩比，验证「1.8MB → 约 0.2MB」；
- `session_list_view_derive_total{result="hit"|"derived"|"skipped_small"|"no_secret"|"failed"|"deferred"}`；
- `session_list_view_derive_seconds`。

## 12. 兼容与迁移路径

### 12.1 兼容矩阵

| # | 组合 | 行为 | 风险 |
|---|---|---|---|
| 1 | **旧 CLI**（任意版本） | 照常写完整 metadata / agentState；瘦身只发生在服务端出口 | 无 |
| 2 | **旧 Web** + 新 server | 不带 `view=list`（`/v1/sessions` 根本没有这个参数），拿到完整行；写 metadata 的底稿是完整版 | 无 |
| 3 | 新 Web + 旧 server | `/v3` 不存在或忽略 `view` → 行上没有 view 标记 → 全部当完整版 | 无，只是没瘦身 |
| 4 | 新 Web 的 bug：拿列表视图当底稿写回 | Web 写入守卫拦截；漏网时服务端守卫回 `list_view_write` | 无数据丢失；守卫命中计入指标 |
| 5 | grantee | 脱敏 + 瘦身；打开会话时 `GET /v1/sessions/:id` 拿到的是脱敏完整版 | 无 |
| 6 | 回滚 server | 列表回到完整版；Web 处理无标记行 | 无 |
| 7 | 推送 | `update-session` 仍是完整 metadata；每次 CLI 改 metadata 仍推约 12KB（只在变化时） | 不在本 spec 范围，见 §12.4 |

### 12.2 为什么不在 `/v1/sessions` 上对所有人瘦身

旧 Web 的 `sessionApplyMetadata` 以 store 里的 metadata 为底稿整份重写（§2）。如果 `/v1/sessions` 直接下发瘦身版，旧 Web 一次重命名就会把 CLI 写的 tools、slashCommands、models 全部删掉，违反铁律 4（协议双向兼容）。所以瘦身必须由客户端显式请求，且只有带写入守卫的新 Web 才请求。

### 12.3 迁移路径（不需要 DB 迁移）

| 阶段 | 内容 | 门槛 |
|---|---|---|
| 0 | server 上线 §11.4 指标与派生代码，`SESSION_LIST_VIEW=off`（只计算字节、不下发，在 `/v3` 请求上抽样 10% 派生并丢弃结果） | 拿到真实 `part=full/list` 分布；派生 P95 < 1ms/行，冷派生对请求时延的贡献 P95 < 30ms |
| 1 | server `SESSION_LIST_VIEW=on`（响应 `view=list` 请求）；Web 带写入守卫与 `ensureFullSession`，但还不发 `view=list` | Web 守卫与按需取完整版在生产跑一个版本，无回归 |
| 2 | Web 对 Owner 账号发 `view=list` 2–3 天 | 无「slash 命令/模型选择缺失」反馈；`list_view_write` 守卫命中为 0 |
| 3 | 全量 | — |
| 4（可选，另立项） | CLI：`completedRequests` 封顶（例如只留最近 50 条），大数组迁到独立的能力字段 | 只有阶段 0–3 的指标显示推送体积或派生开销成为瓶颈时才做；需要 CLI 发版和旧 Web 兼容方案（旧 Web 读不到新字段时 slash 命令会消失，所以 CLI 必须双写一段时间） |

回滚：任一阶段设 `SESSION_LIST_VIEW=off` 或回退镜像；Web 收到无标记行即按完整版处理。

### 12.4 被否 / 延后的方案（Part B）

| 方案 | 结论 | 理由 |
|---|---|---|
| CLI 把大数组写到独立字段，列表不带 | 延后（阶段 4） | 要所有 daemon 主机升级才见效；旧 Web 读不到新字段，slash 命令、模型选择会消失，CLI 必须长期双写，体积反而先变大 |
| server 在 `/v1/sessions` 对所有客户端瘦身 | 否 | §12.2：旧 Web 写回会删字段 |
| server 写入时同步算出瘦身列（新 DB 列） | 否 | 每次 metadata 写都要解密，且需要 schema 迁移；进程内 LRU 加增量接口达到同样效果，没有迁移 |
| 白名单字段 | 否 | 新字段默认被丢，侧栏功能会无声缺失 |

## 13. 测试计划（Part B）

1. Server 单测：派生函数对 fixture metadata 删掉且只删掉黑名单字段，加 `_vhView`，版本号不变；小 blob、无 secret、legacy、解密失败原样返回且无标记；共享行在脱敏结果上瘦身；每请求冷派生 ≤20 行，其余原样；缓存命中不调用 `box.open`（spy）。
2. Server：`update-metadata` 来自 user-scoped 连接、值含 `_vhView` → `list_view_write`；来自 session-scoped → 照常写。mutation-check：去掉守卫，测试必须失败。
3. Web：`metadataView` 状态流转（列表 → 推送升级 → 列表行更高版本覆盖）；`sessionApplyMetadata` 底稿为列表视图时先取完整版，离线时报错不写；源码断言 + mutation-check。
4. Web：打开会话触发且只触发一次 `GET /v1/sessions/:id`；slash 命令、模型选择在完整版到达后出现。
5. e2e：FAT 账号 `view=list` 响应 ≤ 250KB（未压缩）；重命名一个列表视图会话后，服务端解密结果仍含原 tools/slashCommands（e2e 用 standalone server 的测试账号，由测试自己解密）。

## 14. 工作量估计

依据：SYNC §11 的同类 PR 规模（B-494 server handler +906、B-799 Web 同步 +1075、B-722 outbox +1169），以及 5a/6a/6b 的实际耗时（每个 1–2.5 个 agent 工作日）。

| PR | 内容 | 预计规模 | 工作日 |
|---|---|---|---|
| A1 | server `/v3/sessions/list`（全量/增量/members/cursor、开关、测试） | +500，6 文件 | 1 |
| A2 | Web `/v3` 增量 + 成员校验 + socket 首连改增量；`purgeLocalAccountData`、socket 401 latch、401 确认、待删机制（与 B-825 协调） | +900，12 文件 | 2–2.5 |
| A3 | Web 快照库、启动路径、离线翻看、快照期 `seq` 比较点、多标签页守卫、30 天作废、e2e | +1200，15 文件 | 2–3 |
| A-QA | e2e 计时与真机队列 | — | 0.5 |
| **Part A 合计** | | | **5.5–7** |
| B1 | server 派生、缓存、守卫、指标（阶段 0/1） | +600，6 文件 | 1.5–2 |
| B2 | Web `metadataView`、`ensureFullSession`、写入守卫、快照合并规则 | +500，8 文件 | 1.5–2 |
| B-QA | e2e 与灰度观察 | — | 0.5–1 |
| **Part B 合计** | | | **3.5–5** |

A1 与 A2 的 `purgeLocalAccountData` 部分可以并行；A3 依赖 A1、A2。B 依赖 A1（`/v3` 接口）。`sync.ts`、`storage.ts` 是冲突热区，A2/A3/B2 串行合入。

## 15. 风险

1. **快照让旧状态看起来是新的** → `snapshot` 期间显示「同步中」或离线条；实时状态只由推送推导；成员摘要保证对账后一致。
2. **安全增量**（§3.3 唯一新增风险）→ §6 三条缓解 + 待删机制 + 多标签页守卫；OWNER-SUMMARY 写明。
3. **误清数据**（401 误判）→ 确认一次；指标记录确认结果分布。
4. **`sync.ts` 冲突热区** → A2/A3/B2 串行，开工前 `git log -5 -- packages/happy-web-v2/src/sync/sync.ts`。
5. **服务端解密开销**（Part B）→ DEK 与结果两层缓存、每请求冷派生上限、阶段 0 先测。
6. **黑名单字段在会话页外被读** → 实现 PR 必须列出 `git grep` 结果；灰度阶段观察反馈。

## 16. 验收标准

- [ ] §9.1、§9.2 全部用例通过，§9.2-3、§9.2-7 与 §13-2、§13-3 的 mutation-check 有效。
- [ ] §9.3 e2e 每行附改前改后数字，达标。
- [ ] §7.2、§12.1 兼容矩阵逐行有测试或 e2e，PR 正文逐行勾选。
- [ ] 401 确认后本机无 `auth_credentials` 与任何 `vh-sync-*`（与 B-825 共同验收）。
- [ ] Part B 阶段 0 指标上线并给出真实 full/list 字节分布后，才进入阶段 1。
- [ ] shipped 后 §9.4 转入 `docs/verify-queue.md`。

## 17. 修订记录

| 版本 | 日期（SGT） | 修订人 | 内容 |
|---|---|---|---|
| r0 | 2026-10-26 | spec 作者（B-824 / B-826） | 初稿。**推翻 SYNC r2「不缓存 DEK」与 r3「离线不可读」**，依据 Owner 2026-10-26 的决定：做 B-816 中档（会话列表快照 + wrapped DEK + 离线翻看）与大改档的 metadata 瘦身，安全缓解按推荐（退出一起删、401/已下线立即清空并删主密钥、30 天未同步作废）。SYNC §0 第 3 条、§7「缓存 DEK」行、§16 取舍 1 同步加注指向本 spec。SYNC 的订阅协议、消息缓存一致性规则、outbox 规则不变 |
