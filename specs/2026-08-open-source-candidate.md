# Open-source release candidate

> 状态：Shipped candidate（公开切换仍受历史净化阻塞，见 `OPEN_SOURCE_READINESS.md`）
> 日期：2026-08-24 ｜ 关联 backlog：B-155 ｜ 出处：Owner 开源候选专项

## 背景

Very Happy 已经是 Owner 日常使用的生产系统，也已经具备 password/Google Cloud identity、
全局账号容量和 Web→CLI 首机连接路径。但未登录根路由仍跳到登录框，正式用户文档仍混有
上游 Expo/旧包名，公共 PR 会在私有 self-hosted runner 上执行不受信代码，完整 Git 历史还
包含上游真实 session dump 与疑似凭据。仅润色 README 不足以安全公开。

本批把三条边界分开：公开源码仓、陌生用户自托管、Owner 运营的官方 Cloud。代码和文档要
同时支持前两条；官方 Cloud 保持现有账号、session、terminal 和 daemon 兼容，并以可配置容量、
认证降级和真实的 server-trusted 披露服务公众。

## 目标

- 未登录 `/` 是快速、响应式、可访问的产品 landing；公开 `/docs` 提供闭环文档导航。
- 登录/注册、安装 CLI、连接首机、创建首 session 的每个空态和常见失败都有可操作下一步。
- public fork PR 只在 GitHub-hosted runner 执行，不能接触私有 runner、生产网络或发布凭据。
- 当前树不包含确认的密钥、PII 或真实 session dump；完整历史命中给出可执行但不擅自执行的
  净化与轮换方案。
- clean checkout、三包门禁、isolated HOME、浏览器 E2E 和生产健康检查形成可复核证据。
- 最终 `OPEN_SOURCE_READINESS.md` 给出 READY/NOT READY、部署版本、限制和 Owner 不可逆动作。

## 非目标

- 不把 GitHub 仓库真正切为 public，不 force-push 或重写共享历史，不轮换生产密钥。
- 不承诺 E2E、zero knowledge、SLA、数据永不删除或运营者无法访问内容。
- 不重写 terminal/chat wire protocol，不迁移现有账号、session 或 daemon token。
- 不把废弃 Expo `happy-app` 恢复为产品前端；它只作为上游历史保留并明确 unsupported。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 未认证访问 `/` 被 `RequireAuth` 重定向 `/login`，没有 public home | `packages/happy-web-v2/src/app/AppRoot.tsx` |
| 首机引导已有安装、`very-happy auth login` 与启动步骤 | `packages/happy-web-v2/src/screens/onboarding/FirstRunScreen.tsx` |
| password/Google 注册已识别 capacity/closed/invite/rate-limit 错误 | `packages/happy-web-v2/src/screens/auth/{LoginScreen,SignupScreen}.tsx` |
| public Privacy/Terms 已有路由，但没有正式 docs 路由 | `packages/happy-web-v2/src/screens/legal/PublicLegalScreen.tsx` |
| quality 与 Linux CLI PR job 默认跑 self-hosted runner | `.github/workflows/{quality,cli-smoke-test}.yml` |
| Cloud identity/容量已发布，旧 CLI token 保持兼容 | `specs/2026-08-cloud-identity.md` |
| 生产 Web/server 为 hw-sg，daemon 为 mac-office，server 是可信中继 | `docs/operations.md` |
| 2026-08-24 gitleaks 完整历史扫描命中 47 项，含上游 session JSONL/JWT 和 Google 配置 | `OPEN_SOURCE_READINESS.md`（最终记录脱敏分类） |

## 设计

### A. Public information architecture

`/` 为 landing；`/docs` 为文档首页，并提供 `/docs/:slug` 的静态、随 Web 发布的章节。landing
只用 Console tokens，accent 仅表示连接/live；机器/协议信息使用 mono。首屏明确产品、信任边界、
Cloud 与 self-host 区别，并给登录、开始使用、GitHub 和 docs 入口。产品演示按真实三栏结构
（session 列表、深色 terminal、文件浏览/preview）做去敏的轻量 HTML 重建，并可切换 structured
conversation 与 agent board；不引用私有截图、不引入追踪脚本或重媒体依赖。

文档章节至少覆盖 quickstart、CLI、Cloud/self-host、configuration、architecture/data flow、
security/privacy、accounts/quotas、upgrade/rollback、troubleshooting、contributing。仓库 Markdown
仍是可审阅事实源；Web docs 是面向使用者的稳定入口，关键命令与边界保持一致。

### B. New-user journey

landing → `/signup`/`/login` → authenticated `/` first-run → CLI `auth login` → machine appears →
new terminal/session。认证页增加返回 landing/docs 的上下文入口；错误按认证失败、容量、策略、
限流、网络/服务不可用分类，不展示内部异常。首机页明确 CLI 前置条件、Cloud target、自托管
环境变量和“机器未出现”的排障链接。

### C. Public CI boundary

所有 `pull_request` 的代码执行 job 固定 GitHub-hosted Linux runner，且最小只读权限；push main、
tag 和显式 `workflow_dispatch` 才可用私有 runner。部署/publish workflow 继续只允许手动或 tag，
不通过 `pull_request_target`/`workflow_run` 执行 fork 代码。mac-office runner 不参与 PR。

### D. Trust and private remnants

对外统一使用 server-trusted：server operator 或 server compromise 可访问中继内容、恢复账号 secret，
并通过在线 daemon 的授权能力影响远程机器。内部 host 名和 runbook 可保留在 maintainer-only 运维文档
时必须明确不是 self-host 默认；随 CLI 分发的个人绝对路径和默认私有集成改为配置或默认关闭。

完整历史不在本批重写。当前树删除/替换确认的敏感样本；最终报告提供两种 Owner 可执行路径，优先
生成经过 allowlist 的全新 public mirror，其次在维护窗口用 `git filter-repo` 净化并轮换受影响凭据。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 现有 server/CLI | public routes 为纯静态 UI；认证、sync、terminal 协议不变 |
| 旧 Web + 现有 server/CLI | Owner 当前生产路径不变 |
| public fork PR | 只在 hosted runner 执行，无生产 secrets/网络身份 |
| push main/tag/manual release | 保留现有私有 runner 与发布路径 |
| Google 未配置/Cloud 满额/closed | password 登录已有账号可用；新注册显示稳定可操作错误 |

默认发布顺序：文档/CI 可先合并；若无 server/CLI 用户可见变更，只发布 Web，不发 CLI tag；
若 review 产生 server 修复则 server → `vh-update` → Web；所有路径可回滚到 `9b0757ce` / CLI `0.2.56`。

## 风险

1. **landing 破坏登录根路由**：仅把 public `/` 与 authenticated app root 分流，auth return target 和
   已登录 `/` 行为加路由/纯函数测试。
2. **文档与实现漂移**：关键命令引用常量或由测试校验；发布报告核对 CLI `--version` 和 runtime config。
3. **公共 PR 逃逸到生产 runner**：workflow 静态回归测试/脚本扫描所有 PR job 的 `runs-on` 与 triggers。
4. **历史敏感值仍可达**：仓库切 public 前把历史净化/新 mirror 与轮换列为 Owner 硬门，不以当前树
   clean 代替历史 clean。
5. **公开 Cloud 扩大远程执行风险**：保留账号容量、认证限流、一次性 OAuth nonce；配对边界另做安全
   review，确认缺陷必须带回归测试后修复，不以营销文案掩盖。

## 验收标准

- [ ] 未登录桌面/手机可完成 landing→docs→signup/login 导航，键盘与 reduced-motion 可用。
- [ ] 新账号常见失败、首机空态和首次 session 有明确恢复路径。
- [ ] docs 十类主题齐全，README/CONTRIBUTING/部署/安全口径一致，无废弃 Expo 主路径。
- [ ] public PR 不执行在任何 self-hosted runner，不持有写权限或发布 secrets。
- [ ] 当前树 secret/PII/session 扫描无未解释命中；历史命中分类、处置与轮换命令已记录。
- [ ] Web/server/CLI 受影响门禁全绿；clean checkout 与 isolated HOME 冒烟通过。
- [ ] 真实浏览器完成匿名、注册/登录降级、首机和核心 authenticated 路径验收。
- [ ] 安全/代码 review 与首次用户/UI/文档 review 各完成一轮，确认问题已修。
- [ ] 生产健康、asset MIME、Owner 现有 daemon/session 路径无回归。

## 留真机验证项

- 手机窄屏 landing/docs 的视觉层级与可读性。
- Google popup 在真实 production origin 的首次注册、再次登录和取消/失败恢复。
- Owner 现有 mac-office daemon 在 Web 发布后创建 terminal/session 并继续旧 session。
