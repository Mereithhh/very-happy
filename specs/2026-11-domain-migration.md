# 拆成两套部署：公共版 veryhappy.dev + 公司内部版 vibe.apodex.site（B-903）

> 状态：Draft（方案先行，待 Owner 拍板 §10；本 PR 只改文档，不改 DNS / AWS / Cloudflare / 生产，不发版）
> 日期：2026-11-09 ｜ 关联 backlog：B-903 ｜ 复用：B-627（旧站横幅 + 签名 handoff + daemon 通知）、B-635（daemon 跟随）、B-636（`rekey` / `prune-accounts`）、B-624/637/638（白标）
> 方向（Owner 11-09，经 Lead 转达）：veryhappy.dev 继续作为对外公共服务，**不关闭**；公司内部另起一套独立实例 vibe.apodex.site，公司用户迁过去。上一版「同库换域名」的方案已作废。
> 附件：[`2026-11-domain-migration.refs.tsv`](2026-11-domain-migration.refs.tsv)，写死域名的引用清单，列为文件、行、类别、改法（改法按本版重写）

## 0. 结论

- **内部版按同一镜像独立部署**：同在公司 AWS `422653419554` 的 ap-southeast-1，新建一台主机（复用 vh-sg 的蓝绿 + Caddy + PgBouncer 布局），配独立的 RDS、ElastiCache 和 CloudFront。内部版先不建自己的 relay。DB、Redis、`HANDY_MASTER_SECRET`、`RELAY_TOKEN_SECRET` 都不和公共版共享。两套用同一个 SHA 发布，内部版先发，相当于公共版的金丝雀，canary 和回滚各自独立（§2）。
- **数据要迁，不从零开始。** B-627/635/636 的整套工具已经发布：整库复制，`rekey` 换主密钥，`prune-accounts` 只留迁移名单。之后旧站给名单内账号显示横幅，用一次性签名 handoff 加公司 SSO 认领账号；daemon 收到 `server-migrate` 后自动改指向。服务端可恢复账号密钥，会话内容用账号自己的密钥加密，`rekey` 不碰，所以在新 server 上能照常解密（§4，已核代码）。
- **迁移名单 = apodex.com 的 62 个账号 + 自报名并经公司 SSO 证明的人。** 不猜，名单不进 repo（§3）。
- **公共版外部用户完全无感**：同一镜像，只多了几个 env；他们不在名单里，横幅和通知都不会触发。
- **Owner 的「群里通知 + 直接切」在 §5 评估**：对网页可行（横幅设为不可关）；但不能在旧站直接封掉公司账号，否则 daemon 收不到跟随通知（公司账号在 7 天内在线的机器有 70 台），也拿不到更新。推荐做法是「通知 → 复制 → 横幅加 daemon 自动跟随 → 30 天后在公共版删除已迁账号」。
- **访问方式推荐公网开放 + 只允许公司 SSO 登录**，不加 IP 白名单：手机、外出、家里或云上的 daemon 都要能连（§6）。

## 1. 现状事实（只读取证，2026-11-09）

| 项 | 事实 | 来源 |
|---|---|---|
| 公共版拓扑 | vh-sg（`m6i.xlarge`，VPC `vh-vpc` 10.1.0.0/16）、RDS `vh-pg`（`db.m7g.large`，100 GB）、ElastiCache `vh-redis`（`cache.m7g.large`）、CloudFront `E2JUP4WHDXD8HU`（别名 `veryhappy.dev`、`cf-test.veryhappy.dev`，ACM us-east-1，Host 原样回源，没有 WAF）；DNS 在个人 Cloudflare | `aws` 只读；`docs/operations.md` |
| 库大小 | 8.4 GB（`pg_database_size`，包含膨胀；09-07 那次 330 MB 的 dump+restore 用了约 21 s） | 只读 SQL |
| apodex.site | 公司 Route53 zone `Z04787629I6U1OS0O0R0`（ExternalDNS `owner=main-eks` 也在写）；`vibe.apodex.site` 不存在；`vibe-test.apodex.site` 是 EKS us-west-2 `shared/very-happy-test`：standalone PGlite，白标，OIDC（secret 键有 `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/ALLOWED_EMAIL_DOMAINS`、`HANDY_MASTER_SECRET`、`MIGRATION_HANDOFF_SECRET`；值没读），镜像 `staging-039755e-20261019`，单副本 | `aws route53`；`kubectl -n shared`（只读键名） |
| 公共版生产 env（只看有没有、含哪个域名） | `PUBLIC_URL`、`HAPPY_WEB_URL` 含 veryhappy.dev；`GOOGLE_ALLOWED_ORIGINS` 两项；`AUTH_EMAIL_PROVIDER=cloudflare`，发件人在 veryhappy.dev；`HAPPY_RELAYS_JSON` 指向 relay-sg/relay-us.veryhappy.dev；没有 `OIDC_*`，也没有 `MIGRATION_*` | vh-sg `/opt/happy/.env` 键名 |
| 账号 | 共 103 个；有 apodex.com 身份邮箱的 62 个（7 天内有机器在线的 35 个，在线机器 70 台）；7 天内有机器在线的账号一共 45 个，其中 10 个不是 apodex.com | 只读 SQL |
| daemon 版本（7 天在线 98 台） | ≥0.2.178（能自动跟随）91 台；<0.2.178 的 7 台（最老 0.2.99） | `Machine.lastHappyClient` |
| 登录方式 | 30 天活跃的 57 个账号都有可用的登录方式；身份记录：email 72、google 29、password 11 | 只读 SQL |
| 跨两边的关系（公司邮箱 ↔ 非公司邮箱；非公司邮箱那一方也可能是同事本人） | 未撤销的终端授权 6 条、项目授权 1 条，**全部跨边**；会话授权 1 条，不跨边；好友关系 0；未过期的公开分享链接 2 条，都是公司账号创建的 | 只读 SQL |
| Web Push | `webpush:` 订阅 52 条，属于 25 个账号 | 只读 SQL |

## 2. 部署形态

### 2.1 放在哪（Owner 定）

| 选项 | 内容 | 优点 | 代价 |
|---|---|---|---|
| **D1 公司账号 / ap-southeast-1 / 复用 `vh-vpc`，用独立子网与安全组（推荐）** | 新 EC2 `vh-int`，布局照抄 vh-sg（Caddy、蓝绿槽、PgBouncer）；新 RDS `vh-int-pg`；新 ElastiCache `vh-int-redis`；新 CloudFront 分发，别名 `vibe.apodex.site` | 用户大多在新加坡和中国，延迟与现在相同；部署脚本、runbook、监控都能直接复用，只是参数化；两套的故障域独立（主机、库、缓存、边缘全分开） | 每月多一套资源费用（§2.4）；VPC 共用，网络层隔离靠安全组 |
| D2 公司账号 / ap-southeast-1 / 新 VPC | 和 D1 相同，只是 VPC 也新建 | 网络完全隔离 | 多建一套 NAT/子网/路由，NAT 网关每月约 $30–45，运维面更大 |
| D3 main-eks（us-west-2，vibe-test 所在） | 把 vibe-test 升级成正式实例，ArgoCD 部署，外加 RDS/ElastiCache | 符合公司的 k8s 惯例，有 ExternalDNS 和 ALB | 新加坡到美西的 RTT 约 170 ms，终端打字体感明显变差；standalone PGlite 不能直接用于生产，还是要上 RDS；**发布机制变成两套**（ArgoCD 与蓝绿脚本），蓝绿的 drain 和 make-before-break handover 在 k8s 里没有对应实现 |
| D4 和公共版同一台 vh-sg，第二对槽位 | 同机再起两个槽位，连另一个库 | 最省钱 | 故障域耦合（主机、Caddy、磁盘），和「独立实例」的诉求相反，不推荐 |

### 2.2 共享与独立

| 资源 | 推荐 | 理由 |
|---|---|---|
| DB / Redis | **独立** | 两边账号集合不同，最后各自 prune；socket.io Redis 适配器如果共享，会让两边互相广播 |
| `HANDY_MASTER_SECRET` | **独立**（复制后跑 `rekey`） | 一边泄露不影响另一边；`rekey` 是现成工具，副作用只是所有人重新登录一次，而换源本来就要重新登录 |
| relay | **内部版先不配 `HAPPY_RELAYS_JSON`**（走 control 直连兼容路径，`docs/operations.md`「Regional relay rollout」的回滚态就是这样） | relay 共享就得共享 `RELAY_TOKEN_SECRET`，两边信任会耦合；内部用户 ≤70 台机器，控制面直连够用；以后需要再给内部版单独建 relay-sg（D1 同 VPC） |
| 镜像 | **共享**（同一个 `ghcr.io/mereithhh/very-happy-server@sha256:…`） | 一份代码；差异全部写在 env 里（§7） |
| CLI npm 包 | **共享** `very-happy-cli` | 默认地址保持 veryhappy.dev；内部机器靠 `settings.serverUrl` 指向内部版（§5.2） |
| 登录 | 内部版用 **OIDC（公司 SSO）**，`OIDC_ALLOWED_EMAIL_DOMAINS=apodex.com`、`OIDC_SIGNUP_MODE=open`；其他注册方式 `SIGNUP_MODE=closed`；邮箱/Google 登录只保留给迁移过来的老账号（见 §6） | 新同事自助注册；外部人进不来 |
| 发件 | 内部版若保留邮箱验证码登录，要换成公司域的发件人（Resend/SES，DKIM 写 Route53）；只用 SSO 时可以不配 | 公共版的发件域在个人 Cloudflare |
| 字体 CDN | CSP 写死 `veryhappy-fonts.pages.dev`（`securityHeaders.ts:31`，个人 Cloudflare Pages）。两套都依赖它，可以改成镜像内自带字体 | 「个人资源隐患」中的一个，不阻塞 |

### 2.3 发版流程

- **一个 SHA，两个 ring**：同一镜像 digest 先 `deploy instance=internal`，canary + 观察 30 分钟（公司同事等于内测），再 `instance=public`。任何一边失败，只回滚那一边，状态写在各自主机的 `/opt/happy/release/state.env`。
- `deploy-hwsg.yml` 加 `instance: internal|public` 输入，并分 GitHub Environment（`production-public` / `production-internal`），各自有 SSH 主机、key 和 `PUBLIC_ORIGIN`；`deploy-blue-green-remote.sh:18`、`deploy-server-remote.sh:31` 的 `PUBLIC_ORIGIN` 改成从参数读取；`check-release.mjs --live`、`check-shipped.mjs --origin`、`e2e-smoke`、`advance-auto-update.sh`、`check-recommended.mjs` 都按 instance 各跑一次。
- **CLI 自动更新各自独立**：`/v1/version/cli` 读每个实例自己的 `CLI_AUTO_UPDATE_VERSION`，内部版可以先跟 `latest`，公共版晚一个班次。npm 的 `next → latest` promote 门禁不变。
- **迁移（schema）**：同一镜像带同一套 Prisma 迁移；`VH_RELEASE_MIGRATIONS_REVIEWED` 在两台主机上各确认一次。
- release skill、operations runbook 增加「两套」章节：发布顺序、失败只回滚单边、两边的 health/资源检查都要绿，整次发版才算完成。
- 监控：Prometheus 加 `instance=internal|public` 标签，Grafana 两套面板。

### 2.4 成本粗估（ap-southeast-1 按需价，USD/月，**执行前用 AWS Pricing Calculator 复核**）

| 档位 | EC2 | RDS（+gp3 50–100 GB） | ElastiCache | CloudFront/EIP/备份 | 合计 |
|---|---|---|---|---|---|
| 小（推荐起步，用户约 60 人） | m6i.large ≈ 90 | db.t4g.medium ≈ 60–70 | cache.t4g.small ≈ 25 | ≈ 15–30 | **≈ 190–215** |
| 与公共版对齐 | m6i.xlarge ≈ 175 | db.m7g.large ≈ 165–175 | cache.m7g.large ≈ 150 | ≈ 15–30 | **≈ 505–530** |

公共版迁走约 60% 的活跃机器后，它的 RDS/Redis 档位可以评估降档，抵掉一部分新增成本（Q9）。

## 3. 谁迁过去（迁移名单）

1. **apodex.com 的 62 个账号**：有 provider 验证过的 email、Google 或 OIDC 身份邮箱，用 `MIGRATION_EMAIL_DOMAINS=apodex.com` 定位（`targeting.ts:12-20`；纯密码身份没有邮箱，不会命中）。
2. **gmail / 其他 / 无邮箱的 49 个账号里的同事**：不猜，用「自报名 + 公司 SSO 证明」：
   - 公共版加一个设置项「我是 Apodex 同事，迁到内部版」（只在配置了 `MIGRATION_TARGET_URL` 时显示，外部部署看不到）。点击后走 handoff，到内部版用**公司 SSO 登录**完成认领（B-627 的 OIDC 认领：把 `oidc:<issuer>+sub` 挂到复制过来的同 id 账号上）。SSO 只放 apodex.com，所以外部人无法冒认。
   - 名单的辅助核对：Owner 或 Lead 在本机把这 49 个账号的身份邮箱和公司通讯录（Authentik / Tanka 目录）比对，**结果只存在运维主机或 `~/code/github/skills/tmp/`，不进 repo、不进 PR、不进 spec**；比对只用来「提醒这些人报名」，最后的依据是本人用 SSO 认领。
   - 报名窗口必须在**复制时刻 T 之前**关闭：复制只带 T 时名单里的账号（`prune-accounts --keep-file`）。T 之后才报名的人只能在内部版重新开始（没有单账号导出导入，见 §4.4）。
3. 同一个人如果在公共版有两个账号（公司邮箱一个、gmail 一个），各自独立迁移或不迁，**不合并**（`docs/deployment.md`：不按邮箱字符串合并身份）。

## 4. 数据

### 4.1 推荐：迁历史（整库复制 → 换密钥 → 只留名单）

全部用现成工具（`docs/deployment.md`「Moving everyone to another relay (B-627)」）：

1. T 时刻：公共版 RDS 做快照，从快照恢复一个临时实例，`pg_dump -Fc` 后 `pg_restore` 到 `vh-int-pg`。不在生产主库上长事务 dump；快照恢复不影响线上。
2. `happy-server rekey`（`OLD_HANDY_MASTER_SECRET` → 新 `HANDY_MASTER_SECRET`，先 dry run 再 `--apply`）：重新包裹 `AccountSecret`、`AccountCredential`、GitHub/vendor token 和 team 凭据，丢弃旧的登录会话和 OIDC 行（`migration/rekey.ts:1-17`）。
3. `happy-server prune-accounts --keep-file ids.txt`（先 dry run）：沿真实外键图删掉名单外的账号及其所有行（`migration/prune.ts`）。dry run 报告要逐表核对行数。
4. 内部版起服务、内测通过后，公共版开 `MIGRATION_*`（§5）。
5. **T+30 天**：已迁账号的 daemon 流量归零后，在公共版对「已迁名单」做反向 prune（keep-file = 未迁账号），公司数据从公共实例删除。先确认公共版那次快照可以恢复。

可以迁过去的：账号与密钥、会话和消息、项目、团队与 bot 凭据、自动化、issue、机器记录、KV（笔记、草稿、看板）、附件记录。附件文件实体如果在对象存储，`UploadedFile` 指向的存储要一起复制（P0 核实生产附件后端，§8 P0）。

### 4.2 加密数据能否在新 server 上解密（已核）

- 信任模型是 server-trusted，服务端能恢复账号密钥（`docs/operations.md` Topology 段）。账号 secret 存在 `AccountSecret.secretEnc`，用 `HANDY_MASTER_SECRET` 包裹（`accountSecrets.ts:4-34`）；`rekey` 会重新包裹它。
- 会话、消息、机器 metadata 和 data key 用**账号自己的密钥**加密，`rekey` 不碰（`rekey.ts:14-15`）；Web 的数据密钥由账号 secret 派生（`encryptor.ts:51-54`）。所以重新登录、拿到 secret 之后，历史可以照常解密。
- 换主密钥后，登录会话全部失效（`rekey` 主动丢弃），在内部版一律重新登录，和换源的要求一致。
- 例外：「服务端没有密钥副本」的账号整个库里只有 1 个，6 月起不活跃。T 之前用附录 SQL 复查名单内是否有这类账号。

### 4.3 跨两边的东西会断

| 关系 | 现量 | 处理 |
|---|---|---|
| 终端授权、项目授权（公司账号 ↔ 非公司邮箱） | 6 + 1 | prune 会在每一边删掉指向对方账号的行，授权就此结束。T 前把清单（只给 Owner）发给授权的发起人：对方若是同事本人的 gmail 账号，先报名迁移，授权就能保留 |
| 公开分享链接 `/s/<id>#secret` | 2 条有效，都由公司账号创建 | 公共版上的链接在反向 prune 之前一直可用；之后失效。链接所有人在内部版重新生成。内部版的分享链接默认要求 SSO 才能访问，这一点 Q6 定 |
| 会话授权、好友关系 | 不跨边 | 无 |
| 团队里的 bot | 属于账号本身 | 随账号走 |

### 4.4 备选：新起步（不迁历史）

内部版是空库，同事直接 SSO 注册，机器重新配对，公共版上的旧账号原样留着或由本人删除。省掉复制、rekey、prune 和反向 prune，但会话历史、自动化、团队、issue、笔记全部要手工重建，70 台机器每台都要手动重新配对。**不推荐**，只适合「内部版完全做成新产品、不需要历史」的情况。

按单账号导出导入（在已上线的内部库里合并一个账号）目前没有工具，外键图合并和 id 冲突的风险高，**不推荐**。T 之后才来的同事按 §4.4 新起步。

### 4.5 迁移窗口里的 daemon 与 outbox

- **T 之后、跟随之前写入公共版的数据，不会出现在内部版**（复制是快照）。缩小这段缺口：
  - T 放在低峰（例如周六 22:00 SGT），提前 1 天通知「请在 T 前结束正在跑的轮次」；
  - 复制完成后几分钟内开启 `MIGRATION_*`。daemon 重连后收到 `server-migrate`，在没有进行中的轮次时交接到内部版（B-635）；
  - 已经在跑的 session wrapper 会留在公共版，直到会话重启（铁律：handover 不热替换存量 wrapper）。这些会话在 T 之后的消息只在公共版，可以继续在公共版查看，到反向 prune 为止。通知里写明：「迁移后在内部版对正在用的会话点一次『重启会话』」。Claude/Codex 的本地 transcript 是完整的，重启后上下文不丢，只是 Web 上缺这段消息。
- **网页 outbox**：横幅点击前，旧 origin 的 IndexedDB outbox 会照常发到公共版（API 还在），也就是落在缺口里。横幅按钮在跳转前先等 outbox、排队消息、待建会话都清空（最多 15 s，剩下的列给用户看），然后退订本 origin 的 Web Push 并删除推送 token，以免公共版继续给迁走的人发重复通知。这些都在旧 origin 内完成，**不向新 origin 传任何本地数据或密钥**；新 origin 靠重新登录从服务端拿 secret。
- 自动化由 daemon 认领（`AutomationClaimCursor`），一台 daemon 只连一边，理论上不会双跑。P0 要用测试确认，并确认公共版对已迁账号的服务端定时逻辑（如果有）不会继续触发（§8 P0）。

## 5. 迁移操作

### 5.1 推荐流程与 Owner 的「群里通知 + 直接切」

| 步骤 | 推荐 | 「直接切」（在 T 时刻于公共版封掉公司账号） |
|---|---|---|
| 通知 | T−3 天群通知 + 报名窗口；T−1 天提醒 | 同 |
| 网页 | T 后横幅（`GET /v1/migration`）；3 天后改成**不可关闭**的整页提示（新代码：`MIGRATION_ENFORCE_AFTER`）；点击即 handoff 并 SSO 认领 | 网页直接显示「请到 vibe.apodex.site」，不能再用公共版。体验和推荐方案第 3 天之后相同 |
| daemon | 在线即收到 `server-migrate`，自动跟随；离线的机器上线时再跟 | **公司账号的 socket 被拒绝，`server-migrate` 发不出去**：70 台机器全部要手动改（§5.2），<0.2.178 的机器也拿不到自动更新 |
| 停机 | 0 | 每台机器从封号到机主手动处理完这段时间内断线；团队、自动化、手机都看不到 |
| 回滚 | 关掉 `MIGRATION_*` 后 switch；已跟过去的机器留在内部版（两边独立，不需要回迁）；内部版出问题时，机器可以用同一套 handoff 再「跟回」公共版（反向配置 `MIGRATION_*`，前提是还没做反向 prune） | 解封即恢复，但手动改过的机器要再手动改回来 |

结论：「直接切」对**人**可行（第 3 天起不可关闭的提示就是直接切）；对**机器**不可行，要让旧站继续服务公司账号的 API 和 socket，直到 daemon 跟随完。推荐「通知 → T 复制 → 横幅加自动跟随 → 第 3 天强制提示 → T+30 天反向 prune」。

### 5.2 已装机器怎么改指向

CLI 选择 server 的顺序：env `HAPPY_SERVER_URL` → `~/.happy/settings.json` 的 `serverUrl` → 内置默认值 `https://veryhappy.dev`（`configuration.ts:14,45-58,99-115`）。凭据带着 `authServerUrl`，与配置不一致时 fail-closed（`ui/authRelay.ts:13-31`、`persistence.ts:451-479`）。内部版对 CLI 来说就是「自建实例」，这条规则保持不变。

| 机器状况 | 怎么到内部版 | 要手动吗 |
|---|---|---|
| 公司账号，CLI ≥0.2.178，没有用 env 钉住，T 之后上线 | `server-migrate` → 在内部版用 handoff 换 machine token → 改写 `settings.serverUrl/webappUrl` 和 `access.key`（`daemon/serverMigration.ts:52-85`），之后不再跟随 CLI 默认值 | 否 |
| CLI <0.2.178 | 先被公共版的 auto-update 升级，再进入上一行 | 否（只是晚一些） |
| env 钉住 `HAPPY_SERVER_URL` | 通知被拒并写日志（`serverMigration.ts:58`） | 是：改 env 后执行 `very-happy daemon start` |
| 新机器（内部同事） | 内部版首台机器引导给出命令（§7 第 4 行改造后），安装脚本带参数：`curl -fsSL https://vibe.apodex.site/install.sh \| sh -s -- --server https://vibe.apodex.site`，写入 settings，再 `very-happy auth login` | 一条命令 |
| 想手动切换的已装机器 | **新增** `very-happy server use <origin>`（P0）：校验 `/health`，写 `settings.serverUrl/webappUrl`，提示 `very-happy auth login --force` 在新站配对，然后 `daemon start` 接管。现在的 `very-happy server` 是本地自建命令，不能用于这个场景 | 一条命令 + 网页确认 |

### 5.3 网页

- 换源要重新登录：内部版用公司 SSO；迁过来的老账号也可以继续用原来的邮箱或 Google 登录（Q5）。localStorage 里的本机偏好、未发出的输入、Web Push 订阅、PWA 安装都按 origin 隔离，不会带过去（代码位置：`tokenStorage.ts:4`、`outboxStore.ts:36-59`、`persistence.ts`、`webPush.ts:57-88`、`vite.config.ts:32-46`）。新站首次登录后提示「重新开启通知」和「重新安装 App」。
- 公共版的横幅、强制提示、设置项「我是同事」只对名单内或自报名的账号出现。**外部用户看不到任何变化**：同一个镜像，`MIGRATION_*` 只在公共版的 env 里，并且只按名单生效。

## 6. 内部版的访问方式

| 选项 | 手机 / 外出 | daemon | 推荐 |
|---|---|---|---|
| **公网 + 只允许公司 SSO 登录（推荐）** | 正常 | 家里、云上、出差都能连 | ✔ 登录面只有 SSO（新注册），老账号可保留邮箱/Google（Q5）；CloudFront + 源站密钥头 + 限流；可选加 AWS WAF 托管规则 |
| IP 白名单（.site 惯例） | 离开办公网就不能用；手机流量不能用 | 家里、云上、出差的 daemon 全断 | ✘ 与「手机随时看 agent」的核心用法冲突 |
| 公司 VPN（飞连）+ 白名单 | 手机要常开 VPN；后台推送点进来时 VPN 可能没连上 | 每台 daemon 主机都要常驻 VPN 客户端；云上开发机要单独放行 | ✘ 运维成本高，体验差 |

`.site` 惯例的白名单在这里不适用的理由：Very Happy 的价值在于「随时随地接管自己的 agent」，daemon 运行在任意网络上，主动连 server，server 必须能从公网访问。安全由「只有公司 SSO 能登录 + 服务端信任模型 + 限流」保证，而不是靠网络边界。

## 7. 代码改动：一份代码、两套部署（P0）

原则：**server 不写死域名**（CORS `*`、CSP 按请求 Host 推导、不用 cookie；`securityHeaders.ts`、`requestOrigin.ts`、`api.ts:93`）。需要改的都在「把云端 origin 写死」的地方，改成从部署配置读取（`__HAPPY_CONFIG__`、env）。逐行清单见 refs.tsv。

| 位置 | 现状 | 改法 |
|---|---|---|
| server env（不改代码，两套各配一份） | — | 内部版：`PUBLIC_URL` 不设（same-origin）或设为 `https://vibe.apodex.site`；`OIDC_*`，回调 `https://vibe.apodex.site/v1/auth/oidc/callback` 在 IdP 登记；`HAPPY_WEB_URL`；`MIGRATION_HANDOFF_SECRET`；`BRAND_*`、`WEB_LANDING=off`；不设 `HAPPY_RELAYS_JSON`。公共版：加 `MIGRATION_TARGET_URL/WEBAPP_URL/NAME/EMAIL_DOMAINS/HANDOFF_SECRET`，其余不变 |
| server 迁移源（B-627 扩展） | 只按 id 或邮箱域定位；横幅可关闭 | ① 自报名：`POST /v1/migration/opt-in`，只是把账号写入「意向表」，T 时导出给 keep-file（真正的认领仍靠 SSO）；② `MIGRATION_ENFORCE_AFTER` 用于强制提示；③ T 之后才报名的账号，`/v1/migration` 返回「新起步」说明，不发 handoff |
| CLI | `DEFAULT_RELAY_URL='https://veryhappy.dev'` | **保持不变**（公共版默认）；新增 `very-happy server use <origin>`；`install.sh` 支持 `--server <origin>`（写 settings），`HAPPY_SERVER_URL/HAPPY_WEBAPP_URL` 的 env 用法保留 |
| Web 首台机器引导 `firstMachineCommands.ts:1,8` | 写死 `CLOUD_ORIGIN`，在内部版会被当成自建，给出 `HAPPY_HOME_DIR=~/.very-happy-…` 的第二身份命令 | 改为读 `__HAPPY_CONFIG__.installOrigin`（server 注入，默认当前 origin），统一生成 `install.sh --server` 命令；不再假定「非 veryhappy.dev 就是自建」 |
| Web 构建常量 | `vite.config.ts:13` 默认 server；`index.html:26` og:image；`relayLabel.ts:9` 按 host 判断 SG；`SkillDocumentLink.tsx:16` | 默认 server 保持公共版（只作兜底，运行时以注入为准）；og:image 已由 server 改写成当前 origin（`htmlConfigInjection.ts:44`），把模板里的值改成相对路径；`relayLabel` 改用 `/v1/relays` 返回的 region，没有 relay 时显示 control 的 region |
| 安装脚本 `public/install.sh:121,178` | 默认 `WEB_URL` 和安全文档链接是 veryhappy.dev | 由 server 在下发时把 `{{ORIGIN}}` 替换成当前 origin（或者脚本优先用 `--server`） |
| 分享链接 | 已经按 `location.origin` 生成（`apiSessionShares.ts:127`） | 不改 |
| 更新说明 / Landing / 文档 / 法务页 | 文案写死 veryhappy.dev；内部版 `WEB_LANDING=off`，但法务页和文档仍然公开 | 文案里的「托管实例」改用 `BRAND.name` + 当前 origin 占位；`CHANGELOG_RELEASES` 不写域名；README 说明公共版与「公司自建实例」的区别 |
| CI / 发布脚本 | `PUBLIC_ORIGIN` 等写死 | 参数化（§2.3） |
| `happy-agent/src/config.ts:11` | 默认 veryhappy.dev | 保持；文档写明内部用 `HAPPY_SERVER_URL` |
| 测试 | 111 处夹具 | 涉及「云端 origin 判定」的改成按配置断言；其余不动 |

## 8. 分阶段计划

所有生产写入（AWS 资源、Route53、CloudFront、IdP 回调、公共版 env、发版）都由 Owner 确认后、Lead 派人执行；每一步先写好回滚再动。时间都按 SGT。

| 阶段 | 改什么 | 验证 | 回滚 | 用户感知 |
|---|---|---|---|---|
| **P0 代码**（无生产变更，L2 QA） | §7 全部；两套部署的 CI 参数化；核实附件存储后端、自动化与 issue 的服务端定时逻辑在「复制后两边并存」时不会双跑 | 单测与集成：opt-in、强制提示、`server use`、安装脚本 `--server`；standalone 起两套（不同 master secret）：复制 → rekey → prune → 横幅 → handoff + OIDC（mock IdP）→ daemon 跟随 → 内部版解密历史 | revert PR | 无 |
| **P1 起内部版**（生产写入，公司用户还看不到） | 建 EC2/RDS/ElastiCache/CloudFront/ACM；Route53 `vibe.apodex.site` alias；在 IdP 登记回调；部署同一 SHA；用 vibe-test 的经验配置白标和 OIDC | `/health`；SSO 登录 [QA] 账号；新建会话、终端、分享；两套 deploy workflow 各跑一次 canary | 删除资源（还没有用户数据） | 无 |
| **P2 演练** | 用公共版快照 → 临时库 → 内部版的**演练库**（随后丢弃），完整跑一遍 rekey + prune；用 [QA] 账号走 handoff 和 daemon 跟随（daemon 在隔离的 `HAPPY_HOME_DIR`） | dry run 报告逐表核对；记录耗时，用于确定 T 的窗口；随机抽 3 个公司账号核对会话数与解密结果（只看计数和解密成功与否，不看内容） | 丢弃演练库 | 无 |
| **P3 通知 + 报名**（T−3 天） | 群通知（§9）；公共版开 opt-in 设置项（发版） | 意向表行数；名单比对只在本机进行 | 关闭设置项 | 同事收到通知 |
| **P4 T 时刻** | 快照 → 恢复 → dump/restore → rekey → prune（keep-file = 62 个 + 报名者）→ 内部版切到正式库；公共版开 `MIGRATION_*`（switch 发布） | 内部版行数对表；公共版：targeted daemon 的 socket 连接数下降，内部版上升；抽 dev-sg / mac-office 看 settings 与 RPC | 关闭公共版的 `MIGRATION_*`：没跟过去的留在公共版；已跟过去的，必要时用反向 handoff 跟回（反向 prune 之前都可以） | 公司用户：横幅 + 重新登录；外部用户：无 |
| **P5 强制提示**（T+3 天） | `MIGRATION_ENFORCE_AFTER` 生效 | 名单内账号打开公共版只看到提示页 | 去掉该 env | 公司用户无法再用公共版的网页 |
| **P6 收尾**（T+30 天，满足「名单内 daemon 在公共版连续 14 天为 0」） | 公共版反向 prune 名单内账号（先快照）；关闭公共版的 `MIGRATION_*` | dry run 核对；外部用户回归 | 从快照恢复被删的行（按账号）：比较繁琐，所以先等 14 天的零流量 | 无 |
| P7（可选） | 内部版单独建 relay；字体自托管；公共版评估降档 | 各自验证 | 各自回滚 | 无 |

## 9. 用户通知稿（只发公司群；发送由 Owner 确认）

时间：T−3 天发通知，T−1 天提醒，T 当天完成后再发一句「已切换」。渠道：Coding Agent 群（Tanka）。公共版不发全站公告，外部用户无感。

中文：

> **公司内部版 Very Happy 上线：vibe.apodex.site**
> 公司同事请在 **{T 日期 时间}** 之后改用 https://vibe.apodex.site（公司 SSO 登录）。你在 veryhappy.dev 上的会话、项目、团队、自动化、笔记都会一起搬过去。
> - **用 apodex.com 邮箱登录的**：什么都不用做，到时打开 veryhappy.dev 会提示你过去。
> - **用 gmail 或其他邮箱登录的同事**：请在 {T 日期} 之前，在 veryhappy.dev「设置 → 账号 → 我是 Apodex 同事」里报名，否则只能在内部版重新开始。
> - 电脑上的 daemon 会自动切过去；请在 {T 时间} 之前结束正在跑的任务，切换后对仍要继续的会话点一次「重启会话」。
> - 手机通知要在新地址重新开启；装过 App 图标的请重新「添加到主屏幕」。
> 有问题在群里 @我。

English:

> **Very Happy for Apodex is live at vibe.apodex.site**
> From **{T date/time}**, please use https://vibe.apodex.site (sign in with company SSO). Your sessions, projects, teams, automations and notes on veryhappy.dev move with you.
> - **Signed in with an apodex.com email?** Nothing to do — veryhappy.dev will point you there.
> - **Using Gmail or another email?** Opt in before {T date} under veryhappy.dev → Settings → Account → "I'm at Apodex", or you'll start fresh on the internal site.
> - Your daemons switch over automatically. Please finish running tasks before {T time}; afterwards, use "Restart session" on any session you keep working in.
> - Turn notifications on again at the new address and re-add the home-screen app if you installed it.
> Questions? Ping me here.

## 10. 需要 Owner 拍板

1. **放在哪**：推荐 D1，即公司账号 ap-southeast-1、复用 `vh-vpc` 独立子网与安全组，起步用「小」档，每月约 $190–215（§2.1、§2.4）。
2. **共享什么**：推荐 DB、Redis、主密钥、relay 全部独立，只共享镜像和 npm 包；内部版先不建 relay（§2.2）。
3. **发版顺序**：推荐同一 SHA 先发内部版、观察 30 分钟再发公共版，回滚各自独立（§2.3）。
4. **迁历史还是新起步**：推荐迁历史，用复制 + rekey + prune（§4.1）。
5. **内部版登录方式**：推荐公司 SSO 作为唯一的注册入口；迁过来的老账号暂时保留邮箱/Google 登录，90 天后评估是否只留 SSO。如果保留邮箱登录，要先配公司域的发件人（§2.2）。
6. **内部版的公开分享链接**：推荐默认只允许 SSO 登录的人看；对外分享继续用公共版（§4.3）。
7. **gmail 等同事的识别**：推荐自报名 + SSO 认领，本机比对通讯录只用来提醒；报名在 T 之前截止（§3）。
8. **「直接切」**：推荐网页第 3 天起强制提示，daemon 走自动跟随；不在 T 时刻封公司账号（§5.1）。
9. **访问方式**：推荐公网开放 + SSO，不加 IP 白名单或 VPN（§6）。
10. **公共版收尾**：推荐 T+30 天、且名单内 daemon 连续 14 天零流量之后，反向 prune 公司账号；之后评估公共版降档（§4.1、§2.4）。
11. **T 的时间**：推荐 P2 演练测出耗时后，定在一个周六 22:00 SGT。

## 附录：复核 SQL（只读事务；时间列是 UTC，换算 SGT 用 `+ interval '8 hours'`）

```sql
BEGIN READ ONLY;
-- 名单规模：apodex.com 身份邮箱的账号
SELECT count(DISTINCT "accountId") FROM "AccountIdentity" WHERE lower(email) LIKE '%@apodex.com';
-- 服务端没有密钥副本的账号（迁过去也无法恢复）
SELECT a.id FROM "Account" a
WHERE NOT EXISTS (SELECT 1 FROM "AccountSecret" s WHERE s."accountId"=a.id)
  AND NOT EXISTS (SELECT 1 FROM "AccountCredential" c WHERE c."accountId"=a.id);
-- 7 天在线的 daemon 版本分布
SELECT split_part(coalesce("lastHappyClient",'(null)'),' ',1) client, count(*)
FROM "Machine" WHERE "lastActiveAt" > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC;
ROLLBACK;
```
