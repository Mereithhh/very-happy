# Session 分享分层：联系人分享 + 带 token 的只读链接

> 状态：Approved（Lead 10-21，8 条决策 + 4 点补充）；实现见下方「实现记录」
> 关联：[2026-10-session-sharing](2026-10-session-sharing.md)（B-619/B-621，已上线的联系人分享）、[public-security-boundaries](2026-08-public-security-boundaries.md)
> 基线：main 7417ba00

## 背景

Owner 10-21：「分享 session 可以分几层，一个是联系人分享，一个是直接分享一个自带 token 的 weblink，拿到 link 就可以用（当然可以撤销分享或者有有效时间）」。

联系人分享已经上线（B-619）。本 spec 补第二层「链接分享」，给两层统一有效期与管理入口，并把 B-619 当时写下的非目标「不做公开链接」改为「做只读链接，不做匿名参与」，理由见 §1.3。

## 0. 现状盘点（代码已确认）

| 问题 | 现状 | 位置 |
|---|---|---|
| 能分享什么 | 单个 Session：完整历史 + 实时更新（消息、agentState、prompt queue、activity/usage）+ 该会话附件下载。metadata 是脱敏副本（去掉 homeDir/happy*Dir/hostPid/terminalId/mcpServers/claudeEnvVars，**保留 path、host、machineId**） | `sessionShares.ts:147,215-228,512-530`；`attachmentRoutes.ts:319,385` |
| 给谁 | 同服务器已有账号，按 email / 用户名 / 登录名精确匹配，或好友芯片一键；不要求好友关系 | `sessionShares.ts:312-321`；`accountDirectory.ts` |
| 流程 | owner 建 grant → `pending` → 对方接受变 `active`（拒绝即 revoked）。每会话最多 20 条，限频 30/min | `sessionShares.ts:143,328-346,386-398` |
| 权限 | `viewer` 只读；`driver` 只能发纯文本消息（服务器加密，署名，不带 mode/model/delivery）。两者都**拿不到任何 RPC**（权限卡、中断、文件面板、终端、`/btw`、编辑删除），不能归档/改设置/再分享 | `sessionShares.ts:440-487`；spec B-619 实现记录 |
| 撤销 | owner 在 ShareDialog 撤销 → 行置 `revoked`；各读路径立即 404；推 `session-share-revoked`，对方页面提示并回首页。本进程 grantee 缓存立即失效，**其他 server 进程最多 5 s 仍可能扇出**（`GRANTEE_CACHE_TTL_MS`）；grantee 已拿到的 DEK 不轮换 | `sessionShares.ts:145,376-384,491-504`；`sync.ts:3127` |
| 有效期 | **没有**，grant 永久直到撤销 | `schema.prisma:306-324` |
| 审计 | 建/改角色/撤销/接受/拒绝/driver 发消息写日志 + business audit；**没有「谁何时打开过」** | `sessionShares.ts:307-310` |
| 链接分享 | **没有**。B-619 非目标明确拒绝公开链接/只读快照/匿名访问 | `2026-10-session-sharing.md:21` |
| 管理入口 | 只在会话头部的 ShareDialog 里按会话管理；没有「我分享出去的全部」列表；对方的待接受邀请走 `/v1/shares/pending` | `ShareDialog.tsx`；`ChatHeader.tsx:259` |
| 加密前提 | 服务器持有每个账号主 secret（`HANDY_MASTER_SECRET` 封装），可解出任意会话 DEK；B-619 是第一条主动解 DEK 的代码路径 | `docs/encryption.md`；`sessionShares.ts:97-101,188-199` |

结论：联系人分享的能力边界（无 RPC、driver 仅纯文本）是对的，保留；缺的是**链接层、有效期、打开记录、统一管理**。

## 1. 分层与能力

### 1.1 两层

| | 联系人分享（已有，补有效期） | 链接分享（新） |
|---|---|---|
| 对象 | 指定账号（同服务器） | 任何拿到链接的人，**不需要登录** |
| 角色 | viewer / driver | 只读，**没有参与选项** |
| 内容范围 | 完整历史 + 实时 | 二选一：「截至现在」快照（默认）或「实时」（含后续更新） |
| 可见内容 | 原文（同 B-619） | 服务器渲染的**遮罩**文本：对话、工具调用名与摘要、工具输出经密钥遮罩；不含附件、终端、文件面板 |
| 接收方看到 | 登录后列表里「分享给我的」，接受后打开 | `https://<host>/s/<linkId>#<secret>` 公开只读页 |
| 有效期 | 1 天 / 7 天 / 30 天 / 永久（默认永久，保持现状） | 1 天 / 7 天（默认）/ 30 天 / 永久 |
| 撤销 | owner 随时；对方实时被踢 | owner 随时；已打开的页面下一次轮询即失效（≤5 s）并清空内容 |
| 数量 | 每会话 20 | 每会话 5 条有效链接 |

### 1.2 与现有分享的关系：保留并扩展，不合并成一张表

- `SessionGrant` 保留，只加 `expiresAt`。两层的对象模型不同（grant 有接收账号和 DEK 包裹，link 没有账号、不下发 DEK），硬合并会让每个读路径都多一层「是不是匿名」分支。
- 统一的是**入口和管理**：同一个「分享…」面板两个 tab；设置里一张「已分享」表同时列 grant 与 link。

### 1.3 匿名参与：不做（建议长期不做）

driver 的消息会让 agent 以 owner 的权限模式在 owner 的机器上执行；B-619 已把 driver 当成「近似 owner 授权的远程执行」来对待（ShareDialog 有警告）。链接可被转发、截图、进聊天记录、被搜索引擎收录，「拿到链接就能让 agent 跑命令」等于把 owner 机器暴露给不确定人群。

替代：链接页对已登录访客显示「请求参与」（v1 不做，留后续）；需要参与时 owner 走联系人分享。链接页也不提供 fork（会话跑在 owner 机器上，fork 需要访客有自己的 agent 环境，见 B-619「留待后续」）。

## 2. 安全

### 2.1 token

- 生成：`crypto.randomBytes(32)` → base64url（43 字符，256 bit 熵）。
- URL：`/s/<linkId>#<secret>`。secret 放 **fragment**，浏览器不会把它发给服务器或写进 Referer / 反代访问日志；页面 JS 读 fragment 后放 `x-share-secret` 头请求 API；页面**不读**本浏览器的登录凭据、不带 `Authorization`（审计不记名，见 §2.3）。linkId 是普通 cuid，只用于路由与审计展示。
- 存储：服务器只存 `sha256(secret)`（高熵随机值不需要慢哈希）；比较用 `timingSafeEqual`。链接**只在创建响应里返回一次**，之后不能再查看完整链接（面板显示「已复制」与 linkId 前缀；丢了就新建/轮换）。数据库泄露不泄露可用链接。
- 公开端点按 IP 限频（未命中与命中分开计数），错误一律 `404 link_not_found`，不区分「不存在/错 secret/已撤销」——但对**持有正确 secret** 的请求返回具体状态 `410 link_revoked | link_expired` 让页面给出准确提示（不泄露任何新信息，持有者本来就知道链接存在）。

### 2.2 撤销与过期立即生效

- 每个链接 API 请求都查库校验（`revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)` 且会话未删除）；不做缓存。
- 已打开的页面：快照页每 5 s 轮询一次状态、实时页每 3 s 轮询增量（实时页轮询本身就是 `after_seq` 增量）；任一请求得到 410 → 页面**清空已渲染内容**并显示「链接已撤销 / 已过期」。轮询而不是 socket：匿名访客不进 socket.io 鉴权体系，也就不存在「撤销后旧连接继续收推送」的问题。
- 联系人分享：
  - 撤销路径不变；把 `GRANTEE_CACHE_TTL_MS` 的跨进程窗口在 spec 里明示（≤5 s）。
  - 新增过期：`resolveSessionAccess` / `activeGranteeIds` / `listSharedSessionRows` / `listPendingSessionInvites` 一律加 `expiresAt > now` 条件；过期不需要后台任务，读路径即判。过期后 grantee 下次读 404；在线时额外由 server 的已有 grantee 缓存 TTL 自然停止扇出，页面在下一次读失败时提示。
- 会话删除 → link 级联删除；会话归档 → 链接仍可读（归档只是不再运行）。

### 2.3 访问审计

- 新表 `SessionShareLinkAccess(linkId, at, ipHash, bot)`。**一律匿名**（Lead 安全审查定的口径）：只存加盐 IP 哈希（仅用于去重）和是否为预览机器人，不存 UA、不存账号；登录访客与匿名访客无区别，不把访客身份告诉 owner。`ipHash = sha256(serverSalt + ip)` 截 16 字节。
- 页面首次加载与每次轮询（`/messages`）都调用记录函数，同一访客（ipHash + bot）10 分钟内只记一次。
- Link 行冗余 `accessCount`、`lastAccessedAt`，面板直接显示；明细在设置的「已分享」里展开最近 50 条（时间 + 匿名/机器人）。保留 90 天：服务器每小时清理一次（`startShareLinkAccessRetention`），不依赖链接再被打开。
- 建/撤销/轮换链接写 business audit（与 B-619 同 `audit()`）。

### 2.4 链接泄露的应对

- 一键「撤销」与「轮换」（撤销旧链接 + 用同样设置建新链接）。
- owner 能看到打开记录，判断是否扩散。
- 默认 7 天过期、默认快照，降低泄露的时间与内容面。
- 页面 `<meta name="robots" content="noindex,nofollow">` + `X-Robots-Tag: noindex` + `Referrer-Policy: no-referrer` + `Cache-Control: no-store`；不出现在 sitemap。

### 2.5 内容里的密钥：遮罩

会出现密钥的地方：工具输出（`cat .env`、`env`、`printenv`、读配置文件、git remote 带 token 的 URL）、用户粘贴的 key、diff 内容、metadata（`claudeEnvVars` 已删）。

- 链接页不下发 DEK，服务器解密后**按白名单投影**再返回明文记录（保持 `RawRecord` 形状，Web 端直接走 `normalizeRawMessage` → `reducer` → `ActivityMessages`，与 `CodexChildDetail.tsx:29-34` 同路）：
  - 只保留 user 文本、agent 输出里的 text / tool_use / tool_result 与 turn 边界；丢弃 thinking 正文、图片/附件引用、权限请求、prompt queue、agentState、usage、内部帧；`meta` 只留 `sentFrom`/`displayText`/`sharedBy.displayName`。
  - 对剩下记录**深度遍历所有字符串**过 `redactSecrets()`：PEM 私钥块、`sk-`/`sk-ant-`/`ghp_`/`gho_`/`github_pat_`/`xox[abpr]-`/`AKIA…`/`AIza…`/JWT（三段 base64url）/`Bearer <token>`/URL 中的 `user:pass@`/`KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY` 名字的 `name=value` 与 `"name": "value"` 赋值，替换为 `[redacted]`。纯函数 + 单测。
  - metadata 只给会话标题、agent 类型、创建/更新时间、项目目录 **basename**；不给 host、完整 path、machineId。
- 遮罩是**尽力而为**，面板创建链接前明示「自动遮罩常见密钥格式，但不能保证；分享前请确认内容」。
- 联系人分享不加正文遮罩：对方是定向授权的账号，driver 本来就能让 agent 打印任何东西；遮罩会破坏协作（diff、代码）且给人虚假的安全感。

### 2.6 范围：快照 vs 实时

- 快照：创建时记 `snapshotSeq = 当前最大 seq`，读路径 `seq <= snapshotSeq`。之后的消息不出现；owner 想更新就「更新到现在」（把 `snapshotSeq` 推到当前，链接不变——同 ChatGPT 的 Update link）。
- 实时：无上界，页面轮询增量；会话后续的新消息都可见，直到撤销/过期。面板对实时模式加提示「之后的对话也会被看到」。
- 两种模式都是**完整历史起点**（seq 1 开始），不做「从分享那一刻开始」——竞品都没有、对读者也没意义。

## 3. 竞品对照

| 产品 | 形态 | 范围 | 匿名可看 | 能参与 | 撤销/管理 | 有效期 |
|---|---|---|---|---|---|---|
| ChatGPT shared links | 链接 | 创建时快照，之后消息不进，需「Update link」 | 是（Enterprise 限 workspace） | 否（访客可在自己账号里继续，即 fork） | 设置 → Data controls → Shared links 统一删除 | 无 |
| Claude.ai Share chat | 链接 | 快照；取消再分享才更新 | 是（Team/Enterprise 限组织） | 否 | 设置 → Privacy → Shared chats 逐条 Unshare | 无 |
| Claude Code Artifacts | 页面链接 | 实时更新 | Pro/Max 可公开；Team/Ent 默认组织内，公开需管理员开启 | 否 | 按 artifact 管理 | 无 |
| Cursor Shared transcripts | 链接（`cursor.com/s/…`） | 只读副本 | Public 选项可匿名；Team 需登录 | 否，可 Fork 到自己编辑器 | dashboard 列表 | 无 |
| Codex cloud | 共享的是 environment，不是 task | — | 否 | 否 | — | — |
| **Very Happy（本 spec）** | 联系人 + 链接 | 联系人实时；链接快照（默认）或实时 | 链接可匿名，只读 | 仅联系人 driver | 面板 + 设置统一列表；打开记录 | 两层都可选 1/7/30 天/永久 |

取舍：跟随行业「链接只读、默认快照、集中管理」；差异化在**有效期、打开记录、实时只读**（看 agent 干活）和**密钥遮罩**（社区已有 InstaShare 这类自动遮罩的需求，说明是真实痛点）。

来源：[ChatGPT Shared Links FAQ](https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq)、[Claude Sharing and unsharing chats](https://support.claude.com/en/articles/10593882-sharing-and-unsharing-chats)、[Claude Code artifacts](https://claude.com/blog/artifacts-in-claude-code)、[Cursor shared transcripts](https://cursor.com/docs/shared-transcripts)、[Using Codex cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)。

## 4. UI

### 4.1 会话菜单「分享…」面板（扩展现有 ShareDialog）

- 顶部 segmented：「联系人」「链接」。
- 联系人 tab：现有内容 + 有效期选择（永久 / 1 天 / 7 天 / 30 天），列表行显示「x 天后过期」。
- 链接 tab：
  - 创建区：范围（截至现在 / 实时）、有效期（1 / 7 / 30 天 / 永久，默认 7 天）、遮罩提示、「创建链接」主按钮。创建成功后链接框 + 「复制」，提示「只显示这一次」。
  - 已有链接列表：`…<linkId 前 6 位>` · 范围 · 到期 · 打开 n 次 / 最近一次；操作：「更新到现在」（快照才有）、「轮换」、「撤销」（两步确认，同现有）。
- 只有 owner 看得到「分享…」（现有 `canShare`）。

### 4.2 设置 →「已分享」

- 新设置页（`SettingsRoutes` 加一项）：一张表，按会话分组，列出我分享出去的所有 grant 与 link（类型、对象/链接、角色或范围、到期、打开次数、最近打开），每行可撤销；link 行可展开打开记录。
- 另一个分组「分享给我的」：已接受的 grant，可「退出」（grantee 主动 decline active grant，复用 decline 路由）。

### 4.3 对方看到的页面

- 联系人：不变（列表「分享给我的」+ SharedSessionBanner + viewer 无输入框）。过期后和撤销同样提示。
- 链接 `/s/:linkId`：独立公开页（不加载登录态 app shell、不连 socket）。
  - 头部：会话标题、「由 <owner 显示名> 分享 · 只读」、范围（「截至 10-21 14:03」或「实时」+ live 点）、Very Happy 品牌回首页。
  - 正文：只读 transcript（用户/assistant 气泡、工具调用折叠卡、markdown），遮罩处显示 `[redacted]` chip。
  - 状态页：链接无效 / 已撤销 / 已过期 / 加载失败，各一句话，不显示任何残留内容。
  - 移动端优先：单列，`pointer: coarse` 下按钮触控尺寸符合 design-language。

## 5. 数据、接口、兼容与发布

### 5.1 迁移（纯 expand）

```sql
ALTER TABLE "SessionGrant" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE TABLE "SessionShareLink" (
  id TEXT PK, "sessionId" TEXT FK→Session ON DELETE CASCADE, "createdByAccountId" TEXT FK→Account ON DELETE CASCADE,
  "tokenHash" BYTEA UNIQUE, scope TEXT ('snapshot'|'live'), "snapshotSeq" INT NULL,
  "expiresAt" TIMESTAMP NULL, "revokedAt" TIMESTAMP NULL, "accessCount" INT DEFAULT 0, "lastAccessedAt" TIMESTAMP NULL,
  "createdAt", "updatedAt");  INDEX (sessionId), INDEX (createdByAccountId)
CREATE TABLE "SessionShareLinkAccess" (id, "linkId" FK ON DELETE CASCADE, at, "ipHash" BYTEA, bot BOOLEAN); INDEX (linkId, at), INDEX (at)
```

### 5.2 接口

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/sessions/:id/share-links` `{scope, expiresInDays: 1\|7\|30\|null}` | owner | 返回 `{link, secret, url}`，secret 只此一次 |
| `GET /v1/sessions/:id/share-links` | owner | 有效 + 最近撤销/过期的链接（不含 secret） |
| `PATCH /v1/sessions/:id/share-links/:linkId` `{snapshotToNow?: true, expiresInDays?}` | owner | 更新快照/有效期 |
| `POST …/share-links/:linkId/rotate` | owner | 撤销旧 + 新建同设置，返回新 secret |
| `DELETE …/share-links/:linkId` | owner | 撤销 |
| `GET /v1/share-links/:linkId/accesses` | owner | 打开记录 |
| `GET /v1/shares/outgoing` | 登录 | 设置页：我所有 grant + link |
| `POST /v1/sessions/:id/shares` 增加 `expiresInDays`，`PATCH` 同 | owner | 联系人有效期 |
| `GET /v1/public/share-links/:linkId` | `x-share-secret: <secret>`（不读 `Authorization`） | 页面头部信息 + 记一次打开（去重） |
| `GET /v1/public/share-links/:linkId/messages?after_seq&limit` | 同上 | 遮罩后的投影消息，快照模式封顶 `snapshotSeq`；同样记一次打开（去重） |

公开路由挂在 server 上与 `/v1` 同前缀（Caddy 已转发 `/v1`）；Web 加 `/s/*` 静态路由（SPA fallback 已覆盖）。

### 5.3 兼容矩阵

| 组合 | 结果 |
|---|---|
| 新 server + 旧 Web | 旧 Web 不认识 `expiresAt`/新路由，联系人分享照常；没有链接 UI。旧 Web 收到的 grant 视图多一个字段，忽略 |
| 旧 server + 新 Web | 链接 tab 调用 404 → 显示「服务器版本过旧」（复用 `http_404` 文案）；有效期字段被旧 server zod 剥除 → grant 变永久。只在回滚窗口出现（server/Web 同镜像），所以 Web 不做能力探测；回滚前的 SQL 见 §5.4 |
| CLI / daemon | 零改动（链接只读、服务器侧投影；grant 过期只影响读路径） |
| 生产 server/Web 同镜像 | 正常情况下同时切换，上述两行只在回滚窗口出现 |

### 5.4 发布与回滚

1. 一个 PR：migration + server + Web（同镜像，约束 5）。发布前在 `/opt/happy/.env` 写 `VH_RELEASE_MIGRATIONS_REVIEWED=<commit>`（迁移树变了）。
2. 先发 server/Web；CLI 不发版。
3. 回滚：**降级前先执行** `UPDATE "SessionGrant" SET status='revoked' WHERE "expiresAt"<=now();`（旧代码不认识 `expiresAt`，不先收掉的话已过期的 grant 会在旧版本里重新生效）。然后切回上一个 slot/镜像。新列/新表对旧代码不可见；**不跑 down migration**（expand/contract）。回滚期间已建的链接全部 404（旧 server 没有路由）——等于临时撤销，安全方向失败；已设置的 grant 有效期失效变为永久，回滚窗口内需要人工撤销的情况写进发布说明。再次前滚后链接与有效期恢复。
4. 验收：生产创建一条 1 天链接，匿名浏览器打开 → 撤销 → 已打开页 ≤5 s 失效；check-shipped 核对 `/s/` 页面 chunk 与 server 路由。

## 6. 实现计划与测试

- server：`app/session/shareLinks.ts`（建/列/改/轮换/撤销/校验/投影）、`app/session/redactSecrets.ts`（纯函数）、`sessionShareLinkRoutes.ts`；`sessionShares.ts` 加过期条件。
- Web：ShareDialog 两个 tab、设置「已分享」页、`/s/:linkId` 公开页（`PublicRoot` + `rootSelection` 的 always-public 路由；`normalizeRawMessage` + `reducer` + `ActivityMessages`，加 read-only 上下文隐藏消息操作；不连 socket、不读登录态 storage）、文案中英。
- 测试（pglite 集成 + 单测）：
  - 撤销后公开读取 410，旧 secret 轮换后 404；过期链接 410；快照不返回 `seq > snapshotSeq`。
  - 越权：非 owner 建/列/撤销链接 404；错 secret 404；他人会话的 linkId + 自己 secret 404；grantee（即使 driver）不能建链接。
  - grant 过期：`resolveSessionAccess` 返回 null、扇出列表不含、pending 列表不含。
  - 投影不含 thinking/附件/权限卡；`redactSecrets` 覆盖每种模式与不误伤常见代码。
  - 审计：10 分钟内重复打开只记一次。
- 真浏览器 e2e（本地 standalone，端口 5340-5349，两个 Playwright context）：A 建链接 → B（无登录）打开看到内容 → A 撤销 → B 已打开页 ≤5 s 清空并提示 → A 建 1 天链接，DB 把 `expiresAt` 拨到过去 → B 刷新/轮询失效；联系人 grant 过期同理。
- 文档：README/docs 分享段落、站内文档页、`CHANGELOG_RELEASES`（由 Lead 统一发版时收）。

## 7. 待 Lead 确认的决策

1. 链接**永不允许匿名参与**（§1.3）。
2. 链接默认「快照 + 7 天」；联系人默认「永久」（不改现有行为）。
3. 链接内容由服务器**投影 + 遮罩**后下发明文，不下发 DEK；联系人分享不遮罩。
4. 撤销对已打开页面靠轮询（实时 3 s / 快照 5 s，上界 5 s），不接入 socket。
5. 每会话 5 条有效链接；打开记录保留 90 天。

## 实现记录（B-701，与设计稿的差异与补充）

Lead 审批补充的 4 点均已实现：

1. **noindex / no-referrer / 限流**：`/s/*` 页面由 `spaFallback` 返回 `X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`；公开 API 同样三个头。限流两档、按 IP（IPv6 按 /64，`clientRateLimitKey`）：所有公开请求 240/min；**未命中**（未知 linkId / 错 secret / 缺 secret，统一 `404 link_not_found`）另计 20 次 / 10 min，超出后未命中一律 429，持有正确链接的人不受影响（`sessionShareLinkRoutes.ts`）。
2. **unfurl 只拿到通用信息**：OG/title 仍是 `index.html` 的站点通用文案，不注入会话标题；secret 在 fragment，机器人拿不到内容。打开审计按 UA 识别预览机器人（Slackbot、Discordbot、facebookexternalhit、HeadlessChrome、curl 等，`isBotUserAgent`），记 `bot=true`，**不计入**打开次数与最近打开时间。
3. **面板一句话**：链接 tab 顶部固定「想让对方能发消息，请用联系人分享」。
4. **410 不白屏**：已打开页面轮询收到 404/410 → 清空 transcript 并显示「分享已撤销或已过期」+「请向分享者要一个新链接」；网络抖动、5xx、429 不清空、下一次轮询重试（`pollFailureClears`）。

其他实现决定：

- 投影是**按记录类型的白名单**（`app/session/linkProjection.ts`，安全审查后从「剔除」改为「白名单」）：user 只留文本；Claude output 只留 `type/uuid/parentUuid/isSidechain/parent_tool_use_id/message{role,model,content}`，块只留 text / tool_use / tool_result（仅文本）/ tool-call / tool-call-result（cwd、gitBranch、toolUseResult、requestId、signature、usage、permissions 等一律不出）；result/system 记录不出；legacy event 只留 message / queue-cancel / transcript-drop；codex / acp 只留消息与工具调用；session 信封只留 `id/time/role/turn/subagent/ev`，ev 按 t 白名单（turn-end 只留 status/error，不出 costUsd/usage/duration；thinking 文本和 file 不出）。工具的自由格式 input/output 保留结构，但去掉对象或数组形态的 image/document、`source.type=base64` 和 data URI。
- 路径改写：所有字符串先把会话 cwd 前缀改成目录名、owner home 改成 `~`，其他 `/home/<x>`、`/Users/<x>`、`C:\Users\<x>` 也改成 `~`，再做密钥遮罩；页头的会话标题与项目名同样处理。
- ReDoS：`redactSecrets` 所有量词有上限，单个字符串先截到 32 KB；`NAME=value` / `"name": "value"` 改为以 `=`/`:` 为锚点的手写线性扫描。性能测试：200 条 80 KB 对抗串每条 < 50 ms（实测最坏约 8 ms）。
- rotate 只接受有效链接（已撤销/过期 → 409 `link_not_active`），限频，与「每会话 5 条」在同一事务里判断；创建链接的计数与写入也在同一事务里（对 Session 行 `FOR UPDATE` 串行化）。
- `/s/` 页面除响应头外还在 HTML 里注入 `<meta name="robots" content="noindex, nofollow">` 和 `<meta name="referrer" content="no-referrer">`，前端加载时也补一次；Service Worker 的导航回退把 `/s/` 排除在外，始终走网络。
- 匿名页用 `ReadOnlyTranscriptContext`，`MessageActions` 在只读上下文里不渲染任何操作（编辑/删除/改写/引用）。`/s/:linkId` 走 `PublicRoot`（`rootSelection` 视为 always-public，已登录浏览器也一样），懒加载独立 chunk；该路由不显示 PWA 安装提示。
- 每个公开请求都查库（不缓存）；`listShareLinks` 保留最近 50 条（含已撤销/过期）供记录。
- 快照的「截至时间」存 `snapshotAt`（迁移里多一列）。
- 联系人 grant 有效期：`resolveSessionAccess` / `activeGranteeIds` / `listSharedSessionRows` / `listPendingSessionInvites` 统一加 `unexpiredGrant()`；过期的 pending 不能接受；过期 grant 可以直接重新分享（复用行）。面板只在分享时选有效期；改期走 `PATCH`（UI 暂不暴露，撤销重分享即可）。

验证：

- server：`redactSecrets.spec.ts`（17）、`shareLinks.pglite.integration.spec.ts`（9：越权 / 只存哈希 / 投影与遮罩 / 快照封顶 / 撤销即 410 与轮换 / 过期 410 与延期 / 每会话 5 条 / 审计去重与 bot / grant 过期）、`sessionShareLinkRoutes.spec.ts`（5：头、统一 404、未命中限流、记名、轮询不记打开）、`spaFallback.spec.ts`。
- web：`sharedLink.test.ts`、`rootSelection.test.ts`、settings index 测试。
- 真浏览器（本地 standalone + 构建产物，Playwright Chromium，A 桌面已登录 / B 手机 390×844 coarse 匿名）：A 在面板建实时链接 → B 打开，无泄露（thinking、sk-ant、hunter22、ghp_、host、home 路径均不出现）、`[redacted]` 出现、无横向滚动、无消息操作按钮；A 面板显示「1 open」（另一个带 secret 的 Slackbot 请求未计数）；A 撤销 → B 已打开页 **1.9 s** 清空并提示；A 建 1 天快照链接 → B 打开 → 库里拨到过期（server 重启期间 B 保留内容）→ B **0.4 s** 内清空并提示；联系人 tab 选 1 天分享给 bob → 行显示「一天内过期」；设置「已分享」列出 grant 与链接、展开打开记录。截图在 `~/code/github/skills/tmp/vh-team-B-701/shots/`。

## B-745 修正（2026-10-22）：role=session 记录的真实形状

- 事故：生产链接页只显示用户消息。CLI 落库的结构化记录是 `{ role: 'session', content: <SessionEnvelope> }`（wire `SessionProtocolMessageSchema`，CLI `enqueueSessionProtocolEnvelope`），投影却读 `content.data`，于是所有助手回复（Claude / Codex / pi 都走信封）被丢弃。B-701 的测试数据手写了不存在的 `content: { type: 'session', data }`，所以一直是绿的。
- 修法：`linkProjection` 按 wire 形状读信封（仍兼容 Web 归一化后的包装形状），输出也用 wire 形状（Web `typesRaw` 两种都接受）；超大记录占位符同步改为 wire 形状。
- 防再犯：`linkProjection.spec.ts` 的 session 样本一律经 wire schema 构造；新增 `linkProjection.contract.spec.ts`，把本地 e2e 抓取的 Claude / pi 真实落库记录与 Codex（CLI 生产 mapper 输出 + 真实落库的事件）脱敏成 `linkProjection.samples.json`，断言：样本本身通过 wire `MessageContentSchema`、投影结果仍是合法 wire 消息、助手文本 / 工具摘要 / 代码块可见、密钥与 home 路径和 thinking 不出现、B-701 预算对抗用例在真实形状上仍成立。
- 安全面变化：助手文本、工具参数（命令、Write/Edit 内容、Codex patch）与 pi/ACP 的 `tool-call-end.result.text`（命令输出，如 `env`）首次进入遮罩流水线。Claude 与 Codex 的普通工具输出本来就不在信封里（Codex 历史输出是 `thinking: true` 文本，不展示）。`NAME=value` 扫描的密钥名补了 AUTH（非 AUTHOR）、BEARER、JWT、SIGNING/ENCRYPTION/MASTER KEY、HMAC。
