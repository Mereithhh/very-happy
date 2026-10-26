# 应用内反馈（入口 + 偶尔弹出的反馈提示卡）

> 状态：Final
> 日期：2026-10-27 ｜ 关联 backlog：B-836 ｜ 出处：Owner 10-27「做一个反馈功能，一个是入口，一个是时不时弹一个类似打反馈的全局 toast，收集一下。」

## 背景

用户目前没有在产品里说「好用 / 不好用」的地方，Owner 只能靠聊天收集。需要两样东西：一个随时能找到的入口，以及一张偶尔主动出现的提示卡，点一下就能提交。

## 目标

- 任何已登录账号都能提交反馈：三档评分（好用 / 一般 / 不好用）为必选，文字为选填，诊断信息可以看到具体内容，也可以取消勾选。
- 提示卡在 overlayQueue 里排 `notice` 级。弹出频率受限，「以后再说」和「不再提示」的状态跨设备同步，点一下评分就算提交成功。
- 反馈只写入本服务器的数据库。`VH_FEEDBACK_ADMIN_ACCOUNT_IDS` 里列出的账号可以查看反馈列表，有新反馈时会收到 Web Push。每个账号有提交频率限制。

## 非目标

- 截图：放到下一期。截图几乎一定会拍到会话内容，需要先做遮挡或编辑 UI，还要对象存储和配额；html2canvas 懒加载约 45 kB gz，而且画布、iframe 和终端都截不准。表单里提供 GitHub issue 链接作为补充渠道。
- 回复用户、工单状态、导出：本期不做。
- 跨实例汇总：不做。self-host 实例的反馈永远不离开它自己的数据库。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 仓库里没有「实例管理员」的概念；owner_board 只是全局开关 `VH_OWNER_BOARD_ENABLED` | `happy-server/sources/app/attention/rules.ts` |
| 基于数据库的固定窗口限流，被拒的请求不扣额度（B-307） | `happy-server/sources/app/auth/authRateLimiter.ts` |
| 非会话类的设备推送 `dispatchDeviceEventPush`；账号在线时不推 | `happy-server/sources/app/push/pushDispatch.ts` |
| synced settings 是扁平结构，按字段 LWW 合并，不能加 zod `.default()` | `happy-web-v2/src/sync/settings.ts`；AGENTS 约束 1 |
| 浮层排队规则：critical > interaction > notice | `happy-web-v2/src/app/overlayQueue.ts`；design-language「自己弹出的浮层轮流出现」 |
| `utils/requestReview.ts` 是 happy-app 遗留的商店评分弹窗，web 里没有调用方，本期不复用 | — |

## 设计

### 入口
- **设置 → 发送反馈**（`/settings/feedback`）：放在设置分区列表里，也能被设置搜索到（`feedback.form`）。
- **帮助页**（`/help`）：顶部操作区放「发送反馈」按钮。桌面端侧栏底部的「帮助」一直可见，所以桌面靠它进入。
- **手机端**：chip 行的「更多 ▾」里加一项「发送反馈」（`SidebarNavEntry.phoneOnly`）。桌面端不给它一个能力行，避免低频入口挤占会话列表。
- **`/feedback`**：重定向到 `/settings/feedback`，供文档和链接使用。

### 表单
- 评分按钮、文字（≤2000 字）、「附带诊断信息」（默认勾选）、「查看具体发送内容」。展开后看到的 JSON 就是实际发给 API 的对象。
- 诊断字段为白名单：`webVersion`、`cliVersions`、`userAgent`、`language`、`viewport`、`pointer`、`route`、`timeZone`、`ts`。
  - `cliVersions` 只取各机器 CLI 版本的去重排序结果，不带机器名、主机名或路径。
  - `route` 取用户来设置页之前所在的页面，去掉 query 和 hash，像 id 的路径段替换成 `:id`。web 和 server 用同一条规则（`routePattern`）各做一遍。
  - server 用 zod 丢弃未知字段。
- 表单底部有「也可以在 GitHub 提 issue」链接，指向 `https://github.com/Mereithhh/very-happy/issues/new`；还有一行隐私说明，写明反馈只保存在当前服务器（显示服务器主机名）。

### 提示卡（`FeedbackPrompt`，首屏之后挂载）
- **计活跃天数**：每个本地自然日第一次打开 app 时，`feedbackActiveDays` 加 1，每天最多写一次 settings。要等 server settings 至少加载过一次才计数，否则 pending 合并会用默认值 1 覆盖服务端的真实计数。
- **何时弹**（纯函数 `feedbackPromptBlock`）：以下条件全部满足才弹。
  - 活跃天数 ≥ 5；
  - 距上次弹出 ≥ 30 天，距上次提交 ≥ 30 天；
  - 没有选过「不再提示」；
  - 本设备没有未读更新日志；
  - 不是深链进入。
  
  挂载 20 秒后检查一次。如果用户正在输入、引导卡（安装 / 通知 / 登录方式）或横幅占着角落、或者当前就在反馈页，就每 5 秒重试，直到条件满足后再弹。不按 B-823 的「已交互就不弹」处理：提示卡不挡页面，用户几乎一进来就会操作，按那条规则它就永远出不来。
- **排队**：`useOverlayTurn(wanted, notice)`。它排在更新日志和用户自己打开的对话框后面；critical 浮层出现时让位，不算 dismiss，critical 关闭后回来。CSS 层另有一道保险：引导卡出现时隐藏它（`floatingCards.css`）。
- **记录**：卡片拿到展示机会时写 `feedbackPromptShownAt`，其他设备的 30 天计时也从这时开始。
- **一键评分**：点一下就 `POST /v1/feedback { rating, source: 'prompt' }`，不带诊断信息（用户还没看过要发什么），提交即算成功，并写 `feedbackLastSubmittedAt`。之后可以选择展开文字框和诊断信息，「补充发送」走 `PATCH /v1/feedback/:id`（只有本人可改，1 小时内有效），「完成」直接关闭。
- **关闭方式**：「以后再说」、✕、Esc 只关闭卡片，30 天后可以再弹；「不再提示」写 `feedbackPromptOptOut: true`，之后只能从入口进入。

### 跨设备状态
synced settings 的扁平字段：`feedbackActiveDays`、`feedbackLastActiveDay`、`feedbackPromptShownAt`、`feedbackPromptOptOut`、`feedbackLastSubmittedAt`，默认值写在 `settingsDefaults`。同一天多台设备只计 1 天；两台设备并发写入时可能少计 1 天，可以接受。

### 服务端
- **表**：`Feedback`，字段有 `id`、`accountId`（外键，级联删除）、`rating smallint 1..3`、`text`、`diagnostics jsonb`、`source`、`readAt`、`createdAt`、`updatedAt`。索引为 `(createdAt DESC)` 和 `(accountId, createdAt)`。迁移文件 `20261027120000_feedback`，只新增表，不改动现有表。
- **路由**（`feedbackRoutes.ts`，需要登录，body ≤16 KB）：
  - `POST /v1/feedback`
  - `PATCH /v1/feedback/:id`
  - `GET /v1/feedback/admin/access` → `{admin}`
  - `GET /v1/feedback/admin?cursor&limit&unread&rating`：返回 `items[].account {displayName, username, email}` 和 `unreadCount`
  - `POST /v1/feedback/admin/:id/read {read}`
  
  非 admin 访问 admin 接口统一返回 404 `not_found`，和旧 server 一样。
- **admin**：`VH_FEEDBACK_ADMIN_ACCOUNT_IDS`（逗号或空格分隔）。不设置时没人能看。admin 在列表里看到的是账号名或邮箱，不是裸 id。收件箱（`/settings/feedback/inbox`）顶部两组筛选可叠加：「未读 / 全部」和「全部评分 / 好用 / 一般 / 不好用」，一起作为 `unread` + `rating` 发给 list 接口；手机上两组各占一行时也不截断，触控高 ≥44px。
- **限流与防刷**：
  - 每账号每小时 5 条、每天 20 条（`MAX_FEEDBACK_PER_ACCOUNT_PER_HOUR` / `_PER_DAY`），超出返回 429 `feedback_rate_limited`。
  - 同一账号 10 分钟内提交相同评分加相同文字时，直接返回原记录（`deduped: true`），不扣额度，也不推送。
  - PATCH 每分钟 20 次（`MAX_FEEDBACK_EDITS_PER_ACCOUNT_PER_MINUTE`）。
- **推送**：对每个 admin 调用 `dispatchDeviceEventPush`，标题如「新反馈 · 👎 不好用」，正文是「名字：文字前 80 字」，`url=/settings/feedback`。admin 自己提交时不推给自己。每个 admin 每 5 分钟最多推 1 条，期间的其他反馈计入下一条的「另有 N 条」。这个窗口按进程计算，多副本时最坏情况是每个副本各推一条。推送失败不影响提交。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 server | `POST /v1/feedback` 返回 404，表单提示「发送失败」；access 接口失败按「不是 admin」处理，不显示收件箱；提示卡一键评分失败时会提示，卡片停留，用户可以关掉 |
| 旧 web + 新 server | 新路由没人调用；不影响 settings 里的新字段，因为旧端会保留不认识的字段 |
| CLI | 不涉及 |

server 和 web 随同一个镜像发布（AGENTS 约束 5），迁移只做 expand。

**回滚**：只回滚镜像，保留 `Feedback` 表，旧镜像不读这张表。如果要彻底删掉这个功能的数据，执行 `DROP TABLE "Feedback"; DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261027120000_feedback';`。这会丢掉全部反馈，执行前先导出。

## 风险

1. **滥用刷屏**：已有每小时、每天的限额和 10 分钟去重；推送有 5 分钟合并窗口，不会刷爆 admin。
2. **诊断信息泄露会话**：web 和 server 两层都按白名单处理，server 还会再做一次路由去 id，单测断言未知字段会被丢弃。
3. **settings 并发少计活跃天数**：接受，影响只是提示卡晚一天出现。
4. **多副本下推送窗口按进程计**：接受，见上文。

## 验收标准

- [x] 入口：设置分区和设置搜索、`/help` 按钮、手机「更多 ▾」、`/feedback` 重定向。
- [x] 表单：三档评分、文字、诊断信息可见可关，发送内容等于展示内容；有 GitHub 链接和隐私说明。
- [x] 提示卡：notice 级排队；首次使用、深链进入、有未读更新日志、30 天内弹过或提交过、选过「不再提示」时都不弹；一键评分即提交，补充内容可选；状态跨设备同步。
- [x] 服务端：迁移、路由、admin 门槛、带名字和邮箱的列表、已读标记、推送（不推给提交者本人、按窗口合并）、限流、去重。
- [x] 测试：server 有 pglite 下走 `startApi()` 的集成测试和纯函数测试；web 有策略、表单、提示卡测试；mutation-check 通过；e2e 和 device-shots 截图见 PR。
