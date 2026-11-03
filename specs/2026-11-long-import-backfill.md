# 超长导入会话：上传与首屏（import backfill）

> 状态：Final（随实现 PR 定稿；合并后回标 Shipped）
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

### Server：回放单独计费（`sessionMessageStore.ts` `messageWriteBudget`）

- `POST /v3/sessions/:id/messages` 带 `x-happy-message-origin: backfill` 时，计入独立桶 `message_backfill`，`MAX_BACKFILL_MESSAGES_PER_ACCOUNT_PER_MINUTE`，默认 50,000。
  依据：一个 wrapper 实测上传峰值约 450 条/秒；20k 时 31,674 条导入仍撞桶 35 次。
- 总量配额（`MAX_MESSAGES_PER_ACCOUNT` / 字节）不变；live 桶 600/分钟不变，导入不再占用它。
- 只有 HTTP 路由识别该头；Socket 写入路径不变。头由客户端自报：一个想绕过限流的客户端得到的上限仍是 50k/分钟的滥用护栏，与总量配额一起兜底。

### CLI：outbox 按字节分批 + 回放标记 + 进度

- `api/outboxBatch.ts` `planOutboxBatch`（纯函数）：每批 ≤100 条（server 上限）、≤768 KiB 请求体；回放与实时消息不混批；单条 ≥ ~1 MiB 永远发不出的标 `oversize` 并丢弃（debug 日志），不再堵死后面所有消息。
- `ApiSessionClient.replayHistory(fn)`：fn 内入队的消息带 `backfill` 标记（不上传该字段），全部入队后只触发一次 flush，第一批就是满批；回放批次带 `X-Happy-Message-Origin: backfill`。
- `utils/forkBackfill.ts`：
  - `announceForkBackfill` 在读 transcript **之前**写 `metadata.forkBackfill = { done: false, total: 0, sent: 0 }`；
  - `publishForkBackfillWhenCommitted` 期间每秒写 `{ done: false, total, sent }`（`sent` 变化才写），drain 完写原有的 `{ done: true, count, completedAt }`。
  - Claude（`runClaude.ts`）、Codex fork（`runCodex.ts`）、Codex 导入（`importCodexThread.ts`，此前没有任何标记）三条回放路径都接上；announce 之后的每条路径（含读失败）都以 publish 收尾。

### Web：上传中的导入会话「停放」，完成后按普通会话打开

- `sync/importBackfill.ts` `importUploadProgress(session)`：`session.active && metadata.forkBackfill.done === false` 才算上传中；inactive（wrapper 中途死掉留下 `done:false`）不算，按已入库内容正常打开。
- `sync.ts`：`onSessionEnter`、`fetchMessages`、`new-message` 推送、relay committed 四个入口先过 `parkIfImporting`：上传中不 catch-up、不收推送；若在 marker 到达前已订阅，`syncScheduler.forget` 停掉。
  `applySessions` 每次会话更新后 `releaseImportParked`：不再上传中 → `invalidateSessionWindow`（丢掉停放前收到的「最早一页」）→ 正在看就重新 `onSessionEnter`，走 B-616 的最新一页首屏、向上滚动按需加载。
- `ChatList`：上传中显示 OrbitLoader +「正在导入历史对话…」+ 进度条与「已上传 / 总数 · 百分比」（total 未知时只显示标题）。

## 兼容矩阵

| CLI（wrapper） | Server | Web | 行为 |
|---|---|---|---|
| 新 | 新 | 新 | 回放走 backfill 桶、按字节分批、Web 显示进度，完成后打开即最新一屏 |
| 新 | 旧 | 任意 | 旧 server 忽略头 → 回放仍计入 600/分钟（与今天一样慢，但不再 413 卡死）；Web 照常显示进度 |
| 旧 | 新 | 新 | 无 `done:false` → Web 不停放，行为同今天（旧 wrapper 仍可能 413/限流） |
| 新 | 任意 | 旧 | 旧 Web 的 metadata schema 是 `.passthrough()`，`total`/`sent` 保留不剥除；旧 Web 不读它，行为同今天 |
| — | — | — | `very-happy spawn --fork --prompt`（新/旧 CLI）只认 `done === true`，`done:false` 的进度写入不会让它提前发送 |

发布顺序：server/Web 先（server 新桶对旧 CLI 无影响，Web 对旧 CLI 无影响），CLI 后。

## 验收

- 机制测试：`outboxBatch.test.ts`（分批、字节上限、混批、oversize）、`apiSession.test.ts`（回放 100+50 两批带头、实时消息单独一批）、`forkBackfill.test.ts`（进度写入、旧 CLI 不被进度放行、三条回放路径接线）、`importCodexThread.test.ts`、server `v3SessionRoutes.test.ts`（backfill 不占 live 桶、自身也限流）、Web `importBackfill.test.ts`（判定 + 四个入口接线，mutation-check 全部 CAUGHT）、`chatImportProgress.test.tsx`（进度态不渲染 transcript，完成后切回）。
- 隔离 e2e（证据：`~/code/github/skills/tmp/vh-team-B-880/`，脚本 `e2e/measure.mjs`）：真 daemon `claude-import-session` → 打开会话 → 采样直到最新消息可见 → 刷新冷开 → 滚到顶加载更早；桌面 1280 与手机 390 coarse。
