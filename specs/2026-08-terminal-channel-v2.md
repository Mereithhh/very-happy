# 终端通道 v2：tmux control mode 内容流（根治移动端滚动不跟手）

> 状态：Draft（调研完成：代码兼容面全链路 + tmux 3.6b control mode 本机实证 + 外部经验；
> 待对抗性 review 收敛）
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
  `%layout-change/%exit` 等路由到生命周期。写入端硬纪律：**绝不发裸空行**
  （= detach）。
- **headless 权威屏保留**：同一条解码后的输出流喂 headless xterm——agentState
  零 subprocess 快路径、serialize snapshot、`pty.process` 的替代
  （`pane_current_command` 改从 list 轮询字段取，已在 7 字段里）全部延续。
- **seq/ring 机制原样保留**：解码后的输出块 = ingest(chunk)（seq+ring+广播），
  wire 事件 `terminal-output` 语义不变（encStream 不变）。gap→catchUp、
  snapshot-ASSIGN/replay-max 两铁律不变（行流丢块虽不再「永久错位」，但会
  丢内容——catchUp 补齐语义照旧成立）。
- **打开时序（历史回填的无竞态设计，capture 走 iTerm2 验证组合）**：
  1. spawn control client（%output 进解码器缓冲区，暂不 ingest）；
  2. 命令通道顺发三连：主屏+历史 `capture-pane -peqJN -S -<N> -t <pane>`
     （**-J 逻辑长行**：xterm 按自己列宽重 wrap，天然吸收宽度差）、
     alt 屏 `…-a`（-q 容错无 alt 时静默）、未完成序列尾巴 `-p -P -C`；
     光标/DECCKM/DECTCEM 状态用 `list-panes -F` 状态包补（首版可裁剪：
     只补光标位置与 alternate_on，其余观察后加）；
  3. 首个 `%begin` 之前缓冲的 %output **丢弃**（已含于 capture）；
  4. capture 三连拼装为「历史块」写 headless + 作为 open 响应 snapshot 载荷；
  5. 末个 `%end` 之后 %output 恢复 ingest——同一条 stdout 的顺序即权威顺序，
     增量与历史无缝不重复。
- 生命周期：`%exit` / 进程退出 → 与现状 pty onExit 同路；**停 client 一律
  SIGTERM→2s 超时→SIGKILL**（3.6b 退出挂起 bug 兜底；spec 附注：建议
  mac-office 升 tmux ≥3.7 消根因，但代码不得依赖升级）。
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
- 非 ASCII 码点（中文/emoji）→ `send-keys -t <pane> 0xNN…`（tmux UTF-8
  encoder 展开）——**中文输入的主通道，金样本必须覆盖 IME 提交串**；
- C0 控制字节（回车/Esc/Ctrl-*）→ `send-keys -H -t <pane> <hex>`（3.5+ 的
  `0xNN` C0 静默劣化 bug 的规避通道）；
- 单条命令 ≤1000 字节分片；分片间保序（命令通道天然 FIFO）。
纯函数 `encodeSendKeys(bytes) → string[]`（vitest + 金样本：71 项按键差分
工具 B-096 现成，跑 attach vs send-keys 两通道逐字节比对）。

**查询应答过滤（外部调研的头号输入坑）**：pane 应用发的 DA/DSR/CSI 6n/OSC
查询透传进 %output，tmux 已代答；xterm.js 在 onData 会再自动吐一份应答，
回灌即重复应答。处理：web sendInput 链**保持不动**（它只送用户输入？——
错，xterm onData 混合用户输入与自动应答，无法在 web 侧区分来源）→
**daemon 侧过滤**：encodeSendKeys 前剥离已知自动应答模式（CSI [>?]…c、
CSI ?6n 应答 CSI R、OSC 10/11 应答等，白名单纯函数 + 测试）。
【对抗待验：现状 attach 模式下这些应答本来就流向 tmux 且行为正常——
需确认 v2 下 tmux 对 send-keys 进来的应答串的实际处理，若无害可简化】
- startupCommand/tombstones/attachOnly/closedTerminals/镜像注入/B-013 daemon 侧
  paste-buffer：**全部不动**（都作用于 tmux session 生命周期层，与 client 形态无关）。

### D2 web：本地 scrollback 生效

- open 响应 `streamMode:'lines'` 时：不再劫持 wheel（xterm 原生 scrollback 滚动）、
  **移除 touch→合成 wheel 链路并撤 `.term-host` 的 `touch-action:none`**
  ——xterm viewport 原生触摸滚动（跟手+惯性）。alt-buffer 场景（用户在终端里
  跑 vim / `/tui fullscreen`）交给 xterm 默认行为（wheel→方向键），
  `terminal-scroll` RPC 不再调用。
- 历史块（snapshot 新载荷）直接 `term.write`——xterm scrollback(5000) 首次
  真正生效；`@xterm/addon-search` 顺带解锁（B-037，本批不做 UI 只留能力）。
- **三个解冻机制的重审**（现状事实里互相中和、v2 同时变活）：
  - select-mode：原生滚动下触摸手势归还浏览器后，长按选择与滚动的冲突面变化
    ——保留 select-mode toggle（语义变为「冻结输出+允许选择」），触摸滚动不再
    被它独占。
  - termWriteHold：保留（选择期间冻结输出的理由在行流下依然成立）。
  - blank-screen belt：判据前提失效（空终端真的可以全空）——退役或改为
    「snapshot 载荷为空且 daemon 报 session 存活」的窄条件，待对抗定。
- 铁律 6 布局链路（fit/padding/键盘视口）不动——通道形态与 cell 测量无关。
- **几何第三条路（候选，对抗定）**：不调 `refresh-client -C` 的 control
  client 完全不参与 window-size——手机端可默认「纯镜像不声明尺寸」（以 tmux
  实际宽度渲染 + fit 缩字号或横向滚动，回看零几何影响），获得焦点/开始输入
  才声明尺寸。解决「手机瞄一眼把桌面终端挤窄」的老毛病。v1 保守方案 =
  照搬现状（都声明，latest 赢）；此候选若定采纳，限 coarse pointer 且
  作为 localSettings 开关。

### D3 协议与兼容矩阵

- `open-terminal` 请求加 `streamMode:'lines'`（能力声明），响应回
  `streamMode:'lines'|'attach'`。snapshot 载荷在 lines 模式下 =
  base64(历史裸字节)（语义从「serialize 整屏」变为「历史流」），replay/live
  chunk 格式与加密完全不变。
- 兼容矩阵：
  - **新 web + 老 daemon**：请求字段被忽略、响应无 streamMode → web 走现状
    attach 路径（滚动劫持、合成 wheel 全保留为 fallback 分支）。
  - **老 web + 新 daemon**：请求无 streamMode → daemon 回 attach 模式？
    【对抗待定：双模并存 vs daemon 一刀切+老 web 行流降级实测——初步分析
    老 web 在行流下基本工作（buffer 非 alternate → wheel 走原生 scrollback，
    5000 已配），但 blank-belt/termStreamSync 行为需实证】
  - 老 happy-app 消费者：同「老 web」处理。
- 发布顺序：web 先（带 fallback）→ CLI；回滚=CLI 回滚即回 attach 模式。

### D4 退役清单

- `terminal-scroll` RPC 调用侧（web）退役，daemon handler 保留 ≥1 版兼容期。
- planScrollAction/sgrWheelHexBytes 随 handler 保留；touch→合成 wheel、
  wheelAccum 批量、scroll RPC 健康度机制删除（lines 分支）。
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
- [ ] claude 长会话（数千行）：历史回填完整、颜色正确、打字延迟无退化
- [ ] agentState/needs_input 通知、@vh_title 跟随、镜像绑定/输入条、B-013 快捷指令回归全绿
- [ ] 多设备同开：几何 latest 语义、两端内容一致
- [ ] daemon 重启/pty reap 等价物（client reap）后重连：无黑屏、无重复、无冻屏（termStreamSync 三事故回归）
- [ ] 新旧四象限兼容矩阵实测
- [ ] 门禁全绿 + 解码器金样本测试

## 留真机验证项（Draft）

- 手机滑动手感（本批的存在理由）
- 极端刷屏（yes/大 build 日志）下的前端帧率与 daemon CPU
- 用户本地 `tmux attach` 与 web 并存的观感变化
