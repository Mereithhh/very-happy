# 终端通道 v2：tmux control mode 内容流（根治移动端滚动不跟手）

> 状态：**Shipped**（2026-08-17，merge `d0e33d1d` + `1e7fd7e3`；实现批四阶段
> 0a 解码器 / 0b 写入端 / 1 daemon / 2 web，门禁与实测见「实施纪要」节；
> 真机验收项 V-061..067 待 Owner 清账）
> 原状态：**Final**（v6——四轮对抗 review（R1:3B+8M / R2:抓自引入 2B+capture 语义实证反转
> / R3:抓空洞 / R4:限域判 Final-with-edits）+ 实现者视角盲审补 5 处返工级缺口（粘贴
> load-buffer stdin 实测证伪→临时文件路径、capture 双份全发+锚点统一批末、B-096 硬门
> 假绿→pane 侧字节捕获 harness、预算行边界截断、open 超时契约）。可零返工开工；
> goal 投放文件 = specs/2026-08-terminal-channel-v2.goal.md）
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

## 设计（Final——四轮对抗 + 实现者盲审收敛）

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
  间隙——实证会发生）；greeting 空块排除在 FIFO 配对外。**批内容 =
  「双份全发」（盲审 A2 裁决：alternate_on 要从 list-panes 应答读出，
  单次原子批无法先读后发——故 normal 组合与 alt 三段所需命令全部同批发出
  + list-panes，daemon 按应答中的 alternate_on 挑用哪份拼装，多余一份
  丢弃；时点唯一与批原子性保住）**。两种拼装（R2 B3 实证：无 `-a` 的
  capture 返回历史+当前活动面——alt 活动时那就是 alt 内容；`-a` 返回的是
  "另一块屏"=保存的普通屏，且拿不到历史）：
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
  2. **锚点统一 = 批内最后一条命令（`refresh-client -C`）的 `%end`**
     （盲审 A2 附带简化：所有 capture 都在它之前、R4 实测整批块间零插入
     ——锚点后的 %output 必然不含于任何 capture，无歧义）；锚点后恢复
     ingest；snapshot seq = 锚点时刻 ingest seq（=0 起点）。

  **open 失败契约（盲审 A5：v2 的 open 从同步变异步）**：capture 批 10s
  无应答（tmux 卡死/竞态 kill）→ open RPC 回错误串 `terminal-open-timeout`
  （契约字符串，同 `terminal-gone` 惯例），杀重起 control client；web 呈现
  现有 failure+重试路径，不做静默降级（永远 connecting 是禁止形态）。

  **running client（重连 / gap 出 ring / forceSnapshot——R2 B-R2-2）**：
  ingest **全程不停、一个块都不丢**（丢弃即对其他订阅者制造无 gap 信号的
  永久内容洞）；锚点仅用于**读取 seq 值** S——请求方拿到快照后以 S 为
  baseline，≤S 的 live 块自然 dedup（termStreamSync 现有 'dup' 语义）。
  daemon 对同一终端做 **capture single-flight**（M-R2-6：并发 catchUp 合并
  为一次 capture，分发各请求方）。

  **传输与重建（R2 B-R2-1 定向通道 + R3 B-R3-1 生命周期落死）**：
  - **单次 capture 分发（时点唯一）**：capture 在 open/catchUp 时刻执行
    **一次**（single-flight 覆盖 fresh 与 running、含并发 open——per-terminal
    open 互斥共享同一锚点与载荷）；**小快照 = 同一原子 write 批内额外一条
    范围限定 capture 命令**（normal：`-S -300` 至当前；alt：可见屏。R4 实证：
    范围限定 capture 在起点自含样式开启码，而对全量 blob 按行做字符串切片
    会撕裂跨行 SGR 状态、且 -J 逻辑行上「可见区」不可定位——**禁止字符串
    切片**）；小快照另加字节预算（-J 逻辑行长度无上界）。全量按 snapshotId
    hold 在 daemon 内存供分页。绝不允许「首个 history 请求到达时现场再
    capture」——两个时点的 capture 必产生 scrollback 重复+时间倒序（R3 推演）。
  - **open 响应 schema（lines 模式）**：`{streamMode:'lines', seq,
    mode:'snapshot', data:<可见区小快照 base64>, snapshotId, totalPages,
    alternateOn}`——`data` 沿用 v1 字段名与 300 行级尺寸（秒开）；
    `alternateOn=true` 时小快照**前缀合成 `\x1b[?1049h`**（R3 M-R3-3：
    否则拉齐前双轨判定错轨、交互坏死数秒）。
  - **lines 模式 replay 形状（R4 M-R4-5）**：catchUp 命中 ring 时响应 =
    v1 replay 形状 + `streamMode:'lines'`（无 snapshotId/totalPages/
    alternateOn）——per-mount 锁存依赖每个响应携带 streamMode。
  - **重建后光标（R4 N-R4-2 显式化）**：重建序列写完当前屏后光标停在文本尾，
    依赖 capture 批末 `refresh-client -C` 触发的重绘块（S0 后首批 live 块，
    天然在副本缓冲且靠前）自愈——金样本覆盖；list-panes 的 cursor_x/y
    不在重建序列消费（仅诊断用）。
  - **snapshotId hold 生命周期**：末页送达后 10s 宽限再释放（R4 N-R4-3：
    末页在途丢失的重试不至于整个 open 重来）；TTL 90s 兜底；同终端新
    capture 替换旧 id（旧 id 立即失效）；stale id 的分页请求回错误
    `snapshot-expired`——web 收到即放弃本次 assembly（保持小快照形态，
    功能完好仅历史浅）并重试整个 open 一次。内存上界 = 1MB × live 终端数，
    与 reaper 共同封顶。
  - **历史分页 RPC**：`terminal-history {terminalId, snapshotId, page}` →
    `{page, totalPages, data(≤256KB base64)}`——RPC 信封加密后 ~342KB，
    对 server 1e6 上限余量 2.9×（R3 实测）；**并发 2 页**（R3 N-R3-1：防
    与 live 输出在单 socket 上 HOL）；web 侧每页 15s 超时，失败重试 1 次后
    放弃 assembly（同 stale 路径）。历史页**不进 ring、不进 headless、
    不占 seq**（与 ingest 完全解耦）。
  - **assembly 状态机（web，显式转移表；R4 M-R4-2/3 收紧作用域）**：
    `open-ASSIGN`（baseline=S0 立即 ASSIGN；**副本规则与状态无关**：一切
    seq>S0 且被 apply 的 live 块自 ASSIGN 起原子留副本，贯穿拉页与 gate
    挂起全程，done/abort 统一释放——漏一块=重建产物与真实屏幕永久分叉）
    → `buffering`（后台拉页；live 块正常上屏+留副本）→ **安静时刻 gate**
    → `rebuilding`（reset → 历史 → 当前屏 → live 副本；**raw write 绕过
    seq 判定的只有重放的副本与历史页**——重建期间**新到的 live 块到达时
    照常过 liveChunk（推进 lastSeq / gap 检测），仅 write 延迟排队**，重建
    完按序补写。若全绕过：lastSeq 停滞 → 重建后首个正常块被判 gap →
    catchUp 的 reset 把刚建好的深历史立即抹掉——功能自毁路径，禁止）
    → `done`（释放缓冲）。abort：gap→catchUp / snapshot-expired / 页失败 /
    **缓冲超上限（web 侧 2MB，对齐 ring——回看+持续输出的主用例下缓冲
    无界正好死在本 feature 的场景上，R4 M-R4-4）** ——一律回 done
    （小快照形态），seq 簿记全程走正路故无需恢复动作。
  - **用户安静 gate（R3 M-R3-1+M-R3-4 合并解；「安静」指用户不指输出）**：
    重建仅在 `!termWriteHold.isHolding() && 视口位于底部` 时执行，否则挂起
    （挂起期缓冲上限见上，超限放弃）——一次解决「重建毁选区」
    （beginSnapshotRestore 语义是给重连的，不给后台美化用）与「重建跳
    视口」；「无感变深」由此 gate 支撑而非声称。
  - capture 字节预算 1MB（原始）截断更早历史（总量有界）；**截断必须落在
    行边界**（盲审 A4：按字节截撕裂转义序列，与 R4 切片禁令同理；行边界截
    的 SGR 失真只延续到下一变更码，被「可读不承诺像素一致」承诺覆盖）。
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
纯函数 `encodeSendKeys(text) → string[]`（vitest 全覆盖）。**硬门 = pane 侧
字节捕获 harness（新工程，盲审 A3：B-096 工具比对的是 web 侧两条输入路径的
emitted，对 daemon→pane 段恒等=假绿）**：B-096 的扫描表与终端建清函数复用
（README 已导出），字节水槽从 `cat > /dev/null` 改为落文件，新旧两种 daemon
写入端对同一按键序列对跑、pane 侧落盘字节逐字节比对（142 用例）。
**粘贴专路（R1 M4 + R2 M-R2-2 具体化）**：tmux 3.6b 无 bracketed-paste(2004)
format、attach 模式重放 v2 拿不到——pane 已开 2004 时 `term.paste()` 不知情、
多行粘贴逐行执行。修法：新 **machineRPC `terminal-paste` {terminalId, text}**
（RPC 通用机制，server 零改动；mirror-terminal-send 同款形状）——daemon 侧
写**临时文件**后经 control 命令通道执行 `load-buffer -b <name> <path>` +
`paste-buffer -p -d -b <name>`（盲审实测：control mode 下 `load-buffer -`
stdin 喂字节不可行——stdin 就是命令通道，返回 Bad file descriptor；临时
文件路径实测可行且命令仍与 send-keys **同一 stdin FIFO 保序**；用后即删）（R2 指出 spawnSync 双执行器会让
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
- **几何第三条路（定稿：v1 不做，enhancement 注记）**：不调 `refresh-client -C` 的 control
  client 完全不参与 window-size——手机端可默认「纯镜像不声明尺寸」（以 tmux
  实际宽度渲染 + fit 缩字号或横向滚动，回看零几何影响），获得焦点/开始输入
  才声明尺寸。解决「手机瞄一眼把桌面终端挤窄」的老毛病。v1 保守方案 =
  照搬现状（都声明，latest 赢）；此候选若定采纳，限 coarse pointer 且
  作为 localSettings 开关。本批不实现。

### D3 协议与兼容矩阵

- `open-terminal` 请求加 `streamMode:'lines'`（能力声明），响应回
  `streamMode:'lines'|'attach'`。
- **历史传输 = D1 的 terminal-history RPC 分页 + 二段式重建**（权威描述在
  D1「传输与重建」节，此处不重复——R3 B-R3-2 清除了本段与 D1 互斥的 R1
  残骸描述）。约束背景：server socket.io 默认 maxHttpBufferSize=1e6，超限
  直接断 daemon socket = 该机全部终端瞬断——单页 ≤256KB 的余量实测 2.9×。
  出 ring 重连同走此路径（代价如实：手机后台一晚回来 = 一次全量 capture +
  ≤1MB 分页传输 + 安静时刻原子重建；验收含端到端耗时实测）。
- 兼容矩阵：
  - **新 web + 老 daemon**：请求字段被忽略、响应无 streamMode → web 走现状
    attach 路径（滚动劫持、合成 wheel 全保留为 fallback 分支）。
  - **老 web + 新 daemon**：daemon 输出侧一刀切 lines 流（R1 N1 推演裁决
    成立），但 **open 响应形状按请求能力分叉（R2 M-R2-3）**：请求无
    `streamMode` → 回 v1 形状（`mode:'snapshot'` 内嵌 base64(当前屏
    capture)，尺寸沿用 300 行级预算躲 1MB 上限）——老 web 的
    `applyOpenResult` 硬依赖该形状，回 meta 形状会让它在 `res.chunks` 处
    抛异常永远 connecting。老 web 无深历史（如实降级）；其 snapshot data
    从 serialize() 换为 capture 文本——光标错位由批末 refresh 重绘块自愈，
    静默行为差异如实注记（R4 N-R4-5）。其余行为如 N1 推演。老 happy-app
    未实测，废弃产品 Owner 自担。
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

## 实施纪要（2026-08-17 实现批回写；spec 与现实冲突以本节为准）

### 0. 验收实测数字（本机，隔离 tmux server）

| 项 | spec 口径 | 实测 |
|---|---|---|
| 打字延迟（daemon 收 input → 命令落 control stdin，200 次） | 上界 <5ms | 中位 **0.005ms** / p95 0.019ms / 最大 0.405ms |
| 出 ring 重连（5000 行历史） | 要求实测 | capture+小快照 **49ms**、全量 190KB / 2 页、小快照 12.9KB、daemon 侧取页 ~0ms |
| 写入端 pane 侧字节比对（142 用例 × 新旧两条写入端） | 硬门：逐字节一致 | **142/142 一致，退出码 0**（生产配置：`normalizeKeyNames` 开） |
| 解码器金样本 | 硬门：逐字节回放 | 7 组真机样本（含 CJK/alt/burst 5000 行/二进制/命令块/claude TUI）全过 |
| 3.6b 现役 server 上的三通道 + 归一化 + 粘贴 | 盲区补测 | ASCII/CJK 码点/emoji/C0/混合/Home·End/单引号/临时文件粘贴 **全部一致** |

实现中实测推翻/收紧了 5 处设计描述，另有 4 处实现选择与 spec 字面不同但更优，
按 PROCESS.md 铁律回写在此（本节晚于上文，冲突时以本节为准）。

### A. 被实测修正的设计点

1. **`%begin` 的 flags 语义比「greeting 空块」宽得多（返工级）。**
   `flags & 1` 的真实含义是「本块是不是**本 client 的 stdin 命令**的应答」
   （`cmd-queue.c`：`flags = !!(state->flags & CMDQ_STATE_CONTROL)`，而
   `CMDQ_STATE_CONTROL` 只在 `control.c:control_read_callback` 设置）。所以
   flags=0 的块**不止 attach greeting，还包括 tmux hook 触发的命令块**，会在
   流中间任意时刻插入（实测用 `set-hook -g after-set-option 'display-message …'`
   复现）。D1 那句「greeting 空块排除在 FIFO 配对外」**必须读作**：
   **`flags & 1 == 0` 的块一律不参与 FIFO 配对**。按位置约定（「第一个块是
   greeting」）实现的命令队列，在任何 tmux.conf 配了 hook 的机器上会整队错位。
   实现：`ControlModeDecoder` 导出 `solicited`，`ControlClient` 只对
   `solicited` 的块出队。
2. **控制行行尾是裸 LF，不是 `\r\n`**（spec 原文是推测）。tmux 用
   `EVBUFFER_EOL_LF` 收发控制行。
3. **`capture-pane -C` 与 `%output` 的八进制转义规则逐字节相同**
   （`cmd-capture-pane.c:93` vs `control.c:control_append_data`），CJK（≥0x80）
   两处都不转义 → `unescapeOctal` **一份实现两处用**（拼装模块不得再抄一份）。
4. **单条 %output 载荷上界 8192B**（`CONTROL_BUFFER_HIGH`），spec 担心的「超长行」
   现实不出现；解码器仍按无上界实现（拆多 chunk、不截断）。
5. **3.6b 的「control client 退出挂起」bug 在本次实测形状下未复现**：队列里已有
   34–62MB 待发数据时 SIGTERM，3.6b 与 3.7b 均 6ms 干净退出。SIGTERM→2s→SIGKILL
   兜底**照留**（成本为零的保险），但它不再被当作「已知必然路径」。
   另：mac-office 的 tmux 已升 **3.6b→3.7b**（协议实测双向兼容，升级不打断在跑的
   server 与会话）；**现役 server 进程仍是 3.6b 代码**，要等 server 重启才换代——
   所以代码依旧不得依赖版本。3.6b/3.7b 的 control 协议**行结构实测逐行一致**
   （greeting/命令块/`%layout-change`/`%exit`），金样本录在哪个版本都有效。

### B. 与 spec 字面不同的实现选择（更优，已验证）

1. **老 web 的 snapshot 继续用 `serialize()`，不是 capture 文本**（spec R4 N-R4-5
   写的是换成 capture 文本）。理由：v2 的 headless 仍被同一条解码流喂养，且打开时
   用 capture 的 `full` 回灌过，`serialize()` 因此**逐字保持 v1 语义**、零行为差异，
   还省掉「光标错位靠重绘自愈」那条注记。
2. **拼装缝合用 CRLF，并在 `\x1b[?1049h` 后补 `\x1b[H`**。capture 输出以裸 LF 分行，
   直接回放会阶梯化；alt 切换后光标停在原处，不归位则 alt 帧从半截开始画。
3. **capture 目标用 `=vh-<id>:.0`（窗口首个 pane），pane id 从同批 `list-panes`
   首行锁存**——单 pane 声明因此在**打开那一刻**就确定，不靠「第一个看到的 %output」
   race。
4. **`LIST_SESSIONS_FORMAT` 收成单一事实源**：`assistant/terminals.ts` 原本抄了一份
   7 字段格式，加 `pane_current_command` 时静默错位（4 个测试炸出来）。现在它
   re-export webTerminal 的常量，不再有第二份。

### C. 其他实现事实

- 粘贴临时文件落在 `$HAPPY_HOME_DIR/paste-spool/`（0700 目录 + 0600 文件、5s 后删），
  不落 `/tmp`：粘贴内容可能是密码，且 dev/stable 双 daemon 不共用假脱机目录。
- 打开时把 capture 的 `full` 回灌 headless（不进 ring、不占 seq）——否则 client
  重建后 daemon 自己的权威屏是空的，agentState 快路径与老 web 快照会一起变瞎。
- `terminal-history` 的分页数据**沿用该终端的 encStream 规则**加密（与 live 流同款）。
- daemon 侧 `open()` 由同步变**异步**（capture 往返）：`terminal-gone` 从 throw 变
  reject，RPC 层 await 后错误串对客户端不变。

## 风险

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

## 验收标准

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
- [ ] 出 ring 重连：terminal-history 分页总耗时与重建时机实测（含拉齐前
  live 跟流不中断、安静时刻 gate 生效）
- [ ] 门禁全绿 + 解码器金样本 + 写入端 pane 侧字节捕获 harness（B-096 扫描表
  复用、比对面新建，142 用例逐字节一致硬门）

## 留真机验证项

- 手机滑动手感（本批的存在理由）
- 极端刷屏（yes/大 build 日志）下的前端帧率与 daemon CPU
- 用户本地 `tmux attach` 与 web 并存的观感变化
