# 在 Web 里接入机器上已有的 tmux 会话（attach existing tmux）

> 状态：Draft
> 日期：2026-09-02 ｜ 关联 backlog：B-273（接 B-269/B-270 tmux.conf 加固）｜ 出处：同事实报「web 终端里 `tmux attach` 报 `sessions should be nested with care`」

## 背景

web 终端本身就是 daemon 建的 tmux 会话 `vh-<id>` 里的一个 pane，tmux 会向 pane 强制注入 `TMUX`/`TMUX_PANE`（`-e TMUX=` 覆盖不掉，2026-09-01 实测），所以同事在 web 终端里敲 `tmux attach -t dev` 直接被 tmux 拒绝。实测 `TMUX= tmux attach -t dev` 在 web 终端里完全可用：内层会话画在 pane 里、按键直达内层（外层是 control-mode，不截前缀键）、`C-b d` 回到外层、关掉 web 终端只断内层 client，用户会话与窗口原样保留。会话组方案（`new-session -t dev`）否决：不接受 `-c`/shell/`-x -y`（"command or window name given with target"），且 control-mode 下前缀键不生效，用户无法切窗口。

## 目标

1. 「新建终端」面板里列出该机器上用户自己的 tmux 会话（非 `vh-*`），一键在 web 里接入（= 新建一个 vh 终端并由 daemon 注入 `TMUX= tmux attach-session -t '=<name>'`）。
2. 面板顶部一张可关闭的一次性提示卡：web 终端是 tmux 会话；要接入已有会话用下面的选项；不要在终端里再 `tmux attach`。
3. 旧 daemon / 旧 web 任一组合不坏、不卡（能力旗 + `detectedAt >= startedAt`）。

## 非目标

- 不改 pane 环境（不 unset `TMUX`），不做会话组，不改 `list-terminals`/push 载荷。
- 归档恢复（B-265）/自动恢复（B-150）对「接入型」终端只恢复目录，不自动 re-attach（v1 不持久化 attach 目标；有需要另立项）。
- 不提供自由输入会话名；只能从 daemon 列出的会话里选。
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
| 有机器 RPC 超时 `MACHINE_RPC_TIMEOUT_MS`=60s，可按调用传 `timeoutMs` | `sync/ops.ts:396`；`sync/apiSocket.ts:341` |

## 设计

### D1 daemon：列出用户 tmux 会话（新 RPC `list-tmux-sessions`）

- `terminal/webTerminal.ts` 新增 `USER_SESSIONS_FORMAT`（独立于 `LIST_SESSIONS_FORMAT`，不动 vh 解析器）：
  `#{session_name}\x1f#{session_windows}\x1f#{session_attached}\x1f#{session_activity}\x1f#{session_created}\x1f#{pane_current_path}\x1f#{pane_current_command}`（当前窗口活动 pane 的路径/命令，仅作展示）。
- 纯函数 `parseUserSessionLine(line): UserTmuxSession | null`，`listUserTmuxSessions(): UserTmuxSession[]`：`tmux list-sessions -F USER_SESSIONS_FORMAT`，**排除 `vh-*`**，按 `activityAt` 降序，上限 50；`no server running` → `[]`（与 `assistant/terminals.ts` 同口径）。
- `UserTmuxSession = { name, windows, attached: boolean, activityAt, createdAt, cwd?, command? }`；`name` 经 `isSafeTmuxSessionName`（1..128 字符、无控制字符）过滤，不合法的整行丢弃。
- RPC `list-tmux-sessions`（无参数）→ `{ type:'success', sessions }`。
- 能力旗：`activateControlSocket()` 加 `tmuxSessions: { rpcAvailable: true, detectedAt: now }`（与 `terminalRestore` 同一个 `now`）；`DaemonStateSchema` 加同名 optional 字段。

### D2 daemon：`open-terminal` 新参数 `attachTmuxSession?: string`

- 由 daemon 组命令而不是 web 拼字符串：web 只传会话名，daemon 校验后注入。校验：`isSafeTmuxSessionName` + `has-session -t '=<name>:'`（精确匹配）+ 不以 `vh-` 开头；不通过 → 抛 `tmux-session-gone`（契约串，web 提示「会话已不存在」并回退成普通终端 **不自动**——让用户重选）。
- 命令组合为纯函数 `attachStartupCommand(name, socket?)`：`TMUX= tmux [-S <socket>] attach-session -t '=<shellescaped name>'`；`socket` 取 `process.env.VH_TMUX_SOCKET`（生产为空 → 不带 `-S`；测试/隔离 server 下 pane 里 `TMUX=` 一清就会落到默认 server，必须带）。`shellescape` 从 `daemon/run.ts` 抽到 `utils/shellescape.ts` 导出。
- 优先级：`attachTmuxSession` 存在时忽略 `startupCommand`（web 也不发）。只在 `createdNew` 路径注入（与现有启动命令一致）；no-tmux pty 回退路径**不支持** attach（`tmux-unavailable` 错误，web 不会在无 tmux 的机器上拿到能力旗，因为 daemon 只在 `isTmuxAvailable()` 时置旗）。
- 标题：创建成功后 `setTitle(id, name, /*ifAbsent*/ false)` 并置 `@vh_title_manual=1`——内层 tmux 的 pane title 不可靠（用户多半没开 `set-titles`），用会话名当固定标题，用户可再改。
- `cwd`：忽略（attach 不需要），web 不发。

### D3 web：面板与流程

- `sync/ops.ts`：`machineListTmuxSessions(machineId)`（`timeoutMs: 10_000`，宽松解析：只收 `name` 为 string 的项）；`tmuxSessionsSupported(daemonState)`（复用 `terminalRestoreSupported` 的信任规则，抽成通用 `daemonRpcFlagSupported(daemonState, 'tmuxSessions')`）。
- `app/newTerminal.ts`：`createTerminalAt(navigate, machineId, cwd?, resume?, attachTmux?)` → URL 加 `attach=<encodeURIComponent(name)>`；`WebTerminalScreen` 创建时若 `isFresh && attach`：发 `attachTmuxSession`、不发 `startupCommand`/`cwd`；失败 `tmux-session-gone` → toast `t('newTerminalModal.attachGone')`，终端行按现有失败路径处理（不创建）。URL 里只有会话名，daemon 侧精确校验，不构成任意命令执行面。
- `NewTerminalModal`：
  - 机器选定且 `tmuxSessionsSupported` → 打开面板即拉 `machineListTmuxSessions`（一次，`busy` 期间显示占位）；非空时在「目录」区块**上方**新增区块「接入已有 tmux 会话」：单选列表（每行：mono 会话名 · N 窗口 · 「已连接」灰点/无 · 相对时间；选中态用 `.is-on`），再点一次取消选择。选中会话时目录区块折叠为一句 `t('newTerminalModal.attachIgnoresCwd')`，主按钮文案变 `t('newTerminalModal.attach')`；`onCreate` 走 `createTerminalAt(..., attachTmux=name)`。
  - 列表为空/不支持 → 区块不渲染（老 daemon 完全看不到新东西）。
  - 提示卡 `TmuxTipsCard`：面板顶部（eyebrow 之下），三行正文 + 「知道了」；关闭写 localStorage `vh.hint.newTerminalTmux.v1`（try/catch），下次不再显示；无 accent、无叠卡，用 `--bg-1` 台阶 + 1px `--line`。
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
2. 用户配置 `mouse on` → 内层 tmux 吃鼠标，浏览器划选失效。接受（这是用户自己的配置，和本地终端一致）。
3. 会话名含空格/引号/非 ASCII：`shellescape` 单引号包裹 + `=name` 精确匹配；tmux 本身禁止 `:`/`.` 出现在名字里，不额外限制。测试覆盖含空格与单引号的名字。
4. 内层 tmux 的 `remain-on-exit`/`destroy-unattached` 等是用户会话自己的选项，不受 B-270 覆盖影响（覆盖只落在 vh 会话）——正确行为。
5. 用户在 attach 状态下关闭 web 终端 → `kill-session vh-*` → 内层 client 断开，用户会话保留（实测）。
6. 面板每次打开都拉一次列表：一次 RPC、≤50 行，无轮询。
7. 隔离测试 server 下必须带 `-S`；生产带 `-S` 反而会指错 server → 由 `VH_TMUX_SOCKET` 存在与否决定，纯函数单测两种分支。

## 验收标准

- [ ] daemon：`parseUserSessionLine`/`listUserTmuxSessions` 单测（排除 vh-*、排序、上限、坏行丢弃、`no server running`→[]）。
- [ ] daemon：`attachStartupCommand` 单测（含空格、单引号、非 ASCII 名；socket 有/无）。
- [ ] daemon 真实 tmux 集成测试（isolatedTmux）：建用户会话 `dev`（两个窗口，pane 里打印标记）→ `open({attachTmuxSession:'dev'})` → pane 捕获里出现内层内容 → `write` 一行命令在 `dev` 的 pane 里可见 → `killSession(vh)` 后 `dev` 仍在、client 数为 0；不存在的名字 → `tmux-session-gone`；`vh-*` 名字 → 拒绝。
- [ ] daemon：`list-tmux-sessions` RPC 注册 + 能力旗写入（现有 `apiMachine` 测试模式）。
- [ ] web：`tmuxSessionsSupported` 信任规则测试（旗缺失 / 降级 `detectedAt<startedAt` / 正常）；`machineListTmuxSessions` 宽松解析测试；`createTerminalAt` URL 参数测试；`NewTerminalModal` 渲染测试（不支持→无区块；支持且有会话→区块与选中态；选中后主按钮文案变化）；提示卡关闭后不再显示（localStorage）。
- [ ] 门禁：cli build+unit+`--version`；web vitest+build+tsc 0。
- [ ] 真实浏览器（桌面 + 390px）：区块无横向溢出、触控高度 ≥44px、accent 只出现在选中态。

## 留真机验证项

- mac-office 上本地开一个多窗口 tmux `dev` 并 attach 着 → web 面板接入 → 内层状态栏/窗口切换（`C-b n`）/`C-b d` 回外层的手感；关闭 web 终端后本地 `dev` 仍在。
- 手机 PWA 上面板的滚动与触控。
