# 分叉会话首条消息排序（fork backfill 确认）

> 状态：Final（随实现 PR 定稿；合并后回标 Shipped）
> 日期：2026-10-04 ｜ 关联 backlog：B-531 ｜ 前身：B-492（`very-happy spawn --fork`）、B-464（Codex fork 回放）

## 背景

`very-happy spawn --fork <sessionId> --prompt-file <f>`（claude flavor）后，Web 上首条 prompt 被排进回放历史中间，看起来像两条 query 连在一起。
dev-sg 生产事故（very-happy-cli 0.2.162，会话 `cmut7a4h411t2o52kvfutcc7w`，wrapper 日志 `~/.happy/logs/2026-10-04-10-27-08-pid-1072090.log`）：

| 时刻 | 事件 |
|---|---|
| 10:27:09.052 | wrapper `/session-started` 上报 daemon → daemon 回 `/spawn-session`，CLI 立即进入发首条消息 |
| 10:27:09.549 | `[FORK BACKFILL] Replayed 95 historical messages`（只是**入队**，outbox 异步上传，50 条一批） |
| 10:27:09.690 | wrapper 已收到 CLI POST 的首条 prompt（`User message pushed to queue`） |

服务端 seq 在 POST 被处理时分配；CLI 的 prompt 是一个小 POST，比回放第二批先到，于是 seq 落在回放中间。
Claude JSONL 里 prompt 只有一条，`consumeAppPrompt` 去重正常——不是重复，是顺序。
seq 是所有客户端唯一的排序依据（AGENTS 关键约束 15），因此这是永久错位，不是显示问题。

## 目标

- 带 prompt 的 fork：首条消息必须在回放**全部被服务端接受（已分配 seq）**之后才发出。Claude 与 Codex 两条回放路径都覆盖。
- 宁可晚发不乱序：确认不到就**不发**，明确报错（退出码 2），会话保留。
- 双向兼容：新 CLI + 旧 wrapper、旧 CLI + 新 wrapper 都不卡死、不崩。
- 非 fork 的 spawn 行为与耗时不变。

## 非目标

- 不改服务端 seq 分配，不加 server 字段/路由（server 不感知本特性）。
- `very-happy send` 发往一个**刚 fork、回放仍在上传**的会话不在此修（见风险 3）。
- Web composer 不做发送闸门（Web 路径没有自动首条消息，见「Web 路径」）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| spawn 在 daemon 返回后立即发首条消息（`waitForSessionKey` → `sendUserMessage`，`cli-spawn`） | `packages/happy-cli/src/commands/spawn.ts` `sendFirstMessage` |
| daemon 在 wrapper 的 `/session-started` webhook 之后才回 `/spawn-session`，webhook 早于回放 | `packages/happy-cli/src/claude/runClaude.ts` `notifyDaemonSessionStarted`（回放在 `loadDeps()` 之后） |
| Claude 回放：逐行 `session.sendClaudeSessionMessage`，只入队不等上传 | `runClaude.ts` `[FORK BACKFILL]` 段 |
| Codex 回放更晚：在 `client.connect()`、`listModels()`、`resumeExistingThread` 之后才 `readThread` + `sendSessionProtocolMessage` | `packages/happy-cli/src/codex/runCodex.ts` `[CODEX FORK BACKFILL]` 段 |
| outbox FIFO 上传，50 条/批，POST 返回后才从队列移除；服务端按到达顺序分配 seq | `packages/happy-cli/src/api/apiSession.ts` `flushOutbox` |
| `session.flush()` 有 10s 超时兜底，不能证明已上传 | `apiSession.ts` `flush()` |
| wrapper spawn 时的 metadata（含 `capabilities`）经 webhook 落进 `~/.happy/sessions.json`，spawn 已用它解析首条消息 meta | `spawn.ts` `persisted.metadata?.capabilities` |
| CLI 读服务端当前 metadata 的现成函数 | `packages/happy-cli/src/sessions/sessionOps.ts` `readSessionMetadata` |
| Web 解密 metadata 用 zod `MetadataSchema.safeParse`（strip 未知字段），改名/优先级写回的是解析后的对象 | `packages/happy-web-v2/src/sync/encryption/sessionEncryption.ts` `decryptMetadata`；`sync/ops.ts` `sessionApplyMetadata` |

## 设计

### 协议

1. **能力宣告**：Claude 与 Codex wrapper 出生即在 `metadata.capabilities` 加 `fork-backfill-ack-v1`（`FORK_BACKFILL_CAPABILITY`），随 webhook 进 `sessions.json`。
2. **wrapper 侧**：fork 回放（`HAPPY_FORK_CLAUDE_SESSION_ID` / `HAPPY_FORK_CODEX_THREAD_ID`，非 reconnect）入队后，后台调用 `publishForkBackfillWhenCommitted`：
   - `ApiSessionClient.drainOutbox()`：等到**调用时已在 outbox 里的每条消息**都被服务端 POST 应答（已分配 seq）。之后入队的不延长等待。重试沿用 outbox 自身的 InvalidateSync backoff；客户端关闭则返回 false。
   - drain 成功后 `updateMetadata` 写 `forkBackfill: { done: true, count, failed?, completedAt }`。
   - 读不到回放源（JSONL 读失败 / `readThread` 失败）也写 `{ done: true, count: 0, failed: true }`，没有可排序的东西，立即放行 CLI。
   - 客户端在确认前关闭：**不写**标记。
   - 不阻塞 wrapper 启动（SDK / 首条消息处理照常），只影响标记写出的时刻。
3. **CLI 侧**（只在 `--fork` 且带 prompt 时）：`sendFirstMessage` 在 `waitForSessionKey` 之后调 `waitForForkBackfill`：
   - `sessions.json` 的 capabilities **没有** `fork-backfill-ack-v1` → 旧 wrapper，立即发送（旧行为）并在 stderr 打 warning。
   - 有能力 → 每 500 ms `GET /v1/sessions/:id` 解密 metadata，见到 `forkBackfill.done === true` 才 POST；读错误重试到截止。
   - **120 s 超时 → 抛 `ForkBackfillTimeoutError`，不发送**；spawn 走现有「会话已建、首条消息失败」分支：打印 URL、JSON `promptDelivered: false` + `error`，退出码 2。
4. 非 fork spawn：`opts.fork === false`，不读 metadata，零额外请求。

### 超时取舍

- 120 s 覆盖：大 fork（每 50 条一个 POST，几千条也在十几秒级）+ Codex app-server 冷启动在回放之前。
- 超时选择「报错不发」而非「超时后照发」：照发就是原事故；会话还在，调用方可在历史出现后用 `very-happy send` 补发（help 与错误信息里写明）。
- wrapper 在回放前崩溃（如 Codex `client.connect()` 失败）同样表现为超时报错——此时会话本身已不可用，不发是正确的。

### 被否方案

- **CLI 固定 sleep / 等消息数稳定**：时间不可证明，数量对不上 envelope 拆分（一行 JSONL → 0..N envelope）。
- **把 prompt 交给 wrapper（env）由它在回放后入队**：顺序天然正确，但首条消息的 model/permission meta、`sentFrom`、失败语义与 Web 发送原语分叉，且旧 wrapper 会静默丢 prompt（不兼容）。
- **`session.flush()`**：10 s 超时后照样 resolve，不能作为「已落库」证据。
- **服务端排序**：seq 在到达时分配，server 无从知道哪些是回放；要加 server 语义且需三端协同发布，代价远大于收益。

### Web 路径

Web 的 Claude 导入（`claude-import-session` RPC → `resumeClaudeSessionId`）与 `forkAndSpawn`（`sync/ops.ts`，当前 web-v2 UI 无调用方）都经同一条 wrapper 回放路径，**但 Web 不会自动发首条消息**——用户进入会话后手动输入，通常晚于回放完成；因此 Web 无回退，wrapper 侧标记对 Web 也无副作用。
理论残余：回放上传期间（Claude 典型 <1 s，Codex 数秒）用户就发出消息，仍可能落在回放中间；Web composer 可在将来复用 `forkBackfill` 做闸门，本次不做。
Web `MetadataSchema` 新增宽松的 `forkBackfill`（`passthrough().optional().catch(undefined)`），只为防止 Web 改名/优先级写回时把标记 strip 掉；Web 不读它，畸形值不会让整份 metadata 解析失败。

## 兼容矩阵与发布顺序

| CLI（spawn） | wrapper（daemon 拉起） | 行为 |
|---|---|---|
| 新 | 新 | 等标记再发，顺序正确；超时报错不发 |
| 新 | 旧（无能力） | 立即发（旧行为，可能错位）+ stderr warning，不等待、不卡死 |
| 旧 | 新 | 旧 CLI 立即发（旧行为）；wrapper 写的 `forkBackfill` 是新 metadata 字段，旧端忽略 |
| 旧 | 旧 | 不变 |

- Web：旧 Web 不认识 `forkBackfill`，改名时会 strip 它——只在 CLI 等待的几秒窗口内有意义，最坏是该次 spawn 超时报错（不乱序）；新 Web 保留该字段。
- Server：无改动。
- 发布顺序：server/Web 与 CLI 无先后依赖；默认 server/Web → CLI（铁律 5）。CLI 发版后，wrapper 由 daemon 拉起，daemon 交接后新建的会话即为新 wrapper。
- 回滚点：CLI 回滚到 0.2.162 即恢复旧行为（无数据迁移）；Web 回滚只影响上面那个 strip 窗口。

## 风险

1. **wrapper 卡在上传（服务端持续失败）**：drain 一直不 resolve → CLI 120 s 后报错不发。接受：符合「宁可晚发」，错误信息指明补发方式。
2. **旧 Web 改名 strip 标记**：见兼容矩阵，最坏超时报错，不乱序。接受。
3. **`very-happy send` / 自动化在 spawn（无 prompt）后立刻发**：不走本闸门，仍可能错位。接受为非目标；需要时可复用 `waitForForkBackfill`（读 `sessions.json` capabilities + metadata 标记）。
4. **轮询负载**：每个带 prompt 的 fork 在回放期间 ~2 次/秒 GET，通常 1–3 次即见标记。接受。
5. **Codex reconnect 路径**：reconnect 不回放、不写标记；CLI 从不对 reconnect 等待（spawn --fork 永远是新会话）。
6. **B-495 的另一半不在本 spec**：隔离端到端里排序已正确，但 fork 上 `sessions read --wait` 仍等不到回合结束。代码推断：Claude 回放不关闭 mapper 的 `currentTurnId`（`claude/utils/sessionProtocolMapper.ts` 只在 `currentTurnId` 为空时发 `turn-start`），首个新回合没有 `turn-start`，`sessions/turnState.ts` 于是把它的 `turn-end` 当成「上一轮收尾」跳过。另立修复。

## 验收标准

- [x] 机制回归测试复现「首条消息先于回放落库」：真 `ApiSessionClient` outbox + 假服务端按处理时分配 seq，无闸门时 prompt seq < 回放尾部（`spawnForkOrder.test.ts`「reproduces the incident」）。
- [x] fork + 新 wrapper：prompt seq 大于全部 95 条回放 seq，且 metadata 写入 `forkBackfill.done`。
- [x] 新 wrapper 永不确认：`ForkBackfillTimeoutError`，prompt 未落库，无标记。
- [x] 旧 wrapper（无能力）：立即发送 + warning，<1 s，无等待。
- [x] 非 fork：不读 metadata。
- [x] `drainOutbox` 只在服务端应答后 resolve；关闭时返回 false。
- [x] Claude / Codex 两个 runner 的能力宣告与标记写出点有源码断言，`scripts/dev/mutation-check.mjs` 全部抓到。
- [x] Web `MetadataSchema` 保留 `forkBackfill`，畸形值不破坏解析。

- [x] 隔离端到端（standalone server + 隔离 `HAPPY_HOME_DIR` daemon + 真 Claude）：源会话 29 行回放，`[FORK BACKFILL] Committed` 15:13:11.317 之后 wrapper 才收到 prompt（11.560），转录中 prompt 位于全部历史之后。

## 留真机验证项

无（时序由机制测试与隔离端到端覆盖）。
