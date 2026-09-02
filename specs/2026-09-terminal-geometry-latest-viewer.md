# 终端几何：window-size latest + 返回即重排（B-287）

状态：定稿（2026-09-02）。实现分支 `feat/terminal-geometry-arbiter`。
前身：本 spec 第一版设计了「daemon 侧 viewer 注册表 + 活跃度选举」，经 3 轮对抗
review 否决——注册表挂在 `TerminalSession` 上，reap/重启即丢，选举退化回「最后一个
catch-up 赢」（=原 bug 换入口），还牵出 focus 上报被当人类活动、pty 路径无法 resize、
catch-up marker 被 dedup 等一连串新问题。定稿改为**无状态**方案：把仲裁交还给 tmux，
只补上 web 缺的一条返回边沿。

## 问题（Owner 实报 2026-09-02）

1. 手机先打开某终端，再回桌面打开同一终端 → 桌面终端和手机一样窄，不重排。
2. 第一次打开 claude，输入框只画一半、左上角 logo 缺一截。

## 根因（Explore 全图 + 本机 tmux 3.7b 实证 + 对抗 review 核验）

一个 `vh-<id>` tmux 会话只有**一个** control client（daemon 的），手机/桌面/多标签
共用它；tmux 只认得一个「client 尺寸」，就是 daemon 最后一次 `refresh-client -C` 报的
值。所以几何仲裁只能发生在 daemon，语义上限就是 tmux 自己的 `window-size latest`
（最近对 tmux 说过话的人赢）。

- **症状 1** 不是仲裁策略错，而是**返回边沿缺失 + 存量会话拒绝 resize**：
  - web 端 `doFit` 只在 `ResizeObserver`/`window 'resize'`/`onResume`（可见性边沿）
    时发 `terminal-resize`。Cmd-Tab 切走再切回桌面时，标签页始终 `visible`，只是**窗口
    失焦**——`visibilitychange` 不触发，`window 'focus'` 只被 `stampLocalActivity` 消费、
    从不发 resize（`WebTerminalScreen.tsx:225-238`）。于是手机把 pane 挤窄后，桌面没有
    任何事件去重新声明自己的宽度，一直窄到用户手动拖窗口。
  - `applyResize` 对 `refresh-client -C` 去重比较 `session.cols`（乐观值）。若 tmux 拒绝
    （**v0.2.96 前创建、无 `window-size latest` 覆盖**的存量会话，或用户 `window-size
    manual/smallest`），daemon 以为已是新尺寸，之后同值请求全被吞，永不重试。
  - ring-replay 分支的 open 响应不带 `paneCols`（`webTerminal.ts:2140`），落到该路径的
    设备没有权威宽度可 adopt，只能用自己的猜测——旧设备宽度从这里泄漏。
- **症状 2**：冷恢复（daemon 启动自动恢复 B-150、归档 ↻ 恢复 B-265）硬编码 120x30 建
  会话并立刻注入 `claude --resume`（`webTerminal.ts:1959-1996`）。claude 欢迎横幅是一次性
  静态输出，第一次 web open 改尺寸后 tmux reflow 裁行、claude 不重画 → logo/框缺一截。

## 否决的方案

- **daemon viewer 注册表 + 活跃度选举**（本 spec v1）：见开头，状态随 session 生命周期
  丢失是致命伤；且它对「谁最近是人」的判断并不比 tmux `latest` 更准（都靠客户端上报
  的边沿），只多出内存、协议面（viewerId/active 透传、server 两处改）、stale/prune/TTL、
  legacy 计数，净负。
- **每个 web viewer 一个 tmux control client**：`refresh-client -C` 本身就让该 client 成为
  latest，daemon 仍要决定谁发 -C，仲裁一分不少；还每 viewer 多一个 tmux 进程 + `no-output`
  去重。复杂度只增，否决。
- **删掉 web 的 1500ms 兜底、几何全走 daemon marker**：review 实证会让 pty fallback 路径
  （无 `%layout-change`）和 catch-up 发起方（marker.seq ≤ 快照 baseline 被 dedup）永久错位，
  把 B-124 的双状态行带回来。**保留兜底**。

## 设计（无状态）

仲裁归 tmux 的 `window-size latest`；本 spec 只做四件互相独立的小事，任一单独 revert
不破坏其余。

### D1 存量会话也接受 resize（daemon）

`open()` 每次都跑的 `optArgs` 循环（create 与 reattach 都跑）追加一条
`set-option -w -q -t =vh-<id>: window-size latest`（复用 B-270 覆盖的语义）。这样
v0.2.96 前建的、或用户 `window-size manual` 的存量会话，daemon handover 后**首次 open
即被拉回 latest**，`refresh-client -C` 从此真正生效，`applyResize` 的 `session.cols`
去重不再吞掉纠正请求。`-q` 让不认识该选项的老 tmux 不因此失败。

（铁律 19：CI 的 ubuntu tmux 3.4 在 `window-size manual` 下 `new-session` 会崩 server，
真机集成测试须版本 gate；本改动只 `set-option`，不新建会话，安全。）

### D2 replay 也带权威几何（daemon）

ring-replay 分支的 open 响应带 `paneCols/paneRows = announcedCols ?? cols`
（`announcedCols` = 我们上次告诉客户端的宽度，B-124 已有）。落到 replay 的设备与落到
snapshot 的设备一样，先 adopt 权威宽度再渲染。

### D3 返回即重排（web）

终端 effect 里新增 `window.addEventListener('focus', …)` → `scheduleFit()` →
`doFit()` 发一次 `terminal-resize`（lines 模式发 proposeFit + 装 1500ms 确认兜底）。
语义：「我又开始用这台设备了」→ 把 pane 拉回本视口。tmux 已在 D1 保证接受；daemon 对
未变尺寸的 `refresh-client -C` 去重，所以本就是 owner 时是零成本 no-op。这条正是 Owner
的建议（「focus 或后台切回来时刷新 tmux 重排」）。既有的可见性边沿（`onResume`）、
`ResizeObserver`、`window 'resize'` 全部保留；`adoptGeometry` 的「focus 时反提一次」belt
也保留（两端都聚焦时防 ping-pong）。**不动**输入路径、不加 viewerId。

为什么这就够：手机挤窄是「手机最近对 tmux 说了话」的正确结果（tmux latest）；桌面窄
是因为它**回来后没说话**。补上 focus→resize 后，你切到哪台设备，哪台就在 focus 边沿
重新声明尺寸并赢下 pane——这正是 latest 语义，且完全无状态，reap/重启/socket 抖动都
不影响（没有 daemon 侧几何状态可丢）。

### D4 冷恢复按真实尺寸建会话（daemon，修症状 2）

- `LIST_SESSIONS_FORMAT` 增 `#{pane_width}`、`#{pane_height}`（置于 `pane_current_command`
  之前、`pane_title` 之前——铁律 19 的字段顺序纪律；解析器要求 12 段，短行判garbled）。
  `assistant/terminals.ts` 共用解析器，已同步。
- 该几何随 `SeenTerminalInfo` → 落盘 `LiveTerminalInfo` 快照 / `ClosedTerminalRecord` /
  `AutoRestoreCandidate` / `AutoRestorePlan` / `TerminalRestorePlan` 携带 `cols/rows`；
  `sanitizeGeometry` 容错读取（2..10000 整数，否则丢弃）。
- `createDetachedTerminal` 用 `coldCreateGeometry(plan)`：有持久化尺寸就用它建会话，
  否则回落历史默认 120x30。效果：daemon 重启自动恢复、归档 ↻ 恢复都按上次真实尺寸起
  claude，最常见的「同一台设备再打开」不再触发 reflow、横幅完整。`liveSnapshotChanged`
  纳入 cols/rows 比较（仅影响落盘判定，不进 `terminalListSignature`，不触发 daemonState
  推送，无 churn）。

### D5 兼容（铁律 4/5）

- D1/D2/D3 无新协议字段；旧 web 不发 focus resize（行为不变），旧 daemon 不认
  `window-size latest` 覆盖也无害（`-q`）。D2 的 `paneCols` 是既有可选字段，旧 web 忽略。
- D4 的 `LIST_SESSIONS_FORMAT` 是 daemon 内部读，不过线；`pane_width/height` 是 daemon
  与 web 同一批 create 的镜像发布内部约定，随 CLI 发布。
- 发布顺序：server/web 镜像 → CLI（D3 在 web，D1/D2/D4 在 daemon；daemon 需 handover，
  铁律 5/7）。存量会话要等 handover 后首次 open 才吃到 D1，符合铁律 7 推论。

## 验收

- 单测：`webTerminal.test.ts`（`parseSessionListLine` 12 段 + pane 几何容错）、
  `assistant/terminals.test.ts`（共用解析器 12 段）、`liveTerminals`/`autoRestore`/
  `terminalRestore` 尺寸透传（若有对应 test 则补断言）。
- 集成（真 tmux，隔离 socket，`webTerminal.v2.integration.test.ts`）：既有「reopen at new
  size」用例仍绿（D1 不改其行为）；补一条「存量会话 `set window-size manual` 后 open →
  resize 仍生效」（版本 gate）。
- 真机（verify-queue）：① 手机开 → 桌面 Cmd-Tab 回来即重排；② 桌面开着、手机看一眼再回
  桌面聚焦即恢复宽度；③ 冷恢复/归档 ↻ 后首开 claude 横幅完整、输入框完整。
