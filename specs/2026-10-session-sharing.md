# Session 分享：把我的会话交给同服务器的另一个人继续聊

> 状态：Final（2026-10-18，Owner「如果都没有问题你就去实现吧」；实现见 B-619，待 PR 合并后回标 Shipped）
> 关联：specs/2026-10-spaces-a2a.design.md §8；前置事实见 docs/research/2026-10-spaces/very-happy-baseline.md
> 基线：main 2ab14e26d

## 背景

今天每个 Session 只属于一个 Account。Owner 想把自己的会话分享给同事，对方打开后能看到完整记录并在同一个会话上继续和 agent 对话。这是多人协作里最小、最先被用到的一步，不依赖 Space、Team、OIDC 或域名切换。

## 目标

- Owner 把一个 Session 分享给同一服务器上的另一个账号，指定 viewer（只看）或 driver（可发消息）。
- 被分享者在自己的会话列表里看到它，打开后记录、工具调用、diff、权限卡与 owner 看到的一致。
- driver 发出的消息进入同一个 agent 队列，每条消息和每一轮都标明真实发送者。
- 多个 driver 同时在线时行为可预期，不会互相吞消息或互相打断。
- 可随时撤销；撤销后对方不再收到新内容。

## 非目标

- 不做公开链接、只读快照、匿名访问（沿用 2026-09 UX review 的拒绝）。
- 不做跨服务器分享；不做 Team/Space 对象；不改加密模型（服务器仍在信任边界内）。
- 不允许被分享者改会话设置（模型、权限模式、归档）、不允许借 owner 的机器开新会话。
- 不做实时光标/协同编辑式的 UI。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 每个 Session 一把随机 DEK，用 `tweetnacl.box` 包给账号 content 公钥，存 `Session.dataEncryptionKey` | `packages/happy-server/prisma/schema.prisma:207` |
| content 密钥对由账号主 secret 派生；主 secret 用 `HANDY_MASTER_SECRET` 加密存 `AccountSecret`，服务器可恢复 | `docs/encryption.md:5-8,498-533`；`packages/happy-web-v2/src/sync/encryption/encryption.ts:19-22,208,221` |
| Session REST 与列表按 `accountId: userId` 过滤 | `packages/happy-server/sources/app/api/routes/v3SessionRoutes.ts:88,146,166`；`sessionRoutes.ts:70,157` |
| RPC 房间 `rpc:${userId}:${method}`，跨账号打不到 | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:67` |
| 新消息只推给 owner 的 userId | `v3SessionRoutes.ts:189` |
| daemon 收消息只看 seq 与能否解密，不校验发送者 | `packages/happy-cli/src/daemon/apiSession.ts:284-312` |
| 普通消息进 durable 队列，agent 一轮取一条；working 时入队并在 `turn-end` 后恢复 | `specs/2026-08-queued-chat-input.md` |
| 「立即干预」= 从队列取出 + `steer`/`abort`，是可选 session RPC | `specs/2026-08-queued-message-controls.md` |
| 协作消息已有「正文头 + `meta.sentFrom`」格式 | `specs/2026-09-session-peer-messaging.md:36-70`；`packages/happy-wire/src/messageMeta.ts` |
| 上游残留好友表与接口：`UserRelationship(fromUserId,toUserId,status)`、`/v1/friends/{add,remove}`、`/v1/friends` | `schema.prisma:447-460`；`userRoutes.ts:116-184` |

## 设计

### 对象

- `SessionGrant`：`sessionId`、`granteeAccountId`、`role ∈ {viewer, driver}`、`grantedBy`、`createdAt`、`revokedAt`。一个会话对一个账号最多一条有效 grant。
- 分享对象的查找：按 email/handle 精确匹配同服务器账号。好友关系复用 `UserRelationship`（pending → accepted），分享只允许给已接受的好友；好友接口已在，前端补一个最小入口即可。

### 密钥

- 建 grant 时，服务器用已能恢复的 owner 主 secret 解出该会话 DEK，再 `box` 给被分享者的 content 公钥，作为 grant 的一部分存储（`granteeDataEncryptionKey`）。撤销时删除这份包裹。
- 不改消息密文；被分享者用自己的私钥解开 DEK 即可读全部历史。
- 这一步让「服务器可解密」从隐含事实变为显式动作，要记审计日志（谁、何时、把哪个会话包给了谁）。

### 读路径

- Session 列表与详情路由放宽为 owner-or-active-grant；列表项带 `sharedBy` 与 `role`，前端分组显示「分享给我的」。
- 新消息、状态更新、权限卡的推送扇出到所有活跃 grantee 的房间；RPC 中只读类（拉历史、文件预览）允许 grantee 调用，按 grant 校验。

### 写路径（driver）

- driver 发消息：服务器校验 grant 为 driver，落库时 `accountId` 仍为 owner（daemon 不用改），`meta.sentFrom = 'shared'`、`meta.senderAccountId`、正文头用 peer 消息的现有格式注明发送者。
- agent 看到的是「[来自 alice] …」这类前缀，与 Teams/peer 消息一致，不新增 wire 字段。
- 权限卡与 AskUserQuestion：owner 与任何 driver 都能回答，先到先得，记录回答者；viewer 只能看。
- 「立即干预」（steer/abort）、归档、改模型或权限模式、再分享：仅 owner。
- 撤销 grant 后，该账号已入队未处理的消息照常处理（已是 owner 名义），但不再收推送。

### 多人同时用同一个会话（Owner 2026-10-18 提问）

agent 本身一轮只处理一条消息，队列就是并发控制，不需要排他锁。规则：

1. 所有 driver 的消息进同一个有序队列，按到达顺序逐轮处理；每条消息、每一轮都显示发送者。
2. working 时别人发的消息照常入队，前端对所有人都展示「排队中 · 来自谁」。
3. 当前这一轮只能由发起它的人或 owner 中断/改向；其他人只能排队或撤回自己未处理的消息。
4. 权限与提问先答先得，答案对所有人可见并标明回答者。
5. 想独立试一条路的人用「分叉给我」：复制历史到自己名下的新会话（需要目标机器上有可用 agent，首版可只支持同机器 fork；跨机器 fork 留后续）。
6. 在线状态与「正在输入」对会话内所有人可见，降低互相覆盖意图的概率。

冲突的指令本质是沟通问题，不靠锁解决；产品只保证顺序、署名和可见。

## 风险

- 服务器显式解 DEK 给第三方：信任边界没变，但攻击面从「被动可解」变为「有接口可触发」。缓解：只能 owner 触发、审计、限频。
- 被分享者的 daemon 不参与：所有解密在 web 端完成，不下发给对方机器；对方不能把该会话「带走」到自己机器。
- 推送扇出增加 socket 房间数；活跃 grant 一般很少，可接受。
- 旧 Web 看不到「分享给我的」会话，但不影响 owner；需要前端升级才能用。

## 验收标准（高层）

- [ ] owner 分享给好友 A（viewer）：A 能看到完整历史与实时更新，不能发送。
- [ ] 改为 driver：A 发送的消息出现在双方 transcript，署名 A；agent 回复双方同时可见。
- [ ] owner 与 A 同时发送：两条按顺序各占一轮，无丢失；A 不能中断 owner 发起的轮。
- [ ] 撤销后 A 的列表里会话消失，不再收到推送。
- [ ] 审计日志有 grant 建立/撤销记录。
- [ ] 老 Web 与老 CLI 不受影响（daemon 零改动）。

## 实现记录（2026-10-18，与设计稿的差异）

安全审计（spec 定稿前对 grantee 攻击面的只读审计）推翻了设计里两处"最小改动"，实现按审计结论落地：

- **grantee 不拿任何 RPC**。session RPC 的参数用会话 DEK 加密，服务器看不到内容，`permission` 请求体还能带 `mode`/`allowTools`/`updatedInput`；所以 rpc-call 继续按 userId 房间路由，跨账号一律不通。权限卡、中断、改模式/模型、文件面板、`/btw`、消息编辑/删除在 grantee 侧不渲染。
- **driver 的消息由服务器加密**（`POST /v1/sessions/:id/shared-messages` 收明文）。服务器用 owner 的主密钥解出 DEK（`app/session/sessionCrypto.ts`，与 CLI/web 的密钥树、box、AES-GCM 逐字节同格式），写入 `{role:'user', content.text: "[Very Happy shared session message from \"<name>\" <id>]\n<text>", meta:{sentFrom:'shared', displayText, sharedBy}}`，**不含** permissionMode/model/delivery，以 owner 名义入库并推送。daemon 零改动，老 wrapper 也能收。
- **grant 先 pending、对方接受才 active**，不需要好友表；分享对象按 email 或用户名（含密码账号的登录名）查找。
- **DEK 由服务器重包**给 grantee 的 content 公钥（web 登录时上报 `contentPublicKey`，没有就从服务器持有的 secret 派生）；grantee 拿到的 metadata 是重加密的脱敏副本（去掉 homeDir/happy*Dir/hostPid/terminalId/mcpServers），`update-session` 扇出同样脱敏。
- **扇出**挂在 eventRouter：`all-interested-in-session` 的 update 与 session 的 activity/usage ephemeral 镜像到各 grantee 的 user-scoped 房间；归档状态单独补发；删除会话通知 grantee。push/webhook 不扇出。
- **撤销**：行标记 revoked，服务器各读路径立即 404，grantee 页面提示并回首页；已持有的 DEK 不轮换（历史本已可见）。
- 验证：server pglite 集成测试 9 条（含越权、脱敏、信封内容、撤销）；本地 standalone 双账号 + 真实 CLI daemon + 一轮 Claude：driver 消息被 daemon 正常解密、agent 回复双方同时可见；viewer POST 403、owner-only 路由 404、撤销后全部 404。
- **B-621 补：分享对象的解析不再是分享模块私有**。「这个人是谁」统一在 `app/social/accountDirectory.ts`（email 精确 / 资料用户名 / 登录名，不做前缀猜测），好友、搜索、分享、以后的 Space 共用；`POST /shares` 另接受 `accountId`（好友芯片一键分享）。grant 不要求好友关系——分享仍是定向授权，好友只是更快的入口。

## 留待后续

- 跨机器 fork；分享给整个 Team/Space（对象层已就位：`SessionGrant` 可加 `spaceId` 维度，解析走 accountDirectory）；Tanka 等 transport 的双写（见 design §8 Step 4）。
- 分享邀请走 feed/push（现在只走 socket update；好友申请已走 feed `friend_request`，两者合流后手机才有推送）。
