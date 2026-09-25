# Automations：账号级定时 / 触发任务

> 状态：Shipped（server PR #424 `2099afca4`、CLI PR #425 `672766458`，随 CLI 0.2.152 发布；首批迁移 dev-sg `daily-work-inventory` / `tanka-dida-sync`，发布与迁移记录见 backlog B-496）
> 日期：2026-09-25 ｜ 关联 backlog：B-496（核心）、B-497（会话间消息与编辑冲突提示）、B-498（Web 自动化视图）
> 前身：[Team schedules](2026-09-team-schedules.md)（只服务 Teams，保持不变）

## 背景

Owner 的日常自动化（每日 Tanka 盘点、Tanka→滴答同步、IM 事件触发的代答会话）目前散落在 dev-sg 的 systemd timer 和私有常驻脚本里，只能 SSH 看、改、停。Team schedules 只能在 Team 内、由 root Bot 管、只会给 Bot 投递消息，没有 cron/时区，也不能直接起会话。
目标是让「定时 / 触发 → 起会话或续会话或跑脚本 → 可追踪的运行记录」成为账号级一等能力，任何入口（Web、终端 CLI、Claude/Codex/pi 托管会话）都能创建、查看、干预。

## 目标

1. 账号级 Automation：trigger（cron+时区 / 固定间隔 / 一次性 / 仅手动）+ action（spawn / sticky 会话续聊 / script）+ 目标 machine。
2. `very-happy auto fire <name>` 从本机任何进程触发一次运行，可带 payload 与去重键；这是事件触发器的唯一入口（不做公网入站 webhook）。
3. 每次运行有 AutomationRun 记录：状态机、会话链接、结果摘要、失败/超时/无人领取可见。
4. CLI 全量管理；所有托管会话（Claude/Codex/pi）注入 `automation_*` MCP 工具，读写权限与账号一致（Owner 明确不做权限收窄）。
5. 官方 skill 描述用法，随 `very-happy teams install` 同一机制物化。

## 非目标

- 公网入站 webhook、API token。
- 自动迁移 Team schedules（二者并存；共享纯函数）。
- 跨机器自动路由：每条 Automation 固定一台 machine。
- 预算 / token 限额（Owner 明确不要）。
- 任何组织 / IM 特定逻辑（Tanka 过滤、代答策略、滴答映射）——在仓库外的私有适配层。

## 设计

### 数据模型（server，Prisma，新表）

`Automation`
- id, accountId, name（账号内唯一，`[a-z0-9][a-z0-9-_.]{0,63}`）, description?, machineId
- status: `active | paused`
- trigger(jsonb): `{kind:'cron', expr, tz}` | `{kind:'interval', everyMs(≥60000), anchorAt}` | `{kind:'once', at}` | `{kind:'manual'}`
- action(jsonb):
  - `{kind:'spawn', agent:'claude'|'codex'|'pi'|..., directory, prompt, model?, permissionMode?, worktree?:boolean, sticky?:{key:string}}`
    - `sticky.key` 是模板（如 `{{payload.conversationId}}`）；同一 automation + 渲染后的 key 已有活会话时改为向该会话 send `prompt`，否则 spawn 并登记。
  - `{kind:'send', sessionId, prompt}`
  - `{kind:'script', command: string[], cwd?, env?: Record<string,string>, timeoutMs?}`
- concurrency: `skip | queue`（默认 skip：上一轮仍 running 时本轮记为 skipped）
- maxRuntimeMs（默认 6h；script 默认 30min）
- nextRunAt?, version, createdAt, updatedAt, lastRunAt?, lastRunStatus?

`AutomationRun`
- id, automationId, accountId, machineId
- source: `schedule | fire | manual`
- dedupeKey?（同 automation 24h 内唯一；重复 fire 返回原 run）
- payload?（text，≤64KB，模板里 `{{payload}}`/`{{payload.<path>}}` 取值）
- status: `queued → claimed → running → done | failed | skipped | expired | cancelled`；另有布尔 `needsAttention` + `attentionReason`
- sessionId?, stickyKey?, claimedAt?, leaseUntil?, startedAt?, finishedAt?, summary?(≤4KB), error?, exitCode?
- 保留：每 automation 最近 200 条 + 所有非终态。

`AutomationSticky`：(automationId, key) → sessionId, updatedAt。会话已归档/死亡时由 daemon 报告并清除。

模板变量：`{{payload}}`、`{{payload.a.b}}`（JSON payload）、`{{run.id}}`、`{{automation.name}}`、`{{now}}`（ISO，automation tz）。

### 调度（server 判定，daemon 领取执行）

- 到期计算为纯函数 `nextRunAfter(trigger, from)`；cron+tz 用锁定版本的库。离线错过多轮 → 只生成一条 run（与 team schedules 相同的合并语义），nextRunAt 推进到 now 之后。
- `POST /v1/automations/claim {machineId}`（账号认证，daemon 每 5s 调）：同一 Serializable 事务内 ① 为该 machine 物化到期 schedule run（CAS 推进 nextRunAt）② 按 concurrency 处理 ③ 领取 ≤8 条 queued run 标 claimed、lease 60s；返回 run + 渲染所需 automation 快照。P2034/P2010-40001 重试。
- `POST /v1/automations/runs/:id/report {status, sessionId?, summary?, error?, exitCode?, needsAttention?, attentionReason?, leaseMs?}`：daemon 续租 / 状态迁移（fencing：只有 claim 该 run 的 machine 可报告；终态不可回退）。
- 过期：claimed/running 的 lease 超时或超过 maxRuntimeMs → server 在下一次任意 claim/读取时标 `expired` + needsAttention。queued 超过 10 分钟未被领取（machine 离线）→ needsAttention（`machine_offline`），保持 queued。
- 旧 daemon 不调 claim：run 停在 queued 并在 10 分钟后标 attention，不静默。

### daemon 执行

- 新模块 `daemon/automations/`，独立 5s 循环（与 teams worker 同节奏，互不阻塞）。
- 执行前把 runId 写入本地 receipt（`~/.happy/automation-receipts.json`），重启后同一 runId 不再二次 spawn；未知结果报 `failed` + attention，不重试。
- spawn：复用现有 spawn 路径（与 `very-happy spawn` 同默认值），env 注入 `VH_AUTOMATION_RUN_ID`、`VH_AUTOMATION_NAME`；报 `running{sessionId}`。
- 完成判定：agent 调 `automation_report`/`very-happy auto report` 显式给终态优先；否则 wrapper 上报的 turn_ended（B-466 心跳）后该会话 idle 且无待处理消息 → `done`，summary 取最后一条 assistant 文本前 4KB（daemon 本地解密）。
- sticky：命中活会话则 send，run 跟随该会话本轮 turn 判定完成。
- script：spawn 子进程（非 shell，argv），合并 stdout/stderr 尾部 4KB 作 summary，exit 0 → done，否则 failed。超时 SIGTERM→10s→SIGKILL。

### 管理面

- REST：`GET/POST /v1/automations`，`GET/PATCH/DELETE /v1/automations/:id`（PATCH 带 version CAS），`POST /v1/automations/:id/{pause,resume,run}`，`POST /v1/automations/by-name/:name/fire {payload?, dedupeKey?}`，`GET /v1/automations/runs?automationId=&status=&attention=1&limit=`，`POST /v1/automations/runs/:id/{cancel,ack}`（ack 清 needsAttention）。
- CLI `very-happy auto`：`list | show <name> | create --name --cron '0 9 * * *' --tz Asia/Singapore|--every 5m|--at <iso>|--manual --spawn-dir … --prompt[-file] … [--agent --model --sticky-key] | --script -- <argv…> [--machine <id|this>] | edit | pause | resume | run | fire <name> [--payload-file f|--payload-json s] [--dedupe-key k] [--wait] | runs [--name] [--attention] | report --run <id> --status done|failed [--summary] [--attention reason] | ack <runId> | rm`。默认 machine = 本机。`--json` 输出。
- MCP（所有 runner，经现有 happy MCP / stdio bridge / HAPPY_MCP_URL）：`automation_list, automation_get, automation_create, automation_update, automation_pause, automation_resume, automation_delete, automation_run, automation_fire, automation_runs, automation_report, automation_ack`。
- 服务端开关 `VH_AUTOMATIONS_ENABLED=true`（B-502 起去掉 `VH_AUTOMATIONS_ACCOUNT_IDS` 账号白名单，全员开放；每账号 active+paused 合计上限 `MAX_AUTOMATIONS_PER_ACCOUNT`，默认 100，超出 429 `automation_count_quota_exceeded`）；关闭时路由 404，CLI 明确提示。
- 官方 skill `very-happy-automations`（与 teams skill 同目录机制，`very-happy teams install` 同时物化或新增 `very-happy skills install`）。

### Web 视图（B-498，`packages/happy-web-v2`，PR #427 待合并）

Owner 口径：自己只当决策者——页面回答「全自动任务跑得怎样」和「哪些要我处理」，并能在网页上完整管理（创建/编辑/暂停/立即运行/删除）。

- **入口**：侧边栏一级入口「自动化」，位于「团队」下方（同为"让多个 Agent 替我工作"的协作类入口，紧邻团队；待办/帮助保持其后），带 attention 计数徽标（`--danger`，与看板「等你处理」同语义）。路由 `/automations`（列表）、`/automations/new`、`/automations/:id`、`/automations/:id/edit`；首版的 `/board/automations*` 保留为重定向。`/board` 顶栏按钮与顶部「需要我决策」区保留。gate 关闭（404 `automations_disabled`）→ 侧栏入口与看板按钮隐藏、band 不渲染、直达页显示「未启用」说明，停止轮询，不报错。
- **需要我决策**（`screens/automations/AttentionSection.tsx`）：`GET /runs?attention=1` 的 run，按 `attentionRank` 排序（agent 等输入 → failed/expired/unknown_outcome/daemon_restarted/invalid_action → machine_offline → 其它；同级新→旧），为空不渲染不占位。每行：状态、原因（`attentionReason` 词表转人话，未知原因原样）、automation 名（→详情）、时间、会话链接、`error`；操作：打开会话、知道了（`/ack`）、再跑一次（`POST /:id/run`）、取消运行（仅未终态，二次确认；server 取消后仍保留 attention 时 Web 补一次 ack）。
- **列表**：按「定时」（cron/interval/once）与「触发器」（manual）分组；每行名称、描述、trigger 人话（`describeCron` 只翻译能如实成句的形状，否则原始表达式+时区）、机器在线点、下次运行、最近结果；操作：立即运行、暂停/恢复、编辑、删除（确认）。排序：有 attention → 未暂停 → 最近 nextRunAt → 名称。
- **详情**：触发/机器/下次/最近/最长运行+并发+version；「仅触发器」的自动化多一块「怎么触发」（`very-happy auto fire <name>`、带 `--payload-json`/`--dedupe-key` 的形式、MCP `automation_fire(...)`，均可复制）——把 manual 当作触发器呈现；动作摘要；sticky 列表；最近 50 条 run 时间线。
- **创建/编辑**（`AutomationFormScreen.tsx` + 纯函数 `automationForm.ts`）：基本（名称、机器、描述）→ 触发（cron+时区，字段实时预览人话 / 间隔 `15m` `1h30m` / 一次性 datetime-local / 仅触发器）→ 动作（spawn：agent、目录、模型、权限模式、worktree、粘性 key、prompt；send：会话 id、prompt；script：argv 一行按 shell 引号拆分不做展开、cwd）→ 限制（并发 skip/queue、最长运行）。提交前用 wire zod schema 校验；编辑只 PATCH 变化字段 + `version` CAS。server 拒绝映射到字段：`automation_name_taken`、`invalid_cron`、`invalid_timezone`、`machine_not_found`、`stale_automation`（提示重开）。
- **数据层**：`sync/apiAutomations.ts` + `sync/automationsStore.ts`（zustand，独立于 storage/sync 热区）。轮询仅页面可见时：侧栏 60s、看板 20s、列表 15s、详情 10s；恢复只挂 `sync.onResume`（AGENTS #13）。
- **文档与引导**：Help / 首次使用页新增「自动化 · 定时与触发」区（`onboarding/AutomationsGettingStarted.tsx`，gate 关闭时 CTA 换成说明）、Agent skills 区新增 `very-happy auto skill` 卡、帮助手风琴 `organize` 组加「自动化」；公共文档 `/docs/automations`（en/zh 同结构）；仓库 `docs/automations.md` 用户指南，README（en/zh）、`docs/README.md`、`docs/getting-started.md`、`docs/channels.md` 交叉链接。
- **状态语义**：`--accent` 只用于 claimed/running；failed/expired 与 attention 用 `--danger`；done/skipped/cancelled/queued 中性。窄屏 979px 以下单列，coarse 指针按钮/输入 44px、输入 16px。
- 验证：`automationPresentation.test.ts`、`automationForm.test.ts`、`automationsStore.test.ts`、`automationsGettingStarted.test.ts`、公共文档双语结构测试；真浏览器 1280 与 390（coarse）× 明暗截图，无横向溢出。

## 兼容矩阵与发布顺序

| | 旧 server | 新 server |
|---|---|---|
| 旧 daemon | — | 不领取；run queued→10min attention，可见不静默 |
| 新 daemon | claim 404 → 跳过（每 10 分钟最多一条 debug 日志） | 正常 |

发布：server/Web 镜像（含 migration，纯新增表）→ CLI。回滚：server 回滚后新表保留无害；CLI 回滚即停止执行。

## 风险

1. 权限面：任何托管会话可建 script/spawn automation——Owner 明确接受（与现有 bypass spawn 同一信任级）。
2. 重复执行：receipt + claim fencing + 未知结果不重试；代价是偶发漏执行（可见 attention）而非重复。
3. 完成判定误差：无显式 report 时以 turn idle 判定；长任务应显式 report。
4. payload 明文存 server：服务端本就可信且非 e2e；保留期 = run 保留条数。

## 验收标准

- [x] cron+tz / interval / once / manual 的到期计算单测（含 DST、错过多轮合并、anchor 相位）。
- [x] claim 并发幂等（两个并发 claim 不重复物化/领取）、lease 过期、fencing、终态不可回退、dedupeKey 幂等。
- [x] daemon：spawn / sticky 命中与失效 / send / script 成功失败超时；重启不重复 spawn；旧 server 404 降级。
- [x] CLI 全命令 + `--json`；MCP 三 runner 可见工具列表回归。
- [x] 本地全栈 e2e：create cron 每分钟 → 自动 spawn → done；fire 带 payload → sticky 同 key 二次续聊同会话。
- [ ] Web 视图（B-498，PR #427）：侧栏入口 + 看板「需要我决策」+ 分组列表 + 详情（触发方式可复制）+ 创建/编辑表单 + 帮助/引导/公共文档，gate 关闭时隐藏；真浏览器四组截图无溢出。
- [x] 门禁全绿；spec 状态更新为 Shipped + commit。
