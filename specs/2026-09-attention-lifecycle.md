# Attention lifecycle：「需要我决策」的自动关联与自动消解

> 状态：Final
> 日期：2026-09-27 ｜ 关联 backlog：B-508 ｜ 前身：[Automations](2026-09-automations.md)（B-496/B-498）

## 背景

Owner 原话：「需要我决策好像没有自动关联的能力。我怎么勾选掉呢？」

生产实况（2026-09-27，`vh-db.py` 只读查询）：6 条 `needsAttention` run，全部 `status=done`；
`session-harvest-worker` 的 run 带 `payload.sessions[]`（被沉淀的会话 id/url），`attentionReason`
是自由文本 `needs_decision: …` 并内嵌别的会话链接；`daily-work-inventory` 的 reason 是「等 jojo 在分诊页勾选」。
Owner 在这些会话里回复、把会话归档、或 agent 后来报 done，都不会让 run 离开「需要我决策」；唯一出路是
逐条点「知道了」。而 `/automations` 页上这条带还被裁成一行（见现状事实），Owner 实际只看得到 6 条里的第 1 条。

## 目标

1. **自动关联**：一条 run 的「关联会话」= `run.sessionId` ∪ payload 里声明的会话（`sessions[].id` / `sessions[]` / `sessionId` / `sessionIds[]`），服务端算、随 run 视图返回。
2. **自动消解**（服务端，任何客户端都生效）：
   - Owner 在关联会话里发消息 → 该 run `needsAttention=false`，`ackedBy=owner-replied`；
   - 同一 run 之后被报 `done` 且未带 attention → `ackedBy=run-done`；
   - 关联会话被归档（`POST /v1/sessions/:id/archive`，即用户意图归档，B-505）→ `ackedBy=session-archived`。
3. **会话内可见、可勾选**：有未处理 attention 的会话页顶部一条横幅（原因、来源 automation、「知道了」、可关闭）；侧栏该会话带标记。
4. **列表勾选**：每行一个明确的勾选控件（桌面 + 390px coarse ≥44px），带「全部已读」；CLI `very-happy auto ack --all [--name]`。

## 非目标

- 不解析 `attentionReason` 文本里的 URL 当关联（只认 payload 结构与 `run.sessionId`）。
- 不给 attention 建独立表、不做推送通知（B-498 的轮询节奏不变）。
- 不改 Team schedules。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| attention 只有 `needsAttention/attentionReason` 两列，`ackRun` 只清标志，无时间、无来源 | `packages/happy-server/prisma/schema.prisma` `AutomationRun`；`sources/app/automations/store.ts` `ackRun` |
| `reportRun` 终态 done 不动 `needsAttention`（`input.needsAttention` 未给时保持原值） | `store.ts` `reportRun`（`if (input.needsAttention !== undefined) …`） |
| daemon 的 `needs_input` 每个 run 只报一次（`attentionReported` 不复位） | `packages/happy-cli/src/daemon/automations/runner.ts` `report(sessionId,'blocked')` |
| 消息落库只有两处入口：socket `message`（`connection.connectionType` 可区分 wrapper `session-scoped` 与客户端 `user-scoped`）与 `POST /v3/sessions/:id/messages`（`X-Happy-Client` 头） | `sources/app/api/socket/sessionUpdateHandler.ts`；`sources/app/api/routes/v3SessionRoutes.ts` |
| 网页经 relay 发的消息由 wrapper 用 `cli-coding-session/<ver>` 头 POST v3，localId 是网页的 `randomUUID()` | `packages/happy-cli/src/api/apiSession.ts` `session-message-deliver` |
| 自动化派发的用户消息 localId 有固定前缀：`automation-<runId>`、`teams-*`、`remote-send-*`、`session-message-*`、`edit-conflict-*`；`X-Happy-Client` 标签 `automation` / `teams` / `cli-spawn` / `assistant-mcp` / `session-message` | `runner.ts` `defaultSend`；`teams/worker.ts`；`remoteSessionClient.ts`；`peerTools.ts`；`peerCoordinator.ts`；`commands/sessionMessage.ts` |
| 消息正文（含 `meta.sentFrom`）账号密钥加密，server 读不到 | `sessionMessageStore.ts`（`content: { t: 'encrypted' }`） |
| 归档只有一条路由，`/deactivate`（B-505 基础设施原因离线）不算归档 | `sources/app/api/routes/sessionRoutes.ts` `/archive`、`/deactivate` |
| `/automations` 上「需要我决策」带被裁成 96px 只露 1 行：`.au-attn{overflow:hidden}` 是 `.au-body`（column flex，`min-height:0`）的可收缩子项；`/board` 用 `.bd-attn-wrap{flex-shrink:0}` 所以全显示（6 行占满整屏） | `screens/automations/automations.css`；`screens/board/board.css`；线上 `index-B9LiGoFP-20bffc178…` 实测 `.au-attn` height 96 / scrollHeight 693 |
| 每行「知道了」按钮存在（桌面 26px 高；coarse 下 `.au-btn{min-height:44px}`），但在被裁的带里只有第 1 行可见 | `AttentionSection.tsx`；`automations.css` `@media (pointer: coarse)` |
| 会话页横幅位置：`SessionDetailScreen` 在 `ChatHeader` 下按顺序挂 `MirrorBanner / SessionArchivedBanner / StaleWrapperBanner / ModelSupportBanner`，样式 `mirror.css` `.mrb*`（coarse 44px 已有） | `screens/session/SessionDetailScreen.tsx:181-185` |
| 侧栏行信号只有 `attention/unread`（`sidebarAttention.ts`），自动化 attention 只在导航入口角标 | `screens/sessions/Sidebar.tsx:146-149, 953-956, 1095` |
| Web 自动化数据层独立于 storage/sync 热区（zustand + 轮询） | `sync/automationsStore.ts` |

## 设计

### 数据（server，Prisma 纯新增列 + 索引）

`AutomationRun` 新增：`attentionAt DateTime?`（每次 `needsAttention` 变为 true 时写）、`ackedAt DateTime?`、`ackedBy String?`；索引 `(accountId, needsAttention)`。
不新增「关联会话」列：关联是 `(sessionId, payload)` 的纯函数 `linkedSessionIds(run)`（`attentionLifecycle.ts`），
payload 为合法 JSON 时取 `sessions[]`（元素为字符串或 `{id}`）、`sessionId`、`sessionIds[]`，id 校验 `/^[A-Za-z0-9_-]{8,64}$/`，去重、上限 64。
存量 run 无需回填。

`ackedBy` 词表：`owner`（显式 ack，默认）、`owner-replied`、`run-done`、`session-archived`、`cancelled`（Web 取消后补 ack）、`machine-back`（claim 时机器回来清 `machine_offline`）。

### 判定「Owner 消息」（server 纯函数 `isOwnerAuthoredMessage`）

输入 `{ localId, client, connectionType }`；为 Owner 当且仅当：
- 不是 wrapper 自己（socket `connectionType !== 'session-scoped'`；v3 路由无此项）；
- `localId` 不以自动化前缀开头（`automation-`、`teams-`、`remote-send-`、`session-message-`、`edit-conflict-`）；
- `X-Happy-Client` 标签（`/` 前的部分）不在 `automation`、`teams`、`cli-spawn`、`assistant-mcp`、`session-message`、`daemon-auto`。

- `cli-coding-session`（wrapper 自己）只有带 `X-Happy-Message-Origin: relay-client` 时才算——wrapper 用同一个头既持久化**自己的 agent 输出**，也代持久化网页经 relay 发来的消息（e2e 实测：不区分会把 agent 的 `automation_report` 回声当成 Owner 回复，run 报 attention 后 7ms 就被清掉）；CLI ≥ 0.2.158 在 relay 路径加该头。旧 wrapper 下网页回复由 Web 自己补 ack（下文横幅）。

因此：网页/App 直连（`web/…`）、新 wrapper 代持久化的网页消息、终端 `very-happy send`（`cli-send`，人手动发）算 Owner；自动化、Teams、跨机 `sessions send`、peer 消息、冲突提示、wrapper 自己的输出不算。正文加密，所以**不看 `meta.sentFrom`**。

### 服务端钩子（`app/automations/attentionLifecycle.ts`，best-effort，不影响主流程）

- `noteSessionMessage({accountId, sessionId, localId, client, connectionType})`：`isOwnerAuthoredMessage` 为真 → `resolveAttentionForSession(accountId, sessionId, 'owner-replied')`。挂在 socket `message` 成功落库后与 v3 POST `createdMessages.length>0` 后；`VH_AUTOMATIONS_ENABLED` 关闭时直接返回；任何错误只 log。
- `noteSessionArchived(accountId, sessionId)`：挂在 `/archive` 路由 `count>0` 后，`by='session-archived'`。
- `resolveAttentionForSession`：查该账号 `needsAttention=true` 的 run（索引），JS 过滤 `linkedSessionIds(run)` 含该 session，逐条 `needsAttention=false, ackedAt=now, ackedBy=by`。
- `reportRun`：`input.status==='done'` 且 `input.needsAttention!==true` 且 row 有 attention → 同样清除，`by='run-done'`（daemon 的 claimId 报告与 agent 的账号级报告都算；`failed` 不清）。
- `ackRun(accountId, runId, by='owner')`：路由 body `AutomationAckSchema { by?: string(1..64) }`，旧客户端不带 body 即 `owner`。

### daemon（CLI）

`runner.report(sessionId,'idle')` 复位 `attentionReported`：Owner 回复后 server 已清标志，agent 再次阻塞时能重新上报 `needs_input`（server 端幂等）。

### Web

- **带（AttentionSection）**：`.au-attn{flex-shrink:0}` 修裁切；每行最左一个圆形勾选按钮（`.au-attn-check`，`aria-label`=知道了，coarse 44×44）= 「知道了」，动作区不再重复文字按钮；头部「全部已读 (N)」按钮（N>1 时显示），逐条调 ack。`/board` 上列表区 `max-height: 40vh; overflow-y: auto`，不再把看板顶出屏幕。
- **会话横幅 `AutomationAttentionBanner`**：挂在 `SessionDetailScreen` 的 `SessionTeamContext` 之后、其它横幅之前（mirror 除外）。数据 = `useAutomations().attention` 里 `linkedSessionIds` 含当前会话的 run（老 server 不返回该字段时退化为 `run.sessionId`）。内容：原因（词表转人话或原样）、automation 名（链接到详情）、多条时「+N」；动作「知道了」（逐条 ack）、关闭（仅本次挂载，`useState`）。横幅挂载时按看板节奏轮询（20s）。当前会话里出现新的 `user-text` 且 `meta.sentFrom` 不在自动化集合（`automation/team/session-peer/assistant`）→ 立即隐藏并对关联 run 逐条 `ack(by=owner-replied)`（旧 wrapper 不打 origin 头时服务端认不出网页消息；新 wrapper 下服务端已清、ack 幂等），再 `refreshOverview`。
- **侧栏**：`automationAttentionKeys` = attention run 的 linkedSessionIds；`SidebarRow` 新 prop `automationAttention` → 标题行一枚 `Zap` 小标（`.sb-row-auto-attn`，`--danger` 色，title「自动化待决策」）。不改 `rowSignalOf`（那是 agent 阻塞语义）。
- 数据层：`automationsStore.ack(runId, by?)`、`ackAll(runIds?)`；`apiAutomations.ackRun(id, by?)`。纯函数 `runSessionIds(run)`、`attentionRunsForSession(runs, sessionId)`、`isOwnerAuthoredUserMessage(meta)` 进 `automationPresentation.ts` 单测。

### CLI

`very-happy auto ack --all [--name <automation>] [--json]`：`runs --attention`（可按 name）后逐条 ack；输出条数。MCP `automation_ack` 不变。

## 兼容矩阵与发布顺序

| | 旧 server | 新 server |
|---|---|---|
| 旧 Web/CLI | — | 忽略新字段 `attentionAt/ackedAt/ackedBy/linkedSessionIds`；ack 不带 body 即 `owner` |
| 新 Web | `linkedSessionIds` 缺失 → 退化为 `run.sessionId`；`ack` body 被忽略 | 正常 |
| 新 CLI | `ack --all` 只用既有 `runs`+`ack` 路由，可用 | 正常 |

发布：server/Web 镜像（含 migration，纯新增列）→ CLI（`ack --all`、runner 复位）。回滚：server 回滚后新列保留无害；Web 回滚即回到裁切前的带；CLI 回滚只失去 `--all`。

## 风险

1. 误判 Owner：`very-happy send`（`cli-send`）与未知客户端算 Owner。接受——它们都是人或 Owner 自己的脚本在该会话里说话，与「Owner 介入」语义一致；被清的 run 仍在 run 时间线里可查（`ackedBy` 可见）。
2. 每条消息多一次索引查询（`(accountId, needsAttention)`，命中行数通常个位数）；开关关闭时零开销。
3. payload 关联的会话往往在 run 产生前就已归档（harvest 场景），归档钩子对它们不触发——预期；Owner 恢复后回复即触发 `owner-replied`。
4. 横幅依赖轮询，最长 20s 才出现；Owner 从带上点「打开会话」时 store 已有数据，即时显示。

## 验收标准

- [ ] server pglite 集成：payload 关联解析；Owner 消息（v3 `web/`、`cli-coding-session/` 头；socket user-scoped）清除、自动化前缀/标签不清除；done 报告清除、failed 不清；归档清除；`ackedBy/ackedAt/attentionAt` 视图字段；ack body `by`。
- [ ] `isOwnerAuthoredMessage` / `linkedSessionIds` 单测；mutation-check 覆盖源码断言。
- [ ] CLI：`parseAutoArgs(['ack','--all'])`、`ack --all --name`；runner idle 复位后再次 blocked 会再报。
- [ ] Web：`automationPresentation` 纯函数单测；store `ackAll`；带 `flex-shrink:0` 源码断言；1280 与 390（coarse）× 明暗四组截图（/automations、/board、会话横幅、侧栏标记），无横向溢出，勾选控件 ≥44px。
- [ ] 门禁全绿；backlog B-508、changelog `sep27`、docs/automations.md、docs/channels.md 同步；spec 回标 Shipped。

## 留真机验证项

- 手机上横幅关闭按钮与勾选按钮的触感（浏览器 coarse 模拟只能验尺寸）。
