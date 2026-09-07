# very-happy 自身：已知 UX 痛点 + 已规划工作（供竞品对比去重）

> 取证范围：`docs/backlog.md`（活跃区 52 项 + 近期完成区）、`docs/verify-queue.md`（待验 90 项 V-001…V-120）、
> `docs/roadmap.md`、`docs/PROCESS.md`、`specs/README.md` + 全部 57 个 spec 的标题/状态/目标节、
> `git log --since=2026-07-01 -- packages/happy-web-v2`（351 commits）。只读，不改 repo。
> 日期：2026-09-03。以 `B-xxx` = backlog id，`V-xxx` = verify-queue id，`#n` = PR。

## 0. 一句话结论

very-happy 过去 6 周的 UX 投入 **~30% 砸在「浏览器里的远程终端保真」**（几何/字体/CJK/IME/滚动，同类问题反复修 3–6 次），
**~20% 砸在会话生命周期语义**（删除→归档→恢复→离线→重生→单写者锁，六个 spec 连环），**~10% 砸在权限模式「UI 说 yolo 实际在问」**（5 个 backlog 项、两个 spec、四轮对抗 review）。
真正面向「多 agent 并行时哪里需要我」的核心循环（B-032 列表内直接批权限、B-069b 冷终端活跃上浮、分级通知 B-008）要么 todo 三周、要么被 dropped。
roadmap「Next」里的 6 条承诺（可靠调度器、决策回流、工作记忆、fork/review 流、presence 路由通知、定时流水线）代码里 **只有 workspace 分组 lens 和 web-push presence 门是部分落地**，其余为零。
待真机验证 90 项、最老 2026-08-13 —— **移动端与语音助手体验实际上从未被 Owner 闭环验收**。

---

## 1. 产品表面清单（按路由/代码确认）

| 表面 | 代码位置 | 备注 |
|---|---|---|
| 侧栏：列表 / 状态 / 归档三段；镜头 = 平铺 / 工作区 / 标签 | `screens/sessions/Sidebar.tsx`、`sidebarWorkspaceGroups.ts` | 工作区镜头已是默认（B-208 部分落地） |
| 结构化会话（Claude SDK / Codex / ACP Gemini·OpenCode / OpenClaw / 终端镜像只读） | `screens/session/*` | Queue/Steer/Stop、权限卡、AskUserQuestion、plan、子代理卡、附件 50MB、context meter、`/btw` 侧问面板 |
| Web 终端（tmux control-mode 内容流 + xterm 本地 scrollback） | `screens/terminal/WebTerminalScreen.tsx`（冲突热区） | 移动端自研 Web 键盘、输入行模式、选择模式、文件抽屉、快捷指令、接入已有 tmux、结构化镜像 toggle |
| 机器页 | `screens/machine/MachineScreen.tsx` | Claude 登录状态徽章/诊断/修复（B-276）、改名、开会话 |
| 任务看板 `/board` | `screens/board/*` | 三列生命周期（进行中/等我看/已完成）+ 泳道 + Dispatch + LLM 进展分析 |
| 笔记 dock + `/notes` | `screens/notes/*` | 账号 KV 同步、绑定会话、一键插入输入框 |
| 外部 Todo `/todos` | `screens/todos` | provider 命令契约（滴答/Tanka 只是实现） |
| `/assistant` 语音/文字 meta-agent | `screens/assistant/AssistantScreen.tsx`（777 行） | 单机绑定；最后一次功能提交 2026-08-14；Owner 视为弱、不用 |
| 通知：站内铃铛 + Web Push + webhook Channels + 提示音 + PWA badge | `screens/notifications/*`、`sync/notification*.ts`、server `push/pushDispatch.ts` | web push 有「有人在看该会话就不推」presence 门；webhook 明确 presence 无关 |
| 剪贴板历史面板、⌘K 命令面板、⌘. 快捷指令 | `screens/clipboard`、`screens/command` | |
| 设置：机器 / Voice / Usage / Channels / Diagnostics / 终端 | `screens/settings/SettingsRoutes.tsx`（冲突热区） | B-041：12 项设置无消费者 |
| 更新弹窗 + `/changelog`；CLI/daemon 更新横幅 | `screens/changelog`、B-040/B-284 | |
| Help / 首机 onboarding / 公开 Landing / Docs / PWA 安装引导 | `screens/help`、`onboarding`、`public` | Landing 三天内重做 ~6 次（08-24…26） |
| 文件浏览 + 预览 overlay（md/图片/PDF/源码）、`open_preview` 推送 | `screens/files/*` | |

---

## 2. Web 提交聚类（351 commits，2026-07-01 起）

时间分布：7 月 19、8 月 309、9 月 23。两个尖峰：**08-12/13 = 142 commits**（Web V2 大迁移+第一批 UX 走查），**08-24…26 = 88 commits**（开源/Landing/登录/onboarding/relay）。之后每天 7–14。

关键词命中（可重叠）：

| 主题 | 命中 | 反复出现的同类问题（证据） |
|---|---|---|
| 终端 / tmux / xterm | **100** | 几何与首帧：B-124/B-125（08-17）→ B-287/288/289（09-02）→ #159–#164 **两天六个 commit**（宽度回收、line-height、CJK 双宽字体、字体换入重量、UTF-8 locale）；spec `terminal-multi-device-width-reclaim` 原话「用户第 4 次报同一类问题」 |
| IME / 键盘 | 30 | 中文 IME 失效复发 **3 次**（spec `terminal-input-ownership`）；Step 0–3 + 回滚 `d652f685` + 「三修」`f7cf391b`；Android 229 keyCode；B-255/256 自研移动端 Web 键盘；V-039…V-050 共 12 项从 08-14 起未清账 |
| 移动端 / iOS / PWA | 36 | 首弹键盘、视口缩放、safe-area、后台回前台不刷新（B-259）、PWA 更新卡 loading（B-223）、登录页裁切（B-213/218） |
| 滚动 | 14 | 为「手机滑动不跟手」整条终端通道重架构（B-121 v2）；B-219/B-222 TUI 滚动；V-061…V-067 |
| Landing / 公开 / 登录 / onboarding | 37 | `rebuild the public product experience`、`add 3d agent fabric hero`、`sharpen landing hierarchy`、`sharpen landing value narrative`、`position very happy as an agent workspace`、`keep scheduler agent claims honest`（营销先于实现，需回收口径） |
| 侧栏 / 标签 / 排序 / 置顶 | 36 | 排序策略换了 **4 次**：手动分数序 → 最近活跃自动 → 实时化(B-067) → **禁用**(B-076，因 ⌘数字需要位置稳定)；侧栏 header 文字因图标溢出被删（`342bf785`）；看板第三 tab 从侧栏移除（`4134551c`） |
| 看板 / 任务 | 32 | V1 四态列 → V2 LLM+泳道+Dispatch → 生命周期三列翻转；随后 B-043 过滤/批量 dropped「无诉求」，B-032 列表内批权限 todo 三周 |
| 归档 / 恢复 / 重生 | 29 | B-083 archive-only → B-177 归档被心跳翻回 → B-149 重启 22 个终端无痕 → B-150 自动恢复 → B-265 归档恢复 → B-268 离线可恢复 → B-264 重生 → B-272 双 wrapper 锁：**8 个 spec 修同一件事「这个会话到底还在不在、能不能接回」** |
| 权限 / yolo / mode | 14 | B-243 → B-251 → B-254 → B-258 → B-262（四轮对抗 review）→ B-263 dropped；两次生产事故会话同一个（「Tanka 待办提取」） |
| Queue / Steer | 6 | B-231 → B-234 → B-240 → B-244：**两天四个 spec** 定义同一个 composer 的发送语义；用户看到 `[Request interrupted by user]`/`[ede_diagnostic]` |
| Loading / splash | 6 | 同一个启动 loader 修了 6 次（#44 #53 #79 #80 B-242 B-247）；V-089/V-102 |
| 语音 / 助手 | 21 | 全部集中在 08-13/14；此后零功能提交；V-022…V-026、V-032…V-034 三周未清 |
| 通知 | 15 | 角标不减(B-086)、浮层出屏(B-077)、首开风暴；B-008 分级通知 dropped |
| 文件 / 预览 / 附件 | 20 | 文件浏览→预览升级→分栏拖宽→50MB 任意文件→open_preview |
| 子代理 | 13 | B-260 两批 + B-261 顺序 bug |
| 复制 / 剪贴板 | 15 | copy_to_clipboard 三次改体验（弹窗→静默+toast→历史面板） |
| 更新 / changelog | 11 | B-040 精确版本提示、B-223 PWA 自刷、B-284 堆叠未读 |

---

## 3. (a) UX 痛点清单（带证据）

### A. 终端表面（最大投入、最高复发）

| # | 痛点 | 证据 |
|---|---|---|
| A1 | **多设备几何打架**：手机先开→桌面回来卡窄宽；历史行永久窄（硬行不 reflow）。结构性根因：一个 vh 会话只有一个 tmux control client，几何归「最后对 tmux 说话的人」 | B-287 doing；spec `2026-09-terminal-geometry-latest-viewer`（第一版 viewer 注册表被 3 轮 review 否决）；`terminal-multi-device-width-reclaim`「第 4 次报」；V-116/V-117/V-118 |
| A2 | **首帧按错宽度渲染、冻进 scrollback**（web 字体异步加载前量 cell）| B-289 doing；#163 CJK 字体换入再量；V-119 |
| A3 | **恢复快照 SGR 泄漏成整片绿** | B-288 doing；V-120 |
| A4 | **claude logo/八分块字形渲染破碎**（xterm 字形/atlas 问题）| B-109 todo 自 08-15；#161/#162 line-height 与 Sarasa 字体是绕行 |
| A5 | **中文 IME 在 web 终端反复失效**（xterm `_isComposing` 闸门依赖 compositionend）| spec `terminal-input-ownership` Shipped 但 Step 4 押后；一次回滚；V-039…V-050 未清 |
| A6 | **手机上打字：软键盘首弹鬼畜/视口跳/自动放大/Enter 缺** → 自研 Web 键盘 | B-178/179、B-255/256、V-103 未清、V-012、V-044/045 |
| A7 | **手机滑动回看不跟手** → 通道 v2 重架构；alt-screen（vim/claude TUI）仍走 RPC 轨不跟手 | B-121 Shipped；V-062「预期不跟手」；B-219/222 |
| A8 | **用户自己的 tmux.conf 打坏 web 终端**（base-index、destroy-unattached、window-size manual、remain-on-exit、pane-border-status）| B-269/B-270 done；铁律 17 |
| A9 | **同事在 web 终端里 `tmux attach` 被拒** → 一天内四轮迭代（区块隐藏不可发现→一等入口→直达选择器→关闭语义吓人）| B-273/280/281/282 done；V-113/V-114 |
| A10 | 终端无 scrollback 搜索、字号不可调（iOS 12px 偏小） | B-037 todo 自 08-13 |
| A11 | 冷终端（没人看）活跃上浮受 10s tmux tick 约束——「没人看的 agent 又开始跑了」是最扎的场景 | B-069b todo，判定「不值得」 |
| A12 | 手敲 claude 的结构化镜像 toggle 消失、恢复不回来 | B-271 done（reconcile）；镜像本身只读、需手动装 hook |

### B. 会话生命周期与「这个东西还在不在」

| # | 痛点 | 证据 |
|---|---|---|
| B1 | **归档会话里发消息是黑洞**；归档后无恢复入口（机制齐但 web 零调用）| spec `2026-09-archive-restore` 背景节；B-265 doing |
| B2 | **机器离线后会话从「列表」消失、归档里无恢复标志**，只能先手动归档再恢复；恢复无 loading | B-268 doing（同事实报）|
| B3 | **机器重启 22 个终端无痕消失**，靠 52MB 日志手工反推 | B-149/B-150 done（墓碑+自动恢复）|
| B4 | **一个会话跑出两个 wrapper**：消息显示 3 条、thinking 闪动、权限模式来回翻；杀一个会归档整个会话 | B-272 done；铁律 16 |
| B5 | **CLI 升级只换 daemon 不换存量会话**：旧代码会话继续坏（root 机器 0 秒死）；「重启会话」按钮是补救 | B-264 done；B-279 todo（空闲自动换代，Owner 说不急）；铁律 7/14 |
| B6 | 归档被 CLI 心跳翻回 active（刷新后复活）| B-177 spec `session-archive-lifecycle` |
| B7 | 状态词汇过多：列表/归档/离线/已结束终端/墓碑/processFailed/可恢复/镜像 ended… 用户要理解 ~8 种「不在」| 上述 8 个 spec 的存在本身；`sessionRestoreRules.ts`/`sessionRestartRules.ts` 两套规则 |

### C. 「UI 说的」≠「机器实际的」——信任缺口

| # | 痛点 | 证据 |
|---|---|---|
| C1 | **选了 yolo 仍弹审批**（Web 显示本地/代码默认，CLI 实际 plan/default）| B-258、B-262（四轮 review，两批）；B-243、B-251、B-254；spec `permission-mode-source-of-truth`、`permission-mode-cli-truth`；V-104/V-107 |
| C2 | 死选项 `dontAsk` 让整条消息被静默丢弃 | B-262；铁律 14 |
| C3 | 子代理卡在后台存根后即显示「已完成」，运行期无进度；通知被剥空成 XML | B-260 两批 done；V-106/V-108 |
| C4 | agent 跑着时发的消息画成普通气泡，暗示已被看到 | B-231 spec `queued-chat-input`；B-234/240/244 |
| C5 | Steer 后内部 `[ede_diagnostic]`/`[Request interrupted]` 当普通消息展示 | B-248 done |
| C6 | AskUserQuestion 回答后聊天里看不到自己答了什么 | B-249 done |
| C7 | 空 thinking 伪装成可展开块 | B-253 done |
| C8 | **几乎每个新功能都有「旧 daemon → 隐藏/提示升级」分支**（btw、attach tmux、todo provider、子代理、文件预览、恢复…）；同一账号不同会话能力不同 | B-040 更新提示；每个 spec 的兼容矩阵；V-074⑤、V-113 对照项 |
| C9 | RPC handler 抛错被包成正常 ack → store 当成功 → 白屏 | B-003 todo；铁律 17；B-027 无 ErrorBoundary todo |
| C10 | daemon 上下文与 ssh 上下文读到不同 Claude 凭据，一次 OAuth 失败该会话永久报错 | B-275/B-276 done；B-277（web 内 `claude auth login`）todo；铁律 16 |

### D. 结构化对话可读性与效率

| # | 痛点 | 证据 |
|---|---|---|
| D1 | 长消息/思考/工具组/代码块 disclosure 语言不统一；大面积青色 glow、整圈 focus 框 | B-209 doing（Owner 视觉反馈）|
| D2 | 活动流按 turn 聚合、loading 位置反复调整 | B-250/B-252/B-247 done；同一 loader 修 6 次 |
| D3 | 无会话内搜索、无 transcript 导出、用户图片不进 transcript、工具返回图片不渲染 | B-038 todo 自 08-13 |
| D4 | `@文件` / `/命令` 补全已移植但零接线 | B-035 todo 自 08-13 |
| D5 | 长会话（>2k 条）卡：ChatList 无虚拟化、lineDiff 无上限 | B-044 todo |
| D6 | 手机端 model/mode/effort 三选择器换行晃动 → 收进一个入口 | B-220、B-233 done |
| D7 | 等 agent 时想写下一步 prompt 没地方放 → Notes | B-094 done（说明输入框不适合当草稿位）|
| D8 | 等 agent 时想问旁路小问题只能开新会话/打断 → `/btw` | B-283 done |

### E. 注意力路由与多会话管理

| # | 痛点 | 证据 |
|---|---|---|
| E1 | **看板/侧栏卡片上不能直接批权限**（「多会话并行的最高频点击链」）| B-032 todo 自 08-13 |
| E2 | 「更好的通知系统（分级/聚合）」被判「需求不具体」dropped；移动端详情页无铃铛入口 dropped | B-008、B-046 dropped |
| E3 | webhook 出站零重试（IM 抖动 = 通知永久丢）| B-026 todo |
| E4 | 通知 presence 门只覆盖 web push（有人看该会话就不推）；webhook/IM 明确 presence 无关；无按设备/活动路由 | server `pushDispatch.ts` 注释；roadmap Next「presence 路由」|
| E5 | 侧栏「怎么找到我要的会话」没有稳定答案：排序策略换 4 次后禁用；三段视图 + 三种镜头 + 标签分组 + 置顶并存 | B-070/B-067/B-076；B-208；B-091 |
| E6 | 看板直接落地 `/board` 静默不初始化 | B-068 todo |
| E7 | ⌘K 增强、⌘1-9 在折叠侧栏/移动端失效 | B-039 dropped「无诉求」|
| E8 | 看板过滤/批量/清空 ended、断点夹缝 | B-043 dropped |

### F. 平台健壮性与发布节奏对 UX 的外溢

| # | 痛点 | 证据 |
|---|---|---|
| F1 | **渲染异常 = 白屏**（无 ErrorBoundary），无离线/重连横幅 | B-027 todo |
| F2 | 每次发版 PWA 重下 5.7MB（shiki 全语言 precache）；首屏 514KB gzip | B-028 todo |
| F3 | iOS PWA 发版后长期停 loading、需杀 app | B-223 done；V-094 未清 |
| F4 | **待真机验证 90 项，最老 2026-08-13**，纪律要求「下一批前清账」已失效；移动端/IME/语音项基本未验 | `docs/verify-queue.md`；CLAUDE.md 快照「远超纪律」|
| F5 | daemon 无保活（uncaught → 退出即死）| B-021 todo |
| F6 | 12 项设置无消费者 | B-041 todo |

### G. 元助手 / 语音（roadmap 主线，实际闲置）

| # | 痛点 | 证据 |
|---|---|---|
| G1 | `/assistant` 单机绑定、不做多机编排（spec 非目标）；版本门控 dev 逃生门缺（B-054 并入小清理）| spec `voice-assistant` 非目标；`AssistantScreen.tsx` 最后功能提交 08-14 |
| G2 | 派工闭环、主动汇报、iOS/Android 语音链路三周未验 | V-022…V-026、V-032…V-034 |
| G3 | 助手默认跳过权限审批（B-061 可关）；硬禁 Bash/Edit/Write（B-063）——调度器能做的事很窄 | B-061/B-063 done |
| G4 | 提议级工具 `open_url`、`notify` 未选入 | B-141/B-142 dropped |

### H. 工作流上下文

| # | 痛点 | 证据 |
|---|---|---|
| H1 | worktree 会话 UI 缺（`sessionType` 字段零 UI）；新建会话无最近路径/目录补全 | B-042 todo；「与 Owner 的 worktree 工作流直接相关」|
| H2 | 同项目下结构化会话+终端靠标题记忆归属；Changes/Files/Browse 不能直达/返回关闭 | B-208 doing（lens 已上，`?panel=changes` 已有）|
| H3 | FilesPanel 只能看全文不能看 diff | B-036 并入 B-208 |
| H4 | Usage 只统计 Claude assistant 路径且同会话覆盖；Codex 等 token 未入账 | B-211 doing |
| H5 | 外部 todo 面板失败态（未配置/命令不存在/超时/旧 daemon）| V-073/V-074 未清 |

---

## 4. (b) 已规划 / 进行中（竞品分析勿重提）

**doing（活跃区 8 项）**
- B-289 首帧字体宽度：`awaitTerminalFont` + `remeasureFont` seam（spec `terminal-render-integrity`）
- B-288 恢复快照段边界 SGR reset
- B-287 多设备几何：`window 'focus'→resize`、daemon `window-size latest`、冷恢复带真实尺寸；#160 已加「重排」按钮
- B-268 离线-非归档会话在归档视图直接可恢复 + 恢复 loading（#125 已合）
- B-265 归档对话原地恢复（同 id/URL/历史；归档里发送=先恢复再排队）+ 终端关闭进归档同 id 恢复（#120 已合）
- B-216 tmux 终端可编辑 tag，跨设备、参与 `#tag` 搜索与分组（#58 已合）
- B-209 结构化对话 disclosure 统一 + 去青色 glow/整圈 focus 框 → 底部 focus 轨；保留 a11y
- B-208 工作区成一等视图：侧栏按 `machine+cwd` 分组（已上，默认镜头）、Changes/Files/Browse 写入 URL、浏览器返回可关
- B-211 统一 Usage：幂等累计、Codex/Gemini/OpenCode/OpenClaw 归一化、趋势/形态/agent/token 类型
- B-192 多地域 relay plane（已部署 relay + Landing 地图；README 不得宣称全球自动路由直到实测）
- B-031 CI gitleaks（非 UX）

**todo（UX 相关）**
- B-279 daemon 升级后空闲间隙自动把旧 wrapper 换到新 CLI（零点击）——Owner 明确不急，先 spec
- B-277 从 web 发起 `claude auth login`（daemon 进程内 node-pty，URL/输出流到 web）
- B-032 看板/侧栏卡片直接 Approve/Deny/Approve-for-session
- B-035 `@文件` 引用 + `/斜杠命令` 补全接线
- B-037 终端 Ctrl+F 搜 scrollback + 字号可调
- B-038 会话内搜索 + transcript 导出 + 用户图片进 transcript + 工具返回图片渲染
- B-041 12 项死设置实现或删除
- B-042 worktree 会话 UI + 新建会话最近路径/目录补全
- B-044 ChatList 虚拟化 + lineDiff 上限
- B-027 ErrorBoundary + 离线/重连横幅 + store 消息 LRU
- B-028 bundle 瘦身（shiki 动态 import）
- B-109 八分块字形渲染破碎（renderer customGlyphs/字体栈）
- B-090 命令面板「归档当前会话」走 kill-first 对齐
- B-068 `/board` 直接落地初始化
- B-069b 冷终端活跃上浮延迟（判定暂不做）
- B-021 daemon LaunchAgent KeepAlive；B-026 webhook 重试；B-024 Playwright 冒烟；B-025 数据保留；B-003 RPC 假 ack 收口
- B-278 `getClaudeCliPath` exit 杀 wrapper

**dropped（有明确理由，重提需新论据）**
- B-263 `dontAsk`/`auto` 权限模式（单人只用 yolo/default/plan）
- B-008 分级/聚合通知（「需求不具体；通知中心+webhook 已够」）
- B-039 ⌘K 增强 + ⌘1-9 上提（无诉求）
- B-043 看板过滤/批量/断点统一（无诉求）
- B-046 移动端详情页铃铛入口（Owner 两周未再提）
- B-036 FilesPanel diff（并入 B-208）
- B-141 `notify` 工具（与 attention 重叠）、B-142 `open_url` 工具
- B-122 通道 v2 行为变化文档、B-005 ghostty-web、B-029 上游同步
- B-002 看板标注 IM 来源

**spec 里明确的非目标（视为「已考虑、暂不做」）**
- 语音：不做实时对话/wake word/barge-in/多机编排（`voice-assistant`）
- 镜像：只读、不做双栏（`terminal-mirror`）
- 队列：不做跨设备队列同步（`queued-message-controls`）
- 子代理：不做 Subagents track、`forwardSubagentText` 默认关（`subagent-lifecycle`）
- 侧问：不做流式推送、不持久化历史、不支持 codex/gemini（`btw-side-question`）
- Todo：不做双向同步/缓存/编辑/web 端配置（`todo-provider`）
- 工作区：不新增 Workspace 表/RPC；不做 turn outline、review queue、pane keep-alive（`workspace-context`）
- 重生：不做 live-healthy-busy 会话无损热升级、不做协作式 drain（`session-respawn`）
- 文件浏览：只读、不做搜索/写操作（`file-browser`）
- 笔记：不用 Monaco/CodeMirror、不做 markdown 渲染/分享/版本（`prompt-notes`）
- 归档恢复：不做统一 `reviveSession`、不把离线会话留在列表（`session-recoverability`）

---

## 5. (c) roadmap「Next」承诺 vs 代码现状

| roadmap Next | 代码现状 | 缺口 |
|---|---|---|
| meta-agent 成为跨 agent/provider/机器/checkout 的可靠调度器 | `/assistant`（B-051/B-069 Shipped 08-14）绑定单台在线机器；spec 非目标「不做多 assistant/多机器编排」；此后零功能提交、零 backlog | **整体缺失**；Owner 不用 |
| 保留子任务进度、回流决策/阻塞/结果而非让用户盯活动 | 会话内：B-260-P2 子代理生命周期、`report_progress`+LLM 进展写 `metadata.board`（B-132）；B-069 助手「主动汇报」未验 | 无跨会话「决策/阻塞收件箱」；看板只有一行摘要 |
| 只在改善真实工作流处加 adapter；Pi 候选 | Codex/Gemini/OpenCode/OpenClaw 存在；`pi` 0 匹配 | 符合口径（未实现即未承诺）|
| 深化 task-provider 与 development-provider 集成 | todo-provider（B-007，spec 仍 Draft，V-073/074 未验）；Channels webhook | **无任何 dev-provider**（GitHub/PR/CI）集成 |
| workspace/project/checkout/task 记忆一等化 | 侧栏 workspace 镜头（由 `machineId+cwd` 派生，spec 非目标「不新增 Workspace 表」）；Notes 绑会话；`?panel=changes` | 无持久 workspace 对象；无 checkout/worktree 概念（B-042 todo，字段零 UI）|
| 中断恢复包含目标、决策、相关文件、agent 归属、下一步 | 恢复全是**进程级**：auto-restore（B-150）、archive-restore（B-265）、respawn（B-264） | 零「工作记忆」；最近的只有 board LLM 摘要行 |
| 显式 session forking + 多 agent review 流（归属/进度/成本/取消）| `sync/ops.ts` 有 `ClaudeForkSessionOptions`/`forkedFromMessageId` 类型；screens/app **零调用点**；review 流无；成本 B-211 doing | fork 无 UI；review 流缺失 |
| 通知按 presence/活动路由 | server `pushDispatch.ts`：web push 「有人在看该会话就不推」；chime 可见即静默；webhook 注释「PRESENCE-INDEPENDENT」 | 部分；无按设备/活动强度路由，IM 通道全广播 |
| 定时工作与可重复流水线（明确审批边界）| 0（grep schedule/cron 只有内部 scheduler 名）；Landing 曾画「scheduler control plane」(027ee11f) 后需 `keep scheduler agent claims honest` (d2e94b02) 回收 | **整体缺失**，且营销曾超前 |
| 键盘/触屏/折叠屏/a11y/低带宽持续改进 | 折叠屏 B-112；a11y 在 B-209；低带宽：B-028 todo（首屏 514KB gzip、5.7MB precache）| 低带宽零进展 |
| 保留 Tauri 桌面壳作可选 | `a359a4db retain and refresh experimental Tauri shell`；无 backlog 项 | 未承诺，符合口径 |
| 长期：虚拟办公室 | 无 | — |

**Available now 里需谨慎的口径**：「Claude-powered text meta-agent with session awareness and dispatch」技术上在，但 Owner 自己判定弱、未验收；「optional hook pair mirrors hand-started Claude」在但需手动 `install-terminal-hooks` 且只读。

---

## 6. (d) 我的判断：very-happy 今天 5 个最大的 UX 弱点（第一性原理）

### 1. 产品的基本单元是「进程」而不是「工作」
用户看到的一切都是进程状态：在线/离线/归档/已结束/墓碑/processFailed/可恢复/镜像 ended。8 个 spec 连环修「这个会话还在不在、能不能接回」，同事和 Owner 仍在报困惑（B-268、B-265 黑洞、B-149 22 个终端无痕）。
第一性原理：用户关心的是「我在做什么、它产出了什么、卡在哪」；roadmap 自己写了「durable work memory」，但代码里除了 board 一行 LLM 摘要什么都不存。于是中断恢复 = 复活进程，不是复活上下文；换设备 = 重新在侧栏里找。
Notes（B-094）和 `/btw`（B-283）都是这个缺口的旁证：用户要在等 agent 的空档里做的事，产品没有给「当前工作」这个容器。

### 2. UI 与机器真相之间的信任缺口是结构性的，不是 bug 集合
四个独立版本化的运行时（web / server / daemon / 每会话 wrapper），加上 UI 显示乐观/本地状态：权限选择器骗了用户 5 次（B-243→B-262），子代理卡「已完成」其实在跑，排队消息画成已读，RPC 错误被当成功直到白屏。B-262 的「七态 mono 副文案」是诚实的方向，但它是一个控件的补丁。
第一性原理：用户触碰的每个控件都必须反映**生效**状态或明说「未确认」；「这个会话跑什么版本、能做什么」应该是一个显式的会话属性面，而不是散在 N 个 capability 旗里、每个功能各自写「旧 daemon 请升级」。当同一账号里两个会话的能力不同，用户无法建立可预期的心智模型。

### 3. 终端是主表面，却是「远程的远程」的有损镜像
web → relay → daemon → tmux control-mode → pane：几何、字体度量、CJK 宽度、字形 atlas、IME 合成各自修了 3–6 次，占 Web 提交 ~30%。结构性根因两条：一个 tmux client 决定几何（多设备必打架），xterm 的 Unicode 宽度/字体度量必须与 tmux 的裁决一致（异步字体、CJK、块字形全踩）。
第一性原理：在手机上，裸 TTY 是错误的原语——镜像（B-105）方向对，但只读、要手装 hook、toggle 还会丢（B-271）；结构化 SDK 会话是更好的原语，但用户（尤其同事）仍活在 tmux 里（attach-tmux 一天四轮迭代就是证明）。产品在两个原语之间没有明确的「默认路径」，于是两边都要做到完美，两边都做不完。

### 4. 注意力路由是「广播 + 轮询」，不是一个能被清空的队列
信号来源 7 个（铃铛、看板「等我看」、侧栏 accent、webhook、web push、提示音、PWA badge），presence 门只在 web push；「列表内直接批权限」（B-032，Owner 自称「多会话并行最高频点击链」）从 08-13 todo 至今；冷终端活跃上浮延迟被判「不值得」（B-069b）；分级通知被判「不具体」dropped。
第一性原理：N 个并行 agent 时核心循环是「下一个需要我的 → 决定 → 回去」。今天没有一个**有序、可内联决策**（approve / answer / mark done）的收件箱，用户必须点进每个会话。侧栏排序换 4 次后禁用，说明「按什么排」本身没有答案——因为排序回答不了「下一个该处理谁」。

### 5. 表面数量超过单人验证带宽，打磨被稀释
待真机验证 90 项、最老 08-13，其中大多是移动端/IME/PWA/语音——**移动端体验实际上从未闭环验收**；语音助手 08-14 上线后无人验、无人用；Landing 三天重做 ~6 次的同时 B-032/B-035/B-037/B-038 三周未动。加上无 ErrorBoundary（白屏）、每次发版 PWA 重下 5.7MB、iOS PWA 发版卡 loading。
第一性原理：Owner 的日常循环只用 3 个表面（侧栏、会话、终端），产品却有 ~14 个表面（assistant、board、notes、todos、clipboard、help、changelog、docs、landing proofs…）。每多一个表面就多一份状态、兼容分支和验证项；对「穿在浏览器里的终端」这个定位，减法比加法更能提升体验——竞品分析里应该问「对手用更少的表面覆盖了同样的循环吗」，而不是「对手多了什么面板」。

---

## 7. 对竞品分析的使用建议

- **不要再提**：终端几何/字体/IME 修法（doing）、归档恢复（doing）、工作区分组（doing）、统一 Usage（doing）、终端 tag（doing）、disclosure 降噪（doing）、`dontAsk` 模式、分级通知、看板过滤、⌘K 增强、fork 类型层（已有）、Tauri。
- **可以提但要带新论据**：列表内批权限（B-032 todo 三周，可用竞品证明其优先级）、决策收件箱（roadmap 承诺但零代码）、工作记忆/中断恢复（同上）、fork/review UI（类型已在、无 UI）、dev-provider（GitHub/PR）集成（零）、定时/流水线（零）、低带宽（零）。
- **对比时的公平基线**：very-happy 已有的强项——durable 终端 + 重启自动恢复、Queue/Steer/Stop 三通道、子代理真状态、`/btw`、任意文件 50MB 附件、跨设备 Notes、archive-only 无删除、接入已有 tmux、Claude 登录预检/修复、蓝绿发布 + 堆叠 changelog、诚实的 capability 降级（旧 daemon 不白屏）、纯函数模块化 + 对抗 review 流程。
