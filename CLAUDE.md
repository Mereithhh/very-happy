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

## 当前状态快照（2026-09-01，会过期；以 backlog/verify-queue 为准）

- 最新 tag / npm `very-happy-cli` = **v0.2.96**（mac-office daemon 同版本；2026-09-01；含 B-272 单写者锁，0.2.95 首发）；线上 Web = `main@ff8e113f`（2026-09-01 蓝绿）。`packages/happy-cli/package.json` 里的 version 不是发布版本（发版脚本按 tag 定），别拿它判断线上版本。
- `docs/backlog.md` 2026-09-01 已整理：活跃区约 28 项（6 `doing`：B-216 终端 tag、B-209
  对话降噪、B-208 工作区视图、B-211 统一 Usage、B-192 多地域 relay、B-031 CI gitleaks 收尾；
  其余 todo）；裁撤项带理由留在「近期完成」一轮后删。**最近发布 v0.2.92**：B-264 会话重启（一键 Restart + 守卫式重生）、
  B-266 relay 预检、B-267 root IS_SANDBOX（#121/#122/#123）。改 doing 项前先读对应 `specs/`。
- `docs/verify-queue.md` 待验证 **80+ 项**（V-0xx～V-108，含 v0.2.92 的 V-051~053），远超「下一批前清账」纪律；
  发新批前请 Owner 清账或明确批准堆积。
- 门禁基线：web tsc 0 错误、cli 1100+ unit、web 1900+ 测试（本地跑一次门禁约 5-10 分钟，
  首次 install 更久）。web 测试在 web 终端里跑要 `env -u HAPPY_SERVER_URL`（终端注入的生产 URL 会让
  `installScript.test.ts` 失败，CI 不受影响）。
- 大改动/反复复发的 bug 的方法论先例：先出链路全图（Explore 子代理），再 ≥3 轮对抗 review 子代理
  逐轮推翻前提后定稿（B-259/B-260/B-262/B-264 记录在 `~/code/github/skills/tmp/<slug>/`）。

## 本地工具入口

- repo 内 skill：`.agents/skills/dev`（本地起 Web V2 + standalone server + 隔离 CLI home）、
  `.agents/skills/release`（发布/回滚/验证）；全局 `/release` 指向同一套流程。
- Web 本地开发 `pnpm -C packages/happy-web-v2 dev` → `http://localhost:8082`
  （默认代理到生产 veryhappy.dev；连本地 server 用 `VH_SERVER_URL=http://127.0.0.1:3005`）。
- CLI 实验永远用一次性 home：`HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs …`，
  **不要动 `~/.happy`**（那是 mac-office 生产 daemon 的状态）。
- 临时文件放 `~/code/github/skills/tmp/<task-slug>/`，不进 repo。
