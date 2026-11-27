# 模型回答反馈、请求打标、全局模型渠道与全局通知（实例配置驱动）

> 状态：Shipped（commit `e8bffae2`，CLI 0.2.233）
> 日期：2026-11-27 ｜ 关联 backlog：B-980（本文）、B-981 全局模型渠道、B-982 全局通知 ｜ 出处：Owner 11-27「反馈做成 Very Happy 通用能力：记录存在 VH，同时可转发到外部接口；VH 发往模型网关的请求要带会话 id header 和 request id；所有接入只通过配置给出」

## 背景

有团队在自己的模型网关上挂自部署模型，想让同事在 Very Happy 里用它写代码，并对每轮回答点 👍/👎。反馈要能精确对上网关的请求记录（会话、每次请求），才能回流做训练。Very Happy 是开源项目，网关、header 名、转发目标都只能来自部署方配置。

## 目标

1. 实例配置文件 `VH_INSTANCE_CONFIG_FILE`：运营方一处配置，热加载，`${ENV}` 引用密钥。
2. 模型请求打标：命中配置 `hosts` 的 Claude 会话，每个模型请求带「会话 id」「请求 id」两个 header（名字来自配置）；本轮的请求 id 随 turn-end 上报。
3. 每轮最终回答下的 👍/👎（👎 可写一句），存在本服务器数据库；可选转发到配置的外部接口；管理员导出 JSONL/CSV，记录带会话 id、轮次 id、请求 id。

## 非目标

- 网关侧怎么记录 header、怎么接收转发：部署方自己的系统。
- Codex / pi 会话打标：Codex 随 B-981 全局渠道评估；pi 无会话级账号，不做。
- 反馈里带对话原文：网关已有请求原文；VH 只给 id。
- 截图、工单、回复用户（B-836 的非目标沿用）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude 会话所有子进程继承 wrapper 的 `process.env`（含 `ANTHROPIC_BASE_URL`） | `happy-cli/src/claude/sdk/query.ts` env 组装；`agentProfiles/wrapperAccount.ts` |
| `ANTHROPIC_CUSTOM_HEADERS` 是进程级静态值，无法逐请求变化；Claude Code 自带 `x-client-request-id` 但 wrapper 读不到它的值 | Claude Code 2.1.330 二进制字符串 |
| turn id 由 VH 生成（`createId()`），turn-end 已带 cost/usage | `claude/utils/sessionProtocolMapper.ts` `ensureTurn`/`closeTurn` |
| Web 把 turn-end 的元数据贴到本轮最后一条 agent-text（Phase 6） | `happy-web-v2/src/sync/reducer/reducer.ts` |
| `showMeta` = 本轮最终回答 | `screens/session/chatTurns.ts` `lastFinalAgentId` |
| B-836 反馈只存本库、管理员靠 `VH_FEEDBACK_ADMIN_ACCOUNT_IDS` | `happy-server/sources/app/feedback/*` |

## 设计

### 实例配置（`sources/app/instance/instanceConfig.ts`）

- 文件 JSON，最多每 10 s 看一次 mtime；读不到/不合法 → 该节关闭并记日志（只记键名和变量名）。各节独立解析。
- `GET /v1/instance/config`（登录即可）：`{ modelRequestTagging, modelFeedback: {enabled, scope}, modelFeedbackAdmin }`；**不含**转发地址和凭据。

### 请求打标（CLI `src/modelTagging/`）

- wrapper 启动时（账号解析之后）读实例配置（3 s 超时；失败用 `$HAPPY_HOME_DIR/instance-config.json` 上次的结果；404 = 旧 server = 关）。
- `ANTHROPIC_BASE_URL` 的 host 命中 `hosts`（或全局渠道 `alwaysTag`）→ 起 `127.0.0.1` 转发。两个入口：会话主对话 query（含其子 agent）走 `/t`，只有它的 POST（不含 `count_tokens`）计入本轮 `modelRequestIds`；进程 env 指向 `/o`（标题生成、/btw、Bash 里跑的 `claude`），照样打标但不计入。上游中途断流时立即断开下游，不挂起。转发逐请求加 `sessionHeader: <VH 会话 id>`、`requestHeader: <uuid>`，同名入站 header 先删（不可伪造）；hop-by-hop header 丢弃；请求/响应体双向流式透传，不读、不记；上游连不上回 502（Anthropic 错误形状）；客户端断开即断上游。
- 选择本机转发而非静态 header：只有转发能做到「每个请求一个 VH 知道的 id」。只对命中的会话启用，官方端点与未配置网关不经过它。
- 账号不可用（bound but unavailable）时不打标（保持 fail-closed）。
- turn-end 新增可选字段 `modelRequestIds: string[]`（本轮转发过的请求 id，最多 200）。

### 反馈存储与转发（server `sources/app/modelFeedback/`）

- 表 `ModelFeedback`，唯一键 (accountId, sessionId, turnId)：`PUT /v1/model-feedback` upsert（幂等），`DELETE` 撤回，`GET ?sessionId=` 取自己的评分。能读该会话的人（所有者/被分享者）可评。
- 转发：写入即 `pending`，异步 POST `{type:'model-feedback', record}`；用 `forwardAttempts`+`updatedAt` 做 claim，多副本不重发同一版本；`nextForwardAt` 落库，30 s 起指数退避，8 次后 `failed`；每 30 s 扫一次到期行（按 `nextForwardAt` 升序，积压不挡新行）。接收方按 `record.id` upsert。撤回：有转发目标时行保留为 `deletedAt`，转发 `{type:'model-feedback-deleted', id}` 成功后删除。
- 配置文件解析失败（JSON 错误）保留上一次的好配置；文件被删 = 全部关闭。
- 导出 `GET /v1/model-feedback/export?format=jsonl|csv|json&since&until&model&rating`，仅管理员（`VH_FEEDBACK_ADMIN_ACCOUNT_IDS` ∪ 配置 `admins`），非管理员 404。CSV 防公式注入。

### Web

- typesRaw 把 turn-end 的 `envelope.turn` 与 `modelRequestIds` 放进 `ready.turnMeta`；reducer 贴到最终回答（`turnId`、`modelRequestIds`）。
- `MessageActions` 在最终回答上显示 `ModelFeedbackButtons`：配置开启且（`scope=all` 或本轮有请求 id）。再点同一个 = 撤回；👎 后出一行可选说明。
- 设置 → 发送反馈：管理员可见「模型回答反馈」导出 JSONL / CSV。

## B-981 全局模型渠道

- 配置节 `globalModelChannels`：`{id, enabled, label, agent: claude|codex, baseUrl, apiKey(${ENV}), models, contextWindows?, wireApi?, audience}`，逐条解析，坏条目按 id 丢弃（日志不含值）。
- `GET /v1/model-channels`：返回调用方可见的渠道 + `revision`；**只有 machine token 拿得到 key**，Web 登录 token 永远拿不到。
- daemon 启动及每 5 分钟拉取（失败保留上次；404 = 旧 server = 无渠道），落成只读账号 `global-<id>`：`global-accounts.json`（0600，无密钥）+ `global-accounts/<id>/secret`（0600，目录 0700），`readAccounts` 合并、写入方剔除；改名/删除拒绝（`global-readonly`），可测试、可设为本机默认。渠道被关/删：文件删除，绑定会话原地重启后为 `unavailable`，不回落本机登录；指向它的默认值清掉。
- `AgentProfileSummary` 新增可选 `scope: 'global'`，Web 显示「全局」chip、不给改名/删除。
- 打标：全局 Claude 渠道 `alwaysTag`（不看 `hosts`）；Codex 会话不打标。
- 安全：key 下发到每台成员机器，能读该用户文件的人就能读到；用可轮换的专用 key，按人计量请让用户自己添加账号。

## B-982 全局通知

- 配置节 `notices`（≤50）：`{id, title, body, level: info|warning, audience: all | {accounts: [id|username]}, startsAt?, endsAt?, dismissible}`；`GET /v1/notices` 按受众和时间窗过滤。
- Web 首屏后拉取、每 10 分钟、`sync.onResume` 时再拉；`notice` 级浮层卡片，一次只显示最新一条；「知道了」写入同步设置 `dismissedNoticeIds`（保留最近 100，跨设备），不可关闭的只关到刷新。无 migration。

## 兼容矩阵与发布顺序

| | 旧 server | 新 server |
|---|---|---|
| 旧 CLI | 无变化 | 不打标；`scope=tagged` 下按钮不出现，`all` 下照常可评（无请求 id） |
| 新 CLI | `/v1/instance/config` 404 → 不打标 | 打标 |
| 旧 Web | — | 不显示按钮；turn-end 新字段被 zod 剥掉 |
| 新 Web | 404 → 功能关 | 全功能 |

- B-981：旧 CLI 不调 `/v1/model-channels`；新 CLI 遇旧 server 404 = 无渠道；旧 Web 忽略 `scope`（只是没有 chip，且全局账号的改名/删除会被 daemon 拒绝）。
- B-982：旧 server 404 = 无通知；旧 Web 不显示；`dismissedNoticeIds` 是新增同步设置字段，无 `.default()`，旧端忽略。
- migration：新增一张表（expand only），旧镜像不读它；回滚只回镜像。
- 发布：server/Web → CLI。

## 风险

1. 转发器出错会让该会话的模型请求失败：只对配置命中的会话启用；流式/错误/中断有单测与实网关冒烟。关闭方式：删掉配置里的 `hosts` 或该节，新会话即不再经过转发。
2. 会话 id 发到网关：只发给运营方列出的网关 host。
3. 转发目标不可达：反馈照常存本库，状态 `pending/failed` 可在导出里看到（导出带全量，不依赖转发）。

## 验收标准

- [x] server：配置解析单测；pglite 集成（关→404、开→广播不含转发地址、upsert、转发带 `${ENV}` 凭据、失败重试、权限、导出 JSONL/CSV、撤回）。
- [x] CLI：转发器单测（header、流式、多请求 id、502、hop-by-hop/防伪造）、配置缓存与 404、turn-end 带 id。
- [x] Web：turn-end → turnMeta、reducer 贴到最终回答、显示规则、提交体不含原文。
- [x] 端到端：standalone server + 隔离 daemon + 模拟网关，真实会话一轮后网关收到两个 header，Web 点 👎 后导出记录的 requestIds 与网关收到的一致（PR #1027）。
