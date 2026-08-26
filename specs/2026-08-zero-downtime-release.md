# 生产 Server/Web 无缝发版

> 状态：Reviewed Draft（方向可行；完成 Groundwork 门禁前不可直接启用切流）
> 日期：2026-08-26 ｜ 关联 backlog：B-214

## 背景

当前 `veryhappy.dev` 只有一个 `happy-server` 容器，Caddy 固定代理到
`127.0.0.1:3005`。发布脚本虽然先拉取不可变镜像、备份 Compose，并能在失败时
恢复旧 digest，但真正切换仍是 `docker compose up -d --force-recreate`：旧进程先
退出，新进程完成迁移和启动后才恢复服务。因此它能保证可回滚与数据不随容器丢失，
不能保证发布窗口内 HTTP/WebSocket 连续可用。

2026-08-26 生产只读核验：`vh-us` 有约 2.8 GiB available memory，当前 Server
约占 171 MiB，资源允许发布期间短时双跑；但生产容器没有配置 `REDIS_URL`，所以
不能仅靠再起一个容器就宣称多副本安全。代码已有 Socket.IO Redis streams adapter
和跨实例 RPC room 路由，但 relay assignment lease 仍是进程内 `Map`。Owner 同日确认
可以提供 Redis；连接值只通过生产 secret 注入，不写入 repo、文档或日志。

本 spec 把“无缝”定义为用户体验和数据语义，而不是把断线后自动恢复称作零停机。

## Review 结论（2026-08-26）

方案在以下前提满足后可行，但当前代码和原发布脚本尚未满足，不能直接上线双 slot：

- Caddy 2.10.2 的隔离实验确认 config reload 后既有 WebSocket 继续由 blue 提供，新的
  HTTP 请求进入 green。
- 同一实验也确认 Socket.IO polling 的既有 `sid` 若通过新 TCP 请求进入 green，会返回
  `400 Session ID unknown`。生产 Web 主连接允许 `['websocket', 'polling']` 回退，因此
  必须增加 slot 定向 handover/affinity，不能把 WebSocket 结论外推到 polling。
- 使用仓库锁定的 Socket.IO/Redis Streams adapter、两个真实 Node 进程和 Redis 7.4.5
  的隔离实验，跨实例 `fetchSockets`、RPC ack、green→blue room broadcast 均通过。
- Server `tsc` 与 77 files / 504 tests 全绿；CLI build、139 files / 1,281 tests 和运行冒烟
  全绿。但现有 suite 没有覆盖 Caddy 切流、polling affinity、双 slot readiness/drain 或
  Redis lease，以上仍是实现阶段必须新增的事故回归。
- 现有 Redis adapter 创建后立即记录“enabled”，没有等待 adapter peer discovery 的真实
  readiness；Redis client/lag timer 的生命周期也需纳入 shutdown。仅 `PING` 成功不够。
- Prisma 未显式设置 `connection_limit`；双跑会扩大默认 pool。启用 candidate 前必须按
  生产 CPU、PostgreSQL `max_connections` 和其他连接者计算预算，并显式配置每 slot 上限。

因此推荐先做 Groundwork + shadow rollout；shadow 证据通过前保持现有单 slot 发布。

## 目标

- HTTP 发布窗口内无 Caddy 502、connection refused 或因切换产生的 5xx；已进入旧
  进程的请求允许完成。
- durable update 在切换前后无 seq 缺口且幂等；新旧 Server 可在同一 PostgreSQL
  schema 上同时运行。
- regional relay 上的终端字节流不受 control Server 切换影响；central fallback
  终端完成 snapshot/seq 收敛后才结束旧连接。
- Web、daemon、session-scoped agent 的新客户端采用 make-before-break handover：
  新 socket 完成鉴权、同步和 RPC 重新注册后，才关闭旧 socket。
- 发布脚本可以在切流前、切流后、drain 中三个阶段确定性回滚；不执行 destructive
  down migration。
- 单次发布结束后只保留一个 active Server；旧 slot 在连接与 in-flight operation
  清零后退出，不无限积累旧进程。

### 可验证 SLO

| 指标 | 门槛 |
|---|---|
| 发布合成探针 HTTP 成功率 | 100%，零切换型 5xx |
| durable update | 按 `seq` 零缺口、按 `localId` 零重复副作用 |
| 新客户端 handover | p95 ≤ 2s；UI 不进入离线错误态 |
| RPC | drain 期间新调用成功；已开始调用在旧进程完成或返回既有业务错误，不因杀进程失败 |
| regional terminal | 字节流零中断 |
| central fallback terminal | 重连后 snapshot/stream generation 收敛，无可见清屏或缺行 |
| 回滚 | Caddy 切回旧 slot ≤ 10s，旧 digest/health/asset 全部核对 |

## 非目标

- 不解决 `vh-us` 整机、Caddy、PostgreSQL 或 Redis 服务故障；这仍是单机部署，不是
  跨可用区 HA。
- 不在本项目自造 service mesh、Kubernetes control plane 或数据库双主。
- 不承诺任意旧版本客户端永远零 socket 重连。旧端不理解 handover 时，保留长 drain
  窗口并使用既有自动重连 + REST resync；严格 make-before-break 只对先行发布过协议
  支持的新客户端成立。
- 不允许为了回滚执行 Prisma down migration；数据库 contract 删除必须延后到确认旧
  slot 和旧客户端均退出后的后续 release。
- CLI npm 六个平台包的发布不是同一原子事务；继续沿用“平台包先于主包”的幂等发布，
  本 spec 只保证已发布 CLI 的 daemon 切换用户无感。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 生产是单 `happy-server`，Caddy 代理固定 `127.0.0.1:3005` | `docs/operations.md:12-22` |
| 当前脚本备份旧 Compose/digest，但切换动作仍是 `force-recreate happy-server` | `scripts/ci/deploy-server-remote.sh:37-94` |
| 失败路径会恢复旧 Compose、旧镜像并重验 local/public health | `scripts/ci/deploy-server-remote.sh:50-87` |
| Socket.IO 已在 `REDIS_URL` 存在时启用 Redis streams adapter | `packages/happy-server/sources/app/api/socket.ts:64-88` |
| brief-disconnect event replay 已验证但 `connectionStateRecovery` 仍注释关闭 | `packages/happy-server/sources/app/api/socket.ts:47-59` |
| RPC 使用 cluster adapter 的 `fetchSockets()`，空 room 有 15 秒 reconnect grace | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:8-34,293-335` |
| relay assignment lease 是单进程 `Map`，TTL 75 秒，不适合直接多副本 | `packages/happy-server/sources/app/relay/relayRegistry.ts:3-37` |
| Server 收到 SIGTERM 后调用 `app.close()`，但尚无显式 release drain/handover 状态 | `packages/happy-server/sources/app/api/api.ts:189-198` |
| daemon 优雅退出会 flush mirror、保留会话，重启后按持久化 PID 重新接管子进程 | `packages/happy-cli/src/daemon/run.ts:195-220,1297-1341` |
| 多副本 RPC/广播、pod kill 和 missed-event 已有可复用 integration harness | `docs/multi-process.md`、`packages/happy-server/deploy/integration-tests/` |

## 设计

### 1. 推荐拓扑：同机蓝绿，而非同端口强制重建

```txt
https://veryhappy.dev
└─ Caddy :443
   └─ /opt/happy/caddy/active-upstream.caddy（原子替换 + caddy reload）
      ├─ active=blue  → 127.0.0.1:3101 → happy-server-blue
      └─ active=green → 127.0.0.1:3102 → happy-server-green

shared dependencies
├─ happy-postgres  ← durable state + expand/contract migrations
├─ REDIS_URL       ← Socket.IO streams + cross-slot rooms + relay leases
└─ happy-data      ← 现有文件 volume（并发读写契约需回归覆盖）
```

- Compose 定义固定的 `happy-server-blue` / `happy-server-green` 两个 slot，各自使用唯一
  loopback host port、metrics port 与 `VH_RELEASE_SLOT`。
- Caddy reload 本身 graceful，已建立到旧 slot 的 WebSocket 继续存活；这条结论不适用于
  HTTP long-polling 的后续新请求。
- `/v1/updates` 支持显式 `vh_slot=<blue|green>` query route，供新客户端在默认 upstream
  仍为 old 时直连 candidate 做 make-before-break。值只允许当前两个 slot，不能变成任意
  upstream SSRF。默认无 query 的连接仍进入 active slot。
- 不使用 Caddy 对两个 slot 普通轮询。发布期的目标是确定性切流；随机负载均衡会让
  rollback、release asset 判定和旧连接 drain 难以证明。
- 优先使用 Owner 提供的外部/托管 Redis，通过生产 `.env` 的 `REDIS_URL` 注入；要求
  TLS（若跨主机）、ACL、专用 database/key prefix、连接数/内存配额与可观测性。只有
  外部 Redis 不可用时才回退到 pinned digest 的同机 sidecar。Streams 与 lease 均是
  可重建协调状态，不把 Redis 当 durable source of truth。

### 2. 先把“双跑”变成显式契约

#### 2.1 Redis 是双跑门禁，不是可选加速

- Cloud 模式启动第二个 Server 前，`REDIS_URL` 必须存在且 `PING` 成功；candidate
  readiness 在 adapter 初始化完成、经过至少两个 heartbeat interval 后才为 true。
- adapter 使用专用 `streamName`、`channelPrefix` 和 `sessionKeyPrefix`；当前 metrics 读取
  写死的 `socket.io` stream，改 prefix 时必须共用同一配置源，避免 readiness/lag 看错流。
- `RelayRegistry` 改为接口，Cloud 实现用 Redis key：
  `vh:relay-machine:<machineId>`，value 为 `RelayMachineLease`，`PX=75000`；standalone
  无 Redis 时保留 in-memory 实现。
- `activeByUser` connection limit 和 terminal/RPC token bucket 当前按进程计数。双跑
  窗口允许短暂放宽不是安全契约；Cloud 路径需迁为 Redis 原子计数/桶，或将限制乘以
  slot 数并记录为明确的短期风险。推荐前者。

#### 2.2 liveness、readiness、drain 分离

```ts
type ReleaseReadiness = {
  status: 'ready' | 'not-ready';
  release: string;       // 40-char SHA
  slot: 'blue' | 'green';
  database: 'ready' | 'failed';
  redis: 'ready' | 'failed';
  socketAdapter: 'ready' | 'warming' | 'failed';
  webAsset: string;
};

type ReleaseDrainNotice = {
  epoch: string;
  fromRelease: string;
  toRelease: string;
  deadline: number;
  mode: 'make-before-break';
};

type ReleaseDrainStatus = {
  epoch: string;
  state: 'accepting' | 'draining' | 'drained';
  localSockets: number;
  inFlightHttp: number;
  inFlightRpc: number;
};
```

- `/health` 只表示进程活着；新增 loopback-only release admin/readiness endpoint，避免
  public auth surface 增长。
- readiness 至少检查 DB round-trip、Redis、adapter warmup、release SHA 和该 release
  的 Web entry；不能只看 `{status:'ok'}`。
- drain 触发后旧 slot 不再成为 Caddy upstream，但继续处理已存在 socket 和 in-flight
  operation；只有 status 全零才允许 SIGTERM。

### 3. 发布状态机

```txt
GitHub workflow_dispatch(target=all, sha, immutableDigest)
│
├─ preflight
│  ├─ active slot health/release/digest
│  ├─ PostgreSQL + Redis health
│  ├─ memory/disk headroom
│  ├─ migration policy = expand/compatible
│  └─ snapshot: Caddy include + Compose + active slot metadata
│
├─ startCandidate(inactiveSlot, immutableDigest)
│  ├─ pull + packaged Prisma/client checksum
│  ├─ compose up inactive slot（不碰 active）
│  ├─ wait ReleaseReadiness.status === 'ready'
│  └─ cross-slot canary
│     ├─ RPC register on active → call from candidate
│     ├─ emit candidate → receive on active（反向也测）
│     └─ direct candidate Web asset = target SHA
│
├─ handoverSupportedClients（默认 upstream 仍为 old）
│  ├─ old emits ReleaseDrainNotice(candidateSlot)
│  ├─ new clients connect /v1/updates?...&vh_slot=candidate
│  ├─ authenticate / resync / RPC re-register, then close old
│  └─ old clients remain on old during compatibility grace
│
├─ switchDefaultTraffic
│  ├─ write temporary Caddy include → candidate port
│  ├─ caddy validate
│  ├─ atomic rename + caddy reload
│  └─ public health/release/asset must equal target SHA
│
├─ drainOld
│  ├─ unsupported old WebSocket clients remain until grace/deadline
│  ├─ unsupported polling clients may reconnect + REST resync after default switch
│  └─ wait localSockets=0 && inFlightHttp=0 && inFlightRpc=0
│
└─ finalize
   ├─ SIGTERM old slot; verify candidate still healthy
   ├─ record active slot/digest/rollback slot
   └─ promote exact digest to latest
```

#### Cross-slot canary 是硬门禁

仅 candidate `/readyz` 成功不能证明 Redis adapter 已发现 peer。切流前必须跑仓库已有
multi-process harness 的最小生产安全子集：跨 slot `fetchSockets`、RPC ack、双向 room
broadcast。探针只使用临时测试账号/room，不接触真实用户 payload，完成后清理。

### 4. 长连接 handover

```txt
old slot emits server-draining(ReleaseDrainNotice with candidateSlot)
│
├─ Web apiSocket / ApiSessionClient / ApiMachineClient receives notice
│  ├─ keep old socket alive
│  ├─ open candidate socket to same origin with handover epoch + vh_slot query
│  ├─ authenticate + join rooms
│  ├─ durable cursor REST resync or recovered event replay
│  ├─ RpcHandlerManager re-registers methods and waits rpc-registered
│  └─ candidateReady=true → close old socket
│
└─ old server counters
   ├─ localSockets-- on old close
   ├─ inFlightRpc remains until callback settles
   └─ all zero → state='drained' → deploy script may SIGTERM
```

- 先启用并回归 `connectionStateRecovery`，但它只是优化；durable update 的正确性仍以
  DB cursor/REST resync 为兜底，不能依赖 Redis stream 永不裁剪。
- 连接恢复需要单独做并发内存/Redis 压测后再开启；不能因为 adapter 声明支持就直接把
  2 分钟窗口用于全量连接。先从较短窗口和 shadow 指标起步。
- daemon/session runner 的 `RpcHandlerManager` 必须等所有 `rpc-registered` ack 后再关闭
  旧 socket，避免新连接“已 connect 但 RPC 尚不可用”的窗口。
- machine offline 不能在旧 socket `disconnect` 时立即广播。延迟一个 reconnect grace，
  再用跨 replica room membership 确认无任何 machine socket，避免 daemon 更新或
  handover 造成 UI 在线状态闪烁。
- 已经在 regional relay 的 terminal/session realtime 不迁移；control slot 只更新 durable
  state。central fallback 必须在 handover 后触发既有 snapshot + stream generation resync，
  通过一致性探针后才关闭旧 socket。

### 5. 旧客户端兼容与分阶段上线

不能在同一 release 里第一次引入 handover 协议并立刻假设所有旧标签页/旧 CLI 都支持。

1. **Groundwork release**：单 slot 不变；上线 Redis、共享 relay lease、readiness/admin
   metrics、connection recovery、machine offline debounce 和客户端 handover 代码，但不
   触发 drain event。
2. **Shadow rollout**：生产短时启动 inactive slot，只跑 readiness/cross-slot canary，
   不切 Caddy；验证 Redis lag、RPC、共享 lease、资源占用后关闭 candidate。
3. **Blue-green passive drain**：默认 upstream 仍指向 old 时先让新客户端经 slot query
   主动 handover，再切默认 Caddy upstream；旧客户端保留较长兼容 grace 后自然重连，
   超时旧端由 Server 正常断开并走既有 REST resync。
4. **Active handover**：确认 Web/CLI adoption 与真机结果后，把 drain grace 收敛到分钟级，
   达到常态无感发布。

旧 Server 忽略新客户端 handshake 附加字段；旧客户端忽略未知 `server-draining` event。
因此 groundwork 可以先发布，且 server/web/CLI 任一回滚都不破坏旧链路。

### 6. 数据库发布纪律

- 所有 schema 变更使用 expand/contract：release N 只新增 nullable column/table/index，
  old/new 同时可读写；release N+1 在旧 slot 与最低兼容客户端退出后再 backfill/contract。
- candidate 启动执行 migration 时，active 仍在线；migration 必须有锁等待上限和预演，
  禁止长时间 blocking DDL。
- post-switch 回滚只切回旧应用 digest。若新代码已写入新字段，旧代码必须忽略；绝不
  临场 down migration。

### 7. 回滚状态机

```txt
failure phase
├─ before Caddy switch
│  └─ stop candidate; active untouched
├─ after switch, old still draining
│  ├─ atomically restore old Caddy include
│  ├─ caddy reload + verify old release/asset
│  └─ keep candidate alive until its sockets drain, then stop
└─ after old stopped
   ├─ start old digest in inactive slot
   ├─ readiness + cross-slot/public verification
   └─ switch Caddy back; never down-migrate
```

任何 rollback 验证失败都停止自动动作并保留两个 slot，不能继续删除容器或覆盖
rollback metadata。

### 8. 可观测性

两个 slot 使用不同 loopback metrics port，至少暴露：

- `release_slot_ready{slot,release}`
- `release_draining{slot,release}`
- `release_local_connections{slot,type}`
- `release_inflight_http{slot}` / `release_inflight_rpc{slot}`
- `release_handover_total{client,result}` / `release_handover_duration_seconds`
- 已有 `redis_stream_lag_ms`、`rpc_calls_total`、`websocket_connections_total`

发布脚本在切流前后保存这些聚合值。若 Redis lag 超阈值、RPC error rate 上升、handover
失败或连接未按 deadline 收敛，则自动切回旧 upstream，但不杀任何仍承载连接的 slot。

## 被否方案

| 方案 | 不采用原因 |
|---|---|
| 继续单容器 restart，依赖客户端重连 | 有真实 connection refused/502 窗口，不是无缝 |
| Caddy 同时轮询 blue/green | 随机路由使发布版本、rollback 和 drain 不可证明；无 Redis 时 RPC 会断 |
| 只做 Caddy graceful reload，永久保留旧连接 | 长寿命 daemon/socket 可数天不退出，旧进程无法收敛，连续发布会堆积 |
| 直接上 Kubernetes | 当前单机规模下引入 control plane 的复杂度大于收益；现有代码和资源足够同机蓝绿 |
| 把所有状态迁 PostgreSQL | Socket rooms/RPC 是高频 ephemeral state；Redis streams adapter 已有并经过 harness 验证 |

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| old Server + new Web/CLI | 忽略 handover handshake 字段；客户端保持旧重连行为 |
| new Server + old Web/CLI | old client 忽略 drain event；兼容 grace 后自动重连 + REST resync |
| blue old + green new | Redis adapter 跨 slot 路由 room/RPC；schema 仅允许 expand-compatible |
| new Server + old relay | relay protocol 不变；assignment 从共享 Redis 读取 |
| new relay + old Server | 本 spec 不改变 relay wire contract，维持现有兼容 |

常态发布顺序：

1. groundwork Server（单 slot）→ Web → CLI/daemon；
2. shadow rollout 验证；
3. 开启 blue-green；
4. 后续业务 release 继续 Server candidate → supported-client handover → Caddy switch →
   compatibility drain → Web/CLI（按各业务 spec
   的兼容矩阵调整）。

CLI tag 仍在 Server/Web 向后兼容后发布。`vh-update` 保留 agent 子进程；machine offline
debounce 与 RPC reconnect grace 吸收 daemon 控制 socket 的短暂切换。

## 风险

1. **Redis 成为协调层单点。** 本 spec 解决 deploy downtime，不解决 host HA；Redis
   readiness fail-closed，生产切流期间 Redis 异常立即回滚，durable data 仍在 PostgreSQL。
2. **旧客户端不支持 make-before-break。** 必须先发 groundwork，并保留 passive drain
   阶段；不能第一天就把 drain deadline 设很短。
3. **共享 local file volume 并发语义。** shadow 阶段必须覆盖同时上传/读取和配额检查；
   若不能证明安全，Cloud 改用对象存储后才开启双跑。
4. **migration 阻塞 active。** 强制 expand/contract、锁等待上限和 candidate preflight；
   高风险 DDL 单独维护窗口，不冒充无缝发布。
5. **重复 machine socket/RPC owner。** handover 短时可能出现两个注册者；新连接 ready 前
   不关旧连接，RPC router 需按 handover epoch 选择新 owner，而不是不确定地取数组首项。
6. **Caddy 配置漂移。** active include 由脚本原子生成，切前 `caddy validate`，rollback
   保存 checksum；禁止手工同时改主 Caddyfile 和 release include。
7. **polling session 丢失 affinity。** Web 为兼容受限网络保留 polling；发布 handover 用
   slot query 定向，未来 active-active HA 的入口必须使用 cookie/IP affinity，或者经真实
   网络覆盖率证明后才改成 WebSocket-only。
8. **数据库连接翻倍。** Prisma 默认池大小与物理 CPU 相关；双 slot 必须显式限制 pool，
   并给 migration/admin/监控和 PostgreSQL 自身保留余量，不能只凭内存充足判定可双跑。
9. **共享本地附件卷只适合同机过渡。** 随机 UUID 降低同 key 冲突，但重复 PUT、删除与
   上传状态仍可能跨进程竞态；B-214 shadow 必须覆盖这些并发路径。

## 验收标准

- [ ] 外部 Redis 的 TLS/ACL、专用 key prefix、延迟、连接数和内存配额核验通过；生产
  `REDIS_URL` 仅存在于 secret，且 Socket.IO adapter、relay lease、限流多副本语义有测试。
- [ ] blue/green Compose、Caddy include、readiness/drain endpoint 和 release state 文件
  有纯函数/fixture 测试，不依赖修改真实生产文件才能验证。
- [ ] candidate 切流前 cross-slot RPC + 双向 broadcast probe 必须通过；故意断 Redis 时
  workflow fail-closed 且 active slot 不变。
- [ ] 连续 HTTP 探针覆盖完整发布，零 5xx/connection refused，public release/asset 在
  Caddy 切换后精确等于目标 SHA。
- [ ] WebSocket-only 与 polling-only 都覆盖：既有 WebSocket 跨 reload 保持；polling
  handover 使用 slot 定向路由，同 `sid` 不得被送到错误 slot；无 affinity 注入测试必须失败。
- [ ] Web、machine-scoped daemon、session-scoped runner 分别完成 make-before-break；
  新 socket ready/RPC registered 前旧 socket 不关闭。
- [ ] daemon 更新期间 machine UI 不闪 offline，正在运行的 agent 子进程 PID 不变，
  spawn/session RPC 在 grace 内可用。
- [ ] durable session message sequence 零缺口/零重复副作用；central fallback terminal
  与 tmux snapshot/光标一致；regional relay terminal 完全不受影响。
- [ ] candidate readiness 失败、Caddy reload 失败、post-switch health 失败、Redis 中断、
  drain 超时、migration 失败六类注入测试均保留或恢复健康旧 slot。
- [ ] 连续两次发布不会留下两个 old slot；rollback metadata 明确记录旧/新 digest、slot、
  Caddy checksum 和验证结果。
- [ ] 双 slot Prisma `connection_limit` 有显式预算；生产连接峰值、candidate 启动与 migration
  合计不触及 PostgreSQL 连接上限或保留余量。

## 留真机验证项

- 移动端 PWA 在 control Server handover 时，结构化会话、侧栏在线态和输入框不闪离线，
  terminal relay 不清屏、不丢键。
- 桌面端运行中的 Claude/Codex 会话跨 Server 发布与 `vh-update` 后仍在原 turn，权限卡、
  tool result 和 Usage 更新连续。
- 旧版本 CLI 与发布前已打开的旧 Web tab 在 passive drain deadline 后能自动恢复，且不会
  出现需要手工刷新才能继续的状态。
