# 没有 tmux 的机器上的网页终端

> 状态：Shipped（commit `a36964b4`，web 2026-09-23 上线，CLI v0.2.148）
> 日期：2026-09-23 ｜ 关联 backlog：B-486 ｜ 出处：Chuhui XUE 实报（SageMaker HyperPod 开发机，录屏）

## 背景

Chuhui 在一台新连的 HyperPod 开发机上开网页终端，终端能用，但一分多钟后从侧栏消失，终端本身还在跑。
这台机器的 daemon 是 0.2.147（最新），机器在线；镜像里没有 tmux。

## 目标

1. 没有 tmux 时开出的直连 shell 出现在跨设备终端列表里，关掉之前不消失。
2. 在打开的终端上、以及新建终端之前，明确告诉用户这台机器没有 tmux、后果是什么、怎么装。
3. 用户装好 tmux 后，新开的终端不需要重启 daemon 就能用上 tmux（重启 daemon 会杀掉所有直连 shell）。

## 非目标

- 不让直连 shell 跨 daemon 重启存活（没有 tmux 就做不到）。
- 不替用户装 tmux；不改 tmux 可用时的任何路径。
- 不给直连 shell 做 tmux 那套标题跟随和 agent 状态探测。

## 现状事实（代码已确认，基线 origin/main `36e807cd2`）

| 事实 | 位置 |
|---|---|
| 推送的终端列表只来自 tmux `list-sessions` | `happy-cli/src/terminal/webTerminal.ts` `buildTerminalList` → `listSessions` |
| 没有 tmux（或 `new-session` 失败）时 `open-terminal` 退回直连 pty，不经过 tmux | 同文件 `open()` 中的 `No-tmux fallback: unchanged v1 pty path` 分支 |
| 网页新建时先插入乐观行，60 s 内没有推送确认就删掉 | `happy-web-v2/src/sync/terminalPushOps.ts` `CREATE_OVERLAY_TTL_MS = 60_000` |
| 空闲回收会 detach 无人观看的会话；对直连 pty 来说 detach 就是杀掉 shell | `webTerminal.ts` `reapIdle` / `detach` / `SESSION_IDLE_MS` |
| `killSession` 只认 tmux：没有 tmux 时 `kill-session` 报错，关闭返回 false | `webTerminal.ts` `killSession` + `tmuxKillVerified` |
| tmux 可用性每个 daemon 进程只探测一次并永久缓存 | `webTerminal.ts` `isTmuxAvailable` |
| 每个 open 响应都带 `tmuxSession`，直连 pty 时为空（新旧 daemon 都一样） | `webTerminal.ts` `open()` / `linesResponse` |

三条合在一起就是这次的现象：列表里没有 → 乐观行 60 s 后过期 → 「消失」。

## 设计

**daemon（CLI）**
- `TerminalSession.direct = {cwd, createdAt, title?, manual?, tags?}` 只在直连 pty 分支设置；title 取 headless 屏幕上的 OSC 标题（经 `deriveAutoTitle` 过滤，与 tmux pane_title 跟随同规则），用户改名（`manual`）后不再被 OSC 覆盖；改名、打标签存在 daemon 内存里。
- `buildTerminalList` 在 tmux 列表后追加 `directTerminalItems(...)`（纯函数，`terminal/directTerminals.ts`）：tmux 已列出的 id 不重复，每行带 `direct: true`。
- `reapIdle` 跳过直连会话，因为回收它等于杀掉用户的 shell。它们现在会列出来、可以关闭；上限仍由 `enforceCap` 兜底（48）。
- `killSession` 遇到直连会话：写关闭记录、detach（即结束 shell）、写 tombstone、刷新列表，不调用 tmux。
- tmux 缺失的结论只缓存 30 s（`TMUX_MISSING_REPROBE_MS`），之后重新探测；找到后永久缓存，并清掉 env-flag、版本缓存。
- `daemonState.terminalHost = {tmuxAvailable, tmuxVersion?, detectedAt}`：连接时写，每次推送列表时也写。列表签名带上 tmux 可用性（`hostListSignature`），可用性变化时即使行没变也会推送一次。

**web**
- `MachineTerminal.direct` / `TerminalSession.direct` 透传，只认字面量 `true`；侧栏行显示「临时」标记和说明（复用 `sb-row-restored` 的安静样式）。
- 终端页：open 响应里没有 `tmuxSession` → 表头下方显示一条可关闭的提示，带安装命令（brew / apt / conda 免 sudo）。判断只依据 open 响应，所以对**旧 daemon 也生效**。
- 新建终端对话框、终端机器选择页：`tmuxMissing(daemonState)`（这次 daemon 运行写入的 `tmuxAvailable === false`，旧值和旧 daemon 视为未知，不提示）→ 提前说明。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 daemon | 列表仍会消失（需要新 CLI）；终端页提示照常出现（依据 open 响应）；对话框不提示（没有 `terminalHost`） |
| 旧 web + 新 daemon | 直连行出现在列表里，旧 web 忽略 `direct`，显示成普通终端；`terminalHost` 被忽略 |
| 新 + 新 | 完整行为 |

新增字段全部是可选的，server 不解析 daemonState。发布顺序照常：server/web → CLI；回滚点分别为上一个 web release 和 CLI 0.2.147。

## 风险

1. 直连 shell 不再被空闲回收，可能长期占用 pty → 已列出且可关闭，`enforceCap` 仍兜底 48 个。接受。
2. tmux 缺失时每 30 s 多一次 `tmux -V` 探测 → 可以忽略。
3. `live-terminals.json` 快照里会有直连会话；daemon 重启后它们记成 `daemon-gap` 关闭记录，这是如实的记录。自动恢复在没有 tmux 时本来就不跑。

## 验收标准

- [x] 没有 tmux 的 daemon：open 后 `buildTerminalList` 含该 id，且带 `direct: true`（`webTerminal.direct.test.ts`，变异验证过）。
- [x] 无人观看且空闲超时的直连会话不会被回收；没有 tmux 时可以从侧栏关闭，并留下关闭记录。
- [x] tmux 装好后 30 s 内 `tmuxRuntimeInfo()` 变为可用，不需要重启。
- [x] web：推送的直连行在乐观行过期后仍在（`terminalPushOps.test.ts`）；`tmuxMissing` 遵守信任规则。
- [x] 终端页两条 open 路径都会设置直连状态（源码断言 + mutation-check）。
- [x] 真实浏览器（css-probe，Chromium）：提示条在亮/暗、1000/390/320px 下无横向溢出；「临时」复用 `sb-row-restored` 样式。

## 留真机验证项

已转 `docs/verify-queue.md` V-160。

- 在一台真正没有 tmux 的 Linux 机器上（HyperPod / DSW 镜像）走完整流程：开终端 → 1 分钟后仍在侧栏 → 装 tmux → 30 s 后新开终端变成持久终端。
