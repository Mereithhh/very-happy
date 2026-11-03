# 超长导入会话：上传与首屏（import backfill）

> 状态：Final（PR-1 #873 客户端；PR-2 server 声明式回放配额）
> 日期：2026-11-03 ｜ 关联 backlog：B-880 ｜ 前身：B-290（Claude 导入）、B-464（Codex 导入）、B-531（fork backfill 确认）、B-616（首屏只取最新一页）

## 背景

Xu CHEN 11-03 15:05（SGT）：「导入一个巨长的 cc 会话，缓冲了很久都无法到达最新会话的位置」。生产只读核对（vh-sg，读事务）：
该次导入会话 `cmw0c7inu…` 共 12,934 条消息，14:59:16 → 15:19:xx 入库，**每分钟正好 600 条**（账号同一分钟的其他会话合计也被压在 600 以内）。

## 现状事实（代码已确认）

导入一条 Claude Code 对话到 Web 看到最新消息，链路是：

1. Web `ImportHistoryModal` → `machineImportClaudeSession`（`sync/ops.ts`）→ daemon RPC `claude-import-session`（`happy-cli/src/api/apiMachine.ts`）：复制 JSONL、spawn wrapper，RPC 立刻返回 sessionId，Web 随即 `navigate('/session/:id')`。
2. wrapper `runClaude.ts`「Fork backfill」：一次读入整个 JSONL，`replayClaudeForkJsonl` 逐行 `sendClaudeSessionMessage` → `enqueueMessage` 入 outbox（同步、只入队）。Codex 走 `importCodexThread.ts` 同一模式。
3. outbox `flushOutbox`（`apiSession.ts`）按**固定 50 条**一批 POST `/v3/sessions/:id/messages`，FIFO，失败由 `InvalidateSync` 退避重试同一批。
4. server `storeSessionMessagesInTx`（`sessionMessageStore.ts`）对每批调用 `enforceAccountWriteRate('message', MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE=600)`——**账号级**每分钟 600 条，超了 429；生产未覆盖该值（`docs/operations.md` 限额表）。每条入库发一个 `new-message` 更新给所有在看这个会话的 tab。
5. Web 打开会话：`onSessionEnter` → `syncScheduler.open` → 首屏取最新一页（`fetchInitialLatestPage` / subscribe 的 latest，B-616）。但导入刚开始时 server 上只有最早的几十条，「最新一页」就是**最早的**那几十条；此后每条 `new-message` 推送都进 `mergeSessionMessages` → reducer → ChatList 重新渲染，transcript 从最早的消息往后一条条长出来。

## 根因

| # | 位置 | 现象 | 实测（隔离环境，修前） |
|---|---|---|---|
| 1 | server `sessionMessageStore.ts` 账号级 600 条/分钟 | 回放上传被限流到 10 条/秒，同账号其他会话一起饿死 | 2,004 行 JSONL（3,174 条）上传 407 s，最新消息 417 s 才出现；生产 12,934 条 ≈ 20 min |
| 2 | Web `sync.ts` 打开中的导入会话把回放当实时流 | 每条推送都 reduce + 全量渲染，从最早往后长；主线程长时间卡死、内存暴涨 | 20,004 行（31,674 条，28.9 MB）在不限流下：上传 177 s，最新消息 312 s，单次主线程卡顿最长 225 s，JS 堆峰值 1,170 MB，DOM 节点 49,845 |
| 3 | CLI `apiSession.ts` 固定 50 条一批，不看字节 | 工具参数不截断（如 `Write.content`），50 条可超过 server 1 MiB body 上限 → 413 → 同一批无限重试，**此后所有消息永远发不出去** | 300 行、每个 Write 60 KB：627 次 413，服务端停在 seq 1 |

## 方案

### 拆分（Lead 11-03 拍板）

- **PR-1（本 PR，不带迁移）**：Web 停放 + 进度 + 完成后最新一页；CLI 按字节分批 + 回放标记 + 进度。上传仍受 600 条/分钟，但不再卡死、不再 413，Web 不再冻结。
- **PR-2（迁移，expand-only）**：server 只看请求头不够——普通会话加头即可绕过 600。改为 Session 加 `backfillQuota Int?` / `backfillUsed Int @default(0)`，wrapper 回放前 `POST /v3/sessions/:id/backfill { total }` 声明（本人、seq==0、创建 ≤5 min、只声明一次、上限 min(total, 每会话上限)+2%），消息 POST 只有在同事务内 `backfillUsed+n ≤ backfillQuota` 时才计入账号级 backfill 桶（数据库保护，按实测定值），否则回落普通桶；回放完成 `{ done: true }` 关闭。单测覆盖普通会话带头仍受 600 限制。隔离 Postgres 实测（PR-1 期间）：单 wrapper 12,934 条 25.0 s（517 条/s，每批 100 条一个事务、逐行 insert，p95 318 ms），峰值活跃连接 1；3 个并发导入 674 条/s、活跃连接 4，但同账号并发写在 `Account FOR UPDATE` + 限流桶上序列化冲突，3 次重试后约 10% 批次 500（wrapper 退避重试成功；既有问题，记 backlog）。

### CLI：outbox 按字节分批 + 回放标记 + 进度

- `api/outboxBatch.ts` `planOutboxBatch`（纯函数）：每批 ≤100 条（server 上限）、≤768 KiB 请求体；回放与实时消息不混批；单条 ≥ ~1 MiB 永远发不出的标 `oversize` 并丢弃（debug 日志），不再堵死后面所有消息。
- `ApiSessionClient.replayHistory(fn)`：fn 内入队的消息带 `backfill` 标记（不上传该字段），全部入队后只触发一次 flush，第一批就是满批；回放批次带 `X-Happy-Message-Origin: backfill`（PR-1 的 server 不读它；PR-2 只在会话已声明配额时才让它生效）。
- `utils/forkBackfill.ts`：
  - `announceForkBackfill` 在读 transcript **之前**写 `metadata.forkBackfill = { done: false, total: 0, sent: 0 }`；
  - `publishForkBackfillWhenCommitted` 期间每秒写 `{ done: false, total, sent }`（`sent` 变化才写），drain 完写原有的 `{ done: true, count, completedAt }`。
  - Claude（`runClaude.ts`）、Codex fork（`runCodex.ts`）、Codex 导入（`importCodexThread.ts`，此前没有任何标记）三条回放路径都接上；announce 之后的每条路径（含读失败）都以 publish 收尾。

### Web：上传中的导入会话「停放」，完成后按普通会话打开

- `sync/importBackfill.ts` `importUploadProgress(session)`：`session.active && metadata.forkBackfill.done === false` 才算上传中；inactive（wrapper 中途死掉留下 `done:false`）不算，按已入库内容正常打开。
- `sync.ts`：`onSessionEnter`、`fetchMessages`、`new-message` 推送、relay committed 四个入口先过 `parkIfImporting`：上传中不 catch-up、不收推送；若在 marker 到达前已订阅，`syncScheduler.forget` 停掉。
  `applySessions` 每次会话更新后 `releaseImportParked`：不再上传中 → `invalidateSessionWindow`（丢掉停放前收到的「最早一页」）→ 正在看就重新 `onSessionEnter`，走 B-616 的最新一页首屏、向上滚动按需加载。
- `ChatList`：上传中显示 OrbitLoader +「正在导入历史对话…」+ 进度条与「已上传 / 总数 · 百分比」（total 未知时只显示标题）。

## 兼容矩阵（PR-1）

| CLI（wrapper） | Web | 行为 |
|---|---|---|
| 新 | 新 | 回放按字节分批（不再 413）；Web 显示进度，完成后打开即最新一屏、向上按需加载 |
| 新 | 旧 | 旧 Web 的 `forkBackfill` schema 是 `.passthrough()`，`total`/`sent` 保留不剥除；旧 Web 不读它，行为同今天（但上传不再卡死） |
| 旧 | 新 | 无 `done:false` → Web 不停放，行为同今天 |
| 任意 | 任意 | `very-happy spawn --fork --prompt`（新/旧 CLI）只认 `done === true`，进度写入不会让它提前发送 |

server 不变；新 CLI 发的 `X-Happy-Message-Origin: backfill` 头旧/新 server 都忽略（PR-2 前）。发布：Web 与 CLI 无先后依赖。

## 验收

- 机制测试：`outboxBatch.test.ts`（分批、字节上限、混批、oversize）、`apiSession.test.ts`（回放 100+50 两批带头、实时消息单独一批）、`forkBackfill.test.ts`（进度写入、旧 CLI 不被进度放行、三条回放路径接线）、`importCodexThread.test.ts`、Web `importBackfill.test.ts`（判定 + 四个入口接线，mutation-check 全部 CAUGHT）、`chatImportProgress.test.tsx`（进度态不渲染 transcript，完成后切回）。
- 隔离 e2e（证据：`~/code/github/skills/tmp/vh-team-B-880/`，脚本 `e2e/measure.mjs`）：真 daemon `claude-import-session` → 打开会话 → 采样直到最新消息可见 → 刷新冷开 → 滚到顶加载更早；桌面 1280 与手机 390 coarse。

## PR-2：声明式回放配额（迁移 `20261103180000_session_backfill_quota`，expand-only）

- server `sessionBackfill.ts`：`POST /v3/sessions/:id/backfill { total }` 声明（本人；`seq==0`；创建 ≤5 min；只一次；quota = min(total, `MAX_BACKFILL_MESSAGES_PER_SESSION`=100k) × 1.02）→ 200 `{quota}`，否则 409 `backfill_not_allowed` + reason / 404。`{ done: true }` 关闭（quota := used）。
- `storeSessionMessagesInTx`：带 `x-happy-message-origin: backfill` 且同事务 `chargeSessionBackfill`（`backfillUsed + n ≤ backfillQuota`）成功 → 账号级 `message_backfill` 桶（`MAX_BACKFILL_MESSAGES_PER_ACCOUNT_PER_MINUTE`，默认 **10,000**）；否则普通 600 桶。限流拒绝时整个事务回滚，会话配额不被扣。
- CLI `apiSession.ts`：回放首批前声明（任何 HTTP 应答都算定局：404 = 旧 server，照常上传；网络错误随该批重试），最后一批后关闭（尽力而为）。
- 写入方式：每个 POST（≤100 条）一个 SERIALIZABLE 事务，`Account`/`Session` 行锁 + 逐行 `sessionMessage.create`（不是 createMany）。隔离 Postgres 16（`dbload/load.mjs`）：
  | 场景 | 耗时 | 吞吐 | 429 | 峰值 active 连接 |
  |---|---|---|---|---|
  | 声明，10k/分钟，单 wrapper 12,934 条 | 65.0 s | 199 条/s | 42（桶满退避） | 1 |
  | 不限，单 wrapper 12,934 条（上限参考） | 25.0 s | 517 条/s | 0 | 1 |
  | 未声明只带头，2,000 条 | 183 s | 11 条/s（= 600/分钟） | 175 | 1 |
  连接池总数 34（Prisma 默认池 + 后台），不随负载上升；10k/分钟够一次超长导入 ~1 分钟上传完，且单账号写入压力被压在不限时的 40%。
- 兼容：旧 CLI 不声明 → 普通桶（同今天）；新 CLI + 旧 server → 声明 404，普通桶；旧 server 镜像不读新列。回滚：只回滚镜像；需要删列见 migration.sql 注释。
- 验收单测：`sessionBackfill.pglite.integration.spec.ts`（普通会话带头仍受 600；声明后 total+2% 内走 backfill 桶、之外回普通桶且 live 会话预算不受影响；关闭后回普通桶；只能声明一次 / 有消息 / 超 5 分钟 / 他人会话被拒；每会话上限；账号 backfill 桶仍限流且拒绝不扣会话配额），CLI `apiSession.test.ts`（声明→批→关闭顺序；旧 server 404 照常上传不关闭）。
