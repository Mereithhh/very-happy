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
| `active` | root；或有未结束任务（queued/running/submitted）；或当前 generation 的 spawn 未完成（排除 `task_closed_before_spawn`）；或绑定的是用户会话（managed=false 且有 session） |
| `stopping` | 有未完成的 stop（pending/claimed/failed/unknown，含 B-691 保留待处理的清理） |
| `idle` | managed，仍绑定 session，但无任务、无 stop |
| `inactive`（已停用） | managed，无 session，无任务，无未完成操作 |

`teamMemberCounts` 把成员数定义为除 inactive 之外的所有成员。

**委派**：
- 委派给 stopping 的 bot：不再返回 409。建 queued 任务和 spawn op（`sessionId=null`，generation+1），绝不把任务发给正在停止的会话。`claim-operation` 在该 bot 的 stop 完成前返回 `bot_cleanup_pending`，daemon 的现有轮询会让 op 保持 pending。
- stop 完成或人工对账后，只要 `bot.sessionId === op.sessionId` 就解除绑定（不再要求 generation 一致），排队的启动随后被认领。
- 不带 `assigneeBotId` 的委派：优先复用最早的 inactive managed bot（assistant、model、directory 都相同）；带 `botName` 时重命名它；没有可复用的才新建。
- 名额：非 inactive 成员 < 32，`bots` 总记录 < 128（`team_bot_record_limit`）。

**视图**：`teamView` 响应附加 `memberCounts` 和 `bots[].activity`，按完整状态计算，只出现在响应里、不持久化。team_inspect 透传 JSON，所以 agent 也能看到。

**历史与重新激活**：bot 名下的任务 attempts 和各 spawn op 的 sessionId 就是它的历史。用 `assigneeBotId` 委派给 inactive 的 bot，即 generation+1 后启动新会话和新 worktree。不新增 action。

**Web**：成员折叠与「已停用 N 个」由 B-690（#642）负责。它的 `teamMemberInactive` 另加了 UI 启发式（会话已归档、`lastEvent=exited`、长时间空闲）。为了只保留一套底层规则，B-690 应以 `bot.activity === 'inactive'`（旧 server 时调用 `teamBotActivity`）为基础，再叠加这些「看起来不活跃」的 UI 启发式；计数用 `memberCounts`。

## 兼容矩阵

| | 旧 Web | 新 Web |
|---|---|---|
| 旧 server | 原样 | Web 用 wire 函数自己算 |
| 新 server | 忽略新增字段；委派给 stopping 的 bot 由 409 变为排队 | 读取 server 字段 |

daemon/CLI 不变：被拒绝认领的 spawn 保持 pending（现有逻辑）。**不需要 CLI 发版**，无 migration；只需 server/Web 同镜像发布。

## 验证

wire `teamActivity.test.ts`（各状态判定、计数）；reducer：排队委派 → 认领被拒 → stop 完成 → 认领并绑定新会话、任务进入 running；failed stop 人工对账后释放；同形复用与重命名、不同 agent/目录则新建；32 名活跃成员上限不计 31 个已停用；派生字段不持久化。
