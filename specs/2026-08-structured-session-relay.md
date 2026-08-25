# 结构化会话 Regional Relay Fast Lane

> 状态：Final
> 日期：2026-08-26 ｜ 关联 backlog：B-199

## 背景

结构化 Claude 会话的输入和输出目前都经中心区 `/v3/sessions/:id/messages` 落库，再由中心区 `/v1/updates` Socket.IO 通知另一端。区域 relay 只承载 machine RPC 与终端事件，因此离中心区较远的 Web 和 runner 都多走一段中心区 realtime 往返。

目标不是绕开持久化，而是在保留中心库作为权威历史的前提下，让已持久化的结构化消息通过离 Web/runner 更近的 relay 直接交付。

## 目标

- Web→runner 的结构化消息优先经 session-scoped regional relay 交付。
- runner→Web 的结构化消息在中心库确认 `id/seq` 后优先经 relay 交付。
- session RPC 优先使用同一 session relay。
- 中心库仍是消息历史、排序和断线恢复的唯一权威来源。
- relay 缺失、旧端、超时或断线时自动回退现有中心链路；消息不丢、不重复执行。

## 非目标

- 不把数据库或 v3 message API 搬到 relay。
- 不在本批实现 Claude SDK token delta/partial streaming；relay 只降低已经产生的结构化 block 的传输延迟。
- 不更改消息密文格式，也不让 relay 解密正文。
- 不自动重放 ack 结果未知的可变 session RPC。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 发送正文进入 pending outbox，最终 POST 中心区 v3 messages | `packages/happy-web-v2/src/sync/sync.ts:590`, `packages/happy-web-v2/src/sync/sync.ts:1873` |
| CLI 从中心 update socket 收到 new-message 后解密并交给 runner | `packages/happy-cli/src/api/apiSession.ts:207` |
| CLI 输出经 v3 messages POST 持久化 | `packages/happy-cli/src/api/apiSession.ts:472` |
| Web session RPC 固定使用中心 socket | `packages/happy-web-v2/src/sync/apiSocket.ts:190` |
| relay token 只有 machine/web 两种角色且仅按 machine 分房 | `packages/happy-server/sources/app/relay/relayToken.ts:4`, `packages/happy-server/sources/relay.ts:43` |
| relay 当前仅转发 machine RPC 与终端事件 | `packages/happy-server/sources/relay.ts:96` |
| v3 messages 以 sessionId+localId 幂等并返回权威 id/seq | `packages/happy-server/sources/app/api/routes/v3SessionRoutes.ts:129` |

## 设计

### 1. Session-scoped relay 身份

relay token 新增 `session` client type，并在该类型 claims 中强制 `sessionId`。Control 提供 session assignment endpoint：同时验证 session 与 machine 都属于当前账号，并复用该 machine 已选择的 relay lease，签发短期 session token。session metadata 是密文，因此 control 不声称验证二者的 metadata 关联；错误组合只会得到没有 runner 的空 room。旧 machine/web token shape 保持有效。

relay 新增 `relay:<machineId>:session:<sessionId>` runner room。每个 session 只允许一个 runner socket；Web 继续复用现有 machine-scoped relay socket。所有 session event 都校验 token 中的 machine/session scope、payload 大小与速率，正文保持 session-key 密文。

### 2. Web→runner：relay 交付，runner durable-before-execute

Web outbox 仍以 `{localId, content}` 保存。flush 时若 session 有 `machineId`：

1. 尝试通过 machine relay 发 `session-message-deliver` batch，并等待有界 ack。
2. runner 在收到 batch 后，先以相同 localId POST 中心区 v3 messages。
3. 中心区成功返回权威 id/seq 后，runner 才解密并按顺序交给 agent queue，并把权威结果 ack 给 Web。
4. Web 收到成功 ack 后移除 outbox、推进 lastSeq。
5. relay 不可用、无新 runner、超时或失败时，Web 用原 v3 POST 路径提交。localId 唯一约束使“runner 已提交但 ack 丢失”的回退仍幂等。

runner 在发起 v3 POST 前把 batch localId 标为 direct-in-flight；其中心 update/fetch 路径见到这些 localId 时只推进 seq，不再次交给 agent。成功后每个消息只 route 一次；失败则清掉标记且不执行。

### 3. runner→Web：persisted authoritative direct push

CLI output outbox 仍先 POST v3 messages。拿到返回的权威 `id/seq/localId/createdAt` 后，CLI 将权威 envelope 与原密文通过 `session-message-committed` 发往 relay Web room。Web 直接走现有 decrypt/normalize/reducer；如果中心 update 先到或后到，二者因相同 server id 被现有 reducer 幂等去重。relay 推送失败不影响 central durable update。

### 4. Session RPC

session runner 在中心 socket和 session relay 同时注册相同 RPC handler。Web `sessionRPC` 根据 session metadata 的 machineId 优先 relay；若 relay 不可用则使用中心 socket。若 relay 已发出但 ack 丢失，与 machine RPC 一样不在同一次调用内自动重放可变请求，进入短暂 cooldown，下一次显式操作才走中心兼容路径。

### 5. 能力与观测

新 Web 只有在 relay 存在 session runner 时才走 fast lane，旧端不需理解新事件。新增按 transport/direction/result 的计数与延迟日志/指标，至少能区分 relay delivered、central fallback、runner persist latency 与 ack timeout；不能仅凭体感声称 Claude SDK TTFT 已改善。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 全旧 | 现有中心链路不变 |
| 新 control + 旧 relay | session relay 连接/事件不可用，新端回退中心 |
| 新 relay + 旧 control | 无 session token，不启用 fast lane |
| 新 Web + 旧 CLI | session room 无 runner，快速回退中心 |
| 旧 Web + 新 CLI | 输入仍中心；输出 relay 无消费者但中心 update 正常 |
| 全新 | structured input/output 与 session RPC 优先 relay，中心持久化与补偿保持 |

发布顺序：server/control+relay → Web → CLI → `vh-update`。server/relay 可独立回滚；Web/CLI 任一回滚后中心链路仍可工作。

## 风险

1. **direct input 与中心 update 竞态导致重复执行**：runner 在 POST 前登记 localId，update/fetch 都按 localId 去重；覆盖 direct-first/central-first 测试。
2. **ack 丢失导致 Web fallback 重复写入**：沿用 v3 的 localId 唯一约束；runner 只执行自己成功持久化的 batch 一次。
3. **输出两路抵达顺序不定**：relay 携带中心返回的同一 server id/seq，复用 reducer message-id 去重。
4. **旧 CLI 让每条消息等待 relay timeout**：session delivery 使用短超时和 per-session cooldown；首次失败后直接中心，直到能力/连接状态变化。
5. **跨 session 注入**：token 强绑定 account+machine+session，relay 对 room/event/payload 全量校验。
6. **用户仍感到模型首字慢**：本批不伪称支持 token streaming；用分段指标区分 transport 与 SDK TTFT，partial streaming另立 spec。

## 验收标准

- [ ] token/schema 向后兼容测试及 session claims 强校验通过。
- [ ] assignment ownership、lease、expiry 与跨账号/跨 session 拒绝测试通过。
- [ ] relay 双向消息、single runner、payload/rate limit 测试通过。
- [ ] CLI direct-first/central-first 去重、durable-before-execute、输出权威双发测试通过。
- [ ] Web relay success、旧 CLI 快速 fallback、ack 丢失幂等 fallback、输出双路去重测试通过。
- [ ] session RPC relay/fallback 与“未知结果不自动重放”测试通过。
- [ ] 本地 E2E 证明 relay 成功路径下输入/输出即时交付且中心库最终历史完整有序。
- [ ] Web、CLI、server 全部门禁通过。

## 留真机验证项

- 跨区域生产账号对比 structured relay 前后 transport latency；同时记录 SDK TTFT，避免混淆模型生成耗时。
