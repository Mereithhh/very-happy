@AGENTS.md

# Claude 会话补充（AGENTS.md 是事实源，这里只放会话启动与本地克隆事实）

## 每次开工先做（≤1 分钟）

```sh
git fetch -q origin && git status -sb | head -1     # 必须是 `## main...origin/main`，不能有 ahead/behind
pnpm install --frozen-lockfile && pnpm -C packages/happy-wire build   # wire dist 被 gitignore
git worktree list                                   # 派工前看清有哪些并行工作树
```

- 唯一主开发/发布源是公开仓 `Mereithhh/very-happy`（origin）。2026-08-25 做过
  历史净化重发（`docs/history-publication-runbook.md`），**净化前的本地克隆与 origin/main
  完全分叉**（同一批 commit 不同 SHA）——出现 `ahead N, behind M` 时不要 merge/rebase，
  直接 `git reset --hard origin/main`。2026-08-30 已对本地 main 做过一次，旧 tip 留在
  分支 `archive/main-old-history-6591bfbf`（只读，确认无用即删）。
- 本地 `.claude/worktrees/` 下有十余个 2026-08 中旬的陈旧工作树（term-input-*、
  voice-assistant、b-127-* 等），全部基于旧历史；开新事项一律新建 worktree，
  别复用它们；清理用 `git worktree remove <path>`。
- 常规发布不需要 `vh-update`（蓝绿切换）；只有 CLI/daemon 变更才更新 mac-office
  （见 AGENTS.md 铁律 5/7）。旧记忆里的 `happy.mereith.com` / hw-sg web 部署已作废，
  生产是 `veryhappy.dev` on vh-us，操作手册 `docs/operations.md`。

## 当前状态快照（2026-09-03，会过期；以 backlog/verify-queue 为准）

- 最新 tag / npm `very-happy-cli` = **v0.2.105**（mac-office daemon 同版本；2026-09-03；含 B-292 模型活切 `setModel` + `LaunchModeGate` + `meta.effort` 补进 CLI `MessageMetaSchema`）；线上 Web = `main@d0785bd9`（2026-09-03 蓝绿；含 B-293 移动端 header 收纳）。**注意 main 已在其后合入 B-294 导入体验，尚未发布。**发布前先跑 `scripts/changelog/check-release.mjs`（B-285 门禁，CI 也拦）。`packages/happy-cli/package.json` 里的 version 不是发布版本（发版脚本按 tag 定），别拿它判断线上版本。
- **终端字体自托管在 Cloudflare Pages**（`veryhappy-fonts.pages.dev`，Owner 的 CF 账号）：现用
  **Maple Mono CN**（`/maple-cn/{regular,bold}`，cn-font-split 按 unicode-range 切片，终端路由懒加载；
  旧的 Sarasa 仍留在 `/regular,/bold` 作回滚）。**字体不进仓库**；重新发字体用 `wrangler pages deploy`
  （需 Owner 先 `wrangler login`）。选型与「严丝合缝」定律见
  `specs/2026-09-terminal-font-and-seamless-rendering.md`（含 WebGL 被否决的理由）。
- `docs/backlog.md` 活跃区约 31 项非 done（8 `doing`：B-216 终端 tag、B-209 对话降噪、B-208 工作区视图、
  B-211 统一 Usage、B-192 多地域 relay、B-031 CI gitleaks 等）；改 doing 项前先读对应 `specs/`。
  **2026-09-02 已发布**：v0.2.93–v0.2.99 一大批——B-269/B-270（用户 tmux.conf 打坏 web 终端：base-index、
  destroy-unattached 等 + 0x1f 分隔符被 tmux ≤3.5 munge 的存量修复，见 AGENTS 铁律 17）、B-273/280/281/282
  （接入已有 tmux 会话：能力 + 一等入口 + 直达选择器 + 关闭=仅断开/可选彻底关闭，spec
  `specs/2026-09-attach-existing-tmux.md`）、B-275/276（Claude 认证预检/修复）、B-272（session 单写者锁）。
- `docs/verify-queue.md` 待验证 **90 项**（V-0xx～V-114），远超「下一批前清账」纪律；发新批前请 Owner
  清账或明确批准堆积。
- 门禁基线：web tsc 0 错误、cli 1490+ unit、web 1940+ 测试（本地跑一次门禁约 5-10 分钟，首次 install 更久）。
  web 测试在 web 终端里跑要 `env -u HAPPY_SERVER_URL`（终端注入的生产 URL 会让 `installScript.test.ts` 失败，
  CI 不受影响）；happy-cli 的 unit 项目含真实 tmux 测试（CI 也跑，见铁律 17）。
- 大改动/反复复发的 bug 的方法论先例：先出链路全图（Explore 子代理），再 ≥3 轮对抗 review 子代理
  逐轮推翻前提后定稿（B-259/B-260/B-262/B-264/B-265/B-273 记录在 `~/code/github/skills/tmp/<slug>/`）。

## 本地工具入口

- repo 内 skill：`.agents/skills/dev`（本地起 Web V2 + standalone server + 隔离 CLI home）、
  `.agents/skills/release`（发布/回滚/验证）；全局 `/release` 指向同一套流程。
- Web 本地开发 `pnpm -C packages/happy-web-v2 dev` → `http://localhost:8082`
  （默认代理到生产 veryhappy.dev；连本地 server 用 `VH_SERVER_URL=http://127.0.0.1:3005`）。
- `gh pr edit` 在 mac-office 会因 token 缺 `read:org` 报 GraphQL scope 错（标题/正文都改不了）；改用
  `gh api -X PATCH repos/Mereithhh/very-happy/pulls/<n> -f title=… -f body=…`。`gh pr create/merge/checks`、
  `scripts/land-pr.sh` 不受影响。PR 被标 `behind` 时 land-pr 会拒绝：`gh api -X PUT …/pulls/<n>/update-branch` 再 land。
- 发布前后核对线上 SHA 不用登机器：首页 entry 资产名 `index-<hash>-<sha>.js` 就是生效 release（`check-release.mjs`
  也这么读）；需要看 slot/探针留档再 `ssh vh-us`（只读 `/opt/happy/release/state.env`、`http-probe.*`）。
- CLI 实验永远用一次性 home：`HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs …`，
  **不要动 `~/.happy`**（那是 mac-office 生产 daemon 的状态）。
- PR 等 CI + 合并统一用 `scripts/land-pr.sh <pr>`（会识别 conflict 不触发 CI、按 head commit 找 run、合并重试；`--no-merge` 只看 CI）。
- 临时文件放 `~/code/github/skills/tmp/<task-slug>/`，不进 repo。
