# Web 终端 Claude 状态改为 hook 驱动 + transcript 按 hook 路径增量读取

> 状态：Final（主 agent 2026-10-12 定稿：review 五项已修）
> 日期：2026-10-12 ｜ 关联 backlog：B-547（主）、B-551（附带）｜ 出处：Orca 对照批次（`rea-orca` 的 claude managed hooks / server-status-inference / transcript-incremental-reader）

## 背景

**B-547**：web 终端（tmux 里跑的 `claude`）的状态今天只靠截屏：`classifyAgentPane` 看 pane 尾部是否有 `esc to interrupt` / 对话框 / 空闲 footer，10 s 一轮，`TerminalNotifyTracker` 再要求两次间隔 ≥5 s 的一致观测才发通知。于是 ① 状态最快 10–20 s 才变；② 屏幕上看不到 spinner（压缩、长输出把 footer 顶出 20 行窗口、未识别的 footer）就被判成 idle/unknown；③ 未识别的对话框判不出 needs_input。Claude Code 本身有精确的生命周期 hook，wrapper 也早就用 `--settings` 临时文件注入 SessionStart hook——web 终端没用上。

**B-551**：wrapper 的 `sessionScanner` 用 `getProjectPath(cwd)/<id>.jsonl` 猜 transcript 路径，每 3 s 把整个文件重读重解析一遍。SessionStart hook 早就给了权威的 `transcript_path`，没用；文件被改写（截断/替换）时也没有任何检测，只靠 uuid 去重兜底。

## 目标

1. daemon 自己拼出来的 `claude` 命令（新建终端的启动命令、resume 对话、自动恢复、恢复已关闭终端）带上 `--settings <每终端临时文件>`，注入 managed hooks；hook 事件经本机 forwarder → daemon control server → 每终端状态记录。
2. 有有效 hook 记录时，`agentState` 以 hook 为主、屏幕作正向证据；没有记录、记录失效、或 hook 文件缺事件时回退到现有截屏判定（`classifyPane` 不删）。
3. Esc / Ctrl+C 中断不触发 Stop：照 Orca，只有「本 daemon 运行期内确认过的回合 + 基线（turn id / seq / phase 起点 / claude session）完全一致 + 未过期 + 屏幕确认已回到空闲」时合成 done，否则保持。
4. hook 来源的状态变化立即推送（kick list refresh），通知跳过截屏去抖。
5. 不改用户的 `~/.claude/settings.json`；wire 形状不变（复用 `agentState` / `agentKind` / `agentObservedAt`）。
6. B-551：scanner 优先用 hook 的 `transcript_path`；按 byte offset + 边界字节增量读取，检测截断/替换后从头重读（uuid 去重保证不重复上传）；没有路径时回退现有 `getProjectPath` 推导。

## 非目标

- **手敲的 `claude` 不注入**（仍走截屏）。评估过的方案与否决理由见「设计 · 被否方案」。
- 不改 web / server / wire；不加 Prisma migration；不新增 npm 依赖。
- 不动 B-105 mirror 的全局 hook（`install-terminal-hooks`）与 `/terminal-hook` 路由。
- 不做 subagent / teammate 行、工具名展示等 Orca 的扩展状态。
- direct-pty（无 tmux）终端不注入。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 截屏分类：shell→`shell`；choice+Do you want→`needs_input`；`esc to interrupt`→`working`；`? for shortcuts`/`bypass permissions on`/`⏵⏵`/`% context left`→`idle`；其余 claude 画面→无状态 | `happy-cli/src/terminal/agentStatus.ts:7-36`，`classifyPane` 包装在 `terminal/webTerminal.ts:696` |
| 每个 vh tmux 会话每 tick 走一次 `probeAgentState`（有 live headless 用屏幕，否则 2 次 tmux 调用） | `terminal/webTerminal.ts:3044`（`listSessions`）、`:3114`、`:3134` |
| tick 间隔 10 s，事件 kick 去抖 250 ms | `terminal/webTerminal.ts:371`、`:375` |
| 通知要求 2 次、间隔 ≥5 s 的一致观测；working→idle=completed，→needs_input=permission | `terminal/terminalNotify.ts:41-47`、`:79-140` |
| wrapper 已用 `--settings` 临时文件注入 SessionStart hook（forwarder 把 stdin POST 到本进程 hook server） | `claude/utils/generateHookSettings.ts:21-60`、`scripts/session_hook_forwarder.cjs`、`claude/utils/startHookServer.ts` |
| B-105 mirror 的全局 hook 写在用户 `~/.claude/settings.json`（显式命令安装），只有 SessionStart/SessionEnd，转发到 daemon `/terminal-hook`（control token 鉴权） | `mirror/hookSettings.ts`、`scripts/terminal_mirror_forwarder.cjs`、`daemon/controlServer.ts:408` |
| B-137：hook 命令必须带存在性守卫 `[ -f … ] && node … \|\| true` + 条目 `timeout`，否则 CLI 换装后每次 hook 报错 / 卡住会话启动 | `commands/installTerminalHooks.ts:86-90`、`mirror/hookSettings.ts:22` |
| daemon 注入启动命令的三处：新建会话 `injectIntoCreated`、冷建 `createDetachedTerminal`（自动恢复 / 恢复已关闭终端），命令来源 `autoResumeCommand` / `planTerminalRestore` 的 `claude --resume <id>` 与 web 下发的 `startupCommand` | `terminal/webTerminal.ts:2560`、`:1949`、`terminal/autoRestore.ts:146`、`terminal/terminalRestore.ts:70` |
| web 键入经 `write()` 进入 daemon，daemon 能看到原始字节（Esc=`\x1b`，Ctrl+C=`\x03`） | `terminal/webTerminal.ts:2779` |
| 锁定的 Claude Code 2.1.296（agent-sdk 0.3.296 `claudeCodeVersion`）的 hook 事件含 UserPromptSubmit / Stop / StopFailure / Notification(`notification_type`) / PermissionRequest / PostToolUse / PostCompact(`trigger`) / SessionStart / SessionEnd；所有事件带 `session_id` / `transcript_path` / `cwd`，可选 `prompt_id` / `agent_id` | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:963`（`HOOK_EVENTS`）及各 `*HookInput` |
| Claude 1.0.23–2.1.100 遇未知 hook 事件名会丢弃**整个** settings 文件（Orca 用发版 enum fixture 钉住了各事件首版） | Orca `src/main/claude/claude-hook-event-versions.ts` |
| scanner：`readSessionLog` 每次 `readFile` 整个 `<projectDir>/<id>.jsonl`，按 uuid 去重；3 s 轮询 + watcher | `claude/utils/sessionScanner.ts:220`、`:140` |
| wrapper 的 SessionStart hook 数据已含 `transcript_path`，但只取 `session_id` 用 | `claude/runClaude.ts:672-692` |
| B-544 rewind 只**复制**出截断副本（新 session id、新文件），源 JSONL 从不原地改；切换靠 `onSessionFound` | `specs/2026-10-socket-singleton-and-rewind-reconcile.md`「B」节 |

## 设计

### 1. 注入（daemon 拼的命令才注入）

- 纯函数 `injectClaudeSettingsFlag(command, settingsPath)`：仅当命令的第一个 token 恰为 `claude` 且全文不含 `--settings` 时，改写为 `claude --settings '<path>' <其余>`；否则原样返回（`cd x && claude`、别名、用户自己带 `--settings` 都不碰）。路径只允许 `[A-Za-z0-9_./@:+-]`（单引号在 sh/bash/zsh/fish 下语义一致）；不满足就不注入。
- 每终端一个 settings 文件 `<happyHome>/tmp/terminal-hooks/<terminalId>.json`，在注入前写好；终端被 kill / 记为 closed 时删除；daemon 启动（首次 list tracking）时按 id 逐个 `has-session` 清理无对应 tmux 会话的残留文件，有会话的不删（tmux 里的 claude 仍在读它）。内存记录在每个 list tick 按列表 prune（空列表与 tmux 读取失败无法区分，跳过）。
- hook 命令（每个事件同一条）：
  `[ -f '<forwarder>' ] && node '<forwarder>' '<terminalId>' '<happyHome>' "$PPID" || true`
  ——`$PPID` 在 hook 的 `sh -c` 里就是 claude 进程 pid，daemon 用来判这条记录的 claude 是否还活着。条目 `timeout: 10`。
- **按版本挑事件**（防整文件被丢弃 → 也防启动时的 settings 报错对话框）：daemon 用终端同款 `ptyEnv()` 跑一次 `claude --version`（异步、5 s 超时、成功缓存 6 h / 失败 5 min 重试）。探测只在 list tracking 启动（daemon 连上 server）时开始；从未 tracking 的 manager（测试、一次性工具）永不注入。自动恢复是异步路径，会有界等待（3 s）正在进行的探测；新建终端 / 恢复已关闭终端不等，探测未落地时不注入。
  - 版本未知 / 低于 2.0.0 → **不注入**（回退截屏）。
  - ≥2.0.0：SessionStart、UserPromptSubmit、Stop、Notification、PostToolUse、SessionEnd；≥2.0.45 加 PermissionRequest；≥2.1.76 加 PostCompact；≥2.1.78 加 StopFailure。
- forwarder `scripts/terminal_status_forwarder.cjs`：读 `<happyHome>/daemon.state.json` 拿端口与 control token，**只转发白名单字段**（事件名、session_id、transcript_path、cwd、prompt_id、agent_id、source、notification_type、trigger、reason、tool_name + 我们自加的 terminalId / claudePid / prompt 的 sha256 前 16 位），不转发 prompt 原文、tool_input/response、last_assistant_message、compact_summary。stdout 永远为空、永远 exit 0（PermissionRequest / UserPromptSubmit 的 stdout 会被 Claude 当决策 / 上下文，必须为空）；HTTP 超时 2 s。
- 实测（隔离 tmux socket，真实 Claude Code 2.1.296，未发模型请求）：带全部 9 个事件的 `--settings` 文件被接受（无设置报错、正常提示符）；SessionStart / SessionEnd 经真实 forwarder 送达，`claudePid` 等于 claude 进程 pid，bearer token 正确；`/exit` 不触发 UserPromptSubmit。
- 接收端：daemon control server 新路由 `POST /terminal-agent-hook`（同一 bearer 鉴权、`z.any()`、永远 200），经 `apiMachine` 交给 `WebTerminalManager.ingestAgentHook`。不复用 `/terminal-hook`：那条路由会把 SessionStart 当 mirror 绑定信号。

### 2. 状态记录（纯 reducer）

每终端一条记录 `{ claudeSessionId, claudePid?, phase: 'working'|'needs_input'|'done', seq, phaseStartedAt, updatedAt, turnId?, confirmedTurn, interrupted? }`，只存在内存（daemon 重启即丢 → 回退截屏，直到下一个 hook）。

| 事件 | 处理 |
|---|---|
| SessionStart | 新记录（换 claude session 时整条替换），phase=done |
| UserPromptSubmit | phase=working，seq+1，turnId=`prompt_id` ‖ prompt hash，confirmedTurn=true |
| PostToolUse（主线程或 subagent） | phase∈{done,needs_input}→working（seq+1）；working→只续 `updatedAt` |
| PermissionRequest；Notification 且 `notification_type`∈{permission_prompt, elicitation_dialog}（缺类型时 message 含 permission） | phase=needs_input，seq+1 |
| Notification `idle_prompt` | phase=done（锁定版 2.1.296 二进制核实：仅在 `!isLoading`、已有完成的 query、屏幕无对话框、无后台 agent / loop wakeup / 配额恢复、且完成后无输入达到空闲阈值时发出——确为空闲等待；也能收敛 web 外按 Esc 打断、没有 Stop 的回合） |
| Notification 其它类型 | 只续 `updatedAt` |
| Stop / StopFailure（`agent_id` 存在即 subagent，忽略） | phase=done，seq+1 |
| PostCompact | `trigger=manual` → done；auto → 续期 |
| SessionEnd | 删除记录 |

事件里的 `session_id` 与记录不同且不是 SessionStart → 忽略（旧进程的迟到事件）。

### 3. 融合（`probeAgentState` 里，屏幕判定之后）

记录有效 = 存在、未被 SessionEnd 删除、`claudePid` 仍存活（`process.kill(pid, 0)`；无 pid 不判）。无效记录当场丢弃。

| 屏幕 \ hook | working | needs_input | done |
|---|---|---|---|
| `shell` / 其它 agent | 屏幕 | 屏幕 | 屏幕 |
| 探测失败 / claude 但无状态 | working（`updatedAt` 超 10 min → 屏幕） | needs_input（同样超时 → 屏幕） | idle |
| `working` | working | **working**（对话框已消失） | working（如后台任务唤醒、未触发 UserPromptSubmit 的 slash 命令） |
| `needs_input` | needs_input（对话框标记精确；也覆盖 hook 计划里没有 PermissionRequest 的情况） | needs_input | needs_input |
| `idle` | working；但若 `updatedAt` 早于 10 min（HOOK_WORKING_STALE_MS）→ 屏幕 | needs_input（Claude 的模式行 `⏵⏵ …` / `bypass permissions on` 会被截屏当成 idle 标记，而它在未识别的对话框下仍可见）；同样 10 min 过期 → 屏幕 | idle |

即：hook 的 **working** 不被屏幕的「看不到 spinner」降级（这正是截屏的主要误判），但屏幕的正向证据（spinner、对话框）总是被采纳——且算作**屏幕**判定（source=screen），保留截屏的两次观测去抖：只有状态由 hook 记录的 phase 决定时才算 hook 来源、跳过去抖。`agentKind` 固定为 `claude`，`agentObservedAt` 仍是本次探测时间（web 租约语义不变）。manager 内部另记「哪些终端最近一次判定来自 hook」（`hookSourced`，只给通知用，不进推送、不进签名）。`claudeConfident`（mirror 输入闸门）始终取屏幕判定，hook 不会打开它。

### 4. 中断推断（Orca 规则）

- `write()` 看到整块输入恰为 `\x1b`（或 kitty `CSI 27 u` 按下）或 `\x03` 且记录 phase∈{working, needs_input}；或恰为 Enter 且 phase=needs_input（在对话框上选「No / 告诉 Claude 怎么做」同样结束回合且不触发 Stop）→ 记下 pending `{ seq, phaseStartedAt, claudeSessionId, turnId, at }`。选「Yes」时屏幕转为 spinner → 本检查 `wait` 到窗口过期放弃，而融合表的「屏幕 working」行把状态更新为 working。
- 600 ms、2 s、5 s 各复查一次（对该终端单独探测屏幕）。合成 done（`interrupted: true`，seq+1）的**全部**条件：记录仍是同一 claude session、`confirmedTurn`、seq / phaseStartedAt / turnId 与 pending 完全一致、`now - updatedAt ≤ HOOK_WORKING_STALE_MS`、`now - pending.at ≤ 6.5 s`（最后一次计划复查 5 s + 1.5 s 余量，容纳定时器延迟与 tmux 探测耗时）、屏幕判定为 claude `idle`（不是 working / needs_input / 未知）。屏幕仍在 working/needs_input → 等下一次；窗口过了 → 放弃，保持原状。Esc 关菜单、Ctrl+C 清输入框都不会改变屏幕到 idle-with-same-baseline 之外的结果，因此不会误判。
- 合成后立即 kick 推送。

### 5. 推送与通知

- 每个被接受的 hook 事件（以及合成 done）调用 `kickListRefresh()`（250 ms 去抖）——状态在亚秒级到 web。
- `TerminalNotifyTracker.observe(…, { authoritative })`：hook 来源的状态变化**一次观测即确认**（不等 2 tick），其余规则（必须先见过 working、60 s 冷却、只在 working→idle / →needs_input 时发）不变。截屏来源保持现有去抖。

### 6. B-551：transcript 路径与增量读取

- 纯模块 `claude/utils/transcriptCursor.ts`：游标 `{ offset, dev, ino, boundary(≤64 B) }`。每次读：`stat`；dev/ino 变了、`size < offset`、或 `[offset-64, offset)` 的字节与 boundary 不同 → 判定改写，从 0 重读；否则从 offset 读到 EOF，只消费完整行（`\n` 结尾），offset 前移到最后一个 `\n` 之后。重读产生的旧行由现有 `processedMessageKeys` 去重，新行照常上报——与今天「每次整文件重读 + 去重」语义一致，只是不再重复解析未变部分。
- `TranscriptPathHints`：`sessionId → transcript_path`，只接受绝对路径且 basename 恰为 `<sessionId>.jsonl`。runClaude 的 SessionStart hook（过了 B-515 prewarm 闸门的）先登记再 announce；remote scanner 与 local launcher 的 scanner 共用同一个 `TranscriptPathHints`（取用 + 订阅变化）；取不到 → `getProjectPath(cwd)/<id>.jsonl`（现状）。路径变化时重建 watcher、游标归零。
- 已声明「磁盘上现有内容 = 已处理」的会话（构造时的初始 session、`treatExistingAsProcessed`）在 hook 路径**晚到**而改变读取路径时，新路径上**hint 到达时刻**已有的内容（按当时记下的文件大小截断）按同一语义预标记，之后写入的照常上报（启动后几秒内敲的 prompt 不会被吞）；hint 到达即 invalidate，立刻读新路径，不等 3 s 轮询。——否则重连场景（cwd 推导路径不存在、真实 transcript 在 `CLAUDE_CONFIG_DIR` 下）会把整段历史重放进聊天。runClaude 先登记路径再 announce，正常路径不会走到这里。
- B-544：rewind 的截断副本是新 session id 新文件，切换走 `onSessionFound` + SessionStart hook，路径提示按 session id 分开存，互不干扰；源文件从不改写，因此不会触发改写重读。即便将来 Claude 原地改写，重读 + 去重只会上报真正的新 uuid。

### 被否方案

- **改 `~/.claude/settings.json` 全局装 hook（Orca 做法）**：Owner 明确不允许改写用户设置；B-105 已有的全局安装是用户显式命令，不扩展它。
- **PATH shim（cmux 做法）拦截手敲 `claude`**：tmux `-e PATH=` 在 shell rc 之前生效，而 Claude 原生安装器 / Homebrew 的 rc 都会把自己的 bin 目录**前置**，shim 在最常见安装下失效；且 shim 会拦到 wrapper 自己 spawn 的 `claude`（需靠 HAPPY_MANAGED 绕开，再叠一个 `--settings` 有覆盖 wrapper hook 的风险）。收益不确定、风险确定，留作后续单独评估。
- **`CLAUDE_CODE_MANAGED_SETTINGS_PATH`**：二进制里存在的未文档化变量，会替换企业 managed settings，不可用。
- **只用 hook、完全不看屏幕**：hook 计划可能缺事件（旧版本）、事件可能丢（daemon 重启、forwarder 失败），屏幕正向证据是必要的兜底。

## 兼容矩阵与发布顺序

wire / server / web **零改动**：推送的 `TerminalListItem` 字段与 `agentState` 枚举完全不变，hook 只改变 daemon 怎么算出这个值。

| CLI（daemon + wrapper） | server | web | 行为 |
|---|---|---|---|
| 旧 | 旧 / 新 | 旧 / 新 | 与今天完全相同（截屏） |
| 新 | 旧 / 新 | 旧 / 新 | daemon 拼的 `claude` 命令带 hook，状态更快更准；手敲 claude、旧终端里已在跑的 claude 仍截屏；推送形状不变，旧 web 无感 |
| 新 daemon 注入后**降级**为旧 daemon | — | — | 仍在跑的 claude 会继续调用 forwarder：脚本缺失 → `[ -f ]` 守卫静默跳过；脚本在 → 旧 daemon 对未知路由回 404，forwarder 吞掉错误、exit 0；claude 不受影响 |
| 新 daemon、旧 wrapper（存量会话） | — | — | wrapper 不变；B-551 只在新 wrapper 生效（新建/重启的会话） |
| 新 wrapper | 旧 / 新 | 旧 / 新 | 上传的 session 消息与今天一致（同样的 uuid 去重），仅读取方式变化 |

发布顺序：只需发 CLI；无 server/web 依赖。回滚：降级 CLI 即可（见第三行）。存量终端里已在跑的 claude 不会获得 hook，只有升级后由 daemon 新启动的才会。

## 风险

1. **终端 shell 解析到的 `claude` 与 daemon 探测到的版本不同**（rc 里改了 PATH 指向另一份更旧的 claude）→ 可能写入该版本不认识的事件。缓解：只在 ≥2.0.0 注入且事件首版都 ≤2.1.78；flag settings 被丢弃只影响我们自己的文件，结果是退回截屏。接受。
2. **PostToolUse 每次工具调用多起一个 node 进程**（~50 ms）。缓解：forwarder 极小、2 s HTTP 超时、条目 10 s timeout；换来的是长回合里的 working 续期与审批后的及时恢复。接受（Orca 同样安装）。
3. **Stop 丢失**（daemon 正在重启、forwarder 失败）→ working 卡住。缓解：屏幕 idle + 10 min 无 hook 事件即回退屏幕；daemon 重启本身清空记录。
4. **pid 复用**：claude 退出后同 pid 被别的进程复用 → 记录看似存活。缓解：屏幕判为 shell / 其它 agent 时屏幕优先；SessionEnd 正常删除记录。
5. **增量读取不再读取无换行结尾的最后一行**。Claude 的 JSONL 每行以 `\n` 结尾；半行等下一次写入。接受。
6. **settings 文件残留**：daemon 被硬杀时未清理。下次 daemon 启动清扫；kill/close 时删除。

## 验收标准

- [x] 纯函数单测：注入改写（只认首 token `claude`、已有 `--settings` 不碰、非法路径不注入）、版本→事件计划、settings 内容、reducer 全事件表、融合全表、中断推断（基线不符/过期/未确认/屏幕仍 working/窗口过期都不合成）、通知 authoritative 立即确认。
- [x] forwarder 单测：白名单、prompt 只发 hash、stdout 为空、无 daemon 时静默 exit 0。
- [x] control server 路由：鉴权、永远 200、回调收到 body。
- [x] transcript 游标单测：追加增量、半行、截断、替换（inode 变）、同长度改写（边界不符）；scanner 用 hint 路径、hint 晚到时切换、预标记会话的晚到 hint 不重放、无 hint 回退。
- [x] 现有 `sessionScanner.test.ts`、`terminalNotify.test.ts`、`webTerminal.test.ts` 相关用例不回归；`pnpm -C packages/happy-cli build` + `--version` 冒烟。
- [x] 真实 Claude 探针（隔离 tmux socket + 隔离 HAPPY_HOME_DIR）：`--settings` 注入后 SessionStart 到达、`$PPID` 为 claude pid。
- [x] 真 tmux 端到端（`webTerminal.hooks.test.ts`，假 claude 走进程树身份）：注入、hook working 盖过 idle 屏、Esc 推断、Enter 答对话框推断、SessionEnd 回退、kill 删文件。

## 留真机验证项

- 真实回合：UserPromptSubmit→working、Stop→idle、权限对话框→needs_input、Esc 中断→合成 idle、对话框选 No→合成 idle 的端到端时序；顺带确认 Esc / 选 No 确实不触发 Stop（需要真实模型请求，自动化不跑）。
- mac-office / dev-sg 上 `claude --version` 在 daemon（launchd / systemd）环境里能否解析；解析不到则该机不注入（按设计退回截屏）。
