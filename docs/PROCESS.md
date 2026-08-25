# very-happy 迭代流程（Iteration Process）

> 单人产品 Owner（jojo）+ AI agent 集群的开发模式。本流程不是理想主义 SOP，
> 是 2026-08 大规模迭代（v0.2.20→28，30+ 次发布）中实际有效工作流的固化。
> 修订本文档 = 修订流程本身。

## 0. 角色模型

- **Owner（jojo）**：出需求/实报 bug/拍板取舍/真机验收。
- **主 agent（Claude 会话）**：triage、拆分、派工、review、合并、发布、沉淀。
- **实现 agent（sub-agent × worktree）**：单一职责实现，交付"报告 + 分层 commit"。
- 边界纪律：并行 agent 各占 worktree；同文件冲突由主 agent 合并时解决；
  高冲突热区（SettingsRoutes/WebTerminalScreen）派工时显式声明"别碰"。

## 1. 输入 → Backlog

- 全部输入（实报 bug / 想法 / 评审发现 / 技术债）进 **`docs/backlog.md`**（一项一行，
  类型 `bug`/`ux`/`feat`/`debt`）；留真机验证项另进 **`docs/verify-queue.md`**。
  > 2026-08 修订：原定 GitHub Issues，实证零使用（零 issue 零 label）后改文件化——
  > 状态与代码同 commit、agent 零网络凭据可读写、可 grep；理由详见 backlog.md 头注。
- **单写者纪律**：backlog.md 只由主 agent（或 Owner）写；Owner 在对话里说的需求，
  主 agent 当场记入（不靠记忆）；实现 agent 只读不写。
- 产品内 task board 管"会话/任务运行态"，backlog.md 管"产品迭代项"——两者不混。

## 2. 批次制（Release Train）

以**批**为单位迭代，一批 = 2-6 个独立事项：

```
triage（分独立/冲突域）
  → 并行实现（每事项一个 worktree + 分支；大改动先出 spec 定稿，见 specs/README.md）
  → 主 agent 逐个 review + merge（含冲突解决）
  → 集成门禁（见 §3）
  → 发布（见 §4）
  → 验收（自动化 E2E + 真机清单登记 docs/verify-queue.md）
  → 沉淀（见 §6）
```

- **大改动前置设计**：动协议/状态模型/存储语义的（如推送化、seq 记账），
  先由 Plan agent 出 spec（`specs/`，模板与生命周期见 `specs/README.md`）、
  主 agent 定稿，再派实现。小改直接做。spec shipped 后回标状态，留档不删。
- **每批结束跑一次 high-effort code-review 全量回扫**（对本批 diff）：
  2026-08 实证一次回扫抓出 11 个 CONFIRMED 真问题。发现项当场修或建 issue。

## 3. 质量门禁（硬性，任何 merge 前）

| 包 | 门禁 |
|---|---|
| happy-web-v2 | `pnpm exec vitest run` 全绿 + `pnpm exec vite build` 成功 + **`pnpm exec tsc --noEmit` 0 错误**（存量债 2026-08-13 清零，CI 硬门） |
| happy-cli | `pnpm build` + unit 全绿（daemon.integration "second daemon" 为已知环境例外）+ `node dist/index.mjs --version` 运行冒烟（build 绿 ≠ 运行不崩，有 CJS 事故先例） |
| happy-server | `tsc --noEmit` + `vitest run` 全绿（**零新 npm 依赖**——bind-mount 约束） |

通用纪律：
- **事故必附回归测试**：修复不带覆盖该机制的测试不许合并。
- 纯函数优先：新逻辑尽量抽纯函数模块（`termWriteHold`/`termStreamSync`/`boardTaskOps` 模式），
  这是 AI 并行开发下测试稳定性的支柱。
- 推公开 remote 前 gitleaks（或等价 secret 扫描）；密钥永不进 repo。
- 仓库依赖内的构建/测试/生成工具用 `pnpm exec`，不用裸 `npx`（它曾绕过
  workspace/lockfile 解析到错误版本）。仓库外的一次性只读工具仅允许版本化
  plugin/skill runtime，或 `pnpm dlx <package>@<精确版本>`；禁止 `@latest`、未固定
  版本的临时下载，以及因此改动 package.json/pnpm-lock.yaml。

## 4. 发布工程

- **版本**：CLI = semver patch（推 tag 自动发 npm）；web = bundle salt 随每次部署；server 随源同步。
- **发布顺序**：默认 server → web → CLI（tag → npm 200 → `vh-update`）；
  涉及协议字段时按实现报告里的兼容矩阵定顺序，**双向兼容（旧端忽略新字段）是设计要求**不是可选项。
- **部署核对**：push 后 ≥20s 再触发 CI；`gh run view --json headSha` 核对构建 sha = 预期 commit
  （踩过构建到旧 commit、push 静默失败两种事故）。
- **回滚**：CLI = `npm i -g very-happy-cli@<上一版>` + 重启；web = hw-sg `webapp.prev` 或重发上一 sha；
  server = git revert + 重部署。每批发布信息里写明本批的回滚点。
- **server 部署后必须 vh-update**（daemon RPC 重注册的已知问题，未根治前是流程项）。

### CI 跑在哪 / 托管分钟口径（2026-08-14 起）

私有仓计费倍率 Linux 1× / Windows 2× / macOS 10×，个人账号月度免费额 2000 分钟。
2026-08-14 前两天实测烧掉 1711 分钟（额度打穿、Actions 被计费拦停），所以**所有 Linux job
都迁到 fb-us self-hosted runner**（labels `self-hosted, linux, x64, fb-us`），托管分钟只在
发版那一刻的 macOS/Windows 矩阵上花。

| workflow | 触发 | 跑在哪 | 计费分钟 |
|---|---|---|---|
| `quality.yml` | push main / 所有 PR | fb-us self-hosted，**5 个 job 合并成 1 个** | 0 |
| `cli-smoke-test.yml` `smoke-linux` | push main / PR（限 `packages/happy-cli/**`）+ 每个 tag | fb-us self-hosted，node 20 + 24 | 0 |
| `cli-smoke-test.yml` `smoke-hosted` | **只有 tag**（或手动勾 `cross_platform`） | 托管 macOS + Windows × node 20/24 | **~96 / 次** |
| `deploy-hwsg.yml` | 手动 | fb-us self-hosted | 0 |
| `publish.yml` | tag `v*` / 手动 | fb-us self-hosted | 0 |

- **每次 push / PR = 0 计费分钟**（改造前 13 分钟/次，push 密集时还叠 102 分钟的跨平台矩阵）。
- **每次 tag ≈ 96 计费分钟**：macOS 2 格 × ~3 分钟 × 10 = 60，Windows 2 格 × ~9 分钟 × 2 = 36。
  → **约 20 个 tag/月以内不花钱**。按 2026-08-12/13 那种连发日（8 个 tag / 2 天）会到 768 分钟，
  仍然是唯一的花钱项；连发日想省就临时关掉跨平台冒烟：
  `gh variable set SKIP_HOSTED_SMOKE --body 1`（事后 `gh variable delete SKIP_HOSTED_SMOKE`），
  代价是那几个 tag 的发版信心退回 Linux 级别。长期解法是把 mac-office 也注册成
  self-hosted runner（macOS 那 60 分钟直接归零，只剩 Windows 36）。
- quality 合并成 1 个 job 的原因：单 runner 一次只跑一个 job，5 个 job 只会串行排队，
  并行结构反而把 checkout + install + wire build 重复 5 遍。合并后墙钟 ~13 → ~7 分钟。
  「哪个 gate 挂了」靠 step 名（`Gate: xxx`）区分，且每个 gate step 带 `if: !cancelled()`，
  **一个 gate 失败不挡后面的 gate**，一次 run 仍能看到全部门禁结果。
- 依赖装配靠 fb-us 上**持久化的 pnpm store**（硬链接安装），刻意不用 GitHub 缓存服务
  （几百 MB 上下行更慢还占配额）。store 疑似脏了就 `pnpm store prune`；工作树本身每次
  由 `actions/checkout` 的 `clean=true`（`git clean -ffdx`）清干净，不用手动处理。
  唯一保留 `cache: pnpm` 的地方是托管的 macOS/Windows 矩阵——那里 1 分钟安装 = 10/2 倍计费。
- fb-us runner 的前置要求：`git` / `ssh` / `ssh-keyscan` / `tar` / `curl`（deploy 有一步 preflight
  会显式检查并报缺谁）+ 足够磁盘（pnpm store + node tool cache，留 ≥10G）。node 与 pnpm **不用**
  预装：workflow 里 `actions/setup-node` 先跑（它只靠 runner 内置 node），再 `pnpm/action-setup`
  ——顺序是刻意的，反过来在没装 node 的机器上会挂。
- 每个 job 都有 `timeout-minutes`（20-30）：self-hosted 卡死没有天然上限，会永久占住唯一的 worker。
- **runner 掉线时 job 会永久排队**（不会像托管那样超时）。一条命令切回托管，不要改文件：
  ```bash
  gh variable set LINUX_RUNNER --body '["ubuntu-latest"]'   # 降级：开始烧托管分钟
  gh variable delete LINUX_RUNNER                           # 恢复 self-hosted
  ```
  （4 个 workflow 的 `runs-on` 都是 `fromJSON(vars.LINUX_RUNNER || '["self-hosted","linux","x64"]')`。
  排队中的 run 不会自动迁移，切完变量要重跑。）
- tag 会**并行**触发 `publish.yml` 和跨平台冒烟，**刻意不做 needs 硬依赖**（保留紧急发版通道，
  和 deploy 一个口径）：所以 npm 上出现新版本 ≠ 跨平台冒烟已绿，对外宣布版本前看一眼那条 run。

### CI 不可用时的本地部署应急路径

触发条件现在是 **fb-us runner 掉线且不想等**（原来的「配额打穿 / 付款失败 → job 直接不给起」
已经被 self-hosted 化解掉了）。**优先走上面的 `LINUX_RUNNER` 降级**，只有连托管也不想用
（或 GitHub 整体故障）才手工发。`scripts/ci/deploy-hwsg.sh` 要 `SSH_KEY`/`HWSG_*` 环境变量，本地没有；
手工发之前必须先建立并核验 `vh-us` SSH alias 指向当前 production origin；旧
`hw-sg` alias 不是 control origin，禁止继续用。应急发布也不再传源码：

```bash
cd ~/code/github/very-happy
SHA=$(git rev-parse HEAD)
TAG="ghcr.io/mereithhh/very-happy-server:$SHA"
docker build --build-arg "VH_VERSION=$SHA" -f Dockerfile.server -t "$TAG" .
docker push "$TAG"
DIGEST=$(docker buildx imagetools inspect "$TAG" --format '{{.Manifest.Digest}}')
ssh vh-us "bash -s -- ghcr.io/mereithhh/very-happy-server@$DIGEST $SHA" \
  < scripts/ci/deploy-server-remote.sh
docker buildx imagetools create --tag ghcr.io/mereithhh/very-happy-server:latest \
  "ghcr.io/mereithhh/very-happy-server@$DIGEST"
# 核对两条，缺一不可：
curl -s -o /dev/null -w '%{http_code}\n' https://veryhappy.dev/health   # 要 200
M=$(curl -s https://veryhappy.dev/ | grep -oE '/assets/[^"]+\.js' | head -1)
curl -s -o /dev/null -w '%{content_type}\n' "https://veryhappy.dev$M"   # 必须是 javascript
```

- Web 与 server 是同一完整镜像，不允许单独覆盖 host source、migration 或 webapp。
- 改 `.env`（VAPID/邀请码/密钥）要 `docker compose up -d --force-recreate`。
- macOS 的 `tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'` 是 xattr 噪音，不是错误。
- CLI 发不出去时的本地兜底：`pnpm --filter very-happy-cli build && pnpm --filter very-happy-cli pack` 后
  `npm i -g ./very-happy-cli-*.tgz`（跳过 npm registry，只救本机）。

## 5. 验收

- **自动化能验的当批验掉**（E2E 冒烟：spawn/send/webhook/剪贴板链路都有先例脚本手法）。
- **自动化验不了的**（真机 IME/触屏/视觉观感）：当批产出「留真机验证」清单 →
  登记 `docs/verify-queue.md`，**下一批开始前先清账**——不许无限堆积；
  验证不通过当场转 backlog.md 建 bug 项。
- 浏览器判断「没生效」前先在原标签页记录实际加载的 entry/CSS URL、目标元素
  computed style 与关键 CSS variable，并和服务器当前 entry 对比；再用普通 reload
  验证版本迁移。只有证据留存后才 hard refresh/unregister 做恢复；强刷后正常不能
  单独作为发布成功证据。

## 6. 沉淀（每批必做）

- repo 内落账：`docs/backlog.md` 本批做完的项标 done 移入「近期完成」；
  留真机验证项登记 `docs/verify-queue.md`；本批的 spec 回标 Shipped + commit。
- 稳定开发/发布事实同步仓库内 `docs/development.md`、`docs/operations.md` 与
  `.agents/skills/{dev,release}/SKILL.md`；外部个人 agent-system 只能镜像，不再做唯一事实源。
- 设计 token 事实以 `packages/happy-web-v2/src/styles/tokens.css` 为准；事故机制进入
  spec/backlog/代码注释中最贴近机制的位置，不再要求更新外部 build-state。
- 新坑进"坑"清单——判据：下个 agent 不知道会再踩的，才值得写。

## 7. 健康度（轻量，每月看一眼）

- tsc 存量债趋势（只减不增红线）、测试用例总数、web 初始 bundle 大小、
  发布频率与回滚次数。异常再深挖，不做仪表盘。

## 8. 节奏建议

- 集中批（像 2026-08-12 这种连发日）适合攻坚；平时以**周为默认批周期**，
  紧急 bug 走单事项快速批（一样过全部门禁，只是批小）。
- 每 4-6 批做一次**架构层评审**（对全库，不对 diff），滚动更新技术债判定
  （现在修 / 等触发条件 / 永远不修 三档）。
