# Cloud identity + signup capacity

> 状态：Final
> 日期：2026-08-23 ｜ 关联 backlog：B-149 ｜ 出处：Owner 对开源专项的前置收敛

## 背景

Very Happy 的既定产品方向是「开源 + 官方 Cloud 默认可用 + 可自托管」。CLI 继续默认连接
`happy.mereith.com`；官方 Cloud 允许陌生用户直接注册，而不是要求每位用户先部署 server。

现有 web 已有用户名密码注册/登录，但账号身份、Happy account、登录 session 和账户 secret
混在一起：密码表直接保存可回传的 account secret；persistent token 没有服务端到期/撤销；
Google 还不是登录身份；legacy `AccountUnlock` 的公开读取路径仍带单用户假设。本专项先把这条
Cloud 身份底座做稳，从后续开源专项中移除认证方案的不确定性。

Owner 已拍板：

1. 用户名密码长期保留；
2. Google 首次登录允许开放创建 Account；
3. 官方 Cloud 仍是 CLI/Web 默认服务；
4. 增加可配置的全局 Account 容量，先以 100 作为官方 Cloud 建议值；自托管默认不强加上限。

## 目标

- 一个 `Account` 可绑定多个登录身份（首批 password + Google）。
- Google 首次登录和密码注册走同一 signup policy；已有身份登录永远不受容量门限制。
- Web 登录拿到有过期时间、可服务端撤销的 login session；旧 CLI/daemon token 保持兼容。
- account secret 使用 `HANDY_MASTER_SECRET` 派生密钥加密落库；读取时兼容迁移旧明文行。
- 删除 legacy `GET /v1/account/unlock` 的公开跨账户读取能力，保留兼容所需的已认证写路径直至后续清理。
- 暴露注册容量、拒绝原因、活跃 login session 与 Node 进程内存指标。
- Google 未配置时，Web 不显示入口且密码登录完全不受影响。

## 非目标

- 本批不做邮件找回密码、管理员后台、计费、候补名单、ToS/Privacy 全文。
- 本批不做 GitHub 登录；现有 GitHub integration OAuth 与账户登录保持隔离。
- 本批不限制用户本地 tmux/terminal 数；注册总量不是运行时资源保护的替代品。
- 本批不重写 CLI/daemon 的配对协议，不强制旧 persistent token 迁移。
- 本批不做 Google Drive 等授权，只使用 OIDC 身份声明。
- 本批不改公共 CI runner、landing、Docker 或开源历史清理。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 已有密码注册，客户端生成 32-byte secret 后先建 Account、再写 credentials | `packages/happy-web-v2/src/screens/auth/SignupScreen.tsx:60-76` |
| 密码登录返回 `{token, secret}` | `packages/happy-server/sources/app/api/routes/accountAuthRoutes.ts:96-120` |
| `AccountCredential.secretEnc` 当前实际存的是原样字符串 | `packages/happy-server/prisma/migrations/20260618120000_account_credential/migration.sql` |
| auth persistent token 本身无服务端 expiry；24h 只是内存 cache TTL | `packages/happy-server/sources/app/auth/auth.ts:4-19,46-106` |
| Web logout 只清本地凭据，没有服务端 revoke | `packages/happy-web-v2/src/auth/AuthContext.tsx:41-63` |
| 注册 gate 只有 `SIGNUP_CLOSED` / `SIGNUP_INVITE_CODES`，未限制 Account 总数 | `packages/happy-server/sources/app/api/routes/authRoutes.ts:8-27` |
| legacy unlock GET 无认证并选择最早 Account | `packages/happy-server/sources/app/api/routes/unlockRoutes.ts:61-100` |
| runtime Web config 目前只有 server/build 字段，没有 Google client id | `packages/happy-web-v2/src/sync/appConfig.ts` |
| 现有指标已有 websocket/database gauges，未显式注册 Node 默认进程指标 | `packages/happy-server/sources/app/monitoring/metrics2.ts` |

## 设计

### A. 数据模型

新增：

```text
AccountIdentity
  id, accountId, provider, providerSubject, email?, profile?, createdAt, updatedAt
  unique(provider, providerSubject)

AccountLoginSession
  id, accountId, tokenHash, expiresAt, revokedAt?, createdAt, lastUsedAt
  unique(tokenHash)

GoogleLoginChallenge
  nonceHash, expiresAt, consumedAt?, createdAt
  one-time, server-issued, database-backed replay gate
```

`AccountCredential` 继续承载 password identity 的 scrypt hash，避免一次性破坏旧用户；它与
`AccountIdentity(provider=password, providerSubject=<normalized username>)` 在成功注册/登录时懒迁移。
Google 只写 `AccountIdentity(provider=google, providerSubject=<verified sub>)`。

`AccountCredential.secretEnc` 保持 TEXT schema 以降低迁移风险，值改为带版本前缀的 server-side
密文。读取旧无前缀值时视为 legacy plaintext：本次登录成功后立即重写成密文。新 Google Account
的 secret 由 server 生成并只以密文落库；为了复用统一读取路径，为 Google-only Account 增加独立
`AccountSecret(accountId, secretEnc)`，密码路径同步写入/回填该表。最终 secret 事实源是
`AccountSecret`，`AccountCredential.secretEnc` 只作旧版本兼容镜像。

### B. Signup policy

统一解析：

```text
SIGNUP_MODE=open | invite | closed
SIGNUP_MAX_ACCOUNTS=<positive integer; empty/0 = unlimited>
SIGNUP_INVITE_CODES=a,b,c
```

兼容旧配置：未设置 `SIGNUP_MODE` 时，`SIGNUP_CLOSED=true/1` → closed；有 invite codes → invite；
否则 open。只有「创建新 Account」进入 gate；已有 Google/password identity 登录、登录态绑定 identity
均不进入 gate。

容量判断与 Account 创建必须在同一数据库事务中，并锁定单例 `SignupCapacity` 行，避免多副本并发
越过最后名额。容量下降到现有账号数以下不会踢人，只阻止新建。拒绝返回稳定错误：
`signup-closed` / `invite-required` / `capacity-reached`。

### C. Login session

密码/Google Web 登录创建 `AccountLoginSession`，默认 30 天（`LOGIN_SESSION_TTL_DAYS` 可调），
并签发带 `extras.loginSessionId` 的现有 privacy-kit token。数据库只保存 token 的 SHA-256 hash。

鉴权时：

- token 无 `loginSessionId`：视为 legacy/CLI token，按旧逻辑通过；
- token 有 `loginSessionId`：要求 session 存在、未 revoke、未过期、token hash 匹配；
- Web `POST /v1/account/logout` revoke 当前 session；旧 server 不支持该 route 时 Web 仍完成本地 logout。

本批保留 token wire 格式，避免 Socket/HTTP/CLI 全面改协议。

### D. Google OIDC

Web 使用 Google Identity Services 按钮获取 ID token，POST 到 `/v1/account/login/google`。
server 使用 Google JWKS 验证 RS256 签名，并验证 `iss`、`aud`、`exp`、`sub`；只信验证后的 claims。
JWKS 有短 TTL cache，网络/配置失败返回通用认证错误，不记录 token。

在初始化 GIS 前，Web 先从 `POST /v1/auth/google/challenge` 领取 32-byte 随机 nonce；数据库只保存
SHA-256 hash 和 5 分钟有效期。Web 把 nonce 传给 `google.accounts.id.initialize`，并在提交 credential
时一并回传。server 要求签名后的 ID token `nonce` claim 与请求值精确相等，再以条件 UPDATE 原子消费；
过期、未知或已消费 nonce 一律拒绝。因此同一 ID token 即使在 `exp` 前被再次提交，也不能换取第二个
Happy login session。容量/邀请码等后续拒绝会烧掉 nonce，Web 在失败后自动领取新 challenge 并重绘按钮。

Google challenge/login 只接受 `Origin` 命中 `GOOGLE_ALLOWED_ORIGINS` 的浏览器请求；配置 Google Client ID
时该 allowlist 必须存在，否则 server 启动失败。非 loopback origin 强制 HTTPS。它是浏览器边界的纵深防御，
不能替代 token/nonce 验证。认证限流使用数据库原子 bucket，跨 server replica 共享；反向代理部署必须通过
`TRUST_PROXY` 明确信任 hop 数或 IP/CIDR，禁止无条件信任任意 `X-Forwarded-For`。

环境变量：

```text
GOOGLE_CLIENT_ID=<web oauth client id>
GOOGLE_ALLOWED_ORIGINS=https://happy.mereith.com
TRUST_PROXY=1
```

Official Cloud uses client ID `190908753734-rto8svijvvh616877aketn4pnkhauec1.apps.googleusercontent.com`.
The ID is public configuration, not a secret. Self-hosters must create their own Web OAuth client and origin allowlist.

server 通过 `/v1/auth/config` 暴露 public auth config（只含 client id、signup mode、capacity 状态）；
同域 standalone 也可通过 runtime config 注入。首批不需要 client secret。

Google 新身份：先过 signup policy，server 生成 account secret 与 Account，再写 identity、secret、session。
Google 已有身份：直接创建新 login session。相同 email 不自动合并。登录态绑定入口留后续 UI，本批数据模型
和唯一约束先保证可安全增加。

### E. 指标

启用 prom-client 默认进程指标，并增加：

- `registered_accounts_total`
- `active_login_sessions_total`
- `signup_capacity_remaining`
- `signup_rejections_total{reason,provider}`

拒绝指标不得带 username/email/IP 等高基数或个人信息 label。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server + 旧 Web | 原密码注册/登录继续工作；响应新增字段被忽略 |
| 旧 server + 新 Web | auth config/Google route 404 → 隐藏或降级 Google；密码登录继续；logout 本地完成 |
| 新 server + 旧 CLI/daemon | 无 loginSessionId 的 token 继续按旧 token 验证 |
| 新 Web + Google 未配置 | 不加载 GIS、不显示按钮 |
| 达容量 + 已有 identity | 允许登录 |
| 达容量 + 新 password/Google identity | 稳定返回 `capacity-reached` |

发布顺序：数据库迁移 → server → web。CLI 无需发布。回滚 server 时新表保留无害；回滚 Web 后密码登录仍可用。

## 风险

1. **账户创建竞态**：单例 capacity row + transaction row lock。
2. **Google token 验证错误**：只接受 RS256、固定 issuer、精确 audience、有效 exp；JWK `kid` 必须命中。
   Popup callback 另要求一次性 nonce，并限制浏览器 Origin；redirect URI 不是该模式的安全边界。
3. **账号接管**：不按 email 自动合并；provider subject 才是身份键。
4. **旧 secret 明文长期残留**：成功密码登录时懒迁移；另提供一次性迁移脚本/启动迁移统计留后续。
5. **login session DB 查询放大**：短 TTL 内存 cache 可后加；先保证 revoke 语义正确，观察指标再优化。
6. **主密钥轮换**：现有 `HANDY_MASTER_SECRET` 尚无 keyring；密文版本前缀为后续多 key 轮换预留。
7. **多副本指标重复**：registered/capacity gauges 是每 pod 相同快照，dashboard 聚合用 `max` 而非 `sum`。

## 验收标准

- [ ] 密码新注册受 open/invite/closed/capacity 四类策略控制。
- [ ] Google 新身份开放创建；已有身份在满额/closed 时仍能登录。
- [ ] Google token 的签名、issuer、audience、expiry、subject 均有失败测试。
- [ ] Google nonce 必须匹配签名 claim、5 分钟过期且只能原子消费一次；失败后 Web 刷新 challenge。
- [ ] 相同 email 不会自动合并账户；同一 provider subject 不会创建两个账户。
- [ ] 新 account secret 只以 server-side 密文落库；旧密码账号登录后懒迁移。
- [ ] 新 Web login session 可过期、可 revoke；logout 后 token 不能再通过鉴权。
- [ ] 旧 CLI/daemon persistent token 兼容。
- [ ] legacy unlock 公开 GET 不再可用。
- [ ] Google 未配置或旧 server 时密码登录不受影响。
- [ ] 容量和进程内存指标可抓取，无 PII/high-cardinality labels。
- [ ] server tsc + vitest、web tsc + vitest + vite build 全绿。

## 留真机验证项

- Google Console 配置真实 Client ID 后，在 `https://happy.mereith.com` 完成一次新用户注册和再次登录。
- 容量调到当前账号数时，确认新 Google/密码注册显示「已满」，已有用户仍可登录。
- 登录后刷新、跨 tab、logout 的浏览器体验与 Google 按钮暗/亮主题观感。
