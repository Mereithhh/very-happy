# Paseo（paseo.sh）— UX 流程 / 交互 / 视觉设计研究

- 研究日期：2026-09-03（工具抓取时间戳 2026-09-02 UTC 晚间）
- 观察到的版本：Paseo 0.7.2（2026-09-02 发布；CHANGELOG 共 118 个版本，0.1.42→0.7.2 用了 5 个月，多为每周多发）
- Lens：UX flows / interaction / visual design；为 very-happy 做第一性原理对比，不受现有架构约束
- 证据标注：**[OBSERVED]** = 文档 / 截图 / changelog / 仓库设计文档里直接看到；**[INFERRED]** = 我的推断
- 原始抓取物：`raw/`（hero-mockup.png、mobile-mockup.png、CHANGELOG.md、repo-docs/*.md）

## 0. 结论先行

1. Paseo 的核心 UX 赌注是把 **「注意力队列」做成信息架构本身**：侧栏可按状态分组为 Waiting on you / Ready to review / Working / Done，每行带「进入该状态多久」的相对时间、PR 号 + checks 结果、diff 统计、host 徽标，并且有「Mark as read」把一个 workspace 的 attention 清掉 [OBSERVED: PR #1317, CHANGELOG 0.1.90, 首页 mockup]。这是 very-happy 目前最缺的一层（very-happy 的会话列表是时间序 + 权限徽标，没有「等你」桶）。
2. 它的对象模型是 **Project → Workspace（目录 / 受管 worktree）→ Session（agent / terminal / browser / diff，每个是一个 tab）**，agent 只是 workspace 里的一种 tab；review、PR、services 都挂在 workspace 上 [OBSERVED: /docs/workspaces, glossary]。very-happy 是「session 即一切」，没有 workspace 容器，review 只能在会话内看 tool 输出。
3. Paseo 对 Happy Coder 的定位性批评集中在 5 点：Happy 只是 **wrap CLI + 同步会话**（daemon 不拥有 agent 生命周期）、**不管理 worktree 生命周期**、**app 内没有 GitHub 工作流（commit/push/PR/checks/merge）**、**CLI 没有 schedule/loop**、**没有应用级插件**；桌面端只有 macOS、provider 只有 Claude/Codex [OBSERVED: /alternatives/happy-coder]。这些批评对 very-happy 大体成立（very-happy 有 task board / notes / btw 等 Happy 没有的东西，但 review-to-ship 链路同样缺）。
4. 值得直接抄的 UX 机制（按影响排序）：状态桶侧栏 + 清除 attention；agent 级 `requiresAttention` 驱动通知深链与打开 workspace 时自动聚焦；presence-aware 通知路由（heartbeat 报设备 / 可见性 / 聚焦 agent，只用来决定是否通知、绝不当作投递门槛）；**Auto Review 权限模式**（每个 assistant turn 后停下等 review，介于 yolo 与逐工具审批之间）；Changes/Files/Commits + 行内 diff 评论回灌 agent + PR checks failure-first；turn footer 的「Worked for 31m 46s」+ fork/rewind；composer 上方的 tasks / subagents / +1.9k −684 药丸；Steer vs Queue 明确语义；小模型生成 workspace 标题 / 分支名 / commit / PR 正文；heartbeat（agent 自己定时唤醒）。
5. 反模式：关掉根 agent 的 tab = archive（视图与生命周期耦合，作者自己承认是「用户已被训练出来的行为」）；概念词汇过重（Project/Workspace/Session/Tab/Agent/Subagent/Detach/Archive/Label/Pin/Group/Profile 需要一份带「禁用词」的 glossary）；0.5.0 引入的 Side panel 在 0.6.0 被撤回；配对时的 relay opt-in 提问 + 「QR 等同密码」把安全决策压给第一次用手机的人；App Store 8 月评论仍在抱怨切后台后回到首页、项目丢失。

## 1. 定位与信息架构骨架

**定位** [OBSERVED: /docs/why, docs/product.md, HN 帖]：「coding agents 的 control plane」。daemon（Node）在你的机器上拥有 agent 进程；desktop（Electron，内置 daemon）、iOS/Android（React Native 原生，非 webview）、web（hosted app.paseo.sh 或 daemon 自带 `--web-ui`）、CLI、TypeScript SDK、MCP 都连同一个 daemon。无账号、无遥测；远程访问走 E2EE relay（默认关闭、配对时询问）、Tailscale 直连或 SSH。作者起点是「在散步时用手机 SSH 进 tmux 看 agent，体验很糙」，先做了纯语音 app，dogfood 几个月后变成现在这样 [OBSERVED: HN]。

**IA 骨架** [OBSERVED: 首页 mockup 文本、hero-mockup.png、glossary「Sidebar items」]：

```
左侧栏
├─ 顶部固定项（可在 Appearance 设置里排序/隐藏）：New workspace · History · Search · Schedules · (插件贡献项，如 mockup 里的 "Release Radar")
├─ Pinned（可拖拽排序）
└─ Workspaces（两种分组：按 Project，或按 Status：Waiting on you / Ready to review / Working / Done）
    └─ 每行：标题（小模型生成的任务式标题或分支名）· 相对时间 · 可选：host 徽标、PR 号+状态、checks 结果（"3981·passed"）、diff 统计（+466 −124）、service 健康
底部：当前 host（绿点 = 已连接）· "+" · 设置
主区：workspace header（分支切换器 · "View PR" · +466 −124 · Changes | Files）
      ├─ tab 栏：agent / terminal / browser / diff / 插件面板，⌘D / ⌘⇧D 分屏
      ├─ agent pane：timeline（折叠的 Shell 行、assistant 正文、turn footer）
      │    └─ composer 上方药丸：6/6 tasks · 3 subagents · +1.9k −684
      │    └─ composer："Message the agent, tag @files, or use /commands and /skills"
      │         工具条：附件 · 模型（GPT-5.6-Sol）· 推理档（Medium）· 权限模式（Full access）· 麦克风 · 语音模式
      └─ Explorer 侧栏（⌘E）：Files | Changes（Uncommitted/Committed 下拉，目录级 diff 统计）| Commits | PR 面板
```

「Release Radar」出现在首页 mockup 的顶部固定项里，但文档只列了 New workspace/History/Search/Schedules + 插件项，因此我判断它是一个插件示例 [INFERRED]。

**术语纪律** [OBSERVED: docs/glossary.md]：仓库里有一份「UI label 优先、禁止同义词」的 glossary（禁用 Repo/Folder/Checkout/Task/Job/Run/Side panel/Status bar 等）。这对多 agent 并行开发的一致性很关键，very-happy 的 design-language.md 可以补一节等价物。

## 2. Journey A：首次运行 / 上手

**桌面** [OBSERVED: /docs, changelog]：下载 → 打开 → daemon 自动起（无需知道「daemon」是什么，作者在博客里说这是放弃 Tauri 转 Electron 的主因之一：想要「一键体验」+ 可点击落到正确位置的通知）→ 短暂启动屏 → 主页 quick tiles：Add project / Import session / Set up providers / Pair device（0.1.6x「New home screen with quick tiles」）。前置条件是**你自己装好并登录至少一个 provider CLI**，PR 相关功能还要 `gh`。第一个坑是 PATH：Dock 启动的 app 拿不到终端环境，Paseo 会跑一次 `$SHELL -i -l -c` 捕获登录 shell 环境；仍找不到时 Settings → host → Providers → provider → **Diagnostic** 显示 Resolved path / Daemon PATH / Version [OBSERVED: /docs/troubleshooting]。

**手机** [OBSERVED: /docs/connectivity, /docs/security, App Store]：装 app → welcome 屏带 setup 提示与 paseo.sh 链接 → 需要一个已在跑的 daemon → 桌面 Settings → your host → Pair a device → **Enable relay**（新装默认关，此处询问；CLI 是 `paseo daemon pair`）→ 扫 QR 或粘贴 pairing link。QR 是信任锚（含 daemon 公钥），文档明说「treat it like a password」，0.5.0 还在桌面和 CLI 的配对链接旁加了「password-equivalent」警告。不用 relay 就走 Tailscale：填 IP + 6767 + 密码。

**Web** [OBSERVED: /docs/web-ui]：daemon 自带 web UI 时，浏览器打开 `http://localhost:6767/` 自动连同源 daemon，跳过 Add host；hosted app.paseo.sh 则需要配对 offer URL。静态页在鉴权前就能加载（为了渲染登录屏），API/WS 才要密码。

**评分**：
- 优秀：桌面「打开即用」+ 环境捕获 + Diagnostic 面板把「终端里能用 / app 里不能用」这个最常见故障做成了可自助的诊断。very-happy 的 Claude 认证预检（`daemonState.claudeAuth`）是同一思路，但只覆盖认证，没覆盖 PATH/版本。
- 摩擦：手机第一次连接要做两个安全决定（开不开 relay、QR 是密码）；issue #416 自己承认「localhost web client 也要扫 QR 是摩擦」。零账号的代价是每台设备都要配对一次；很像 very-happy 的 machine pairing，但 very-happy 有账号，所以 web 端不用配对——这是 very-happy 天然更顺的一环。

## 3. Journey B：日常循环

**开始工作** [OBSERVED: /docs/workspaces, /docs/worktrees, changelog]：`New workspace` 全局按钮（可先不选项目）→ 选 Isolation：Local（复用 checkout）或 New worktree（branch-off / checkout-branch / checkout-PR）→ 可以不打 prompt 直接开一个空 workspace 开终端/服务，也可直接下第一条 prompt。worktree 创建时跑 `paseo.json` 的 setup（装依赖、拷 .env），declared services 得到独占端口和 `web--fix-auth--my-app.localhost:6767` 这样的确定性代理 URL；setup 失败才自动弹出 Setup tab（0.5.0 改的）。标题、分支名由小模型自动生成，可按项目给指令 [OBSERVED: /docs/metadata-generation]。

**看 N 个 agent** [OBSERVED: 首页 mockup, PR #1317, docs/agent-lifecycle.md]：
- 状态桶是 workspace 级聚合：根 agent 与跨 workspace 子 agent 各自贡献状态；同 workspace 的后代只贡献 `running`，它们的 attention/permission/error 留在父 agent 的 Subagents track 里；terminal 活动也参与聚合（「Terminal activity stops after an interrupted turn」）。
- 每行的 `statusEnteredAt` 有「priority unmasking」语义：高优先级桶清掉后回落到低优先级桶时时间戳仍稳定。
- 会话按最近活动排序；Sessions 顶部有快速搜索与显示菜单（选择行上显示 host/PR/checks/scripts；项目过滤；labels）。
- 「Opening a workspace auto-focuses the agent that needs your attention」（0.1.7x）。
- Workspace focus mode（只留当前 workspace，有可见退出控件）。

**被拉进来** [OBSERVED: changelog, glossary]：
- 权限：提示卡片；Claude 的 question 通知会摘要「要你输入什么」；多个问题一次只出一个；ACP 可「一键批准全部工具调用」，OpenCode 可「整个会话批准」；CLI `paseo permit ls/allow/deny`；MCP `list_pending_permissions` / `respond_to_permission`。
- **Auto Review 模式**（0.1.76）：agent 每个 assistant turn 后停下等你 review，而不是无人值守跑完——这是把「yolo vs 逐工具审批」之间的第三档做成了 permission mode。
- **Steer vs Queue**：设置里 Default send 决定 Enter 是「Send and steer」（注入正在跑的 turn）还是进 Queue track（客户端保存到 turn 结束）；在 agent 等权限时发消息会**先 deny 那个请求**再把消息送进同一 turn，避免消息卡在权限后面。停止按钮和 Esc 都是 interrupt，未被读取的 steer 会丢（文档明说没有任何 provider 支持撤回）。
- 子 agent 的通知去的是**父 agent**（finish/error/需要权限时通知调用者，权限是检查点不是终点），人只在根 agent 需要时被打扰 [OBSERVED: docs/agent-lifecycle.md「notifyOnFinish」]。

**Review & ship**：见 §5。

**评分**：
- 优秀：状态桶 + 时间戳 + Mark as read 把「我该看哪个」变成一眼可答；Auto Review 是我见过最干净的「半自动」档；子 agent 通知回父 agent 而不是回人，是让 orchestration 真正减少打扰的关键设计。
- 摩擦：首页 mockup 里 Done 桶下面挂着 9 条 3–5 天前的东西（「Undefined task」「Task for abcdefghi」），说明 Done 桶会堆积，需要 auto-archive（PR 合并后自动归档是 host 级开关，非默认）；概念太多（见 §11）。

## 4. Journey C：手机 / 离开桌面

**能做什么** [OBSERVED: mobile-mockup.png, App Store, changelog]：首页宣称「native mobile app has full feature parity with desktop」。四张官方截图：Sessions 列表（项目分组、PR 号 + Open 徽标）；Settings（Hosts 列表带绿点与 host 类型图标、Add connection、Theme、「Keyboard shortcuts are only available on desktop」、Test audio、Version）；Changes diff 视图（Committed 下拉、View PR 按钮、语法高亮 diff）；Terminal（底部 Ctrl / Shift / Alt / Esc / Tab / ↑ ↓ ← 修饰键条，新终端支持选择/复制/粘贴）。语音：dictation（本地 Parakeet）与 voice mode（本地 Kokoro TTS + 隐藏的 agent 会话做「语音编排」），voice mode 在 agent 运行时隐藏。可从剪贴板贴图、附文件；agent 配置在手机上合并成一张 options sheet（0.5.0）。

**交互模型** [OBSERVED: docs/mobile-panels.md]：紧凑布局只有三个互斥目的地——左 `agent-list`、中 `agent`、右 `file-explorer`——由一个归一化位置（−1/0/1）驱动，两侧抽屉与遮罩不可能同时打开；冷启动总是落在 `agent`。这是「一个手势模型」而不是「两个独立抽屉」。

**怎么知道需要你** [OBSERVED: App Store 描述「push notifications when tasks complete」；changelog「Notifications now open the correct workspace and agent」「In-app notifications route to whichever surface you're actually looking at」「Agent notifications no longer get swallowed by a backgrounded focused client」；docs/timeline-sync.md]：客户端 heartbeat 上报设备类型、app 可见性、聚焦的 agent、最近活动，**只用于通知路由**；文档明确「presence is not delivery」——不能因为某台手机的 stale 聚焦心跳而少推送，更不能少投递 timeline。通知点击深链到正确的 workspace + agent。

**怎么回答审批**：同桌面（卡片 + 一次一个问题）。没有看到「锁屏通知上直接 approve」的证据 [INFERRED: 没有]。

**刻意不在手机上的**：键盘快捷键、Browser tools（tab 由桌面 app 承载，daemon 只做 broker）、Open location 布局偏好（mobile 忽略）；插件的 client 贡献**在手机上也生效** [OBSERVED: /docs/plugins, /docs/browser, docs/explorer-sidebar.md]。

**评分**：
- 优秀：三面板单手势模型；终端修饰键条；diff 上的行内评论可以直接回灌 agent（App Store 评论「a diff viewer I can comment on… fork the entire convo history to a new harness when I exhaust the quota」）；push 深链到 agent。
- 摩擦：2026-08-17 的 App Store 评论：切后台一段时间回来会回到首页而不是恢复会话，「projects I added also disappear」——尽管 changelog 早有「Mobile restores the saved workspace on launch」，说明恢复仍不可靠；0.7.2 仍在修「mobile sidebar and explorer panels losing their settled position when a JS stall crossed the animation」和「Reduced JS stalls while watching a streaming agent on mobile」，长会话流式渲染在 RN 上仍是性能热点。very-happy 是 PWA，没有原生 push 之外的手段，但也没有 RN 的 JS stall 问题。

## 5. Journey D：Review 时刻

[OBSERVED: hero-mockup.png、首页 mockup 文本、changelog、/docs/metadata-generation]

- **在哪 review**：Explorer 侧栏 Changes（Uncommitted / Committed 下拉，目录树逐级显示 +/−）、Files、Commits（可浏览提交历史并打开单个 commit diff）；PR 打开位置三选一（Main panel / On the side / Explorer sidebar，默认 Explorer）；紧凑布局永远在 Explorer 里开。
- **评论回灌**：diff 行内评论 → 作为附件发回 agent（0.1.65 #530）；PR 面板可把 PR comments / reviews / threads / **failed check logs** 一键附到 chat；粘贴 GitHub PR/issue URL 即附件。
- **CI**：PR checks 有 outcome summaries 与 failure-first 分组；GitLab/Gitea 的 manual / action-required / warning 状态也有；轮询走共享的 GitHub API 预算。
- **ship**：git 头部按钮按状态提升（分支落后 → Pull 提到主位；领先 → Push 在 merge 前；ready 分支默认走 PR）；merge 方式命名（squash / merge / rebase）；GitHub auto-merge 动作在 PR hover card；PR 合并后自动归档干净 workspace（host 级开关），归档有未提交/未推送改动时先确认；commit 走配置好的 Git signing。
- **「Create a PR」**：首页 mockup 里是 agent 回复后的一个动作 → 下一条 agent 消息「PR opened: … https://github.com/getpaseo/paseo/pull/3981 · Ships … · Formatting, typecheck, and lint are clean. Ready for review. Worked for 1m 18s」。PR 标题/正文由 metadata generation 起草。它是 composer 快捷动作还是 skill，文档未说 [INFERRED: 更像是一条内置 prompt/skill，因为结果以 agent 消息形式出现]。
- **turn footer**：每条消息有时间戳，每个 turn 显示耗时（「Worked for 31m 46s」）、复制、fork（完成的 turn 处 fork 截止到该 turn；进行中的 turn 处 fork 包含正在流式输出的内容；可 fork 到新 tab 或新 worktree、跨 provider）；任意用户消息处可 rewind chat 或 files。

**评分**：
- 优秀：review 不离开 workspace、评论直接变成 agent 输入、CI 失败日志一键成为上下文——这是 Paseo 相对 Happy 类产品最大的差异化，也是 very-happy 目前完全没有的一段（very-happy 的 review 只能在聊天里看 tool 输出或开 web 终端跑 git）。
- 摩擦：大 diff 曾卡死（0.7.2 才修「large and many-file diffs stalling or crashing」）；单条 assistant 消息超 32k 字符会直接截断渲染（0.7.2）；PR 打开位置有三个偏好 + 每种内容一个 Main/Side 偏好，是设置蔓延。

## 6. Journey E：恢复

[OBSERVED: docs/product.md, docs/timeline-sync.md, docs/agent-lifecycle.md, changelog]

- **网络断**：daemon 拥有 agent，「Agents keep running when a client disconnects」；重连时**先立即画出缓存的 projects/workspaces/agents/timelines**（0.5.0），再做 gap recovery——按页拉 `after` 直到 `hasNewer:false`，失败按 1s→30s 指数退避且「background retries are silent」，只有用户按 sync-error callout 里的 Retry 才显示 in-flight；重连提示区分「daemon 重启」与「网络中断」（0.3.0）；「Messages no longer duplicate or arrive out of order after a reconnect」（0.3.0）。
- **机器休眠**：「Fixed terminal sessions being lost after host sleep or daemon worker stalls」（0.4.0）；idle agent 会自动释放进程、需要时恢复（0.2.x）。
- **agent 崩了**：provider 运行时在两个 turn 之间死掉时，agent 会「sits at idle looking healthy while its background work is gone」——文档坦承只有 Claude provider 会把这种退出报成 turn failure 进 `error` 并写 timeline 行，其他 provider 还不会。crash screen 保持可读且 Retry 可达。
- **认证过期**：已运行的会话保留启动时的认证，重新登录 Claude 后要**新开会话** [OBSERVED: /docs/claude-code]——与 very-happy 铁律 7/14「wrapper 不热替换」同构。
- **Hub 触发**：daemon 离线时 dispatch 直接失败、**不排队不重试**（`daemon_not_connected`）。
- **桌面 app 退出会停掉它启动的 daemon**（自己跑的 daemon 不受影响）——文档把它当「restart the app 是真修复」的优点，但也意味着关 app = 关 agent。

**评分**：优秀在「先画缓存再补齐」+ 静默退避 + 用户触发的 retry 有自己的 pending 态（very-happy 的 resumeSync 单入口思路一致，但 very-happy 没有「缓存立即上屏」）。摩擦在运行时死亡检测只有 Claude 有；Hub 无重试。

## 7. 注意力管理与通知策略（汇总）

[OBSERVED 来源见各条]

| 机制 | Paseo 做法 | 出处 |
| --- | --- | --- |
| 需要你的状态 | agent 级 `requiresAttention`；workspace 级桶 Waiting on you / Ready to review / Working / Done；`statusEnteredAt` | PR #1317 |
| 清除 | 侧栏行 Mark as read（host 侧执行，对未加载的存储 agent 也有效；支持批量） | PR #1317 |
| 通知路由 | heartbeat（设备、可见性、聚焦 agent、最近活动）只决定是否通知；in-app 通知路由到你正在看的 surface；backgrounded 客户端不会吞掉通知 | timeline-sync.md, changelog |
| 深链 | 通知打开正确的 workspace + agent；打开 workspace 自动聚焦需要注意的 agent | changelog |
| 桌面 | 原生通知 + 声音 + badge 计数跨 workspace 一致；这是作者换 Electron 的核心动机 | 博客, changelog |
| 子 agent | finish / error / permission 通知给父 agent；permission 是 checkpoint，之后还会再通知 | agent-lifecycle.md |
| 噪音控制 | Claude subagent 旁白不进主聊天；subagent task 通知不污染父 timeline；spurious needs-attention 已修 | changelog |
| 问题 | 多个问题一次一个；通知里摘要要求的输入 | changelog |
| 无人值守档位 | Auto Review（每 turn 停）/ bypass / plan / 各 provider 模式；Shift+Tab 不再误改后台 agent 的模式 | changelog 0.1.76 |

## 8. 键盘 / Command Center

[OBSERVED: changelog, /docs/plugins]：⌘K Command Center 覆盖 workspace 搜索（含 PR/MR 号）、git 与 workspace 动作、模型/推理/模式/plan/fast 切换、面板/tab/pane 与布局动作、侧栏分组、主题；多词乱序匹配 + 按可见结果排序；插件可注册 Command Center 项。快捷键完全可重绑、支持 chord、Mac/Win 区分、可取消绑定、快捷键帮助可按动作/键搜索；侧栏行显示序号徽标；⌘D/⌘⇧D 分屏，⌘E 切 Explorer，Esc 中断 agent（0.7.2 修了「Esc 关图片预览也把 agent 中断了」），中键关 tab。手机上「Use the command center from mobile」也存在。

**评分**：完整度高；反例是 Esc 语义重载（关预览 vs 中断 agent）造成误伤，very-happy 若加「Esc = stop」要做焦点作用域。

## 9. 视觉语言与密度

[OBSERVED: docs/design.md（38 KB 设计规范）, hero/mobile mockup]

- **性格**：「minimal, spacious, quiet, confident… The app is calm so the user's work is not.」每个视觉决策要么服务「act on this」要么「understand this」，从不「look at this」。
- **层级靠字重与颜色，不靠字号**：界面 14px 基准（原生 15px），正文内容单独 16px token；三档字重（ScreenTitle 400/300 更轻、结构标签 medium、内容 normal）；`foreground` 是被操作的对象，`foregroundMuted` 是上下文。
- **强调色纪律**：accent = 每个 surface **最多一个** CTA，多数页面为零；destructive 红色只在 confirm 对话框里出现（「Red appears after the user has indicated intent」）。
- **状态色**：每种状态信号只有一个 token（success / danger / warning / merged），所有 PR 图标、CI 饼、diff 统计、pill、usage bar 共用；**状态圆点是单独一族**（success/danger/warning/running，running 会脉动），色度比状态文字更高（90% vs 55–60% gamut chroma），因为 6pt 的点没有形状可读；身份色（项目图标、host 徽标、PR 头像）来自固定 10 色表，与状态色分离，「identifies rather than ranks」。
- **状态变化不许移动布局**：为加载态预留空间，「A surface that shifts under the user stops feeling calm」。
- **紧凑优先**：小屏是设计对象，大屏加 chrome；list+detail 是唯一的两种壳之一（另一种是 workspace 壳），发明第三种要过 design review。
- **文案**：sentence case，行标题/按钮无句号，空态是短名词短语（「No sessions yet」），错误直陈不道歉（「Unable to remove host」）。
- **主题**：六种以上（Midnight、Claude、Ghostty dark、Pure black…）、自定义界面/代码字体、语法高亮主题、插件主题；截图全部是近黑底、灰字、绿/红 diff 统计、极少图标，accent 几乎不可见。等宽体只用于代码/diff/终端，**不是**终端风格 app。

**与 very-happy 的关系**：very-happy「teal 只表示 live」与 Paseo「accent 只做唯一 CTA + running 点单独一族」是同一纪律的两种写法；差异在 Paseo 整体是「安静的 app」，very-happy 是「穿在浏览器里的终端」。可借鉴的是状态色 token 单一化、状态点单独调色、布局不位移这三条规则文本。

## 10. Paseo 对 Happy Coder 的批评 → 对 very-happy 的适用性

[OBSERVED: /alternatives/happy-coder；适用性判断为 INFERRED]

| Paseo 的说法 | 对 very-happy 是否成立 |
| --- | --- |
| Happy 「wraps the agent CLI on your laptop and syncs sessions」；Paseo 「daemon owns agent lifecycle, worktree, dev servers」 | 成立：very-happy 的 daemon 只负责 spawn/handover，session wrapper 是独立进程，没有 workspace/worktree/service 概念 |
| GitHub workflow in app：Happy 「—」 | 成立：very-happy 没有 commit/push/PR/checks/merge 面板 |
| Managed Git worktrees：Happy 只能「选一个已存在的 worktree 路径」 | 成立 |
| Per-worktree dev server URLs | 成立（very-happy 有 web 终端可手动跑，但无端口分配/代理） |
| CLI：Happy 「launch and control sessions」，无 schedules/loops | 成立；very-happy 有 spawn/send/MCP 入站契约（docs/channels.md），无 cron |
| Application plugins | 成立 |
| Desktop 只有 macOS | 不适用（very-happy 是 web-only，反而是全平台） |
| Providers 只有 Claude/Codex | 部分成立：very-happy 有 Codex/ACP 会话 |
| Voice：两者都有 | very-happy 有 voice-assistant 工作树但未成产品 |

未被 Paseo 提到但 very-happy 有的：task board、notes、/btw 侧问、durable tmux web terminal、机器页认证预检。Paseo 没有独立的「assistant/dispatcher」屏——它把编排能力做成 **注入到每个 agent 的 MCP 工具 + 三个 skill（/paseo-handoff、/paseo-committee、/paseo-advisor）**，人只对着主 agent 说自然语言，这可能是 very-happy「assistant 屏弱且没人用」的反面教材：编排不该是一个独立页面，而是主会话里的工具 [INFERRED]。

## 11. 可借鉴（按 UX 影响排序）与反模式

见结构化摘要（borrowable_for_very_happy / anti_patterns）。补充几条这里更适合展开的判断：

- 状态桶的**前提是 agent 级 attention 语义可靠**。very-happy 已有权限请求的可靠通道（铁律 12），缺的是「question / 完成待 review / 错误」的统一 attention 位与「清除」动作；先做这个位再做分组，否则分组会骗人。
- Auto Review 对 very-happy 尤其合适：它可以用现有 permission mode 出站清洗点（`normalizeClaudeOutboundMode`）实现为「每 turn 结束时自动 Stop + 标 Ready to review」，不需要 SDK 新能力 [INFERRED]。
- 「先画缓存再补齐」需要客户端持久化 timeline 副本；very-happy 是服务端可信、非 e2e，服务端本来就有全量，做「服务端快照 + seq 游标」比 Paseo 更容易。
- Paseo 把「关根 agent tab = archive」保留是为了不改用户习惯；very-happy 不背这个包袱，不要抄。

## 12. Open questions

1. Waiting on you 桶的精确构成（permission / question / error / 等待 review 是否都算）与桶内排序规则——PR #1317 只说明 `statusEnteredAt` 与 priority unmasking。
2. 手机 push 的策略细节：哪些事件推、是否按 presence 抑制、有无静默时段——文档只说「push notifications when tasks complete」。
3. 「Create a PR」是 composer 快捷动作、skill 还是普通 prompt；「Release Radar」是内置还是插件示例。
4. app.paseo.sh 的实际首屏（截图为空白 SPA），以及 light theme 的实际观感（所有官方图都是深色）。
5. 语义权限（PR #3981）何时变成用户可见的 device / viewer 角色与 pairing invitation UI——目前明确是「non-goals」。
6. 长会话性能上限：单条 32k 字符截断、大 diff 卡顿刚修，RN 端 JS stall 仍在处理。

## 13. Sources（均于 2026-09-03 读取）

| URL | 证明了什么 |
| --- | --- |
| https://paseo.sh | 首页文案与产品 mockup：侧栏项（New workspace/History/Schedules/Release Radar/Pinned）、状态分组 Ready to review/Working/Done、行元数据、thread 里的 tasks/subagents/diff 药丸、「Create a PR」流、mobile parity 声明、MCP fan-out 示例、FAQ |
| https://paseo.sh/hero-mockup.png | 桌面截图：项目分组侧栏、diff 统计、PR 徽标、tab 栏、View PR、Changes/Files、折叠 Shell 行、composer 工具条、手机叠图 |
| https://paseo.sh/mobile-mockup.png | 四张手机截图：Sessions、Settings（Hosts/Theme/Shortcuts only desktop/Test audio）、Changes、Terminal 修饰键条 |
| https://paseo.sh/docs | 上手：桌面自带 daemon、Pair Device、前置 provider CLI + gh |
| https://paseo.sh/docs/workspaces | Project → Workspace → Session 模型、Local/Worktree isolation |
| https://paseo.sh/docs/worktrees | paseo.json setup/teardown、scripts/services、端口分配、代理 URL |
| https://paseo.sh/docs/cli | permit / agent mode / schedule / hub / --host offer URL |
| https://paseo.sh/docs/mcp | 工具目录、权限工具、heartbeat vs schedule |
| https://paseo.sh/docs/connectivity | SSH / relay / Tailscale 配对流程 |
| https://paseo.sh/docs/security | relay E2EE 模型、QR 为信任锚、密码鉴权 |
| https://paseo.sh/docs/configuration | config.json、web UI、密码 |
| https://paseo.sh/docs/web-ui | daemon 自带 web UI 同源自动连接 |
| https://paseo.sh/docs/voice | 本地 Parakeet/Kokoro、voice mode 隐藏 agent 会话 |
| https://paseo.sh/docs/schedules 、/docs/schedules-chat | Schedules vs Heartbeats、从聊天创建 |
| https://paseo.sh/docs/orchestration 、/docs/orchestration-workflows 、/docs/skills | Subagents track、跨 provider 子 agent、/paseo-handoff /committee /advisor |
| https://paseo.sh/docs/plugins | 插件贡献面（含手机）、Command Center 项、⌘K |
| https://paseo.sh/docs/browser | Browser tools 桌面限定 |
| https://paseo.sh/docs/metadata-generation | 小模型生成标题/分支/commit/PR 正文、按项目指令 |
| https://paseo.sh/docs/claude-code | 用 claude CLI + Agent SDK、认证过期需新会话 |
| https://paseo.sh/docs/troubleshooting | PATH 诊断面板、登录 shell 捕获 |
| https://paseo.sh/docs/updates | Stable/Beta、36h 渐进发布 |
| https://paseo.sh/docs/why 、https://paseo.sh/download | 定位与安装矩阵 |
| https://paseo.sh/docs/hub 、/hub 、/docs/hub/quickstart 、/docs/hub/concepts 、/docs/hub/triggers 、/docs/hub/activity | Hub 触发器、from_users 必填、Activity 记录、daemon 离线不重试、€15/seat |
| https://paseo.sh/alternatives/happy-coder | Paseo 对 Happy Coder 的逐项批评 |
| https://paseo.sh/alternatives/claude-desktop 、/codex-app 、/superset | 分屏快捷键 ⌘D/⌘⇧D、GitHub 流、CLI 对比 |
| https://paseo.sh/blog/i-was-wrong-about-electron | 通知点击落位是必需、daemon 一键体验 |
| https://github.com/getpaseo/paseo | README：CLI/SDK/skills、包结构 |
| https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md | 0.1.42–0.7.2 全部条目（状态分组、Auto Review、通知路由、Command Center、fork/rewind、PR checks、恢复修复等） |
| https://github.com/getpaseo/paseo/pull/1317 | 侧栏状态分组 + workspace.clear_attention + statusEnteredAt |
| https://github.com/getpaseo/paseo/pull/3981 、https://github.com/getpaseo/paseo/issues/416 | 「semantic permissions」= daemon 级 principal/grant 模型（非工具审批 UI）；设备鉴权设计 |
| https://github.com/getpaseo/paseo/issues/259 | 「automation mode」被以现有能力关闭：Schedules、状态分组、queue、通知 + 行内 diff 评论 |
| https://raw.githubusercontent.com/getpaseo/paseo/main/docs/design.md | 设计规范全文 |
| https://raw.githubusercontent.com/getpaseo/paseo/main/docs/glossary.md | 术语与禁用词、Steer/Queue/Fork/Tracks 定义 |
| https://raw.githubusercontent.com/getpaseo/paseo/main/docs/agent-lifecycle.md | 状态机、tab 关闭=归档规则、subagent track、运行时死亡处理 |
| https://raw.githubusercontent.com/getpaseo/paseo/main/docs/timeline-sync.md | presence≠delivery、分页 gap recovery、退避与 retry callout |
| https://raw.githubusercontent.com/getpaseo/paseo/main/docs/mobile-panels.md 、docs/explorer-sidebar.md 、docs/product.md 、docs/permissions.md | 手机三面板模型、Explorer/side pane、产品哲学、权限目录 |
| https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924 | push 通知描述、用户评论（后台恢复问题、diff 评论 + fork 好评） |
| https://news.ycombinator.com/item?id=47397226 | 起源故事、初始功能集 |
| https://vibecodinghub.org/blog/paseo-review | 第三方评测（v0.4.0 时点） |
