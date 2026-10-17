# Very Happy Spaces：多人空间、Agent-to-Agent 通信与 Tanka 接入（高层设计）

> 状态：Draft（2026-10-17，仅概念与清单，不含实现细节）
> 调研底稿：`docs/research/2026-10-spaces/`（orca / mirasim / tanka-surface / very-happy-baseline）
> 基线：main 2ab14e26d；前置 spec：2026-09-agent-teams、2026-09-session-peer-messaging、2026-08-cloud-identity、2026-08-tanka-channel、2026-09-automations

## 0. 结论先行

1. **Very Happy 今天的一切对象都挂在单个 account 下**，没有 org/team/成员表；Teams 是同账号、同机器的多 agent 编排；Tanka 接入是仓库外的私有适配器。做 Space 会推翻 2026-09 UX review 里"只有单个 Owner"的前提，T-39 之外的几条显式拒绝需要重新论证。
2. **Orca 和 Mirasim 各强一半**。Orca 强在"编排契约给 agent 用"（Run/Task/Dispatch/Message/decision gate 全是 CLI+skill）和"状态机三处投影"（Needs You 在卡片、看板、feed、推送同时出现），但没有账号与团队。Mirasim 强在"空间即服务端"、群聊 @助手、会话互联协议（投递语义 + 限流/跳深/熔断）、事项枢纽和"面板即 CLI"，但桌面优先、数据留在自己云、没有 Tanka。
3. **"数据在 Tanka 体系内"可达上限是：Tanka 身份 + Tanka AI 经 Ridge 查到 very-happy 数据 + 事件进 Tanka 群**。open.tanka.ai 没有自定义 agent 注册、没有普通消息事件、建群/拉人 restricted，所以空间状态和 A2A 消息只能留在 very-happy server；Tanka 做身份、查询入口和通知。推荐路径：Authentik OIDC（Tanka 源 + `ridge_profile`）+ Ridge provider/MCP 只读曝光 + Ridge `/v1/notify` 或 apodex-bot 推群。
4. **核心保持 provider-neutral**：Space / Actor / 信封 / 事件是产品内一等概念；Tanka 只通过三个可插拔接口接入（身份源、渠道、数据曝光）。这与 2026-08-tanka-channel"核心不认识 Tanka"的原则一致，也保住开源边界。

## 1. 目标与非目标

目标
- 多人共享一个工作面：看到彼此的机器、会话、agent、任务和"需要决策"项，并能把工作交给对方或对方的 agent。
- 人↔agent、agent↔agent 都能对话，且消息有发送方身份、授权范围和回执。
- "automate everything"：每个对象都产生事件，每个事件都能触发自动化，自动化本身是空间内可见、可审计的对象。
- 公司场景下身份、组织树、可查询数据和通知都落在 Tanka 体系内。

非目标（本轮）
- 不把 Tanka group 当作 Space 的存储或消息总线（能力不开放）。
- 不做通用工作流 DSL、插件市场、bot 自动创建 bot。
- 不做公开只读链接 / 匿名分享。
- 不改真 E2E：共享内容按 Teams 现状走"服务器可信、明文存储"，私有会话保持客户端加密。

## 2. 概念模型（新增/升级的一等对象）

```text
Account ──belongs──▶ Space (personal 默认 / shared)
                       ├─ Member (role: owner / admin / member / observer)
                       ├─ Actor  (human member | named Agent | channel bot)  ← 统一可寻址 @name
                       ├─ Agent  (命名、持久：模型 + 默认机器/目录 + skills/MCP + 权限策略 + owner)
                       │     └─ Session (实例；可私有，也可 publish 到 Space)
                       ├─ Room   (频道 / 话题 / DM；人和 Actor 都能发；@Agent → 开 Session → 结果回帖)
                       ├─ Task   (事项：负责人/协作人/状态/验收；Room ↔ Session ↔ 决策 的枢纽)
                       ├─ Team   (现有 Agent Teams，升级为 Space 作用域，成员可来自不同 Account)
                       ├─ Automation (触发 = cron | 事件；动作 = 开会话 / 发给会话 / 发到 Room / 跑脚本)
                       ├─ Machine grant (把自己的机器按目录/agent/驱动者出借给 Space)
                       └─ Event log (统一事件流，feed / dashboard / 自动化触发 / Ridge 曝光 的唯一来源)
Decision queue：按人跨 Space 聚合（permission / question / acceptance / gate），不属于某个 Space
```

关键取舍
- **Space 是共享边界，不是运行边界**。运行仍在 Machine（Orca 的 Host、Mirasim 的"空间=服务端"）。个人用法不变：每个 Account 自带 personal Space，单人路径零改动。
- **Agent 升格为一等、命名、持久对象**（Mirasim 的"助手"）。今天 agent 只是 Session 的 flavor 字段；没有稳定身份就无法被 @、被授权、被审计。Session 是 Agent 的一次实例。
- **Room 与 Session 分离**（Mirasim 模式）。Room 是人与 Actor 的对话面，Session 是 agent 的工作记录。@Agent 在 Room 里开 Session，Session 结果回 Room。不做 Grok 式"把 bot 塞进一个群聊"。
- **单驱动者原则**：一个 Session 同一时刻只有一个人（或一个 Actor）能驱动，其他人观看、评论、"分叉给我"或申请接管；每一轮署名。避免多人同时往一个 agent 队列塞输入。
- **信任分两档**：Space 内共享的 Room/Task/Event/Team 是服务器可信明文（Teams 已如此）；私有 Session 继续客户端加密。"发布到 Space"= owner daemon 解密后产生一份 Space 可见的投影（流或快照），不是让别人拿密钥。

## 3. Agent-to-Agent 通信

在现有 `team_message` / `session_message`（文本头 + `sentFrom`）之上定义 **结构化信封 v1**：
- 发送方 Actor（账号、Space、Agent、Session、generation）与接收方地址（`@agent`、`@session`、`@room`、群发 `@all/@idle`）。
- 意图枚举：`status` / `question` / `handoff` / `result` / `heartbeat` / `escalation`（Orca 合约）。
- 授权上下文：发送方在目标 Space 的角色、本次允许的动作范围。
- 安全规则（沿用 T-39）：信封不能批准任何事、不能改配置、内含命令不执行；跨权限等级默认暂挂进决策队列。
- 投递语义按目标状态（Mirasim）：空闲→新一轮；运行中→引导输入；离线→缓存并超时退回。回执区分"已入队 / 已被模型读取 / 已回复"。
- 熔断：每会话限流、链深上限、乒乓检测、账本保留；全部作为 Space 策略可配。
- 对 agent 的暴露方式：官方 skill + MCP 工具（`list_actors` / `read_session` / `send` / `start_session` / `ask` / `gate`），与 Teams 现有 `team_*` 合并成一套，不另起协议。

跨账号路由：RPC 房间从 `userId` 扩到 `spaceId`；跨机器派发复用 B-506 的白名单 RPC；Team 成员允许是其他 Account 的 Agent，task 可跨账号认领与验收。

## 4. Automate everything

- **事件是一等对象**：Session 状态变化、Task 流转、Room 消息/@、决策产生与消解、Automation run、成员/机器变更、入站渠道事件，统一进 Event log。
- **触发器从 cron 扩到事件**：`on event where …`，加 precheck、去重键、sticky key（已有）。公网入站 webhook 仍不做；入站事件统一经"渠道"进来（Tanka app_mention、本机 `auto fire`）。
- **观测两视图并存**（Orca）：Agents feed（时间线，离开后追赶）与 Dashboard 看板（Needs You / Working / Done / Idle，现在谁卡住）。
- **面板即 CLI**（Mirasim）：UI 的每个动作都有等价 CLI/JSON 命令，含 `answer`（脚本化批准）、配置树 `apply --dry-run`，这样自动化和 agent 都能驱动面板本身。
- **Automation 模板与 Space 级共享**：自动化属于 Space，可由成员查看、复制、禁用；先 disabled 创建 + 手动 run 验证再启用。

## 5. Tanka 接入（三个可插拔接口）

| 接口 | 落地 | 得到 | 现状/依赖 |
|---|---|---|---|
| 身份源 | 新增 OIDC identity（Authentik，内含 Tanka 登录源 + `ridge_profile`）；email 为映射键 | Tanka 用户 → Account；部门/团队/上级 → Space 成员与角色的建议值 | Account 已支持多登录身份；个人/开源产品接公司身份源需 jojo 确认 |
| 渠道 | 把仓库外 Tanka 适配器产品化为"渠道"：入站发送人按 email 映射成 Space 成员（而非全部以 owner 执行）、群 ↔ Room 绑定、出站可靠投递（修 B-026）、引用回复 trailer 回流 | 在 Tanka 群里 @agent、收到结果、回复决策 | 事件订阅只有 app_mention；bot 不能私聊；出站走 Ridge `/v1/notify` 或 apodex-bot |
| 数据曝光 | 注册 Ridge provider：只读 GET（空间、Room 摘要、Session 摘要、Task、决策队列）+ Ridge JWT `sub` 做 ACL；同一曝光自动进 MCP | Tanka AI 与同事的 agent 能查 very-happy 数据，有审计 | Ridge 管理员激活；Ridge 事件推送/统一凭证未上线，先只读 |

不做：Tanka group 当 Space 存储；open.tanka.ai agent 注册（无此能力）；workmemory 以外的记忆写入（API 未披露）。
后续：Ridge 事件推送与统一凭证上线后，把 Event log 接入 Ridge；Ridge 组织树可选自动 provision 公司 Space。

## 6. 清单（按阶段，高层）

P0 地基（单人路径不变）
1. Space + Member + 角色 + 邀请；personal Space 默认存在。
2. 资源归属加 Space 维度：Session / Machine / Team / Automation 可授权给 Space。
3. Agent 一等化（命名、持久、owner、权限策略）；Actor 统一地址。
4. 决策队列按人跨 Space 聚合（permission / question / acceptance / gate）。
5. OIDC 身份源（通用 OIDC，Authentik 作为公司配置）。
6. 信任模型定稿：共享明文投影 vs 私有加密，"发布到 Space"的语义。

P1 协作
7. Room / 话题 / DM；@Agent 开 Session 并回帖；来源芯片（`tanka:群名`）。
8. Session 发布与单驱动者：观看 / 评论 / 分叉 / 接管申请。
9. A2A 信封 v1 + 投递语义 + 熔断；skill/MCP 工具合并。
10. 跨账号路由（spaceId 房间）与跨机器派发；Team 成员可跨账号。
11. 机器出借（目录 / agent / 驱动者白名单）。
12. Task 事项作为 Room ↔ Session ↔ 决策枢纽。

P2 Automate everything
13. Event log 一等化；事件触发器；Automation 属 Space。
14. Agents feed + Dashboard 看板。
15. 面板即 CLI（含 `answer`、`apply --dry-run`）。
16. Tanka 渠道产品化（身份映射、群绑定、可靠出站 B-026、回流）。
17. Ridge provider 只读曝光 + MCP。

P3 延伸
18. 目标/Goal 持续推进与任务图（Mirasim /goal、Orca Run）。
19. Ridge 事件流接入、公司 Space 自动 provision。
20. 重新评估 2026-09 UX review 的拒绝项（bot 群聊、多租户触发服务）在 Space 前提下是否解封。

## 7. 待 Owner 决策

1. 共享内容走服务器可信明文（Teams 现状）是否可接受为产品承诺；私有会话"发布到 Space"用流还是快照。
2. 身份：开源核心只做通用 OIDC，Authentik/Tanka 作为部署配置；公司侧接入是否需要 jojo 确认。
3. Tanka 三接口以"仓库内可插拔 provider"还是"独立 adapter 仓库"交付。
4. P0 范围：是否先只做 1–4（Space/Agent/决策队列），把 OIDC 和信任模型并入 P1。
5. 公司 Space 是否从 Ridge 组织树自动 provision，还是手工建。

## 8. 分步路线（2026-10-17 Owner 调整：不一口气做完）

Owner 决定按小步走：先账号体系，再分开源版/公司版，再消息中转，session 分享优先级最高。以下为核验后的顺序与前提（证据见 `docs/research/2026-10-spaces/`）。

### Step 1 · Session 分享（最高优先，不依赖后面任何一步）
- 现状四道门：被授权者拿不到 owner content 私钥解 DEK；REST/列表按 accountId 过滤；RPC 房间按 userId；新消息只推 owner。daemon 不校验发送者，只看 seq 和能否解密。
- 最小路径：`SessionGrant(sessionId, granteeAccountId, role: viewer|driver)`；服务器（已在信任边界内）解出 DEK 再 box 给被授权者 content 公钥；读写路由放宽为 owner-or-grant；被授权者消息以 owner 身份落库，正文头注明真实发送者（沿用 Teams/peer 头部格式）；推送与 RPC 扇出到被授权者房间。
- 分享对象：同服务器账号，按 email/handle 查找；可复用上游残留的 `UserRelationship` 作好友表，不需要 Team 对象。
- 单驱动者规则：同一时刻一个 driver，其余 viewer；每轮署名。
- 与 2026-09 UX review 拒绝的"只读快照/公开链接"不同：这是登录态、定向授权。

### Step 2 · 开源版通用 OIDC
- 现状：Google 只走 GIS ID-token，issuer/JWKS 写死，无 client secret、无回调；多身份绑定已有（`AccountIdentity(provider, providerSubject)`），但每账号限一个 Google/一个 Email。
- 要补：discovery + 动态 JWKS、authorization code + PKCE、回调与 state、issuer/clientId/clientSecret 配置、provider 键 `oidc:<issuer>`。账号创建/注册限额/登录 session 复用。

### Step 3 · 开源版 / 公司版分拆与迁移
- 不 fork：同一代码库，公司版 = 部署配置（域名 vibe.apodex.site、OIDC=Authentik 含 Tanka 源、SIGNUP_MODE、全局配置）+ 可选私有模块。现状只有全局 env 开关，没有 edition/插件机制，先用 env + 配置文件即可。
- 迁移：没有账号级导出/导入工具；所有 JWT 和 AccountSecret 都系于 `HANDY_MASTER_SECRET`。最省事的做法是**域名切换而非数据搬家**：现有 DB 与 master secret 原样挂到新域名，用户只改 `HAPPY_SERVER_URL` 并在 web 重新登录；veryhappy.dev 之后重置为开源公共实例。若必须分库，走 pg_dump/pg_restore 并用新 master 重加密 AccountSecret。
- 群通知在切换窗口前发，内容含：新域名、CLI 改 server URL 的命令、web 重新登录、旧域名停服时间。

### Step 4 · 消息中转（message adapter）
- 抽象为 transport：VH server 自带（默认）、Tanka、Slack……每个用户自带凭证，以本人身份发言。Room 绑定到一个外部群。
- Tanka 可行性（官方 MCP）：每人自建个人 API key，Chat 权限须勾选具体群，读/发不可分开授权；`send_group_message` 发言、`page_room_messages` 读历史（游标分页）；**没有消息推送**，只能按人×群轮询（0.25s 间隔基本安全，约 1/100 次限流）；**不能建群/拉人**，群需人工预建；key 有效期未知，需实测；key = 本人完整发言权，必须按用户加密保管。
- Claude Code Channels 作参照：本地 MCP server 以 `claude/channel` 能力把消息推进会话，Telegram/Discord 以 bot 身份发言，无历史读取，多人靠 sender allowlist。它解决的是"IM → 会话"入站，不是"以用户身份在群里对话"；可借鉴其 sender 鉴权与 permission relay 设计。
- 两个要先定的口径：① Tanka 群是"记录之地"，VH 仍保留工作副本（UI、agent 上下文、无 key 的用户都要用）；② agent 的输出用谁的身份发到群：用用户 key 则看起来像本人说话，建议 agent 输出走 bot（apodex-bot/Ridge notify），人类消息走本人 key。

### 之后
Space/Agent 一等化、A2A 信封、事件触发器、Ridge 曝光按第 6 节顺序继续；Step 1–4 完成后再启动。
