# 团队成员生命周期：已停用不计数、复用与排队委派

状态：Final · 2026-10-21 · B-692（基于 B-691）

## 现场

Owner：「已经不用的 team 也会占据一个成员……我现在 21 个成员了，但实际活跃的一直只有几个」。Lead 每次委派都新建 bot（Dev-B2 / C2 / …），因为用 `assigneeBotId` 委派给刚完成任务的 bot 时会遇到 409。

## 根因（代码已确认，`happy-server/sources/app/teams/reducer.ts` `delegate`）

- `bot_cleanup_pending`：只要该 bot 还有 stop 未 completed 就拒绝委派。B-691 之前 failed stop 永不完成，这个 bot 就永远不能复用。
- 名额按 `bots.length < 32` 计算，已停用的 bot 照样占名额。
- 不带 `assigneeBotId` 的委派总是新建 bot。
- 没有「已停用」的概念，Web 和 team_inspect 都按 `bots.length` 计数。

## 契约

**成员状态（派生，不存储）**：由 happy-wire 的 `teamBotActivity(team, bot)` 唯一定义，server、Web、agent 共用这一套规则：

| 状态 | 条件 |
|---|---|
| `active` | root；或有未结束任务（queued/running/submitted）；或当前 generation 的 spawn 未完成（排除 `task_closed_before_spawn`） |
| `stopping` | 有未完成的 stop（pending/claimed/failed/unknown，含 B-691 保留待处理的清理），显示为「回收需要处理」，不折叠 |
| `inactive`（已停用） | 没有未结束任务，且满足任一条件：没有会话、会话已归档（只有 Web 知道，通过 `context.sessionArchived` 传入）、`lastEvent=exited`、最近一次事件超过 7 天（B-690 的规则并入，Lead 10-21 确认） |
| `idle` | 仍绑定会话但没有活，且不满足上一行任一条件；仍计入成员数 |

`teamMemberCounts` 把成员数定义为除 inactive 之外的所有成员。

**委派**：
- 委派给 stopping 的 bot：不再返回 409。建 queued 任务和 spawn op（`sessionId=null`，generation+1），绝不把任务发给正在停止的会话。`claim-operation` 在该 bot 的 stop 完成前返回 `bot_cleanup_pending`，daemon 的现有轮询会让 op 保持 pending。
- stop 完成或人工对账后，只要 `bot.sessionId === op.sessionId` 就解除绑定（不再要求 generation 一致），排队的启动随后被认领。
- 不带 `assigneeBotId` 的委派：优先复用最早的、**没有会话**的 inactive managed bot（assistant、model、directory 都相同）。仍持有会话的 bot 虽然计为已停用，但委派会发消息给它而不是重新拉起，所以不复用。带 `botName` 时重命名它，旧名记入 `previousNames`（曾用名，最多 16 个）。没有可复用的才新建。
- 名额：非 inactive 成员 < 32，`bots` 总记录 < 128（`team_bot_record_limit`）。

**视图**：`teamView` 响应附加 `memberCounts` 和 `bots[].activity`，按完整状态计算，只出现在响应里、不持久化。team_inspect 透传 JSON，所以 agent 也能看到。

**历史与重新激活**：bot 名下的任务 attempts、各 spawn op 的 sessionId 和 `previousSessionIds` 就是它的历史。B-729 起，join（adopt/重绑）替换会话、stop 或人工对账解绑会话时，server 把旧 sessionId 记进可选的 `TeamBot.previousSessionIds`（最早的在前，最多 32 个；旧 server 没有这个字段，旧 Web 会忽略）。Web 侧栏归属（`teamSessionMembership`）只认当前绑定、spawn 完成回执和 `previousSessionIds`。同一会话被多处认领时不再丢弃，按「当前绑定 > spawn 回执 > 历史」定唯一归属，平局时较新的团队优先。较早代的会话折进「已停用」。用 `assigneeBotId` 委派给 inactive 的 bot，即 generation+1 后启动新会话和新 worktree。不新增 action。

**Web**：成员折叠与「已停用 N 个」由 B-690（#642）负责，它会把本地的 `teamMemberInactive` 换成 `teamBotActivity`（带上 `sessionArchived`）。共享函数已先由 #646 单独合入。server 的 `memberCounts` 不知道会话是否已归档，所以 Web 应带上归档信息自己重算。

## 兼容矩阵

| | 旧 Web | 新 Web |
|---|---|---|
| 旧 server | 原样 | Web 用 wire 函数自己算 |
| 新 server | 忽略新增字段；委派给 stopping 的 bot 由 409 变为排队 | 读取 server 字段 |

daemon/CLI 不变：被拒绝认领的 spawn 保持 pending（现有逻辑）。**不需要 CLI 发版**，无 migration；只需 server/Web 同镜像发布。

## 验证

wire `teamActivity.test.ts`（各状态判定、B-690 启发式、计数）；reducer：排队委派 → 认领被拒 → stop 完成 → 认领并绑定新会话、任务进入 running；failed stop 人工对账后释放；同形复用与重命名、不同 agent/目录则新建；32 名活跃成员上限不计 31 个已停用；派生字段不持久化。

端到端（本地 standalone server，通过 owner API 模拟执行电脑）：旧 server（B-689 版）委派给正在回收的 bot 返回 `409 bot_cleanup_pending`；B-692 server 返回 200，任务排队；回收完成前认领被拒（409 `bot_cleanup_pending`），回收完成后启动、任务 running；默认委派复用同一 bot（名字改为 Dev-C2，`previousNames: ["Dev-B2"]`）；视图 `memberCounts` 与 `activity` 正确。证据见 `~/code/github/skills/tmp/vh-team-B-692/e2e/evidence/`。
