# Automation precheck 与连续跳过合并

> 状态：Final（主 agent 2026-10-12 定稿：review 七项已修）
> 日期：2026-10-12 ｜ 关联 backlog：B-548 ｜ 前身：[Automations](2026-09-automations.md)、[Attention lifecycle](2026-09-attention-lifecycle.md)；参考 Orca `automation-precheck.ts` / `precheck-runner.ts` / `automation-run-operations.ts`（只读）

## 背景

定时 automation 常见形态是「每 5 分钟看一眼有没有新消息，有才起会话」。现在每次到点都会 spawn 一个 agent 会话，哪怕无事可做——烧额度、刷屏。Orca 的做法是在动作前跑一条廉价的 precheck 命令：退出码 0 才执行，否则记为跳过；连续同因跳过折叠成一条带计数的记录。

## 目标

1. Automation 可选配置一条 precheck：argv（`command`）或 shell 命令行（`shell`）二选一，`cwd`、`timeoutMs`（默认 60s，上限 600s）、`includeOutput`（把 stdout 附加到 spawn/send prompt）。daemon 领取 run 后先跑 precheck；退出码 0 才执行动作；否则 run 记 `skipped` + 原因码（复用 `error` 字段），**不新增 status enum**。超时杀整个进程组。输出截断 4000 字符。
2. **旧 daemon 绝不能在不跑 precheck 的情况下执行带 precheck 的动作。** daemon 在 claim 请求里宣告能力；server 只把带 precheck 的 run 派给宣告了 `precheck` 的 daemon，否则该 run 记 `skipped`（`precheck_unsupported_cli`）+ attention 一次。
3. 同一 automation 的**定时（`schedule`）**run 同一原因连续 `skipped` 折叠到最近一条（`fire` 每个事件的 payload/dedupeKey 必须可追溯、payload 关联会话不能跨事件继承 attention，`manual` 是显式意图——二者都不折叠），累加 `occurrenceCount`；原因变化或中间出现其它 run 时重新计数。Web 运行列表显示「×N」。
4. CLI `auto create/edit`、MCP `automation_create/update`、Web 表单支持 precheck；`docs/automations.md` 更新。
5. 零 Prisma migration。

## 非目标

- 不做 SSH/远端 precheck（Orca 有；本仓 automation 固定在 daemon 本机执行）。
- 不改 Team schedules。
- 不把 precheck 输出存成独立历史（只存在 skipped run 的 `summary` 里，与 script 的输出尾一致）。
- 跳过不触发 attention：普通 `precheck_failed`（非 0 退出）就是「没事做」；只有 `precheck_timeout` / `precheck_error` / `precheck_unsupported_cli` 提示（每个连续段至多一次）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| `Automation.action` / `trigger` 是 `Json` 列；`AutomationRun` 没有任何 JSON 列（只有 `summary`/`error`/`attentionReason` 文本与 `exitCode`） | `packages/happy-server/prisma/schema.prisma` `model Automation`、`model AutomationRun` |
| 请求 schema 是 zod `z.object`（默认 strip 未知键），旧 server 会**静默丢弃**新字段而不是 400 | `packages/happy-wire/src/automations.ts`；`automationRoutes.ts` `schema: { body: … }` |
| 并发 skip 已经用 `status: 'skipped'` + `error: 'previous_run_active'` 记原因 | `store.ts` `enqueueRun` |
| claim 只按 machineId 领取，claim 响应带 automation 快照（`toAutomationView(row)` 原样回 `row.action`） | `store.ts` `claimRuns`、`toAutomationView` |
| daemon 报告 schema 的 status 只有 `running|done|failed`；无 claimId 的账号级报告只能 done/failed | `automations.ts` `AutomationReportSchema`；`store.ts` `reportRun` |
| 旧 daemon 遇到未知 `action.kind`：`renderAction` 落到 script 分支（需 `command` 数组），`execute` 再落到 spawn 分支，`isSpawnAgent(undefined)` 为假 → `failNow(…,'invalid_action')`（失败 + attention，不执行） | `packages/happy-cli/src/automations/template.ts` `renderAction`；`daemon/automations/runner.ts` `execute` |
| 旧 Web 遇到未知 `action.kind`：`describeAction` 的 `default` 与 script 同分支，读 `action.command` | `packages/happy-web-v2/src/screens/automations/automationPresentation.ts` `describeAction`；`AutomationDetailScreen.tsx` `ActionCard` |
| script runner 已有进程组 kill（`detached` + `process.kill(-pid)`）与尾缓冲 | `daemon/automations/script.ts` `killScriptTree`、`TailBuffer` |
| Web 与 server 同一不可变镜像发布 | AGENTS 铁律 5 |

## 设计

### Wire（`happy-wire/src/automations.ts`）

```ts
AUTOMATION_PRECHECK_DEFAULT_TIMEOUT_MS = 60_000; AUTOMATION_PRECHECK_MAX_TIMEOUT_MS = 600_000;
AUTOMATION_PRECHECK_OUTPUT_MAX_CHARS = 4000;
AUTOMATION_DAEMON_CAPABILITY_PRECHECK = 'precheck';
AUTOMATION_SKIP_REASONS = previous_run_active | precheck_failed | precheck_timeout | precheck_error | precheck_unsupported_cli
AutomationPrecheckSchema = { command?: string[1..256], shell?: string(1..8000), cwd?: string, timeoutMs?: 1000..600000, includeOutput?: boolean }
  // refine：command 与 shell 恰好一个
AutomationCreateSchema.precheck?: AutomationPrecheck | null
AutomationUpdateSchema.precheck?: AutomationPrecheck | null   // undefined=保留，null=移除
AutomationClaimSchema.capabilities?: string[≤32]
AutomationReportSchema.status 增加 'skipped'（仅带 claimId 的 daemon 报告）
Automation.precheck?: AutomationPrecheck | null    // 新 server 总是带这个键（null 表示无）
AutomationRun.occurrenceCount?: number             // 缺省 = 1
```

响应类型字段全部可选（铁律 4/14）；未知 skip 原因码 Web 原样显示。

### 存储（零 migration）

全部放在 `Automation.action` JSON 列，由纯函数模块 `app/automations/storedAction.ts` 编解码，视图层永远只看到解码后的 `action` / `precheck`：

- 无 precheck：存原样 action（与现状逐字节相同），可附加私有键 `skipCounts`。
- 有 precheck：存**闸门包装** `{ kind: 'precheck', command: [<升级提示>], precheck, then: <原 action>, skipCounts? }`。
  - 目的是 fail-closed：server 回滚到旧版本时，旧 server 原样返回这个 action，旧 daemon 按「现状事实」走到 `invalid_action`（失败 + attention，**不执行动作**）；旧 Web 把它当 script 显示占位 argv，不崩溃。
- `skipCounts: Record<runId, number>`：连续跳过段头 run 的累计次数（≥2 才记），最多保留 50 个键（按插入顺序淘汰最旧）。
- `updateAutomation`：`input.action` 只替换内层 action；`input.precheck === undefined` 保留原 precheck，`null` 移除；`skipCounts` 总是保留。
- 写入 skipCounts 不递增 `version`、不改 `updatedAt`（运行态，不应让用户的编辑 CAS 失败）。

被否方案：
- `AutomationRun.occurrenceCount Int @default(1)` 新列——最直接，但加 migration 会挡住并行会话的发布（PROCESS §1）。若主 agent 更倾向列存储，可在后续单独 PR 加列并从 `skipCounts` 迁移，读路径只改 `occurrenceOf()` 一处。
- 把 precheck 作为 action 的普通兄弟键（不包装）：server 回滚后旧 daemon 会忽略它并**直接执行动作**，违背硬约束。
- 把计数编码进 `summary`/`exitCode`：语义污染，旧客户端会显示垃圾。

### 能力宣告与派发（server `claimRuns`）

- 新 daemon 的 claim 请求带 `capabilities: ['precheck']`。旧 server 的 zod 会剥掉该字段，无副作用。
- claim 事务中对每个待领取的 queued 头 run：解码其 automation；若有 precheck 且请求未宣告 `precheck` → 不领取，改记 `skipped`，`error='precheck_unsupported_cli'`，`summary='CLI too old to run this automation's precheck; upgrade very-happy-cli on this machine'`，按合并规则合并或新建 + attention 一次；释放 dedupe slot。
- 旧 daemon 的 claim 照旧拿到无 precheck 的 run；带 precheck 的 run 永远不会到它手上。

### daemon 执行（`daemon/automations/precheck.ts` + runner）

- 只在 `automation.precheck` 存在时运行；运行期间 run 以 `script` 形态被 track（child 挂上，复用租约续期、取消时杀树、`busy` 阻挡 handover）；precheck 期间不写 receipt（未执行动作 → daemon 重启时 run 只会 lease 过期为 `expired`，不会重复执行）。
- 执行：`command` 走 argv（渲染模板，同 script）；`shell` 用 `spawn(line, { shell: true })`（不渲染模板，payload 走 `VH_AUTOMATION_PAYLOAD` 环境变量，避免注入）。`detached`（POSIX 独立进程组），超时 SIGTERM 进程组、2s 后 SIGKILL。stdout 与合并输出各保留尾部 4000 字符。
- cwd：`precheck.cwd` → spawn 的 `directory`／script 的 `cwd` → 家目录；`~` 展开，必须绝对路径（否则 `precheck_error`）。
- 判定（纯函数 `evaluatePrecheck`）：退出码 0 且未超时、无启动错误 → 通过；超时 → `precheck_timeout` + attention；启动错误 → `precheck_error` + attention；否则 `precheck_failed`（无 attention）。
- 通过后：`includeOutput` 为真且 stdout 非空 → spawn/send/sticky 的 prompt 末尾追加 `\n\n[precheck output]\n<stdout>`；script 动作总是得到 `VH_AUTOMATION_PRECHECK_OUTPUT` 环境变量。
- 未通过：报告 `{ claimId, status: 'skipped', error: <原因码>, summary: <人话 + 输出尾>, exitCode, needsAttention? }`。若 server 以 400 拒绝 `skipped`（server 回滚的过渡窗口），改报 `failed`，同样不执行动作。

### 连续跳过合并（server，纯函数 `skipStreak.ts` + store）

`shouldMergeSkip(prev, next)`：`prev.status==='skipped' && prev.error===next.reason && prev.source===next.source && next.source==='schedule'`（review 修订：`fire` 与 `manual` 都不折叠）。prev 取同 automation 中紧挨在当前 run 之前（`createdAt,id` 序）的那条。

合并方向是**保留最新一条、删除前一条**：计数迁到最新 run（`skipCounts[new] = (skipCounts[prev] ?? 1) + 1`，删 `skipCounts[prev]`），attention 状态（`needsAttention/attentionReason/attentionAt/ackedAt/ackedBy`）从前一条原样继承，于是：
- 调用方手里的 run id（`fire` 返回的、daemon 正在报告的）始终有效，`--wait` 不会撞 404；
- 合并**永不重新拉起 attention**：前一条已 ack 则保持已 ack，未 ack 则继续挂着——「同一原因只提示一次」；
- 列表里该条的时间就是最近一次跳过的时间，`×N` 是连续次数。

适用三处：并发 skip（`enqueueRun` 新建 skipped run 后）、daemon 报 `skipped`（`reportRun`）、claim 时 `precheck_unsupported_cli`。中间出现任何其它 run（done/failed/新原因的 skip/manual）都会让 prev 不满足条件，从 1 重新计。

- `toRunView` 增加 `occurrenceCount = skipCounts[run.id] ?? 1`。

### 客户端

- **CLI** `auto create|edit`：`--precheck-shell '<line>'` 或 `--precheck-argv '<json array>'`（二选一），`--precheck-cwd`、`--precheck-timeout <dur>`、`--precheck-output`（includeOutput）、`--no-precheck`（edit 移除）。`show` 打印 precheck，`runs` 行对 `occurrenceCount>1` 显示 `×N`。
- **MCP** `automation_create` / `automation_update` 增加 `precheck`（update 可传 `null` 移除）。
- **新 CLI/MCP 连旧 server 的保护**（`automations/precheckCompat.ts`）：旧 server 会静默剥掉 `precheck`，于是 create 会造出一个「没有闸门」的 automation。带 precheck 的 create 先以 `paused` 创建，检查响应是否带 `precheck` 键：没有 → 立刻删除并报错 `This server does not support automation prechecks; upgrade the server`；有 → 若用户没要 paused 再 resume。edit 设置 precheck 时响应没有该键 → 报同样的错（旧 server 上不可能存在 precheck，动作行为未变）。
- **Web**：表单「动作」后新增「前置检查（可选）」分组：开关、模式（shell / argv）、命令、cwd、超时、「把输出附加到 prompt」；详情页动作卡下显示 precheck；运行行在 `occurrenceCount>1` 时显示 `×N`；skip 原因码转人话（未知原样）。Web 与 server 同镜像，不需要上面的兼容探测。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server + 新 Web + 新 CLI | 完整功能。 |
| 新 server + 旧 CLI（daemon） | 无 precheck 的 automation 不变；带 precheck 的 run 不派给旧 daemon，记 `skipped`/`precheck_unsupported_cli` + attention 一次，后续同因合并为 ×N；**动作永不执行**。旧 CLI `auto list/show` 看到解码后的 action（多出的 `precheck` 键被忽略），`auto edit --prompt …` 只发 `action`，server 保留 precheck。 |
| 新 server + 旧 Web | 不存在（同镜像）。回滚场景见下行。 |
| 旧 server（回滚）+ 任意 Web/CLI，库里已有 precheck automation | 旧 server 原样返回闸门包装 action：旧/新 daemon 都按未知 kind → `invalid_action` 失败 + attention，**不执行动作**；Web 显示为占位 script 不崩溃。无 precheck 的 automation 只多一个被忽略的 `skipCounts` 键。 |
| 旧 server + 新 CLI | claim 的 `capabilities` 被剥掉；server 不下发 precheck → 行为同现在。带 precheck 的 `create` 被检测并删除、报错；`edit` 报错。`skipped` 报告不会发生（无 precheck run）。 |
| 新 server + 新 CLI + run 进行中 server 回滚 | daemon 的 `skipped` 报告被 400 → 改报 `failed`，动作仍不执行。 |
| 旧 Web/CLI 读 `occurrenceCount` / `precheck` / 新原因码 | 均为可选字段，忽略；原因码作为 `error` 文本原样显示。 |

发布顺序：server/Web 镜像（无 migration）→ CLI。先发 CLI 也安全（旧 server 下新 CLI 行为不变）。回滚点：server 回滚依赖上面的 fail-closed 包装；CLI 回滚后带 precheck 的 run 改记 `precheck_unsupported_cli`。

## 风险

1. **`skipCounts` 存在 automation 行上**：每次合并多一次 automation 行写入，与 claim/编辑同处 SERIALIZABLE 事务，冲突走既有 `inTx` 重试。接受；频率 ≤ 触发频率。
2. **合并会删除较旧的 skipped run 行**：为保证旧 id 可追溯，`action` 列再存 `mergedInto[oldId]=newestId`（一跳、链式合并时重指、上限 200 条）；`GET /runs/:id` 与 `ack` 命中缺失 id 时扫本账号 automation（≤ 账号上限）跟随到新 run（响应 `id` 为新 run），`--wait` 轮询因此自动跟随。超出 200 条或新 run 被保留策略裁掉后才会 `run_not_found`——接受。
3. **shell precheck 的注入面**：`shell` 不渲染模板；payload 只经环境变量。argv 形态渲染模板（与 script 一致）。
4. **precheck 输出进 prompt**：可能把大量或敏感文本带进会话。默认关闭，上限 4000 字符，文档提醒。
5. **paused 创建再 resume** 对 `once` 且时间已过的 trigger：resume 用 `nextRunAfter`，过去的一次性时间不会再触发。接受（带 precheck 的过期一次性任务没有意义），文档说明。
6. **闸门包装的占位 argv 在回滚后的旧 Web 上会显示为 script**：只在回滚期出现，文案写明需要升级。接受。

## 验收标准

- [ ] wire：precheck schema（二选一、超时上下限）、create/update/claim/report 新字段单测。
- [ ] server 纯函数：`storedAction` 编解码（无 precheck 逐字节不变、包装形态、skipCounts 保留/淘汰）、`shouldMergeSkip`。
- [ ] server pglite 集成：precheck CRUD（update 不带 precheck 保留、null 移除、改 action 保留 precheck）；无能力 claim → skipped + attention 一次，第二次合并 ×2 且不再拉 attention、run 行数不增；带能力 claim → 正常领取且快照含 precheck；daemon 报 `skipped` 同因合并 / 异因不合并 / 中间 done 后重计；账号级报告不能报 skipped；并发 skip 合并。
- [ ] CLI：`evaluatePrecheck`、`appendPrecheckOutput`、precheck 执行（通过、非 0、超时杀进程组、argv/shell、截断）；runner：通过后执行并附加输出、失败报 skipped 不执行、claim 带 capabilities、400 回退 failed；parseAutoArgs/precheck flags；create 兼容探测（旧 server 剥字段 → 删除 + 报错）。
- [ ] Web：form 纯函数（draft↔precheck、校验）、×N 与原因码展示单测；tsc、vite build。
- [ ] docs/automations.md 用户说明；门禁（各包 tsc、相关 vitest）。

## 留真机验证项

- 无（UI 改动是表单字段与列表文本，桌面/窄屏截图由主 agent 集成验收时补）。
