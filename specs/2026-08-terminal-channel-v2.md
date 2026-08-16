# 终端通道 v2：tmux control mode 内容流（根治移动端滚动不跟手）

> 状态：Draft v3（R2 修 R1 自引入的 2 BLOCKING + capture -a 语义实证反转：历史改走
> **machineRPC 分页**（server 零改动回归）+ **二段式打开**（秒开当前屏→历史后台拉齐→
> 原子重建）；丢弃规则限 fresh-spawn；capture 按 alternate_on 三段分支；粘贴走新
> terminal-paste RPC 与 send-keys 同 FIFO；reaper/cap 平移；7 MUST-FIX 全采纳。待 R3）
> 日期：2026-08-17 ｜ 关联 backlog：B-121 ｜ 出处：Owner 实报手机滑动不跟手 → 三层方案 Owner 拍板直接根治

## 背景

现状 web 终端 = daemon 里 node-pty 起 `tmux attach-session -d` 全屏镜像客户端。
xterm 恒处 alternate screen、本地零 scrollback，一切回看滚动都要走
`terminal-scroll` RPC 跨洋往返驱动 tmux copy-mode（手机上 touch→合成 wheel→
60ms 批→RPC→copy-mode→全屏重绘回流，固定 ~200ms 延迟、无惯性、串行排队）。
「跟手」在此架构下物理不可达。

v2：把通道从「全屏镜像」换成「内容行流」——daemon 起 **tmux control mode
客户端**（`tmux -C attach`，pipe 非 pty），把 pane 的真实输出流喂给 xterm，
xterm 拥有本地 scrollback。滚动/惯性/选择/搜索全部本地化，镜像批之外的
最后一块移动端体验短板拔除。

## 目标

- 手机/桌面滚动回看 = xterm 本地 scrollback + 浏览器原生触摸滚动（像素级跟手、系统惯性）。
- 保持既有产品语义不变：多设备同看、终端持久化（tmux session 存活）、
  agentState 探测、@vh_title 跟随、镜像 B-105/107、快捷指令 B-013、
  startupCommand、tombstones 防复活、closedTerminals。
- `terminal-scroll` RPC 退役（新链路不再需要；保留 daemon handler 供老 web）。
- 顺带收益：`@xterm/addon-search` 搜索（B-037 解锁）、PTY 上限约束消失
  （control client 走 pipe 不占 /dev/ptmx——现状 MAX_LIVE_PTYS=24 是
  kern.tty.ptmx_max~511 逼出来的）。

## 非目标

- 不换渲染器（ghostty-web/Restty 仍归 B-005，renderer seam 不动）。
- 不做 per-client 独立几何（tmux window 单尺寸是根约束，v1/v2 相同，照搬
  window-size=latest 语义）。
- 不做 mosh 式预测回显（输入延迟不是本批问题）。
- 不动 **web 侧**输入路径（own-input/mobileInputBridge 依赖的是 xterm helper
  textarea 与 VT 编码器，不依赖通道形态）。⚠️ daemon 侧写入端**必须**重写
  （无 pty 可写，改 send-keys 命令化）——见 D1b，这不是可选项。

## 现状事实（代码已确认 + 本机实证）

### 代码侧（调研 agent 逐条核实，行号=当前 main）

| 事实 | 位置 |
|---|---|
| pty 命令 = `/bin/sh -c "…exec tmux attach-session -d -t vh-<id>"`；`-d` 故意踢其他 client 让尺寸跟随本 pty | `webTerminal.ts:1427-1437,1486-1489` |
| TerminalSession：pty + @xterm/headless(scrollback 5000) + SerializeAddon + 单调 seq + 2MB base64 环形缓冲；`subscribeState(fromSeq)` ring 覆盖则 replay 否则 snapshot(base64(serialize)) | `webTerminal.ts:736-853` |
| tmux 侧 `history-limit 2000`（刻意小——daemon headless 才是权威 scrollback） | `webTerminal.ts:1389,1446-1455` |
| 输出广播无 per-subscriber 概念；几何归最后 resize 的人；`resub` 不涨订阅数；socket 断开 resetSubscribers 全归零 | `webTerminal.ts:1268-1285,1573-1586,1240-1248` |
| encStream：对 base64 字符串加密，snapshot/replay/live 三处；`terminal-activity` 刻意明文 | `apiMachine.ts:154-169,220-225,294-316` |
| web 滚动劫持只在 `tmuxAttached && buffer.active.type==='alternate'`；60ms 批 + 串行 RPC + 3 败退避；移动端 touch→12px 阈值→合成 WheelEvent | `WebTerminalScreen.tsx:849-922,1080-1129` |
| `.term-host { touch-action: none }` 是合成 wheel 的前置（主动放弃原生滚动）；select-mode 靠覆盖它实现 | `terminal.css:86-100` |
| agentState 零 subprocess 快路径 = 直接读 daemon headless buffer 尾 40 行 + `pty.process` 当 pane_current_command；冷 session 才 spawnSync tmux | `webTerminal.ts:808-824,1728-1757` |
| @vh_title 实时链路 = `set-titles on` 让 tmux 把 OSC 重发给 attach client → headless onTitleChange → kickListRefresh；另一半靠 10s list 轮询 `#{pane_title}` | `webTerminal.ts:774-780,1399-1406,1521-1526` |
| B-013 粘贴走 xterm `term.paste()`（web 侧）与 tmux load-buffer/paste-buffer -p（daemon/assistant/镜像输入条侧）双路径 | `WebTerminalScreen.tsx:1456-1466`、`assistant/terminals.ts:119-131` |
| startupCommand 只在 `new-session -d` 退出码 0（原子「我创建的」判据）时注入；tombstones/attachOnly 防复活契约字符串 `terminal-gone` | `webTerminal.ts:1325-1369,1287-1316` |
| termStreamSync 三事故与两铁律：snapshot 后 baseline 必须 ASSIGN（daemon 重建 seq 从 0 重启）；gap chunk 拒写（tmux delta 重绘丢块=永久错位）→ catchUp | `termStreamSync.ts:1-44,82-101` |
| termWriteHold：选择期间冻结输出（xterm 选区是 buffer 坐标，重绘毁选区）；chunk 边界必须原样保留（xterm UTF-8 解码器跨 write 有状态） | `termWriteHold.ts:1-12,35-51` |
| renderer 纯 DOM xterm（无 webgl/canvas addon），`scrollback:5000` 现状只对 no-tmux fallback 生效；termMouseModeFilter 吞 DECSET 鼠标模式、放行 47/1047/1049/2004 | `xtermRenderer.ts:16-43`、`WebTerminalScreen.tsx:856-857`、`termMouseModeFilter.ts:19-97` |
| blank-screen belt 的判据前提（「tmux 总画状态栏」）与 daemon `status off` 现状矛盾——现在就靠 attach 全屏重绘掩盖 | `WebTerminalScreen.tsx:924-938` vs `webTerminal.ts:1390-1398` |
| MAX_LIVE_PTYS=24 / PTY_IDLE_MS=20min / reaper 5min；pty 被 reap 后重开 = 新 session、seq 从 0 | `webTerminal.ts:204-238,1199-1238` |
| 老 app（happy-app）存在同协议第二消费者；daemon ≥0.2.27 list push、≥0.2.29 attachOnly 是既有兼容地板 | `packages/happy-app/...`、`terminalPushOps.ts:15`、`ops.ts:336-341` |
| utils/tmux.ts（上游遗留）与 webTerminal 互不相干；全仓无 control mode 实现；`pipe-pane` 注册过名字零调用 | `tmux.ts:26-33,70,316-317` |

### tmux 3.6b control mode 本机实证（mac-office，隔离 socket，2026-08-17）

| 实证 | 结论 |
|---|---|
| `tmux -C attach -t X` 经 **pipe**（非 pty）工作；协议 = `%begin/%end` 包裹命令输出 + `%notification` 异步通知，同一条 stdout，**顺序即权威顺序** | 天然同步点：attach→缓冲 %output→发 capture→%begin 前到达的 %output 已含于 capture（丢弃），%end 后的是纯增量 |
| `%output %<pane> <data>`：控制字节 octal 转义（`\033 \015 \012 \010`、反斜杠=`\134`），**UTF-8 多字节原样透传**（中文实测） | 解码器只需 octal unescape，无 UTF-8 拆装 |
| `%begin/%end` 块内命令输出（如 capture-pane -e）是**裸字节**（ESC 不转义）——与 %output 两种编码并存 | 解析器按上下文切换 |
| pane 内应用发 OSC 2 标题：**原样出现在 %output 流里**（`\033]2;标题\007`） | @vh_title 实时链路不死反而少一层中转；daemon headless 与 web xterm 都能原生 onTitleChange |
| alt-screen 进出（`\033[?1049h/l`）原样透传（less 实测） | TUI 全屏重绘进 xterm alternate buffer，**scrollback 不被污染**，退出自动回主 buffer——方案成立的命门 |
| `refresh-client -C 100x30` 生效（%layout-change + TUI reflow 实测）；window-size latest/smallest/largest 多 client 实测符合语义 | resize 与多设备语义照搬现状（共享几何，latest 赢） |
| 5000 行 burst → 44 个合并 %output（~60KB），默认无 %pause；`refresh-client -f pause-after=N` 被接受 | flow control 可选项存在；默认合并已相当温和 |
| %output 范围 = **仅当前 attach 的 session**（t2 输出对 attach t1 的 client 不可见；跨 session 只有 %sessions-changed 等元通知） | daemon 需 per-terminal 一个 control client（与现状 per-terminal pty 结构对称） |

### 外部调研关键事实（来源见调研报告；iTerm2 = 生产十年的同架构先例）

| 事实 | 含义 |
|---|---|
| 3.6b control.c：%output 只转义 <0x20 与反斜杠（\ooo 三位八进制），≥0x80 原样——**payload 不保证合法 UTF-8**（二进制输出如 cat /dev/urandom） | 解码器必须**按字节**分行/解转义，产出 bytes（→base64 直接进现有信道）；不得中途过 UTF-8 string decode |
| 向 control client 的 stdin 写**空行 = detach** | 命令写入端的硬纪律 |
| %begin/%end 三参数（epoch/命令编号/flags）FIFO 配对；块内不插通知；%end 消歧靠精确匹配参数（iTerm2 手法） | 命令通道可安全复用为 capture/set-option/refresh 的统一通路，替代散落 spawnSync |
| capture 组合（iTerm2 生产验证，直接抄）：主屏+历史 `capture-pane -peqJN -S -N`（**-J 合并折行=拿逻辑长行，xterm 按自己列宽重新 wrap，天然适配宽度差**）；alt 屏另发一次加 `-a`；未完成转义序列尾巴 `-p -P -C`；光标/DECCKM/DECTCEM/tabs 等状态用 `list-panes -F` 补 | 历史回填不只 capture 一发，是「三连 + 状态包」 |
| flow control：`pause-after` 开启后 %output→%extended-output，%pause 后数据**不补发**，continue 前必须 capture 重填——iTerm2 在这条状态机上连踩两轮（#9133 键盘失灵事故）；不开 pause 时 tmux 3.2+ 有内建公平限速 | v1 **不开 pause-after**（省掉最危险的状态机），靠内建限速 + xterm 50MB 队列上限 + ring 兜底；pause 列为后续增强 |
| 输入：iTerm2 全走 send-keys 三通道——ASCII 可打印 `send -lt`、其他码点 `send -t 0xNN`、C0 控制字节 `send -H`（3.5+ 的 0xNN C0 bug）；单命令 ≤1000 字节分片；单引号 quoting | daemon 写入端的替代方案已被生产验证 |
| pane 应用的查询序列（DA/DSR/CSI 6n/OSC 10/11）会透传进 %output，且 **tmux 已代答**——xterm.js 会在 onData 自动吐应答，回灌 = pane 应用收到重复应答 | web→daemon 的 sendInput 链必须过滤自动应答（或 daemon 侧过滤）；输入损坏类 bug 的最大来源 |
| **3.6b 现存 bug**：control client 退出时 pty 数据在队列会挂起（3.7 修）；toggle no-output 后退出挂起 | daemon 停 client 必须 SIGTERM→超时→SIGKILL 兜底；或建议升 tmux ≥3.7 |
| 不调 `refresh-client -C` 的 control client **完全不参与几何** | 「手机纯镜像不抢尺寸」成为可能（D2 候选） |
| xterm.js：write 非阻塞入队 <16ms/帧分片消化（5-35MB/s，50MB 队列上限静默丢）；reflow 仅 normal buffer（alt buffer 永无 scrollback/reflow）；一次灌几百 KB 历史毫秒级 | 历史回填性能无虞；持续洪水由 tmux 内建限速管上游 |
| tmux 与 xterm 的 Unicode 宽度裁决独立（CJK/emoji 折行可能不一致）；-J 逻辑行缓解折行差异但宽度判定仍双源 | 中文主场景必须真机专项验证 |

## 设计（Draft——待对抗收敛）

### D1 daemon：TerminalSession v2

- 每个 live 终端一个 **control client 子进程**：`spawn('tmux', ['-C','attach-session','-t','vh-<id>'], {stdio:'pipe'})`
  ——非 pty，不占 ptmx。`-d` 不再需要（control client 不参与尺寸竞争，尺寸经
  `refresh-client -C WxH` 显式声明）。
- **ControlModeDecoder（新纯函数模块，vitest + 金样本）**：**按字节**解析
  stdout（%output payload 不保证合法 UTF-8）——`%begin/%end` 块按（epoch,
  命令编号）FIFO 配对路由到命令 promise 队列（同一连接跑 capture/set-option/
  refresh-client，替代散落 spawnSync）；`%output %<pane>` octal-unescape 后
  产出 **bytes**（→base64 直接进现有 ring/信道，不过 UTF-8 string）；
  `%layout-change/%exit` 等路由到生命周期；greeting 空块排除在 FIFO 配对外
  （N5）；超长 %output 行**拆分为多个连续 chunk 完整 ingest**（R2 M-R2-7：
  截断丢字节=撕裂转义序列，termWriteHold「chunk 边界原样保留」同族铁律；
  上限只管单块大小，一个字节不丢）。写入端硬纪律：
  **绝不发裸空行**（= detach）。
- **headless 权威屏保留**：同一条解码后的输出流喂 headless xterm——agentState
  零 subprocess 快路径延续。`pty.process` 的替代：`pane_current_command`
  **需要新增进 LIST_SESSIONS_FORMAT**（R1 M3 打假：现有 7 字段没有它）
  + `parseSessionListLine` 同步；降级如实写明：command 从实时值变 ≤10s
  轮询值，needs_input 判据主要靠 tail 文本不受影响，shell/idle 分类容忍。
- **单 pane 声明（R1 M6）**：%output 自带 pane id；ingest **只跟随该 window
  的首个 pane**，其他 pane（用户本地 `tmux attach` 后 split 出来的）的
  %output 丢弃——v1 镜像 tmux 合成画面（含分屏可见），v2 分屏内容不可见，
  行为变化写入验收与文档。**%layout-change → headless.resize 跟随**（R2 NIT：
  v2 不再踢本地 attach，本地改尺寸后 headless 几何须同步，否则 serialize
  与 agentProbe 折行漂移）。
- `LIST_SESSIONS_FORMAT` 新增 `pane_current_command` **必须插在 pane_title
  之前**（R2 NIT：防 0x1f 设计要求 pane_title 恒为最后一列）。
- **no-tmux fallback 保留（R1 M8）**：无 tmux 时的裸 shell pty 路径原样保留
  （含 startupCommand 直写、MAX_LIVE_PTYS/reaper 机制留守）——「PTY 上限
  约束消失」只对 tmux 路径成立。
- **seq/ring 机制原样保留**：解码后的输出块 = ingest(chunk)（seq+ring+广播），
  wire 事件 `terminal-output` 语义不变（encStream 不变）。gap→catchUp、
  snapshot-ASSIGN/replay-max 两铁律不变（行流丢块虽不再「永久错位」，但会
  丢内容——catchUp 补齐语义照旧成立）。
- **打开/快照时序（R2 重构：二段式 + fresh/running 分治）**：

  **共同底座**：capture 命令批**一次 write** 管道化（防 %output 插进应答块
  间隙——实证会发生）；greeting 空块排除在 FIFO 配对外；**capture 组合按
  `alternate_on` 分支（R2 B3 实证：无 `-a` 的 capture 返回历史+当前活动面
  ——alt 活动时那就是 alt 内容；`-a` 返回的是"另一块屏"=保存的普通屏，
  且拿不到历史）**：
  - normal 活动：历史+主屏 `capture-pane -peqJN -S -<N>` 一发；
  - alt 活动：三段拼装——历史 `…-S -<N> -E -1`（实证精确 history-only）+
    普通屏 `…-a` + `\x1b[?1049h` + 可见区（无 -a 默认范围 capture）——
    否则 alt TUI 画面灌进 normal scrollback，违反本方案命门；
  - 附 `list-panes -F`（cursor_x/y、alternate_on）+ 尾巴 `-p -P -C` +
    末尾 `refresh-client -C WxH`（SIGWINCH 重绘自愈相对光标错位；R2 实证
    该重绘落在锚点后，不被误伤）。

  **fresh-spawn（daemon 首次为该终端起 client）**：
  1. spawn → 锚点前缓冲的 %output **丢弃**（含于 capture）——丢弃规则
     **仅限本场景**（此前无人 ingest，无内容洞风险）；
  2. 锚点 = 活动绘制面那次 capture 的 `%end`；锚点后恢复 ingest；
     snapshot seq = 锚点时刻 ingest seq（=0 起点）。

  **running client（重连 / gap 出 ring / forceSnapshot——R2 B-R2-2）**：
  ingest **全程不停、一个块都不丢**（丢弃即对其他订阅者制造无 gap 信号的
  永久内容洞）；锚点仅用于**读取 seq 值** S——请求方拿到快照后以 S 为
  baseline，≤S 的 live 块自然 dedup（termStreamSync 现有 'dup' 语义）。
  daemon 对同一终端做 **capture single-flight**（M-R2-6：并发 catchUp 合并
  为一次 capture，分发各请求方）。

  **传输与重建（R2 B-R2-1：绝不走 terminal-output 广播通道）**：
  - 历史与快照经 **machineRPC 分页**下发（新 RPC `terminal-history
    {terminalId, snapshotId, page}` → `{seq, page, totalPages, data}`，
    每页 ≤256KB base64，加密照旧走 RPC 信封）——RPC 是现有通用机制，
    **server 零改动**、点对点不打扰其他设备；历史块**不进 ring、不进
    headless、不占 seq**（与 ingest 完全解耦）；
  - **二段式打开**：open 响应内嵌「当前屏小快照」（capture 可见区，
    ≤300 行级，v1 尺寸哲学）→ 秒开 + live 跟流；web 后台并发拉历史页，
    拉齐后**原子重建**（reset → 历史 → 当前屏 → 重放 assembly 期间缓冲的
    live 块）——termStreamSync 新增 assembly 状态（meta→收块→齐后 ASSIGN
    baseline）；重建对用户呈现为 scrollback 无感变深；
  - capture 字节预算 1MB（原始）截断更早历史（总量有界）。
- 生命周期：`%exit` / 进程退出 → 与现状 pty onExit 同路；**停 client 一律
  SIGTERM→2s 超时→SIGKILL**（3.6b 退出挂起 bug 兜底；spec 附注：建议
  mac-office 升 tmux ≥3.7 消根因，但代码不得依赖升级）。
  **reaper/cap 语义原样平移（R2 M-R2-5）**：每 live 终端 = 1 tmux 子进程 +
  headless(5000) + 2MB ring，无界增长不可接受——reapIdle（无订阅 20min →
  kill client，tmux session 存活）与 enforceCap 保留，cap 从 24 上调
  （不再受 ptmx 制约，具体值实现期定，建议 48）。
  tmux `history-limit` 上调至 5000（=xterm scrollback，capture 深度上限）
  ——只对新建 session 生效，存量终端历史深度不变（如实降级）。
- flow control：**v1 不开 pause-after**——%pause→capture 重填→%continue 状态机
  是 iTerm2 两轮事故重灾区；3.2+ 内建公平限速 + xterm 50MB 写队列 + 2MB ring
  已构成三层兜底。极端刷屏（yes）列入真机验证，pause 机制留作 v2.1 增强位。

### D1b daemon 写入端：pty.write → send-keys 三通道（本 spec 唯一的输入面改动）

现状 `write()` 直接 `pty.write(utf8)`；v2 无 pty，写入改经 control 命令通道，
照抄 iTerm2 生产验证的三通道分类（按码点 run-length 合并）：
- ASCII 可打印段 → `send-keys -lt <pane> -- '<literal>'`（单引号 quoting，
  内部单引号按 shell 规则拆接）；
- 非 ASCII → `send-keys -t <pane> 0xNNNN…`——**按 Unicode 码点**（R1 M5 实证：
  按字节发 0xE4 0xB8 0xAD 得到乱码 `ä¸­`，按码点 0x4E2D 才是 `中`；emoji
  0x1F600 同验）——中文输入主通道，金样本必须覆盖 IME 提交串；
- C0 控制字节（回车/Esc/Ctrl-*）→ `send-keys -H -t <pane> <hex>`（3.5+ 的
  `0xNN` C0 静默劣化 bug 的规避通道）；
- 单条命令 ≤1000 字节分片；FIFO 保序，**fire-and-forget（不等 %end）**——
  R1 实测 200 条管道化 1.9ms、串行等待中位 0.03ms，拥塞担忧证伪。
纯函数 `encodeSendKeys(text) → string[]`（vitest + 金样本：B-096 71 项按键
差分工具现成，attach vs send-keys 两通道逐字节比对作为硬门）。
**粘贴专路（R1 M4 + R2 M-R2-2 具体化）**：tmux 3.6b 无 bracketed-paste(2004)
format、attach 模式重放 v2 拿不到——pane 已开 2004 时 `term.paste()` 不知情、
多行粘贴逐行执行。修法：新 **machineRPC `terminal-paste` {terminalId, text}**
（RPC 通用机制，server 零改动；mirror-terminal-send 同款形状）——daemon 侧
经 **control 命令通道**执行 `load-buffer`（stdin 喂字节）+ `paste-buffer -p`，
与 send-keys **同一 stdin FIFO 保序**（R2 指出 spawnSync 双执行器会让
「粘贴+立刻回车」乱序——Enter 经 send-keys 先落地=空行先执行；同通道则
天然有序）。web 侧 lines 模式下粘贴/B-013 插入从 `term.paste()` 切到该 RPC；
attach fallback 分支维持 `term.paste()`。

**查询应答过滤（R1 M1 四步实证坐实，必须过滤）**：pane 查询（CSI c/6n、
OSC 10/11）tmux 无 client 也代答且原样透传进 %output → web xterm onData
自动再吐一份；v1 下 attach client 的应答被 tmux 吞掉（实测 pane 收 0 字节，
tmux 是消费者），v2 下 send-keys 注入的应答**原样进 pane stdin**（实测 7
字节全到）= 脏输入。修法：**daemon 侧过滤**——encodeSendKeys 前剥离已知
自动应答模式（CSI [>?]…c、CSI ?6n→CSI R、OSC 10/11 应答），白名单纯函数
+ 测试。R1 N2 顺带指出唯一可插进粘贴分片间的写者也是 tmux 代答，窗口极小。
- startupCommand/tombstones/attachOnly/closedTerminals/镜像注入/B-013 daemon 侧
  paste-buffer：**全部不动**（都作用于 tmux session 生命周期层，与 client 形态无关）。

### D2 web：本地 scrollback 生效

- open 响应 `streamMode:'lines'` 时**滚动双轨（R1 B3 修正——alt-screen 一轨
  不能砍）**：
  - **normal buffer（回看，95% 场景）**：不劫持 wheel、放行原生触摸滚动
    ——xterm 本地 scrollback，跟手+惯性；
  - **alternate buffer（vim / `/tui fullscreen` / 存量无 classic-env 的
    claude）**：v1 的 wheel 劫持 + touch→合成 wheel + `terminal-scroll` RPC
    **原样保留**——xterm 默认的 wheel→方向键在 claude TUI 里是「滚轮翻
    prompt 历史」的老坑（planScrollAction 的验尸注释为证），不能回归；
  - `touch-action` 随 buffer 态动态切换（xterm `buffer.onBufferChange` →
    `.term-host--alt` class；normal=原生滚动，alt=none 供合成 wheel）；
  - `termMouseModeFilter` **保留**（alt 轨的 SGR wheel 语义依赖它维持
    「应用以为没开鼠标」的现状；R1 指出退役清单漏了它的去留）。
- 历史块（snapshot 新载荷）直接 `term.write`——xterm scrollback(5000) 首次
  真正生效；`@xterm/addon-search` 顺带解锁（B-037，本批不做 UI 只留能力）。
- **三个解冻机制的重审**（现状事实里互相中和、v2 同时变活）：
  - select-mode：原生滚动下触摸手势归还浏览器后，长按选择与滚动的冲突面变化
    ——保留 select-mode toggle（语义变为「冻结输出+允许选择」），触摸滚动不再
    被它独占。
  - termWriteHold：保留（选择期间冻结输出的理由在行流下依然成立）。
  - blank-screen belt：**lines 分支退役**（R2 裁决：fresh shell 必有 prompt
    文本，误触发面大于价值；「终端存在但空」由 open meta 显式表达，前端
    不再定时器猜）。attach fallback 分支保留现状。
- 铁律 6 布局链路（fit/padding/键盘视口）不动——通道形态与 cell 测量无关。
- **几何第三条路（候选，对抗定）**：不调 `refresh-client -C` 的 control
  client 完全不参与 window-size——手机端可默认「纯镜像不声明尺寸」（以 tmux
  实际宽度渲染 + fit 缩字号或横向滚动，回看零几何影响），获得焦点/开始输入
  才声明尺寸。解决「手机瞄一眼把桌面终端挤窄」的老毛病。v1 保守方案 =
  照搬现状（都声明，latest 赢）；此候选若定采纳，限 coarse pointer 且
  作为 localSettings 开关。

### D3 协议与兼容矩阵

- `open-terminal` 请求加 `streamMode:'lines'`（能力声明），响应回
  `streamMode:'lines'|'attach'`。
- **snapshot 分块传输（R1 B1——server socket.io 默认 maxHttpBufferSize=1e6，
  超限直接断 daemon socket=该机全部终端瞬断）**：lines 模式下 open 响应不再
  内嵌大载荷——响应只带 `{streamMode, seq, historyChunks: n}` 元信息，历史
  按 ≤64KB(base64 前) 分块经现有 `terminal-output` chunk 通道顺序下发
  （每块带 seq、encStream 加密照旧），web 按 seq 顺序 write。双保险 =
  分块（单帧不爆）+ D1 的 1MB capture 字节预算（总量有界）。出 ring 重连
  同样走此路径（代价如实：手机后台一晚回来 = 全量 capture + ≤1MB 传输 +
  xterm 毫秒级重写；验收含其耗时实测）。
- 兼容矩阵：
  - **新 web + 老 daemon**：请求字段被忽略、响应无 streamMode → web 走现状
    attach 路径（滚动劫持、合成 wheel 全保留为 fallback 分支）。
  - **老 web + 新 daemon**：daemon 输出侧一刀切 lines 流（R1 N1 推演裁决
    成立），但 **open 响应形状按请求能力分叉（R2 M-R2-3）**：请求无
    `streamMode` → 回 v1 形状（`mode:'snapshot'` 内嵌 base64(当前屏
    capture)，尺寸沿用 300 行级预算躲 1MB 上限）——老 web 的
    `applyOpenResult` 硬依赖该形状，回 meta 形状会让它在 `res.chunks` 处
    抛异常永远 connecting。老 web 无深历史（如实降级），其余行为如 N1
    推演。老 happy-app 未实测，废弃产品 Owner 自担。
  - **streamMode per-mount 锁存（R2 M-R2-4）**：vh-update/回滚使 daemon 在
    web 存活期换代是常态（铁律 5）；catchUp 响应的 streamMode 与 mount 时
    翻转（attach↔lines）→ 强制整屏重建（remount 等价路径），不做热切换。
  - 老 happy-app 消费者：同「老 web」处理。
- 发布顺序：web 先（带 fallback）→ CLI；回滚=CLI 回滚即回 attach 模式。

### D4 退役清单

- `terminal-scroll` RPC：**normal-buffer 轨**退役调用（本地 scrollback 接管）；
  **alt-buffer 轨照旧调用**（D2 双轨）——daemon handler、planScrollAction、
  sgrWheelHexBytes、wheelAccum 批量、健康度退避、touch→合成 wheel **机制
  本体全部保留**（R2 M-R2-1：它们是 alt 轨的依赖，只是 normal 轨不再进入）。
- `attach-session -d` 的踢客户端语义随 attach 路径退役后消失——用户本地
  `tmux attach` 与 web 并存的行为变化写入验收。

## 风险（Draft）

1. **daemon 写入端命令化（D1b）是全 spec 风险最高的面**：quoting/分片/C0
   通道/应答过滤，任何一处漏=诡异输入损坏，而 IME/中文正是本 repo 刚踩过
   三轮雷的区域。缓解：B-096 按键金样本差分工具现成（attach vs send-keys
   两通道 142 用例逐字节比对作为硬门）+ encodeSendKeys 纯函数全覆盖。
2. **%output 解码器**是新单点：字节纪律（非 UTF-8 安全）+ octal unescape。
   缓解：纯函数 + 真实 claude 会话金样本回放。
3. **高吞吐**：v1 不开 pause-after 的三层兜底（tmux 内建限速/xterm 50MB/
   2MB ring）未经极端验证——yes 级刷屏列真机项；恶化则 v2.1 上 pause。
4. **capture 历史保真度**：-e 只还原文本+SGR，不含全部模式状态——历史回看
   承诺「可读」不承诺像素级一致；接缝（capture 尾 vs 流头）靠 stdout 顺序
   保证但需金样本验证。
5. **双模并存维护税**：web 保留 attach fallback 分支（新 web+老 daemon）
   至少一个兼容期。
6. 老 web/老 app 对行流的实际表现未实测（兼容矩阵【待定】项）。
7. 3.6b control client 退出挂起 bug——kill 兜底已设计，但 daemon 关闭路径
   的僵尸子进程风险要在集成测试覆盖。
8. Unicode 宽度双裁决（tmux wcwidth vs xterm Unicode11）——中文/emoji 折行
   错位风险，真机专项。

## 验收标准（Draft）

- [ ] 手机真机：终端回看滑动跟手（原生惯性），流式输出中回看不被拉底
- [ ] 桌面滚轮回看本地化（断网后仍可滚历史）
- [ ] vim / `/tui fullscreen` 进出：alt buffer 正确切换、退出后 scrollback 完整
- [ ] claude 长会话（数千行）：历史回填完整、颜色正确；打字延迟以可测口径
  验（daemon 收 input → 命令落 control stdin 的耗时上界 <5ms；体感项挪真机）
- [ ] **存量 alt-屏 claude（v2 前创建、无 classic env）**：回看仍走 alt 轨
  RPC、normal scrollback 近空——零增益是预期不是 bug，文档明写
- [ ] agentState/needs_input 通知、@vh_title 跟随、镜像绑定/输入条、B-013 快捷指令回归全绿
- [ ] 多设备同开：几何 latest 语义、两端内容一致
- [ ] daemon 重启/pty reap 等价物（client reap）后重连：无黑屏、无重复、无冻屏（termStreamSync 三事故回归）
- [ ] 新旧四象限兼容矩阵实测
- [ ] 多行粘贴进已开 2004 的 pane：不逐行执行（M4 专项）
- [ ] 用户本地 attach 后 split：web 端行为符合单 pane 声明（M6）
- [ ] 出 ring 重连：snapshot 分块大小与端到端耗时实测（B1/B2）
- [ ] 门禁全绿 + 解码器金样本 + encodeSendKeys 金样本（B-096 差分 142 用例硬门）

## 留真机验证项（Draft）

- 手机滑动手感（本批的存在理由）
- 极端刷屏（yes/大 build 日志）下的前端帧率与 daemon CPU
- 用户本地 `tmux attach` 与 web 并存的观感变化
