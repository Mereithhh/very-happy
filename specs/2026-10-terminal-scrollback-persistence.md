# 终端回看跨重启保留（scrollback persistence）

> 状态：Draft
> 日期：2026-10-12 ｜ 关联 backlog：B-550 ｜ 前身：`2026-08-terminal-tombstones.md`（B-149，非目标里留的「原 L3」）、`2026-08-terminal-auto-restore.md`（B-150）｜ 参考：Orca `daemon-pty-checkpoint-persistence.ts` / `terminal-scrollback-limits.ts`（只读）

## 背景

B-149/B-150 让 daemon/机器重启后的终端**回来**（同 id、同 cwd、`claude --resume`），B-265 让关闭的终端可以 ↻ 恢复。
但三条路径都把终端冷建成一个**全新的 tmux 会话**：屏幕和回看从空白开始。B-150 的「已恢复」tooltip 也明说「屏幕历史从头开始」。
用户想知道「重启前我在这个终端里干了什么」时，只能去翻 claude transcript；裸 shell 终端（编译输出、日志、手敲命令）则完全没有痕迹。

Orca 的做法是 daemon 定期把每个 pty 的 scrollback checkpoint 到盘（存 5MB、回放 512KB），冷恢复时作为历史回放。
very-happy 的前提不同：tmux 本身就是 scrollback 的权威持有者（`history-limit 5000`），daemon 不需要维护增量日志，
只要在**tmux 还活着时**把它的历史拍下来、在**会话被重建时**放回去。

## 目标

1. daemon 在关键时刻（输出静默后、长时间连续输出时兜底、daemon 退出前）把每个 vh 终端的回看落盘。
2. 终端被**重建**（B-150 自动恢复 / B-265 ↻ 恢复已关闭终端）后，web 打开它时，落盘内容作为「历史」出现在新会话输出**上方**，
   有明确的视觉分隔（「以下为上次会话的输出 … / 以上为上次会话的输出」）。
3. 旧内容**只进 web 的显示流**，绝不写进新 shell 的 stdin（不走 send-keys、不走 pty）。
4. 每终端上限、总上限、过期清理；文件 0600、目录 0700，放 `HAPPY_HOME_DIR` 下；`settings.json` 一个开关可关，关闭即删盘。
5. 不加协议字段、不加消息类型：旧 web / 旧 CLI 行为无害。

## 非目标

- 不恢复进程、光标位置、alt screen 帧（vim/less 画面）；回放的是**文本 + 颜色**的历史。
- 不做增量日志（Orca 的 append + compaction）：tmux 已持有完整历史，全量 capture 足够、且没有「日志有洞」这类状态机。
- 不对 tmux **没死**的 daemon 重启（升级 handover）做任何回放：那时 tmux 历史本来就在，回放只会重复。
- 不覆盖直连 pty 终端（B-486，无 tmux 不可重建）和 attach 终端（B-273，外层 pane 只是内层 tmux 客户端的画面）。
- 不做 web 端开关 UI（CLI 读不到同步设置，与 `terminalAutoRestore` 同理）。
- 不替 claude 去重：`claude --resume` 自己可能再打印一遍对话，与上方回放部分重叠，接受（回放的价值主要在裸 shell 与工具输出）。

## 现状事实（代码已确认，基线 origin/main `50c82a11f`）

| 事实 | 位置 |
|---|---|
| `snapshotStore` 是**内存态**、TTL 90s，只服务一次 open 的分页拉取；没有任何落盘 | `happy-cli/src/terminal/snapshotStore.ts` 头注释与 `SNAPSHOT_TTL_MS` |
| lines 通道每次 open/catch-up 跑一次 capture batch → `assembleRestore` 得到 `full`（历史+屏幕，1MB 预算）→ 存 `snapshots.put` 分页给 web；fresh 时还 `restoreHeadless(full)` | `webTerminal.ts` `runCaptureBatch`；`captureAssembly.ts` `assembleRestore`、`CAPTURE_FULL_BUDGET_BYTES` |
| web 先写 small 快照，再在静默时 `term.reset()` + 写全部页 + 补写期间的 live chunk；页缓冲上限 2MB | `happy-web-v2/src/screens/terminal/termAssembly.ts` `ASSEMBLY_MAX_BUFFER_BYTES`、`WebTerminalScreen.tsx` `runRebuild` |
| web xterm `scrollback: 5000` | `WebTerminalScreen.tsx:569` |
| B-288：capture 只在属性变化处发 SGR，pen 跨行延续；very-happy **只在自己拼接的段接缝**插 `\x1b[0m`，capture 内部行间不动 | `captureAssembly.ts` `SGR_RESET` 注释；`specs/2026-09-terminal-render-integrity.md` D2 |
| 重建终端只有一个入口 `createDetachedTerminal`（B-150 自动恢复与 B-265 ↻ 共用）；先 `has-session` 幂等检查，存在则不建 | `webTerminal.ts` `createDetachedTerminal` |
| 列表跟踪 tick 每 10s 一次，先 `trackClosures`（含一次性 `reconcileRestoredSnapshot`）| `webTerminal.ts` `listTrackTick`、`LIST_TRACK_INTERVAL_MS` |
| daemon 退出（信号/RPC stop/升级 handover）都走 `apiMachine.shutdown()` → `webTerminal.stopListTracking()`（同步） | `api/apiMachine.ts` `shutdown`；`daemon/run.ts` `cleanupAndShutdown` 与 handover |
| `#{session_activity}` **不随输出更新**（无 client 时只在创建/按键时变）；`#{window_activity}` 随 pane 输出更新 | tmux 3.6a 私有 socket 实测：`sleep 3; echo hi` 后 session_activity 不变、window_activity +3s |
| `list-sessions -F` 的格式上下文含当前窗口活动 pane：`#{alternate_on}`、`#{window_activity}`、用户选项 `#{@vh_attach}` 都可直接取 | 同上实测（`vh-def|…|1||…`） |
| `capture-pane -peqJN`：`-J` 合并软折行并去掉未写单元格的行尾空白；跨行颜色在下一行行首才 `\x1b[49m` | 同上实测（`green\n\033[49mxyz`） |
| 机器级设置放 `~/.happy/settings.json`，字段可选、容错读取 | `persistence.ts` `Settings.terminalAutoRestore*`；`autoRestore.ts` `resolveAutoRestoreConfig` |
| `closedTerminals` 上限 40，`live-terminals.json` TTL 14 天 | `closedTerminals.ts`、`liveTerminals.ts` |

## 设计

### D1 文件与上限（`terminal/scrollbackArchive.ts` 纯函数 + `terminal/scrollbackCheckpoint.ts` I/O）

目录 `<HAPPY_HOME_DIR>/terminal-scrollback/`（0700），每终端最多两个文件（0600，tmp+rename 原子写）：

| 文件 | 含义 |
|---|---|
| `<id>.live.vhsb` | **当前这一世** tmux 会话的最近一次 checkpoint |
| `<id>.prev.vhsb` | **上一世（及更早）** 的历史，只在重建后回放 |

文件 = 一行头 `VHSB1 <savedAtMs>\n` + 正文（已清洗、CRLF 行尾的字节）。`id` 先过 `TERMINAL_ID_RE` 再拼路径。

| 常量 | 值 | 理由 |
|---|---|---|
| `SCROLLBACK_FILE_MAX_BYTES` | 512KB（同时是回放上限） | Orca 回放 512KB；我们**不存比能回放的更多**——Orca 存 5MB 是为了增量日志压实，我们无此需求，多存只是多一份敏感数据滞留 |
| `SCROLLBACK_TOTAL_MAX_BYTES` | 64MB | 约 128 个满文件；超出按 mtime 从旧到新删 |
| `SCROLLBACK_TTL_MS` | 7 天 | 与 tombstone TTL 同级；回看价值随时间衰减 |
| 捕获深度 | 5000 行 | = tmux `history-limit` = web/headless scrollback |

GC（首个 tick 必跑，此后每 10 分钟）：删坏文件名；删 TTL 过期；删 id 既不在**当前 tmux 列表**也不在**closed 记录**里的（这次 tmux 列表探测失败则跳过这一条，避免误删）；再按总上限淘汰。

### D2 何时落盘（checkpoint）

在 `listTrackTick`（10s）里挂一个**异步、单飞**的 `tick(closedIds)`：

1. 一次 `tmux list-sessions -F '#{session_name}|#{window_activity}|#{alternate_on}|#{@vh_attach}'`（分隔符可打印 ASCII，铁律 19；只认 `vh-` 前缀，跳过 `@vh_attach` 非空的）。
2. 纯函数 `planCheckpoints` 选出要拍的：`window_activity` 比上次 checkpoint 时新（它只有秒级精度：只有整秒都早于上次捕获**开始**时刻才算干净，同一秒内的后续输出仍算脏），且
   - 已静默 ≥3s（`CHECKPOINT_QUIET_MS`）且距上次 ≥30s（`CHECKPOINT_MIN_INTERVAL_MS`）——「输出静默后」；或
   - 脏了 ≥120s（`CHECKPOINT_MAX_DIRTY_MS`）——spinner/`tail -f` 永不静默的兜底；
   - 每 tick 最多 4 个，最久没拍的优先。首次见到某 id 时，用已有 `.live` 文件的 mtime 作「上次 checkpoint」，daemon 重启不会把所有终端重拍一遍。
3. 捕获（与 lines 通道 history 同一组 flag，B-288 一致）：
   - 普通屏：`capture-pane -peqJN -t =vh-<id>: -S -5000`（历史+可见屏）；
   - alt 屏：`-S -5000 -E -1`（历史）+ `-a`（被 alt 遮住的普通屏），**不拍 alt 帧**（vim/less 画面不属于回看）。
4. 每段：清洗（D4）→ LF→CRLF → 去尾部空行；段间用 `\x1b[0m` + CRLF 拼接；按行边界截到 512KB（保留最新）。
5. 写 `.live`；写前核对该 id 的「代」没有被 D3 的晋升改变（防止在飞的旧捕获在晋升后覆盖）。

**daemon 退出前**：`stopListTracking()` 末尾同步 `flushOnShutdown()`——用 `spawnSync` 对所有「脏」终端补拍，总预算 1.5s，超时即止。
只在本进程至少跑过一次 tick 后生效（单测里 `stopListTracking` 不会去碰真实 tmux）。机器关机时 tmux 可能先死，此时补拍失败即放弃，
最多丢最后一个静默周期（≤ ~2 分钟）的输出，由周期 checkpoint 兜底。

### D3 何时晋升（live → prev）

只有一个时机：`createDetachedTerminal` 通过了「会话不存在」检查、即将 `new-session` 时，`promote(id)`：

- `prev' = 截尾512KB(prev ⊕ 内分隔「── 重建 ──」⊕ live)`（只有一边就取那一边），savedAt 取较新一边；写 `.prev`、删 `.live`、该 id 的代 +1。
- attach 计划（`plan.attachTmux`）不晋升。
- 晋升在建会话**之前**：同一同步回合内，异步 tick 无法在两者之间对新会话拍照；create 失败时 `.prev` 也是正确状态（下次成功重建照样回放）。

升级 handover / daemon 崩溃但 tmux 存活：不经过 `createDetachedTerminal` → 不晋升 → 不回放（tmux 历史本来就在）。

### D4 回放与渲染约束

`runCaptureBatch` 里：`payload = withArchivedScrollback(assembleRestore(...), scrollback.replayFor(id))`。
`replayFor` 只在开关开启时读 `.prev`（≤512KB，同步读）。`withArchivedScrollback` 只改 `full`，不动 `small`/`alternateOn`：

```
full' = RESET + 头分隔 + CRLF + 归档正文 + RESET + CRLF + 尾分隔 + CRLF + full(原样，本身以 RESET 开头)
```

- 头：`── 以下为上次会话的输出 · previous session (MM-DD HH:mm) ──`；尾：`── 以上为上次会话的输出 · 终端已重建，进程是新的 ──`；两行都是 `\x1b[0;2m … \x1b[0m`（暗色），纯文本、无光标控制。
- **不进 stdin**：回放只出现在 daemon→web 的快照字节与 headless 屏里；没有任何 send-keys / pty write。
- **render-integrity（B-288）**：归档与当前历史之间、分隔行前后都是 very-happy 自己制造的接缝，全部插 `\x1b[0m`；归档内部行间不动（保跨行颜色）。
- **清洗**：归档正文只保留可打印字节、`\t\r\n` 与 SGR（`CSI [0-9;:]* m`）；其余 CSI（光标移动、`?1049h`、清屏）、OSC（尤其 **OSC 52 写剪贴板**、OSC 8）、DCS/APC/PM/SOS、其他 C0 与 UTF-8 C1（U+0080–U+009F）一律丢弃。
  `capture-pane -e` 正常只产出 SGR，这是对磁盘文件（可能被篡改/截断）的防御：回放不能让 web 执行任何非着色的终端动作。
- **屏幕几何不变**：`full` 原本的「历史 → 恰好 rows 行的屏幕 → 绝对 CUP」结构不动；归档只是更早的历史，屏幕仍落在最后 rows 行，光标定位正确（B-126 的不变量）。
- **铁律 9**：不涉及字体、lineHeight、渲染器、列数；归档是 `-J` 逻辑行，由 web 按自己的宽度软折行（与现有历史相同），窄屏只会多折几行，不会硬折既有内容。
- 字节预算：`full`(≤1MB+屏幕) + 归档(≤512KB) + ~200B < web 页缓冲 2MB；web xterm scrollback 5000 行满时最先挤掉的是最旧的归档行。

### D5 开关（`~/.happy/settings.json`）

`terminalScrollbackPersist?: boolean`，缺省 = **开启**（见风险 1 的建议，主 agent 定稿时可改 `SCROLLBACK_PERSIST_DEFAULT`）。
每 60s 容错重读；读到 `false` 时：停止 checkpoint、`replayFor` 返回空、**删除整个目录**。畸形值回落默认值。

### D6 web 文案

B-150 的「已恢复」tooltip 现写「屏幕历史从头开始」，新 daemon 下不再成立。改为中性表述（新旧 daemon 都对）：
「…进程是新的；若本机开启了回看保留，上次的输出会显示在终端上方。」（`_default.ts` / `zh-Hans.ts`，仅文案，不碰热区文件）。

## 兼容矩阵与发布顺序

无新 wire 字段、无新 RPC、无新消息类型；server 不涉及。回放内容是 `full` 快照字节的一部分，任何 lines 客户端都按原路径渲染。

| CLI (daemon) | server | web | 行为 |
|---|---|---|---|
| 新 | 新/旧 | 新 | 完整：重建后上方出现带分隔的上次输出；tooltip 为新文案 |
| 新 | 新/旧 | 旧 | 同上（旧 web 只是把多出的历史当普通 scrollback 显示，无报错、无状态异常）；tooltip 仍是旧文案「从头开始」（轻微不准，无害） |
| 新 | 新/旧 | 旧 Expo / 非 lines 客户端 | 走 headless `serialize()` 快照，fresh 时 headless 由 `full'` 预热 → 也能看到归档；无害 |
| 旧 | 新/旧 | 新 | 与现状完全相同（无落盘、重建后空白）；新 tooltip 措辞「若开启了…」对旧 daemon 也成立 |
| 旧 | 新/旧 | 旧 | 现状 |
| 新 → 回滚到旧 CLI | — | — | 旧 CLI 不读 `terminal-scrollback/`，目录残留无副作用；可手动删除。再次升级时 TTL/GC 自动清理 |

wrapper 不涉及（只改 daemon 的终端管理器）。发布顺序：常规 server/web → CLI；web 只有文案，可任意先后。回滚点：上一个 CLI 版本 + 上一个 web release。

## 风险

1. **敏感输出落盘**（最重要）：终端里打印过的 token、`cat .env`、数据库连接串会以明文进 `~/.happy/terminal-scrollback/`，并可能进入 Time Machine/备份。
   缓解：0600/0700；每终端只留最新 512KB；7 天 TTL；终端不在 live 也不在 closed 记录里即删；`terminalScrollbackPersist: false` 关闭并立即删目录。
   对照：同目录已有明文 `access.key`/凭据，`~/.claude/projects/*.jsonl` 已明文保存 claude 会话全部工具输出，shell history 也在盘上——威胁模型等价于「能读用户 home 的人」。
   **建议默认开启**（与 B-150 自动恢复默认开启一致：恢复了终端却没有历史，是 Owner 反馈的痛点本身）；若主 agent 认为风险不可接受，改一个常量即为默认关闭、按需开启。
2. **事件循环阻塞**：tick 用异步 `execFile`、单飞、每 tick ≤4 个；只有退出时用 `spawnSync`，且总预算 1.5s。
3. **磁盘写放大**：每终端最多每 30s 一次（持续输出时每 120s），单次 ≤512KB；10 个活跃终端约 ≤170KB/s 峰值，通常远低于此。接受。
4. **`claude --resume` 与回放内容重叠**：接受（见非目标）。
5. **在飞捕获与晋升竞争**：用每 id 的「代」号拦截；晋升在建会话前同步完成。
6. **单测写真实 `~/.happy`**：unit 项目不隔离 `HAPPY_HOME_DIR`（B-149 遗留债）。checkpointer 构造时零 I/O，只有跑过 tick 才会写；新测试全部用 mkdtemp 目录与私有 tmux socket。
7. **关机时 tmux 先死**：退出补拍失败，丢失最后 ≤2 分钟。接受（周期 checkpoint 是主保证）。
8. **Ink 硬换行（L4）**：claude 输出里的字面 `\n` 回放后仍是硬行，宽度变化不会重排——与现有历史行为一致，不新增问题。

## 验收标准

- [x] 纯函数单测：清洗（SGR 保留；CUP/`?1049h`/OSC 52/OSC 8/DCS/C0/C1 丢弃；不完整序列不吞后续正常文本）、文件编解码与容错、截断落在行边界、`chainArchive`、`planCheckpoints`（静默/最小间隔/脏兜底/上限/排序/首见 mtime）、probe 解析（跳过非 vh、attach、坏行）、GC（TTL/成员/总上限/探测失败不删成员）、配置容错。
- [x] `withArchivedScrollback` 渲染进 `@xterm/headless` 断言 **cell 属性与位置**：归档里未闭合的绿底不漏进分隔行与当前历史；当前屏幕仍在最后 rows 行、光标位置与无归档时一致；`small` 不变；无归档时字节完全不变。
- [x] 私有 socket 真 tmux 集成：终端打印带颜色内容 → checkpoint 写出 0600 文件（目录 0700）→ kill tmux 会话 → `restoreClosedTerminal` 重建 → lines open 的 `full` 含头/尾分隔与旧内容，且**新 pane 的输入里没有旧内容**（`capture-pane` 新 pane 不含旧标记串）；关闭开关后目录被删、`full` 不含归档。
- [x] webTerminal.ts 只增最小挂钩（import、字段、tick、shutdown flush、promote、replay 包裹），不碰 `classifyPane` 附近。
- [x] CLI：`pnpm build` 0 + 相关 vitest + `node dist/index.mjs --version`；web：相关 vitest + `tsc --noEmit` 0 + `vite build`。

## 留真机验证项

- mac-office / dev-sg 真重启：重启前在一个裸 shell 终端里跑几条有颜色输出的命令 → 重启 → 自动恢复的终端（或 ↻）打开后上方出现「以下为上次会话的输出」与旧输出，颜色正确、无绿块、不进输入；手机窄屏下分隔行折行无横向溢出。
