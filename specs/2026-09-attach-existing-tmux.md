# 在 Web 里接入机器上已有的 tmux 会话（attach existing tmux）

> 状态：Draft v2（第 1 轮对抗 review 后）
> 日期：2026-09-02 ｜ 关联 backlog：B-273（接 B-269/B-270 tmux.conf 加固）｜ 出处：同事实报「web 终端里 `tmux attach` 报 `sessions should be nested with care`」

## 背景

web 终端本身就是 daemon 建的 tmux 会话 `vh-<id>` 里的一个 pane，tmux 会向 pane 强制注入 `TMUX`/`TMUX_PANE`（`-e TMUX=` 覆盖不掉，2026-09-01 实测），所以同事在 web 终端里敲 `tmux attach -t dev` 直接被 tmux 拒绝。实测 `TMUX= tmux attach -t dev` 在 web 终端里完全可用：内层会话画在 pane 里、按键直达内层（外层是 control-mode，不截前缀键）、`C-b d` 回到外层、关掉 web 终端只断内层 client，用户会话与窗口原样保留。会话组方案（`new-session -t dev`）否决：不接受 `-c`/shell/`-x -y`（"command or window name given with target"），且 control-mode 下前缀键不生效，用户无法切窗口。

## 目标

1. 「新建终端」面板里列出该机器上用户自己的 tmux 会话（非 `vh-*`），一键在 web 里接入（= 新建一个 vh 终端并由 daemon 注入 `TMUX= tmux attach-session -t '=<name>'`）。
2. 面板顶部一张可关闭的一次性提示卡：web 终端是 tmux 会话；要接入已有会话用下面的选项；不要在终端里再 `tmux attach`。
3. 旧 daemon / 旧 web 任一组合不坏、不卡（能力旗 + `detectedAt >= startedAt`）。

## 非目标

- 不改 pane 环境（不 unset `TMUX`），不做会话组，不改 `list-terminals`/push 载荷。
- 自动恢复（B-150）不复活接入型终端（它没有 claude 会话，`selectAutoRestore` 的 `no-conversation` 规则天然排除）。手动恢复（B-265 归档区 ↻）**要**重新接入（见 D2b），原会话已不存在则报错不建空壳。
- 内层会话里跑的 claude 不做 mirror（B-105）；接入型终端的 `agentState` 只是可见文本分类，仅用于侧栏状态点。
- 不提供自由输入会话名；只能从 daemon 列出的会话里选，且以 tmux `session_id`（`$N`）定位，不按名字。
- 按机器默认目录/启动命令、首次全局提示、pane 输出里 nested 报错的内联提示 → B-274。
- `TerminalPickerScreen`（多机器选择页）不加此入口；入口只在 `NewTerminalModal`（侧栏「+ → 指定目录」、⌘K「新建终端…」）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 终端 RPC 全在 `registerHandlers()`，参数为手写 `typeof` 校验，无 zod；`open-terminal` 解构 `{terminalId, cols, rows, cwd, fromSeq, encStream, startupCommand, resub, attachOnly, streamMode}`，未知字段被丢弃（铁律 4） | `packages/happy-cli/src/api/apiMachine.ts:336-365` |
| 能力旗先例 `terminalRestore {rpcAvailable, detectedAt}`，`activateControlSocket()` 连接时以同一个 `now` 盖 `startedAt` 与 `detectedAt` | `api/apiMachine.ts:933-951`；schema `api/types.ts:275-278` |
| web 侧信任规则 `flag.rpcAvailable===true && detectedAt >= daemonState.startedAt`；调用未注册 RPC 会在 server 侧等 15s | `packages/happy-web-v2/src/sync/closedTerminals.ts:45-51`；`sync/ops.ts:647-650` |
| daemon 列表只读 `vh-*`：`listSessions()` 里 `if (!s.name.startsWith('vh-')) continue` | `terminal/webTerminal.ts:2798`（另一份同过滤在 `assistant/terminals.ts:53`） |
| `LIST_SESSIONS_FORMAT` 以 `\x1f` 分隔 9 字段，`pane_title` 最后 | `terminal/webTerminal.ts:658-722` |
| 启动命令注入：`normalizeStartupCommand`（≤2000 字符、去换行）→ `startupInjectionArgs` = `send-keys -t =name: -l -- <cmd>` + `Enter`，直接 spawnSync，不经 `sh -c` | `terminal/webTerminal.ts:501-534`；注入点 2220-2233 / 2279-2295 / 2390-2393（no-tmux pty 回退） |
| 只有 `createdNew`（`new-session -d` 退出码 0）的会话注入启动命令；重开/attachOnly 从不注入 | `terminal/webTerminal.ts:2176, 2220` |
| 创建 argv `tmuxNewSessionArgs` 已链式带 B-270 覆盖；`ptyEnv()` 会 scrub `TMUX`/`TMUX_PANE`；生产 `VH_TMUX_SOCKET` 未设（默认 server），只有测试设 | `terminal/webTerminal.ts:1040-1099`；`terminal/tmuxSocket.ts` |
| 标题：`@vh_title` + `@vh_title_manual`，manual 时自动跟随不覆盖；`setTitle(id, title, ifAbsent)` | `terminal/webTerminal.ts:2961-2975`；`set-terminal-title` RPC `apiMachine.ts:472-481` |
| 唯一 shell 转义助手 `shellescape()`（单引号包裹 + `'\''`），未导出 | `daemon/run.ts:53-55` |
| web 新建入口：`app/newTerminal.ts` `createTerminalAt(navigate, machineId, cwd?, resumeClaudeSessionId?)` → `useTerminalSessions.create()` 生成 12 位 id → `navigate('/terminal/<m>?tid=&fresh=1[&cwd][&resume]')` → `WebTerminalScreen` 创建时 `machineOpenTerminal(...{startupCommand: (isFresh && resumeCmd) \|\| settings.terminalStartupCommand, cwd: isFresh ? cwd : undefined, attachOnly: !isFresh, streamMode:'lines'})`，成功后 `clearFreshRef` 清 URL 参数 | `app/newTerminal.ts:56`；`sync/terminalSessions.ts:50,98`；`screens/terminal/WebTerminalScreen.tsx:245-277, 1467-1500` |
| URL 只带 id 不带命令行（`resume` 只接受 uuid），「构造的 URL 不能在用户 shell 里跑别的东西」 | `app/newTerminal.ts:50-67`；`sync/closedTerminals.ts:57-66` |
| `NewTerminalModal`：机器选择 + 目录预设 + `.ns-hint`；已有 option-pill 样式 `.ns-agent.is-on`（accent 表示 selected） | `screens/sessions/NewTerminalModal.tsx:43-230`；`screens/sessions/newsession.css:57-92, 196` |
| 一次性关闭先例：`ChangelogNotice` 用 localStorage `vh.changelog.seen` + try/catch；`CliUpdateBanner` 用 localSettings record | `app/ChangelogNotice.tsx:17-35`；`app/CliUpdateBanner.tsx:12-22` |
| i18n：新 key 只碰 `text/_default.ts` 与 `text/translations/zh-Hans.ts`；面板现有 key `newTerminalModal.*` | `text/README.md:5-25`；`_default.ts:980`；`zh-Hans.ts:971` |
| 设计契约：accent 只表 live/selected；mono 只给机器层（会话名/路径/时间）；不叠圆角卡；触控 ≥44px；禁裸色 | `docs/design-language.md` §2/§3/§5 |
| 机器 RPC 默认超时 `MACHINE_RPC_TIMEOUT_MS`=60s（`sync/apiSocket.ts:235`），可按调用传 `timeoutMs` | `sync/apiSocket.ts:235, 341` |
| tmux ≥3.2 对会话名是 **sanitize 而非拒绝**：`:`/`.`/`$`/空格/引号/CJK 都能进名字（3.7b 实测 `a:b`、`v1.2` 原样保留；3.2a 把 `:` 换成 `_`），只有控制字符被拒/visify。`-t '=a:b'` 会被 target 解析成「会话 a」→ 找不到；`-t '$N'`（session_id）在 3.2a/3.7b 上 `has-session`/`attach-session`/`display-message` 都无歧义 | 2026-09-02 实测（`skills/tmp/vh-bug-triage/name-probe.sh`） |
| 嵌套 attach 后外层 pane：`alt=1 cmd=tmux`，内层 `mouse on` 时外层 `mouse_any_flag=1`（内层会向外层开鼠标上报），`mouse off` 时为 0；给外层 pane 发 SGR 滚轮字节：内层 mouse off → 被内层 tmux 静默吞掉（shell 无垃圾字符）；mouse on → 内层进 copy-mode 滚动 | 2026-09-02 实测（`scroll-probe.sh`） |
| `planScrollAction`：`alternateOn && !wantsMouse && !claudeLike` → 发 `Up/Down` 键；`claudeLike` 只看外层 `pane_current_command` | `terminal/webTerminal.ts:869-898` |
| `.ns-preset.is-on` 是面板里现成的选中态样式；`.ns-agent` 属 NewSessionModal | `screens/sessions/newsession.css:124-128` |
| `NewTerminalModal` 的 `canCreate` 含 `!busy`；`onCreate` 先 `machineFsList` 探目录再创建 | `screens/sessions/NewTerminalModal.tsx:70, 83-94` |
| `machineOpenTerminal` 只把 `'terminal-gone'` 映射成 `gone`；其余错误 `WebTerminalScreen` 用红字写进终端；乐观行 `CREATE_OVERLAY_TTL_MS`=60s；`clearFreshRef` 只删 `fresh/cwd/resume` | `sync/ops.ts:~401`；`screens/terminal/WebTerminalScreen.tsx:267-277, 1487-1492`；`sync/terminalPushOps.ts:86` |
| `useTerminalSessions.create(machineId, machineName, title?)` 第三参已存在（乐观标题） | `sync/terminalSessions.ts:98` |
| `createDetachedTerminal(plan)` 已支持 `plan.command` 注入；`plan.manual` 会再钉一次 `@vh_title_manual` | `terminal/webTerminal.ts:1892-1941` |
| 关闭记录/活终端快照的 sanitizer 只保留显式解构的字段（新字段不加进去会在重启后丢失）；签名 `terminalListSignature` 不含的字段不会触发 push | `terminal/closedTerminals.ts:109`；`terminal/liveTerminals.ts:75, 106`；`terminal/webTerminal.ts:591` |

## 设计

### D1 daemon：列出用户 tmux 会话（新 RPC `list-tmux-sessions`）

- `terminal/webTerminal.ts` 新增 `USER_SESSIONS_FORMAT`（独立于 `LIST_SESSIONS_FORMAT`，不动 vh 解析器），**`pane_current_path` 放最后**（目录名可含 `\x1f`，按 `parseSessionListLine` 的 pane_title 手法 `slice(7).join`）：
  `#{session_id}\x1f#{session_name}\x1f#{session_windows}\x1f#{session_attached}\x1f#{session_activity}\x1f#{session_created}\x1f#{pane_current_command}\x1f#{pane_current_path}`。
- 纯函数 `parseUserSessionLine(line): UserTmuxSession | null`，`listUserTmuxSessions(): UserTmuxSession[]`：`spawnSync('tmux', tmuxArgs(['list-sessions','-F',…]), {timeout: TMUX_PROBE_TIMEOUT_MS, env: ptyEnv()})`，**排除 `vh-*`**，按 `activityAt` 降序，上限 50；`no server running`/无 tmux/超时 → `[]`。
- `UserTmuxSession = { id: '$N', name, windows, attached: boolean, activityAt, createdAt, command?, cwd? }`；`id` 必须匹配 `/^\$\d+$/`，`name` 1..128 字符且无控制字符（纵深防御，tmux 自己已挡），不合法整行丢弃。
- RPC `list-tmux-sessions`（无参数）→ `{ type:'success', sessions }`。
- 能力旗：`activateControlSocket()` **无条件**加 `tmuxSessions: { rpcAvailable: true, detectedAt: now }`（与 `terminalRestore` 同一个 `now`，同样不看 `isTmuxAvailable()`；无 tmux 时 RPC 返回 `[]`，web 不渲染区块）；`DaemonStateSchema` 加同名 optional 字段。

### D2 daemon：`open-terminal` 新参数 `attachTmux?: { id: string; name: string }`

- web 只回传列表里拿到的 `{id, name}`，daemon 组命令并注入；web 永远不拼 shell 字符串。
- **校验时机**：只在 `!attachOnly && !resub` 的创建路径、且在 `new-session -d` **之前**：`id` 匹配 `/^\$\d+$/`；`display-message -p -t '<id>' '#{session_name}'` 成功且等于传入 `name`（防 id 被复用给别的会话）且不以 `vh-` 开头。不通过 → 抛 `tmux-session-gone`（契约串），**不创建** vh 会话（无孤儿行）。`createdNew===false`（duplicate）→ 不校验不注入（与启动命令一致）。无 tmux（`!isTmuxAvailable()`）→ 抛 `tmux-unavailable`，不走 pty 回退。
- 命令：纯函数 `attachStartupCommand(id, socket?)` → `` ` TMUX= tmux [-S <socket>] attach-session -t '<id>'` ``（前置一个空格避免进 `HIST_IGNORE_SPACE` 的 shell 历史；`$N` 在 sh/zsh/fish 单引号里都是字面量，`shellescape` 仍作形式保障并从 `daemon/run.ts` 抽到 `utils/shellescape.ts` 导出）。`socket` = `process.env.VH_TMUX_SOCKET`（生产未设 → 不带 `-S`；隔离 server 下 pane 里 `TMUX=` 一清就会落到默认 server，必须带）。
- 优先级：`attachTmux` 存在时忽略 `startupCommand`（web 也不发）；`cwd` 忽略（web 不发）。
- 标题：创建后 `set-option @vh_title <name>` + `@vh_title_manual 1`（内层 tmux 的 pane title 不可靠），用户可改。
- 标记：创建后 `set-option @vh_attach '<name>'`（仅名字；`$N` 不跨 server 重启）。
- 响应回显 `attachedTmux: { id, name }`；web 在 `isFresh && attach` 但响应缺该字段时 toast「此 daemon 不支持接入，已开普通终端」（覆盖旗缓存 vs daemon 降级的竞态）。

### D2b daemon：接入型终端的列表/关闭/恢复

- `LIST_SESSIONS_FORMAT` 在 `@vh_tags` 之后、`pane_current_command` 之前插入 `#{@vh_attach}`（10 字段；`parseSessionListLine` 的 `parts.length >= 10` 与 `slice(9)` 同步改；`assistant/terminals.ts` 共用同一解析器，一起过）。
- `TerminalListItem.attachTmux?: string`（名字）→ 进 `terminalListSignature` → `WebTerminalListItemSchema` → `SeenTerminalInfo`/`LiveTerminalInfo`（`sanitizeLiveSnapshot`/`liveSnapshotChanged` 加字段）→ `ClosedTerminalRecord`（`sanitizeClosedTerminals` 加字段）→ `ClosedTerminalRecordSchema`。web 侧 `MachineTerminal.attachTmux?` 只读不显示（v1 标题已是会话名）。
- **滚轮**：`scroll()` 在外层 `pane_current_command === 'tmux'` 时一律走 `mouse-wheel`（SGR）——内层 `mouse on` 会进 copy-mode 滚动；`mouse off` 被内层静默吞掉、不再把 `Up/Down` 灌进内层应用（B-121 同类）。`planScrollAction` 加 `nestedTmux` 参数，纯函数单测。
- **手动恢复**（`restore-terminal`）：记录带 `attachTmux` 时，`planTerminalRestore` 用当前 `listUserTmuxSessions()` 按**名字唯一匹配**解析出 `$N` → `command = attachStartupCommand(id)`，`title=name, manual=true`；找不到或不唯一 → `{type:'error', reason:'tmux-session-gone'}`，不建空壳。`cwd` 用记录里的（外层 shell 的目录，attach 后无意义但无害）。
- 自动恢复（B-150）：不改，`no-conversation` 已排除。

### D3 web：面板与流程

- `sync/ops.ts`：`machineListTmuxSessions(machineId)`（`timeoutMs: 10_000`，宽松解析：只收 `name` 为 string 的项）；`tmuxSessionsSupported(daemonState)`（复用 `terminalRestoreSupported` 的信任规则，抽成通用 `daemonRpcFlagSupported(daemonState, 'tmuxSessions')`）。
- `app/newTerminal.ts`：`createTerminalAt(navigate, machineId, opts?: { cwd?; resume?; attachTmux?: {id,name} })`（现有两个位置参数改成 options 对象，调用点一起改）；有 `attachTmux` 时 `useTerminalSessions.create(machineId, label, name)` 让侧栏乐观行立刻显示会话名；URL 加 `attach=<encodeURIComponent(id)>&attachName=<encodeURIComponent(name)>`（只有 id 与名字，daemon 精确校验，不构成命令执行面）。
- `WebTerminalScreen`：`isFresh && attach` → 发 `attachTmux`，不发 `startupCommand`/`cwd`；`clearFreshRef` 同时删 `attach`/`attachName`。失败 `tmux-session-gone`/`tmux-unavailable` → `useTerminalSessions.remove(tid)`（撤掉乐观行）+ toast `t('newTerminalModal.attachGone')` + `navigate('/terminal')`（回机器选择页）；不留一个空终端屏幕。
- `NewTerminalModal`：
  - 机器选定且 `tmuxSessionsSupported` → 打开面板即拉 `machineListTmuxSessions`（一次；**独立 `loadingSessions` 状态**，不复用 `busy`，主按钮不被锁）；非空时在「目录」区块**上方**新增区块「接入已有 tmux 会话」：单选列表（每行：mono 会话名 · N 窗口 · 「已连接」灰点/无 · 相对时间；选中态复用 `.ns-preset.is-on`；行高 ≥44px 落到 CSS），再点一次取消选择。选中会话时目录区块折叠为一句 `t('newTerminalModal.attachIgnoresCwd')`，主按钮文案变 `t('newTerminalModal.attach')`；`onCreate` 选中会话时**跳过 `machineFsList` 目录探测**，直接 `createTerminalAt(navigate, machineId, { attachTmux })`。
  - 列表为空/不支持 → 区块不渲染（老 daemon 完全看不到新东西）。
  - 提示卡 `TmuxTipsCard`：面板顶部（eyebrow 之下），正文三句：① web 终端本身就是一个 tmux 会话；② 要接入你已有的 tmux 会话，用下面的「接入已有 tmux 会话」，不要在终端里再敲 `tmux attach`；③ 接入后 `C-b d`（按你自己的 prefix）会退回普通 shell，要再接入回面板来。加「知道了」按钮（≥44px）。关闭写 localSettings `dismissedHints: Record<string, number>`（新 key，默认 `{}`，不加 zod `.default()`；与 `acknowledgedCliVersions` 同纪律），key `newTerminalTmux`。样式：`--bg-1` 台阶 + 上下 1px `--line`，**无 radius、无边框卡**（§5.3），无 accent。
- 侧栏行：不改（标题即会话名）。

### D4 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 daemon（≤0.2.96） | 无 `tmuxSessions` 旗 → 不拉列表、不渲染区块；URL 手改 `attach=` 时 daemon 忽略该字段 → 开出普通终端（无新 RPC 调用，不触发 15s 卡顿） |
| 旧 web + 新 daemon | 旧 web 不读旗、不发新字段；`daemonState` 多一个字段被忽略 |
| 新 web + 新 daemon 但 daemon 降级重启 | 旗随 `{...state}` 带过来但 `detectedAt < startedAt` → 视为不支持 |
| 机器无 tmux | daemon 不置旗；`open-terminal` 带 attach 走 no-tmux 回退时抛 `tmux-unavailable` |

发布顺序：CLI（v0.2.97）→ web（蓝绿）；任一顺序都安全，但先 CLI 才能在发 web 后立刻验收。回滚点：web 回滚即隐藏入口；CLI 回滚只丢列表 RPC。

## 风险

1. 用户会话已在本地 attach → 两个 client，尺寸取「最近使用」client（tmux 默认 `window-size latest`）；本地端会被 web 尺寸带跑。接受（与本地两个终端同时 attach 一样），提示卡里不写、文档里写。
2. 用户配置 `mouse on` → 内层 tmux 吃鼠标：滚轮能滚内层 copy-mode（好），但浏览器划选失效（与本地终端一致，接受）。`mouse off` → 滚轮在接入型终端里无效，需用他自己的 copy-mode；提示卡第 ③ 句附带一句。
3. 会话名字符集：按 `$N` 定位，名字只用于显示/标题/恢复时的唯一匹配；`\x1f` 进不了名字（tmux 拒绝/visify），目录里能进但已放格式末尾。
4. 内层 tmux 的 `remain-on-exit`/`destroy-unattached` 等是用户会话自己的选项，不受 B-270 覆盖影响（覆盖只落在 vh 会话）——正确行为。
5. 用户在 attach 状态下关闭 web 终端 → `kill-session vh-*` → 内层 client 断开，用户会话保留（实测）。
6. 面板每次打开都拉一次列表：一次 RPC、≤50 行，无轮询。
7. 隔离测试 server 下必须带 `-S`；生产带 `-S` 反而会指错 server → 由 `VH_TMUX_SOCKET` 存在与否决定，纯函数单测两种分支。
8. `session_id` 只在 tmux server 生命周期内稳定：列表与打开之间会话被杀再建同名 → id 变、`display-message` 反查名字不等 → `tmux-session-gone`，让用户重选（正确）。
9. 内层 claude 的可见文本会让 `agentState`/`claudeConfident` 为真，`mirrorManager.reconcile` 只会在有持久化 mirror 记录时 adopt——接入型终端没有 `SessionStart` hook 绑定，实际 no-op；非目标里已声明。

## 验收标准

- [ ] daemon：`parseUserSessionLine`/`listUserTmuxSessions` 单测（排除 vh-*、排序、上限、坏行丢弃、`no server running`→[]）。
- [ ] daemon：`attachStartupCommand` 单测（`$N`、socket 有/无、前置空格）；`planScrollAction(nestedTmux)` 单测；`parseSessionListLine` 10 字段（含 `@vh_attach` 空/非空、pane_title 含 `\x1f`）。
- [ ] daemon 真实 tmux 集成测试（isolatedTmux）：建用户会话 `my dev`（含空格，两个窗口，pane 里打印标记）→ `listUserTmuxSessions()` 含它且不含 vh-* → `open({attachTmux:{id,name}})` → pane 捕获里出现内层内容 → `write` 一行命令在 `my dev` 的 pane 里可见 → `@vh_title`=名字、`@vh_attach`=名字、列表项 `attachTmux` → `killSession(vh)` 后 `my dev` 仍在、client 数轮询归零；`id` 存在但 `name` 不符 / 不存在的 id / vh-* → `tmux-session-gone` 且**无 vh 会话残留**；关闭后 `restore-terminal` 重新接入（同名会话在）/ 报 `tmux-session-gone`（会话已杀）。
- [ ] daemon：`list-tmux-sessions` RPC 注册 + 能力旗写入（现有 `apiMachine` 测试模式）。
- [ ] web：`tmuxSessionsSupported` 信任规则测试（旗缺失 / 降级 `detectedAt<startedAt` / 正常）；`machineListTmuxSessions` 宽松解析测试（丢弃 id 不合法项）；`createTerminalAt` options/URL 参数测试；`WebTerminalScreen` 创建参数（有 attach → 无 startupCommand/cwd；`clearFreshRef` 删 attach）；失败路径撤乐观行；`NewTerminalModal` 渲染测试（不支持→无区块；支持且有会话→区块与选中态；选中后主按钮文案变化且不探目录；`loadingSessions` 不锁主按钮）；提示卡关闭后不再显示（localSettings）。
- [ ] 门禁：cli build+unit+`--version`；web vitest+build+tsc 0。
- [ ] 真实浏览器（桌面 + 390px）：区块无横向溢出、触控高度 ≥44px、accent 只出现在选中态。

## 留真机验证项

- mac-office 上本地开一个多窗口 tmux `dev` 并 attach 着 → web 面板接入 → 内层状态栏/窗口切换（`C-b n`）/`C-b d` 回外层的手感；关闭 web 终端后本地 `dev` 仍在。
- 手机 PWA 上面板的滚动与触控。
