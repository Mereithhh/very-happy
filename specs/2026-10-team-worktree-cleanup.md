# 团队 worktree 清理：已推送/已合入即清理，已删除视为已清理，处理入口与折叠

状态：Final · 2026-10-21 · B-691（依赖 B-689 的 `retry-operation`）

## 现场（10-21，dev-sg 上的研发团队）

团队设置页底部堆着 `stop · failed · Worktree branch changed; preserve for manual reconciliation`。本地 receipt：5 条 stop 停在 `prepared`，daemon 日志里每条已重试约 2000 次（每 5 s 一次：stop → archive → git 检查 → fail-operation）。

## 根因（代码已确认，`daemon/teams/worktree.ts` `removeTeamWorktree`）

1. **分支变了就保留**：只认 `HEAD === codex/team-<op>`。我们的流程是在 team worktree 里切 `team/B-xxx` 分支、推送、开 PR、squash 合入，这一步永远报 failed。
2. **合入判定只认源 checkout 的 HEAD 是祖先**：squash 合入、只推到 origin 都判为未合入。
3. **worktree 已被移除**：`git worktree remove` 之后目录还在（空目录，或运行中的工具重建的 `node_modules/.vite`、`.claude` 残留），`git -C <dir> symbolic-ref` 直接报错（不是 worktree）；分离 HEAD 也会让 `symbolic-ref` 报错。
4. **失败重试太密**：stop 失败每个 5 s 轮询都重跑，`failure-<op>-<phase>` 请求 id 固定，错误文本改变也不会更新。
5. **Web 只有「人工对账」表单**，没有重试入口，已处理的条目也不折叠。

## 修复契约

- **安全判定**（唯一入口 `removeTeamWorktree`）：
  - 有未提交/未跟踪文件（ignored 不算）→ 保留：「Uncommitted work retained at … (N changed files): commit and push it, or discard it, then retry cleanup」。
  - HEAD（任何分支或分离 HEAD）上有提交既不在任何 remote ref、也不在源 checkout HEAD 上，且不是 squash 合入 → 保留：「Unmerged work retained on <分支|a detached HEAD> at …: N commits are not pushed or merged; push or merge, then retry cleanup」。
  - squash 合入判定：`merge-base(HEAD, origin/HEAD)..HEAD` 的合并 patch-id 出现在 `base..origin/HEAD` 最近 500 个提交的 patch-id 中。
  - 团队自己的 `codex/team-<op>` 分支按同一规则检查；有未推送提交时**连 worktree 一起保留**；安全时 `branch -D`。worker 自己的 `team/B-xxx` 分支从不删除。
  - 以上都安全 → `git worktree remove`（不加 `--force`，git 自己也拒绝脏树）。
- **已删除视为已清理**：目录不存在 → `worktree prune` 后视为完成；目录存在但已不是任何 worktree（源仓库 `worktree list` 里没有它）→ 视为已清理，空目录删除，有残留则**原样保留不删**；仍登记为 worktree 但 git 链接损坏 → 保留并提示人工核查。
- **退避与 Owner 重试**：stop 失败后 5 分钟再自动复查；`retry-operation`（B-689 引入）对 failed stop 立即复查，每个请求只执行一次。失败上报的请求 id 带原因哈希，原因变化会更新。machine `teamRetryVersion` 升到 2 表示支持清理重试。
- **Web**：「执行需要处理」只列未处理条目；failed stop 显示原因、处理说明，以及「重试清理」（需 `teamRetryVersion ≥ 2`，否则提示升级 CLI）和「标记为已处理」（展开原人工对账表单：确认 + 说明）；已人工处理的条目折叠为「已处理 N 条」。

## 不变量（测试锁定）

真实 git 仓库（bare origin + worktree）测试：脏文件不删、分离 HEAD 上未推送提交不删、`codex/team-*` 分支有未推送提交时 worktree 与分支都不删、登记但损坏的 worktree 不碰、已移除 worktree 的残留文件不删；已推送分支、squash 合入并删除远端分支、目录已不存在三种情况完成清理。

## 兼容与发布

wire 无新字段（复用 B-689 的 `retry-operation` / `retryRequestedAt` / `teamRetryVersion`，值升到 2）。server 不变。旧 daemon：Web 不显示「重试清理」，仍可「标记为已处理」。**需要 CLI 发版**才能自动清理已推送/已合入的 worktree；发布顺序同 B-689：server/Web → CLI。升级后现存的 failed stop 会在下一次复查（≤5 分钟）按新规则自动完成或给出新指引。

## 验证

- 单测：`worktree.test.ts` 8 个真实 git 场景、`worker.test.ts` 退避/Owner 重试/原因哈希请求 id、Web `canRetryCleanup`/`attentionOperations`。
- 端到端（隔离 HAPPY_HOME_DIR + 本地 server，worker 在 worktree 里切 `team/B-x` 分支并推送后取消任务）：修前 0.2.179 两条都是「Worktree branch changed」；修后已推送且干净的直接清理，有未跟踪文件的保留并给出指引；提交推送后在浏览器点「重试清理」立即清理；旧 daemon 团队「标记为已处理」后折叠为「已处理 2 条」。
