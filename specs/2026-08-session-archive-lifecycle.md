# 会话归档生命周期

> 状态：Final
> 日期：2026-08-26 ｜ 关联 backlog：B-177 ｜ 前身：`fc3f4ac7`、`cce91657`

## 背景

生产中的普通对话在 UI 归档后会先消失，刷新后重新出现。2026-08-26 对指定会话做真实验证时，Web 已发出 `POST /v1/sessions/:id/archive`，主服务也成功处理；但仍在运行的 CLI 随后继续发送 `session-alive`，批处理再次把数据库 `active` 写成 `true`。

两次局部修复分别补了 archive HTTP commit 和 kill deadline，但没有改变根本模型：同一个 `Session.active` 同时表示“进程最近在线”和“用户希望它留在活动列表”，而心跳拥有覆盖用户归档的权限。

## 目标

- 用户确认归档后，任何旧进程、迟到心跳、缓存批处理或跨 replica 竞态都不能自动撤销归档。
- `killSession` 恢复为受精确 session identity 约束的可用 RPC；用户 socket 不能注册 RPC，session/machine socket 不能越权注册其他 scope。
- 只有明确的恢复操作能撤销归档；恢复失败不能留下假活跃状态。
- daemon 必须最终确认普通 session 进程已退出；tmux 关闭必须确认对应 tmux session 已不存在，UI 才能报告成功。
- server、Web、CLI 可按兼容顺序分阶段发布并独立回滚。

## 非目标

- 不把归档改成物理删除；消息、usage、access key 等仍保留。
- 不让服务端解密或解释客户端 metadata。
- 不借本次改造重写通用 presence、RPC transport 或历史会话列表 UI。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 归档 endpoint 只写 `active=false`，没有持久化独立的用户归档意图 | `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:350` |
| 心跳批处理无条件写 `active=true`，可覆盖刚完成的归档 | `packages/happy-server/sources/app/presence/sessionCache.ts:192` |
| `session-alive` 在校验账号拥有关系后立即排队并广播 active | `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts:108` |
| session socket 的 RPC registration scope 被传成 `undefined` | `packages/happy-server/sources/app/api/socket.ts:239` |
| RPC handler 在 scope 缺失时拒绝注册，且错误文案/测试明确限定 machine-only | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:190`、`rpcHandler.spec.ts:25` |
| CLI 的会话控制 handler 正是通过 session-scoped socket 注册 `sessionId:killSession` | `packages/happy-cli/src/api/apiSession.ts:140`、`packages/happy-cli/src/claude/registerKillSessionHandler.ts:18` |
| Web 的短时 inactive hold 只有 5 秒，设计上不能成为持久化正确性的来源 | `packages/happy-web-v2/src/sync/sessionArchiveHold.ts:1` |
| 显式恢复目前通过 machine RPC 启动旧会话，子进程不会先向 server 提交独立的 unarchive transition | `packages/happy-web-v2/src/sync/ops.ts:833`、`packages/happy-cli/src/daemon/run.ts:859` |
| daemon 的 session stop 发送一次 SIGTERM 后立即删除 tracking，没有验证退出或 SIGKILL 兜底 | `packages/happy-cli/src/daemon/run.ts:924` |
| tmux kill 忽略 `tmux kill-session` 退出码并无条件返回 RPC success，可能先隐藏 UI、后留下真实 tmux | `packages/happy-cli/src/terminal/webTerminal.ts:2465`、`packages/happy-cli/src/api/apiMachine.ts:419` |

## 设计

### 1. 拆分用户意图与在线状态

给 `Session` 增加 nullable `archivedAt`。字段只表达用户归档意图：

- `archivedAt = null`：允许 presence 更新 `active/lastActiveAt`。
- `archivedAt != null`：会话已被用户归档；对外始终 inactive，旧 session socket 不再有资格提交心跳或状态写入。

保留 `active` 作为在线/结束视图的兼容字段，避免一次性改写所有客户端数据结构。`archivedAt` 是 server-owned 明文字段，不放进客户端加密 metadata。

### 2. 归档成为服务端原子 transition

`POST /v1/sessions/:id/archive` 在同一数据库写入中设置 `archivedAt=now`、`active=false`、`lastActiveAt=now`。提交后：

1. 丢弃该 session 在本 replica 的 pending activity update；flush 使用 `where archivedAt IS NULL` 的条件更新，保证已收集的迟到 batch 也不能复活。
2. 通过 Socket.IO 的跨 replica room 能力断开该 session 的 session-scoped sockets。
3. 向 session 子进程和账号下的 machine-scoped daemon 广播 `session-archive` 控制事件，再向 user-scoped 客户端广播 inactive。

socket 认证对 session-scoped 连接读取 `archivedAt`：归档中的旧进程重连会被拒绝，因此不需要每个 heartbeat 都访问数据库，也不存在跨 replica 本地缓存失效窗口。

### 3. 恢复成为显式 transition

新增幂等 `POST /v1/sessions/:id/unarchive`，清空 `archivedAt` 但保持 `active=false`，直到新进程的第一条合法 heartbeat 才变为 active。

两个入口都必须覆盖：

- Web → machine `resume-happy-session`：先 unarchive 再启动，避免新子进程在 socket 认证时被 tombstone 拒绝；启动失败立即重新 archive，收敛回原状态。
- `very-happy resume` / daemon reconnect：新 CLI 在建立 session socket 前调用同一 endpoint；404 视为旧 server，不阻断启动。

为兼容旧 Web/CLI，新 server 在过渡期保留旧 `active` 响应形状；新字段不进入 wire。旧客户端仍可读取/归档。旧客户端对“已由新语义归档的会话执行恢复”无法提交显式 transition，因此发布必须 server → Web → CLI，并在 server rollout 后立即更新 Web 与 CLI/daemon；这是本次不可完全消除的短暂兼容窗口，部署与回滚章节必须明确验收。

### 4. 修复 RPC identity，而不是放宽注册

从已认证的 `ClientConnection` 纯函数推导 RPC registration scope：

- machine-scoped → 精确 `machineId`
- session-scoped → 精确 `sessionId`
- user-scoped → `undefined`，禁止注册

`rpcHandler` 使用中性的 authenticated scope 文案。测试分别覆盖 user 拒绝、machine/session 同 scope 接受、跨 scope 拒绝，防止再次把一种合法控制平面误判为越权。

### 5. Server 驱动本地资源终止与重连对账

Web 删除 kill-first RPC，只调用 server archive transition。DB commit 后：

- session-scoped 子进程收到 `session-archive` 后，经共享终止注册层执行 cleanup；Claude、Codex、Gemini、OpenClaw 和 ACP 使用同一路径。即使事件丢失，旧 socket 被断开，重连也会因 `archivedAt` 被拒绝并再次触发退出。
- machine-scoped daemon 收到同一命令后，按 session id 找到跟踪进程，先 SIGTERM，宽限期后仍存活则 SIGKILL，并在确认 PID 不存在后才移除 live tracking。
- daemon 每次 control socket 重连，把自己仍在跟踪的 session ids 分批提交给 `/archive-status` 对账，补杀断线期间漏掉的归档命令。
- daemon 重启时把持久化的 `hostPid` 与当前 Happy 进程 inventory 交叉验证；只有两者精确匹配才重新收养进 live tracking，既覆盖升级前已运行的旧 session，也避免 PID 复用误杀无关进程。

Server 状态正确性不依赖控制事件送达；daemon 资源收敛不依赖单次 push。

### 6. tmux 关闭以机器验证为准

`kill-terminal` 必须先执行 `tmux kill-session`，再用 exact target 的 `tmux has-session` 验证目标已不存在。只有验证成功后才能 detach、写 closed record/tombstone、从 daemon list 删除并返回 RPC success；命令失败或目标仍存在时保持原状态并向 Web 返回失败。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server + 旧 Web | 读取与归档保持原响应；新语义归档后的显式恢复在 Web 更新前不可用 |
| 新 server + 旧 CLI | 现有在线会话继续运行；归档后旧进程被阻断重连；CLI 更新前不支持直接恢复该会话 |
| 旧 server + 新 Web/CLI | unarchive 返回 404 时按旧语义继续；不发送旧端无法解析的 wire 字段 |
| 全新 | 归档持久、旧心跳不可复活、显式恢复可撤销归档 |

发布顺序：数据库 additive migration → server → Web → CLI tag/npm → `vh-update`。回滚时 Web/CLI 可先退；server 回滚后 nullable 列保留，待确认无回滚需求再决定是否清理，禁止同批 drop column。

## 风险

1. **短暂的旧客户端恢复窗口**：server 与 Web/CLI 发布间，旧端无法恢复已按新语义归档的会话。缓解：同一发布批连续发布，server 后立刻 Web、CLI、`vh-update`，不把中间态长期留在生产。
2. **归档断 socket 影响 cleanup 回写**：归档提交后 CLI 的 metadata archive stamp 可能无法经 socket 落库。缓解：server-owned `archivedAt` 才是正确性来源；metadata stamp 降级为展示/诊断信息。
3. **批处理竞态**：flush 可能已收集 heartbeat。缓解：数据库 update 使用 `archivedAt IS NULL` 条件，而不是只清内存 queue。
4. **恢复成功判定时序**：machine RPC 返回时子进程可能尚未接入 relay。缓解：unarchive 幂等；UI 以随后的 session presence 为在线依据，不把 RPC ack 本身展示为在线。
5. **SIGKILL 可能跳过进程 cleanup**：仅在 SIGTERM 宽限期后仍存活时升级；DB 已归档且 daemon 保留恢复信息，不以 cleanup 完成作为正确性前提。

## 验收标准

- [x] session-scoped `killSession` 注册与调用成功；user/cross-scope 注册仍被拒绝。
- [x] archive 与并发/迟到 heartbeat 的测试中，数据库最终保持 `archivedAt != null, active=false`。
- [x] archive 后旧 socket 被断开，自动重连在未 unarchive 前被拒绝。
- [x] offline CLI、kill timeout、kill ack 后 cleanup 失败三种情况下归档都不复活。
- [x] daemon 收到实时命令和重连对账两条路径都能终止已归档 session；顽固进程会从 SIGTERM 升级到 SIGKILL 并验证退出。
- [x] tmux kill 只有在 `has-session` 确认不存在后才返回成功；失败时 UI/daemon list 不提前隐藏。
- [x] Web machine resume 成功后可恢复；失败时不清 archive 状态。
- [x] CLI 直连 resume 在新旧 server 上均有明确兼容行为。
- [x] Prisma migration、server/Web/CLI 全部门禁通过，且无新 server npm 依赖。
- [ ] 生产发布后用新建测试会话完成 archive → 普通 reload → daemon heartbeat 周期后仍消失 → resume → 重新出现的真实验收。

## 留真机验证项

- 生产同账号真实执行归档、普通 reload、等待至少两个 heartbeat/batch 周期后确认不复活。
- 从“已归档”视图恢复同一会话，确认只出现一个活动行且消息历史不丢失。
