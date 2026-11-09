# 托管实例迁到公司域名 vibe.apodex.site（B-903）

> 状态：Draft（方案先行，待 Owner 拍板 §9；本 PR 只有文档，不改 DNS / AWS / Cloudflare / 生产，不发版）
> 日期：2026-11-09 ｜ 关联 backlog：B-903 ｜ 复用：B-365（旧 host 只留 API）、B-627 / B-635（搬家通知与 daemon 跟随）
> 引用清单：[`2026-11-domain-migration.refs.tsv`](2026-11-domain-migration.refs.tsv)（文件、行、类别、改法）

## 0. 结论

- **只换 hostname，不搬 server、DB、Redis。** vh-sg、RDS `vh-pg`、ElastiCache 已在公司 AWS `422653419554`。CloudFront `E2JUP4WHDXD8HU` 也在公司账号。真正挂在个人资源上的，是 `veryhappy.dev` 的注册与 DNS（个人 Cloudflare）、登录邮件的发件域、`admin.veryhappy.dev`（Cloudflare Access/Tunnel）、`relay-us`（个人 VPS dmit-la）、GitHub 仓库和 npm 包。
- **推荐方案 B：人走、机器跟。** 新域名先作为同一后端的别名上线。旧站点的 daemon 由已发布的 `server-migrate` 通知自动跟随：7 天在线的 98 台机器里，91 台的 CLI ≥0.2.178，能自动跟。网页再一次性切到新域名，旧域名的 API 保留到流量归零后再关。用户感知只有一件事：打开 vibe.apodex.site，重新登录一次。这正是 Owner 想要的「通知 → 去新站」，只是旧域名的 API 不断。
- **Owner 提的方案 A（旧站整站挂「升级中」）不推荐。** 停机没有任何技术收益。它会让 98 台 daemon 同时断线：团队、自动化、运行中的会话全部失联，而且断线后连自动更新都发不下去，只能每台机器手动处理。对比见 §5。
- 浏览器换源之后，账号密钥由服务端在重新登录时下发；30 天活跃的 57 个账号都有可用的登录方式（实测，§3.1）。会丢的是：旧 origin 上还没发出的输入、本机偏好、Web Push 订阅、PWA 安装。降损做法见 §3.2，方案里没有任何跨域传递密钥的设计。

## 1. 现状事实（只读取证，2026-11-09）

| 项 | 事实 | 来源 |
|---|---|---|
| 公网入口 | `veryhappy.dev` → 个人 Cloudflare（NS `cesar/liz.ns.cloudflare.com`），DNS-only CNAME → CloudFront `E2JUP4WHDXD8HU` | `dig`；`docs/operations.md` Topology |
| CloudFront | Aliases：`veryhappy.dev`、`cf-test.veryhappy.dev`；证书 ACM us-east-1 `1a7be563…`（SAN 就是这两个，DNS 验证，2027-04-10 到期，可自动续）；默认行为 CachingDisabled + **AllViewerAndCloudFrontHeaders**（Host 原样转发到源站）；`/assets/*` CachingOptimized；`/.well-known/acme-challenge/*` 走 HTTP 源（Caddy 用 HTTP-01 签证书）；没有 WAF，没有访问日志 | `aws cloudfront get-distribution-config` |
| apodex.site | 公司 Route53 public zone `Z04787629I6U1OS0O0R0`，共 309 条记录，ExternalDNS（`owner=main-eks`）写入；**`vibe.apodex.site` 不存在**；已有 `vibe-test.apodex.site`，它是 EKS us-west-2 `shared/very-happy-test` 的白标 standalone（PGlite，OIDC，镜像 `staging-039755e-20261019`），**与生产不同库** | `aws route53 list-resource-record-sets`；`kubectl -n shared` |
| 源站 Caddy | `veryhappy.dev, happy.mereith.com { … }`；`happy.mereith.com` 已经按「API 照常、页面 301」处理（B-365），可直接作为本次旧域名的先例 | `ops/production/Caddyfile.blue-green:40-61` |
| 生产 env（只判断有无与所含域名，不回显值） | `PUBLIC_URL` 含 veryhappy.dev；`HAPPY_WEB_URL` 含 veryhappy.dev；`GOOGLE_ALLOWED_ORIGINS` 有 2 项（veryhappy.dev、happy.mereith.com）；`AUTH_EMAIL_PROVIDER=cloudflare`，`AUTH_EMAIL_FROM` 在 veryhappy.dev 域；`HAPPY_RELAYS_JSON` = relay-sg/relay-us.veryhappy.dev；没有 `OIDC_*`（生产没开 SSO）；没有 `MIGRATION_*` | vh-sg `/opt/happy/.env` 键名 |
| Web 实际注入 | `__HAPPY_CONFIG__ = {"serverUrl":"https://veryhappy.dev"}`（来自 `PUBLIC_URL`，`standalone.ts:84`），**写死成绝对地址，不是 same-origin** | `curl https://veryhappy.dev/` |
| daemon 版本（7 天在线 98 台） | 0.2.208 ×66，0.2.205 ×8，0.2.207 ×5，0.2.178–0.2.204 共 12 台；**<0.2.178 共 7 台**（0.2.170 ×2，0.2.148、0.2.141、0.2.135、0.2.113、0.2.99 各 1）；30 天在线 138 台 | `Machine.lastHappyClient`（只读事务） |
| 账号登录方式 | 共 103 个账号；30 天有机器在线的 57 个**全部**至少有一种登录方式（51 个只有邮箱/Google，6 个有密码）；没有任何登录方式的 1 个，6 月起就不活跃；`AccountIdentity` 里 email 72 条、google 29 条、password 11 条 | 只读 SQL |
| 服务端密钥 | 103 个账号中 99 个有 `AccountSecret`，另有 3 个在 `AccountCredential.secretEnc` 里存着旧副本；两处都没有的只有上面那个不活跃账号 | 只读 SQL |
| Web Push | `AccountPushToken` 里 `webpush:` 订阅 52 条，涉及 25 个账号，没有 origin 列 | 只读 SQL；`schema.prisma:238` |

## 2. 引用清单与改法（按类别；逐行见 refs.tsv）

仓库内共 288 处、130 个文件（包含测试夹具 111 处、历史记录 33 处）；refs.tsv 另加了 13 行仓库外配置。Lead 估的「51 个文件 / 122 处」不含测试和历史，两个数口径不同，不矛盾。

| 类别 | 处数 | 改法 | 阶段 |
|---|---|---|---|
| **C CLI 默认地址**：`happy-cli/src/configuration.ts:14` `DEFAULT_RELAY_URL`，`ui/authRelay.ts:1-3`，`commands/auth.ts:13`，`commands/panels.ts:14`，`happy-agent/src/config.ts:11` | 7 | ① **先放宽凭据**：在 `authRelay.ts` 把 `veryhappy.dev`、`vibe.apodex.site`、`happy.mereith.com` 定义成「同一托管部署的别名组」。`authServerUrl` 落在组内任意一个时，在组内其他 origin 上都认（今天是 fail-closed：`authServerUrl=https://veryhappy.dev` 的凭据放到新默认地址上会报 `Credentials belong to …`。dev-sg 本机 `access.key` 实测就是这个值）。`happy-agent/credentials.ts:23-27` 同样处理。② 默认地址改成 `https://vibe.apodex.site`，**必须和 ① 在同一版发布，且晚于 P1 新域名验通**。③ 已装机器的 `settings.serverUrl` 迁移见 §4 P2 | P0 写码，P2 发版 |
| **W Web 构建常量**：`vite.config.ts:13`、`index.html:26` og:image、`relayLabel.ts:9`、`firstMachineCommands.ts:1,8`、`SkillDocumentLink.tsx:16`、wire `builtinTodoSkill.ts:13` | 16 | 默认值换成新域名。`relayLabel`、`firstMachineCommands` 要同时认新旧两个 host：否则从 vibe 打开首台机器引导时会被当成自建实例，给出 `HAPPY_HOME_DIR=~/.very-happy-vibe…` 的第二身份命令（这是 bug 级风险） | P0 |
| **W Web 文案 / 安装**：Landing、`publicContent*.ts`、法务页、`public/install.sh:121,178` | 15 | 中英同步改成新域名，并写一句「原 veryhappy.dev」；旧域名上的 `/install.sh` 照常提供（只是普通文件，CLI 默认值以版本内常量为准） | P0 |
| **S server 运行时** | 2（都是注释） | server 不写死域名：CORS 是 `*`，CSP 按请求 Host 推导（`securityHeaders.ts`、`requestOrigin.ts`），不用 cookie，没有 WebAuthn；分享链接由浏览器用 `location.origin` 生成。需要改的全在 env，见下行 | — |
| **P 生产配置**（refs.tsv `(prod)` 行） | — | `PUBLIC_URL`：P1 **改为不设**（注入 `same-origin`，每个 host 打自己的 API；附件和 OIDC 的 URL 由 Host 推导，CloudFront 原样转发 Host）。上线前要核对 `storage/files.ts:44`、`attachmentRoutes.ts:172` 在不设时的行为；不能接受的话，P3 再设成新域名。`GOOGLE_ALLOWED_ORIGINS` 在 P1 追加新 origin，同时在 Google Console 加 Authorized JS origin（只用 GIS popup，没有 redirect URI）。`HAPPY_WEB_URL`（Tanka webhook 里的链接）在 P3 换。`AUTH_EMAIL_FROM` 本轮不动（§6 Q5）。`OIDC_*` 生产没开，以后开的话把回调注册成 `https://vibe.apodex.site/v1/auth/oidc/callback`。`VAPID_*` 不换 | P1 / P3 |
| **E 边缘**：Caddyfile、CloudFront、ACM、Route53 | 5 + 外部 | Caddy 站点行加 `vibe.apodex.site`，P3 加 `@vh_old_page { host veryhappy.dev; not path /v1/* /v2/* /v3/* /files/* /health /logs-* }` → `redir https://vibe.apodex.site{uri} 301`（与 happy.mereith.com 相同），`test-blue-green-state-machine.sh:384` 的 grep 一起改；ACM 证书的 SAN 不能改，要新签一张含 `vibe.apodex.site` + `veryhappy.dev`（+`cf-test`）的证书，DNS 验证记录分别写在 Route53 和个人 Cloudflare；CloudFront 加别名并换绑证书；Route53 新建 A/AAAA alias → CloudFront（手工记录不带 ExternalDNS owner TXT，不会被 ExternalDNS 删） | P1 / P3 |
| **R 中继域名**：`ops/relay/Caddyfile.{sg,us}`、`deploy-relays.sh` | 6 | relay URL 是 CLI/Web 从 `/v1/relays` 动态拿的，relay token 绑定 `relayId`、不绑 host（`relayToken.ts:16`），**用户看不到，本轮不动**；relay-us 是否迁到公司资源见 §6 Q1 | 可选 P6 |
| **D 发布 / CI**：`deploy-blue-green-remote.sh:18`、`deploy-server-remote.sh:31`、`deploy-hwsg.yml:94,97,181`、`e2e-smoke.yml`、`publish.yml:277`、`check-recommended.mjs`、`advance-auto-update.sh` | 15 | `PUBLIC_ORIGIN` 改新域名；过渡期 deploy 的 health / 入口资源检查**两个 host 都探**（旧 host 的 API 也是生产路径） | P1 |
| **X 运维 / 探针脚本**、**M 监控** | 19 | 默认 base 改新域名（参数仍可覆盖）；告警目标加新 host；新增按 host 统计流量的指标（§5.1） | P1 |
| **U 当前文档**：README×2、`docs/*.md`、PRIVACY、AGENTS、RELEASING、CLI README | 59 | 改新域名，注明旧域名的过渡期；operations Topology 加一行 | P3 |
| **T 测试夹具 / H 历史记录** | 111 / 33 | 测试中当作「云端 origin」语义的，改成别名组断言；其余保留。backlog、旧 spec、竞品报告**不改**（是历史事实） | P0 顺带 |
| 不在本轮 | — | `admin.veryhappy.dev`（Cloudflare Access/Tunnel）、GitHub 仓库 `Mereithhh/very-happy`、npm 包名 `very-happy-cli`：都和用户访问的域名无关，见 §6 Q1 | — |

## 3. 浏览器换源的影响（最关键）

origin 一变，浏览器里按 origin 存的东西都会「看不见」。下表按影响排列：

| 存储 | 位置 | 换源后 | 能否找回 |
|---|---|---|---|
| 登录凭据 `{token, secret}` | localStorage `auth_credentials`（`web/src/auth/tokenStorage.ts:4`） | 未登录 | **能。** 服务端可恢复账号密钥（server-trusted，`AccountSecret.secretEnc` 用 `HANDY_MASTER_SECRET` 包裹，`accountSecrets.ts:4-34`）。密码、邮箱、Google 登录都会返回 `{token, secret}`（`accountAuthRoutes.ts:778-806,847,935`）；数据密钥由 secret 派生（`encryptor.ts:51`），换源后历史全部可读。实测 30 天活跃账号都有登录方式。Google 登录需要先在 P1 把新 origin 加进白名单，否则 403 `origin_not_allowed` |
| 未发出的消息 outbox | IndexedDB `vh-sync-<hash>` 的 `outbox` store（`outboxStore.ts:36-59`） | 新 origin 看不到 | 只能在**旧 origin 上发完**（§3.2） |
| 输入框排队、待建会话、待上传设置 | localStorage `mmkv:default:queued-messages-v1` / `pending-sessions-v1` / `pending-settings`（`persistence.ts:16,171`；`sync.ts:357,2705`） | 丢 | 同上，在旧 origin 上 flush |
| 草稿 | `session-drafts`、`new-chat-draft-v1`、`new-session-draft-v1`、diff / 对话批注草稿 | 丢 | 可编辑草稿、笔记、看板是服务端 KV，不丢；其余告知用户 |
| 本机偏好 | `mmkv:default:local-settings`（主题、侧栏宽度、zen、已读提示…）、`vh.*` 键 | 回到默认值 | 不迁移（只影响观感）；同步设置（语言等）在服务端，不丢 |
| Web Push | 订阅属于旧 origin 的 SW；服务端 `AccountPushToken` 按 token 存，没有 origin | 新 origin 要重新授权、重新订阅；**旧订阅会继续收推送，导致重复通知**，点击后打开 veryhappy.dev（之后会 301） | 新站引导重开；旧 origin 在离开前主动退订（§3.2） |
| PWA | manifest `id/scope/start_url` 都是 `/`，按 origin 识别 | 已安装的图标仍指向旧 origin，页面 301 之后会跳出 PWA 范围 | 需要重新安装；新站的安装卡会正常出现 |
| 自定义 server | `mmkv:server-config:custom-server-url` | 丢 | 托管用户本来就不设；影响可以忽略 |

### 3.1 账号密钥：核实结论

信任模型确实是「服务端能恢复账号密钥」（`docs/operations.md` Topology 段，以及法务页 `PublicLegalScreen.tsx:42`）。所以换源后只要重新登录，密钥就由服务端重新下发，**不需要也不应该**从旧 origin 带走任何密钥材料。仅有的例外是「只靠扫码配对、从没设过登录方式、服务端也没有密钥副本」的账号：生产上只有 1 个，6 月起不活跃。P2 之前再查一次（SQL 见附录），有新增的话单独通知本人。

### 3.2 降损做法（P2 写进 Web，不跨域传递任何东西）

1. **旧 origin 先发完、再跳转（drain-then-redirect）。** P2 起，同一个镜像在旧 host 上收到 `__HAPPY_CONFIG__.canonicalOrigin`（新的可选字段；旧 bundle 忽略它，向后兼容）。旧 origin 启动时：
   - 未登录、或者是 `/s/…`、`/login`、公开页：立即 `location.replace(新 origin + pathname + search + hash)`；
   - 已登录：显示「已迁到 vibe.apodex.site」整页，背后照常跑 sync。outbox、排队消息、待建会话、待上传设置都清空后（或者最多等 15 s，只要还有 `failed` 行就列出来让用户手动重试或复制），自动 `pushManager.unsubscribe()` 并 `DELETE` 本 origin 的推送 token（同 origin 操作），然后跳到新 origin 的同一路径，hash 保留。
   - 这一步依赖旧 host 的 API 还活着，方案 A 做不到。
2. **新 origin 首次登录引导。** 检测到「首次在本 origin 登录」时，登录卡下方写一行：「Very Happy 已从 veryhappy.dev 迁到这里，账号和会话都在，登录一次即可」。登录后的提示条提供「重新开启通知」和「重新安装 App」。这些都是本 origin 内的状态，不碰旧 origin。
3. **P3 Caddy 硬 301**（页面路径，`{uri}` 保留）做兜底。到那时还没打开过旧站的人，会被直接送到新站重新登录；他们本来也没有待发的数据。
4. **不做：** 不把 localStorage / IndexedDB / 密钥通过 URL、postMessage、iframe 或服务端中转带到新 origin。B-627 的网页 handoff（`/login/migrate?handoff=…`）技术上可以免去重新登录，但它会把一张一次性登录票放进 URL（浏览器历史、Referer、代理日志都可能留下）。重新登录的成本很低，所以推荐**网页不开 handoff**（§6 Q6）。

安全取舍：drain 页只在旧 origin 自己的上下文里读写自己的存储；跳转 URL 只带原来就在 URL 里的 path、query、hash（分享链接的 `#secret` 是持有者凭证，本来就在用户手里的 URL 中，见下）。

### 3.3 分享链接 `/s/<id>#<secret>`

`#secret` 是持有者凭证（不是解密密钥），由页面从 `location.hash` 读取，以 `x-share-secret` 头请求 `${serverUrl}/v1/public/share-links/…`（`SharedLinkScreen.tsx:27-49`），与页面来自哪个 origin 无关。浏览器遇到不带 fragment 的 301 时会自动保留原 fragment，所以 Caddy 的 `redir https://vibe.apodex.site{uri} 301` 能保留路径和 `#secret`；P2 的客户端跳转显式拼接 `location.hash`。**跳到根路径或返回「升级中」页面都会让已发出的链接失效**（方案 A 的问题之一）。CLI 生成的机器授权链接 `#<publicKey>` 同理。

## 4. 分阶段计划（推荐方案 B）

谁做：P0 代码由 worker 开 PR；**所有生产写入**（ACM、CloudFront、Route53、Cloudflare、vh-sg env/Caddy、发版）由 Owner 确认后、Lead 派人执行；每一步都写好回滚再动。时间按新加坡时间，挂在 11:00/17:00 发版班次上。

| 阶段 | 改什么 | 验证 | 回滚 | 用户感知 |
|---|---|---|---|---|
| **P0 代码准备**（无生产变更） | CLI：`authRelay` 别名组（veryhappy.dev ↔ vibe.apodex.site ↔ happy.mereith.com 互认），happy-agent 同理；**默认地址的改动先合但不发**。server：`MIGRATION_ACCOUNT_IDS=*`（或 `MIGRATION_ALL_ACCOUNTS=1`）表示全部账号；新增「同库别名」模式：只有请求或 socket 握手的 Host ≠ 目标 host 时，才发 `server-migrate`、返回 `/v1/migration`（今天的代码假设新旧是两套库，「never in life」，`migrationConfig.ts:5`）；`canonicalOrigin` 注入；按 host × 客户端类型计数的指标。Web：§3.2 的 drain 页和新站引导，`firstMachineCommands`、`relayLabel` 认新旧两个 host，文案。全部按 L2 走 QA（迁移、登录） | 单测：别名组正反向、非组内 origin 仍然 fail-closed；server 用 Fastify inject 测 Host 守卫；standalone + 两个 Host 头的 e2e：daemon 收到通知 → 在「新 host」换 token → 改写 settings 与 `access.key` | revert PR | 无 |
| **P1 新域名作为别名上线**（生产写入） | ① ACM us-east-1 新签证书（SAN：vibe.apodex.site、veryhappy.dev、cf-test.veryhappy.dev），在 Route53 和 Cloudflare 各写一条 DNS 验证 CNAME；② CloudFront 加别名 `vibe.apodex.site` 并换绑新证书；③ Route53 建 `vibe.apodex.site` A/AAAA alias → CloudFront；④ 发一版 server/Web（P0 + Caddyfile 加 host），switch 时 Caddy 通过 `/.well-known/acme-challenge/*` 签发源站证书；⑤ env：`GOOGLE_ALLOWED_ORIGINS` 加新 origin，`PUBLIC_URL` 改为不设；Google Console 加 origin；⑥ CI/探针改成两个 host | `curl -sI https://vibe.apodex.site/health`；两个 host 的入口资源 content-type；新域名用 [QA] 账号走密码 / 邮件 / Google 登录、读写会话、终端、分享链接；`check-shipped --origin` 两个 host 都过；旧域名全部回归 | ① 证书替换前旧证书保留，CloudFront 换回 `1a7be563…` 即可；③ 删除 Route53 记录；⑤ 恢复 `.env.bak-*` 后 `rollout=switch`。这一阶段没有用户在用新域名，回滚无感知 | 无（新域名尚未公布） |
| **P2 机器跟随 + 新 CLI** | ① env：`MIGRATION_TARGET_URL=MIGRATION_TARGET_WEBAPP_URL=https://vibe.apodex.site`、`MIGRATION_ACCOUNT_IDS=*`、`MIGRATION_HANDOFF_SECRET`（rbw 新条目），switch 发布：在旧 host 上连着的 ≥0.2.178 daemon，在没有进行中的轮次时自动改写 `settings.serverUrl/webappUrl` 与 `access.key`，并交接给新的 daemon 进程（B-635）。运行中的 wrapper 留在旧 host 直到会话重启（旧 API 继续服务，不受影响）。② 发 CLI 新版（别名组 + 默认地址 = 新域名），按 auto-update `latest` 链路自动升级 | 指标：旧 host 的 daemon socket 连接数单调下降，新 host 上升；抽 dev-sg、mac-office：`settings.json` 已是新地址、`daemon status` RPC 正常、团队 / 自动化 / 终端可用；`HAPPY_SERVER_URL` 被 env 钉住的 daemon 只记日志（逐台通知） | ① 去掉 `MIGRATION_*` 后 switch：已经跟过去的机器继续在新 host 上工作（同一个库），无需回迁；② CLI 新版有问题时，按 release skill 把 `CLI_AUTO_UPDATE_VERSION` 退回旧版本。**回退目标必须含别名组**：不含别名组的旧版只认 veryhappy.dev/happy.mereith.com，会拒绝已改写成 `authServerUrl=vibe` 的凭据。所以 P0 先单独发一版只加别名组的 CLI，≥80% 在线机器升上去之后再开 ① | 无（daemon 交接与 CLI 升级相同，正在跑的轮次不会被打断） |
| **P3 网页切换**（通知后执行） | ① env `HAPPY_WEB_URL` 换新域名；`canonicalOrigin` 生效（drain 页）；② Owner 在群里发通知（§8）；③ 3–7 天后 Caddy 页面硬 301（`@vh_old_page`），API、socket、files 路径照常 | 打开 veryhappy.dev 的任意页、`/s/x#k`、`/session/…`，都应 301 到同路径（含 fragment）；drain 页把 outbox 清空后再跳（在 [QA] 账号上构造排队消息）；Tanka webhook 链接打开的是新域名 | 撤掉 `canonicalOrigin`、恢复 Caddyfile 后 switch（几分钟）；已在新域名登录的用户不受影响（同一个后端） | **有**：重新登录一次；重开通知；PWA 重装 |
| **P4 观察**（≥30 天） | 不改动；每周看一次旧 host 流量（§5.1） | 旧 host 的 daemon 连接数 → 只剩 env 钉住的、<0.2.178 的和离线机器；逐个点名处理 | — | 无 |
| **P5 旧 host 停 API** | 满足「连续 14 天旧 host 的 daemon / CLI 请求为 0（或只剩已通知的机器）」且距 P3 ≥90 天后：旧 host 的 API 返回 410 和一段迁移说明，页面继续 301 | 新 host 指标无变化；410 的计数 | Caddyfile 回滚（几分钟） | 只影响已经通知过的残余机器 |
| **P6（范围选项）** | relay 改名 / 迁移、admin、发件域、域名注册转移，见 §6 | 各自验证 | 各自回滚 | 无 |

各阶段顺序上的硬约束：

- 先 P1（新域名验通），后发「默认地址 = 新域名」的 CLI。
- 先让大多数机器升到含别名组的 CLI，后开 `MIGRATION_*`。否则回退 CLI 会让已经跟过去的机器凭据失效（`authServerUrl=vibe` 不在旧版的认可列表里）。
- 旧 host 的 API 至少要保留到 P5。

### 4.1 已装机器的 settings 怎么迁

CLI 选 server 的顺序是 env `HAPPY_SERVER_URL` → `~/.happy/settings.json` 的 `serverUrl` → 版本内的默认值（`configuration.ts:45-58,99-115`）。多数机器的 settings 不写 URL，跟随默认值。

| 机器状况 | 怎么到新域名 | 需要手动 |
|---|---|---|
| ≥0.2.178，没有 env 钉住，P2 期间在线 | `server-migrate` 自动改写 settings 与 `access.key`（`daemon/serverMigration.ts:82`），之后不再受 CLI 默认值影响 | 否 |
| 升到 P2 的新 CLI，没有收到通知（例如离线） | 默认地址已是新域名，旧凭据靠别名组照常可用；daemon 发现 serverUrl 变了会自动重启（`ensureDaemonRunning.ts:14-27`） | 否 |
| <0.2.178（7 台），没有 env | 旧 host 的 API 继续可用；它们会被 auto-update 升级，升级后进入上一行 | 否（只是更晚） |
| env 钉住 `HAPPY_SERVER_URL=https://veryhappy.dev` | 通知被拒并写日志（`serverMigration.ts:58`） | 是：改 env，然后 `very-happy daemon start`；P4 按指标点名 |
| 团队 worker 的 scope 文件里存了 `serverUrl`（`daemon/teams/worker.ts:177`） | 新建的 worker 用新地址；存量 worker 在会话重启前留在旧 host | 否 |

## 5. 方案 A vs 方案 B（Owner 的「旧站直接挂升级中」）

| | 方案 A：通知 → veryhappy.dev 整站「升级中」→ 大家去 vibe | 方案 B（推荐）：新域名先作别名 → 机器自动跟随 → 网页切换（旧站 drain 后 301）→ 旧 API 保留到归零 |
|---|---|---|
| 技术前提 | 同 B 的 P1（新域名必须先可用） | 同上 |
| 网页用户感知 | 打开旧站看到「升级中」，手动去新站并重新登录 | 打开旧站自动去新站的同一路径，重新登录一次 |
| 网页停机 | 0（新站已可用） | 0 |
| **daemon / 机器** | **98 台 daemon 同时断线**（socket 和 API 都在旧 host）：团队、自动化、运行中会话全部离线，手机上看不到；**auto-update 也打不到**（`/v1/version/cli` 在旧 host），只能每台手动执行：`npm i -g … very-happy-cli@<含新默认值和别名组的版本> && very-happy daemon start`。新 CLI 没有别名组时还要再执行 `auth login --force` 并在网页确认 | 0 台需要手动（除了 env 钉住的机器）；≥0.2.178 的 91 台自动跟随，7 台老版本由 auto-update 带过去 |
| 机器停机时长 | 从挂牌到每位机主手动处理完：按以往的通知经验，至少几小时到几天，假期中的机器不确定 | 0（daemon 交接与 CLI 升级相同，正在跑的轮次不会被打断） |
| 已发出的分享链接、Tanka 通知链接、PWA | 全部指向「升级中」页面，失效（除非额外给 `/s/` 做 301） | 301 到同路径，fragment 保留，继续可用 |
| 未发出的消息 | 旧站一挂牌就发不出去，丢失 | drain 页发完再跳 |
| 回滚 | 撤掉挂牌即恢复（快）；但已经手动改过的机器不受影响，不需要回滚 | 每一步都可以独立回滚（§4） |
| 工作量 | 少一个 drain 页和别名模式（约 0.5 天）；把成本转嫁给 98 台机器的主人 | P0 约 1.5–2 天开发 + L2 QA |
| 「干净」 | 旧域名立刻不再服务 | 旧域名对人立刻「消失」（网页 301）；只有 API 在后台再服务 ≥90 天，靠指标决定关闭时间 |

结论：停机不能让迁移更快，也不能让它更安全，因为两种方案的数据都在同一个库里。方案 A 节省的半天开发，换来的是全员机器断线和逐台手动修复。方案 B 已经包含 A 想要的用户体验（通知 → 统一去新站）。

### 5.1 旧域名剩余流量怎么看（决定何时下线）

- P0 新增 Prometheus 计数：`vh_http_requests_by_host_total{host="old|new|legacy",client="web|cli-daemon|cli|agent|other"}`，以及 socket 握手 `vh_socket_connects_by_host_total{host,client}`。client 来自握手里自报的 `happyClient`（现有字段，见 operations「Which CLI version」）和 UA 粗分。Grafana 加一个面板。
- 机器级别：P0 在 `Machine` 上加一个可空列 `lastConnectHost`（只在变化时写，参照 `lastHappyClient` 的做法），这样能列出「还在旧 host 上的机器 → 账号」，逐个通知。这一项涉及存储语义，属于 L2，也可以只靠日志 grep 代替（成本更低，精度也够），交给 Owner 选（§9 Q7）。

## 6. 范围选项（每项附推荐和代价）

| # | 选项 | 推荐 | 代价 / 理由 |
|---|---|---|---|
| Q1 | 只换主域名，还是连同 relay-us（个人 VPS）、admin（Cloudflare Access）、GitHub/npm 一起迁 | **本轮只换主域名**；relay-us 迁到公司 AWS 另开一项（例如 B-903b，与 relay 改名 `relay-*.vibe.apodex.site` 一起做）；admin 改走公司 Authentik 另开一项；GitHub/npm 不动 | relay 和 admin 用户看不到，绑在一起只会拉长关键路径；但 relay-us 在个人 VPS 上仍是「隐患」，要排期而不是忘掉 |
| Q2 | 旧域名留多久 | **API ≥90 天，并且连续 14 天流量≈0 再停（P5）；域名注册和 Cloudflare zone 至少保留 2 年，最好转到公司名下** | 域名一旦过期被抢注，老 CLI 和 env 钉住的机器会把 bearer token 发给新持有人：这是安全问题，不只是可用性问题 |
| Q3 | 公开访问还是 IP 白名单 | **公开** | 手机、家庭网络、云上开发机、Tanka webhook、分享链接都要从任意 IP 访问；目前的防护是 CloudFront + 源站密钥头（`X-Origin-Verify`）+ 限流 + 登录。可选：之后给 CloudFront 加 AWS WAF 托管规则（现在没有 WAF），按请求量计费，单独评估 |
| Q4 | 非 apodex.com 邮箱的账号（gmail 32、其他 6、无邮箱 11）怎么办 | **照常迁移，不区分**：同一个库，所有账号自然都在新域名上，只需要中英双语通知 | 如果公司要求「公司域名只给公司人用」，那是另一个项目（注册策略 / 分库），和换域名无关，不应该绑在一起 |
| Q5 | 登录邮件发件域（现在是 `login@veryhappy.dev`，通过个人 Cloudflare Email 发送） | **本轮不动**；P5 之前换成公司域（例如 `login@vibe.apodex.site`，经 Resend 或 SES，DKIM/SPF 写 Route53） | 旧域名下线时如果忘了这一项，邮箱登录（72 个身份）会整体失效 |
| Q6 | 网页是否开 B-627 handoff（旧站一键免登录跳到新站） | **不开**，只开 daemon 通知 | 免登录的代价是一张一次性登录票放在 URL 里；活跃账号都能重新登录，收益很小 |
| Q7 | 机器级剩余流量用 DB 列（`lastConnectHost`）还是日志 | **先用指标 + 日志**，不加列 | 少一次迁移；P4 只有十来台残余机器时，日志就够了 |

## 7. 兼容矩阵

| 组合 | 结果 |
|---|---|
| 旧 Web bundle × 新 server | 忽略 `canonicalOrigin`，行为不变 |
| 旧 CLI（<P0 别名组）× 旧 host | 照常（P5 之前） |
| 旧 CLI × 收到 `server-migrate`（≥0.2.178） | 跟到新 host，凭据改写为 `authServerUrl=vibe`；**之后不能再降级到不含别名组的版本** |
| 新 CLI × 旧凭据（`authServerUrl=veryhappy.dev`）× 新默认值 | 别名组放行 |
| 新 CLI × 自建实例 | 不在别名组内，仍然 fail-closed（不放宽） |
| <0.2.178 daemon | 忽略 `server-migrate`，留在旧 host，由 auto-update 带到新版 |

发布顺序：P0 只含别名组的 CLI → server/Web（P1） → 默认地址 CLI 与 `MIGRATION_*`（P2） → Web 切换（P3）。

## 8. 用户通知稿（发送由 Owner 确认）

时间：P3 当天 11:00 发版班次之后；P3 执行前 1 天在 Coding Agent 群预告一次（可选）。渠道：Coding Agent 群（Tanka）、站内更新通知（`CHANGELOG_RELEASES`，web 条目），以及 README 顶部一行。

中文：

> **Very Happy 换地址了：vibe.apodex.site**
> 从今天起，请用 https://vibe.apodex.site 打开 Very Happy（原 veryhappy.dev 会自动跳转过去）。账号、会话、机器都不变，**重新登录一次就行**。
> - 电脑上的 daemon 会自动切过去，不用手动操作；
> - 手机或浏览器的通知需要在新地址重新开启一次；装过 App 图标的请从新地址重新「添加到主屏幕」；
> - 以前发出的分享链接照常可用。
> 有问题在群里 @我。

English:

> **Very Happy has moved to vibe.apodex.site**
> Starting today, open Very Happy at https://vibe.apodex.site (veryhappy.dev redirects there). Your account, sessions and machines are unchanged — **just sign in once**.
> - Your daemons switch over automatically; nothing to run.
> - Turn notifications on again at the new address, and re-add the home-screen app if you installed it.
> - Share links you sent earlier keep working.
> Questions? Ping me in this group.

## 9. 需要 Owner 拍板

1. **方案 B 还是方案 A？** 推荐 B（§5）：用户体验和 A 一样是「通知 → 去新站」，但 98 台机器不用断线，也不用手动处理。
2. **范围**：推荐本轮只换主域名；relay-us 上公司资源、admin 改 Authentik 各开一项排期（Q1）。
3. **旧域名**：推荐 API 保留 ≥90 天且连续 14 天流量≈0 再停；域名注册与 zone 保留 ≥2 年，转到公司名下（Q2）。
4. **访问方式**：推荐公开访问，不加 IP 白名单（Q3）。
5. **非 apodex 账号**：推荐照常迁移，不区分，中英双语通知（Q4）。
6. **发件域**：推荐本轮不动，P5 之前换成公司域（Q5）。
7. **网页免登录 handoff**：推荐不开（Q6）。
8. **剩余流量统计**：推荐用指标 + 日志，不加 DB 列（Q7）。
9. **通知**：§8 的中英文稿，以及发送时间和渠道。

## 附录：复核 SQL（只读事务；时间列是 UTC，换算 SGT 用 `+ interval '8 hours'`）

```sql
BEGIN READ ONLY;
-- 7 天在线 daemon 版本分布
SELECT split_part(coalesce("lastHappyClient",'(null)'),' ',1) client, count(*)
FROM "Machine" WHERE "lastActiveAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;
-- 服务端没有密钥副本、换源后无法恢复的账号
SELECT a.id FROM "Account" a
WHERE NOT EXISTS (SELECT 1 FROM "AccountSecret" s WHERE s."accountId"=a.id)
  AND NOT EXISTS (SELECT 1 FROM "AccountCredential" c WHERE c."accountId"=a.id);
-- 有机器活跃、但没有任何登录方式的账号
SELECT a.id FROM "Account" a
WHERE EXISTS (SELECT 1 FROM "Machine" m WHERE m."accountId"=a.id AND m."lastActiveAt" > now()-interval '30 days')
  AND NOT EXISTS (SELECT 1 FROM "AccountIdentity" i WHERE i."accountId"=a.id)
  AND NOT EXISTS (SELECT 1 FROM "AccountCredential" c WHERE c."accountId"=a.id AND c."passwordHash" IS NOT NULL);
ROLLBACK;
```
