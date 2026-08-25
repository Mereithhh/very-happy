# Email OTP authentication

> 状态：Final
> 日期：2026-08-25 ｜ 关联 backlog：B-185 ｜ 出处：Owner 2026-08-25

## 背景

公开 Cloud 需要比共享密码更适合跨设备的默认认证方式。Email 验证码不要求用户记忆或复用密码，仍保持“换设备直接登录”的体验。现有密码账号和 Google 登录已在生产使用，不能因新增入口失效。

## 目标

- Web 登录和注册默认呈现 Email 验证码；Google 与可选密码是次级入口。
- 一个 Email OTP 流同时覆盖已有身份登录和受 signup policy 保护的新账号创建。
- OTP 在数据库中短期持久化、单次消费、限制错误次数，并对 IP、邮箱和全局发送/验证做共享限流。
- 发信层不新增 npm 依赖，支持 `cloudflare` 与 `resend` 两种 HTTPS provider。
- `AUTH_PASSWORD_LOGIN_DISABLED=true` 同时关闭服务端密码 signup/login/credential mutation，并从新 Web 隐藏密码入口。

## 非目标

- 不把 Email OTP 描述为 MFA；它是 passwordless primary authentication。
- 不自动把输入邮箱与已有 password/Google 账号合并；只有已经绑定同一 email identity 的账号会返回原账号，避免仅凭邮箱字符串错误合并身份。
- 不在本批实现邮件退信 webhook、营销邮件、magic link 或第三方 SMTP client。
- 不删除既有 password credential 数据，以便关闭开关后可逆恢复。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 当前登录页先呈现 Google，随后直接展示 username/password | `packages/happy-web-v2/src/screens/auth/LoginScreen.tsx` |
| password 与 Google 均返回 server-held account secret 和 30 日可撤销 login session | `packages/happy-server/sources/app/api/routes/accountAuthRoutes.ts` |
| 新身份必须通过带全局 Account 锁的 signup gate；已有身份绕过容量/关闭策略 | `packages/happy-server/sources/app/auth/signupPolicy.ts` |
| `AccountIdentity(provider, providerSubject)` 已提供多身份唯一索引和可选 email | `packages/happy-server/prisma/schema.prisma` |
| DB-backed `AuthRateLimitBucket` 可在多副本间共享认证限流 | `packages/happy-server/sources/app/auth/authRateLimiter.ts` |
| server bind-mount 发布约束禁止为发信新增 npm dependency | `AGENTS.md`、`.agents/skills/dev/SKILL.md` |

## 设计

### Public config 与环境变量

`GET /v1/auth/config` 增加：

```ts
{
  emailOtpEnabled: boolean;
  passwordLoginEnabled: boolean;
}
```

环境变量：

- `AUTH_EMAIL_PROVIDER=cloudflare|resend`：不设置则 Email OTP 不启用。
- `AUTH_EMAIL_FROM`：必填发件地址；显示名由 provider 能力决定。
- Cloudflare：`CLOUDFLARE_EMAIL_ACCOUNT_ID`、`CLOUDFLARE_EMAIL_API_TOKEN`。
- Resend：`RESEND_API_KEY`。
- `AUTH_PASSWORD_LOGIN_DISABLED=true`：关闭全部 password auth 写入与登录端点。
- `AUTH_EMAIL_CODE_TTL_MINUTES`：默认 10，限制 2–30。

若配置了 provider 但缺参数，或禁用 password 且 Email OTP/Google 均不可用，server 启动 fail closed。生产应显式配置 provider；自托管未配置邮件时，旧 Web 仍可使用 password/Google。

### 数据模型

新增 `EmailLoginChallenge`：随机 UUID 主键、规范化 email、HMAC-SHA256 code hash、expiry、attempts、consumedAt、createdAt。HMAC key 从 `HANDY_MASTER_SECRET` 域分离派生，不存明文验证码。

请求新 code 时先清理该 email 的未消费 challenge，再写入新行。生产 source-overlay 部署不携带重新生成的 Prisma Client，因此新表读写全部使用参数化 raw SQL。验证在数据库事务和行锁中完成：过期/已消费/达到 3 次失败均拒绝；失败原子增加 attempts，第 3 次同时消费；成功先标记 consumed，再进入 identity lookup/signup transaction。验证码只接受 6 位 ASCII 数字。

### API

1. `POST /v1/auth/email/code { email }` → `{ challengeId, expiresAt }`
   - 无论 email 是否已有账号，响应结构相同。
   - 发送桶：IP 10/min、email 3/10min、global 300/min；pending global cap 默认 10,000。
   - provider 失败删除该 challenge，返回可恢复的 503，不记录 email/code/API response body。
2. `POST /v1/account/login/email { email, challengeId, code, inviteCode? }` → login response
   - 验证桶：IP 30/min、email 10/min、challenge 6/min、global 600/min。
   - 已有 `provider=email, providerSubject=<normalized email>`：加载原 secret、创建 login session。
   - 新 email：走 `withSignupGate(provider='email')`，生成 account secret/public key，写 AccountSecret + AccountIdentity 后创建 login session。
3. `GET /v1/account/identities` → 当前账户可用登录方式的最小摘要。
4. `POST /v1/account/login/refresh { secret }` → 用有效 bearer + 当前账户 seed 换取新 login session。
   - seed 必须能推导出不可变的 `Account.publicKey`；仅有长期 bearer 不足以提升权限。
   - 用于旧 key-only/旧 bearer 客户端在不退出工作的情况下进入敏感身份变更，并原子修复历史 `AccountSecret` 与兼容镜像漂移。
   - 按账户分钟/日限流；不接受目标账户、public key 或 recovery secret 的替换。
5. `POST /v1/account/identities/email { email, challengeId, code, secret }` → 显式关联 Email 登录。
   - 必须同时具备有效 bearer、10 分钟内创建且未撤销/未过期的 login session，以及与当前 Account public key 匹配的本机 secret。
   - OTP 消费与 identity insert 在同一数据库事务；冲突会回滚 OTP 消费。
   - 一个账户最多一个 Email identity；一个 Email identity 只属于一个账户。已有归属返回 409，绝不移动、替换或按 Google claim email 隐式合并。
   - 绑定成功后 Email OTP 登录返回原账户，不创建第二个账户。
6. `POST /v1/account/identities/google { credential, nonce, secret }` → 显式关联 Google 登录。
   - 与 Email link 相同，要求 10 分钟内的有效登录 session 和能推导当前账户 public key 的本地 secret。
   - Google ID token 必须绑定五分钟一次性 nonce；token 先验签，nonce 消费与 identity insert 在同一事务。
   - 一个账户最多一个 Google identity；已有归属返回 409，绝不按 Google claim email 自动合并或移动身份。

### 发信适配器

统一纯接口 `sendLoginCode({to, code, expiresInMinutes})`：

- Cloudflare 调用 `POST /client/v4/accounts/{id}/email/sending/send`，Bearer token，域名必须在 Email Sending onboard，任意收件人要求 Workers Paid。
- Resend 调用 `POST https://api.resend.com/emails`，Bearer key，必须验证发件域名。
- HTML 与纯文本均提供；验证码不放 URL，不写日志。请求设超时；对外只返回 `email_delivery_unavailable`。

### Web flow

登录页首先显示 email 输入；发送成功后同卡片切到 6 位 code 输入、倒计时/重发和“更换邮箱”。验证码输入使用 `inputMode=numeric`、`autocomplete=one-time-code`、字体至少 16px。

Google 作为第二入口。仅 `passwordLoginEnabled=true` 时显示“Use password instead”折叠区。Signup 页面复用同一 Email OTP 组件并保留 invite 输入；服务端依据身份是否存在决定登录或注册，页面不承诺“这个邮箱是否已注册”。旧 server config 缺字段时兼容为 email disabled/password enabled。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 Web + 新 Server，password enabled | 旧 password/Google 路径不变；忽略 config 新字段 |
| 旧 Web + 新 Server，password disabled | password 请求收到明确 403；Google 仍可用；部署切换开关前必须先发布新 Web |
| 新 Web + 旧 Server | config 缺新字段 → password/Google 兼容 UI；Email OTP 不显示 |
| 新 Web + 新 Server | Email 默认；Google/可选 password 按 config 显示 |

发布：migration + server（先保持 password enabled）→ Web → 配置并验证邮件 provider → `docker compose up -d` 重建 server → Email 实信冒烟 → 可选设置 `AUTH_PASSWORD_LOGIN_DISABLED=true` 再重建。Server 发布后照 B-001 执行 `vh-update`。回滚先恢复 password enabled，再回滚 Web/Server；migration 为纯新增表，不做 destructive down。

## 风险

1. **邮件轰炸/成本滥用**：每邮箱/IP 的分钟、小时、日窗口，全局小时/日/月预算，pending cap 和短 TTL；默认月预算 3,000，接口不允许自定义内容或 sender。
2. **验证码爆破**：HMAC hash、3 次失败消费、challenge 与 email 双绑定、小时/日验证限流、一次性事务消费。
3. **账号枚举**：send response 不区分已有/新账号；signup policy 仅在正确 code 后判定。
4. **误锁 Owner**：禁用 password 前要求新 Web 已发布、provider 有效且至少 Google 或 Email 可用；startup 配置交叉校验。
5. **供应商 outage/Beta**：provider adapter 可在 Cloudflare/Resend 间切换；密码开关可逆且凭据不删除。
6. **同邮箱错误合并**：不按 Google claim email 自动合并；不同 provider identity 保持独立。Email/Google 显式 link 都需要近期登录、当前账户 secret 与独立 provider proof；冲突 fail closed。

## 验收标准

- [x] provider config 解析、缺项 fail closed、password disabled route guard 有单测。
- [x] OTP HMAC、TTL、错误次数、单次消费、并发双提交、email/challenge mismatch 有回归测试。
- [x] 已有 email 登录与新 email signup policy/capacity/invite 有 integration coverage。
- [x] Email sender 两 provider 的 URL/header/payload、timeout、错误净化有单测。
- [x] Web 默认 Email flow、resend/change email、Google/password 条件显示和错误状态有测试。
- [x] 已登录账户显式 Email link 对近期 session、账户 secret、单账户/单邮箱唯一性、并发冲突与事务回滚有回归测试。
- [x] 已登录账户显式 Google link 对近期 session、账户 secret、Origin、nonce、单账户/单 subject 唯一性与事务回滚有回归测试。
- [x] desktop/mobile real browser 无溢出，输入字号与 tap target 合规。
- [ ] server/web 全门禁、production Email 实信、password disabled/reenabled rollback 冒烟通过。

## 留真机验证项

生产 provider 配置需要 Owner/发布 agent 用一个真实邮箱收取验证码；验证码属于敏感数据，不写入仓库、日志或最终报告。
