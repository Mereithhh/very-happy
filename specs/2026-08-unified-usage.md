# 统一 Usage 统计

> 状态：Final
> 日期：2026-08-26 ｜ 关联 backlog：B-208

## 背景

Usage 设置页目前看似有总 token、费用和趋势，但数据只从 Claude assistant
message 路径上报。同一会话还反复覆盖同一个 `claude-session` report，最终无法
得到完整会话累计；Codex 等 agent 已经产生 token-count 事件，却没有进入统计链路。
Owner 要求终端会话、普通会话和各种 agent 都能被看见，并升级展示质量。

## 目标

- Claude 的每次真实 API 调用按稳定事件 id 幂等累计到会话快照，重放不重复、同会话不覆盖。
- 支持把各 agent 的累计 token-count 快照归一化并按会话幂等保存；未知字段安全忽略。
- 查询同时返回时间聚合和最小 report 明细，Web 用已解密的本地 session metadata 做
  会话形态/agent 归因，relay 不新增明文路径、机器名或会话 metadata。
- Usage 页展示总量、费用、会话数、终端数、时间趋势、agent 分布、会话形态和
  token 类型；未知成本不伪造为 `$0.00`。

## 非目标

- 不向 relay 公开解密后的 session metadata。
- 不为没有 token-count 的 provider 猜 token 或费用。
- 不把 shell/纯 TUI 的字节数冒充 LLM token；终端只计会话数量与活跃形态。
- 不在本次引入第三方图表依赖，也不承诺 provider 账单级成本对账。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude assistant message 有 usage 时调用 `sendUsageData` | `packages/happy-cli/src/api/apiSession.ts:525` |
| 上报 key 固定为 `claude-session` | `packages/happy-cli/src/api/apiSession.ts:711` |
| UsageReport 唯一键为 account/session/key，重复 key 更新覆盖 | `packages/happy-server/prisma/schema.prisma:286`、`packages/happy-server/sources/app/usage/usageStore.ts:72` |
| 查询按 report `createdAt` 归桶，而更新只改变 `updatedAt` | `packages/happy-server/sources/app/api/routes/accountRoutes.ts:244` |
| Codex app-server 已把 tokenUsage notification 转成 `token_count` | `packages/happy-cli/src/codex/codexAppServerClient.ts:331` |
| Codex session mapper 当前明确跳过 token_count | `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts:434` |
| ACP 官方 SDK 在 `PromptResponse.usage` 提供 Gemini/OpenCode/custom agent token | `node_modules/@agentclientprotocol/sdk/schema/schema.json` 的 `PromptResponse`/`Usage` |
| Web session 持有已解密 flavor/startedBy 与 createdAt | `packages/happy-web-v2/src/sync/storageTypes.ts:139` |
| 终端 push/closed record 持有 createdAt/closedAt，但没有 LLM token 语义 | `packages/happy-cli/src/api/types.ts:184` |

## 设计

### 上报模型

保留现有 `usage-report` socket 事件与 UsageReport JSON 结构，不做数据库迁移：

- Claude 会话累计快照：沿用 key `claude-session`。CLI 以稳定 message uuid/id 在进程内
  去重并累计每次 API-call usage；JSONL 完整回放可幂等重建快照。每个 Happy session 只占
  一条 UsageReport，避免按调用增长并耗尽账户 report quota；沿用旧 key 也避免升级后同一
  会话的新旧记录被查询层重复求和。
- 其他 agent 累计快照：key 为 `usage:<flavor>:session`。归一化器接受 Codex 的
  `tokenUsage.total`、ACP `PromptResponse.usage`、OpenClaw session token 字段及兼容的
  snake/camel case；只保存有限非负数。累计快照继续 upsert，
  因此 notification 重复或 daemon 重连不会重复累计。
- report key 同时是无敏感信息的 agent 归因；模型只在已有可靠字段时附加到 key 的安全片段，
  否则显示 agent 级别，不猜模型。

### 查询模型

`POST /v1/usage/query` 保留原 `usage`、`groupBy`、`totalReports` 字段，并新增 `reports`：
`{ key, sessionId, timestamp, tokens, cost }[]`。timestamp 使用 `updatedAt`，时间过滤和聚合也
使用 `updatedAt`，让累计快照落入实际更新窗口。旧客户端忽略新增字段。

### Web 聚合与展示

纯函数接收 reports、sessions、terminal push/closed records 和窗口：

- token/cost 仍以 reports 为真值；report key 解析 agent。
- sessionId 与本地已解密 session join 得到 flavor、startedBy、terminal-mirror/assistant 标签。
- 普通会话按窗口内 `createdAt` 计数；终端以 terminal records 去重计数，terminal mirror
  归到“终端 agent”，不同时算成普通会话。
- 未知 agent 显示 `unknown`；缺 cost 就显示 `—`；无 usage 但有会话仍展示会话统计和
  “尚未采集 token”，不能整页误报无数据。

视觉沿用 Console tokens：高密度 mono 数字、发丝边、无渐变/发光；唯一 accent 只用于
当前 period 和 hover/focus。趋势条用中性层级，agent/形态采用文字标签与长度共同编码，
不只靠颜色。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Server + 旧 CLI | 旧固定 key 继续保存；查询按 updatedAt 修正归桶，并返回可忽略的 reports |
| 旧 Server + 新 CLI | 新 Claude/agent snapshot key 均满足旧 schema，正常保存 |
| 新 Web + 旧 Server | `reports` 缺失时回退旧 aggregate，只展示能证实的 token 类型与本地会话统计 |
| 旧 Web + 新 Server | 忽略 `reports`，原 usage 列表继续可用 |

发布顺序：Server → Web → CLI。回滚任一层不会破坏旧字段；新 key 只会成为旧 Web 正常求和的
UsageReport 行。CLI 回滚后新 report 保留，旧固定 key 继续更新。

## 风险

1. Provider token-count 形状漂移：归一化器严格白名单字段、有限非负数，fixture 覆盖常见形状；
   无法识别时不写入而不是猜。
2. Claude assistant usage 是否为单次而非累计：其 SDK/JSONL shape 是 assistant API-call usage；
   稳定 message id 在会话累计器内去重，并用重放测试防重复。
3. 历史数据无法补齐：旧固定 key 只能保留现状并标为 legacy，不伪造历史；新版本起完整记录。
4. 终端历史只保留 daemon 已知的 live + capped closed records：UI 口径显式写“本期可见终端”，
   不宣称账单级全历史。

## 验收标准

- [ ] 同一 Claude 会话两条 assistant usage 累计到同一 key，重放其中一条不重复累计。
- [ ] Codex `tokenUsage.total` 累计快照、ACP `PromptResponse.usage` 与兼容 snake_case token-count 能归一化；非法/负数被拒绝。
- [ ] Server 时间过滤、归桶和 report timestamp 使用 updatedAt，并保持旧 response 字段。
- [ ] Web 同时显示普通会话、终端、Claude/Codex/Gemini/OpenCode/OpenClaw/ACP/unknown 的可证实统计。
- [ ] 无 token 但有终端/会话时仍有有效页面；未知费用显示 `—`。
- [ ] Web、CLI、Server 质量门禁通过，wire 若改动则 build/test 通过。

## 留真机验证项

- Usage 页在 390px 移动端和桌面深/浅主题的密度、横向溢出、tooltip 可读性。
