# 一条连接只有一个 socket + 会话改写以持久状态收敛

状态：Final · B-543 / B-544 · 2026-10-11

## 问题（Owner 2026-10-11 实报，100% 复现）

会话 `cmun0cigo3i10mx2k2qilljpn`（dev-sg，wrapper pid 2775017，CLI 0.2.16x，10-06 起）编辑 T-3 再发送 →「没能改写对话。 operation has timed out」。同一 wrapper 的所有 session RPC（bash 也是）自 10-10 14:38 +08 起全部 30 s 超时。

### 证据链

1. wrapper 日志：两次 `conversation-rewind` 都在 0.1–0.9 s 内 `Handler returned` + `Sending encrypted response`。
2. server（green）同一毫秒：`Multiple RPC sockets found during handover; preferring the epoch owner`，30 s 后 `rpc-failed code=timeout`。今天 6 条该告警全部是这个 wrapper（4 bash + 2 rewind）。
3. Redis 流 `vh:socket.io` 只有一个 adapter uid（green 单进程）⇒ 两个 socket 都在 green 本地。
4. dev-sg 上 pid 2775017 只有 **1 条** TCP（到 CloudFront）⇒ 两个 server socket 共用同一条 engine 连接。
5. wrapper 在 10-10 14:38:29 部署切换时断线，`startSmartReconnect` 3 s 内调了两次 `socket.connect()`（日志两行 `Attempting reconnect`）。

### 根因（本地复现，`skills/tmp/xuchen-ios/dupconnect/repro.cjs`，socket.io 4.8.3 server + client）

- **client**：`Socket.connect()` 在 manager 已 `open`、本 socket 的 CONNECT 还没被确认时会**再发一个 CONNECT 包**（`socket.io-client/build/esm/socket.js` `connect(): if ("open" === this.io._readyState) this.onopen()`）。重连时 server 接纳慢（鉴权/连接限额/B-494 有界恢复排队）超过 3 s，`setInterval` 就会第二次 `connect()`。
- **server**：同一 engine client 上同一 namespace 的第二个 CONNECT 生成第二个 `Socket`，`client.nsps.set('/', 新)` 覆盖路由，但第一个 `Socket` 仍在 `nsp.sockets`、所有 room（含连接态恢复带回的 RPC room）和 eventRouter 里——**孤儿**：server 发给它的包照样经同一条线送到 client，但 client 回的 ack 被路由给新 socket，孤儿上的 `emitWithAck` 必然超时。
- **RPC 选路**：`rpcHandler` 按 `handoverEpoch` 字符串降序挑一个；两个都是 `''` 时稳定排序取先注册的孤儿 ⇒ 100% 超时。
- 复现输出：`room 2 / sockets 2 / engines 1`；孤儿 `emitWithAck → operation has timed out`，新 socket → `done`；client 两次都执行了 handler。

### 次生问题：改写在 agent 侧生效、页面侧未生效

`conversation-rewind` 的设计是「agent 先改（RPC），成功回执到达后 web 再写 `transcript-drop` tombstone 并发送新文本」。回执丢失 ⇒ wrapper 已切到截断副本（`4a931804…`，只到 T-4），web 没写 tombstone、没发新文本：agent 忘了 T-3..T-1，页面仍显示。原 JSONL `8208b899…` 未被修改。任何「回执丢失」（不只孤儿 socket：断网、30 s 超时、标签页关闭）都会造成同样的分裂。

## 方案

### A. 传输不变量：一条 engine 连接、一个 namespace，至多一个 socket（B-543）

1. **client 不再重复 CONNECT**（CLI `apiSession` / `apiMachine` / web `apiSocket` 所有手动 `connect()`）：抽纯模块 `socketConnectGuard`：
   - `connect()` 前若 `socket.connected` 或「已发 CONNECT 未决」→ 不发；
   - 未决超过 `CONNECT_PENDING_MAX_MS`（15 s）→ 视为卡死：`socket.disconnect()` 关掉整个 engine 再 `connect()`（新 engine，不会在旧线上叠第二个 CONNECT）；
   - 状态在 `connect` / `connect_error` / `disconnect` 事件里清。
2. **server 强制不变量**（兜住旧 CLI / 旧 web 标签页）：`connection` 时检查 `socket.client` 上同 namespace 的其它 socket（孤儿），立即逐个驱逐：离开全部 room、移出 eventRouter/连接计数、触发与普通断开相同的清理，但**不**向线上发 DISCONNECT 包（那会让 client 以为当前 socket 被踢），也**不**改动新 socket 的 `client.nsps` 映射。实现依赖 socket.io 4.8 私有字段，必须有集成测试钉住（真 server + 真 client 复现上面的双 CONNECT，断言驱逐后 room=1、RPC 成功、client 未收到 disconnect）。驱逐计数指标 `socket_orphans_evicted_total` + 日志。
3. **RPC 选路**：候选里先排除本地孤儿（`target.client.nsps.get(nsp) !== target`），再按 `handoverEpoch`、最后按连接时间（新者优先）。告警文案区分「真 handover（epoch 不同）」与「同 epoch 多 socket（异常）」。
4. **存量自愈**：server 部署切换本身让所有连接重连，新连接经 2 驱逐，存量孤儿随旧槽消失；另加低频清扫（60 s）驱逐本地孤儿，覆盖不经部署就产生的情况。

### B. 会话改写：先「暂定」，以持久日志确认，否则自动回滚（B-544）

不变量：**agent 的对话 = 服务端日志里可见的用户消息**。回执只是快速路径，正确性只依赖持久状态。

1. **请求 id**：web 每次编辑/删除生成 `requestId`，随 RPC 参数下发，并写进随后的 `transcript-drop` tombstone（`requestId` 新可选字段；旧端忽略）。
2. **wrapper 暂定**：rewind 成功后在 session metadata 写 `rewind: { requestId, action, sourceClaudeSessionId, claudeSessionId, at, state: 'pending' }`（metadata 走 server 的版本化更新，不依赖 RPC 回执），再回执。
3. **确认 / 回滚**（wrapper 内，纯函数 `rewindReconcile` 判定）：
   - 观察到带同一 `requestId` 的 tombstone → `state: 'confirmed'`；
   - `at + REWIND_CONFIRM_MS`（120 s）仍未见 tombstone → 切回 `sourceClaudeSessionId`（源 JSONL 从未改动）、`state: 'reverted'`，静默重启 query；
   - 暂定期间到来的新 prompt 先等判定（排在 tombstone 之后的 prompt 本来就晚于 tombstone 到达，按 seq 处理即可）。
4. **web 快速路径修补**：RPC 报错/超时时，不直接判失败——在 10 s 内看 metadata `rewind.requestId` 是否等于本次：是 → 照常写 tombstone + 发送（wrapper 随后确认）；否 → 报失败。两条路径收敛到同一结果：要么两边都改了，要么两边都没改。
5. **启动对账（含存量会话）**：wrapper 启动 / 恢复时：
   - metadata 有 `state: 'pending'` → 按 3 判定（拉取 `at` 之后的 session 记录找 tombstone）；
   - **旧版本留下的分裂**（无 `rewind` 记录）：拉取服务端可见（未被 tombstone 覆盖）的用户消息 localId；若其中有 localId 在当前 JSONL 里找不到、却出现在当前 JSONL 所复制自的源 JSONL（行内 `sessionId` 指向的文件）里 ⇒ 当前文件是未确认的截断副本 → 切回源。只比较带 uuid（B-528 之后）的 prompt。
6. **定位跨 lineage**：若目标 prompt 不在当前 JSONL、但在其源 JSONL 中，rewind 从源出发（用户重试编辑在任何残留状态下都能成功）。

**B 实现备注（B-544 PR）**：纯规则在 CLI `claude/rewindReconcile.ts`，I/O 在 `claude/rewindReconciler.ts`（launcher 接线：`session.client.on('message')` 观察 tombstone、`nextMessage` 先 `settled()`、首次 launch 前有界 15 s 启动对账）。在上文之外：
- 判定前一律重读服务端日志尾部（500 条，`ApiSessionClient.readLogTail`）；读不到日志不回滚、继续等。暂定期间每 15 s 轮询一次。
- 回滚后（本进程内，或启动时 metadata 为 `reverted`）若日志里出现同 `requestId` 的 tombstone（web 发件箱迟到），重新切到改写副本并记 `confirmed`——以日志为准。
- 暂定中再次改写：新记录的 `sourceClaudeSessionId` 继承上一条未确认记录的源（回滚回到最后确认的对话）。
- 到期但 agent 已不在该副本上（`claudeSessionId` 不符）→ 不切换，记 `superseded`。`state` 为普通字符串。
- web 回退只认 `rewind.requestId` 相同且 `state` 不是 `reverted`/`superseded`；只有抛错（超时/断线）走回退，wrapper 明确拒绝（`ok:false`）与「方法不存在」不走。
- 启动 lineage 对账：当前 JSONL 行内最新的他者 `sessionId` = 源；仅当某可见 prompt 的 uuid 在源而不在当前时切回源；切回会忘掉分裂后只在副本里的 prompt（日志记录）。

## 兼容

| Web | CLI | 行为 |
|---|---|---|
| 新 | 旧 | 无 `rewind` metadata → 超时仍报失败（现状）；server 驱逐已修好传输，回执不再因孤儿丢失 |
| 旧 | 新 | 旧 web 不带 requestId、tombstone 也没有 → wrapper 对「无 requestId 的请求」保持旧语义（直接 confirmed），不自动回滚，避免误伤 |
| 新 | 新 | 完整 B 流程 |

server 无 schema 变化（metadata 为加密 blob；tombstone 为加密 session 记录）。发布顺序：server（A2–A4，立刻修好全部存量连接）→ web → CLI；CLI 生效需 wrapper 重启。

## 验收

- A：集成测试双 CONNECT → 驱逐后 RPC 成功、client 无 disconnect；`socketConnectGuard` 单测（未决不重发、超时整连重建）；mutation-check 钉住驱逐与选路。
- B：`rewindReconcile` 纯函数单测（confirm / 超时回滚 / 旧 web 无 requestId / 启动对账 lineage）；web 超时走 metadata 修补的单测。
- 真机：会话 `cmun0cigo3i10mx2k2qilljpn` 在 server 发布后 session RPC 恢复；wrapper 以新 CLI 重启后自动切回 `8208b899`，再编辑 T-3 成功。
