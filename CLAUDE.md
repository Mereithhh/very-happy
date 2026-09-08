@AGENTS.md

# Claude 会话补充（AGENTS.md 是事实源，这里只放会话启动与本地克隆事实）

## 每次开工

```sh
git fetch -q origin
git status -sb
git worktree list
git log -1 --oneline origin/main
```

在自己的分支/worktree 工作；记录当前基线及未提交改动。`ahead/behind` 本身不能
证明旧历史分叉，也不能作为 `reset --hard` 的理由。需要同步时先核对 merge-base、
具体提交与改动归属；任务分支允许 ahead，不要求每个 worktree 都叫 main。
构建或测试前按 `dev` skill 安装锁定依赖并构建 happy-wire 的 gitignored dist。

唯一开发/发布源是公开仓 `Mereithhh/very-happy`。旧历史归档只读，迁移判断见
`docs/history-publication-runbook.md`；不要把某次本地克隆清理动作当成日常启动命令。

- 常规发布不需要 `vh-update`（蓝绿切换）；只有 CLI/daemon 变更才更新 mac-office
  （见 AGENTS.md 铁律 5/7）。旧记忆里的 `happy.mereith.com` / hw-sg web 部署已作废，
  生产是 `veryhappy.dev` on **vh-sg**（AWS 新加坡；2026-09-07 前是东京 VPS vh-us，已退役），操作手册 `docs/operations.md`。

## 当前状态从事实源读取

不在启动文件复制最新版本、测试数量或 backlog 快照，它们会先于规则过期。
推荐与自动安装的区别、完整 smoke 门禁见 `AGENTS.md` 铁律 6；实际版本通过
npm dist-tags、线上 `/v1/version/cli` 与 release state 分别核验。
生产发布及 mac-office launchd 接管见 `docs/operations.md` 和 `release` skill；
监控采集与托管看板见 `docs/monitoring/README.md` 和 `metrics-graphana` skill。
需求、验收和门禁分别只认 `docs/backlog.md`、`docs/verify-queue.md` 与 `AGENTS.md`。

## 本地工具入口

- repo 内 skill：`.agents/skills/dev`（本地起 Web V2 + standalone server + 隔离 CLI home）、
  `.agents/skills/release`（发布/回滚/验证）；全局 `/release` 指向同一套流程。
- Web 本地开发 `pnpm -C packages/happy-web-v2 dev` → `http://localhost:8082`
  （默认代理到生产 veryhappy.dev；连本地 server 用 `VH_SERVER_URL=http://127.0.0.1:3005`）。
- `gh pr edit` 在 mac-office 会因 token 缺 `read:org` 报 GraphQL scope 错（标题/正文都改不了）；改用
  `gh api -X PATCH repos/Mereithhh/very-happy/pulls/<n> -f title=… -f body=…`。`gh pr create/merge/checks`、
  `scripts/land-pr.sh` 不受影响。PR 被标 `behind` 时 land-pr 会拒绝：`gh api -X PUT …/pulls/<n>/update-branch` 再 land。
- 发布前后核对线上 SHA 不用登机器：首页 entry 资产名 `index-<hash>-<sha>.js` 就是生效 release（`check-release.mjs`
  也这么读）；需要看 slot/探针留档再 `ssh vh-sg`（只读 `/opt/happy/release/state.env`、`http-probe.*`）。
- 证明「改动真在线上」用 `node scripts/dev/check-shipped.mjs --needle '<只有新代码才有的串>'`，别手搓 curl
  （连着三次搓错，每次都读成相反的结论）。它自己读线上 SHA、**传递**遍历 chunk 图、并把 SPA 回退的 HTML
  当「资产不存在」报出来——**拼出来的 /assets 路径拿到 200 也可能是 index.html**，本地 dist 的 chunk 名
  更不能照抄（`__APP_VERSION__` 进内容哈希，CI 和本地不同名）。
- CLI 实验永远用一次性 home：在任务临时目录下创建独立 home，设置 `HAPPY_HOME_DIR` 后运行 CLI，
  **不要动 `~/.happy`**（那是 mac-office 生产 daemon 的状态）。
- 终端「慢 / 一行一行地画」先跑 `node scripts/dev/term-burst.mjs '<命令>'`（隔离 socket，报块数、
  中位块大小与按停顿切开的密集段）。**别看首尾跨度**——它把进程启动算进绘制，据此下的结论会把
  「传输放大」说成「源头本来就慢」（B-335 实踩）。
- 取号/验号 `node scripts/dev/check-ids.mjs`（B-/V-/changelog key 三家一起，只认 `origin/main`；
  `--claim <id>…` 撞号即非 0 退出）。纪律与撞号后的重编号见 `docs/PROCESS.md` 编号分配那条。
- **main 受保护，`git push origin main` 会被 repository rule 直接拒**（连一行 docs 也不例外）：
  一律开分支走 PR + `land-pr.sh`。
- **要 commit 的活一律在自己的 worktree 里做，一行 docs 也是**：主工作树
  `~/code/github/very-happy` 是多个会话共用的，别的会话会在里面 `git reset --hard origin/main`
  ——2026-09-03 实踩：在主工作树建分支并 commit 之后，被并行会话的 reset 把分支指回了 origin/main，
  接着 push 上去的是个空分支（`gh pr create` 报 `No commits between main and <branch>`）。
  commit 本身还在 object store 里，`git reflog` 找到 sha → `git branch -f <分支> <sha>` 即可复原。
- PR 等 CI + 合并统一用 `scripts/land-pr.sh <pr>`（会识别 conflict 不触发 CI、按 head commit 找 run、合并重试；`--no-merge` 只看 CI）。
- 临时文件放 `~/code/github/skills/tmp/<task-slug>/`，不进 repo。
