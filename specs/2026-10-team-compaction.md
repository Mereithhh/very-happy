# 长期运行的团队不再撞记录上限：自动压缩、容量可见、上限不再像限流

状态：Final · 2026-10-26 · B-822

## 现场

一个生产团队跑了 5 天：`AgentTeam.state` 约 649 KB（169 个任务），`TeamMessage` 996 条（约 993 KB），`TeamOperation` 330 条（约 389 KB），合计约 2.03 MB，超过 reducer 末尾的 `JSON.stringify(s).length <= 2_000_000`。之后 delegate / message / submit / accept 全部返回 `team_size_limit`（**HTTP 429**）。CLI `teamRequest` 只在 409 时读 body，模型看到的只有 `Teams request failed (HTTP 429)`，所有人都以为是限流。Lead 在 Owner 授权下手工备份并删除了 968 条已结束任务的已送达消息（备份在 `~/code/github/skills/tmp/vh-team-prune/`）。消息 2000 条、operation 1000 条、任务 200 个这三个上限按同样的速度也会撞上。

## 现状事实（代码已确认）

- 一次写入 = `store.actOnTeam` → `load`（AgentTeam + 该团队所有 TeamOperation / TeamMessage 行）→ `reduceTeam` → `persistTransition`（逐行 upsert）。size 检查的是含消息和 operation 的完整 state。
- 删除只有一条路：`persistTransition` 删除已结束的 schedule 消息，受 `unsafe_message_prune` 守卫（必须有 scheduleId 且已送达或已取消，DELETE 再次校验）。任务和 operation 从不删除。
- `teamBotRepository`（reducer）取每个 bot **第一个**带 directory 的 spawn 作为源仓库（B-706）；projects `teamFolder` 通过 worktree 路径里的 operation id 反查 spawn（B-755）。
- `scopedTeamView`：agent 只能看到自己任务子树里的任务（沿 parent 链往上找），以及这些任务的消息；消息要能送达，接收者必须看得到它的任务。
- reconcile / retry / complete / fail-operation 都要求 op 处于 claimed / unknown / failed 且 claimId 匹配；`task_closed_before_spawn` 的 op claimId 为 null，永远匹配不上。
- team_inspect 和每个 team_* 动作的 MCP 返回体都带完整 team 视图；lead 是 root，看到的是整个团队。

## 设计

### 1. 压缩：closed work 移到 `TeamArchive`

新表 `TeamArchive(teamId, kind ∈ task|message|operation, id, state jsonb, archivedAt)`，主键 `(teamId, kind, id)`，随 AgentTeam 级联删除。只做 expand：旧镜像不读这张表，回滚后照常运行（只是看不到已归档的记录）。

**安全规则**（`compaction.ts` 的 `*Archivable`；`persistTransition` 对每条消失的记录都会再校验一次，不满足就整笔事务失败）：

| 记录 | 可以归档的条件 | 拒绝码 |
| --- | --- | --- |
| 消息 | 已送达或已取消；不是 schedule 消息（schedule 消息仍沿用自己的保留规则，直接删除）；taskId 为 null，或任务已 done/cancelled，或任务已被归档。DELETE 再校验已送达或已取消 | `unsafe_message_prune` |
| operation | completed，或者 `failed` + `task_closed_before_spawn`；不是该 bot 的源仓库 spawn（第一个带 directory 的 spawn，永远保留）；任务已结束或已归档。DELETE 再校验状态 | `unsafe_operation_prune` |
| 任务 | done/cancelled；cleanup 不是 pending/failed；没有未结束的后代任务；它的 operation 都已无后续动作，消息都已送达或已取消 | `unsafe_task_prune` |

**策略**（`compactTeam`，纯函数）：任务关闭、消息送达或取消、operation 创建满 **24 小时**后归档。任意一项用量 ≥ 50% 时放宽到 1 小时，仍 ≥ 50% 时去掉年龄要求。任务新增 `closedAt` 字段（accept、cancel、archive 时写入）；B-822 之前关闭的任务没有这个字段，用它最后一条消息或 operation 的时间代替。`team.compacted` 记录累计归档数量和最近一次归档时间。

**执行位置**：`actOnTeam` 在 `reduceTeam` **之前**先压缩，所以已经撞上限的团队，下一次写入就会解卡；`tickTeamSchedules` 在 advance 之前也压缩一次（只有触发了 schedule 才写库）。在写入之前压缩，「已送达」就一定是数据库快照里的状态，和 schedule prune 的「只删快照里已经结束的行」同一语义。

**有意的取舍**：已归档的记录不再出现在团队页和 inspect 里（数据还在 `TeamArchive`，可以查回）。idle digest 的「上一条消息」可能因此变早，至多重复提示一次 idle。

### 2. 上限错误：409 + used / limit / hint

`team_size_limit`、`team_message_limit`、`team_operation_limit`、`team_task_limit`、`team_bot_limit`、`team_bot_record_limit`、`team_depth_limit`、`team_schedule_limit`、`team_limit` 一律改为 **409**，body 为 `{ error, used, limit, hint }`。用 409 是因为旧 CLI 只读 409 的 code。CLI 读取所有 4xx 的 body：只要 code 以 `_limit` 结尾，就提示「容量上限，不是限流，重试无效」以及该怎么做。只透出 code 和 used/limit 两个数字，hint 用 CLI 自带的文案，不回显服务端文本。旧服务端返回的 429 + code 也走同一条提示。

### 3. 容量可见与 80% 提醒

- 每个读视图（owner、agent）都带 `capacity`：`{ metrics: { bytes, messages, operations, tasks: { used, limit } }, warning? }`，按完整记录计算，不受读者视角范围影响。
- 某一项第一次到 80% 时，reducer 给 lead（root bot，优先选有会话的那个）发一条系统消息（`taskId: null`，和 schedule 一样能送达）。`capacityWarned` 记录已经提醒过的指标，用量降到 70% 以下后清除，之后再次越过 80% 会再提醒一次。

### 4. MCP 返回体（评估 + 实现）

完整 lead 视图在事故团队里每次调用约 1–4 MB；压缩后稳态约 0.4 MB（长跑 fixture 峰值 444 KB），仍然太大。CLI `toolView.ts`：team_inspect 和所有动作结果默认返回精简视图：

- 未结束的任务完整保留，但只有当前 attempt 带 result；已结束的任务只留摘要（goal 和 result 截到 200 字）。
- 消息：未送达的全部保留，另加最近 20 条。
- operation：只保留未完成的，并去掉 prompt。
- 加一个 `omitted` 字段，写明省略了多少、怎么查完整内容。

`team_inspect { taskId }` 返回单个任务的全部内容，`{ full: true }` 返回完整视图。Codex stdio bridge 转发时用 `full: true` 取原始视图，再在本地生成精简视图；已经带 `omitted` 的视图不会再压一次。Web 和 HTTP API 的返回不变。

## 兼容与发布顺序

| 组合 | 行为 |
| --- | --- |
| 新 server + 旧 CLI | 上限错误返回 409 + code，旧 CLI 显示 `HTTP 409: team_size_limit`。MCP 仍返回完整视图（旧 CLI 没有精简视图，但压缩已经限制了体积） |
| 旧 server + 新 CLI | 429 + code 走容量提示；没有 `capacity` 和 `compacted` 字段，精简视图照常工作 |
| 回滚到旧镜像 | `TeamArchive` 被忽略；已归档的记录看不到；保留下来的源仓库 spawn 指向已归档的任务，只在 reconcile / complete 这类路径才会按 op 去查任务，而这些路径要求 op 未完成，所以不会触发 |

迁移 `20261026120000_team_archive` 只新增一张表（发布时按 operations 的 migration review 流程确认）。先 server/Web，后 CLI；两者之间没有硬依赖。

## 验收

- `compaction.spec.ts`：安全规则逐条测试；24 小时 / 压力分档；legacy 任务的年龄；80% 只提醒一次、降到 70% 以下后可再次提醒；上限错误为 409 + details。长跑 fixture：520 个周期（2080 条消息、1040 个 operation、520 个任务，跨 11 天），开启压缩时四项用量峰值都低于 80%；未结束的根任务、卡住的任务和它已认领的 spawn、源仓库都保留。关闭压缩时同样的流程撞上限（复现事故）。
- `store.pglite.integration.spec.ts`：24 小时后真的写进 `TeamArchive`，并从实时表里删除；未送达的消息、未结束的任务、源仓库 spawn 都保留；手工构造不安全的删除，三种情况都被拒绝。
- CLI：`refusal.test.ts`（409 和 429 两种情况）、`toolView.test.ts`、`tools.test.ts`（精简视图、taskId、full、不重复压缩）。
