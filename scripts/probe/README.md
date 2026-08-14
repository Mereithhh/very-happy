# scripts/probe —— 对着真站跑的 CDP 探针脚本

非 CI，按批手跑。跑的是**真站 + 真终端**，所以每个脚本都必须自己负责清理。

## term-input-goldendiff.mjs —— 按键 golden 差分

终端输入路径改造（`specs/2026-08-terminal-input-ownership.md`）从 Step 1 推进到
Step 3 的**硬门**：同一个终端、同一构建，`?input=xterm` 与 `?input=own` 各跑一遍
按键扫描表，比对写进 PTY 的字节。**逐字节一致才算通过**（spec §风险 R3、§验收标准）。

```sh
node scripts/probe/term-input-goldendiff.mjs            # 真站扫描（默认 happy.mereith.com）
node scripts/probe/term-input-goldendiff.mjs --selftest # 离线自测，不开浏览器、不碰终端
node scripts/probe/term-input-goldendiff.mjs --help     # 全部选项
```

首次跑（专用 Chrome profile 里还没登录）：
`VH_USER=... VH_PASS=... node scripts/probe/term-input-goldendiff.mjs`
（凭据在 rbw 的 `happy.mereith.com`；profile 会记住登录态，之后不用再给。）

**退出码**：`0` 全一致 · `1` 有不一致 · `2` 跑不出结论（通道死 / 两条路径没真的分叉 /
终端没连上 / DECCKM 稳不住）。**2 绝不当 0 用** —— 这套工具最大的风险是假绿，不是漏报。

### 扫描表（71 项 × DECCKM on/off = 142 用例）

| 组 | 项数 | 内容 |
|---|---|---|
| function | 12 | F1–F12 |
| arrow | 16 | ↑↓←→ × {无, Ctrl, Shift, Alt} |
| nav | 7 | Home / End / PageUp / PageDown / Insert / Delete / Backspace |
| ctrl-letter | 26 | Ctrl+a … Ctrl+z |
| ctrl-punct | 6 | Ctrl+`[` `]` `\` `^` `_` Space |
| tab / control | 4 | Tab / Shift+Tab / Enter / Escape |

DECCKM（应用光标键）用 `term.write('\x1b[?1h' / '\x1b[?1l')` 本地切，**每个用例前都
复核一次**（远端重绘会把它打回去，见下）。

### 它消费的契约（Step 1 提供，脚本不改产品代码）

1. `?input=own` / `?input=xterm` 一次性覆盖输入路径（默认 xterm）。
2. `debugMode` 下页面挂 `window.__vhTermInput = { routed:[], emitted:[] }`（环形 200），
   `emitted` = 实际写入 PTY 的字符串。脚本自己会把这个 profile 的 `debugMode` 打开。

契约没上线时：`--reader=ondata` 用 `term.onData` 兜底把工具本身跑通
（⚠️ 只看得见走 xterm 编码器的字节，**不能当门**），`--selftest` 用注入的假读取器
离线验证扫描表 / 差分 / 退出码 / 噪声过滤。

### 纪律：测试终端必须清干净

脚本**新建一个专用测试终端**跑扫描，`finally` 里 `tmux kill-session -t vh-<id>` +
写墓碑 `~/.happy/terminal-tombstones.json`（Owner 被"测试终端复活"坑过）。SIGINT 也清。

开跑前会把终端压成**字节水槽**：`stty raw -echo -isig -ixon; cat > /dev/null`。
raw 模式下 Ctrl+C/D/Z/S 只是普通字节 —— 扫描表里的危险键杀不掉 shell、挂不起、
Enter 也执行不了任何东西。`--no-prep` 关掉这层保护（不建议）。

### 血泪（改脚本前先读，每条都是实际踩过的）

- **选择器会点到别人的终端**：`/terminal` 选择器上「机器」组（点=新建，带 `fresh=1`）
  和「已打开的终端」组（点=打开别人正在用的）**都能被机器名 match 到**。2026-08-14
  首次冒烟就把一个活了两天的真终端当成自己建的给 kill 了。现在有三道闸：取第一个候选、
  钩 `history.pushState` 硬断言跳转带 `fresh=1`、断言 id 不在点击前的 tmux 快照里；
  清理时再查一次快照，拒绝杀"开跑前就存在"的会话。
- **headful 失焦 ⇒ `dispatchKeyEvent` 被静默丢弃**（composition 却照常送达）。开跑前
  `Page.bringToFront` + `Emulation.setFocusEmulationEnabled` + **探针键断言 emitted 有增长**。
- **down/up 的 keyCode 必须配对**，否则按键状态残留污染后续用例。
- **终端页 `Page.reload` 会卡在 beforeunload 上**（closeGuard 的 ⌘W 保护）。全程不 reload，
  切 `?input=` 一律开新 tab，并挂 `Page.javascriptDialogOpening` 自动处理。
- **每次路由变化后重取探针**：WebTerminalScreen 会 remount，握着死实例测出来的全是假的
  （症状之一：`term.write` 的 callback 照常回调，但 DECCKM 死活设不上）。
- **DECCKM 会被远端输出打回去**：tmux/应用重绘带着状态恢复序列，71 个键的长跑必撞
  （7 个键的短跑撞不到）。所以模式是每个用例前确认、必要时重设，按键后再复核。
- **app 层快捷键会吃掉终端键并夺走焦点**：不处理的话之后每个键都打进空气，报告上表现为
  "53 个用例两边都是空串"的假一致。现在当场 Esc + 重新聚焦，并把该用例标成"被 app 层消费"。
- **终端自动回复会混进采样**：OSC 10/11 颜色回报、DA/DSR、DEC 1004 焦点上报都会写进 PTY，
  但不是按键产物（实测把一条本该一致的用例报成了差异）。整条纯回复会被丢掉并计数。
- **JSON 里看不见 `\x7f`**：`JSON.stringify` 不转义 DEL，直接看会把 Backspace 的 `\x7f`
  看成空串（照这个判错过一次）。落盘的每行都额外带一份 `escaped`。
- 不碰 `clipboard.readText`（弹权限框冻结 renderer）。

### 已知盲区（这套差分兜不住的）

（下面这条盲区里的「点击焦点交接」现在有专门的脚本，见本文件末尾
`term-focus-handoff.mjs`。）

- **可打印字符与 IME**：扫描表只有非文本键。P7 那条腿（输入域 → `input` → diff → PTY）、
  死键、Option 字符、中文合成一概没测，那是 `term-input-replay.mjs` 五场景的活。
- **粘贴 / 复制 / 拖放**：独立于按键表，spec 另有一张粘贴矩阵。
- **⌘ 组合与 app 快捷键（P0/P2）**：故意不测 —— 它们本来就不该进 PTY，两条路径都"没有
  字节"是平凡一致，测了也说明不了问题（Ctrl+J/K 这种被 app 吃掉的会单独列出来）。
- **修饰键的组合爆炸**：只覆盖方向键 ×4 修饰；F 键带修饰（Shift+F1、Ctrl+F5…）、
  Ctrl+Shift+字母、keypad（applicationKeypadMode）都没在表里。
- **布局依赖**：`Ctrl+^` / `Ctrl+_` 用的是 US 布局的物理和弦（Ctrl+Shift+6 / Ctrl+Shift+-）。
  非 US 布局下这两条无意义。（顺带：本构建上这两个和弦里的 `Ctrl+^` 一个字节都没发。）
- **时序 / 连打 / repeat**：一次一个键、键间等 140ms。按住不放的 `repeat`、连打时的
  合并与竞态、以及"一次 keydown 只能产生 ≤1 次 emit"（spec R4）都不在这张表里。
- **只在 macOS + Chrome 上验证过**。Linux/Windows 的修饰键语义（Ctrl+Shift+C/V 剪贴板、
  ⌘→Ctrl 的整体位移）会得出不同的 golden，需要各自跑一遍。
- **两条路径同时坏成一样**不会被发现 —— 差分只保证"没有回归"，不保证"编码正确"。
  绝对正确性还是得靠人眼看 golden 值（或将来换纯 TS 编码表时拿这张表当迁移护栏）。

### 顺带查出来的产品问题（不是工具问题）

- `CommandPalette.tsx:99` 与 `NotesDock.tsx:59` 的快捷键匹配器都写成
  `e.metaKey || e.ctrlKey`，于是 **macOS 上 Ctrl+K / Ctrl+J 永远到不了终端**
  （Ctrl+K = readline kill-line，Ctrl+J = 换行/accept-line，都是真实终端键）。
  Ctrl+K 会弹出命令面板并夺走焦点，Ctrl+J 静默吞掉。Linux/Windows 上 Ctrl+K/J
  作为 app 和弦是合理的 ⇒ 修法多半是 `isMac ? metaKey : ctrlKey`。

## term-focus-handoff.mjs —— 点击后的焦点交接（`?input=own` 的最高真机风险）

自有输入元素是 `pointer-events:none`（不能挡住光标附近的拖选，spec §R6），所以点终端
画面仍然走 xterm 自己的 `mousedown → term.focus()` → **helper textarea 拿到焦点**；
此时安全带会把真实按键全部否决 = **光标看着还在、打字全哑**。实现靠 root 上的
`focusin` 把焦点弹回 `.vh-term-input` 自愈（`termInputHost.ts` 的 `onFocusIn`）。

```sh
node scripts/probe/term-focus-handoff.mjs        # 5 个位置各点一次
```

每个位置：先 `blur()` 丢掉焦点 → 点击 → 断言 `document.activeElement` 是
`.vh-term-input` → 发一个可打印键与一个方向键，断言 `__vhTermInput.routed` 有增长且
`emitted` 是期望字节 → 最后打一份 `__vhTermDiag.snapshot()`（看 `focusOwner` 是不是
`'terminal'`；报成 `'other'` 说明 `classifyFocusHolder` 的 class 兜底那层漏了）。

终端的新建/清理与三道闸**直接复用** `term-input-goldendiff.mjs` 导出的函数
（取第一个候选 + 硬断言 `fresh=1` + 断言新 id 不在开跑前的 tmux 快照里；清理时拒绝杀
开跑前就存在的会话）—— 这套闸只能有一份实现，不许各抄一遍。

退出码：`0` 全通过 · `1` 有断言失败 · `2` 跑不出结论。
