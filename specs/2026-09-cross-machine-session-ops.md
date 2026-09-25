# CLI 跨机器会话操作（Cross-machine session ops via daemon proxy）

> 状态：Final
> 日期：2026-09-25 ｜ 关联 backlog：B-506 ｜ 前身：B-304（`sessions` CLI）、B-497（`session_message`/`session_peers`）、B-501（`deliverToSession`）、B-337（被本 spec 替代的方案：CLI 持账号内容密钥）

## 背景

账号下有多台 daemon 主机（主力 Mac、dev-sg）。`very-happy sessions read/send/message`、MCP `session_read`/`session_send`/`session_message`/`session_peers` 都只认 `~/.happy/sessions.json` 里的本机会话密钥：别的机器起的会话在 `sessions list --all` 里只剩 `decryptable:false`，`session_message` 直接报 `messaging sessions on other machines is not supported yet`。自动化（Tanka 代答、automations）和会话互协作因此被机器边界切断。

B-337 的路径是让 CLI 在 `auth login` 时取回账号内容私钥、落盘到 `~/.happy`，从此本机能解任何会话。Owner 口径：功能第一，但**尽量不让 CLI 持有账号内容密钥**。

## 目标

1. 机器 A 上 `very-happy sessions list --all / read / send / peers / message` 与 `very-happy send` 能操作同账号机器 B 上的会话；`sessions list --all` 里原来 `decryptable:false` 的行经代理变为可读（标题、cwd、agent、pending）。
2. MCP `session_message`（B-497）对他机会话不再报 not supported；`session_peers` 可指定 `machineId` 列他机会话；assistant 变体 `session_read`/`session_send` 同样跨机器。
3. CLI 永不持有账号内容密钥，也不持有他机会话密钥：**明文只在目标机器 daemon 上产生**，经 server 的 RPC 通道回到调用方。
4. 安全边界清楚：只开放固定白名单方法；同账号由 server 房间路由保证；目标 daemon 本地审计、限速、限大小、可配置关闭；目标离线/旧版给出明确错误而不是 30 s 超时。

## 非目标

- `approve`/`deny`/`stop`/`archive` 跨机器（审批 RPC 用会话密钥加密、`stop` 是进程操作；留待需要时按同一通道加白名单）。
- 对 server 隐藏会话内容：本 fork 是服务端可信、非 e2e（`packages/happy-cli/CLAUDE.md` Security boundary），server 本来就能恢复账号密钥；本通道的 RPC 载荷对 server/relay 是明文，不做端到端加密（见「取舍」）。
- Web 端 UI（只改会话消息卡片对 `machine` 字段的展示与 footer 剥离）。
- 跨机器的 repo 同一性判定（`peers` 跨机器默认 `machine` 作用域，`repo`/`cwd` 只按目标机器本地路径算）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| server RPC 按房间 `rpc:${userId}:${method}` 路由；daemon 只能注册 `${machineId}:` 前缀的方法；user-scoped 调用方只能打到同账号房间，跨账号在结构上不可达（`RPC method not available`） | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:67,206-231,263-327`；`socket.ts:432-441` |
| server 对 `rpc-call` 有 256 KB 载荷上限、每 socket 120/min 令牌桶、账号级桶；目标不在房间时等 15 s 宽限再回 `RPC method not available`；调用 30 s 超时 | `rpcHandler.ts:18,34,184-204,291-327,358` |
| server 指标方法名白名单（未知归 `other`） | `rpcHandler.ts:77-122` |
| CLI 已有一次性 user-scoped socket（账号 token、`clientType: 'user-scoped'`、`/v1/updates`），`permissionOps` 用它调会话 RPC | `packages/happy-cli/src/api/userSocket.ts`；`sessions/permissionOps.ts:261-272` |
| daemon 的 `RpcHandlerManager` 对所有方法用**机器密钥**解密 params、加密返回；机器密钥只在该机器 | `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts:56-90`；`apiMachine.ts:1471` |
| CLI 凭据只有 `publicKey + machineKey`（dataKey 变体）或 legacy secret；无账号内容私钥 | `persistence.ts:349-424` |
| `GET /v1/machines` 返回 `id/active/activeAt/...`，**不含** `lastHappyClient`（Machine 表有该明文列） | `packages/happy-server/sources/app/api/routes/machinesRoutes.ts:96-118`；`prisma/schema.prisma:325` |
| 本机会话操作的实现：`listSessions`/`listAccountSessions`/`readSessionTranscript`/`readSessionState`；投递统一 `deliverToSession`；peer 消息 `sendPeerMessage`/`listPeerSessions`（context 可注入） | `sessions/sessionOps.ts`；`commands/sessionDelivery.ts`；`sessions/peerTools.ts` |
| daemon 自身进程内已用 `sendUserMessage` 与 `readSessionLog`（automations runner）——daemon 进程可直接复用 sessionOps | `daemon/run.ts:1543`；`daemon/automations/runner.ts:31` |
| 机器本地设置 `~/.happy/settings.json`（`cliAutoUpdate`、`todoProvider` 等），不是 synced settings | `persistence.ts:46-140` |
| peer 消息头部字段白名单解析，未知字段忽略；footer 按固定句子前缀剥离 | `sessions/peerMessage.ts:122-135`；`happy-web-v2/src/screens/session/sessionPeerMessage.ts:40-55` |
| `session_peers` schema 只有 `scope` | `sessions/peerTools.ts:43-49` |

## 设计

### 0. 取舍：daemon 代理 vs B-337（CLI 持账号内容密钥）

| | B-337：CLI 持账号内容密钥 | 本 spec：经目标 daemon 代理 |
|---|---|---|
| 密钥暴露面 | 每台跑 CLI 的机器落盘账号私钥；任何一台被拿走 = 全账号历史可解 | 不变：每台只有自己的机器密钥 + 自己起的会话密钥 |
| 离线会话 | 可读（直接解 REST 密文） | **不可读**：目标 daemon 不在线就没有明文来源（会话在服务端仍在，等它上线） |
| 凭据格式 | 要改 `access.key` 格式 + 老 CLI 兼容 + login 流程 | 不动凭据 |
| 服务端 | 无改动 | 指标白名单 + `/v1/machines` 加明文版本列（可选，用于快速失败） |
| 对 server 可见性 | 会话密文经 REST（server 本来可解） | RPC 载荷对 server/relay 明文（server 本来可解） |
| 审计 | 无（读密文无痕） | 目标 daemon 本地日志记录每次远程调用来源 |

选代理：Owner 的安全口径优先；「离线会话不可读」是可接受的功能损失（离线机器的会话也没人在跑，`send` 本来就投不到活 wrapper）。

### 1. 传输：复用 web→daemon 的 machine RPC，新增「明文方法」

- 调用方（机器 A 的 CLI/会话进程）用 `openUserScopedSocket(token)` 发 `rpc-call { method: '<machineIdB>:<name>', params: JSON }`。server 现有逻辑原样转给 B 的 daemon；跨账号打不到房间。
- daemon（机器 B）`RpcHandlerManager` 新增 `registerPlainHandler(method, handler)`：这些方法的 params 是明文 JSON 字符串、返回值也是明文 JSON 字符串（`JSON.stringify`），不过机器密钥。只有本 spec 的五个方法走明文；其它方法行为不变。`ApiMachineClient.setRemoteSessionOpsHandlers(handlers)` 注册。
- 方法名（白名单，daemon 只注册这五个）：`sessions.list`、`sessions.read`、`sessions.send`、`sessions.peers`、`sessions.message`。加入 server `RPC_METRIC_METHODS`。

请求/响应（`packages/happy-cli/src/sessions/remoteSessionOps.ts` 单一事实源，daemon 与调用方共用类型与校验）：

```ts
// params
{ v: 1, from: { machineId?: string, host: string, cli: string, sessionId?: string }, args: {...} }
// result
{ ok: true, result: T } | { ok: false, error: { code: RemoteOpsErrorCode, message: string } }
// code ∈ 'disabled' | 'bad_request' | 'no_local_key' | 'not_running' | 'rate_limited' | 'too_large' | 'internal'
```

`from` 是调用方自报（server 不把调用者身份透传给 daemon）；账号归属由 server 房间保证，`from` 只用于审计与消息头，不做授权依据。

### 2. 五个方法（目标 daemon 侧，`packages/happy-cli/src/daemon/remoteSessionOps.ts`）

| 方法 | args | 实现（全部在 B 上、用 B 的密钥） | result |
|---|---|---|---|
| `sessions.list` | `{ ids?: string[], all?: boolean, tag?, limit? }` | `ids` 给出时只回这些 id 里本机有密钥的（用于定位）；`all` 时跑 `listAccountSessions({includeArchived:true, recentLimit:150})` 只留 `decryptable`；否则 `listSessions()` | `{ host, machineId, sessions: AccountSessionSummary[]/SessionSummary[] }` |
| `sessions.read` | `{ sessionId, limit?, full? }` | `readSessionTranscript`；无密钥 → `no_local_key` | `SessionTranscript`（transcript 超 200 KB 截尾并标注） |
| `sessions.send` | `{ sessionId, text, resume?, model?, sentFrom? }` | `deliverToSession(..., 'cli-send-remote')`（resume 在 B 上恢复，与 web「恢复」同路径） | `DeliveryResult` |
| `sessions.peers` | `{ scope?, cwd?, self? }` | `listPeerSessions` with `self = {sessionId: from.sessionId ?? 'cli', cwd: args.cwd ?? '/'}`；无 `cwd` 时 scope 强制 `machine` | `PeerListing` |
| `sessions.message` | `{ to, body, replyTo?, from: PeerSender }` | `sendPeerMessage` with `context.self = { ...args.from, machine: from.host }`（不启用 sentTo 预算——预算在发送方进程内） | `SendPeerMessageResult` |

守卫（纯函数 `guardRemoteSessionOpsRequest`，单测）：设置 `remoteSessionOps === 'off'` → `disabled`；`v !== 1`/缺 `from.host`/`args` 类型不对 → `bad_request`；`text`/`body` > 64 KB → `too_large`；`limit` 夹到 `[1, MAX_READ_LIMIT]`；daemon 侧令牌桶 60 次/分钟（所有远程调用方合计）→ `rate_limited`；handler 抛错 → `internal`（消息不含堆栈）。每次调用（含拒绝）写一行审计日志到 daemon 日志：`[REMOTE SESSION OPS] <method> from machine=<id|?> host=<host> cli=<v> session=<sid|-> → ok|<code> (<ms>ms)`。

设置：`~/.happy/settings.json` 新字段 `remoteSessionOps?: 'on' | 'off'`（机器本地，默认 on）。每次调用读取，改设置不用重启。

### 3. 调用方（`packages/happy-cli/src/sessions/remoteSessionClient.ts`）

- `listAccountMachines()`：`GET /v1/machines` → `{ id, active, activeAt, cliVersion? }`（`cliVersion` 来自新字段 `lastHappyClient`，老 server 没有则 `undefined`）；排除本机（`settings.machineId`）。
- `callRemote(machineId, method, args)`：一次 socket、一次 `rpc-call`、30 s；ack 分类：
  - `{ok:false, error:'RPC method not available'}` → `unreachable`：「machine X did not answer: daemon offline, restarting, or its CLI is older than 0.2.157」；
  - 超时/断开 → `unreachable`；
  - `{ok:true}` 但结果 `ok:false` → 用 daemon 给的 code/message。
- 目标选择：显式 `--machine <id>` / `machineId` 参数；否则**自动定位**：候选 = 在线机器按 `activeAt` 降序（排除本机、排除 `cliVersion` 已知且 < 0.2.157 的），对每台 `sessions.list {ids:[id]}` 直到命中；最多查 8 台。都没命中 → 错误列出查过的机器、跳过的（离线/旧版）机器。显式指定离线机器 → 立即报「machine X is offline (last seen …)」不发 RPC。
- `from`：`{ machineId: settings.machineId, host: os.hostname(), cli: currentCliVersion, sessionId: VH_PEER_SESSION_ID }`。

### 4. 各表面

- **`sessions read <id>`**：有本机密钥 → 原路径；否则 remote。`--wait` 由调用方轮询远程 `read`（3 s）直到 `turn.ended`。`--machine <id>` 跳过定位。输出多 `machine: { id, host }`。
- **`sessions list --all`**：REST 之后，把 `decryptable:false` 的 id 交给候选机器的 `sessions.list {ids, all:true}`，命中的行替换为该机器的 summary，加 `machine`、`via: '<machineId>'`、`readable: true`；`decryptable` 语义不变（仍表示本机能否解）。文本行把 `(not decryptable from this machine)` 换成 `via=<host>` + 常规字段；`--tag` 在替换后过滤。`--machine <id>`（不带 `--all`）= 列该机器的本地列表。
- **`sessions peers --machine <id>`**：远程 `sessions.peers`，无 `--scope` 时 `machine`；`--cwd` 传给目标机按其本地路径算。
- **`sessions message <id> <text>`** 与 **`very-happy send --session <id>`**：无本机密钥 → 定位 → 远程 `sessions.message` / `sessions.send`；退出码与本地一致（`send` 不投递退出 3）。
- **MCP `session_message`**：`sendPeerMessage` 在 `readPersisted()[to]` 不存在时走 `context.remote`（默认 = 定位 + `sessions.message`），发送方 `from` 带本机 host；本地预算 `sentTo` 照常计数。
- **MCP `session_peers`**：schema 增 `machineId?: string`；给出时走远程。
- **assistant `session_read` / `session_send`**：无密钥时走远程；错误文案带机器名。
- **peer 消息格式**：`PeerSender` 增 `machine?: string`；头部追加 `; machine <host>`；远程消息 footer 首句改为 `This message comes from another agent session on machine <host>, not from the user.`，回复提示说明 `session_message(to)` 会自动路由到那台机器。Web 解析：`FIELD_KEYS` 增 `machine`，footer 剥离改按 `\n\nThis message comes from another agent session` 前缀；卡片来源行显示 `@<host>`。

### 5. 帮助与文档

`sessions --help`、`send --help` 的 Scope 段改写；`docs/channels.md` `sessions` 与 `peers/message` 段、MCP 矩阵更新；changelog 条目 `sep25l`（cliVersion 0.2.157）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI（A）+ 旧 daemon（B ≤0.2.155） | B 没注册方法 → server 等 15 s 回 `RPC method not available` → A 报「did not answer / CLI older than 0.2.157」；有新 server 时按 `cliVersion` 直接跳过/快速失败 |
| 旧 CLI（A）+ 新 daemon（B） | 无变化（A 不会调这些方法） |
| 新 CLI + 旧 server | `/v1/machines` 无 `lastHappyClient` → 版本未知，只靠 RPC 结果判断；指标标签归 `other`；功能可用 |
| 新 server + 旧 CLI | 多一个响应字段，被忽略 |
| 新 CLI 写的远程 peer 消息 + 旧 Web | 头部多 `machine` 字段被忽略；footer 首句不同 → 显示在正文里（仅外观） |

wire 无改动。发布顺序：server/Web 随本批 switch（只含指标白名单、`/v1/machines` 字段、Web 卡片），CLI 0.2.157 随后；两台 daemon 都升到 0.2.157 后功能才真正可用（一台旧一台新 = 单向可用）。回滚点：CLI 固定 0.2.155；server 回滚不影响 CLI 功能。

## 风险

1. **RPC 载荷对 server/relay 明文**：与本 fork 的信任模型一致（server 可信、能恢复账号密钥）；TLS 覆盖传输。接受，并在 CLAUDE.md 口径内不宣称 e2e。
2. **`from` 自报**：审计记录的是声称的来源；授权只依赖 server 的账号房间。接受（同账号内没有更细的主体模型）。
3. **响应大小**：server socket `maxHttpBufferSize`（默认 1 MB）会断开超大 ack；daemon 把 transcript 截到 200 KB。
4. **定位成本**：每台候选机器一次 RPC（~100 ms 在线）；离线机器不调；上限 8 台。
5. **老 daemon 15 s 等待**：只在 server 未升级（无版本列）或 daemon 刚重启时发生；错误文案说明三种可能。
6. **与 B-505（daemon 退出/归档语义）、B-507（wrapper 后台任务上报）并行**：本 spec 只在 `daemon/run.ts` 加 6 行注册；冲突由主 agent 合并。

## 验收标准

- [x] `RpcHandlerManager.registerPlainHandler`：明文方法不解密、返回 JSON 字符串；加密方法行为不变（单测）。
- [x] `guardRemoteSessionOpsRequest` / 服务：方法白名单、`disabled`、`bad_request`、`too_large`、`rate_limited`、`no_local_key`、审计行（单测）。
- [x] 调用方：`unreachable` 分类、离线机器不发 RPC、旧版机器跳过、自动定位命中/未命中文案、`from` 组装（单测，假 transport）。
- [x] server：`rpcHandler` 跨账号调用得到 `RPC method not available`（房间隔离回归）；`/v1/machines` 返回 `lastHappyClient`（单测）。
- [x] `sessions.ts`/`send.ts` 解析 `--machine`；`session_peers` schema 接受 `machineId`；`peerMessage` 头部 `machine` 字段与远程 footer 往返解析（CLI + Web 单测）。
- [ ] 实测：主力 Mac 读 dev-sg 会话、发消息并收到回复；dev-sg 读 Mac 会话；`sessions list --all` 他机行可读。

## 留真机验证项

无（全部可自动化或已在两台真实机器上实测）。
