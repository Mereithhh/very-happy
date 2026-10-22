# 汇报板（Briefing）：AttentionItem 契约与存储

> 状态：Draft（W0 契约待 Lead 审）
> 日期：2026-10-22 ｜ 关联 backlog：B-766 ｜ 出处：B-766 设计稿 §4、§6、§7（Owner 10-22 拍板方案 C、D1～D7 按推荐）

## 背景

负责人（团队根成员）没有结构化通道向 Owner 汇报：需要拍板的事只能贴在消息流里，被成员消息和 idle 通知淹没（样本中 13 个决策被重复贴了 196 次）。`request_human` 不持久化、刷新即丢；根任务的 `team_submit` 被 reducer 直接丢弃。

## 目标

1. 一张明文表 `AttentionItem` 承接所有「需要你」：负责人上板（decision / todo / report / answer）、`request_human`（blocked）、Owner 提问（question / request）、钉（pin）、根任务提交（team）、二期的自动化 attention。
2. `happy-wire` 给出 W0 契约：条目 schema、`attention-item` update 事件、`/v1/attention-items` 请求与响应、`owner_board_post/update/resolve/list` 工具入参与出参。CLI（C-1）和 Web（W-1/W-2）只依赖这份契约并行开工。
3. S-1：server 存储、按 `(sessionId, key)` upsert 去重、同一条目 push 至多一次、根任务 submit 写「待你验收」、会话归档时清理、Owner 回复自动 resolve，全部在 feature 开关后面。

## 非目标

- 条目内容端到端加密（D1 定为明文，与 Teams / Projects 同级）。
- 回填历史 `request_human` 或 `AutomationRun` attention（二期 W-3 再写 item）。
- server 代 Owner 往会话里写消息：看板上的选择由 Web 以 Owner 身份发普通消息（`meta.boardItemId`）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 根任务 `ownerBotId=null`，`msg()` 在 recipient 为空时直接 return，根任务 submit 的消息被丢弃 | `packages/happy-server/sources/app/teams/reducer.ts:113` |
| teams 功能开关是 env `VH_AGENT_TEAMS_ENABLED`，关时 404 `teams_disabled` | `packages/happy-server/sources/app/teams/store.ts:13-15` |
| 自定义 update 的写法：wire 定义 `t` 字面量 body schema，server `build*Update` 构造 | `packages/happy-wire/src/promptQueue.ts:45-50`、`packages/happy-server/sources/app/events/eventRouter.ts:749` |
| 自动化 attention 已有「Owner 回复即 ack」（`owner-replied`）规则 | `packages/happy-server/sources/app/automations/attentionLifecycle.ts` |
| push kind 只有 done / permission / question / attention，server 不去重 | `packages/happy-server/sources/app/push/pushDispatch.ts` |
| wire 惯例：请求 schema 严格；响应用开放字符串，新 server 加枚举值时旧端不丢消息 | `packages/happy-wire/src/automations.ts:3-5` |

## 设计

### 契约（`packages/happy-wire/src/attention.ts`）

| 名称 | 内容 |
|---|---|
| 枚举 | `ATTENTION_SOURCES` lead / agent / owner / automation / team；`ATTENTION_KINDS` decision / todo / blocked / report / answer / question / request / pin；`ATTENTION_STATES` open / in_progress / answered / resolved / dismissed；`ATTENTION_RESOLVED_BY` owner / owner-replied / lead / auto-first-reply / run-done / session-archived |
| 纯函数 | `attentionKindNeedsOwner`（decision / todo / blocked）、`attentionPushKind`、`attentionResolveState`、`isAttentionActive`、`ownerBoardPostToRest` |
| 条目 | `AttentionItemSchema`：kind / state / source / resolvedBy 为开放字符串；时间为 epoch ms；`version` 每次变更 +1；`firstReply` 为 CLI 自动挂回的首次回复锚点 |
| update | `{ t: 'attention-item', item }`，发给账号所有连接，全量快照；条目不硬删除，客户端按 id 取最大 version |
| REST | `POST /v1/attention-items`（upsert）、`PATCH /:id`、`POST /:id/resolve`（agent 侧）、`POST /:id/owner-respond`（choose / resolve / reopen）、`GET /v1/attention-items`（sessionId / state / needsOwner / since / limit） |
| 工具 | `owner_board_post`（kind 限 decision / todo / report / answer；decision 必须 2～4 个选项；`anchor` 默认 `this_turn`，由 CLI 解析成锚点）、`owner_board_update`（state 只能 open / in_progress）、`owner_board_resolve`（done / answered / dropped / superseded）、`owner_board_list` |
| 能力与开关 | wrapper 在 `metadata.capabilities` 声明 `owner-board-v1`；server env `VH_OWNER_BOARD_ENABLED=true` 才开启（与 `VH_AGENT_TEAMS_ENABLED` 并列，默认关，Owner 的部署打开），关闭时所有路由 404 `owner_board_disabled`、钩子不动作 |

`resolve` 的结果：done → resolved，answered → answered，dropped / superseded → dismissed。

### 去重与幂等

- 同一 `(sessionId, key)` 再 post：条目仍是 open / in_progress 时，更新内容并 `repostCount+1`；已关闭时重新打开（state=open，清 resolved*，允许再推一次）。
- 不带 `key` 时，`requestId` 保证幂等；同一 `requestId` 重试返回原条目，不累加 `repostCount`。
- `request_human` 用 `key = hash(reason)` 取代 CLI 进程内 60 秒去重。

### Push

- 只推 `attentionPushKind` 非空的条目：decision / todo / blocked → `attention`；回答 Owner 问题的 answer → `question`；report / pin 不推；`inferred`（D5 自动识别草稿）不推，负责人确认后再推一次。
- 以 `pushedAt` 为水位，用条件更新（`pushedAt IS NULL`）抢占，保证同一条至多推一次；重新打开时清空 `pushedAt`。
- 前台在线静默规则不变。

### 自动 resolve

- Owner 在会话里发言（判定沿用 `isOwnerAuthoredMessage`）：会话里唯一一个开放的 decision 置为 resolved、`resolvedBy='owner-replied'`；有多个开放 decision 时不动。D5 草稿（`inferred=true`）不参与计数也不会被关：Owner 没看到它被正式提问，聊天不能算回答（S-1b，C-1 实测复现）。消息正文是加密的，server 读不到 `meta.boardItemId`，所以看板按钮发出的 Owner 消息用 `attentionBoardLocalId`（localId 前缀 `board-`）标记，server 见到这个前缀就跳过自动 resolve——对应条目已经由 `owner-respond` 处理，不能顺手关掉另一条 decision。
- 会话归档：所有开放条目置为 dismissed、`resolvedBy='session-archived'`。
- 根任务 `team_submit`：写一条 `source='team'`、`kind='decision'`、标题「根目标已提交，等你验收」的条目，选项「验收 / 退回」；Owner 选择后映射为团队的 accept / return。

### S-1 实现（server）

| 部分 | 位置 |
|---|---|
| 迁移 `20261022120000_attention_items`：只新增 `AttentionItem` 一张表（FK 到 Account / Session，级联删除），不回填；回滚 `DROP TABLE "AttentionItem";` | `packages/happy-server/prisma/migrations/` |
| 纯规则：post 计划（create / noop / repost、关闭条目重开）、根任务状态迁移、「待你验收」条目、owner-replied 目标、push 文案、answered 每会话保留 2 条 | `sources/app/attention/rules.ts` |
| 存储：SERIALIZABLE `inTx`；并发首插同 key 时输家撞唯一索引（P2002）后整笔重试、落成 repost；push 用 `UPDATE … WHERE pushedAt IS NULL` 抢占 | `sources/app/attention/store.ts` |
| 根任务 submit：`actOnTeam` 在同一事务里比较前后状态，root task 变成 submitted 时在负责人会话写条目（key `team-submit:<taskId>`，requestId 按 attempt），离开 submitted 时关闭；看板「验收 / 退回」先执行团队 accept / return | `sources/app/teams/store.ts`、`attention/store.ts` |
| 钩子：消息入口（socket / v3 HTTP）调用 owner-replied；归档入口调用 session-archived | `sessionUpdateHandler.ts`、`v3SessionRoutes.ts`、`sessionRoutes.ts` |
| 路由 | `sources/app/api/routes/attentionRoutes.ts` |

看板选择与已关闭条目：同一选项重复提交返回原条目；关闭后换选项返回 409（普通条目 `attention_item_closed`，根任务条目 `attention_item_stale`），需要先「追问」重开。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server + 旧 Web | 旧 Web 的 `ApiUpdateContainerSchema` 解析 `attention-item` 失败，只打一条 console 日志并忽略（`happy-web-v2/src/sync/sync.ts` `handleUpdate`；账号级 update 没有 seq 断档检测，不会触发重同步）；看不到汇报板，其他功能不受影响 |
| 新 server + 旧 CLI | 旧 CLI 不注册 `owner_board_*`，`request_human` 继续写 `metadata.board.attention`，新 Web 两者都兼容一个版本 |
| 旧 server + 新 CLI / Web | `/v1/attention-items` 404：CLI 不暴露工具、`request_human` 退回旧路径；Web 不显示汇报板入口 |
| 开关关闭 | 等同旧 server（404 `owner_board_disabled`） |

发布顺序：server（含迁移，只新增一张表，不回填）→ Web → CLI。回滚：关闭开关即可；表保留，不影响旧代码。

## 风险

1. 条目内容 server 可读：D1 已由 Owner 确认，与 Teams / Projects 同级。
2. 自动识别草稿（D5）可能刷屏：
   - 条目带 `inferred: true`（只有 CLI 的 D5 识别路径会设置，`owner_board_post` 不开放该参数），Web 显示「自动识别」标签，Owner 能分清是负责人主动上板还是系统推断。
   - `inferred` 条目不推送，只进看板和徽标（`attentionPushKind` 对其返回 null）。
   - key 取选项文本哈希，重复识别只累加 `repostCount`；草稿不会把已确认的条目降级为 inferred。
   - 负责人随后用 `owner_board_post` 发同一个 key：条目改为 `inferred: false`，按正常规则推送一次（草稿期间从未推送，`pushedAt` 仍为空）。
   - 开放条目软上限 5 条（`ATTENTION_LIMITS.openPerSessionSoftCap`）。
3. 并发 upsert：依赖 `@@unique([sessionId, key])` 加冲突重试（P2002 / P2034 / 40001），S-1 用并发测试覆盖。

## 验收标准

- [ ] W0：wire schema、update 事件、REST 与工具入参出参有单测；wire build、vitest 通过。
- [ ] S-1：迁移只新增一张表；`/v1/attention-items` CRUD 与 owner-respond；并发 upsert 去重；push 至多一次；根任务 submit 写条目（修 `reducer.ts:113`）；归档清理；`owner-replied` 自动 resolve；feature 开关。
- [ ] server vitest（含 PGlite）覆盖迁移、并发去重、push 只发一次。

## 留真机验证项

无（server 与 wire 均可自动化验证；UI 部分见 W-1 / W-2）。
