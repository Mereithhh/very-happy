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

## term-sendkeys-bytecmp.mjs —— pane 侧字节捕获对跑（B-121 写入端硬门）

终端通道 v2（`specs/2026-08-terminal-channel-v2.md` §D1b）的**硬门**：daemon 写入端
从 `pty.write()` 换成 tmux `send-keys` 命令化之后，**pane 侧真正落到程序 stdin 的
字节**必须与现状一致。

> ⚠️ **为什么不能拿上面那个 goldendiff 当门**（spec 盲审 A3）：它比的是 web 侧两条
> 输入路径的 `emitted`，而这两条路径在 daemon→pane 那一段走的是同一个
> `daemon.write()` —— **恒等 = 假绿**。v2 换掉的正是那一段，所以比对面必须挪到
> pane 侧。

```sh
node scripts/probe/term-sendkeys-bytecmp.mjs             # 完整 142 用例（约 2.7 分钟）
node scripts/probe/term-sendkeys-bytecmp.mjs --normalize # 打开 Home/End 键名归一
node scripts/probe/term-sendkeys-bytecmp.mjs --keep-prefix
node scripts/probe/term-sendkeys-bytecmp.mjs --filter 'Ctrl' -v
```

**退出码**：`0` 全一致 · `1` 有差异 · `2` 跑不出结论（子集跑、用例数不是 142、
control 通道报错、两边都空超过 20%）。**2 绝不当 0 用**，同上面那条纪律。

### 怎么比

4 条泳道 = 2 条写入端 × DECCKM 两态，各自一个**隔离** tmux 会话：

| 泳道 | 写入端 | 等价于 |
|---|---|---|
| attach | node-pty 起 `tmux attach-session -d`，`pty.write(bytes)` | v1 现状（`webTerminal.ts` 的 `write()`） |
| sendkeys | `tmux -C attach-session`（control mode，pipe）+ `encodeSendKeys()` 命令行 | v2 |

pane 压成**落文件**的字节水槽（`stty raw -echo -isig -ixon; cat > <file>`——goldendiff
那边是 `> /dev/null`，这里必须落盘才能比对），逐用例采样新增字节，**逐字节比对**。

142 条输入字节序列**直接 import** `term-input-goldendiff.mjs` 的 `buildScanTable()`
（71 项）与 `refEncode()`（用例 + DECCKM → VT 字节）——**这套表只能有一份实现，
不许各抄一遍**。repo 里没有落盘 golden，字节由 `refEncode` 现算；它在这里只是
**激励生成器**，不是期望值（期望值永远是"另一条路径收到的字节"）。

### 隔离纪律（本机是 mac-office，默认 socket 上是生产）

所有 tmux 调用都经脚本里的 `tx()` 强制注入 `-L b121-p0b`，一次都不碰默认 socket 上
Owner 的生产 daemon 与真实 `vh-*` 工作会话。`finally` 与 SIGINT 都 `kill-server`。

### 血泪（三条都是第一轮实跑换来的，改脚本前先读）

- **v1 的 attach client 不是透明字节管道**：它把字节**解成键、再按 pane 的
  模式/terminfo 重新编码**。所以 DECCKM 必须**在 pane 上真的对齐**（deckm=on 的
  泳道水槽写成 `printf '\033[?1h'; cat > f`，并用 `#{keypad_cursor_flag}` 断言），
  否则喂 `ESC O A` 会被重编码成 `ESC [ A`，凭空造出十几条"差异"，全是 harness 自己的锅。
- **孤立 ESC 在旧路径上迟到约 500ms**（tmux client 的 partial-key 超时；实测 400ms
  还没到、1000ms 到）。采样的静默窗口必须比它长，否则 ESC 漏进**下一条用例**的
  样本，一错错一串（症状：`off|Escape` 空、`on|F1` 多一个 `1b`）。现在 attach 泳道
  750ms、sendkeys 泳道 250ms。慢是应该的——这是硬门，不是 CI。
- **tmux 默认 prefix `C-b` 会吃掉扫描表里的 `Ctrl+b`**，还会把紧随其后的键当 tmux
  命令解释（可能开窗/detach 污染整轮）。默认两条泳道都 `set prefix None`；
  `--keep-prefix` 用来复现并量化那条差异。

### 首轮结果（2026-08-17，mac-office，tmux 3.7b，Node v26.7.0）

- 默认（spec 定稿的三通道）：**138/142 一致，4 条差异，exit 1**。差异全在 Home/End：
  web 发 `ESC[H`/`ESC[F`（DECCKM 态 `ESCOH`/`ESCOF`），v1 的 pane 收到 tmux 编码的
  `ESC[1~`/`ESC[4~`，v2 原样注入收到 `ESC[H`/`ESC[F`。
- `--normalize`（打开 `encodeSendKeys` 的 `normalizeKeyNames`，这 4 条序列改发 tmux
  键名 `send-keys -t <pane> Home`）：**142/142 一致，exit 0**。
- 其余 138 条（F1–F12、方向键 ×4 修饰、PageUp/Down、Insert/Delete/Backspace、
  Ctrl+a..z、Ctrl 标点 6、Tab/Shift+Tab/Enter/Escape）两条路径**逐字节相同**。
- `--keep-prefix`（保留默认 prefix `C-b`，= 生产 `vh-*` 会话的真实配置）：
  **134/142，8 条差异** = 上面 4 条 + `Ctrl+b`/`Ctrl+c` 各两态。旧路径下 `Ctrl+b`
  被 attach client 当前缀吃掉（pane 收 0 字节），紧随其后的 `Ctrl+c` 作为「前缀后
  的未绑定键」也被吃掉；新路径下两者都原样到 pane。**这是产品可见的行为变化**：
  一方面 `Ctrl+b`（readline backward-char）在今天的 web 终端里其实是坏的、v2 修好了；
  另一方面 `webTerminal.ts` 注释里写的「深 tmux 历史仍可用键盘 copy-mode（prefix + [）
  抵达」这条逃生口在 v2 下**失效**（键不再进 tmux 客户端）。

`normalizeKeyNames` 默认关（spec §D1b 定稿写死三通道，键名归一算设计变更），开关与
实测表在 `packages/happy-cli/src/terminal/sendKeysEncoding.ts` 的
`TMUX_KEY_NAME_ALIASES` 注释里。

### 已知盲区

- 只覆盖**非文本键**（扫描表的边界）。可打印字符、IME 提交串、CJK/emoji 由
  `sendKeysEncoding.test.ts` 的纯函数用例覆盖，没在这条真 pane 链路上跑过。
- 粘贴（`load-buffer`+`paste-buffer -p`）不在这 142 里；它的 2004 包裹行为在
  spec §D1b 的实测记录与模块注释里，端到端验收另计。
- 只在 macOS + tmux 3.7b 上跑过。**3.6b 没有可用二进制**（Homebrew Cellar 只剩
  3.7b），而生产默认 socket 上的 server 仍是 3.6b 代码——`-H` 的裸字节语义、
  `0xNNNN` 码点语义在 3.6b 上未复验。
- 两条路径同时坏成一样不会被发现（同 goldendiff 的老盲区）。

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

## tmux-control-golden.mjs —— control mode 金样本录制（B-121 Phase 0a）

`packages/happy-cli/src/terminal/controlModeDecoder.ts`（tmux control mode 按字节
增量解码器）的回放样本来源。样本落 `packages/happy-cli/src/terminal/__fixtures__/controlmode/`，
测试 `controlModeDecoder.test.ts` 逐字节回放 + 随机切分点重放。

```sh
node scripts/probe/tmux-control-golden.mjs                    # record + bless 全部
node scripts/probe/tmux-control-golden.mjs record --only cjk  # 只重录一个场景
node scripts/probe/tmux-control-golden.mjs bless              # 按现有 .bin 重算 expected
node scripts/probe/tmux-control-golden.mjs --list
```

### 每个场景三个文件

| 文件 | 内容 | 谁产生 |
|---|---|---|
| `<name>.bin` | control client stdout 的**原始字节** | tmux |
| `<name>.truth.json` | 录制环境 + **与解码器无关**的断言（喂进 pane 的确切字节 sha、必须出现的标记、块形态） | 录制脚本 |
| `<name>.expected.json` | 事件摘要（回归基线） | 解码器自己 |
| `<name>.embedded.bin` | 喂进 pane 的确切字节（binary/cjk 场景） | 录制脚本 |

`.expected.json` 是解码器算的 —— 单看它等于自证。所以 **`bless` 只在 `.truth.json`
的独立断言全过时才肯写**（binary 场景的 2048 字节 urandom 必须在解出的输出里**连续
原样**出现；burst 场景 1..5000 必须按序全在；altscreen 必须有 `\033[?1049h/l`；
commands 必须有 `%error` 块、块体里的假 `%end 1 2 3` 必须没有提前关块、块体里必须有
**裸 ESC**）。真正的回归价值来自「同一 `.bin` 任意切分点重放结果必须一致」。

### 场景

| 场景 | 覆盖 |
|---|---|
| `shell` | 普通会话、prompt 重绘、SGR、tab |
| `cjk` | 中文/emoji（含 tmux 把多字节切在两条 %output 之间的真实情况） |
| `altscreen` | less 进出 alt 屏，`\033[?1049h/l` 原样透传 |
| `burst` | `seq 1 5000`，合并 %output 与长行 |
| `binary` | 2048 字节 urandom，非法 UTF-8 不被破坏 |
| `commands` | capture-pane / list-panes / refresh-client / %error 块 / 块体内假 `%end` / 块体裸 ESC |
| `claude-tui` | 真实 claude TUI 片段（不提交 prompt、不调 API），含 DA/DSR 查询序列 |

### 字节精确的前提：`stty raw` 必须和载荷同一行

`stty raw -echo; cat x.bin; stty sane` —— 交互式 bash/sh 每次出提示符都会把 termios
按 readline 的意思重设，**单独一行的 `stty raw` 在载荷命令跑之前就被撤销了**。同一行
才能让 OPOST 关着（无 LF→CRLF 翻译）跑完载荷。

### 纪律：隔离 socket

全程 `tmux -L b121-p0a`，**绝不碰默认 socket 上的生产 `vh-*` 会话**（mac-office 上跑着
Owner 的生产 daemon 和真实工作会话）。`finally` 与 SIGINT 都 `kill-server`。

### 版本注记

样本录自 **tmux 3.7b**（客户端 3.7b，隔离 socket 上的 server 也是 3.7b）。默认 socket
上的现役 server 仍是 3.6b 代码，3.6b 二进制已不在本机；主 agent 2026-08-17 用 3.6b
现役 server 与 3.7b 隔离 socket 双跑同一批命令，**协议行结构逐行一致**（只有 session/
pane/命令编号不同）。解码器不得依赖任何版本特有形状。

### 血泪

- **`flags` 不是「greeting 标记」**：`cmd-queue.c` 的 `flags = !!(state->flags &
  CMDQ_STATE_CONTROL)`，而 `CMDQ_STATE_CONTROL` 只在 `control.c:control_read_callback`
  （命令来自本 client 的 stdin）设置。所以 flags=0 的块除了 attach greeting，**还包括
  tmux hook 触发的命令块**（实测：`set-hook -g after-set-option 'display-message …'`
  会在流中间插一个 flags=0 的块）。按「下一个块配下一条命令」而不看 flags，在任何配了
  hook 的机器上都会错位。
- **块体里可以出现长得像 `%end` 的行**：`set-buffer -b g "before\n%end 1 2 3\nafter"` +
  `show-buffer` 实测复现。只能按 (epoch, cmdNum) 精确配对。
- **两种编码并存**：`%output` 载荷是八进制转义（`<0x20` 与 `\` 转成 `\ooo`，`>=0x80`
  原样），`%begin` 块体是**裸字节**（ESC 不转义）。`capture-pane -C` 的转义规则与
  `%output` **逐字节相同**（`cmd-capture-pane.c:93` 与 `control.c:control_append_data`
  同一条判据），所以 `unescapeOctal()` 一份实现两处用。
- **行尾是裸 LF 不是 CRLF**（管道传输，tmux 用 `EVBUFFER_EOL_LF` 读写）。
- **向 control client 的 stdin 写空行 = detach**：脚本的 `send()` 里有硬断言挡着。
