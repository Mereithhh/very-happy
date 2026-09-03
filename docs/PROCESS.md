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
- **编号分配（多会话并行）**：`node scripts/dev/check-ids.mjs` 报下一个可用的 B-/V-/changelog key，
  `--claim B-xxx --claim V-xxx --claim <key>` 验号（撞了就非 0 退出）；**每次 rebase 后、开 PR 前都要再验一次**。
  下面是这条纪律的来历与手工做法（脚本挂了或要改它时看）：新开 B-/V- 编号前先 `git fetch origin main`，取 **origin/main** 上的最大号 +1，
  不要拿本地分支或记忆里的号；rebase 遇到同号先到者优先，后到者在整个分支上重编号（代码注释、测试名、spec、
  verify-queue、PR 标题都要改）。2026-09-02 一天内 B-279、B-282 各被两个会话撞号，各多花一轮 rebase+CI。
  **changelog key 撞号有一个静默形状**：两条 release 文案在 `releases: {}` 里相邻，冲突块从对象**中间**开始，
  于是「两边都留」的机械解法会把两条**合并进同一个 key**（前一半的字段被后一半覆盖，少的那条无声消失）。
  这一半的防线是 tsc 的 duplicate-key 报错——解完这类冲突必须跑 `tsc --noEmit`，别只看 vitest
  （2026-09-03 实踩：B-315/sep03t 被并行会话同取，重编号时正是这个形状）。**但 tsc 只挡文案文件那一半**：
  release 列表里两条 entry 同时指向 `sep03y` 是合法 TypeScript，git 也能无冲突自动合并，运行时才会
  显示成两条一模一样的更新说明——那一半由 `changelogRelease.test.ts` 的「每条 release 有自己的文案块」挡。
  **重命名自己的 key 时按内容定位，别按 key 名**：同名的那个块正是别人的，按名字替换会改到对方头上
  （2026-09-03 实踩，靠 tsc 的 TS2820 才发现）。
  **claim 通过 ≠ 安全，窗口就是 CI 时长**：号是在你 `--claim` 之后、land 之前被别人拿走的。
  2026-09-03 一个 PR 连着三轮被挤掉（B-321→B-322→B-324，sep03y→sep03z→sep03aa），每轮都是
  「取 next free → 跑 CI 三分钟 → 被抢 → 重来」。所以**撞过一次之后重编号要留余量**，别再取 next free；
  空出几个号比再赔一轮 rebase+CI 便宜得多。
  **重编号是 `sed -g` 最容易伤到别人的地方，两个方向都出过事**：往外——2026-09-03 把 `B-321` 批量换成 `B-322`
  时匹配到了并行会话正在做的 `MachineScreen.tsx`（提交前从 `origin/main` 还原，未污染 main；B-319 备注里
  记着同一个事故的另一次）；往里——**同一天有会话在 `docs/backlog.md` 里批量重编号，把已经合入 main 的
  B-322 行改成了 B-324，和他们自己的 B-324 撞成两行同号**，而代码/spec/changelog 里写的全是 B-322。
  所以：① 重编号前先 `git diff --name-only` 确认匹配集只含自己的文件；② **`docs/backlog.md` 是共享单写者文件，
  只准改自己那一行**——别人的行即使看起来号不对也不要动，去问；③ 改完用 `grep -c '^| B-xxx |'` 确认没有同号两行。

  **长任务要重复做这件事**：号是在开工时取的，而 main 在你写代码、跑门禁、做 review 的这几小时里会一直前进——
  2026-09-03 的 B-309/310/311 连撞两次（第一次 B-304/305、重编到 306 又被占），每次 rebase 后都要重新
  `git show origin/main:docs/backlog.md` 核一遍最大号。**CLI 版本号同理且更贵**：同一天 0.2.109/110/111 被
  三个会话依次取走，changelog 里的 `cliVersion` 每次都要跟着改；已推的 tag 不可动（铁律 6），所以只能往后让。
  发 tag 前用 `check-release.mjs --mode cli --version <目标>` 核对，别照 changelog 里已写好的号想当然。
- **changelog 文本 key 同样会撞，而且撞了不报错**：`changelog.releases.<key>` 用日期序（`sep03a/b/c…`），
  两个会话同日各取下一个字母就会选中同一个。2026-09-03 两个会话同时用了 `sep03f`：squash 合并保留了先合的一方，
  **后合的一方代码全在、release 条目却被静默吞掉**（deploy 的 changelog 门禁这才拦下来）。开条目前照 B-id 的做法
  `git fetch` 看 origin/main 上已用到哪个字母；发现被吞就补一个新 key 重发，不要去改对方的条目。
- **npm 版本号也会被并行会话取走，而且取走之后无法挽回**：CLI 版本由 `v*` tag 决定，不看
  `package.json`。写 changelog 条目时填的 `cliVersion` 是**预测**，在你 review 期间可能有别的会话
  先把那个号发掉。2026-09-03：`sep03i` 写着 `cliVersion: '0.2.106'`，而 v0.2.106 已在 `2357adb7`
  （B-294 那批）打好并发到 npm——那个版本里根本没有这批改动。**发版前一律先跑
  `check-release.mjs --mode cli --version <目标版本>` 核对，别照 changelog 里已写好的 cliVersion
  想当然**；它会告诉你上一个 tag 是谁、这段区间有哪些 user-facing 提交。tag 是不可变外部发布
  （铁律 6），发错只能递增版本号重来。
- **别人的 migration 会挡住你的纯 web 发布**：server/web 是同一个不可变镜像，只要 main 上任何人加了
  migration，`VH_RELEASE_MIGRATIONS_REVIEWED` 门禁就会拦下整次 deploy（在 `before-switch` 阶段失败并
  自动还原 active upstream，生产不受影响）。这个确认是 **commit-bound 的生产写入**，不属于「顺手放行」：
  除非 Owner 明确授权，让加 migration 的那个会话自己发，你的改动随它一起上线。

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
- **事故必附回归测试**：修复不带覆盖该机制的测试不许合并。**源码断言型测试
  （`expect(source).toContain(…)`，本仓大量使用）必须用 `node scripts/dev/mutation-check.mjs` 验一遍**——
  被断言的字符串在同一文件里别处也出现时，删掉你真正想钉住的那一处测试照样全绿（B-300 实例）。
- 纯函数优先：新逻辑尽量抽纯函数模块（`termWriteHold`/`termStreamSync`/`boardTaskOps` 模式），
  这是 AI 并行开发下测试稳定性的支柱。
- 推公开 remote 前 gitleaks（或等价 secret 扫描）；密钥永不进 repo。
- 仓库依赖内的构建/测试/生成工具用 `pnpm exec`，不用裸 `npx`（它曾绕过
  workspace/lockfile 解析到错误版本）。仓库外的一次性只读工具仅允许版本化
  plugin/skill runtime，或 `pnpm dlx <package>@<精确版本>`；禁止 `@latest`、未固定
  版本的临时下载，以及因此改动 package.json/pnpm-lock.yaml。

## 4. 发布工程

- **changelog 门禁**：Server/Web 发布按「线上 release SHA → 目标 SHA」求差、CLI 按「上一个 v* tag →
  本 tag」求差，凡有 feat/fix/perf 提交就必须新增 `CHANGELOG_RELEASES` 条目（CLI 需精确 `cliVersion`），
  `deploy-hwsg.yml` / `publish.yml` 拒发；本地先跑 `scripts/changelog/check-release.mjs`，跳过必须留理由
  （deploy 输入 `changelog_skip_reason` / 附注 tag `[changelog-skip: …]`）。
- **版本**：CLI = semver patch（推 tag 自动发 npm）；同一 tag 先发布六个
  `very-happy-tools-<arch>-<os>` 平台包，再发布带精确 optionalDependency 版本的
  `very-happy-cli` 主包，部分成功后 workflow 可幂等重跑；web = bundle salt 随每次部署；server 随源同步。
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
- **发布后必须证明本次改动真在线上**（workflow 绿 ≠ 上线）：
  `node scripts/dev/check-shipped.mjs --needle '<只有新代码才有的串>'`，非 0 即没上。
  别手搓 curl——三次手搓三次读出相反结论，坑写在脚本头部。
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
