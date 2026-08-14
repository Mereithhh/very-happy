# /goal prompt：实现终端 Claude 结构化镜像视图（B-105）

> 本文件是给全新 Claude Code session 的 goal prompt（Owner 用 /goal 命令投放）。
> 你是本批主 agent。设计已定稿，不要重新设计——你的工作是照 spec 实现、门禁、发布、留验收。

## 使命

实现 **specs/2026-08-terminal-mirror.md**（状态 Final v3，经三轮对抗性 review 收敛）：
web 终端里手敲的 claude TUI，经全局 SessionStart/SessionEnd hook + tmux env 绑定，
由 daemon tail transcript JSONL 灌成「影子会话」，web 终端页提供 xterm ↔ 结构化
只读视图的**来回切换**。移动端是首要场景（手机上 TUI 渲染差，结构化视图是主收益面）。

**先通读 spec 全文再动手**——每个关键决策（key 管理、localId 公式、
treatExistingAsProcessed、HAPPY_MANAGED 双路注入、needs_input 横幅、两级视图偏好、
closedTerminals 联动）都有 reviewer 用代码证据定过的唯一正确写法，spec 里的
「现状事实」表每行都带 verdict 和文件:行号。**实现中若发现 spec 与代码现实冲突，
先改 spec 再改码**（PROCESS.md 铁律），并在交付报告里说明。

## 工作方式（repo 流程，硬性）

1. 全程在 git worktree 里干活（其他会话在并发写 main）；合并前 `git fetch origin main`
   + rebase；**backlog/verify-queue 提交前先 grep 最大编号防撞号**（撞号规则：
   已进代码注释的编号不动，改另一条）。
2. 本批对应 backlog **B-105**（现状 todo「待拍板」→ 你开工时标 doing，附本 goal 文件）。
3. 改动跨 happy-cli + happy-web-v2（server 零改动，spec 已证）。冲突热区
   `WebTerminalScreen.tsx` / `webTerminal.ts`——改前 `git log --oneline -5 -- <file>`
   看有无并行工作，改动保持最小面。
4. 大块新逻辑抽纯函数模块 + vitest（repo 惯例：termWriteHold/boardTaskOps 先例）。
   本批天然的纯函数位：hook payload 解析与分发、绑定状态机（startup/resume/compact/
   fork/end 转移）、localId 推导、backfill 截断决策、视图偏好解析。
5. 门禁（merge 前，全部）：
   - `pnpm -C packages/happy-web-v2 exec vitest run && pnpm -C packages/happy-web-v2 exec vite build && pnpm -C packages/happy-web-v2 exec tsc --noEmit`（tsc 必须零错误）
   - `pnpm -C packages/happy-cli test` + `HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs --version`（铁律 2 运行冒烟）
   - 真机制 E2E 冒烟：本机起 dev daemon（HAPPY_HOME_DIR 隔离，**别劫持生产 daemon**
     ——B-009 事故先例），vh 终端里手敲 claude 跑一小轮，验证影子会话出现、
     结构化视图渲染、resume 不重复。
6. 发布顺序（spec 兼容矩阵）：**web → CLI tag → mac-office `vh-update`**。
   push 后 ≥20s 再触发 CI，`gh run view --json headSha` 核对构建 sha（铁律 7）。
   CLI 发版=推 tag `vX.Y.Z`（版本号从上一个 tag 递增，看 `git tag -l 'v0.2.*' | sort -V | tail -1`）。
7. 自动化验不了的（移动端观感/滞后体感/多终端打字延迟）登记 docs/verify-queue.md
   （先 grep 最大 V 编号）。
8. Owner 的 `~/.claude/*` 归 chezmoi 管：`install-terminal-hooks` 命令照常实现，
   但在交付报告里提醒 Owner 把 hook 配置手动入 chezmoi 源，否则下次 apply 被覆盖。

## 明确不做（防扩权）

- 镜像不可交互（v1 严格只读；「交互边界与二期通路」节只留槽位不实现）。
- 不做双栏并排（一期 toggle only）。
- 不动 server 包。
- 不做 offset 持久化（spec MF-1 已拍板：重启 tail 尾部 N 行 + localId 幂等兜）。

## 交付定义

- spec 验收标准逐条对照的交付报告（哪条自动化验了、哪条进 verify-queue）。
- backlog B-105 收口 + verify-queue 登记 + spec 状态行更新为 Shipped（附 merge commit）。
- 发布完成：web 已部署 happy.mereith.com、CLI 已发 npm、daemon 已 vh-update
  且 `daemon status` 显示新版本。
