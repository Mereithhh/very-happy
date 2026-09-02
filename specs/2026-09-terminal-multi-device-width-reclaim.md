# 终端多设备宽度回收 + 「历史无法重排」定论（P1）

状态：已实现，纯 web。分支 `fix/terminal-width-reassert`。接 B-287/B-288/B-289
（`specs/2026-09-terminal-geometry-latest-viewer.md`、`specs/2026-09-terminal-render-integrity.md`）。

## 现象

手机先打开某终端 → 切回桌面：**当前屏是宽的，但往上滚的历史全是窄的（手机宽），
且不会自动变宽**，要「来回切换会话」才好。用户第 4 次报同一类问题。

## 两个必须分清的层

### L1 —「历史窄」不可修，是终端物理法则（不是 very-happy 的 bug）

Claude Code 用的 Ink 在折行处**写入字面量 `\n`**（ink#883 点名 Claude Code）。终端收到
的是硬换行，与「真正的段落换行」再无法区分——软/硬信息在写入那刻即被销毁。因此：

- 任何终端/多路复用器都救不了:iTerm2 / kitty / WezTerm / xterm.js 都只重排「自己软折
  的」行(靠每行一个 wrapped 标志位),对 app 打的 `\n` 无能为力;tmux 自 ~2.9 会重排自己
  的软折,同样接不回 app 的 `\n`;Warp 的块模型只覆盖 shell 命令输出的软折,**全屏 TUI 在
  块模型之外**。换 emulator、丢 tmux、ANSI 反解析全部无效。
- 每会话只有一个宽度是 PTY 物理定律:一个 pty 一个 winsize/COLUMNS。tmux/screen/zellij/
  ttyd/tmate/VSCode 共享终端**都不给「每设备各自重排」**。
- **唯一能跨设备完美重排的架构 = 不传终端网格、传结构化内容** = SDK 原生会话
  (reducer/ChatList/Markdown/ToolView,纯 CSS reflow)。终端这条路做不到,别再试。

结论:已冻进历史的窄内容**永久无法重排**;终端路径只能保证「以后新产生的、以及 live
区」用对宽度。想要跨设备完美重排的对话,用 SDK 原生会话。

### L2 —「回桌面不自动变宽」是真 bug,可修(本 spec 的实现)

根因:宽度重申只挂在**可见性/焦点边沿**——B-287 加了 `window 'focus' → scheduleFit`,
`onResume` 挂 `resumeSync` 的可见性边沿。但**两台物理设备之间切换,桌面侧不产生任何
focus/visibility 边沿**:桌面浏览器窗口从没失去 OS 焦点(用户只是扭头看手机),标签页一直
`visible`。于是手机把 `window-size latest` 的共享 pane 压到 45、桌面经 OSC-6121 把自己
xterm 也 adopt 成 45 后,**没有任何事件触发桌面重新 `proposeFit`**(容器没变→ResizeObserver
不触发;窗口没 resize;可见性没变→onResume 不触发),桌面卡在 45,直到切会话触发重挂载+重开
才按 120 重新 capture。

## 设计（`WebTerminalScreen.tsx`，纯 web）

能跨越「无边沿」的可靠信号是**用户在本设备上的真实交互**(pointer/keys),即使从没有过
focus/visibility 边沿也会发生。

1. **交互回收**:`reassertGeometry(force?)` = 读 `proposeFit()`,经纯函数
   `shouldReassertGeometry({hidden, want, current:{term.cols,term.rows}, force})` 判定后调
   `doFit()`。挂在 `mount`(即 `.term-host-inner`,xterm 的父节点)的**捕获相** `pointerdown`
   (立即探测)与 `keydown`(≤1/s 节流探测,keystroke 是热路径)。只读、绝不
   preventDefault/stopPropagation,不干扰 xterm。
2. **门控(纯函数,单测锁)**:`hidden` 标签页永不驱动宽度(防后台手机把桌面重新染窄);
   `want===current` 时不发(不与已正确的 pane 打架、不刷屏);窄设备主动交互仍会发自身窄宽
   (手机重排到自己是**期望行为**)。发出后 OSC-6121 adopt 使 `term` 与 pane 一致,后续交互即
   no-op。
3. **显式按钮**:头部 `RefreshCw`「重新适配宽度」→ `refitWidthRef.current?.(true)`(force,
   即使已匹配也重发,给用户确定反馈、也能治愈卡死的 pane);tooltip 就地解释「上方旧内容
   保持当时宽度、终端无法重排」(`terminal.refitWidthHint`)。
4. **catch-up 堵洞**:catch-up 后的 `terminal-resize` 加 `document.visibilityState !== 'hidden'`
   守卫——后台手机重连后不再重发窄宽把前台桌面染窄(reviewer BREAK 2 的类)。

## 兼容 / 发布

- **纯 web,零协议/daemon 改动**:daemon 早就处理 `terminal-resize`→`applyResize`→
  `refresh-client -C`。只走一次 web 蓝绿,**不发 CLI、不用 daemon handover**。
- 无 wire 字段,新旧端无关(铁律 4)。

## 验收

- 纯函数单测 `termGeometryReassert.test.ts`:宽设备回收=true;已匹配=false;hidden=false;
  degenerate/null=false;窄设备主动=true;force 覆盖匹配但仍守 hidden/degenerate。
- 源断言(可选,`termChannelV2.test.ts` 先例):`shouldReassertGeometry` 挂到 pointerdown/
  keydown;catch-up resize 带 hidden 守卫。
- 真机(verify-queue):手机开→桌面**点击/按键即变宽**(不必切会话);按钮任何时候能重适配;
  后台手机不再把桌面染窄;**旧窄历史仍窄(预期,L1,tooltip 已解释)**。
