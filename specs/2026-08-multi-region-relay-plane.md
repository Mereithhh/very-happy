# 多地域 Relay Plane

> 状态：Final
> 日期：2026-08-25 ｜ 关联 backlog：B-192 ｜ 后续：WebRTC direct path（另立 spec）

## 背景

Very Happy 当前把 durable API、账号数据和交互式 Socket.IO relay 放在同一个 origin。浏览器和 daemon 即使在同一地区，每个无本地回显的终端按键仍会经单一 origin 往返，物理距离会被 browser → server → daemon → server → browser 的链路放大。Owner 要求先实现多地域 relay 自动选择，后续再增加 WebRTC 直连；完成后把这项能力作为 README 与 Landing 的一级产品差异点。

## 目标

- control/data plane 继续集中承载登录、账号、机器/session 元数据、PostgreSQL、durable sync 和 Web 静态资源。
- 新增不依赖数据库的 regional relay 运行模式，只承载 machine RPC 与 Web terminal 实时事件。
- daemon 并行测量控制面下发的候选 relay，锚定最低 RTT 的健康节点，并周期续租。
- Web 打开某台机器时获取其当前 assignment 和短期、最小权限 token，直连该机器所在 relay。
- terminal UI 显示当前 transport、relay id/region 和浏览器到 relay 的实测 RTT，让跨洲物理延迟可见而不是表现成未知卡顿。
- 中央旧 Socket.IO 实时路径保留一个兼容发布窗口；新客户端在 discovery 不可用时自动回退。
- 为将来的 browser ↔ daemon WebRTC DataChannel 保留统一的 realtime transport seam，regional relay 成为 fallback。

## 非目标

- 本批不实现 WebRTC、ICE、STUN 或 TURN。
- 不让浏览器切换一台已有活跃 daemon 的 relay；第一版采用 machine-anchor，避免多个浏览器争抢路由。
- 不把 durable update、session message、clipboard、file preview 或账号 presence 迁出 control plane。
- 不承诺企业 SLA、无限水平扩容或任意地区已经上线；宣传只描述代码和实际部署验证过的能力。
- 不使用 GeoIP 作为唯一选择依据。region 是展示/运维标签，选择依据是 daemon 的实际健康探测 RTT。
- 不对 raw TUI 做 speculative local echo。xterm screen buffer 缓存的是已确认远端输出，不能证明远端如何解释按键；Claude/Codex alternate screen、方向键和 IME 下伪回显会造成双字与光标失步。transport 可保留有界发送队列，但真正缩短跨洲 echo 依赖后续 WebRTC/direct path。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 只有一个 `ApiSocket`，HTTP、durable sync、machine RPC 与 terminal events 共用 `serverUrl` 和 `/v1/updates` | `packages/happy-web-v2/src/sync/apiSocket.ts:42-220` |
| daemon 的 machine connection 同样只连 `configuration.serverUrl`，RPC 注册与终端输入输出在同一 socket | `packages/happy-cli/src/api/apiMachine.ts:767-895` |
| control server 在连接握手时查账号 token 和 machine ownership，并在 terminal input 每帧再次走 ownership cache | `packages/happy-server/sources/app/api/socket.ts:96-135`、`packages/happy-server/sources/app/api/socket/terminalHandler.ts:165-197` |
| Socket.IO Redis adapter 解决同一 control server 的多进程 fan-out，但不是 database-free regional relay，也没有 machine assignment | `packages/happy-server/sources/app/api/socket.ts:58-91` |
| terminal live payload 已支持按 machine key 加密，relay 只需保持 envelope 字段和顺序，不需要解密字节 | `packages/happy-cli/src/api/apiMachine.ts:147-180`、`packages/happy-server/sources/app/api/socket/terminalHandler.ts:107-160` |

## 设计

### 1. 两个 plane

```text
                         durable HTTPS + sync socket
 Browser ─────────────────────┐
                              ▼
                      Control / Data server
                      auth · metadata · Postgres
                              ▲
 Daemon ──────────────────────┘

 Browser ── short-lived token ──► Regional relay ◄── short-lived token ── Daemon
                  terminal bytes · machine RPC only
```

Control plane 从 `HAPPY_RELAYS_JSON` 读取有序候选 `{id,url,region}`。候选为空时功能关闭，现有单 origin 行为不变；配置了候选却缺少至少 32 bytes 的独立签名 secret 时 fail fast，不能静默退成未保护模式。

### 2. Discovery、探测和 machine-anchor

1. daemon 用已有 bearer 调 `GET /v1/relays` 获取候选。
2. daemon 并行请求每个 `${relay.url}/health`，使用 monotonic wall time、2 秒上限；健康候选按 RTT 最小值选择，稳定相同时按配置顺序。
3. daemon 调 `POST /v1/relays/machines/:machineId/claim` 上报 relay id、完整探测结果并续租；control plane 验证 machine ownership 后返回 10 分钟 machine relay token。
4. assignment 采用 75 秒 TTL；daemon 每 20 秒续租。control 重启或租约过期时 Web 回退旧路径，daemon 下一 heartbeat 自动重建。
5. Web 调 `GET /v1/relays/machines/:machineId`；control 验证 ownership 后返回当前 relay 和 10 分钟 web relay token。Web 在 token 到期前按需重新获取。

这里的“最近”明确指**离 daemon 最近的健康 relay**。浏览器连接该 machine 的锚定 relay，保证双方汇合且实时字节不经过中央数据服务器。未来可以在不改变 token/transport 接缝的前提下加入两端 score 或 WebRTC direct path。

### 3. Relay token

control 和 relay 共享独立的 `RELAY_TOKEN_SECRET`，不复用数据库 master secret。HS256 claims：

```text
aud=very-happy-relay
iss=very-happy-control
sub=<accountId>
relayId=<configured relay>
machineId=<owned machine>
clientType=machine|web
iat / exp
```

relay 固定校验 algorithm、audience、issuer、relayId 和 claims shape。token 只允许加入单一 machine room；Web 不能注册 RPC，machine 不能伪造其他 machineId。日志不输出 token。

### 4. Relay 数据面

新增 `happy-server relay` 模式：只启动 `/health` 和 Socket.IO `/v1/relay`，不初始化 Prisma、auth provider、文件存储或 migrations。

- daemon room：`machine:<machineId>:daemon`，同一 machine 新连接替换旧 epoch。
- web room：`machine:<machineId>:web`，允许多个浏览器。
- Web → daemon：`rpc-call`、`terminal-input`、`terminal-resize`、`terminal-close`。
- daemon → Web：`terminal-output`、`terminal-exit`、`terminal-activity`。
- relay 复用现有 payload 大小、字段、维度和账号速率护栏；只转发经过 allowlist 的事件。
- RPC method 必须以 token 的 `${machineId}:` 开头，并带有界 ack timeout；无 daemon 时立即返回明确错误。

### 5. 双连接客户端和兼容窗口

- daemon 保留 control socket 处理 durable update、machine state、alive、clipboard 等；另建 realtime relay socket，RPC handler 同时注册到两条路径，terminal output 在兼容窗口双发。
- Web 保留 control `ApiSocket`；新增按 machine 缓存的 realtime socket。`machineRPC` 和四类 terminal Web→daemon event 优先 relay，discovery/连接失败回退 control。relay 到达的事件进入现有 `messageHandlers`，UI 无需理解 transport。
- Web 一旦对 machine 建立 relay，忽略 control path 上该 machine 的 terminal output/exit/activity，避免双发重复；RPC ack 天然只走发起路径。

### 6. 可观测性与切换

- daemon 记录候选 id、RTT、选中 id、fallback 原因，不记录 URL credential/token。
- relay `/health` 返回 relay id/region/version；连接日志只含安全标识。
- Web verbose diagnostics 显示 machine → relay id 和 transport（regional/legacy）。
- terminal header 常驻一个紧凑 chip：regional 模式显示 relay id + browser↔relay RTT，legacy fallback 明示 `CONTROL`；连接态用 live accent，不能用颜色暗示未连接。
- relay 断线：terminal stream 立即使用仍在线的 control socket；machine RPC 不能在 ack 丢失后自动重放，因为 spawn/stop/write 可能已经执行，当前调用有界失败，后续用户重试在 cooldown 内走 control。daemon 继续保留 legacy socket并重新探测。切换不改变 terminal seq，现有 snapshot/fromSeq 机制负责补洞。

## 兼容矩阵与发布顺序

| Control/Relay | Web | CLI daemon | 行为 |
|---|---|---|---|
| 旧 | 新 | 新/旧 | discovery 404，新端自动使用旧 `/v1/updates`；功能不回归 |
| 新 | 旧 | 新 | daemon 双注册/双发，旧 Web 继续走 control |
| 新 | 新 | 旧 | 无有效 assignment，Web 回退 control |
| 新 | 新 | 新 | realtime 优先 regional relay；durable 数据仍走 control |
| relay 故障 | 新 | 新 | terminal event 立即回退；未知结果的 RPC 不自动重放，后续调用在 cooldown 内走 control |

发布顺序：

1. control/server（feature 默认关闭，保留 legacy handlers）；
2. 至少两个 relay，逐个健康检查；
3. Web（具备自动 fallback）；
4. CLI daemon（双注册/双发）；
5. 打开 `HAPPY_RELAYS_JSON`，重启 control 后 `vh-update`；
6. 观察一个完整兼容窗口后，另立事项移除双发和旧 realtime handler。

回滚：先清空 `HAPPY_RELAYS_JSON`，Web/CLI 自动退回 legacy；无需 schema downgrade。然后可独立回滚 Web、CLI、relay 和 control。

## 风险

1. **assignment 仅在 control 内存中**：第一版生产是单 control replica，daemon 20 秒内自愈；扩 control HA 前需把 registry 接到 Redis/KV，不能把当前实现宣传成 control-plane HA。
2. **双发造成重复输出**：新 Web 对已连接 relay 的 machine 丢弃 legacy terminal event；terminal seq 仍作为最终防重/补洞依据。
3. **恶意 relay URL/SSRF**：候选只来自 operator env，不接受客户端 URL；解析时要求绝对 http(s) origin、禁止 credential/path/query/hash。
4. **短 token 过期**：daemon 周期 claim；Web 按连接/失败重新取，不把长期 account bearer 发给 relay。
5. **relay 连接成功但 daemon 未注册完成**：RPC 返回 `machine_unavailable`，UI 保持已有错误反馈；不无限 pending。
6. **宣传超出现实**：README/Landing 必须注明 regional relay availability 取决于 Cloud 实际 PoP 或 self-host 配置，不写 SLA、GeoIP 或“全球零延迟”。

## 验收标准

- [ ] `happy-server relay` 在无 DATABASE_URL / master secret 时可启动，`/health` 暴露安全的 id/region/version。
- [ ] relay token 的过期、错误 audience/issuer/relayId、clientType/machineId 越权均被测试拒绝。
- [ ] daemon 并行探测、最低 RTT 选择、超时过滤、稳定 tie-break 有纯函数/假时钟测试。
- [ ] control route 验证 machine ownership，assignment TTL 和 token scope 有回归测试。
- [ ] 新 Web/CLI 对旧 server 自动回退；旧 Web/CLI 对新 server 保持可用。
- [ ] 两个本地 relay 的 E2E 证明 daemon 选择低 RTT relay，Web RPC 与 terminal 双向字节不经过 control realtime handler。
- [ ] relay 中断后 terminal stream 立即回退；未知结果 RPC 不重复执行，下一次显式调用走 legacy，cooldown 后可重新连接。
- [ ] terminal header 显示 relay/RTT/fallback，窄屏不挤出标题或操作按钮；不做 speculative local echo。
- [ ] wire、server、CLI、Web 全部门禁通过，CLI build 后 `--version` 运行成功。
- [ ] README/Landing 只在上述自动化与实际多节点验证完成后展示多地域 relay 亮点。

## 留真机验证项

- mac-office + 新加坡 relay：键入与方向键体感、实测 p50/p95 echo latency。
- 美国浏览器访问 mac-office：确认路径只跨洋一次往返，不再经中央 origin 二次绕行。
- relay 强制重启时，当前 terminal 的恢复时间、是否重复字符或丢 seq。
