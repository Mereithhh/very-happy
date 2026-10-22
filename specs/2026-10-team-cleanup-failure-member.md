# 成员清理失败后不再永久卡住新任务

状态：Final · 2026-10-23 · B-775（依赖 B-691 清理退避、B-692 排队）

## 现场

- QA5 O4（10-23 04:40–05:00 SGT）：Worker 第一个任务验收后清理失败（worktree 有未合并提交），再派给它的任务一直「启动中」（spawn `pending`，`claimId` 为空），团队页无提示。
- 研发团队 Dev-N1 / Dev-M1（10-22，生产 team state 只读取证）：

| 成员 | 时间 (SGT) | 操作 | 结果 |
| --- | --- | --- | --- |
| Dev-N1 | 10-22 05:49 | 任务 1 验收 → stop `1cb7fcf6`（gen 1） | failed，最终原因 `Worker binding changed` |
| | 12:48 | 新任务 → spawn `8fb76830`（gen 2，排队） | 一直 pending，13:56 取消 |
| | 13:56 | 取消产生 stop `70d41a35`（gen 2，同一个旧 session） | failed（ownership unknown → binding changed） |
| | 23:53 / 23:56 | 再派 spawn `0d2fb12c`（gen 3）→ 取消 → stop `fe847042` | 同上；共 3 条 failed stop |
| Dev-M1 | 10-22 17:07 / 18:18 / 20:37 | stop `4a889230`（gen 3）→ spawn `f7321aa6`（gen 4）一直 pending → 取消 → stop `e6e7a4ae` | 同样的连锁 |

daemon 日志只有每 5 秒一行 `Teams operation <id> remains pending`（如 `04c5cd47` 13 次），没有原因。

## 根因

1. **认领门槛过宽**（server `claim-operation`，B-692）：spawn 只要同 bot 有任何 `status !== 'completed'` 的 stop 就拒绝（`bot_cleanup_pending`）。failed stop 只有 Owner 重试成功或「标记已处理」才会 completed，所以排队的 spawn 永远不会被认领。daemon 把 409 吞成「remains pending」。
2. **排队本身让清理永远失败**（CLI cleanup）：委派给正在清理的 bot 时 `generation++`（B-692 排队）。stop 每次重试都要求 `bot.generation === op.generation`，于是变成 `Worker binding changed`，哪怕 Owner 已经推送了提交、点了「重试清理」也不会成功——N1 第一条 stop 的最终原因就是它。
3. **取消排队任务又叠加一条 stop**（server `cleanup()`）：被卡住的任务取消时，bot 仍绑定着旧 session（清理没完成），`cleanup()` 给这个旧 session 再建一条 stop，generation 是新的。daemon 按 `(generation, sessionId)` 找不到原始 spawn → `Original worktree ownership is unknown`（QA5 看到的就是这条）。每派一次再取消就多一条，越积越多。
4. **不可见**：任务卡显示「启动中」；团队页「执行需要处理」只列 failed stop，看不出它挡住了哪个任务；team_inspect 没有任何字段；lead 收到的是 `Teams request failed (HTTP 409)`（不带原因）。

## 修复契约

- **清理的目标是 op 自己的 session**（CLI `worker.ts`）：去掉 generation/session 必须仍等于当前绑定的要求；只在 bot 不存在或该 session 已被 B-730 移到别的团队时拒绝。成功 stop+archive 后再出错（脏/未合并/归属不明）上报 `fail-operation.sessionStopped: true`，请求 id 加 `-stopped`（旧 daemon 可能已用同一原因上报过无此字段的请求）。
- **只有仍占着会话的清理才挡新启动**（wire `teamCleanupHoldsSession`，server 认领门槛 / handoff 同用）：stop 未完成且 `op.sessionId === bot.sessionId`。`sessionStopped` 的失败让 server 立即 `releaseBotSession`：成员可以接新任务，新 spawn 用新的 worktree 和分支（worktree 目录按 operation id，从不复用），旧 worktree 仍挂在这条 failed stop 上等 Owner 处理。选这条而不是「一律报错」：会话确认已停时没有并发写者风险，成果也不会丢，卡住成员没有收益。
- **仍占着会话的失败清理：派活前明确报错**：`delegate` / `handoff` 指定这个成员时 409 `bot_cleanup_failed`，details 带 `botName`、`operationId`、`cleanupError`、`hint`；CLI `teamRequest` 只放行 snake_case 错误码，并对 `bot_cleanup_failed` 给出固定说明（改派他人、请 Owner 重试清理或标记已处理）。进行中的清理（pending/claimed）仍按 B-692 排队。
- **不叠加 stop**：`cleanup()` 在已有未完成 stop 针对 bot 当前 session 时不再新建 stop；该任务 `cleanup` 保持 `none`（它的启动从未运行）。
- **可见**：
  - team_inspect（agent 视图）新增派生字段 `cleanupIssues[]`：`botId/name/operationId/taskId/error(≤300)/holdsSession/waitingTaskIds/hint`。
  - 清理第一次失败（`claimed → failed`）给该任务的 owner bot 发一条 system 消息，说明原因和是否挡住新任务；同一条 stop 之后的重复失败不再发。
  - Web：排队任务的状态 `cleanupBlocked`「等待清理处理」（红色，需要 Owner），详情说明原因并给出清理错误；成员卡显示「处理之前，这个成员的新任务无法启动」；「执行需要处理」里该 stop 写明是否挡住新任务、有几个任务在等。
  - daemon 日志：`remains pending (<server error code>)`，只记录错误码。

## 兼容矩阵

| server | daemon (CLI) | 结果 |
| --- | --- | --- |
| 新 | 新 | 清理在停会话后失败 → 成员立刻可接新任务（新 worktree）；排队任务自动启动。 |
| 新 | 旧 | 旧 daemon 不发 `sessionStopped` → 会话仍算被占：新委派被明确拒绝，已排队的任务显示「等待清理处理」；Owner「标记已处理」即放行（`reconcile-operation` 已释放会话）。旧 daemon 的 generation 检查仍会让重试失败，需升级 CLI。 |
| 旧 | 新 | 旧 server 的 zod 剥掉 `sessionStopped`，行为同今天（多出的是 daemon 日志原因和更准确的清理重试）。 |

wire 只加可选字段/类型，无迁移。发布顺序：server/Web 镜像先，CLI 后。

## 验证

- server：reducer 单测（QA5/N1 链路、拒绝 details、不叠加 stop、只通知一次、in-flight 仍排队）+ pglite 集成测试（持久化链路、拒绝不入请求表）。
- CLI：worker 测试（generation 已变仍清理、`sessionStopped` 与请求 id、未停会话/已转移会话不带标记、日志原因）、refusal 文案。
- Web：`cleanupBlocked` 状态与渲染。
- mutation：见 PR。
- 隔离实跑：standalone server + 隔离 daemon，真 git worktree 制造未合并提交 → 再派任务。
