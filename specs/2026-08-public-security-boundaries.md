# Public authentication, execution and egress boundaries

> 状态：Final
> 日期：2026-08-24 ｜ 关联 backlog：B-155 ｜ 出处：开源候选独立安全 review

## 背景

公开仓与公开 Cloud 会把此前“可信少数用户”的隐含假设变成可被陌生人主动攻击的边界。
独立 review 确认：PR 代码会进入私有 runner；HTTP 日志会记录 bearer/header/body；CLI 配对只凭
公开 key 轮询领取明文 token，且请求无 TTL/共享限流；webhook 只检查 URL 字面量、不解析 DNS；
account 总量不是活跃连接、session、payload 和 RPC 的资源保护。

## 目标

- fork PR 代码只能运行在临时 hosted runner，不能触达生产身份与私有 runner。
- 日志不记录 Authorization、Cookie、OAuth code/token、配对 key、原始畸形 body。
- 新 CLI 配对以只留在请求端的 claim secret 证明领取权，请求有 TTL、一次领取和 DB 共享限流；
  legacy 领取需显式 opt-in，默认关闭。
- 只有 machine-scoped socket 能注册 RPC；所有 socket/HTTP payload 与账户资源有可配置硬上限。
- webhook 每次发送前解析 A/AAAA，拒绝任一非公网地址，并把实际连接固定到已验证地址，阻断
  DNS rebinding/重解析绕过。
- password/Google 既有登录和已发行 daemon token 不失效；旧 daemon 在线连接不被踢下线。

## 非目标

- 不轮换或撤销生产密钥，不重写 Git 历史。
- 不把 account bearer token 改成完整 capability-token 系统；本批明确它仍是 account-wide token。
- 不增加 server npm dependency；生产 bind-mount 约束保持。
- 不承诺 webhook 能访问私网；公共安全默认优先于内部 webhook，私网目标应走独立 egress proxy。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 所有 PR 默认 self-hosted Linux 并执行 install/build/test | `.github/workflows/{quality,cli-smoke-test}.yml` |
| authenticate 日志截取 Authorization，404 日志序列化全部 headers | `packages/happy-server/sources/app/api/utils/{enableAuthentication,enableErrorHandlers}.ts` |
| JSON parser 把无法解析的原始 body 写日志 | `packages/happy-server/sources/app/api/routes/connectRoutes.ts` |
| terminal/account auth request 以 publicKey upsert，授权后仅凭 publicKey 返回 bearer token | `packages/happy-server/sources/app/api/routes/authRoutes.ts` |
| request 表已有 createdAt/updatedAt，可在不改 schema 的情况下实施 TTL | `packages/happy-server/prisma/schema.prisma` |
| `AuthRateLimitBucket` 已提供跨副本原子固定窗口 | `packages/happy-server/sources/app/auth/authRateLimiter.ts` |
| socket 信任握手 clientType，所有类型都安装 rpc-register handler | `packages/happy-server/sources/app/api/{socket,socket/rpcHandler}.ts` |
| webhook 明确把 DNS resolution/rebinding 留在范围外 | `packages/happy-server/sources/app/push/webhookNotify.ts` |
| Fastify 全局 bodyLimit 为 100MB | `packages/happy-server/sources/app/api/api.ts` |

## 设计

### A. CI isolation

`pull_request` job 的 `runs-on` 固定 `ubuntu-latest`，`permissions: contents: read`；self-hosted 仅用于
push main、tag、显式 dispatch。禁止 `pull_request_target` 和由 fork artifact 驱动的特权
`workflow_run`。增加仓库测试脚本静态检查所有 workflow。

### B. Safe logging

日志只留 method、path、request id、status、是否带 auth、body byte length/content type；不输出任何
header value、raw body、OAuth state/code/access token 或完整配对 identifier。用 sentinel token/cookie/body
回归测试捕获 logger 输出并断言 sentinel 不出现。

### C. Pairing claim protocol

新请求携带 `claimSecret`（32 random bytes, base64url）和 `supportsClaimSecret: true`。server 只保存
SHA-256 hash（可复用现有 request 行的兼容存储字段时优先；否则向两张表增加 nullable hash 字段并
保持旧 Prisma/bind-mount 可运行的 raw SQL 路径）。领取授权结果时必须提交原 claimSecret，常数时间
比较通过后在同一事务中删除 request/标记 consumed，再发行 token；重复领取返回 not_found。

请求 TTL 默认 10 分钟，可配置 1–60 分钟。create/poll/status/approve 采用 DB rate limiter：IP、public key
摘要和 account 三个低基数 bucket；schema 对 base64 解码后长度、response 长度、claimSecret 长度设硬界。
create 在跨副本数据库锁内先物理清理两张 pairing 表的过期行，再对两类 outstanding request 施加
全局安全上限；达到上限稳定返回 `429 pairing-capacity`。日志仅记录 request id 的短不可逆 hash。

legacy 客户端没有 claimSecret 时：已有授权 token/在线连接不受影响；新配对只有
`AUTH_ALLOW_LEGACY_PAIRING=true` 才允许领取，默认 false。发布采用 server 兼容接收新字段 → CLI →
确认 mac-office → 生产关闭 legacy。Web approval status 只暴露 pending/authorized/expired，不返回 token。

### D. Account and socket abuse limits

`/v1/auth` 现有 key 登录允许已有 Account；创建新 key Account 受 DB IP/global limiter，公共 Cloud 可用
`ALLOW_LEGACY_KEY_SIGNUP=false` 禁止，以免攻击者耗尽 signup cap。password/Google 正式注册路径保持。

全局 body limit 降为保守值，大 payload route 显式覆盖；create machine/session、活跃 socket、RPC 调用
分别有环境变量上限/窗口，默认值适合小型公开实例，`0` 只在自托管者显式配置时表示 unlimited。
超限稳定返回 413/429/`limit-reached`，不影响已有对象读取与账号登录。只给 machine-scoped socket 安装
rpc-register/unregister；user/session socket 可 rpc-call。握手 clientType 必须是枚举且所带 id 归当前
account；legacy 未带 clientType 只作 user-scoped。

### E. DNS-pinned webhook delivery

发送前用 Node DNS 解析目标 host 的全部 A/AAAA；任何一个地址属于 loopback/private/link-local/
multicast/documentation/unspecified/metadata 或非单播公网范围即拒绝。实际 HTTPS request 使用自定义
`lookup` 返回已经验证的单一地址，同时保留 URL hostname 作为 TLS SNI 和 Host。禁 redirect、5s timeout、
限制响应体读取；每次发送重新解析/验证。解析失败默认拒绝。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server + 新 CLI | claimSecret 领取、TTL/一次性消费 |
| 新 server + 旧 CLI，legacy=true | 临时兼容旧配对，记录 deprecated 指标，不记录 key |
| 新 server + 旧 CLI，legacy=false | 已有 token/连接正常；发起新配对得到 upgrade-required |
| 旧 server + 新 CLI | 新 CLI 检测 unsupported 后给出升级 server 指引；不静默回退到不安全领取 |
| 新 Web + 新/旧 server | approval 多余字段被旧端忽略；expired/not_found 提示重开 CLI link |

发布：hosted PR 隔离/日志/webhook 可先合并；协议路径 server（legacy 临开）→ CLI tag → mac-office
`vh-update` → 生产关 legacy → Web。回滚 server/CLI 时不删除兼容列；恢复上一版并重启 daemon。

## 风险

1. **旧 CLI 无法配对**：明确 upgrade-required，已有 token 不受影响；仅维护窗口可短期开 legacy。
2. **DNS pin 破坏 CDN 多地址 webhook**：只要全部解析地址为公网就选一个连接；任一混入私网即 fail closed。
3. **限额误伤 Owner**：现有对象和连接不回收；只拒绝新增/超速请求，指标记录 reason，环境变量可调。
4. **bind-mount Prisma drift**：新增列通过 migration + raw SQL 使用，测试覆盖旧 generated client mock。
5. **token audience 误判**：现有 pairing token 明确为 account-wide，不把历史 `extras.session` 当 scope；
   通过连接类型限制 RPC 注册来缩小能力，而不破坏 daemon。

## 验收标准

- [ ] fork PR workflow 静态测试证明无 self-hosted/secret/write permission。
- [ ] sentinel bearer/cookie/body 永不出现在日志。
- [ ] 新配对缺/错 claimSecret、过期、重放、并发双领、超速均失败；正确领取只成功一次。
- [ ] legacy 配对默认拒绝且已有 token 验证不受影响。
- [ ] 非 machine socket 不能 rpc-register；id 跨 account 连接失败。
- [ ] webhook 私网 DNS、混合 A/AAAA、rebind、redirect 均失败，公网 TLS/SNI 成功。
- [ ] 资源限额返回稳定错误并有测试/指标；已有读取/登录无回归。
- [ ] server/CLI/Web 全门禁与 isolated HOME 配对冒烟通过。

## 留真机验证项

- 新 CLI 在生产 Cloud 连接首台机器，claim 链路成功且链接过期后可恢复。
- mac-office daemon 更新前后已有 session/terminal 不中断；关闭 legacy 后重新认证仍成功。
- 现有公网 webhook 正常投递，私网/内网 hostname 明确被拒绝。
