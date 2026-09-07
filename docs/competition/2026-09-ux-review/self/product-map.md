# very-happy 产品表面地图（用户视角）

> 审计对象：`Mereithhh/very-happy` main@796565d5（2026-09-03），线上 Web `main@892be05e` + CLI v0.2.100。
> 视角：**用户在屏幕上看到什么、能做什么**；组件名只作定位（`packages/happy-web-v2/src/...`）。
> 来源：`app/AppRoot.tsx`（路由）、`screens/**`、`text/_default.ts`（全部用户可见文案）、`docs/roadmap.md`、
> `docs/design-language.md`、`docs/keyboard-shortcuts.md`、`docs/channels.md`、`docs/getting-started.md`、
> `docs/backlog.md`、`docs/screenshots/*.png`、`specs/*`、`packages/happy-cli/src/assistant/templates.ts`。
> 断点：`useIsDesktop` = 980px（壳层单/双栏）；会话/终端右栏 = 861px；粗指针（touch）额外改变行为。

---

## 0. 一页总览

| 层 | 用户看到的东西 |
|---|---|
| 公开层 | Landing `/`（未登录）、`/welcome`、`/docs/*`（14 篇）、`/privacy`、`/terms`、`/changelog`、`/login`、`/signup` |
| 壳层（登录后） | 左侧栏（列表 / 状态 / 归档三视图）+ 主区 + 右侧 Notes dock；移动端单栏（根 = 侧栏，其余 = 详情 + Back） |
| 主区路由 | `/`（HomeGate：首机引导 / 工作区向导 / 空态 / 看板）、`/session/:id`、`/terminal`、`/terminal/:machineId?tid=`、`/machine/:id`、`/board`、`/notes`、`/todos`、`/help`、`/settings/*` |
| 全屏兄弟路由 | `/assistant`（语音/文字调度助手，无侧栏）、`/terminal/connect#key`（配对批准） |
| 全局覆盖层 | ⌘K 命令面板、通知铃面板、剪贴板历史、`open_preview` 文件预览、Notes dock、CLI 更新横幅、Changelog 弹窗、PWA 安装卡、「首台机器上线」弹窗 |
| 对象模型 | 机器（daemon）→ 结构化会话（Claude SDK / Codex / Gemini(ACP) / OpenClaw）+ Web 终端（tmux）；镜像会话（终端里手敲 claude 的只读结构化影子）；看板任务（KV）；Notes（KV）；Todo（机器上的外部 provider） |

---

## 1. 全局壳（AppLayout / AppRoot）

### 1.1 桌面布局（≥980px）
- 三列 grid：`Sidebar`（可拖宽，最小/最大有界；可折叠成 46px 竖轨，轨上只剩「展开」+ 通知铃）｜ 6px 拖柄 ｜ 主区 `<Outlet/>` + 右贴 `NotesDock`（打开时挤压主区而非悬浮）。
- 会话/终端页在 ≥861px 时还有自己的右栏（Files / /btw），也可拖宽（`filesPanelWidth` 设备本地，会话与终端共享）。

### 1.2 移动布局（<980px）
- 单栏：`/` 显示全屏侧栏（会话列表）；任何详情路由显示全屏详情，靠 `BackButton` / 左缘滑动 / `⌘[`/`Alt+←` 返回。
- Notes dock、通知面板、Files 面板、/btw 面板在窄屏都变成全屏覆盖层。
- 没有底部 tab 栏；所有「应用级」入口都在侧栏 header/footer（回到根才能用）。

### 1.3 常驻行为（Layout 级 hook）
- 终端列表/agent 状态由 daemon 推送（`useTerminalSync`），侧栏折叠也在跑。
- 快捷键：`⌘K` 命令面板；`⌘N`（PWA）/`⌥N`（普通 tab）新终端；`⌘W`/`⌥W` 关闭当前会话或终端（可配置先确认；离开页面 beforeunload 守卫）；`⌘J` Notes；`⌘.` 快捷片段；`⌘R` 重命名当前行；`⌘1-9` 切侧栏前 9 行（长按 ⌘ 显示角标；只在侧栏挂载时可用）；`⌘[`/`Alt+←` 返回。macOS 上故意用 ⌘ 而非 Ctrl，把 Ctrl 留给终端 readline。
- 通知产生器（看板生命周期跃迁 → 本地通知 + 提示音）与跨设备已读同步（`useSeenTracker`：在任一设备打开目标就把该目标的通知置读）。
- `RequireAuth` 下常驻：`CliUpdateBanner`（某机器 daemon 低于 relay 推荐/最低版本：可复制精确升级命令、去诊断页、「忽略此版本」；required 不可关）、`FirstMachineWelcome`（首台机器接入 → 跳 `/` + alert「Your first machine is online / Explore workspace」）、`ChangelogNotice`（自上次确认以来所有发布堆叠展示，附受影响机器的 CLI 升级命令）。
- `PwaInstallPrompt`：手机/平板打开 1.8s 后出现安装卡（Android 原生安装面板；iOS Safari/Chrome/其他分别给「分享 → 添加到主屏幕」步骤）；「稍后 / 不再提示」。

### 1.4 HomeGate（`/` 登录后显示什么）
1. 数据未就绪 → 全屏 OrbitLoader。
2. **0 台机器** → `FirstRunScreen`（首次运行）。
3. 有机器但 **0 会话且 0 终端** → `HelpScreen`（工作区向导；移动端也是）。
4. `homeView=board`（Settings → Appearance）→ `TaskBoardScreen`。
5. 否则 → `EmptyDetail`（"Pick up where you left off" + 「New session」/「Open web terminal」）。

---

## 2. 屏幕 / 路由逐个清单

### 2.1 公开层

| 路由 | 用户做什么 | 入口 | 主要动作 | 状态 | 移动端 |
|---|---|---|---|---|---|
| `/`（未登录）、`/welcome` | Landing：hero + 交互式「调度系统图」、区域 relay 地图、运行时架构、产品截图工作区、Why、三步开始（安装/登录/daemon）+ Cloud vs 自托管、手机连续性、核心特性、键盘证明、结尾 CTA | 直接访问 | Sign in / Sign up / Docs / GitHub | 中英文切换 | 响应式；PWA 安装卡 |
| `/docs`、`/docs/:slug` | 14 篇指南分 4 组（start: quickstart/keyboard/cli/cloud/self-hosting；understand: architecture/security；operate: configuration/accounts-and-quotas/upgrades/troubleshooting；extend: integrations/contributing） | Landing、登录页脚、首次运行页、Help 页 | 章节导航、代码块一键复制、上一篇/下一篇 | — | 顶部「章节」抽屉 |
| `/privacy`、`/terms` | 法务页 | 页脚 | — | — | — |
| `/changelog` | 发布历史时间线（每条：日期、web build、标题、摘要、要点、配套 CLI 版本） | Changelog 弹窗「View release history」 | — | 最新条高亮 | — |
| `/login` | 邮箱验证码（默认）、Google、可选用户名/密码（折叠） | Landing、被踢回 | Continue；帮助/故障排查链接 | 错误：认证失败 / 限流 / 网络；重新认证提示（去绑定邮箱/Google 时） | 品牌面板隐藏、键盘视口钉住 |
| `/signup` | 同上 + 邀请码（invite 模式）；容量满 / 关闭注册 / 邀请制状态条 | 登录页「已有账号」反向 | 注册 | 用户名≥3、密码≥8、确认一致；用户名占用 | 同上 |

### 2.2 首次运行与向导

| 屏幕 | 内容 |
|---|---|
| `FirstRunScreen`（`/`，0 台机器） | Eyebrow「YOUR FIRST MACHINE」→「Connect a computer to get started」。**快速路径**：一条 `curl https://veryhappy.dev/install.sh` 引导命令（自托管时自动加 `HAPPY_HOME_DIR/HAPPY_SERVER_URL/HAPPY_WEBAPP_URL` 三行 export）；Node.js 缺失提示。**手动三步**（各有复制按钮，Windows 给 PowerShell 版本）：① `npm install -g very-happy-cli` ② `very-happy auth login`（打开批准链接）③ `very-happy daemon start`。信任说明（server-trusted）。「机器没出现？」三条恢复建议。按钮：Read the getting started guide / Open troubleshooting。 |
| `/terminal/connect#<pubkey>` | CLI `auth login` 打开的批准页：显示请求指纹前 12 位，「Approve connection / Cancel」；成功 →「Machine connected」+「Open very happy」；无效链接 → 提示重跑 `auth login`。key 只留内存（立即从 URL 抹掉）。 |
| `HelpScreen`（`/help`，也是 0 会话时的 `/`） | 「MACHINE CONNECTED / Your workspace is ready」；主按钮 **New conversation**（快速建聊）/ **New terminal** / Explore settings；三组手风琴：Move around quickly（⌘K 快捷键、文件浏览预览）、Keep context close（Notes ⌘J、Todo 面板）、Move work between terminal and AI（终端↔结构化、文件拖入终端、让 AI 复制到剪贴板）；底部 Complete quick start / Keyboard & touch guide。入口：侧栏左上品牌标、Settings → Help。 |

### 2.3 侧栏（`Sidebar.tsx`，桌面常驻 / 移动端 = 根页面）

**Header**（从左到右）：品牌标（→ `/help`）｜socket 状态点（connected / connecting 脉冲 / offline）｜搜索图标（仅粗指针显示，打开 ⌘K 面板）｜排序切换（列表视图：按最近活动 ↔ 手动顺序，同步到账号）｜分组菜单（**工作区**（默认，machine+cwd）/ 标签 / 不分组）｜语音助手（→ `/assistant`）｜看板（角标 = 待处理数，9+）｜折叠（桌面）｜**「+」菜单**：New chat（快速：最近机器+目录直接建）/ New chat (choose options)… / Web terminal（单机在线直接开，否则去选择器）/ Web terminal in a directory… / Attach a tmux session…。

**视图切换行**：`List` / `Status` / `Archived`（List/Status 记忆到设备；Archived 不记忆）。

**行（Row）**：终端行或会话行。
- 左：会话 = 状态点（offline / permission 脉冲 / thinking 脉冲 / connected）；终端 = 终端图标 + 小点（Claude working 脉冲 / needs_input）。
- 中：标题 + 最多 2 个 tag chip（+N）+「restored」徽章（daemon 重启后恢复的终端）；mono 副标题（会话：`host · agent · 摘要`；终端：`machine · terminal`）。
- 右缘信号点（B-085 两级）：**accent 脉冲 = 待处理**（权限请求 / 终端等输入 / LLM 判定 review/blocked，与看板「紧急带」同源）；**灰点 = 未读**（agent 在你没看时跑完了；仅会话、内存态、打开即清）。
- 长按 ⌘ 出现 `⌘1..9` 角标。
- 非活跃会话（归档或离线）行尾 ↻ 恢复按钮（机器离线则禁用）。
- 「…」菜单 / 右键 / 长按：Rename / tags；Restore；Mark as priority（`priority` tag，组内置顶）；Move up / down（粗指针的拖排替代）；Archive（会话，红）或 Close（终端，中性）；接入型终端多一项「Close together with the tmux session…」（红）。
- 桌面细指针可拖任意行到任意位置（插入线；分组模式下禁用；在 recent 模式拖动会自动切到 manual）。指针停在列表内时冻结自动重排（防误点）。

**Status 视图**：`Waiting on me`（紧急带 + 待收割带）/ `Running` / `Done today`（折叠，24h 内 ✓ 过的）。分类与看板同一个分类器。

**Archived 视图**：非活跃会话平铺 +「Closed terminals」区（daemon 记录的最近 ≤20 条：标题、tags、cwd · 机器 · 关闭时间 ·「ended in a restart」；动作：Restore this terminal（同 id/标题/tags，自动 `claude --resume`）/ Continue this conversation here（旧 daemon）/ New terminal in this directory；有镜像的还有「View structured history」）。

**Footer**：Settings ｜ Notes（⌘J）｜ Todos ｜ 主题快切 ｜ 通知铃（角标）。

### 2.4 结构化会话 `/session/:id`（`SessionDetailScreen`）

**ChatHeader**：Back ｜ 可编辑标题（点铅笔；Enter 保存）｜ `host · cwd` 面包屑 ｜ relay 区域标签 + 连接点（agent 在线且 socket 连上才亮）｜ Notes ｜ `/btw` 侧问（仅 Claude 会话、非镜像）｜ Files 面板开关。

**横幅**：
- `MirrorBanner`（镜像会话）：「Read-only mirror · trails the terminal slightly…」+ 上下文用量 + 「Terminal」切回；Claude 在终端等输入时顶部出现 accent 条「Claude is waiting for input in the terminal → Switch back」。
- `SessionArchivedBanner`（已归档 / 仅离线）：「This session is archived/offline. Restore it…」+ Restore（阶段文案：Restoring on the machine… → The machine has not responded yet… → Started — waiting for the session to come online… / 失败原因 12 种 + Retry）。

**ChatList（transcript）**：
- 按 turn 聚合：用户气泡（复制、长文展开）、agent Markdown（复制；反引号/加粗里的路径可点开预览）、thinking 折叠块（「Thought for Xs」）、**工具组**（「n tool calls」+ 运行摘要 + 错误标记，展开逐个 ToolView）、`TurnActivityView`（「Elapsed Xs」、「n sub-agents」/「x/n running」，运行中自动展开、结束折叠）。
- ToolView 特化：Edit/MultiEdit/Write → 语法高亮 unified diff（+/- 统计、复制补丁、可选行号；触屏默认换行）；Read → 路径；Bash → 命令 + 输出；Grep/Glob → 查询 + 路径；WebFetch/WebSearch → 链接/查询；Task（子代理）→ 卡片：类型徽章、工具数、逐条日志、状态 running/done/failed/stopped、时长、最终报告（16KB 截断）；TodoWrite → 勾选列表；Skill → 已加载；ExitPlanMode → Plan proposal Markdown；AskUserQuestion → 选项按钮（单/多选 + Other 自由文本）；附件 → 文件卡。
- 服务事件行：Stopped by you；The agent process exited unexpectedly（+ **Restart** 按钮，daemon 太旧则提示升级）；Claude Code could not authenticate（+「Check machine login status」→ 机器页）；Switched to mode X；Usage limit until HH:MM；sub-agent started/completed。
- **服务端持久队列**（CLI 侧 queued）：紧凑「command buffer」卡片，可取消（太晚则提示）。
- **PermissionCard**（agent 卡在审批时，置于 transcript 末尾）：标题「Permission required · n requests pending」；每条：工具名 + 参数（Bash 显示命令、文件工具显示路径、其余 JSON）；按钮 **Approve / Approve for session / Deny**（Approve for session 仅在 CLI 给出 permissionSuggestions 或旧 CLI 的可变工具时出现）；ExitPlanMode 渲染计划 Markdown；AskUserQuestion 直接渲染选项；MCP elicitation 渲染表单（enum/number/boolean/string[]）或 URL 模式；多条时 **Approve all / Deny all**。
- `SessionLiveStatusBar`：「Thinking 12s」/「Bash · 3s」脉冲点。
- 「Load older messages」；离底后右下 ↓「Jump to latest」带未读条数。

**AgentInput（composer）**：
- 圆角自增高 textarea（Enter 发送 / Shift+Enter 换行，可反转；IME 安全）；工具行：📎 附件（选择/粘贴/拖入；新 daemon 任意文件 ≤50MB，旧 daemon 仅图片/PDF；非 Claude 会话无附件）、**Shortcuts** 预设菜单（⌘.，1-9 直插）、展开/收起（~60% 视口）；右侧 **Stop**（运行中）+ **Send / Queue message / Restore and send**。
- 桌面状态行：`model` / `mode` / `effort` 三个下拉（Claude：default/plan/acceptEdits/yolo；Codex：default/read-only/safe yolo/yolo；Gemini：default/auto edit/yolo/plan；OpenClaw：default/yolo；模型列表按 flavor；effort low…max）。mode 旁诚实副文案：`· switching` / `· CLI: default` / `· at start` / `· unconfirmed (web auto-approves)` / `· unconfirmed`。上下文用量表（tokens / 窗口，≥90% 警告 ≥95% 危险；模型未知只显示 token 数）。提示文案：「Enter to send…」/ 运行中「Send queues · Steer updates the current turn」。
- 移动端：三个下拉收进一个「Session settings」sheet（触发器显示 `model · mode` 摘要）。
- **本地队列**（运行中发送）：「Queued · n · this device」列表，每条可编辑/保存/删除/**Steer current turn**（↳ 图标，仅 Claude 且 CLI 支持 `claude-steer-v1`）；⌘/Ctrl+Enter = 直接 steer；turn 结束自动逐条释放；归档会话先恢复再释放。
- 斜杠建议：`/btw` 置顶 + CLI 上报的 commands/skills；Tab/Enter 补全。
- 权限模式切换在 Claude 远程会话上**即时生效**（v2 能力空闲也行；v1 仅运行中），失败回滚并 alert。

**右栏（`?panel=`）**：
- **FilesPanel**：`Changed files`（数量角标；行 = 状态字母 M/A/D/R/U + 文件名 + `+x -y`）/ `Project files`（树）/ `Browse`（机器文件系统：面包屑、按时间/名称排序、显示隐藏文件、刷新、全屏；打开文件 = 内置查看器 md/图片/PDF/代码）。点文件 → 只读代码视图（行号、二进制提示）。URL 可分享、浏览器返回可关。
- **BtwPanel**（`/btw`）：「Side question · not added to the conversation」；问答列表（时间、Markdown 答案、running 计时 + 停止、错误/取消/「无上下文」注释）；清空；composer（Enter 发送）；CLI 不支持 → 「Update very-happy-cli…」；会话离线 → 禁用。

**MirrorInputBar**（镜像会话唯一可写入口）：文本直接粘进终端里的 claude + Enter；claude 退出后自动隐藏。

### 2.5 Web 终端

| 屏幕 | 内容 |
|---|---|
| `/terminal`（`TerminalPickerScreen`） | 机器列表（在线 → `+` 新建；离线 → 「Offline」徽章 + 「run `very-happy daemon start`」）；「Open sessions」已开终端列表。 |
| `/terminal/:machineId?tid=`（`WebTerminalRoute` → `WebTerminalScreen`） | 若该终端有镜像且设备默认「structured」，3s 内重定向到镜像会话（避免把正在打字的人拽走）。 |

**终端页 header**：Back ｜ 可编辑标题（打开 RenameModal：标题 + tags）｜ relay 芯片（`SG · 42ms` / `CONTROL` / `RELAY…`）｜ loading ｜ **Structured view**（有镜像时）｜ Notes ｜ Select/copy 模式（移动端）｜ Shortcuts 菜单（桌面；`$` 标记项选中即执行）｜ Files 抽屉（`FsBrowser` 起点 = pane cwd）｜ **Refit width**（多设备把 pane 挤窄后手动重排；tooltip 解释历史行不能重排）｜ tmux 帮助（鼠标/prefix/scrollback/panes/windows/detach 速查）。

**终端体**：xterm，两主题下都深色；拖入/粘贴文件 → 「Drop to upload」→ 进度条 → 上传到 `~/.happy/uploads/terminal/` 并在光标处粘贴带引号的路径（不回车）；旧 Windows daemon 不粘路径而提示手动。

**移动端底栏**（粗指针）：键盘开关 ｜ `WEB`（内置英文 Web 键盘：全 ASCII、Shift/Caps、符号页、Backspace 长按连删、方向键、Enter）｜ 行输入模式（普通 textarea 整行发送：IME/听写友好，Enter 发送）｜ Shortcuts ｜ 分隔 ｜ 粘性 `Ctrl` ｜ Esc Tab Enter ↑ ↓ ← → `|` `~` `/` `-`。

**新建/接入**：
- 一键新终端：⌘N/⌥N、「+」菜单、⌘K、EmptyDetail、Help；单在线机器直建，否则去选择器；在 `$HOME` 打开并跑 Settings → Shortcuts 的「Terminal startup command」（仅新建，不在重连时）。
- `NewTerminalModal`「Terminal in a directory」：首次三条 tmux 提示卡（每台 web 终端就是一个 tmux 会话 / 别在里面 `tmux attach` / detach 后回来再接）；选机器 → 「Attach an existing tmux session」区（列出用户自己的非 vh 会话：名称 · n windows · attached · 活动时间）→ 目录（预设 chip 可存/删、路径输入、📁 内嵌目录浏览器「Use this directory」）→ Open terminal / Attach session。
- `AttachTmuxModal`「Attach a tmux session」：直接列出可接入会话，点击即接入（CLI < 0.2.98 提示）。
- **关闭语义**：普通终端「Close terminal?」→ 进归档、可原地恢复；接入型「Disconnect this tmux session?」默认仅断开；另有「Close together with the tmux session」= kill。

### 2.6 机器页 `/machine/:id`（入口：Settings → Machines / Diagnostics / Claude 认证失败事件）

header：名称 + host ｜ `Claude · max` 登录徽章（ok/未登录/失败/缺二进制/未定）｜ 在线点 ｜ 重命名。
分组：**Launch New Session in Directory**（路径输入 + Start；离线则「Launcher disabled」+ 三条帮助）→ **Daemon**（状态、PID、HTTP 端口、启动时间、CLI 版本、推荐/最低版本、更新状态徽章、Copy update command、state version、**Stop Daemon**）→ **Claude Login (daemon context)**（状态、诊断六种、daemon lineage、凭据存储 `Use file`/`Use Claude default`、Re-check now、Back up and delete the empty keychain item）→ **CLI Availability**（claude/codex/gemini/openclaw Installed/Not found）→ **Active Sessions (n)**（最近 5 条）→ **Machine**（host/id/用户/home/平台/架构/最后在线/版本）→ **Danger Zone**：Delete Machine。

### 2.7 任务看板 `/board`（`TaskBoardScreen`；也可设为首页）

header：Back ｜ Task Board ｜ 待处理计数 ｜ `Lifecycle` / `Tasks` 切换 ｜（Tasks 下）New task。
- **Lifecycle**（默认）三列：`Working`（运行中）/ `Waiting for you`（紧急带：权限、终端等输入、LLM review/blocked，按等待最久排；待收割带：`ready to collect`（跑完没收）、`ended`（进程死了 24h 内）、`machine offline`；列尾「View archived →」）/ `Done`（24h 内 ✓ 过的会话 + 完成的任务，桌面展开、手机折叠）。
- **Tasks**：每个 open 任务一条泳道（标题、描述、计数、**Mark done**、**Dispatch**（打开 NewSessionModal，描述预填为首条消息，spawn 后记录到任务）、菜单：Dispatch/Edit/Move up/down/Mark done/Delete）；拖排（细指针）；「Ungrouped」泳道收终端与未归类会话。任务级 Mark done 会问「Also mark n sessions on this task as done?」（批量 kill-first 归档）+ 一条 webhook。
- **BoardCard**：状态点 ｜ 标题 ｜ ✓（会话：完成记录 + 归档 + webhook「✅ 已完成」；终端：确认关闭）｜ 类型图标 ｜ `machine · cwd` ｜ LLM 进度一句话 ｜ 脚注徽章（review/blocked、工具名、machine offline、ended、ready to collect、`waiting 4m` / `3m ago`）；右键/长按：Mark done / Open / Move to top / Rename / Archive|Close。
- Board AI 分析（进度、attention、任务归类）是 daemon 侧本地 haiku 旁路，默认关，只能在机器 `~/.happy/settings.json` 里 `boardLlm: true`（Settings → Appearance 只放说明）。

### 2.8 Notes（`NotesDock` + `/notes`）

- Dock（⌘J / 侧栏 footer / 会话与终端 header 的便签图标 / ⌘K）：右侧面板（桌面可拖宽；窄屏全屏）。顶部 tab 条：列表视图 ｜ 已 pin 的笔记 tab（可关）｜ 新建 ｜ 全屏 ｜ 关闭。列表 + 分栏编辑；行右键：Pin as tab / Rename / tags / Archive / Delete。新建笔记自动**绑定当前会话或终端**（chip 显示绑定目标；可跳转/解绑）；编辑器有「Insert into input」把文本插到当前 composer/终端（不发送）。上限 200 条，账号级 KV 同步。
- `/notes`：全部笔记（筛选、归档视图、新建、「Back to side panel」）；桌面双栏，手机列表→编辑。

### 2.9 Todos `/todos`

header：Back ｜ Todos ｜ 机器选择（在线点）｜ 分组（按 provider 分组 ↔ 按优先级四桶）｜ 刷新（无轮询）。
内容：新增输入框；条目（勾选完成、标题、note、优先级、due、id）；缺失/截断提示；失败卡（provider 出错原文、超时、机器离线/太旧）；**未配置** → 引导卡（说明必须在那台机器 `~/.happy/settings.json` 写 `todoProvider`，附示例与 docs 链接）。

### 2.10 助手 `/assistant`（`AssistantScreen`，B-051「类 Siri 第二形态」）

- 无侧栏全屏；header：← ｜ Voice assistant ｜ 机器名 ｜ 文字记录开关 ｜ 语音设置。
- 门控：无在线机器 / 多机器选一台 / CLI < 0.2.34 升级提示 / spawn 失败重试。
- 舞台：品牌 logo 动效（idle/listening/thinking/speaking）+ 状态词；若助手会话卡权限 → 「Waiting for permission approval: X → Review」跳到该会话页；对话区（用户句、回复正文或朗读字幕、`<options>` 可点选项、TTS 截断提示）；工具 ticker（「Dispatching a new task · /srv/x」等友好名）。
- 控件：Enable spoken replies（iOS 解锁音频）｜ **按住说话**大麦克风（电平条；松开 → 转写 → 发送；短按取消）｜ 文字输入 + 发送 ｜ New conversation（强制重生助手会话并归档旧的）。
- 文字记录面板：user/assistant 行、thinking 折叠、tool 折叠（原始 JSON）。
- 后端事实：助手 = 那台机器上一个隐藏的 Claude 会话（`variant=assistant`），系统提示是中文「调度中心」：只派活不动手（无 Bash/Edit/Write），工具 `sessions_list/session_read/session_send/session_spawn/session_kill/session_archive/terminals_list/terminal_read/terminal_send/memory_update/journal_append`；贵操作先复述确认；个人记忆 `memory/personal.md` ≤2000 字。默认 **skip permissions**（Settings → Voice 可关）。STT/TTS 走服务器（ElevenLabs），未配置则纯文字。

### 2.11 通知（铃 + 面板 + 设置）

- 铃在侧栏 footer / 折叠轨（移动端只有回根页面才能看到）；角标未读数。
- 面板：Mark all read ｜ 设置 ｜ 关闭；条目 = 类别图标（🔑 permission / ❓ question / ✅ done / ⚠ error）+ 标题 + 详情（daemon 文案或本地类别「Asking to run a tool / Agent suggests a look / Agent reports it is stuck / Terminal is waiting for input / Finished its turn」）+ mono 时长 + 未读点；点击 → 跳转并置读；已读状态跨设备同步。
- 来源两路：daemon feed（会话）+ 本地看板跃迁（覆盖终端与 LLM 判定）；自看页面不响铃；保留天数可设。
- 提醒渠道：WebAudio 提示音（四种、音量、按事件）；浏览器 Notification（主开关、四类、免打扰时段）；**Web Push**（Service Worker + VAPID，PWA 安装后 iOS 也能收）；账号 **Webhook**（一条 HTTPS，事件 completed/permission，消息末尾固定 `session: <id>`，供 IM 适配器 quote-reply 回流）。

### 2.12 命令面板 ⌘K

搜索框（`#tag` 语法）；Actions：New terminal（快捷键提示）/ Web terminal in a directory / Attach a tmux session / New chat / New chat (choose options) / Rename current / Restore current / Archive current / Voice assistant / Clipboard history / Notes（⌘J）/ All notes / Todos / Settings；Sessions；Terminals。

### 2.13 剪贴板历史 & 文件预览覆盖层

- `ClipboardHistoryPanel`（⌘K / Settings → Channels）：agent `copy_to_clipboard` 推送的历史；点行复制、展开可编辑再复制/删除；清空；自动复制开关在 Channels。
- `FsPreviewOverlay`：agent `open_preview` 推送 → 弹出文件查看器（不抢焦点；Esc/遮罩关；全屏）；机器离线/未知给明确文案；`mode: diff` 降级为普通预览 + 「diff 不可用」。

### 2.14 设置 `/settings/*`

| 子页 | 内容 |
|---|---|
| Overview | Help & getting started ｜ About ｜ Account ｜ Appearance ｜ Agent defaults ｜ Shortcuts ｜ Notifications ｜ Channels ｜ Voice & Assistant ｜ Machines ｜ Usage ｜ Diagnostics ｜ Danger: Logout |
| Appearance | 主题（Adaptive/Light/Dark）｜ Home Screen（Recents / Task Board）｜ ⌘W 关闭守卫（先确认；离开页面警告）｜ Board AI Analysis 说明 ｜ 语言（自动/中/英）｜ Display（diff 行号、diff 换行） |
| Account | 状态、Public ID、Email 登录（绑定/解绑 → `/settings/email`）、Google（→ `/settings/google`）、密码（→ `/settings/password`）、服务器；Profile（GitHub 连接）；Logout |
| Agents | New chat creation：Default agent（claude/codex/gemini/openclaw）、Always ask、**Review Changes First**（新会话起于审阅优先模式）；每 agent 的 Permission / Model / Effort 默认（「Use default」= 交给机器 CLI 自己配置）；Reset all |
| Shortcuts（Snippets） | 快捷片段列表（标题/文本/「Run in terminal on select」）｜ Terminal startup command ｜ Terminal input method（Standard / Own input 实验）｜ Terminal default view（xterm / Structured chat） |
| Notifications | 浏览器通知开关 + 四类 + 免打扰 ｜ 提示音（开关/音量/音色/事件）｜ Notification Center 保留天数 ｜「Webhook 已移到 Channels」 |
| Channels | 账号 Webhook（URL + Task completed / Needs attention）｜ Automation CLI（`very-happy spawn` / `send` 说明）｜ MCP clipboard tool ｜ IM adapter pattern ｜ 剪贴板接收（自动复制、历史）｜ 文件预览接收开关 |
| Voice & Assistant | TTS 音色（列表 + 试听）｜ Voice Library 浏览/添加（中/英/日/韩）｜ ASR 语言 ｜ 朗读文字回复 ｜ PTT 提示音 ｜ **Skip permission approvals** ｜ 助手所在机器 |
| Machines | 机器列表（在线状态）→ `/machine/:id` |
| Usage | 时间段（今天/7 天/30 天）；汇总账本；按时间；按 agent；按类型（普通会话 vs 终端会话等） |
| Diagnostics | Web build（检查更新/重载）｜ relay socket 状态 ｜ 机器与 daemon（更新徽章、claude 缺失）｜ 开发者：verbose/console 日志 |

---

## 3. 状态与徽章词汇表

| 位置 | 视觉 | 含义 |
|---|---|---|
| 侧栏 header 点 | 绿 / 脉冲 / 灰 | 到 relay 的 socket 已连 / 连接中 / 断开 |
| 会话行左点 | permission 脉冲 / thinking 脉冲 / connected / offline | 待审批 / 在跑 / 在线空闲 / 进程不在线或归档 |
| 终端行小点 | thinking 脉冲 / permission | 终端里 Claude working / needs_input |
| 行右缘点 | accent 脉冲 / 灰 | 待处理（等你）/ 未读（跑完没看） |
| 行徽章 | `restored` / tag chip / `priority` | daemon 重启后恢复 / 标签 / 优先 |
| 看板卡片脚注 | `review` `blocked` / 工具名 / `machine offline` / `ended` / `ready to collect` / `waiting 4m` | LLM 判定 / 卡在哪个工具 / 机器离线 / 进程死了 / 跑完没收 / 等待时长 |
| 会话 header | relay 标签 + 点 | 区域 relay 与连接 |
| composer mode 副文案 | `· switching` `· CLI: x` `· at start` `· unconfirmed…` | 权限模式与 CLI 事实的一致性 |
| 上下文表 | 绿/黄/红 | 用量 <90 / ≥90 / ≥95% |
| 机器页 | `Claude · max` 绿徽 / 红徽；Update available / required | daemon 上下文 Claude 登录；CLI 版本策略 |
| 全局横幅 | CLI UPDATE AVAILABLE / REQUIRED | 见 1.3 |
| 通知类别 | 🔑 ❓ ✅ ⚠ | permission / question(review/blocked/needs input) / done / error |

---

## 4. 主要旅程（现状）

### J1 首次运行：注册 → 配对机器 → 第一个会话
1. Landing → Sign up：邮箱验证码（默认）/ Google / 密码；可能撞上邀请制或容量满。
2. 登录后 `/` = `FirstRunScreen`：复制一条 bootstrap 命令（或三步手动）在自己电脑终端跑；`auth login` 打开 `/terminal/connect#key` → 点 Approve；`daemon start`。
3. 机器上线 → 自动跳 `/` + 弹窗「Your first machine is online」→ `HelpScreen`。
4. 点 **New conversation**：快速路径需要「最近机器+目录」，首次没有 → 打开 `NewSessionModal`：选机器、**手输目录路径**（可存为预设）、选 agent（claude bundled；codex/gemini/openclaw 未安装则灰 + 安装命令提示）、可选首条指令 → Create → 进入 `/session/:id`。新会话默认 **Review Changes First**（plan 模式）。
5. 或 **New terminal**：单机直开 tmux 终端；里面手敲 `claude` 也能跑（安装可选 hooks 后才有结构化镜像）。
6. 摩擦点：Claude 凭据必须在 daemon 环境里（`ANTHROPIC_API_KEY` 或 keychain/文件），首条消息才会暴露「could not authenticate」→ 机器页诊断；目录靠手输；第一次不知道 plan 模式会让每个工具都问。

### J2 日常循环：列表 → 会话 → 工具/diff/权限 → 队列/steer/停止 → /btw → 终端 → 文件 → 看板/Todo/Notes
1. 侧栏默认**按工作区分组**（machine+cwd），行有待处理/未读点；⌘K 或 ⌘1-9 切换。
2. 会话页：读 turn 聚合的 transcript；工具组折叠；Edit 类工具内嵌 diff；权限卡在底部 Approve/Approve for session/Deny；AskUserQuestion 直接点选项；plan 批准后自动继续。
3. 运行中发消息 = 入本地队列（可编辑/删/Steer）；Stop 方块中止；改 mode（如切 yolo）即时作用于当前 turn。
4. `/btw 这个报错什么意思` → 右栏侧问，不进主对话。
5. 需要真终端 → 侧栏「+」或 ⌘N 开终端；有镜像的终端在 header 一键切「Structured view」，手机上常驻结构化、桌面常驻 xterm（设备默认 + 每终端记忆）。
6. Files 面板：Changed files 看改了哪些（数量 + 增删行）→ 点开看**整文件**；Browse 逛机器目录；agent 提到的路径可点。
7. 收工：看板 ✓ Mark done（记录 + 归档 + webhook）或侧栏 Archive；归档可 Restore。
8. 旁路：Notes dock 存下一条 prompt（绑定当前会话，Insert into input）；Todos 读机器上的外部清单；剪贴板历史收 agent 推来的文本。

### J3 离开桌面：手机 PWA、通知、审批、恢复
1. 手机打开 veryhappy.dev → 安装卡引导加到主屏；登录态延续。
2. 后台事件：Web Push（PWA）/ 浏览器通知（tab 打开时）/ 提示音 / Webhook → IM 群。点通知深链到 `/session/:id` 或 `/terminal/..?tid=`。
3. 回前台：`resumeSync` 自动追平会话与终端，探活 socket。
4. 审批：进入会话页底部 PermissionCard 点 Approve；yolo 会话由 CLI（或旧 CLI 时 Web 代批）自动放行；终端里的 TUI 审批只能切回 xterm 面用底栏键盘按键。
5. 手机会话页：composer 三行起、设置收进 sheet、附件从系统文件选择器；终端页有键盘/WEB 键盘/行输入三种输入法。
6. 摩擦点：通知铃只在根侧栏；看板/状态视图各一套「等我」；镜像视图看不到 TUI 权限对话框只有一条「Switch back」横幅；多设备打开同一终端会互相挤宽度（已加 Refit）。

### J4 多会话 / 多机器
- 一个账号多台机器：侧栏工作区分组天然按机器+目录聚合；看板卡片带机器名；Todos 按机器切换；助手绑定一台机器。
- 机器管理：Settings → Machines → 机器页（daemon 停止、CLI 版本、Claude 登录诊断、删除）；Diagnostics 一眼看所有机器版本。
- 会话级：每会话独立 model/mode/effort（并成为该 agent 新会话默认）；`Approve for session` 只作用于当前会话；一个会话一个 wrapper 进程（单写者锁）。
- 并行 agent：Task 泳道把多个会话归到一个任务下（手动 Dispatch 或 daemon LLM 归类）；子代理在会话内以卡片显示生命周期。
- 缺：没有机器级筛选/切换器；没有 worktree/分支概念；没有跨机器路由（助手也只在一台机器派活）。

### J5 助手（meta-agent）与语音
- 入口：侧栏声波图标 / ⌘K「Voice assistant」/ `/assistant`。
- 流程：选机器 → 后台在 `~/.happy/assistant` 起一个隐藏 Claude 会话 → 按住说话或打字 → 助手用 `sessions_list/terminals_list` 盘点、`session_spawn` 派活（需要绝对路径）、`session_read/send` 跟进；派出去的会话完成后系统通报回助手，助手一句话汇报。
- 语音需要服务器配置 ElevenLabs（STT/TTS/流式），iOS 需先点「Enable spoken replies」。
- 现状弱点（Owner 视角）：只能 Claude、只能一台机器、派出的会话与看板任务没有绑定、助手会话本身隐藏（只能靠 URL 审计）、权限等待要跳到另一页、记忆只是一个 md 文件、没有日程/定时。

### J6 Codex / Gemini(ACP) / OpenClaw 会话
- 创建：NewSessionModal 选 agent（需该机器已装 `codex` / `gemini-cli` / OpenClaw 网关；daemon 上报可用性，未装置灰并给安装命令）；也可在终端里 `very-happy codex` / `very-happy gemini` / `very-happy acp -- <cmd>` / `very-happy openclaw` 起本地进程。
- 会话页与 Claude 共用 transcript/工具卡/权限卡；mode/model 列表按 flavor（Codex：read-only/safe yolo/yolo + gpt-5.x；Gemini：auto edit/yolo/plan + gemini 3.x/2.5）。
- 与 Claude 相比缺：无附件（composer 隐藏 📎）、无 `/btw`、无 Steer、无即时权限切换、无子代理卡、无「Restart」保证、无 Claude 登录预检；MCP 只给 title/clipboard/preview（无 report_progress → 看板 LLM 进度也拿不到）。

---

## 5. 移动端行为汇总

| 表面 | 手机上的形态 |
|---|---|
| 根 `/` | 全屏侧栏（无底部 tab）；搜索图标打开 ⌘K；看板/助手/设置/Notes/Todos/通知都在侧栏 header/footer |
| 会话页 | header 图标缩到 Back/标题/状态/Notes/btw/Files；composer 三行起、`Session settings` sheet；Files/btw 全屏覆盖；键盘弹起时视口钉住 |
| 终端页 | 深色 xterm + 底栏键位；Select 模式长按复制；Files 全屏；Refit width |
| 看板 | 三列退化单列，Done 默认折叠；泳道拖排改用菜单 Move up/down |
| Notes dock | 全屏覆盖；会话/终端 header 有便签入口 |
| 通知面板 | 全屏覆盖，仅根页面可达 |
| 助手 | 移动优先的全屏形态（logo 居中、按住说话） |
| 首次运行/登录 | 紧凑；安全区；PWA 安装卡 |

---

## 6. 走一遍表面后看到的明显 UX 缺口

> 只记「站在表面上就能看出来」的缺口；括号里注明 backlog/roadmap 是否已有对应项。

**注意力与状态**
1. **「等我」有三套并行表面且语义不完全一致**：侧栏 Status 视图、看板 Waiting 列、通知铃面板；终端行只有「needs_input」没有「未读」；未读是内存态、换设备即丢（仅「已读」跨设备同步）。没有一个「按紧急度排好、可就地处理」的统一收件箱。
2. **权限审批只能在会话页里做**：侧栏行、看板卡片、通知条目都不能就地 Approve/Deny（B-032 todo）；镜像视图连审批对话框都看不到，只有「切回终端」。
3. **没有「离开期间发生了什么」的摘要**：回到会话只有未读点 + 「↓ n」未读条数，没有 turn outline / 变更摘要 / 决策列表（roadmap「Durable work memory」）。
4. **看板 AI 分析（进度/attention/归类）只能在机器上改配置文件开**，Web 里只有说明文字；默认关闭意味着大多数用户看板卡片永远没有进度句。

**代码与评审**
5. **没有 worktree / 分支 / PR 概念**：新会话只有「目录」，UI 不显示分支，不能一键建 worktree（`NewSessionDraft.sessionType` 字段零 UI，B-042 todo），没有 PR 状态或 CI 结果。
6. **Diff 评审停留在工具级**：Edit/Write 卡片各自一小段 diff；Changed files 只列文件名 + 增删行，点开是**整文件**而非 git diff（B-036 dropped）；没有整会话累积 diff、逐 hunk 接受/拒绝、行内评论、从 Web 提交/推送/开 PR。`open_preview` 的 diff 模式明确「不可用」。
7. **Web 端文件只读**：`files.editFile/saveFile` 文案存在但 FileView/FsFileViewer 没有编辑；改一行注释也得开终端。
8. **没有 fork / rewind**：`session.forkAction/duplicateAction` 等文案是上游遗留死字符串，web-v2 没有任何入口；想「从这一步重来」只能在终端 `claude --resume` 自己 fork。

**会话与输入**
9. **没有会话内搜索、没有 transcript 导出**（B-038 todo）；长会话 ChatList 未虚拟化（B-044）。
10. **没有 @文件引用 / 路径补全**（B-035 todo）；斜杠建议只补全命令名。
11. **新建会话必须手输目录**：预设是手工维护的 chip 列表，没有「最近项目 / git 仓库发现 / 目录浏览默认展开」；快速建聊只记一个「最近机器+目录」。
12. **附件与侧问只对 Claude**：Codex/Gemini 会话 composer 没有 📎、没有 /btw、没有 Steer、权限模式不能即时切；协议上是二等公民。
13. **Approve for session 之外没有规则管理**：不能查看/编辑「本会话已允许的工具」，更没有跨会话的允许列表或项目级策略 UI。
14. **模式诚实副文案暴露了复杂度**：`· unconfirmed (web auto-approves)` 之类是必要的真话，但用户要理解「Web 代批 vs CLI 执法」两套机制。

**终端**
15. 终端**没有 scrollback 搜索、没有字号调节**（B-037 todo），没有 Web 侧 tab/分屏（全靠 tmux 键）；多设备共用同一 pane 宽度靠「Refit width」手动打补丁。
16. 终端里手敲的 claude 要先 `very-happy install-terminal-hooks` 才有镜像，且镜像严格只读（写入靠一个「粘进终端」的输入条）。

**多机器 / 多 agent / 助手**
17. 机器只存在于设置和诊断页里；侧栏/看板没有**按机器筛选**，没有机器离线的全局提示（会话行只是变灰）。
18. 助手（meta-agent）单机、单 Claude、隐藏会话、派活与看板任务不打通、无定时/重复任务（roadmap「provider-aware coordination」「scheduled work」）。
19. 用量只有 Settings → Usage 的聚合视图；会话内只有上下文表，**没有本会话花了多少钱/token**。

**移动端与导航**
20. 手机没有底部导航；看板/通知/Todos/Notes 都要先回根侧栏；⌘1-9、拖排、桌面快捷片段菜单在手机上不存在（菜单里的 Move up/down 是替代品）。
21. 通知铃在会话详情页不可达（B-046 dropped）；只能靠提示音或 Push。

**健壮性（用户可感）**
22. Web 无 ErrorBoundary（渲染异常 = 白屏）、无离线/重连横幅（B-027 todo）；Webhook 零重试（B-026）。
23. 「关闭 ⌘W」在浏览器 tab 里其实关的是 tab，文案要解释一大段；`Alt+W` 替代不直觉。

---

## 7. 已在 backlog / roadmap 里计划的项（与上面缺口对照）

| 缺口 | 已计划 |
|---|---|
| 就地审批（侧栏/看板卡片） | B-032 todo |
| @文件引用 + 斜杠补全 | B-035 todo |
| 终端搜索 + 字号 | B-037 todo |
| 会话内搜索 + transcript 导出 + 图片进 transcript | B-038 todo |
| worktree 会话 UI + 新建会话最近路径/目录补全 | B-042 todo |
| 长会话虚拟化 | B-044 todo |
| Web ErrorBoundary / 离线横幅 / 消息 LRU | B-027 todo |
| Webhook 重试 + 投递失败进诊断 | B-026 todo |
| 工作区成为一等视图（Changes 直达等） | B-208 doing |
| 统一 Usage（终端 + 所有 agent） | B-211 doing |
| 终端 tag 编辑 | B-216 doing |
| 对话展开/收起降噪 | B-209 doing |
| 离线会话可恢复 + loading | B-268 doing |
| daemon 升级后自动换 wrapper | B-279 todo |
| 从 Web 发起 `claude auth login` | B-277 todo |
| 死设置清理（diffStyle split 等 12 项无消费者） | B-041 todo |
| 多地域 relay plane | B-192 doing |
| 更好的通知系统（分级/聚合）、`notify`/`open_url` MCP 工具 | B-008 / B-141 / B-142 **dropped** |
| Git diff 面板 | B-036 **dropped** |
| ⌘K 增强、看板过滤/批量、详情页通知铃 | B-039 / B-043 / B-046 **dropped** |
| 可靠调度器（跨 agent/机器）、子任务进度回传、显式 fork 与多 agent review、workspace/project/checkout/task 一等概念、按在场/活动路由通知、定时/流水线、Tauri 桌面壳、「虚拟办公室」 | `docs/roadmap.md` Next / Long-term（未落 spec） |
