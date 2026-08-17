# /goal prompt：实现终端通道 v2（B-121，tmux control mode 内容流）

> 本文件是给全新 Claude Code session 的 goal prompt（Owner 用 /goal 命令投放）。
> 你是本批主 agent。设计已定稿（Final v6：四轮对抗 review + 实现者盲审收敛），
> 不要重新设计——你的工作是照 spec 实现、门禁、发布、留验收。

## 使命

实现 **specs/2026-08-terminal-channel-v2.md**：把 web 终端通道从「pty 起
tmux attach 全屏镜像」换成「pipe 起 tmux control mode 客户端 + 内容字节流」，
xterm 获得本地 scrollback——**手机滑动回看变成原生本地滚动**（本批的存在
理由，Owner 实报）。**先通读 spec 全文再动手**：每个关键决策（%output 字节
纪律、capture 双份全发+批末锚点、二段式打开+assembly 状态机+用户安静 gate、
send-keys 三通道+应答过滤、粘贴临时文件路径、滚动双轨、fresh/running 分治、
snapshotId 生命周期、兼容矩阵）都被 reviewer 用代码证据或本机实证定过唯一
正确写法；「现状事实」三张表每行带 verdict。**实现中发现 spec 与现实冲突，
先改 spec 再改码**（PROCESS.md 铁律），交付报告说明。

## 工作方式（repo 流程，硬性）

1. 全程 git worktree（其他会话并发写 main）；合并前 fetch+rebase；
   backlog/verify-queue 提交前 grep 最大编号防撞号。
2. 本批对应 backlog **B-121**（doing，spec 已 Final）——开工时把备注更新为
   实现中+worktree 名。
3. **阶段拆分（盲审建议，照此推进）**：
   - **Phase 0（地基，可两线并行，均 happy-cli 包）**：
     0a `ControlModeDecoder` 纯模块 + 金样本（录真实 control 流：claude
     会话/CJK/alt 进出/burst/二进制；隔离 socket `tmux -L` 采集）；
     0b `encodeSendKeys` + 应答过滤 + 粘贴编码纯模块 + **pane 侧字节捕获
     harness**（B-096 扫描表复用、字节水槽落文件、新旧写入端对跑）。
     硬门：金样本逐字节回放 + 纯函数全覆盖。
   - **Phase 1（daemon，串行于 0）**：TerminalSession v2 全量。⚠️
     `webTerminal.ts` 是冲突热区——**输出路径与写入端不要拆两个并行 agent**。
     硬门：cli 门禁 + 运行冒烟 + harness 142 用例逐字节一致 + 老 web v1
     形状分叉回归。
   - **Phase 2（web，可与 1 并行——wire 契约以 spec D1「传输与重建」节冻结）**：
     assembly 纯模块（转移表测试先行）+ 双轨滚动 + touch-action 切换 +
     per-mount 锁存 + 粘贴 RPC 切换 + blank-belt lines 退役。
     硬门：vitest + build + tsc 零新增 + 转移表全覆盖。
   - **Phase 3（集成，串行）**：四象限兼容矩阵、E2E 冒烟（隔离
     HAPPY_HOME_DIR dev daemon，**别劫持生产 daemon**——B-009 先例）、
     出 ring 重连耗时实测、真机项登记 verify-queue。
4. 门禁（merge 前全部）：
   - `pnpm -C packages/happy-web-v2 exec vitest run && … vite build && … tsc --noEmit`（零新增）
   - `pnpm -C packages/happy-cli test` + `HAPPY_HOME_DIR=$(mktemp -d) node packages/happy-cli/dist/index.mjs --version`
   - server 零改动（spec 已证）——若发现需要动 server，停下改 spec 并在报告标红。
5. 发布顺序（spec 兼容矩阵）：**web → CLI tag → mac-office `vh-update`**。
   push 后 ≥20s 核对 CI headSha（铁律 7）；CLI 版本从 `git tag -l 'v0.2.*' | sort -V | tail -1` 递增。
6. 真机验不了的（滑动手感/极端刷屏/本地 attach 并存观感/CJK 宽度）登记
   docs/verify-queue.md（先 grep 最大 V 编号）。
7. 实施注意：mac-office tmux 3.6b 有 control client 退出挂起 bug——kill 兜底
   是设计一部分；可顺带建议 Owner `brew upgrade tmux`（≥3.7）但代码不得依赖。

## 明确不做（防扩权）

- 不换渲染器（B-005 另议）；不做 per-client 独立几何（「几何第三条路」
  已定稿为 enhancement 注记，本批不实现）；不做 pause-after flow control
  （v2.1 增强位）；不做 mosh 式预测回显；不动 web 侧输入路径
  （own-input/mobileInputBridge）。
- 存量 alt-屏 claude 终端回看零增益是**预期**（spec 验收明列），不要试图修。

## 交付定义

- spec 验收标准逐条对照的交付报告（自动化验了哪些、verify-queue 哪些）。
- B-121 收口 + verify-queue 登记 + spec 状态行更新 Shipped（附 merge commit）。
- 发布完成：web 已部署 happy.mereith.com、CLI 已发 npm、daemon 已 vh-update
  且 `daemon status` 显示新版本。
