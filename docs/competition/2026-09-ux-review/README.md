# very-happy UX 优化 TODO（终审稿，供 Owner 逐条裁决）

> **归档状态**：Archived · 2026-09-08 存档，未开工。Owner 的处置是「留着以后做」，**§5 的 43 条裁决一条都还没裁**，
> 因此本文档还不是任何 backlog 项的依据——要动手先裁 §5，再按裁决结果开 backlog 项与 spec。
> 存档时 `docs/backlog.md` 未新增任何条目，这是有意的。
> 基线：仓库 `main@796565d5`、线上 web `main@892be05e` / CLI v0.2.100（2026-09-03 研究时点）。
> 半年后若仍未开工，先重跑一次代码核实再用——见 §8 局限第 3 条。

> **这是什么**：对比 Claude Code desktop/Remote Control、Codex desktop/remote、paseo.sh、stablyai/orca 四家竞品（外加 grok bot / Cowork Dispatch / ChatGPT tasks / OpenClaw / pi 五个 adjacent 参考）之后，沉淀出的 very-happy 可优化事项清单。只看 UI/UX 与工作流抽象，**不受现有架构与代码约定约束、不计工作量**，只从第一性原理与用户体验出发。
>
> **怎么产生的**：16 个研究 agent 分别做了 very-happy 自审（产品表面地图 / 已知痛点与已规划 / 工作流抽象层现状）与四家竞品 × 3 视角（功能清单 / UX 流程与视觉 / 编排与工作流抽象）+ 1 份 adjacent；三路独立合成（日常循环 / 第一性原理理想产品 / 幕僚长方向）合并成 40 条；每条再被 6 个对抗 reviewer（三视角 × 2 票：①已经有了/已规划 ②对这个 Owner 有没有价值 ③第一性原理与设计语言一致性）尝试推翻，reviewer 被明确要求「拿不准就判推翻」。因此**「被推翻」≠「坏主意」**——多数推翻理由是「形状不对」并附了改写建议，这份文档已经把改写吃进去了，并逐条标注了哪些让步、哪些不接受。合成期间还核实推翻了草稿自己的多处事实错误（下文每条的「问题」里都写了）。
>
> **一条例外必须先说清**：§4 里的 **G-01…G-05 五条不在这 40 条对抗评审范围内**——它们是终审阶段按 `critic.md` 的完备性缺口补写的新条目，6 票对抗评审只覆盖 T-01…T-40，**G-* 从未被 reviewer 评审过**。它们的「反方」是我自己预设、自己回应的（版面上已改名为「我预设的反方与我的回应（无 reviewer 票）」，元信息行也标了 `来源`），读的时候不要把它们当成三视角六位 reviewer 的对抗记录；其中 G-01/G-03/G-04/G-05 四条在 NOW，且 §5 的第 15/21/24 条被列进「先裁 9 条」。
>
> **怎么用**：逐条读 §4。每条末尾若有 `> 需要你裁`，就必须裁——那是这条能不能落地的分岔点。所有裁决汇总在 §5，可以直接按编号回答「1. 选 A」。§6 是判定不做的（含证据），§7 是方向不是待办，§8 是取证清单与方法局限。
>
> 日期 2026-09-03；代码事实基于本机 `main@796565d5` 与线上 `veryhappy.dev` 实测。

---

## §1 结论先行

**诊断**：瓶颈不是 agent 的产能，是 Owner 一个人的判断带宽。产品的基本单元是**进程**，三个日常表面（侧栏、会话、终端）都只回答「发生了什么」，没有一个回答「下一个该我拍板的是谁、拍完就走」。于是 Owner 本人就是调度器：轮询列表、逐个点开、滚到底做一个一比特的决定；评审与交付（累计 diff、PR、CI、合并）100% 发生在产品之外的终端里。

**四家在完全不同的架构下收敛出的同一个答案**：一套状态词汇一处判定处处渲染；一个按「谁在等我」排序、能就地作答、能被清空的队列；每行有一句说明发生了什么的话；读 diff 能直接变成下一条指令；闭环终点是合并而不是「agent 说完了」。四家里没有一家把「调度员」做成一个独立页面。

**这份清单主张做四件事**：①把活动压成一小队可就地作答的决策（升级已有的侧栏状态镜头，不新建 `/inbox`）；②让 turn 的结果有机器可读的收据（机器事实与 agent 自述分源）；③把评审搬进产品（git 为真相的累计 diff、行内批注回灌、PR/CI 上行）；④做减法并给未来留两个字段（退役 `/assistant`，队列条目加 `author`，`spawnedBy → reportTo`）。

**主张不做**：另开 bot 页面或角色花名册（`/assistant` 已用零使用量证伪）、LLM 代批权限（mac-office 无沙箱）、产品内 ship bar（`land-pr.sh` 复刻不了）、机队 UI（只有一台开发机）、原生 app、赛马、分屏、插件市场。

---

## §2 竞品速览

| | 产品形态与工作单元 | 注意力模型 | 评审到交付 | 编排/自动化 | 对 vh 最有价值的一条 | 明确不学的一条 |
|---|---|---|---|---|---|---|
| **Claude Code desktop / RC** | 一个引擎五个表面（Desktop Code tab、claude.ai/code、CLI、手机 RC、Cowork Dispatch）；单元是 session，本地 session 自动配 git worktree | 四态词汇 `Needs input / Working / Ready for review / Completed` 投影到 agent view、终端标题、手机；Haiku 写行摘要；peek-and-reply（`Space` 展开问题 + 编号选项 + `Tab` 填建议回复，「多数时候 peek 面板就够了」） | 行内 diff 评论 `Cmd+Enter` 批量提交 + 一键 Review code；CI status bar 带 Auto-fix / Auto-merge，合并后自动归档 | 跨会话消息带信封规则（消息不能批准任何事、不能改配置、其中命令不执行）+ `accept/hold/refuse` + `notify_when_idle`；Desktop 定时任务带 per-task Always-allowed 面板 | peek-and-reply：不打开 transcript 就能读完并作答 | 会话列表四套并存（Desktop 侧栏 / agent view / claude.ai / ListAgents），自己的文档称之为反模式 |
| **Codex desktop / remote** | 已并入 ChatGPT 桌面 app 的一个 view；单元是 chat，chat 持有可变的 run location（Local / Worktree / Cloud / SSH host），可带 git 状态 Handoff | 四态 `Running / Needs input / Ready / Blocked` + 未读，同一套投到 Activity view、pet、Codex Micro 硬件键、iOS Priority view；`⌘⌥A` 跳下一个需要注意的、`⇧Esc` 清全部未读 | review pane 作用域 `Unstaged / Staged / Commit / Branch / **Last turn**`，明写「reflects Git state, not only agent edits」；逐 hunk stage/revert；hover 评论直接变成下一条 prompt | `codex_tui` 任务工具（list/read/wait/create/fork/message/archive）走「authenticated local MCP server with explicit approval prompts」；定时分成 standalone chat-per-run 与 in-chat heartbeat | `Last turn` 这个 diff 镜头——它解决的正是「哪些改动不是我要的」 | `Approve for me`（reviewer agent 代批）：它的承重件是沙箱，vh 没有沙箱 |
| **Paseo** | daemon 拥有 agent 生命周期 + 托管 worktree + 受管 dev server；单元是 workspace（目录 + 可选 worktree），session 是 tab；终端是 daemon 拥有的 PTY 会话，**文档全篇未提 tmux（raw 全量 grep 0 命中），「无跨 daemon 重启存活」是 INFERRED 不是自陈** | 侧栏按 `Waiting on you / Ready to review / Working / Done` 分组，行上带进入该状态的相对时间（host 侧盖戳 `statusEnteredAt`）、PR 号 + checks、diff 统计；`workspace.clear_attention` 在 host 侧执行、对未加载会话也生效 | 在 workspace 内闭环：Changes/Files/Commits、点行号批注回灌 agent、PR checks failure-first 分组、**一键把失败 check 日志附到 chat**、合并后自动归档 | Schedule（每次新 agent）/ Heartbeat（打回同一会话）干净二分；外部触发拆成独立 Hub（GitHub/Slack/Discord → 仓库内 YAML workflow），`from_users` 白名单必填非空、Activity 记 4 类未路由原因 | priority unmasking：高优先原因清掉后回落低优先，`since` 不重置 | presence 当投递门槛（180s 窗口曾整类吞掉权限提示，issue #1764）——vh 今天更狠，是账号级 |
| **Orca** | worktree-native 桌面 IDE；单元就是 git worktree（分支 + 目录 + agent PTY + editor/diff/browser tab） | 一套 glyph 贯穿 sidebar / tab / kanban / `Cmd-J` palette / 手机；bell 带 mark-unread + Dock badge；`Cmd-J` 空态 = needs-you → done → idle 六行 + 数字键 + 打开期间成员冻结 + 省略当前 idle tab「so the list stays actionable」 | 最强的一段旅程：组合 diff + 文件树 + `j/k` 换文件 `n/p` 换 hunk；**Annotate AI Diff** 把多条行锚定批注攒成一条 prompt 发回 agent（理由写成机制：逐条发会让 agent「swing back and forth」）；`Fix broken checks` | Run/Task/Dispatch 账本 + at-least-once 收件箱 + `worker_done` 绑 dispatch id + decision gates——但**全部 CLI-only、人看不见**，可靠性押在 42KB 协议 prompt 上 | 批注攒一批再发；每个死掉的 agent tab 上一枚 Restart chip（同 agent、同 cwd、同账号）+ 诚实的幸存矩阵 | yolo-by-default（所有 CLI 预置 `--dangerously-skip-permissions`）：它自己把权限旅程设计没了，手机上「approvals are text, not decisions」 |
| **adjacent**（grok bot / Cowork Dispatch / ChatGPT tasks / OpenClaw / pi） | grok bot = 一台共享云电脑上的具名 Bot + 2–6 Bot 群聊；Dispatch = 单一常驻线程 + router；OpenClaw = agents/sessions/tasks/automations/approvals 全是分开的一等类型化对象；pi = 极简 harness + FleetView 扩展 | OpenClaw：Home 会话汇聚 + heartbeat「没事回 NO_REPLY」+ sidebar 之上的 attention chip + Tasks 账本；grok chief-of-staff 的唯一产出是 source-linked digest，每条以「我是否欠一个决定」收尾 | 不在这条赛道上；OpenClaw 的完成 handoff 带 Result/Status/token 并附一条要求 requester 先验证再判完成的 review instruction | OpenClaw promotion：例行任务从已经做过的活提升而来，创建后立刻以可见测试跑一次，失败就删掉这条 | 横向恒量：**真正减少盯梢的是决策收件箱**，不是更好的 dispatcher；「promote, don't author」，cron 表达式永远不是主 UI | grok 式 bot 群聊 + Cowork 的单线程 dispatcher（官方自陈开不出第二条线程）——没有队列的 dispatcher 会退化成聊天，这正是 `/assistant` 的形态 |

---

## §3 我们的位置

### 真实强项（不吹，每条带证据）

1. **durable tmux web 终端 + 重启自动恢复，四家没有一家有。** Paseo 与 Orca 的终端是 daemon PTY——**注意证据等级**：Paseo **文档全篇未提 tmux**（对 `vendors/paseo/raw/**` 全量 grep，"tmux" 出现 **0 次**），终端是 daemon 拥有的 PTY 会话，文档里没有任何跨 daemon 重启存活的说法；「no tmux-style durability」是**研究者的 INFERRED 判定**（`vendors/paseo/inventory.md:112/182` 均标 `[I]`），**不是竞品自陈**，属缺席证据（见 §8 局限）；Claude 全家桶「no surface exposes a remote terminal to the phone or browser」；Codex 有 integrated terminal 但 host 一睡就死。vh 的终端能扛住 host app 退出、能 attach 用户已有的 tmux 会话（B-273/280/281/282）。
2. **结构化权限是一等对象，且有唯一服务端执法点。** `agentState.requests` 是权威源，`sync/yoloEnforcement.ts` 是唯一执法入口，`normalizeClaudeOutboundMode` 是出站唯一清洗点。对照 Orca：所有 CLI 预置 bypass flag，手机上审批只能打 `y/yes`。
3. **web/PWA 是主表面 + 自托管 relay + 自有账号，不绑任何一家订阅的登录态。** Codex Remote 必须 host 醒着且没有浏览器远端、配对是每手机×每 host 一次 QR；Claude 的远程故事全部绑 claude.ai 订阅与 api.anthropic.com。vh 是唯一把「远程 web 客户端」当主表面的。
4. **多 engine 已经付过接入成本。** Claude / Codex / Gemini(ACP) / OpenClaw 都能起，`NewSessionModal` 按 `cliAvailability` 置灰并给安装命令。四家里只有 Paseo 同样多 provider，Claude/Codex/Orca 各自单一或以自家为主。
5. **不丢东西的纪律。** archive-only 无删除（B-083）、会话单写者锁（B-272，`~/.happy/session-locks/<id>.json`）、server/web 同一完整不可变镜像蓝绿发布、发布带 changelog 硬门禁（B-285）。对照 Paseo：「关掉根 agent tab = 归档」是它自承的历史包袱。
6. **工程方法论本身是产品优势。** 纯函数模块（`termWriteHold` / `boardTaskOps` / `boardItems.lifecycleOf`）+ 对抗 review + spec 先行，让并行 AI 开发下的返工率可控。这不是用户可见的，但它是这份清单里多数「形状对不对」问题能被便宜地改对的原因。

### Paseo 在 `/alternatives/happy-coder` 对上游 Happy Coder 的定位性批评，及其对 vh 是否成立

| Paseo 的说法 | 对 very-happy | 判断依据 |
|---|---|---|
| 「wraps the agent CLI and syncs sessions」vs「daemon owns agent lifecycle」 | **成立** | vh 的 daemon 只管 spawn/handover，session wrapper 是独立进程；没有 workspace/worktree/service 这层对象 |
| app 内无 GitHub 工作流（commit/push/PR/checks/merge） | **成立** | web 侧 GitHub 只有账号绑定（`sync/apiGithub.ts`），`packages/happy-cli/src` 无任何 gh/PR 代码。见 T-22（做事实上行）与 §6 T-23（不做 ship bar） |
| 不管理 worktree 生命周期，只能选一个已存在的 worktree 路径 | **成立** | `packages/happy-web-v2/src/utils/worktree.ts` 在 web 里零消费者，是上游遗留死代码；`useSessionGitStatus` 同样零消费者。见 T-21 |
| 无 per-worktree dev server URL | **成立且有代价** | 直接卡住 AGENTS.md 验收节要求的「真实视口验证」；见 G-02 |
| CLI 无 schedule / loop | **成立** | 全仓无 cron/队列依赖，只有 in-process `setInterval`；见 T-28 |
| 无应用级插件 | **成立，但我们主动拒绝** | 用户只有一个人且能直接改仓库；Paseo 自己的信任模型是「插件是不沙箱的 daemon 代码」 |
| desktop 只有 macOS | **不适用** | vh 是 web-only，反而全平台；这是 vh 相对四家的结构性优势之一（前提是 G-01 成立） |
| providers 只有 Claude/Codex | **部分成立** | vh 有 Codex/ACP，但非 Claude 会话在能力上是二等公民（见 G-03） |

### 结构性弱项（第一性原理）

1. **产品的基本单元是「进程」而不是「工作」。** 用户看到的一切都是进程状态：在线/离线/归档/已结束/墓碑/processFailed/镜像 ended。八个 spec 连环修「这个会话还在不在」，同事与 Owner 仍在报困惑（B-268、B-265、B-149）。roadmap 写了 durable work memory，代码里除了看板一行 LLM 摘要什么都不存。Notes（B-094）与 `/btw`（B-283）都是这个缺口的旁证。
2. **UI 与机器真相之间的信任缺口是结构性的，不是 bug 集合。** 四个独立版本化的运行时（web / server / daemon / 每会话 wrapper）+ 乐观本地状态：权限选择器骗了用户 5 次（B-243→B-262，四轮对抗 review 才收敛）；铁律 17 记录的「handler 抛错 → 正常 ack → store 当成功 → 渲染层拿 undefined」；全仓 `ErrorBoundary` 零命中，任一渲染异常整页白屏。
3. **注意力路由是「广播 + 轮询」，不是一个能被清空的队列。** 信号源多、`B-032`（列表内直接批权限，Owner 自称「多会话并行的最高频点击链」）自 2026-08-13 todo 至今；侧栏排序策略换了四次后被禁用——排序回答不了「下一个该处理谁」。**新证据**：`dispatchSessionEventPush` 的抑制门是账号级 `isUserActive`，桌面开着一个标签页时手机永远收不到权限推送（T-06a）。
4. **评审到交付 100% 发生在产品之外。** `DiffView` 只服务 Edit/Write 工具卡，`FilesPanel` 的 Changed 点开是整文件；git 取数走 `sessionBash`，会话一归档 git 面全黑——而那恰好是「跑完待收、该评审」的时刻。Owner 的真实动作是开一个 web 终端跑 `git diff` 用 xterm 读。
5. **表面数量超过单人验证带宽。** ~14 个表面，`docs/verify-queue.md` 待验 90 项、最老 2026-08-13，其中大多是移动端/IME/PWA——**移动端体验实际上从未被闭环验收**。`/assistant` 语音台上线后零使用（硬证据见 §7）。
6. **「发版时刻」今天无人负责。** `vite.config.ts:110-112` 把 release SHA 拼进**每一个** chunk 文件名，所以每次发版全部资产 URL 都变，runtime `CacheFirst` 必然 100% miss；线上 `AppRoot` 实测 590,599 字节（压缩后传输量）挡在认证界面之前。而「显式拒绝原生 App」的唯一理由正是「零安装、永远最新的 PWA」（G-01）。

---

## §4 TODO 主清单

> 元信息读法：`horizon` 只表示依赖与价值顺序，不表示大小；`判定` 是 6 个对抗 reviewer 之后的终审结论——**除 G-01…G-05 外**，那五条标着 `来源 critic 补齐 · 未经 6 票对抗评审`，它们的「判定 保留」只是我自己的结论，不含任何 reviewer 票；`依赖` 是形状依赖不是排期依赖。
> **编者注**：G-05（NOW）是 T-27a（NEXT）的最小前置，两者不是重复——G-05 只补被保留的 T-03 自己制造的洞，T-27a 是完整的授权可见面；**机制事实一律以 T-27a 为准**（授权集权威在 wrapper/SDK 侧、寿命=wrapper 进程）。G-05 自己的那一刀已并入 T-03 的裁决（§5 第 2 条）。若 T-03 的「本会话始终允许」按钮被删，G-05 随之消失。

## NOW

### T-02 · 把已有的侧栏「状态」镜头升级成能办事的默认队列，同批删掉重复的那一个
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` T-01 / T-03 / T-04 ｜ `backlog` 实现并超出 B-032；只复活 B-039 的最小面（⌘K 空态）

**问题**：「今天没有任何有序、可清空的等我列表」**不成立，这一句必须改掉**——侧栏 `View='status'`（`Sidebar.tsx:62`）已经按看板全序给出 waiting（紧急带按等待最久优先）/ running / 今日完成（`sidebarStatusView.ts` + `completedTodaySessions`），`/board` 的 Lifecycle 三列还带 `waiting 4m` 与 ✓ Mark done——而 ✓ 的设计原文就是「DONE is not a status but an explicit user action that removes the item and leaves a record」。真正缺的是四件事：这两个容器都不是默认镜头；行上不能就地作答（B-032）；**reason 已经有**（`waitReason` 七值枚举 permission/review/blocked/needsInput/idle/ended/machineOffline，`boardItems.ts:47-56`；`URGENT_WAIT_REASONS` :60 驱动紧急带），**since 只覆盖紧急带**（`attentionSince` :87/263/267/290 只在 `status==='attention'` 时赋值，`BoardCard.tsx:188` 已渲染 `waiting Xm`）——缺的是非紧急 waiting 的 since、以及三处判定的构造一致性（口径以 T-01 为准，别读成「reason/since 都没有」）；跨设备不记账（T-04）。另外 ⌘K 对状态完全无感（`CommandPalette.tsx` 里 attention/waiting/lifecycle/unread 零命中）。

**提案**：选定一个既有容器作为唯一的决策队列，**同批删掉另一个**，保证净表面数下降。它必须满足：①三段 = 需要决定 / 跑完待收 / 失败，段内按 since 最久优先，每条带 reason + 等待时长 + 来源（machine · cwd · 标题）；②行内展开 T-03a 的决策卡就地作答，办完原地消失、留「今天」区可撤销；③键盘分诊 `j/k` 移动、`Enter` 展开、**裸** `1..9` 直选卡内选项、`.` 跳下一条欠决策、`Shift+Esc` 全部已读——`⌘1-9` 继续只表示侧栏位置寻址，一组数字键不允许两个语义（这正是 B-076 禁用自动重排的原因，别在新表面上重演）；④空态即产品目标：「没有等你的事」+ 最近 3 条已办；⑤可设为登录后首页与手机根页（`AppRoot.tsx` 的 `homeView` 已存在）。
桌面：常驻，不离开当前页就能分诊。手机：队列即根页或由 T-08a 的芯片升起 sheet。
⌘K 空查询首屏改为「等你决策 → 跑完待收 → 在跑」前 6 行、打开期间成员冻结、省略你正在看且无待办的那个——**这一条与队列无依赖，可独立先发**。

**竞品依据**：Orca `Cmd-J` 空态六行 + 数字键 + 成员冻结 + 省略当前 idle tab；Codex Activity view + `⌘⌥A` + `⇧Esc`；Paseo `Waiting on you` 桶 + host 侧 `clear_attention`（对未加载会话也生效、可批量）。

**被挑战与让步**：三票 REFUTE 打在同一点——容器已经存在两份且同源，把它包装成新表面是第三次复制同一张列表，正是「排序/视图换四次然后禁用」的下一轮。全部吃进：撤掉 `/inbox` 与「常驻带 vs 一等表面」的二选一，改成「升级 + 删除」。另修正草稿一处虚构阻力：`specs/2026-08-workspace-context.md:24` 原文「不在本批实现 turn outline、review queue…」是批次范围声明，不是产品结论，不需要推翻。

> **需要你裁**：队列的宿主二选一，另一个同批删掉。
> **A（推荐）**：侧栏「状态」镜头——常驻、桌面上不离开当前页就能分诊、手机上天然是根页。代价：280px 宽列里展开决策卡在桌面偏挤，且要把 board 已有的 ✓ / 今日完成 / `waiting 4m` 搬过来；**另外必须同批把触屏默认 `sidebarView` 从 `'list'` 改成 `'status'`（`localSettings.ts:188`，设备级偏好）**——不改的话「手机上天然是根页」这句不成立，手机根页仍是手动排序列表，T-02 自己列的第一个缺口（「这两个容器都不是默认镜头」）在手机上原样保留，而手机正是 T-03/T-08/G-01 全部价值论证的落点。这一项已从原第 17 条降为本刀的从属选项。
> **B**：`/board` Lifecycle 页——卡片空间足够、✓ 与等待时长已经在、已能设为首页。代价：桌面每次分诊都要离开当前页，手机上是第二跳。
> 我推荐 A，`/board` 只留 Tasks 泳道（与 T-19/T-20 一起处置）。

### T-03 · 就地决策卡（拆成 T-03a 卡本体 + 推送正文 ／ T-03b「改口令」）
`horizon` NOW ｜ `判定` 拆分 ｜ `依赖` T-04 ｜ `backlog` B-032 的实现形态；受铁律 8/14/17 与 `specs/2026-08-permission-mode-source-of-truth.md` 约束

**问题**：就地决策今天一处都没有：`PermissionCard` 只在会话页 transcript 末尾，看板卡里 permission 只是徽章，铃铛条目只能跳转置读——这就是 B-032 的内核。但草稿「通知正文只有类别」要分两半说：铃铛 feed 车道**已经带工具名**（`notificationProducer.ts:96`「Claude wants to use ${toolName}」），真正空的是系统推送——`getSessionNotificationCopy` 的 title 固定是 'Permission request'、body 只是会话标题，而 `claude/utils/permissionHandler.ts:413-419/538-544` 送出的 push `data` 里**其实已经带了** `tool` 与 requestId。另有两处形状风险：「本会话始终允许」授出的常设许可今天不可见不可撤销（见 G-05）；「改口令 = deny + 同 turn steer」跨了两个控制通道，是 0.2.79–0.2.90 在权限回调内嵌套 control request 事故的同一形状（铁律 8/14）。

**提案**：
**T-03a（卡本体，先发）**：一个组件，**三个**落点——队列行展开（侧栏行 / 看板卡 / 铃铛条目是同一份行数据的三次渲染，一个宿主就覆盖三处）、会话页既有的 `PermissionCard`、推送深链落地页。卡型：权限（工具名 + 参数，Bash 显示完整命令、文件工具显示路径）/ AskUserQuestion（选项含 Other）/ ExitPlanMode（计划摘要 + 批准·驳回）/ 跑完待收（outcome 摘要 + ✓ 完成·继续追问·打开会话）。每张卡带 reason、`waiting 4m`、来源（machine · cwd · 发起它的子会话）；处理完自动前进到下一条，但每条仍需各自按下——**不做跨主体「全部批准」**（同会话内的 Approve all 已在 `PermissionCard` 里）。硬约束：普通 approve 不得带 `mode`（铁律 14）；每个动作的返回必须先查 RPC `error` 字段再信载荷、失败显式报错（铁律 17，与 B-003 同类）；主按钮用 ink/canvas 高反差，卡上 accent 只允许出现在「在跑」计时点。
**第一刀可独立先发且极便宜**：把推送 title/body 改成携带已有的 `data.tool` + 参数摘要，替换 `getSessionNotificationCopy` 的类别词。
**T-03b（改口令，需 spec + 回归测试）**：deny 先返回，wrapper 在权限回调之外、同一 turn 边界上再发 steer，**绝不在回调内嵌套第二条 control request**；按 `session.metadata.capabilities` 分版本渲染真实语义——有 steer 能力显示「插入本轮」，没有（Codex/Gemini/OpenClaw、旧 wrapper）显示「拒绝并留言（下一轮）」，一个标签不许两种行为。
桌面：卡在队列行内展开，Enter 批 / Esc 拒。手机：同一张卡，大按钮 + 拇指区，从推送深链直达。删掉草稿里的「相机/相册直接进 prompt」（那是附件能力，已有 📎）。

**竞品依据**：Codex 手机审批卡四按钮 `Approve / Always approve / Tell Codex what to do / Deny`；Claude peek-and-reply 明写「多数时候 peek 面板就够了，不必打开完整 transcript」；反面是 Orca 手机上「approvals are text, not decisions」。

**被挑战与让步**：唯一 REFUTE 与两票保留集中在三处，全部吃进：①「跨五个表面」是虚的——三处落点已够，每多一个就多一条「失败必须显式」的代码路径和一批真机验证项，而 Owner 的硬约束正是验证带宽（待验 90 项）；②「本会话始终允许」是全清单里唯一不可逆的授权，却被放进上下文最少的推送落地页（见下方裁决与 G-05）；③「改口令」跨控制通道且能力门控，必须单独立项。同时修掉草稿一处事实错误：通知正文并非全是类别词，铃铛 feed 已带工具名。

> **需要你裁**：「本会话始终允许」怎么处理？**这是一刀四选项**（原 §5 第 2 与第 14 条是同一个决定、选项集却不一致，已合并到这里；G-05 只写选 B 时的实现约束）。
> **A**：等 T-27a 的完整授权面上线后再放这个按钮，未上线前卡上不出现。代价：最省事的那一档要多等一批。
> **B（推荐）**：卡上自带「已允许 n 项 · 重启即清（展开 / 收回）」一行，作为 G-05 的最小前置。代价：在一张为速度优化的卡里塞一个管理面，且该行的值必须来自 CLI 只读 RPC（旧 wrapper 上禁用并写明原因），不能拿浏览器点击历史顶替。
> **C**：降级为「本 turn 内同类自动放行」这种会自然过期的形态。代价：连批时多按几次。
> **D**：把按钮从决策卡上删掉，只留单次批准 / 拒绝 / 模式切换。代价：最省事的那一档没有了。
> 我推荐 B，并规定该按钮只出现在能看到工具参数与所在会话的落点；推送落地页只给批准 / 拒绝 / 改口令。**不可接受的形态只有一个：保留按钮、不给出口。**

### T-01 · 把 reason/since 变成 wire 事实：补待收带的等待时长、收口三处独立推导
`horizon` NOW ｜ `判定` 保留（重写、大幅缩小）｜ `依赖` — ｜ `backlog` 扩展 B-085 与 BoardItem 契约；纠正 B-070/B-067/B-076 的因果记载

**问题**：草稿的前提是错的，必须先修掉：`boardItems.lifecycleOf` **已经是唯一分类器**——`screens/sessions/sidebarStatusView.ts` 头注释明写「the sidebar never classifies on its own: it consumes BoardItem.lifecycle」，`sidebarAttention.ts`（B-085）消费同一份 `URGENT_WAIT_REASONS`，`sync/notificationInbox.ts` 的 LOCAL 车道由同一个 lifecycleOf 的跃迁生成。真正的缺口只有三处：① `attentionSince` 只在 `status==='attention'` 时赋值（`boardItems.ts:263/267/290`），**跑完待收 / 已结束 / 机器离线三种 waiting 完全没有等待时长**；②这套 reason/since 只活在浏览器里——daemon 的 `notificationProducer` 与 server push 的 `kind: done|permission|question`（`pushRoutes.ts:162`）是对同一件事的另外两次独立推导，三份判定今天靠纪律一致，不是靠构造一致；③侧栏用 accent 表示「待处理（等你）」，而 `tokens.css` 与 design-language 第 30 行规定 accent 只表示 live。另需删掉草稿两处伪证据：PWA 角标全仓 `setAppBadge` 零命中；「CI 失败」今天没有数据源（属 T-22）。侧栏排序换四次后禁用的在案原因是 ⌘1-9 需要位置稳定（B-076），**不是分类不统一**。

**提案**：不做「统一词表」重构，只做三件事加一条纪律。① `lifecycleOf` 输出扩成 `{state, reason, since}`，并对**全部** waiting 赋 since：permission 用请求到达时刻（`req.at`，已是数据不是本地时钟）、needsInput 用**由 daemon 盖戳上报的**状态进入时刻（不是今天那个浏览器时钟，见②）、reap 带（idle/ended/machineOffline）用进入该状态的时刻；reason 从高优先回落到低优先时 **since 不重置**（Paseo priority unmasking）。②判定与 since 下沉到事实所在处并随 session/terminal 推送下发，客户端只渲染：**必做项——终端 since 下沉到 daemon 上报**：今天 `sync/terminalAgentState.ts` 的 `entry.since` 是浏览器 ingest 时钟（注释原文「When we first observed the CURRENT state (**ingest-side clock**)」:32，赋值处 `since: Date.now()` :121），冷启动时 `before` 为 undefined 必然走这一支，**刷新或换设备后终端 since 归零**；daemon 已在 tmux 侧持有 `session_activity`（下发为 `activityAt`），状态进入时刻必须由 daemon 盖戳后随 `daemonState.webTerminals` 下发。不做这一条，T-02 队列的「等待最久优先」在手机首开时排序就是错的。同时 daemon 的 `notificationProducer` 与 server push kind 改为消费同一份 reason；没有镜像 hook 的裸 tmux pane 不得从字节流猜「在跑/已完成」，显示「无信号」。③词表封闭：新增一个 reason 必须删掉一个旧的。
渲染纪律：「等你决策」不使用 accent，紧急度由排最前 + mono 计时承载。

**竞品依据**：Paseo workspace 状态枚举带 host 侧盖戳的 `statusEnteredAt`，且高优先原因清掉后回落低优先、since 不重置。

**被挑战与让步**：**4/6 推翻（exists×2 + value×2，`verdicts/T-01.json` bucket=dropped——与 T-13 并列 NOW 段被推翻最狠的两条），终审判定为保留并大幅缩小。** exists 两票 REFUTE：「一处判定」已是现行不变量而非待办，按草稿立项等于花一个 M 买已经有的东西；value 两票**同样是 REFUTE（不是补充意见）**：剩下的是字段级重构，单独交付屏幕上不会有可观察变化。全部接受：撤掉「三套并行分类」的说法与「所有 NOW 项的依赖根」定位，缩成 reason/since 的上行契约 + 一条着色纠正。**另一处反对，终审复核后由「不接受」改判为接受**：principles#2 说 since 由客户端推导会在刷新/重连后归零——**它是对的**。permission 的 `req.at` 确实是数据（`boardItems.ts:263` 已核实），但终端的 `entry.since` 不是 daemon 的字段而是浏览器 ingest 时钟（`terminalAgentState.ts:32/121`），刷新/换设备即归零；所以问题不只在覆盖面，**载体本身也要改**（见提案②的必做项）。

> **需要你裁（其一）**：「等你决策」要不要放弃 accent？
> **A（推荐）**：严格执行 accent=live，等你决策改为 ink 高反差 + mono 计时 + 永远排最前。代价：最紧急的信号从此没有颜色，只有当队列成为默认镜头后才成立，否则是把最重要的信号降级。
> **B**：给设计语言开一条明文豁免，accent =「live 或 blocked-on-you」，把 B-085 现状写进契约。代价：teal 从此有两个语义，以后谁都能援引这条豁免。
> 我推荐 A，并与 T-02 同批交付。
>
> **需要你裁（其二，与 T-10 同形态）**：T-01 独立成条，还是并进 T-02 的实现条款 + 一条着色纠正？**critic 的原始建议是后者**（`critic.md`：「建议把『唯一分类器 = `boardItems.lifecycleOf`』并进 T-02 的实现条款，而不是当独立项」），原样交给你：合并则清单少一条，但 reason/since 的 wire 上行契约与「终端 since 由 daemon 盖戳」这条必做项容易被当成队列的装饰做丢；独立则这份契约有人认领。

### T-04 · 未读与「延后」接到已有的账号级已读水位上
`horizon` NOW ｜ `判定` 保留（重写、降调）｜ `依赖` — ｜ `backlog` 扩展 `notificationSeen` / `notificationSeenStore` / `useSeenTracker`（B-086 同一条链），建议新开一条并写死「不新建第二套同步语义」

**问题**：「未读是内存态、只有已读跨设备同步」只对了一半，问题陈述要降调：跨设备已读水位**已经是一套完整上线的模型**——`sync/notificationSeen.ts` + `notificationSeenStore.ts` 用账号 KV `vh.notif-seen.v1` 存每目标一个 `lastSeenAt`，per-key max 合并 + 版本 CAS + `kv-batch-update` 实时推送 + MMKV 镜像兜底，`useSeenTracker` 有 dwell 700ms / 可见性 / 60s 心跳 / pagehide 收尾（B-086 修过「看完就关 tab」）。真正没接上去的只有三处：侧栏那颗灰点仍读内存 Set（`storage.unreadSessionIds`，`storage.ts:270/696-718`，换设备即丢）、终端行根本没有未读、没有「看过了待会儿再办」的表达。草稿提的字段设计还会造伤：`dismissedRequestIds` 是重复真相（权威 pending 集是 `agentState.requests`，答完 CLI 直接 delete），`attentionClearedAt`/`lastSeenSeq` 是第二、第三个时间戳，会破坏「一 key 一 max」这个让 KV 载体并发安全的唯一理由。

**提案**：复用同一张图，只加一张同形状的图。①侧栏与终端行的未读改为从 SeenMap 派生：unread ⟺ 该目标最后一次 turn 结束时间 > `lastSeenAt[key]`（会话与终端共用 `t:<id>` 键空间，已就绪），删掉 `storage.unreadSessionIds`。②新增第二张同样 per-key max 合并、写进同一 KV blob 的 `snoozedUntil` 图承载「延后」：条目暂时下沉、到点回浮，**回浮时 since 不重置**。③三个位永远分开、任何一个都不许代替另一个：机器事实「还在等」（只有 agent/CLI 能清）、已读水位（账号级、纯 cosmetic）、人为延后。
验收写死一条：**在手机上延后一条权限请求，桌面上该请求仍必须可见、仍在等**。明确不做 `dismissedRequestIds`、`attentionClearedAt`、`lastSeenSeq`。将来若做 PWA 角标，计数必须从这份账号级记录派生。

**竞品依据**：Orca 右键 mark unread（triaged 了但想稍后回来）+ bell 未读跨 worktree + Dock badge 镜像；Paseo `clear_attention` 在 host 侧执行、对未加载会话也生效。

**被挑战与让步**：零票推翻，但六票里四票要求降调与改形状：跨设备已读不是「做了一半」，而是一套已上线、为并发安全专门论证过的完整模型；`dismissedRequestIds` 会造出「我在手机上划掉了，机器那端 agent 还卡着」的信任缺口，是 Paseo #1764 那类事故的用户侧变体。两条都吃进，本条因此从「S 号新机制」降为「接线 + 一张新图」，但仍保留为独立条目——它是 T-02/T-03 可信度的前置。

> **需要你裁**：「延后（snooze）」与「标记为未读」二选一，不要都做。
> **A（推荐）**：只做 snooze，有到期时间、会自己回来。代价：要选时长，多一次交互（长按/右键给「1 小时 / 今晚 / 明早」三档）。
> **B**：只做 mark unread，永久亮着直到再看。代价：它本质是没有时限的 snooze，容易积成一片永远亮着的点。

### T-06 · 通知（拆成 T-06a 权限推送正被 presence 整类吞掉 ／ T-06b IM 腿延迟发 + 通道策略）
`horizon` NOW ｜ `判定` 拆分 ｜ `依赖` T-01 ｜ `backlog` 以可验证 bug 复活 B-008（dropped 理由「需求不具体」已失效）；T-06b 同批兑现 B-026

**问题**：实情比草稿写的更严重也更好改。`dispatchSessionEventPush` 的门是**账号级** `isUserActive(userId)`（`pushDispatch.ts:234`），只要有任意一个非 machine 客户端连着且未 background，**所有设备推送整类被抑制**（日志原文 'Suppressed device push for active account; webhooks already sent'）——**桌面开着一个标签页时，手机永远收不到权限请求推送**。这正是草稿引用的 Paseo #1764 反面案例，今天活在 vh 生产里，而且它是一个按 kind 的分支就能改的 bug（`kind: done|permission|question` 已在 `pushRoutes.ts:162` 的 zod schema 上并随 data 下传）。已有的部分要如实标注：chime 已有自视图静音 + 冷却 + 跨 lane 折叠 + 免打扰，server feed 有 repeatKey 每类留最新，webhook 已按 kind 映射开关。「7 个信号源」要减一：PWA 角标不存在。

**提案**：
**T-06a（bug 级，可独立先发）**：`dispatchSessionEventPush` 按 kind 分支——`permission`/`question` **一律不受 presence 抑制**；`done` 保留抑制，但把账号级 `isUserActive` 收窄成 per-target「有客户端此刻正在看这个会话/终端且可见」，**不引入时间窗**（180s 窗口正是 Paseo 事故的形状）。附回归测试锁住「桌面开着标签页时，手机仍收到权限推送」。
**T-06b（策略，需裁）**：①同一请求跨渠道只提醒一次，站内与 push 在任一端处理后立即静默；②IM/webhook 腿改为**延迟发**——等你类事件延后 N 分钟，发之前重查 `agentState.requests`，已答就不发（用户可见效果等同「撤回」且不撒谎——群消息本来撤不回，写「跨渠道撤回」就是又一次「UI 说的 ≠ 系统做的」）；③设置只留「每通道一个档位（只收欠决策 / 也收跑完）+ 一个免打扰时段」；④推送点击直达 T-03a 的决策卡，不是会话底部；⑤同批兑现 B-026（webhook 指数退避重试 + 投递失败进诊断）。
**明确不做**：升级阶梯（一个人、同一台手机，重复叫不会让决定更早做出，只会让你把通道静音）、事件×通道×时段矩阵（B-041 已经躺着 12 项无消费者的设置）、断线期决策的服务端队列（pending 权限的权威集就是 `agentState.requests`，回前台由 `resumeSync` 追平，铁律 13）。

**竞品依据**：Paseo issue #1764（180s presence 窗口曾让权限提示整类不推送）；Claude RC 只在你于该终端打字/聚焦时跳过推送，抑制粒度是「这台机器前的这个上下文」。

**被挑战与让步**：两票 REFUTE 打的是搭车项而非内核，四条全部删掉或替换：升级阶梯（删）、事件×通道×时段矩阵（删）、「跨渠道撤回」对任意 HTTPS 端点的 fire-and-forget 出站不可实现（替换为延迟发）、断线补齐队列在 vh 是重复真相（删）。剩下的内核经代码核实是 bug 而非设计诉求，因此单独拆出来，不必等策略部分定案。

> **需要你裁**：T-06b 的 IM 腿延迟发做不做？
> **A（推荐，N=3min）**：等你类延后 N 分钟再发 IM，发前重查，已答则不发。代价：真正需要你时 IM 通知晚 N 分钟到。
> **B**：不做，IM 保持即时 fire-and-forget。代价：你在桌面上 10 秒内批掉的请求，群里照样弹一条，重复轰炸照旧。
> T-06a 不需要裁，那是 bug。

### T-09 · turn 收据：机器事实与 agent 自述分源的结构化 outcome
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` T-01 / T-05 ｜ `backlog` extend B-132；把 B-260 子代理 `stop{status,result,usage}` 的 wire 形状提升到会话级；token 口径与 B-211 合流

**问题**：「跑完了」今天只有三样够不上的东西：`metadata.summary` 标题；`metadata.board{attention, progress}`（B-132 `report_progress`，只有 Claude 会写、guidance 明确只在里程碑写）；以及 boardAnalyzer 的一行进度句（代码默认关、只能在机器本地 `~/.happy/settings.json` 开，**你机器上已开**，见 T-05）。`workflow-layer §5 缺口 3` 点名「没有会话 outcome 的结构化表示」，于是队列行、通知正文、webhook、recap、复核与未来 bot 都得各自重读一遍 transcript。

**提案**：turn 边界（以及会话结束/失败）由 wrapper 写一条 outcome，**两段分源、渲染上分栏**：
- `facts`（机器算出，模型不可填写）：本轮 `+x −y / m 文件`（`git status --porcelain=v2` + `diff --numstat`，`sync/gitStatusFiles.ts` 已有取数先例）、分支与 base ref（与 T-11 的 ref 快照同一次写入）、跑过的命令与退出码、新建的 commit/PR、耗时与 token（口径对齐 B-211）。
- `claims`（agent 自述，UI 明标「未核对」）：`next`、`blocked_on` 一句话、`how_to_verify`、`发现的后续事项[]`。
**不新增状态权威**：删掉草稿的 `state` 枚举与 `owes_decision`，状态一律由 T-01 的判定函数从 facts/claims/`agentState.requests` 推导；`headline` 与 T-05 共用同一字段、同一写者（T-05 = 运行中那一句，本条 = 收尾定稿那一句）。
降级链按 `session.metadata.capabilities` 分版本（铁律 14）：旧 wrapper 与 Codex/Gemini/OpenClaw 会话只出 `facts`（wrapper 推导是唯一跨 flavor 的路径），绝不伪装有进展。
桌面/手机：turn 尾部一张紧凑卡，不新增面板。消费方：队列「跑完待收」卡、T-10 recap、通知与 webhook 正文、`/btw`、未来 bot。

**竞品依据**：Orca 要求 worker 恰好发一次 `worker_done --outcome succeeded|failed`，coordinator 用 `worker-read --source auto` 取结构化 transcript；OpenClaw 的完成 handoff 带 Result/Status/token 并附一条 review instruction。

**被挑战与让步**：5/6 保留但要求同一组修正，全部吃进：① facts/claims 必须分源——否则「跑绿了」这句自述会被队列/webhook/recap/bot 一起当事实继承，而校验它的 T-29 在 NEXT；②不许新建第四套状态词；③ headline 不许有第二个写者；④「后续事项 → 一键新 worktree 会话」隐式依赖 T-21，拆出去。唯一 REFUTE 认为它与 T-05 重叠、真正新增的只有 facts——部分成立，已被上述修正吸收。不接受的部分：facts 不是「可有可无的一半」，它正是队列「待收」行不打开会话就能读的唯一来源。

> **需要你裁**：「发现的后续事项」的出口。
> **A（推荐）**：只写成 backlog 候选行，人 triage 后才开工——合你自己写下的批次纪律。
> **B**：给 Claude 式 task chip，点一下在新 worktree 起会话。更快，但绕过 triage，而活跃区已 31 项非 done、verify-queue 90 项待清。

### T-11 · 累计变更视图：以 git 工作区为真相，作用域含「最近一轮」
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` — ｜ `backlog` 以新论据复活 B-036；扩展 B-208 的 `?panel=changes`；兑现 `specs/2026-08-open-preview.md` 挂起的 `mode:'diff'`；回收死设置 `diffStyle`

**问题**：评审停留在工具级：`screens/session/DiffView.tsx` 只服务 Edit/Write 工具卡；`FilesPanel` 的 Changed 只有文件名 + 增删行，点开走 `FileView` 是整文件；`open_preview` 的 `mode:'diff'`「只留参数位，实现依赖 B-036」。B-036 记账为「并入 B-208」，但 B-208 的 spec 非目标写死「不改变 Git 数据源、文件 RPC」，并不覆盖本条。于是 Owner 的真实动作是开一个 web 终端跑 `git diff` 用 xterm 读。更硬的理由不是「工具级 diff 不够全」而是**原理上不可能全**：Bash/sed、格式化器、hook、并行会话与终端手改都不产生 Edit/Write 卡。

**提案**：把变更视图从**会话属性升级为工作区属性**（`machineId + cwd`，B-208 已派生出这个 key），取数改走机器/daemon 作用域：今天 `sync/gitStatusFiles.ts` 走 `sessionBash`（`ops.ts:1469`），**会话一归档、进程一死 git 面就全黑——而那恰好是「跑完待收、该评审」的时刻**；machine 级 bash RPC **已经存在**（原稿写「`apiMachine.ts` 现有 handler 里没有任何 machine 级 bash/git」是错的）：`apiMachine.ts:262` 调 `registerCommonHandlers(this.rpcHandlerManager, process.cwd())`，其中就注册了 machine 级 `'bash'`（`modules/common/registerCommonHandlers.ts:198`），web 侧封装是 `sync/ops.ts:1143` 的 `machineBash`，`utils/worktree.ts` 正在调它。真正的约束是另一件事：该 handler 用 `validatePath(cwd, process.cwd())` 把 cwd **锁死在 daemon 自己进程 cwd 的子树内**（`modules/common/pathSecurity.ts:15`），对任意仓库路径不可用，而且它是通用 shell 面不是 git 专用面。所以本条要做的是**放宽/新增一条作用域受控的 machine 级 git 取数 RPC**（只读 git 子集 + 显式作用域参数），不是从零新增一条 machine 级执行通道。
必要核心（批准理由只包含这些）：作用域切换 `工作树 / 最近一轮 / 自起点 ref`；左文件树（目录级 ±）+ 右 unified diff；逐 hunk 折叠；顶部 `+466 −124` 与文件数；`j/k` 换文件、`n/p` 换 hunk。
「最近一轮」和「自起点」不是视图问题是**记录**问题：起活时记 base ref（HEAD sha + 分支），每个 turn 起点记一次 ref（未提交部分用 `git stash create` 一类树对象），与 T-09 的 facts 同一次写入；不写这条契约，实现会静默塌缩成只剩「工作树」——而那正是今天开终端就有的那个。旧 wrapper 没有快照时该镜头显式置灰说明。
桌面：右栏 `变更` tab 保留为 peek，主视图是可全宽的工作区路由（沿用 `?panel=changes`，不新增表面）。手机：全屏、文件树抽屉、diff 默认换行。机器离线时明说「机器离线，无法取 diff」，不空白。
标为可选增强、不作为批准理由：split 视图（复用死设置 `diffStyle`）、图片 diff、二进制提示。语法高亮复用现有 shiki 并懒加载（B-028 体积债）。

**竞品依据**：Codex review pane 作用域 `Unstaged / Staged / Commit / Branch / Last turn`，明写「reflects Git state, not only agent edits」，其 flows 把「Last turn」点名为解决「files I didn't ask for」困惑的关键。

**被挑战与让步**：**0/6 推翻（与 T-04、T-34 同为全票保留的三条之一——原稿写「本批唯一全票保留」是错的）**。四条形态修正已吃进：取数不得走 `sessionBash`；作用域挂 workspace 而非 session；「最近一轮/自起点」必须先有 ref 记录契约；桌面右栏（861px 门控）放不下逐 hunk + 高亮 + split，主视图要能全宽。按 reviewer 建议收窄了必要核心，把 split / 图片 diff / 二进制移出批准理由——不是因为工作量，而是附件太多会让一条真正必要的事被整条否掉。

> **需要你裁**：要不要为「最近一轮」这一个镜头付 CLI 侧的每轮 ref 快照契约（wrapper 改动，按 capabilities 分版本，存量会话拿不到）。
> **付（推荐）**：队列「跑完待收」、T-25「每轮停下等我看」、T-12 的批注对象都有了确定的 diff 基准。
> **不付**：只做「工作树 / 自起点」两个镜头，「这一轮改了什么」继续只能靠滚工具卡自己数。

### T-12 · diff 上的批注 → 一条行锚定的批量指令（草稿缓冲，不建评审状态机）
`horizon` NOW ｜ `判定` 保留（重写、大幅收窄）｜ `依赖` T-11 ｜ `backlog` 取代 B-094 Notes 被当作「攒一句带位置的 prompt」的用法；与 B-035 划边界；复用 B-240 durable queue 的卡片与取消语义

**问题**：要纠正 agent 的一处改动，今天只能在 composer 里用自然语言描述「你在 auth.ts 47 行附近那段改成…」——把定位工作从机器推给人；全仓 grep `annotat|inline comment|reviewComment` 零命中。现有补丁是 B-094 Notes + `app/insertToInput.ts`。真正的第一性理由不是竞品一致：**绝大多数 agent 评审发生在还没有 commit/PR 的工作树上**，GitHub 行内评论覆盖不到那一段——出口必须在产品内，没有出口的 T-11 只是观察窗。

**提案**：在 T-11 的 diff 上：桌面点行号或按 `c`、手机点 hunk（换行后行号是 ~10px 的模糊命中区，终端正因同类问题才做了 Select 模式）写 markdown 批注 → 进入**这张 diff 的草稿缓冲区**（挂在 composer 上方，复用现有 queue track 视觉）→ `⌘Enter` 汇总成一条行锚定的批量指令（`at src/auth.ts:47, …`，带 hunk 原文引用）发给当前会话 → 发送即清空。手机在键盘上方固定「发送 n 条批注」。
通道写死（铁律 8）：默认进 durable Queue（会话忙则排队、闲则直发，复用 B-240 的 queued 卡片与取消语义），Steer 只作为一个显式的第二动作；**不存在任何隐式发送口**。
本批明确不做：跨修订锚点跟随、已解决/未解决状态机、常驻验收清单、「发给哪个执行体」。验收改靠重看 T-11 的「最近一轮」镜头 + T-09 的 `how_to_verify`。

**竞品依据**：Orca 把批处理理由写成机制——逐条发会让 agent「swing back and forth」，攒一批给一轮思考命中率更高，`Send to agent` 组成一条行锚定 prompt；Codex 自评其行内评论「still need an explicit follow-up message to take effect」。

**被挑战与让步**：1/6 推翻 + 全员要求收窄。REFUTE 的理由：对这位 Owner 位置不是成本——被纠正的是一个正在同一会话里听着的机器；真正需要行锚定 + 跨修订存活的是异步人-人 PR 评审，而他那段已有 GitHub 行内评论、`land-pr.sh` 与对抗 review 方法论。部分成立，已让步：砍掉全部 PR-review 半身，只留「读 diff 时把位置交给机器 + 一次发一批」。不接受的部分：工作树阶段没有 PR 对象可承接，而 agent 改的东西绝大多数要在开 PR 之前就被纠正一轮；且他今天的替代动作是在手机上开 xterm 读 `git diff` 再口述位置。

> **需要你裁**：「diff → 输入框」这个手势归谁。
> **A（推荐）**：归 T-12——批注与引用共用同一个草稿缓冲，区别只是带不带正文，T-31 降为纯 `@文件` 补全与拖入。
> **B**：归 T-31——先做便宜的 hunk 引用，批注等 T-11 落地后再评估。代价：T-12 在本批只剩一个空壳、评审仍然没有产物出口。

### T-05 · 把已有的进展句投影到所有表面、开关搬进 Web、没写就说没写
`horizon` NOW ｜ `判定` 保留（重写、删掉最贵的两条方向）｜ `依赖` T-01 ｜ `backlog` 扩展 B-132 / boardAnalyzer 的产物；开关搬家与 B-041 同批

**问题**：delta 是真的，但比草稿小得多，而草稿最贵的两条方向是错的。真的部分：`metadata.board.progress`（B-132 + daemon 侧 boardAnalyzer）今天只投影到 BoardCard，侧栏副标题仍是 `getSessionSubtitle` 的 host·agent·摘要，⌘K / 通知 / webhook 正文都没有这句话；`boardLlm` 的**代码**默认是关、且只能在机器的 `~/.happy/settings.json` 里开（`boardAnalyzer.ts:20/246`）——但**实测 mac-office 的 `~/.happy/settings.json` 里就是 `"boardLlm": true`，Owner 早已开启，这条 LLM 车道正在生产跑**（这条本机取证是终审阶段补的：全稿对 `~/.happy/assistant/`、`todoProvider`、`ps` 都做了取证，唯独漏了这个开关，因此下方裁决的论证前提整个换过）。错的部分：①「agent 自写优先、便宜模型兜底」不是新设计，boardAnalyzer 已经 import `isSelfReportFresh`；②「改由 relay 侧兜底」是把模型凭据、常态 token 成本与一条新失败面搬进生产镜像，而 boardAnalyzer 跑在 daemon 恰恰是因为已认证的 claude 二进制、订阅额度与 cwd 上下文都在机器上；③「默认开」让每个在跑会话每轮烧订阅额度，而额度触顶会让一批并行会话同时停摆（T-30 的前提）；④与 Owner 自己写进看板设计的管理哲学反向——`boardItems.ts` 头注释原文「DONE is not a status but an explicit user action」。

**提案**：三件事，全部零模型成本或成本不变。①**投影**：把已存在的 `metadata.board.progress` 复用为侧栏副标题、队列行、⌘K 结果行、通知与 webhook 正文——一处产出、多处渲染。②**诚实降级**：没有新鲜自述的会话不伪装进展，显示 `no update · 12m`（时长由 T-01 的 since 算，零调用）；在跑的行显示确定性事实「当前工具 · 计时」（会话页 `SessionLiveStatusBar` 已是这个形态）。③**开关搬家**：`boardLlm` 从机器本地文件搬到 Web 的机器页，经 daemon RPC 写 `~/.happy/settings.json`（机器页已有 Claude 认证预检/修复的 RPC 先例），**不进 synced settings**（铁律 1 禁 zod `.default()`）。
明确不做：relay 侧生成、运行中节流刷新的模型旁白。跨 agent 自述通道归 T-01 的 reason 覆盖与 G-03。

**竞品依据**：Claude agent view 的行摘要由 Haiku 级模型写、运行中 ≤15s 刷新（vh 明确不抄这一半）；OpenClaw 的 live digest headline 同时是侧栏副标题与手机列表文案。

**被挑战与让步**：4/6 推翻（value×2 + principles×2），最强三条接受：与 Owner 自陈的管理哲学反向、relay 侧兜底把模型凭据与常态成本搬进生产镜像、「默认开」用会让并行会话集体停摆的额度买一句可能没人读的话。**一条打在幸存内核上的反对，原稿整条略去了，补在这里——部分接受**：value#1 原话「把一句模型写的话默认铺到侧栏/看板/队列/通知/webhook/⌘K 七个出口，是在『UI 说的 ≠ 机器真相』这个类别上加杠杆——一句错的 headline 比没有 headline 更贵」。而提案①保留下来的正是这条投影。缓解写死三条：该句只能来自 agent 自述 `report_progress` 或 daemon 的 boardAnalyzer（**不新增第三个写者**）；缺失时强制显示 `no update · 12m` 而不是留白或复用旧句；投影出去的每一处都按 agent 自述渲染、不与机器事实（当前工具 · 计时 · T-09 的 facts）混排。**残留风险如实说**：代码默认关这条挡箭牌对你不成立——你机器上 `boardLlm` 已开，所以「多数行根本不会有句子」在你这里是假的，杠杆是真的；这也是上面那一刀（收窄到只对「跑完待收/失败」生成）的另一个理由。一处不接受：**三位** reviewer（value#2、principles#1、principles#2）主张整条并入 T-09 + T-01——T-09 管的是 turn 结束的结构化 outcome，而「在跑的行显示什么、没写状态时显示什么」是列表渲染契约，合并会让「no update · 12m」这条最便宜也最必要的诚实规则无人认领。

> **需要你裁**：boardAnalyzer（LLM 旁路）的**生成范围**。（**「先看你会不会去开它」这个问法已作废**——你机器上 `boardLlm` 已经是 `true`。在已开启的前提下，提案的三件事——投影、诚实降级 `no update · 12m`、开关搬到 Web——是纯收益，不需要裁。）
> **A**：维持现状——只要开着就按 boardAnalyzer 现有节流（5 分钟最小间隔 + 内容 hash 变更 + 每机器每小时 30 次上限）生成，包含在跑的行。代价：为「在跑」这类正确反应通常是「什么都不做」的行持续烧额度，而额度触顶会让一批并行会话同时停摆（T-30 的前提）。
> **B（推荐）**：收窄为**只在 turn 结束写一次、且只对「跑完待收 / 失败」两类行生成**。代价：在跑的行只剩确定性事实（当前工具 · 计时），没有模型旁白。
> 两案都保持**代码默认关**（新机器不自动烧额度），改的只是已开启时的生成范围。

### T-10 · 未读区间：确定性的「你离开期间发生了什么」，两处渲染、零读时模型
`horizon` NOW ｜ `判定` 保留（重写、削成渲染规则）｜ `依赖` T-04 / T-09 ｜ `backlog` 与 `specs/2026-08-workspace-context.md` 非目标「本批不实现 turn outline」冲突（新论据在下）；与 B-209 互补不重叠

**问题**：回到一个跑了 40 分钟的会话，今天 transcript 里没有任何「上次看到这里」的分隔：`ChatList.tsx:337-384` 只有「回到最新」按钮，其上的「↓ n」是 `chatFollow.ts` 的离底 row 快照——回到底部即清零，跟上次访问无关；roadmap 承诺的 durable work memory 零代码。这里要同时更正草稿与 reviewer 的一处共同错误：**跨设备锚点并不缺**——`notificationSeenStore.ts` 的 `vh.notif-seen.v1` 已把每个目标的 `lastSeenAt` 同步到账号 KV 并按 key 取 max 合并，缺的只是把它当成区间边界用。

**提案**：定义一个「未读区间」对象（不是一张看一次就没的卡）：区间 = `lastSeenAt(target)`（账号 KV，已有）到最新。内容 100% 由已持久化的 T-09 outcome 在客户端拼装，**读时零模型调用**：①机器事实行 `自你上次查看：n 轮 · +x −y / m 文件 · k 工具 · e 次错误 · 42 分钟`；②区间内每轮已写好的 headline 顺次列出（不重新生成）；③一行「现在的状态」（T-01 判定词）+ 动作 `跳到这里 / 全部展开 / 收起`。outcome 缺失时只显示机器事实行，不生成散文、不伪造 outline。
同一个对象**渲染两处**：①T-02 队列/侧栏行的展开态——不进会话就能读完；②会话内已读水位处的一条窄条，**手机上是首屏固定条**，不是要滚动才看得见的行内锚点。
生命周期：不「打开即消费」，只有 `lastSeenAt` 真正推进才失效；配「标记为未读」回退（与 T-04 同一水位）。

**竞品依据**：Claude 的 transcript Summary 模式文档明写用途「when you're running multiple sessions and want to scan results quickly」；Orca Agents feed 被定义为「the catch-up surface when you've been away」。

**被挑战与让步**：4/6 推翻，三条核心：①「它只是 T-09 + T-04 的一条渲染规则」——部分接受，削成「区间对象 + 两处渲染」，headline 与 facts 都不归它，偏好记忆删除；②「缺失时用便宜模型生成 = 把一次 LLM 调用放到一天最高频动作上，且两台设备会对同一区间生成两份不同说法」——完全接受，读时模型路径已删；③「打开即消费掉会重演 T-04 要消灭的跨设备失忆」——接受，改为绑定同步水位。同时更正 reviewer 一处事实错误：per-target `lastSeenAt` 早已是账号 KV 同步且 merge-by-max，区间边界今天就能算。

> **需要你裁**：保留为独立条目，还是并成 T-09 的一条渲染条款 + T-04 的一条水位条款（清单少一条）。
> 推荐保留独立，理由只有一条：它拥有「队列行展开即读完、不必进会话」这个承诺，而那正是 T-02 的核心承诺——挂到 T-09 底下会被当成会话内的装饰做丢。若选择合并，务必把「两处渲染」写进 T-09 的验收条款。

### T-13 · 失败可读：分层 ErrorBoundary + 一条按同一张词表措辞的全局横幅
`horizon` NOW ｜ `判定` 保留（重写、降为给已在册项补形状）｜ `依赖` T-15 ｜ `backlog` 扩展 B-027（`docs/backlog.md:62`，逐字同题）与 B-003（:55，RPC 假 ack 收口）；吸收原 T-18 的掉线横幅

**问题**：`packages/happy-web-v2/src` 全域 grep `ErrorBoundary|componentDidCatch|getDerivedStateFromError` = **0 命中**，任一渲染/reducer 异常整页白屏；铁律 17 记录的「handler 抛错 → 正常 ack → store 当成功 → 渲染层拿 undefined」就是现成触发路径，而 B-003 的收口未完（只有 `sync/fsOps.ts` 与 `sync/ops.ts` 的 `throwIfRpcError` 三处做了检查）。草稿写的「白屏 = 丢失未发送输入」**被代码证伪**：`sync/persistence.ts` 已把 composer 草稿与纯文本队列落 MMKV，真正丢的是滚动位置与**带附件的队列项**。真实代价是：整个 app 不可用直到刷新，而 iOS PWA 上「刷新」这条恢复路径本身是已知会卡 loading 的（B-223 done / V-094 未清）——手机白屏 = 这台设备当场退出战斗。诚实前提：B-027 逐字就是这件事，本条不是新发现，而是给它补验收标准。

**提案**：①**边界分层**：全局 1 层 + 每个「被远端数据直喂」的区域各 1 层（transcript 列表、xterm 实例、Files 面板、侧栏）。降级卡固定三动作：重试 / 重载应用 / 复制诊断；`resetKey = route + sessionId`（否则同一条坏消息会让边界反复自愈失败，比白屏更难恢复）。手机是单栏全屏，区域=整屏，所以全局层必须自带「重载应用」。②**一条全局横幅、一个槽位**：复用 `AppRoot` 已有的 `CliUpdateBanner` 挂载点（`AppRoot.tsx:71/78`），与会话级 `SessionArchivedBanner`/`MirrorBanner` 明确优先级（会话级 > 全局，同时只显示一条）。横幅是**不改变终端 pane 尺寸的浮层**（占位会重新触发 xterm padding/floor 那类复发几何 bug，铁律 9），手机置于 safe-area 顶部。③**措辞不自建词**：原因取自 T-15 收敛后的存在轴词表，不可自愈的原因下**撤掉重连建议**、只给唯一正确动作。吸收原 T-18 的唯一必要内核：宿主机掉线时写明影响面——`mac-office 已离线 4 分钟 · 6 个会话与 3 个终端受影响 · 查看机器页`，恢复后自动撤下并提示「已恢复，正在追平」。④后台重试静默指数退避，只有用户点「重试」才显示 in-flight。⑤硬规则：任何 web RPC wrapper 先检查 `error` 字段（铁律 17）。
删掉草稿两处：「服务端已更新，点此重载」（`app/staleBundleReload.ts` 已因 2026-08-13 僵尸 bundle 事故改成可见性边沿自动重载，再加人工横幅是回退）；「缓存先上屏」（web 今天没有会话/消息本地持久层，且与本条「屏幕上写的是真的」直接冲突）。

**竞品依据**：Claude RC 把 8 秒 toast 换成常驻失败指示器并按原因分文案（taken over / ended / archived elsewhere / server can't find it），在这些情形下**撤掉**重连建议。

**被挑战与让步**：**4/6 推翻（exists×2 + principles×2，`verdicts/T-13.json` bucket=dropped），终审判定为保留并降为「给已在册项补形状」。** 最强反对（2 票 exists）：「这逐字就是 B-027 + B-003，Owner 逐条评审时无可裁决」。属实，不再写成新发现。第二条（principles×2）：「按原因措辞会造出第四套『不在』词汇」——接受：横幅原因词强制取自 T-15 的词表，T-18 的掉线横幅并进同一个槽。第三条（value×2）：「白屏 = 丢失未发送输入」被 `persistence.ts` 证伪——已改掉。

> **需要你裁**：要拍的是优先级不是形状——把 B-027 + B-003 从 debt 提到本批执行，并接受「横幅按原因措辞、词表来自 T-15」这一层设计约束。若判为不做，请顺带明确「宿主机掉线横幅」的去留（它是从被否决的 T-18 并进来的，会随本条一起消失）。

### T-15 · 「还在不在」收敛成一张词表的存在轴 + 一个 Restart
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` T-01 ｜ `backlog` 延伸 B-264/B-265/B-268/B-272；**显式推翻 `specs/2026-09-session-recoverability.md` 三条非目标**；合并 `app/sessionRestoreRules.ts` 与 `app/sessionRestartRules.ts`

**问题**：机制侧已经修了 8 个 spec（B-083/B-149/B-150/B-177/B-264/B-265/B-268/B-272），用户仍要理解 ~8 种「不在」。代码侧证据：`sessionRestoreRules.ts` 与 `sessionRestartRules.ts` **两套规则并存、各带一套 reason 枚举**（restart 独有 `daemon-too-old`）；UI 里「归档 / 离线 / 墓碑 / processFailed / 已结束终端 / 镜像 ended」各说各话；B-268 的做法甚至是继续**增加**分支文案，说明不收敛词汇就会继续长词。草稿两处要修正：「归档会话发消息是黑洞」已由 B-265 交付（`canReleaseQueuedMessage(gate='restore-first')`），「离线会话只能先归档再恢复」已由 B-268 交付（`canOfferRestore`）。

**提案**：一张词表两条轴，同一个纯函数判定、处处渲染；本条只负责**存在轴**，取值四个不多不少：
`活着` / `不在 · 可重启`（[重启]：同 id、同 cwd、同模型、同授权；固定副文案写幸存矩阵——转写 ✓、工作区 ✓、进程 ✗）/ `不在 · 宿主不可达`（**不显示重启**，唯一正确动作是去机器页 / 唤醒机器）/ `已删除`。四种非自愿的「不在」（离线、墓碑、processFailed、终端已结束）合并成第二态；判定与执行下沉为 daemon 的**单一 revive RPC**——web 只传 sessionId，daemon 自己决定走 resume 还是 respawn。
「归档」不删概念、只换动词：它是 Owner 唯一能把跑完的活清出列表的主动动作（无删除语义，B-083），改名「收起 / 已完成」，`删除` 仍是唯一破坏性动作。
不用「执行体」这个名词（T-19 未采纳它作为一等 IA），卡片就叫会话卡；T-14 的能力行挂在这张卡上，不另开面板。移动端约束保留：banner 是详情页（侧栏隐藏时）唯一恢复入口，收敛文案不得顺手删掉它。

**竞品依据**：Orca 在每个退出的 agent tab 上给 Restart chip（一键重启同 agent、同 cwd、同账号），文档附诚实的幸存矩阵。

**被挑战与让步**：三票推翻。①「T-01 已经在做词表，两条各自宣称唯一词表就是 vocabulary churn 第 9 轮」——接受一半：词表所有权合并成一张，本条只写存在轴；但两个规则文件并存与 UI 四套说法是可核实的现状。②「两态模型会被宿主机事实打穿：机器离线时按 [重启] 要么失败要么说谎」——接受，加第三态。③「『归档一词从 UI 消失』只处理了词、没处理动作」——接受，改成换动词。④「必要性的证人是同事不是 Owner」——部分成立，但两套规则文件与 12 种 restore 失败原因是 Owner 每次改这块都要付的复杂度。⑤「引入『执行体』依赖未采纳的 T-19」——接受，改名。

> **需要你裁**：**显式推翻 `specs/2026-09-session-recoverability.md` 的三条非目标**（不做统一 reviveSession、不把离线会话留在列表、不重命名归档视图）及验收项「离线会话 composer 仍直发」。
> **A（推荐）**：批准推翻，判定下沉为 daemon 单一 revive RPC + 词表收敛。代价：新出一份 spec，且 B-265/B-268 正在改的 banner 文案要跟着再改一次。
> **B**：维持非目标，只做「幸存矩阵 + 统一 [重启] 文案」这层表面收敛。代价：两套规则文件与四套词继续存在，第 9 个 spec 大概率还会来。
> 我推荐 A，但 gate 在 B-265/B-268 合入之后再动手。

### T-14 · 能力真相长在被挡住的控件上（删掉「会话真相面板」）
`horizon` NOW ｜ `判定` 保留（重写、删掉新表面）｜ `依赖` T-15 ｜ `backlog` 扩展 B-262（七态副文案降格为 design-language 纪律）与 B-264；给 B-279 补新论据；收敛 B-040/B-283/B-273/B-284 那批各自为政的「请升级」提示

**问题**：`session.metadata.capabilities`（`sync/storageTypes.ts:47`）今天只被四处功能门各判各的——`AgentInput.tsx:186`（claude-steer-v1）、`btwCommand.ts:30`（claude-btw-v1）、`livePermissionMode.ts`、`yoloEnforcement.ts`——没有任何地方汇总或解释；web 里唯一可见的版本号是**机器级** `happyCliVersion`，而铁律 14 恰恰规定按**会话**能力分版本，即用户能看到的是错的那个轴。同一账号两条会话能力不同是常态，今天的表现是**控件直接消失**，用户无从判断该不该重启。另一半（诚实三态）不是缺口：B-262 的 `screens/session/permissionModeDisplay.ts` 七态副文案已上线并有单测。

**提案**：删掉「会话真相面板」这个新表面，换成四件事：① web 侧建一张 **capability registry**（key → 人话名 + 缺失时的一句原因 + 最低 CLI 版本 + 补救动作）。所有「请升级 very-happy-cli」提示只从这里取词；新增能力必须先登记，否则 UI 不得引用。②能力不足的控件**不隐藏**：就地 disabled + 一行原因 +「重启会话」动作，例如「这条会话跑的是升级前的进程 · 重启可获得 /btw」——沿用已上线的 restore reason 写法。③会话级 CLI 版本、进程启动时间、幸存矩阵、重启按钮全部并进 T-15 的那张会话卡，一行即可：`CLI v0.2.9x · 重启可获得：/btw、即时改模式`。不给 ChatHeader 的连接点加第二重语义。④把 `app/sessionRestartRules.ts` 今天只挂在 `processFailed` 上的「重启会话」提升为常驻动作，与 T-15 的 [重启] 同一个入口。
不作为 todo：「任何反映远端事实的控件必须显示 已生效 / 切换中 / 未确认(原因)」写进 `docs/design-language.md` 的组件纪律。

**竞品依据**：Codex 权限卡把 SANDBOX / APPROVALS POLICY / REVIEWER 三格并列，把「能做什么」与「谁批准」显式分开；Claude 明说哪些模式在手机上不可选——都在使用点说明，**没有一家另开能力矩阵**。

**被挑战与让步**：四票推翻，核心一句：「这是给一个不该存在的问题配一个检查器」。①落点错（面板删除）；②内容错——`btw ✓ / steer ✓` 是把内部 capability 旗原样倒给用户（改为 registry 出人话）；③根治优于说明——B-279（daemon 升级后空闲自动把旧 wrapper 换到新 CLI）才是让能力歪斜消失的解（升为裁决项）；④三态诚实规则降为设计语言纪律。有一条不接受：「Owner 是自己切 tag 的人，不需要看版本」——控件默默消失而不说原因是产品缺陷，与谁在用无关。另纠正 reviewer 一处引用：七态副文案的实现在 `permissionModeDisplay.ts`，文案键才在 `text/_default.ts`。

> **需要你裁**：「把 B-279（空闲自动换代 wrapper）提到本批」还是「只做就地原因 + 常驻重启」。
> B-279 让能力歪斜从根上消失，代价是先出 spec 且触碰 respawn 与单写者锁（铁律 16）；只做就地原因，代价是每个新能力继续付一次 UI 分支税。
> 推荐两件都做，顺序是：就地原因先落（无协议改动、立刻止血）→ B-279 出 spec 再上。

### G-05 · 「本会话始终允许」必须能看见能收回，否则删掉这个按钮
`horizon` NOW ｜ `判定` 保留（重写）｜ **`来源` critic 补齐 · 未经 6 票对抗评审（`verdicts/` 下无 G-* 文件）** ｜ `依赖` T-03 / T-14 ｜ `backlog` 承接 T-27 被推翻后不可省的最小部分；机制边界见 `specs/2026-08-permission-mode-source-of-truth.md`

**问题**：清单保留了 T-03（含「本会话始终允许」）而 T-27（常设授权可见可撤销）被推翻——结果是 T-03 每被用一次就多一条**用户完全看不见**的会话内授权。**机制事实以 T-27a 为准（本条初稿写错了，已按代码改正）**：`PermissionCard.tsx:76` 确实用 `decision:'approved_for_session'` 带上 `sessionApproval.allowedTools` 出站、`ops.ts:1440` 的 `sessionAllow` 转成 `allowTools` 发给 wrapper；但**现代路径**下 wrapper 是把 SDK 自己给的 `pending.suggestions` 作为 `updatedPermissions` 交回 SDK（`claude/utils/permissionHandler.ts:285-296` 已核实），**规则住在 Claude 进程里，vh 既读不回也没有撤销通道**；只有 legacy 的 `response.allowTools` 才进 wrapper 进程内的 `allowedTools` Set，不持久、不上行、reset 即 `clear()`。两个推论必须写进本条：①**授权集的权威在 wrapper/SDK 侧，不在 web**——vh 侧唯一自有的东西是「这个浏览器这次点过什么」，把它当成「机器当前状态」展示，恰恰就是第 6 次「UI 说的 ≠ 机器实际的」，正是这条要防的事；②**寿命 = wrapper 进程寿命，重启会话即清空（这是设计不是 bug）**，所以本条的风险叙事不是「每用一次就多一条不可撤销的常设授权」，而是「用户看不到这条会话此刻到底允许了什么、也不知道它什么时候消失」。全仓没有任何读回、列出或撤销的入口，缺口成立。

**提案**：不做决策账本，只补 T-03 自己的出口，一行。决策卡与 T-14 的能力行上固定一行 mono：`本会话已允许 3 项 · 重启即清（展开 · 全部收回）`；展开是工具名列表，带 matcher 的（如 `Bash(git *)`）原样显示，不做人话化。三条硬约束：
① **值必须取 CLI 报告的当前授权集**（新增一条只读 session RPC，与 T-27a 的读侧是同一条），**不是 web 本地的点击历史**——只列「本浏览器点过什么」不构成机器当前状态；必须**先查 RPC 回包的 `error` 字段再信载荷**（铁律 17）。
② **没有该 RPC 的旧 wrapper 上：计数与展开按钮禁用并写明原因**（「这条会话跑的是升级前的进程，读不到当前授权集」，沿用 B-262 的诚实写法，铁律 14），**不得用本地历史顶替**。
③ **卡上文案写死寿命**：这些允许只活到该 wrapper 进程结束，**重启会话即清空**（是设计不是 bug）。
「收回」按 T-27a 的两种诚实处理：vh/legacy 自持的 → 撤销 RPC 即刻移除；SDK 持有的 suggestions → 文案写「移除并重启执行体」（复用 T-15 的 Restart），不假装即刻生效。计数为 0 时这一行仍在（写「本会话无额外允许」）——「有没有」本身就是用户要看的事实。
**若只能做一半**：可做的最小面是「读 + 诚实降级 + 寿命文案」，**不是**「web 自己列一列」——后者是把一个已知不等于机器状态的东西渲染成事实。
桌面/手机：同一行，决策卡底部与能力行里各一份。明确不做：跨会话允许列表、项目级策略 UI、决策账本、任何新的出站权限模式枚举。

**竞品依据**：Codex 把 SANDBOX / APPROVALS POLICY / REVIEWER 并列显示；Claude 把 permission mode 发布给所有已连接客户端并双向同步——两家的共同做法是**授权状态必须是可读的当前事实**，没有一家做「一次点击、此后不可见」的常设授权。

**我预设的反方与我的回应（无 reviewer 票）**：三条：①「T-27 已被推翻，再提是重复」——不成立，本条只提被保留的 T-03 自己制造的洞，范围小到一行；②「Owner 用自己的机器，风险被夸大」——部分让步，风险维度不争，但**可见性不是风险问题而是信任问题**；③「收回需要 wrapper 新能力，老会话拿不到」——接受；但初稿据此写的「**『查看』是纯 web 侧、立即可做**」**是错的，终审按代码撤回**：授权集的权威在 wrapper/SDK 侧（`permissionHandler.ts:285-296`），读侧同样需要一条 CLI 只读 RPC，旧 wrapper 上只能禁用并写明原因。因此「只做查看这一半就堵住了洞」不成立——堵洞的最小面是「**读 CLI 报告 + 诚实降级 + 寿命文案**」。

> **需要你裁**：**本刀已并入 T-03 的那一刀**（§5 第 2 条，四选项：配一行 / 删按钮 / 等 T-27a 上线再放 / 降级为本 turn 自动放行）——原来这里与那里是同一个决定却给了不一致的选项集，容易答出互相打架的组合。本条只保留**选「配一行」时的实现约束**：值取 CLI 报告、旧 wrapper 禁用并写明原因、卡上写死「重启即清」、收回按 T-27a 分两种诚实处理。

### G-03 · 非 Claude 会话不能是二等公民：队列可作答性是所有 engine 的底线
`horizon` NOW ｜ `判定` 保留 ｜ **`来源` critic 补齐 · 未经 6 票对抗评审** ｜ `依赖` T-01 / T-02 / T-14 ｜ `backlog` 扩展 B-132 到 stdio bridge；替掉 `AgentInput.tsx:131` 的 flavor 硬编码（B-241 的 `attachmentKinds` 已是数据驱动能力位）

**问题**：Codex / Gemini(ACP) / OpenClaw 会话今天在协议上是二等公民，而且缺口是**数据层的**、不只是 UI：`AgentInput.tsx:131` 硬编码 `supportsAttachments = flavor === 'claude'`、`btwCommand.ts:canOfferBtw` 同样按 flavor 拒绝、`supportsSteer` 与 `shouldApplyPermissionModeLive` 都要求 `isClaudeFlavor`。更关键的是 `report_progress`（B-132）**根本没进 stdio bridge**——`happyMcpStdioBridge.ts` 只转 `change_title` / `copy_to_clipboard` / `open_preview`，`publicContent.test.ts:308` 还显式断言 bridge 不含 `'report_progress'`。后果直击 NOW 段前提：T-01 的状态词表与 T-02 的队列一旦落地，非 Claude 会话在「等你决策 / 待评审」上永远缺行，而**漏行的队列不可能被清空**。T-14 只让这份不平等变诚实，不修它。

**提案**：定一条硬约束 + 补最便宜的数据层缺口。
**底线（硬约束）**：`回答问题 / 批准 / 拒绝 / 停止` 四个动作，外加「能产生一条队列行」，对每种 engine 都必须有实现**或明确的降级动作**；不允许按钮静默消失，降级文案沿用 B-262 已被证明有效的诚实写法。
**数据层**：`report_progress` 进 `happyMcpStdioBridge`（`open_preview` 就是现成先例）；`agentGuidance` 的对应指引同步给 codex/gemini。
**能力位取代 flavor 硬编码**：`supportsAttachments` 改读已存在的 `metadata.attachmentKinds`；`/btw`、Steer、即时模式一律改为「capability 存在即可用」（铁律 14）；flavor 只用于决定**默认能力集**，不再当门。ACP/OpenClaw 若无对应控制通道，就声明降级实现（答复排进下一轮），而不是不声明。
**`/btw` 的界**：铁律 18 的三件套是 Claude SDK 专属，所以 `/btw` 对其他 engine 的底线是「明说不支持」，不进四动作。
桌面/手机：同一张决策卡，engine 名作 mono chip 出现在卡头；不支持的动作留在原位、置灰并带一句为什么。

**竞品依据**：engine-agnostic 是竞品自己承认的赛道——Paseo 官网对比表列 `Providers: 4 native + 30+ ACP + custom` 对 `Claude Code, Codex`，右列正是 vh 的上游；Claude/Codex/Orca 都是单 provider 或以自家为主。

**我预设的反方与我的回应（无 reviewer 票）**：三条：①「Owner 自己 99% 用 Claude」——部分让步，附件与 `/btw` 已移出底线；但「四动作 + 一条队列行」是 T-02 自身的完整性条件，Owner 只要开过一个 Codex 会话，队列就会漏它。②「不同 engine 控制通道本来就不同，强行对等会造出假承诺（铁律 8）」——接受为设计约束，所以底线写的是「实现**或**明确降级」。③「T-14 已经覆盖」——不成立：T-14 能显示「不支持」，但 `report_progress` 缺失让非 Claude 会话在看板上**根本不产生行**。

> **需要你裁**：是否把「四动作 + 一条队列行」定为**接新 engine 的准入门槛**（以后接一个 engine 就要付这份成本，付不起就不接）；还是只承诺「显式说明不支持」，接受队列在非 Claude 会话上留洞。

### T-17 · 待发消息是会话的属性，不是这个浏览器的属性
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` T-02 / T-03 ｜ `backlog` 扩展 B-244/B-231/B-234/B-240；**显式推翻 `specs/2026-08-queued-message-controls.md` 两条非目标**；沿用 B-265 的 restore-first gate

**问题**：现状比草稿写的更糟，草稿的失败模式是错的必须改：纯文本队列**不会**因刷新丢失（`sync/persistence.ts` 的 `queued-messages-v1` 落 MMKV，spec 验收项就写了「刷新后仍存在」），但**释放状态机整个跑在浏览器里**——`screens/session/queuedMessages.ts` 的 `advanceQueueDeliveryPhase(phase, isWorking)` 与 `canReleaseQueuedMessage` 由挂载中的 `AgentInput` 驱动。于是手机上排的下一步既不投递、也不对其他设备可见；等几小时后重新打开那个 tab，它会在 turn 空闲时**自动发出去**，打在一个模式、工作树甚至进程都已经变了的会话上。**这是静默迟发，比丢失更坏。** 附件项确实会丢（`persistableQueuedMessages` 过滤掉带附件的项），而「手机拍照 → 桌面继续」正是 Owner 的真实路径。相关 spec 非目标逐字写着「不做跨设备队列同步；队列明确属于创建它的浏览器」。

**提案**：①待发消息升级为**会话级服务端对象**：跨设备一致，可编辑/重排/删除，每条标注来源设备与时间（`来自手机 · 3m`），关闭标签页不影响，**释放由 wrapper 在 turn 结束时执行**。明写唯一性：服务端对象是唯一排序权威，CLI 的 `MessageQueue2` 降级为执行侧；寻址与取消复用 B-240 已上线的 `localKey`/`sourceId` + `cancelQueuedMessage`。归档会话保持 B-265 的「先恢复再释放」语义。②**删掉**草稿的「发送=排队 / 发送=插入当前轮，记忆到账号」——让 Enter 的含义按账号偏好漂移，正是 `dontAsk`/yolo 那一类隐藏持久模式的事故模型（铁律 14）。正确形状：**默认永远排队**，Steer 是每条待发消息上的**显式动作**，`⌘/Ctrl+Enter` 降为写在 tooltip 里的加速键。③**陈旧性规则**（跨设备的必要配套）：会话重启、模式变更、被收起或 turn 身份变化后，待发条目转为「需确认」而不是盲发；排队超过 N 分钟未释放同理，降级成 T-02 队列里的一条待确认项；释放前显示它将进入哪个 turn。④**附件必须表态**：入队即上传拿 id，否则本条只覆盖纯文本，并在跨设备条目上显式标「附件仅在原设备」。⑤手机形态：不常驻占 composer 高度，折叠成一行摘要「已排 2 条 · 来自手机」，点开成 sheet。⑥改名「待发消息」，避免与 T-02 的「决策队列」同词。⑦草稿里「agent 正等权限时发消息 = 先拒绝那条权限再送进同一轮」拆出去并入 T-03b。

**竞品依据**：Codex 的 queued prompts 从 iOS 与 host 同步、手机切后台也照发，队列条目在 composer 上方可编辑/重排/删除；Claude RC 的 mid-turn prompts 从任一设备排队并留在 transcript。

**被挑战与让步**：6 票里只有 1 票推翻，但两票 keep 各带一处必须改的事实错误，都已吃进（问题陈述重写）。推翻票三条接受两条：「记忆型 send 模式是给 Enter 加一个看不见的隐藏模式」（删除该半条）、「缺陈旧性模型 + 与 T-02 同词」（补规则并改名）。部分接受一条：「B-240 的 durable 路径已经有 localKey/sourceId + cancelQueuedMessage」——那条链路解决的是**已投递**消息的取消，未发送队列的排序权威与释放时机仍然无归属；正确说法是复用它的寻址与取消语义而不是从零造对象，但 wire/server 确实要新增持久字段。

> **需要你裁**：**显式推翻 `specs/2026-08-queued-message-controls.md` 的两条非目标**（不做跨设备队列同步；Server/wire 不新增持久字段）。新论据不是「跨设备很方便」，而是「释放逻辑在客户端 → 指令可以延迟数小时打到已经变了的仓库上」。
> **A（推荐）**：批准，先出 spec 再实现（wire 新字段 + server 持久 + wrapper 侧释放 + web 退化为视图，附件走入队即上传）。代价：跨包改动与一次兼容矩阵。
> **B**：不动协议，只在现有本地队列上加「离开这台设备就作废」的诚实标注与到期清除。代价：手机→桌面这条你每天走的路径永远断。

### T-08 · 手机常驻注意力入口（T-08a）与 PWA OS 角标（T-08b）
`horizon` NOW ｜ `判定` 拆分 ｜ `依赖` T-01 / T-02 / T-03 ｜ `backlog` 以新论据复活 B-046 的最小形态；受 B-041 约束不新增设置位；终端页形态受 B-255/B-256 底栏约束

**问题**：结构缺口属实且可代码证实：`screens/AppLayout.tsx` 手机分支只有「根＝Sidebar / 其余＝Outlet」，没有任何常驻入口；`NotificationBell` 只挂在 Sidebar footer 与桌面折叠 rail——**详情页、终端页到不了待决入口**（B-046 以「Owner 两周未再提」dropped，本条论据不同：诉求不是详情页要有铃铛，而是**决定要能不返回就做完**）。OS 级角标是零实现：全仓 `setAppBadge`/`clearAppBadge` 零命中，今天只有 tab 标题的 `(N)`/`(!)` 前缀与铃铛的内存计数。草稿另两处必须修掉：推送并不落在「会话底部而不是要决定的地方」——`public/push-sw.js` 深链到 `/session/<id>`，`PermissionCard` 就在 transcript 末尾，真实代价是为一个 y/n 要把整屏会话拉起来（那是 T-03 的职责）。

**提案**：
**T-08a 常驻注意力入口**（本条唯一的结构增量）：所有手机路由常驻一个注意力芯片——ink/mono 计数，**不占 teal**（计数不是 live）；点击从底部升起 T-02 的队列 sheet，在 sheet 内展开 T-03 决策卡、办完自动前进；计数为 0 时降为极淡轮廓。**终端页让位**：底部已被快捷键位栏 + 自研 Web 键盘 + safe-area 占满（B-255/B-256），终端页改为 header 内计数，不压拇指区。不新增路由、不新增 tab bar、不新增设置位。桌面不出现（侧栏常驻已解决）。
**T-08b PWA OS 角标**：`navigator.setAppBadge(n)`，n = T-01 词表里的「等你决策」条数（不是全部未读）；处理完立即 `clearAppBadge`；iOS 仅在装到主屏后可用，未装/不支持静默降级为现有 tab 标题前缀。全新建，不依赖 T-08a。
**明确不属于本条**：推送深链落在决策卡 → T-06；拇指区大按钮、办完自动前进 → T-03；未读计数跨设备一致 → T-04；手机根导航是列表还是队列 → 由 T-02 那一刀一次裁完。

**竞品依据**：Orca 手机首页是真正的 fleet 页 + Dock badge 镜像未读；Codex iOS Priority view 把 running / unread / awaiting 顶到最上；OpenClaw 把 pending approvals 做成 sidebar 之上的 attention chip。

**被挑战与让步**：5/6 判定「这不是一条 item，是一张选票加一段已经写在 T-02/T-03/T-06 的共识」——接受：删掉三条重复共识与 A/B/C 三选一，只留两件真正无主的事并拆成 a/b。接受「A 案自称不与终端底栏打架站不住」（B-255/B-256 已占满底栏）。接受「PWA 角标不是改口径而是从零新建」的更正。唯一不接受的反驳是「到达路径是推送不是导航，所以常驻入口无价值」：推送要用户先允许通知、iOS PWA 还常年失效，而「已经在应用里、想看看还欠谁一个决定」是每天几十次的动作。

> **需要你裁（从属于第 1 刀，不是独立的一刀）**：触屏设备的 `localSettings.sidebarView` 默认值要不要从 `'list'` 改成 `'status'`（一行默认值，`localSettings.ts:188`，该偏好已存在且是设备级）。**先答第 1 刀**：
> **若第 1 刀选 A（队列 = 侧栏「状态」镜头）→ 随之改（推荐）**：否则 A 的核心卖点「手机上天然是根页」在手机上直接落空，队列仍不是默认镜头。代价：你 8 条终端并行时最常用的手动排序列表退到第二眼。
> **若第 1 刀选 B（队列 = `/board` Lifecycle 页）→ 不改**：那时手机入口本来就靠 T-08a 的芯片提供，改这个默认值没有意义。
> （原稿把这条写成一条独立且推荐「不改」的刀，与第 1 刀的推荐 A 互相抵消，已改为从属选项。）

### T-07 · 终端里的 claude：把已经渲染出来的问题变成可点的答案（不做屏幕解析）
`horizon` NOW ｜ `判定` 保留（重写）｜ `依赖` T-02 / T-03 ｜ `backlog` 扩展 B-105 / B-107（`mirror-terminal-send`）/ B-271；复用 B-100/B-229 的 `AskUserQuestionOptions`

**问题**：原稿的问题陈述有一半被代码证伪，已修：镜像今天**能**读到 AskUserQuestion / plan 选项（transcript 里是 tool_use，`ToolView.tsx` 用 `AskUserQuestionOptions` 渲染），也**能**被回答（B-107 的 `MirrorInputBar` → `mirror-terminal-send`，手机上打字即可）。真正缺的是两件：①那些选项按钮是死的（`ToolView.tsx:346` `disabled={… || !pendingRequestId}`），要答只能改用底部自由文本；②终端 agentState 是四值枚举（`sync/ops.ts:845`），队列与看板只能亮灯，说不出「在问什么」。另有一处环境事实：本机 ps 实测 7–8 个手敲 claude 全带 `--dangerously-skip-permissions`，**TUI 权限对话框对这位 Owner 基本不发生**——原稿引的四条权限审批竞品证据打偏，本条价值实际落在 AskUserQuestion / ExitPlanMode / 编号选择。

**提案**：读侧只认结构化源，写侧只做「把人本来会按的那个键送进 pane」，分两层。
**第一层（本批）**：镜像会话里 AskUserQuestion / ExitPlanMode 的选项按钮变活，桌面与手机同一张卡（T-03 组件），在 T-02 队列里展开即这张卡，**不必打开 xterm、不必打字**。点击链路：daemon 先 capture-pane 重新核对对话框指纹（同一问题、同一选项集）仍在 → 才发对应按键（`webTerminal.write` 正在为 xterm 面写原始键，`sendKeysEncoding.ts` 是现成编码器，**不要用 bracketed paste 冒充按键**）→ 指纹不匹配返回 `dialog-changed`，卡上直说「终端那边已经变了，请刷新」，**绝不投递**。成功后按钮置灰标「已送进终端 · <选项>」。解析不到结构化问题时不给按钮，沿用现有 MirrorBanner + MirrorInputBar 自由文本。
**第二层（结构化正解，见裁决）**：镜像本来就靠 `install-terminal-hooks` 存在——让手敲 claude 的 PreToolUse / Notification 走同一 hook 通道，把权限与 plan 上报成真的 `agentState.requests`，由 T-03 的同一张卡作答，零解析零合成按键。边界要诚实：hook 能替 PreToolUse 返回 allow/deny，但**给不了 AskUserQuestion 的答案**，所以第二层不能取代第一层。
硬边界：不新增「最后一屏问题块 + y/n 选项」解析器（classifyPane 是刻意粗糙的四态降级信号，且 tmux 输出按版本/locale 被 munge，铁律 19）。

**竞品依据**：Orca 的 worker contract 明写 worker 要用结构化 `ask` 而不是 local TUI prompt——与「别解析屏幕」是同一判断；反面是 Orca 手机端「approvals are text, not decisions」。

**被挑战与让步**：4/6 推翻。①「已经能被回答」——属实，已删掉被证伪的两句。②「读侧靠 capture-pane 猜是 terminal-as-truth 反模式，猜错一次＝替人按了别的选项」——完全接受，改为只消费 transcript 里已有的结构化问题。③「写侧 bracketed paste 不等价于按键」——接受，改成显式按键通道 + 发送前指纹重校验。④「本机全是 skip-permissions，权限卡是伪需求」——自己核实属实，价值论证已改写。⑤「应整体撤下、改走 hook 上报」——部分让步：hook 路线写成第二层并交裁决。⑥「队列不完整」这个必要性论证已删（board 与通知早就含终端 needs_input）。

> **需要你裁**：要不要为「手敲的 claude」扩 terminal-hooks 契约（PreToolUse/Notification → 真 `agentState.requests`）。
> **做**：权限与 plan 从此有权威源，T-03 原样复用，零屏幕解析。代价：动用户 `~/.claude/settings.json` 的 hook 契约，并新增一个「谁在替我批」的执法面（铁律 14 的老坑区）。
> **不做**：终端里的 claude 永远只有「点选已渲染的问题」这一档，权限类永远只能切回终端（而你现在几乎全跑 skip-permissions，代价很小）。
> 推荐：本批只做第一层，第二层等 T-14 落地后再评估。

### T-16 · 起活：「在哪里跑」控件（并入 T-21）+ 预填深链（并入 T-37）
`horizon` NOW（a）/ NEXT（b）｜ `判定` 拆分 ｜ `依赖` **T-16a：无**（与 T-21「投影」半条**同批**，不是先后依赖——原稿 T-16 `依赖 T-21`、T-21 `依赖 T-16` 成环，已解开）／ T-16b：T-37 ｜ `backlog` T-16a = B-042 的完整形态 + 接线已有的 `settings.recentMachinePaths`；顺带清理零消费者的 `utils/worktree.ts`

**问题**：核实后要削掉草稿的夸大：新建**会话**确实只有手工维护的 preset chip（`NewSessionModal.tsx:54`）+ 自由文本路径输入，没有目录浏览器（`FsBrowser` 只装在 NewTerminalModal / WebTerminalScreen / Files 上），也没有最近目录建议——而数据其实**已经存在且账号同步**（`sync/settings.ts:52` `recentMachinePaths`，最近 10 条），只被 `utils/quickChat.ts` 用来决定「跳不跳对话框」，`NewSessionModal` 只写不读。产品对 worktree/分支一无所知：`utils/worktree.ts` 在 web 里**零消费者**。草稿的「一天起 5–10 个会话」在三份取证底图里没有出处，删掉；可核验的表述是：Owner 的开发流程契约是 worktree-per-item（AGENTS.md），而产品今天只认一个 cwd 字符串。

**提案**：
**T-16a「在哪里跑」控件（与 T-21 合并，NOW）**：新建会话/终端的目标选择，行单位不是路径字符串而是 **checkout**——`repo · 分支/worktree · 有无未提交改动 · n 个会话在这`。数据来自 daemon 上报（仓库根、`git worktree list`、当前分支、脏状态；**按需探测，不做整机扫盘**），按最近使用排序、可模糊搜索（手机上模糊搜索是默认，手输降为兜底）；「任意目录」保留为兜底行，手输与 `FsBrowser` 不删。「n 个会话在这」是本条唯一不能靠输入法记忆解决的问题（并行 agent 不能踩同一个 checkout），可由 `sidebarWorkspaceGroups` 的 machine+cwd 分组现成派生。同时吸收原 T-18 的机器可用性四校验：行上直接显示该机器在线 / CLI 可用 / Claude 已登录 / 目标目录存在，**让这个控件永不提供打不开的目标**。
**T-16b 预填深链（并入 T-37，NEXT）**：`veryhappy.dev/new?machine=&dir=&branch=&agent=&prompt=` 只预填不自动发送 + 会话/终端页「复制深链」。今天**没有生产者**（`docs/channels.md` 入站只有 CLI spawn/send 与 MCP，web 全域只有 oauth 与 `?panel=` 在读 searchParams），Owner 手打这个 URL 比按「+」还慢；它只有和 T-37 一起定义允许名单、作用域与鉴权才成立。

**竞品依据**：Codex 新任务 = 选已连接电脑 → 项目 → Local/worktree + 分支 → 模型，Search chats 连分支名一起匹配；Orca Create Workspace 的 Repository combobox 在无匹配时给「Create worktree」行。

**被挑战与让步**：三票推翻，两条全盘接受：①「同一个控件设计两遍」——T-16 自己列的行内容根本就是 worktree 数据，先按目录做 now、再在 T-21 改成 checkout 是明知要返工，故 T-16a 与 T-21 的**投影半条同批交付于 now**（两者互不依赖，T-21 的生命周期半条才留在 NEXT——原稿把两条写成互相依赖，是个环，已解开）；②「深链今天没有生产者」——接受，移出 now 并入 T-37。③「事实夸大：不是必须手输目录」——已改写。不接受的一条：「New chat 快速路径已经零输入」——快速路径只复用最近 1 条且要求该机器在线，第二个及以后的目标仍然回到手工 chip / 手输，而且它对 worktree 永远看不见。

> **需要你裁**：**T-16 / T-21 合并后的唯一一刀，覆盖原 §5 第 19 与第 26 条**（那两条本来就是同一个决定，而且推荐互斥：19 让产品创建 worktree、26 说产品不创建——已统一）。两问一次答：
> **① 创建**：**a** 默认隔离（每个新会话自动开 worktree，选 base ref，仓库根声明 setup/teardown）／ **b（推荐）产品拥有创建，但作为非默认选项**——「运行位置」= `当前 checkout`（默认）/ `已有 worktree`（T-16a 的发现式选择器）/ `新建 worktree（从 <base>）`，分支名预填 `b-<id>-<slug>`、落点沿用 `.claude/worktrees/`，配「n 个会话在这」的显式撞车拦截 ／ **c** 产品不创建，需要新树时只给「在这台机器开终端并预填 `git worktree add …`」。
> **② 删除**：**d（推荐）**只在工作区视图里一个显式「清理这个 worktree」动作，有未提交/未推送时**阻止**而不是警告 ／ **e** 产品完全不拥有删除。**无论怎么选，删除永不挂在关闭/归档路径上**（B-149 前科）。
> 推荐 **b + d**。b 的代价：产品成为第二条创建路径，与你 harness 的 EnterWorktree 并存——所以它必须是非默认选项、且命名与落点沿用仓库既有约定（接线前先替换 `utils/worktree.ts` 的随机词表与 `.dev/worktree` 落点）。a 的代价：每次起活多一次拷贝与 setup，且 worktree 不隔离数据库/端口/凭据（Orca 被第三方指出的坑）。c 的代价：手机上开新事项永远多一步。

### T-19 · 工作记忆先落地（a），任务对象升级已有的 BoardTask（b）
`horizon` NOW（a）/ NEXT（b）｜ `判定` 拆分 ｜ `依赖` T-21 / T-09 ｜ `backlog` 扩展 B-208 与 B-094 Notes（迁移）；升级 `vh.board-tasks.v1`；在「不新增 Workspace 表/RPC」这点上**遵守**而非推翻 `specs/2026-08-workspace-context.md`

**问题**：原文的前提「没有一个容器装当前这件事」被代码证伪：`sync/boardTasks.ts` + `boardTaskOps.ts` 的 KV `vh.board-tasks.v1` **已经是账号级任务表**（title/description/status/sessionIds[]/orderKey/墓碑/跨端 merge-on-409），`app/rowActions.ts:132` 的 `markSessionDone` 已经是「completedAt + kill-first 归档 + webhook」的完成动作。真正缺的是：这张表没有起点(base ref)、没有结构化产出、没有记忆，也不在主导航。记忆侧还有一条 in-house 反证：`~/.happy/assistant/memory/personal.md` 自 2026-08-13 起 **315 字节未动**、`journal/` 为空——**需要人逐条策展的记忆在这个 Owner 身上零积累**。

**提案**：
**T-19a 工作记忆（NOW）**：一份可编辑备忘落成**工作树里的文件**（默认 `.vh/WORKING.md`），字段=目标/已定决策/关键文件/未决问题/下一步/约束。选文件不选账号级 KV 的理由：随分支生死、agent 天然读得到、可进 git 复查，与 Owner 真实在用的载体（specs/、backlog）同类。Web 侧编辑器就是今天的 Notes（B-094）改绑：绑定目标从 session 升为 machine+worktree（无 worktree 时回落 B-208 已有的 machine+cwd key），既有 note 一次性迁移并提示，**禁止静默丢弃**。agent 只能往文件里追加「候选」块，人写的正文优先；**不做逐条采纳/否决队列**（那是再造一个要人清的收件箱）。注入必须可见：在该工作区起新会话时，首条是一张可折叠、可编辑、可删的上下文卡，**禁止隐藏前缀**。
**T-19b 任务对象（NEXT）**：不新建表——给 BoardTask 补 `baseRef` / `worktreePath` / `outcomeIds`；任务做成侧栏的**第四个镜头**（工作区 / 标签 / 不分组 / 任务），**不替换第一层**，无任务会话不产生「未归任务」伪组；任务页桌面三栏、手机=根列表 + 全屏分段视图，复用 `?panel=`；任务级「完成」= 对旗下会话扇出既有 `markSessionDone`（受铁律 16 约束、对活 wrapper 先提示），**不新增生命周期、不做定时自动归档**。

**竞品依据**：Paseo「organized around workspaces, not chats」；**关键的反向证据**：四家没有一家引入独立 task 表 + 需人工策展的记忆——它们的持久容器都是 checkout；记忆有先例的是 Cowork 可编辑记忆 / OpenClaw MEMORY.md，都是文件或自动摘要，不是候选审批流。

**被挑战与让步**：4 票推翻，六条反对：①比进程活得久的容器已经存在，叫 worktree+分支+PR，新建 Task 对象等于长期与 git 真相对账；②需要人采纳/否决的记忆在本仓已被证伪；③「侧栏第一层是任务」与 lifecycle spec 明确允许的「无任务会话」冲突，会把 attach 进来的 tmux、同事的 pane 挤成二等公民；④任务级归档撞铁律 16；⑤三栏任务页零手机形态；⑥条目自带 fallback 等于自证不是必要项。让步：接受①③④⑤全部，接受②的形式（记忆改成文件、去掉候选审批流）。**不让步的一点**：记忆本身不能只靠 T-09 outcome + T-10 recap 派生——那两条都是自动生成的过去时，而「已定的决策 / 约束 / 不要再试哪条路」是 Owner 只肯写一次、且必须能手改的东西。

> **需要你裁**：侧栏第一层是执行体还是任务？
> **A（推荐）**：保持执行体，任务只做第四个镜头 + 一个任务页。代价：任务始终是二等，「一个目标下多个执行体」的表达偏弱。
> **B**：第一层换成任务。代价：必然长出「未归任务」伪组（attach 的 tmux、同事终端、一次性 shell 都在那儿），IA 变更不可回退，且与 T-15 正在收敛的词汇正面打架。
> 推荐 A：本仓没有任何证据显示你今天需要在一个容器里并挂多个执行体（你的方法论是子代理，不是并列会话）。

### G-01 · 发版时刻：更新预算 + 可见的换版，而不是「点开推送先等 690 KB」
`horizon` NOW ｜ `判定` 保留 ｜ **`来源` critic 补齐 · 未经 6 票对抗评审** ｜ `依赖` T-02 / T-03 ｜ `backlog` **推翻 B-028 的现有口径**；收编 B-223（done）与 V-094 为一次「发版时刻」验收；触碰 B-285 门禁的读取点（已核实不破坏）

**问题**：登录用户在一次发版后打开 veryhappy.dev，进入认证界面前要先取 entry+vendor+css ≈100 KB，再取 `AppRoot` **590,599 字节**（压缩后传输量，2026-09-03 对线上 `AppRoot-BrBtMrpo-597d4764….js` 实测）。真因不是 precache：`vite.config.ts:110-112` 把 release SHA 拼进**每一个** chunk 文件名（`[name]-[hash]-<sha>`），所以每次发版全部资产 URL 都变，runtime `CacheFirst`（`very-happy-assets-v1`，maxEntries 180，单次构建就 134 个资产）必然 100% miss，`cleanupOutdatedCaches` 又只清 precache——「每次发版重下」没消失，只是从后台 precache 挪到了**前台首屏的阻塞路径**上。**B-028 的 todo 描述已过期**：`highlighter.ts` 早已改用 `shiki/core` 精细导入、`globPatterns` 已收敛，「shiki 全语言进 precache / 5.7MB」不再成立。另一半是换版动作本身：`staleBundleReload.ts` 在可见性边沿与 15 分钟轮询里**静默强制 reload**，`registerSW` 走 autoUpdate+skipWaiting，iOS PWA 卡 loading（B-223 已修但 V-094 自 2026-08-27 未清）。

**提案**：把「发版时刻」当成一个有预算、有可见状态的表面：
① **构建契约**——release SHA 只留在 entry（`index-*`）与 `__APP_VERSION__` 常量上，其余 chunk 用纯内容哈希，跨发版未变的 vendor/xterm/shiki/crypto 直接命中 CacheFirst。已核对：`scripts/changelog/check-release.mjs:33` 的正则只认 `/assets/index-…-<40hex>.js`，`staleBundleReload.ts` 的 `ENTRY_RE` 同样只认 entry，B-285 门禁与僵尸 bundle 自愈都不受影响；内容哈希在蓝绿双 slot 下反而更安全。
② **首屏预算写死并进门禁**——「登录 → 决策队列可交互」的压缩传输量 ≤200 KB；把 `AppRoot` 拆成「队列/决策卡」与「会话/终端/看板/设置」两段，crypto（939 KB raw / 300 KB gz）与 xterm 只在真用到时拉。
③ **换版可见**——桌面与手机同一行 mono：`新版本 <sha 前 7> 已就绪 · 现在换 / 稍后`；不用 teal。正在输入或正在读决策卡时**绝不夺焦**，改在下一次切页/回前台的空闲换；换版给确定性进度而不是白屏。
④ **卡住可诊断**——超时仍未接管则显示 `仍在旧版本 <sha>` + `强制换版` + `继续用旧版`，把 V-094 的 iOS 形态从「杀 app」变成一个按钮。
⑤ **验收合并**——F2/F3/V-094 合成一次「发版时刻」真机验收（蜂窝网 + iOS 主屏 PWA + 冷启动 + 后台唤醒各一遍），进发布 checklist 固定项。

**竞品依据**：四家都不在这条赛道上——桌面端是原生或 Electron，更新走 store 或安装器（Codex 实测 36 小时灰度、store 滞后、RN JS stall）。这正是论点本身：清单拒绝原生 App 的理由「零安装、永远最新的 PWA 是结构性优势」**只有在本条成立时才成立**。

**我预设的反方与我的回应（无 reviewer 票）**：三条：①「B-223 已 done、precache 已瘦身，剩下的只是验收」——不成立：precache 确实修了（据此推翻了 B-028 旧口径），但资产名带 release SHA 让 runtime 缓存每次发版全失效，是本次在 `vite.config.ts` 与线上资产名上核实的新事实；②「Owner 桌面常开，换版感知很弱」——**让步**：首屏预算的桌面收益是虚的，真收益全在手机蜂窝网从推送点进来的那一次，因此本条价值绑定 T-02/T-03 在手机上成立；③「动 chunk 命名会碰发布门禁和蓝绿」——不成立，门禁与自愈的读取点已逐个核对，均只解析 entry 名。

> **需要你裁**：chunk 文件名去掉 release SHA、只留内容哈希（entry 保留 SHA 以喂 B-285 门禁）——做还是不做。做，则「每次发版重下」结构性消失；不做，则本条只剩 ③④ 的体感修补。

### T-34 · 退役 `/assistant`：纯减法，不挂任何依赖
`horizon` NOW ｜ `判定` 保留（重写、删掉依赖）｜ `依赖` **无** ｜ `backlog` B-051 与 `specs/2026-08-voice-assistant.md` 回标 Retired；B-057 的 cleanup 债同批还清；V-022~026 / V-032~034 / V-040 判 dropped

**问题**：六票零推翻，证据是全清单里**唯一的实测零值**：`/assistant` 路由 + `screens/assistant/AssistantScreen.tsx`（777 行）+ 侧栏与 ⌘K 各一个入口；`assistantSkipPermissions` 默认 true（`sync/settings.ts:196`）；`isHiddenSession`（`assistant/assistantSession.ts:41`）在 sync、storage、通知 feed、⌘K、侧栏、看板、机器页**七处**把它从所有出口过滤；CLI 侧 `assistant/assistantTools.ts` 注册 11 个 variant 工具；V-022~026 / V-032~034 / V-040 **九项真机验证自 2026-08-13 挂在 verify-queue**。使用量：9 份 JSONL 全在 8-13、`memory/personal.md` 至今 315 字节种子、journal 空、8-24 起 1318 个 daemon 日志 0 条记录。两处修正：①「最难审计」是夸大（隐藏会话按设计仍可由 `/session/<id>` 直达）；②方向冲突必须一并处理——`docs/roadmap.md` Next 第一条仍写「Make the meta-agent a dependable dispatcher…」，`docs/channels.md` 还把 Web Assistant 当成对外契约的一条入站路径。

**提案**：**无条件的纯减法，删掉 depends_on**（草稿写依赖 T-02/T-35 是因果倒置：正因为它零使用、零依赖，删它不需要任何替代品先落地；把一次安全清理挂在一个 XL 后面等于让「默认 skip permissions + 全出口隐藏」的组合再活几个月）。交付物：①删 `/assistant` 路由、`AssistantScreen.tsx`、侧栏与 ⌘K 入口、Settings → Voice & Assistant 里的助手机器选择与 `assistantSkipPermissions`；②删 CLI `assistantTools.ts` 的 11 个 variant 工具与 `[系统通报]` 汇报通道；③**保留 daemon 侧编排原语**——`POST /spawn-session` 的参数面、`HAPPY_SPAWNED_BY` + `/session-event`：删的是 UI 与 variant 工具面，不是原语（G-04 的 `reportTo` 要用它）；④`isHiddenSession` 不按字面「取消隐藏」——它今天是 `assistant ∪ mirror`，assistant 分支随页面消失、**mirror 继续隐藏**；不给尚不存在的 bot 预留侧栏行，也不引入身份色；⑤同批改文档：`docs/channels.md` 删「Inbound Web Assistant / meta-agent」节与 MCP 能力矩阵那一行，`docs/roadmap.md` Next 从「让 meta-agent 成为可靠调度器」改成「编排以工具面进入普通会话」；⑥同批把九项 V-xxx 判为 dropped（**直接减 9 项待验**）。与 T-20 的减法批次合并执行。

**竞品依据**：Paseo **没有独立 dispatcher 页面**，编排是注入每个 agent 的 MCP 工具 + 三个 skill；Orca 同样没有 meta-assistant chat；Cowork Dispatch 的单线程调度线程被列为反模式。

**被挑战与让步**：0/6 推翻，但六票都要求改形状，全部吃进：①depends_on 倒置（已删依赖，horizon 提到 now）；②「bot 会话不再隐藏是减法条目里夹带的加法，且按字面删过滤会连坐 terminal-mirror」（核实属实：`isHiddenSession = isAssistantSession ∪ isMirrorSession`）；③身份色违反设计语言（已删）；④「最难审计」说过头（已修正）；⑤「语音降级为 composer 麦克风是把删掉的表面换个位置长回来」（升格为下方裁决）；⑥「不说 `src/assistant` 下 20+ 模块与九项待验怎么办」（已核实并写进裁决）。

> **需要你裁**：语音链的去留（必须和删页面同刀裁，否则会留下一个无人调用的子系统 + 九项挂着的验证债）。已核实：`src/assistant/` 下的 asrStream / ttsQueue / ttsPlayer / ttsStream / earcons / iosAudioUnlock / recorderMachine / useHoldToTalk 等 20+ 模块，除 `assistantSession.ts` 的两个谓词外**无任何外部消费者**。
> **A（推荐）**：整条删掉，含 ElevenLabs STT/TTS 链路与相关服务端 key 面；手机听写走系统键盘。代价：将来要语音得重做。
> **B**：把按住说话挂到普通 composer 当输入法、TTS 降为可选朗读。代价：把刚删掉的表面换个位置长回来，并继续背 V-022~026 那批验证项。

### T-20 · 减法改成一条常设纪律（一进一出）+ `/todos` 单独裁决
`horizon` NOW ｜ `判定` 拆分 ｜ `依赖` **无**（原文依赖 T-02/T-19 是依赖倒置，已解除）｜ `backlog` B-041 退回 backlog 执行；B-007 / `specs/2026-08-todo-provider.md` + V-073/V-074

**问题**：原条目里最硬的一刀被事实证伪：mac-office 的 `~/.happy/settings.json` 里 `todoProvider` **已配置**，指向 Owner 自己的 `happy-todo-provider.py`（不是仓库示例），所以「/todos 无消费者、可删」不成立。另三刀（Notes dock、剪贴板历史、board Tasks 泳道）唯一的删除理由是「Paseo/Orca/Claude/Codex 都没有这个表面」——这是**反向 cargo-cult**，且零使用量证据；本仓唯一有硬使用量证据的是 `/assistant`，那条已单列 T-34。剩下成立的只有一句：表面数已超过单人验证带宽。

**提案**：
**T-20a 减法纪律（规则不是功能）**：写进 `docs/PROCESS.md` 与 `docs/design-language.md`——任何新表面上线，必须在自己的 spec/条目里**指名它取代或吸收了哪个旧表面**并给出数据迁移步骤（KV key 迁移 + 一次性提示，禁止静默丢弃），否则不许合并。本清单里每一条要新增表面的条目（T-19b 任务页、T-22 的 PR 区块、T-02 的队列）都按这条填一栏，评审时一起看净预算：本轮删除表面数 ≥ 新增表面数。
**T-20b `/todos` 的处置**：**不删路由、改成队列的一个来源**——面板保留，条目可进 T-02 队列并带来源标记，agent 能读到当前 todo 列表（今天 agent 对它完全不可见，这才是它孤立的真因）；同批按 verify-queue 纪律把 V-073/V-074 验掉。
明确不做：删 Notes（跟随 T-19a 的记忆迁移一起裁）；删剪贴板历史面板（它是 `copy_to_clipboard` 的 agent→人出口）；删 board Tasks 泳道（T-19b 正要升级的就是它，两条自相矛盾）。

**竞品依据**：四家都没有 notes/todo/board 表面，但它们都是面向多人的产品——「别人没有」不能证明「他少了会更好」。真正可移植的是**反面教训**：Codex 把编码工作台塞进三模式超级 app 造成「我的项目去哪了」；Orca 注意力分散在 5 个表面、3 个藏在 Experimental 后面——这两条支持的是「一进一出」的纪律，不是一次性删表面。

**被挑战与让步**：4 票推翻，五条全部接受：①五个不同性质的删除捆成一票；②依赖倒置；③三刀的唯一理由是 cargo-cult 且无零使用证据；④`/todos` 是 `docs/channels.md` 的对外入站契约 + spec + CLI 示例 provider，删路由不等于删契约；⑤「减少验证带宽」是产能论证。追加一条 reviewer 没查到的事实：`todoProvider` 在 Owner 机器上是真配置的。唯一保留的分歧：不接受「减法整条降级为评审规则就够了」——规则没有执行时刻，所以 T-20a 是规则，T-20b 是这一批就要落的一次具体裁决。

> **需要你裁**：`/todos` 二选一。
> **A（推荐）**：修——面板保留，条目成为 T-02 队列的一个来源，agent 可读，同批验掉 V-073/074。代价：多维护一个入站契约面。
> **B**：下线 `/todos` 路由，保留 CLI 侧 `todoProvider` 契约与 `docs/channels.md` 段落，V-073/074 随路由注销。代价：砍掉你非 vh 的那半日程在 vh 里的可见性——而 provider 是你自己写的脚本，说明你曾真的要这个。
> 推荐 A：配置这一动作已经是使用意图的硬证据；若两周内你仍不打开该面板，再按 B 下线。

### G-04 · 现在只加两个字段：队列条目的 `author`，与 `spawnedBy → reportTo`
`horizon` NOW ｜ `判定` 保留（重写）｜ **`来源` critic 补齐 · 未经 6 票对抗评审** ｜ `依赖` T-02 ｜ `backlog` 承接 T-35/T-36 被推翻后无人认领的最小部分；复用已有 `spawnedBy` / `HAPPY_SPAWNED_BY` / `/session-event` / `assistantReport.ts` 骨架与 `variant` 自由字符串

**问题**：清单保留 T-34（退役 `/assistant`）而 T-35/T-36 全被推翻，等于**删掉唯一编排面且不留任何接口**；`workflow-layer §5` 列的五个缺口（账号级读取面、事件订阅、outcome、出口、角色模型）只剩 outcome（T-09）被保留。Owner 明说未来方向是幕僚长 / 角色 bot / 可能自做 harness——如果队列（T-02）以「只有人能写、行没有作者」的形状落地，那第一次想让 bot 写一行时只剩两条路：再长一个 `/assistant`，或迁移全部已有条目并改所有渲染点。本条不主张现在做 bot，只主张现在别把门焊死。

**提案**：只落两个字段，零新表面。
- **队列/看板条目加 `author`**：`user` / `machine:<name>` / `bot:<name>`。渲染上只是行首一个 mono 前缀 + 一个筛选位；语义上它是「这行不是我写的」的唯一抓手，也是将来审计非人写入的唯一入口。默认全是 `user`，今天看不出任何区别——**这正是它便宜的原因**。
- **`spawnedBy` 泛化成 `reportTo`**：`spawnedBy` 今天已经是自由字符串（`daemon/controlServer.ts:121/208`、`claude/session.ts:224` 读 `HAPPY_SPAWNED_BY`），且已有完整回报骨架「被派会话 → `/session-event` → `assistantReport.ts` sink」，只是 sink 硬绑在助手上、且只覆盖 `spawnedBy === 'assistant'`。改成「回报目标 session id / role」，任意会话（将来是任意 bot）就能收到它派出去的会话的完成与需输入事件，不需要新协议。
- **明确不做**：角色花名册、人设文件、bot 群聊、`@session` 同级互发、bot 页面、bot 创建 bot。
桌面/手机：今天什么都看不到（全是 `user`）。这是设计意图，不是遗漏。

**竞品依据**：反面证据最有力——Orca 的编排账本只有 CLI、人看不见，「协调只存在于模型上下文里」；正面是 adjacent 的恒量「promote, don't author」：bot 的产出应落进人已有的收件箱，而「可被写入」在数据模型上就是 `author`。

**我预设的反方与我的回应（无 reviewer 票）**：三条：①「为未来做功」——**部分让步**，判断标准很具体：若你认为「未来一年不会有任何非人写入队列」，本条应当被裁，我不辩；②「T-34 若被一并裁掉，本条悬空」——不成立，本条不依赖 T-34，只依赖 T-02；③「加了 `author` 会诱使后面的人真去做 bot 写入」——接受为约束，所以写死「`author` 只是渲染前缀 + 筛选位，不附带任何写入通道」。

> **需要你裁**：现在就把 `author` 写进队列条目的数据模型（与 T-02 一起落，成本约等于零），还是等真有 bot 时再加（届时要迁移已有条目并改所有渲染点）——只需要这一个是/否。

---

## NEXT

### T-22 · PR / CI 事实上行到行与队列，失败带闸门地入队交回，合并后人点一次收摊
`horizon` NEXT ｜ `判定` 保留（重写、大幅收窄）｜ `依赖` T-02 / T-21（软）｜ `backlog` 无对应 id；复用 `app/rowActions.ts` 的 `markSessionDone`、`sync/ops.ts` 的 `machineBash`（**注意它今天被 `validatePath` 锁在 daemon 进程 cwd 子树内，作用域放宽与 T-11 是同一件事**）、`sync/gitStatusSync.ts`

**问题**：核实为零重复：web 侧 GitHub 只有账号绑定（`sync/apiGithub.ts` + Settings 连接/断开），没有任何 PR/checks 数据面；`packages/happy-cli/src` 无 gh/PR 相关代码；backlog 无对应 id。今天**两套完成态并存**——产品里是人点 ✓，现实里是 PR 合了 / CI 绿了——对账成本全落在你头上；你成批 land PR 靠 `scripts/land-pr.sh` + 反复 `gh run view`，铁律 10 还要求 push 后 ≥20s 再核 headSha，也就是「CI 变红了没有」今天只能由你自己去问。收摊侧的链路其实已经齐了：`markSessionDone`（completedAt + kill-first 归档 + webhook）只缺一个客观触发源。

**提案**：收窄到「事实 + 一张失败卡 + 一次收摊」，钉死四条硬约束。
- **数据源**：daemon 侧只读 `gh` 的 REST 子集（`gh pr checks` / `gh api repos/…/pulls`）轮询后**推送**进既有状态流；不新增 web 轮询循环（`sync/terminalAgentState.ts` 已写明「不许出现第二个竞争轮询」），不用可能超 30s 的同步 RPC（铁律 17 的 30s 上限，超时的活走「即返 id + 轮询」，B-283 先例）。review threads 这类 GraphQL 内容**先不做**：mac-office 的 token 缺 `read:org`，`gh pr edit` 已实测报 scope 错。
- **行/卡**：一行中性 mono 事实 `#158 · checks ✗ 2m`。着色只用 `--warn` / `--danger`，**teal 不参与**（已合并的 PR 不是 live）；绿 ✓ chip 不做，成功态就是普通文本。
- **失败入队有闸门**（这是它不退化成 CI 通知流的关键）：只有「当前分支有开着的 PR 且这条会话推过」才自动生成一条决策卡；**同一 PR 同一 head SHA 只入一次**，重跑/flaky 不重复铸条目；卡上带「等它绿，别再叫我」。卡内容 = 失败 check 名 + 日志尾部 + `交给它修 / 我自己看 / 忽略`，打包成 prompt 发给该会话，**不自动提交、不绕过门禁**。
- **收摊**：PR 合并/关闭 → 队列出现一条「已合并 · 收摊?」，**人点一次**，复用 `markSessionDone`，对活 wrapper 先提示（铁律 16）。**删掉「合并后 24h 自动收摊」设置**——默认关、后果不可见的定时开关正是 B-041 的病，而 B-177 已有「归档被自动翻回」的前科。
- **降级三态可见**：未装 gh / 未认证 / token 缺 scope 各给一行说明，**不隐藏区块**。
桌面/手机：行 chip + 队列条目是一等；PR 详情外链 GitHub。完整 PR 面板（含 review threads）拆为后续条目。作用域对 T-21 只是软依赖——有 worktree 用 worktree，没有就让 daemon 在 cwd 里 `git rev-parse --abbrev-ref HEAD`。

**竞品依据**：Paseo 的 PR 面板 checks failure-first 分组 + **一键把失败 check 日志附到 chat**；Orca 的 `Fix broken checks` 把 check 名与链接交给 agent；四家都把「失败日志一键交回 agent」做成同一个动作——这是本条最可移植的部分；四家的「自动归档」我们不抄，因为 vh 的归档带 kill-first 语义。

**被挑战与让步**：一票推翻：必要部分已被 T-01/T-02/T-03 吸收，多出来的是一个 GitHub 客户端表面；且 `land-pr.sh` 的合并语义（等 CI、识别 conflict 不触发 CI、按 head commit 找 run、behind 先 update-branch、合并重试）产品复刻不了，只会成为第二个要对账的真相源；「合并即收摊」是由外部状态触发的破坏性自动化；绿 ✓ chip 撞设计语言。另一票指出每个 PR 都跑门禁，flaky 与已知例外会天天铸队列条目，而队列的全部价值在于可清空。**让步**：全部接受——不做合并按钮、不做自动收摊、不做绿 chip、加 SHA 级去重闸门、PR 面板拆走。**不让步**：不接受「PR/CI 只改行状态、完全由人拉取」——你今天的痛点恰恰是**必须主动去问**；拉取模型等于把这段成本原样留在你身上。

> **需要你裁**：CI 失败是推送进队列，还是只改行状态、由你主动去看？
> **A（推荐）**：带闸门推送——只对「你推的、有开着 PR 的分支」入队，同一 head SHA 只叫一次，可对单个 PR 静音。代价：闸门条件写错时会漏叫。
> **B**：只改行状态，人显式说「这条等它绿」才入队。代价：回到今天的主动轮询，价值折半。
> 若想更保守：先按 A 上线但默认静音、只在行上显示，观察一周它一天铸几条再决定是否开推送。

### T-21 · worktree/分支：先把已同步却零消费的 git 事实渲染出来
`horizon` **投影半条 NOW（与 T-16a 同批交付——T-16 的让步里写的「horizon 拉到 now」指的就是这半条）／ 生命周期半条 NEXT**（本条排在 NEXT 段是按后者定位）｜ `判定` 保留（重写）｜ `依赖` **投影：无（与 T-16a 同批）；生命周期：T-16a + 本条投影**（原稿与 T-16 互指成环，已解开）｜ `backlog` 扩展并拆分 B-042（目录补全归 T-16，worktree 归本条，拆完即关）；分组 key delta 写进 B-208；前科 B-009 / B-149

**问题**：三处事实要修：①**不是「零管道」**——`sync/gitStatusSync.ts` 已按 `machineId:path` 同步 `GitStatus{branch,upstream,ahead,behind,stash,+/-}`，但 `storage.ts:1866/1873` 的 `useSessionGitStatus` / `useSessionGitStatusFiles` **全仓零消费者**，即数据同步了却没人渲染；②`utils/worktree.ts` 的 `createWorktree/listWorktrees` 存在但零调用点，且它把 worktree 固定塞 `.dev/worktree`、分支名用「形容词-名词」随机词表（如 clever-ocean），与你的 `.claude/worktrees/` + `b-xxx` 契约冲突，直接接线会造出你自己 runbook 不认识的树；③「他在终端里手工建 worktree」不准确——你的 agent harness 已有 EnterWorktree/ExitWorktree。所以必要性靠**显示、撞车防护、收摊**三件，不靠创建。

**提案**：分两半，前一半可先批准。
**投影（零新状态，先做）**：行/卡/工作区分组直接消费已有 gitStatus——在 worktree 里显示 `repo · branch`（+ahead/behind/dirty），否则显示路径，**规则化，不加 Appearance 开关**；侧栏分组 key 在有 worktree 时用 worktree 根而不是 cwd（写进 B-208 的 delta）；起活时若目标 checkout 已有活跃会话/终端，**在起活前拦一下**并显示是谁在那儿，不是事后提示。
**生命周期（有新状态，其次）**：新建时「运行位置」三态——当前 checkout / 已有 worktree（走 T-16 的发现式选择器）/ 新建 worktree（选 base ref）；分支名**预填** `b-<id>-<slug>` 可编辑，**不调模型**（git 里的名字是永久的，且你的分支名与 backlog id/PR 绑定）；worktree 落点沿用仓库既有约定（`.claude/worktrees/`），接线前先替换 `utils/worktree.ts` 的随机命名与 `.dev/worktree` 落点；setup 沿用已有的 `promptPresets` / `terminalStartupCommand`，**不引入 vh.json**。
**两个必须能渲染的失效态**：孤儿 worktree（会话没了树还在——本地十余个 8 月陈旧树就是存量）与树被删了会话还在（B-009 是这一类的真实事故）。
**删除永不挂在关闭/归档上**：只在工作区视图里一个显式「清理这个 worktree」动作，有未提交/未推送时**阻止**而不是警告（B-149「22 个终端无痕」的前科）。
手机：继承所在 worktree、可创建（纯 `git worktree add`，可逆）、**不提供删除**。

**竞品依据**：Claude Desktop 每 session 一个 worktree（`.claude/worktrees/`、branch prefix、`.worktreeinclude`、归档即删）；Orca 把 worktree 当工作单元本身，并被第三方指出「worktree 不隔离数据库、端口、凭据」——这条反证支持「setup 沿用已有 startup command 而不是新配置文件」。

**被挑战与让步**：两票推翻。「必要的一半已被 T-16 吸收，剩下的『产品拥有 worktree 生命周期』是照抄四家，而 north star 明确『需要完全控制时真终端一步之遥』；且『归档时删 worktree 与分支』是 UI 触发的不可逆 git 操作」——让步：删除动作从关闭/归档路径整体移出，创建这一半交给 T-16，B-042 拆完即关。**不让步**：`useSessionGitStatus` 零消费者是核实的新事实——一个已同步的机器事实至今没有出口；它同时是 T-22 把 PR 挂回行的作用域来源，必须独立可批准。

> **需要你裁**：**已并入 T-16 的那一刀**（§5 第 19 条：创建 a/b/c + 删除 d/e，推荐 b + d）。本条不再单独裁——原第 26 条与第 19 条是同一个决定，且两处推荐互相抵消（19 让产品建树、26 说产品不建树，26 自己的收尾又写「推荐 A + 把创建做成非默认的选项」，与 A 正文冲突），已统一为「**非默认的创建选项 + 仅工作区视图里的显式清理**」。

### T-25 · 「跑完停一下」：turn 结束不自动放行排队消息（不是第五个权限模式）
`horizon` NEXT ｜ `判定` 保留（重写）｜ `依赖` T-11 / T-17 ｜ `backlog` 扩展 `specs/2026-08-queued-message-controls.md`（B-234 shipped）的放行语义；渲染面复用 board lifecycle 的 waiting/idle

**问题**：原条目的前提是错的，必须先修：`components/modelModeOptions.ts:getClaudePermissionModes` 今天就是四档，`acceptEdits` 就是既有的中间档，「要么每个工具都问要么全放开」不成立；Claude 会话本来每个 turn 结束就停下等输入（全仓 grep 不到 autoContinue 任何命中），「跑完待收」也已经是 `boardItems.ts` 的 lifecycle waiting/idle。**vh 里唯一真实的跨 turn 连跑口子只有一个**：`specs/2026-08-queued-message-controls.md:14`「当前 turn 正常结束后，每个队列项独立开启一个后续 turn」——我还没读完这一轮的 diff，排队的下一条已经自己开跑了。另外 `newSessionReviewFirst`（`sync/localSettings.ts:178` 默认 true）已经占用了 review-first 语义，再造一个「Auto Review」是纯命名混淆。

**提案**：**不动模式选择器一个字**：出站仍只有 default/plan/acceptEdits/bypassPermissions 四个枚举，唯一清洗点 `normalizeClaudeOutboundMode` 不变（铁律 14）。新增的是会话/任务上的一个**布尔属性「看过之前不放行」**（默认关）：turn 正常结束时不释放队列首项，会话保持既有 waiting/idle 态，并在该条目上直接挂本轮累计变更摘要（`+x −y · n 文件`，点开即 T-11 的「最近一轮」镜头，可写 T-12 批注）。恢复动作只有一个：条目上的「继续」= 放行队列首项。
桌面：队列条目 + composer 上方一枚 mono 小标记 `hold`（中性 ink/text 阶，**禁止 teal**）。手机：同一张队列卡，「继续」是 ink/canvas 主 CTA。
硬边界：不改变轮内任何权限行为、不新增模式文案、不产生新的真相源；副文案只讲队列语义（「本轮结束后先等你，排队的 n 条不会自动开跑」），**一个字都不许讲权限**。

**竞品依据**：Paseo `Auto Review` 原文是 "stop after each assistant turn instead of running unattended"——它解决的是 Paseo 自己让 agent 无人值守连跑，vh 没有这个基线；Claude 的 Auto 是权限分类器不是停靠策略。两家的机制都不能整块搬过来。

**被挑战与让步**：**6/6 全票推翻**，两条全盘接受：①「第三档模式」在运行时上等于 bypassPermissions 加一个标签，安全增量为零，且只能由 web/relay 执法而 CLI 报告的仍是别的模式——正是骗了用户 5 次的同一形状；②「每轮停下」「置为待评审」今天都已经是既成事实。让步：撤掉模式档，改成队列 hold 属性。**不让步的一点**：多数 reviewer 主张「零增量，并进 T-02/T-11 即可」——不成立。队列自动放行是 vh 唯一的连跑路径，而 T-17 把队列升级为服务端对象时写的是「turn 结束由 wrapper 侧释放」，它让自动放行**更强**而不是可选；这个 hold 位没有任何其他条目覆盖，critic 也指出「T-25 丢 = T-11/T-12 的评审面没有触发器」。

> **需要你裁**：这条独立成条，还是作为 T-17 服务端队列对象上的一个字段落地？
> 推荐后者——它天然是队列属性，独立成条会诱使实现者又把它做成一档模式。**若 T-17 被裁掉，它必须独立存在**，否则 T-11 的累计 diff 面没有任何触发器。

### T-29 · 点 ✓ 之前有据可依：先真跑仓库自己的门禁命令，模型复核只在跑不了时兜底
`horizon` NEXT ｜ `判定` 保留（重写、换主形态）｜ `依赖` T-02 / T-09 / T-11 ｜ `backlog` 扩展既有 `boardAnalyzer` 车道（别开第三条 LLM 旁路）；与 B-283 共用三件套里的两件但**不 fork 主会话**

**问题**：「跑完 ≠ 完成、完成必须人点 ✓」是你写在 `workflow-layer §2.1` 的管理哲学，而点 ✓ 时手上只有印象——缺口成立。但原提案选错了形态：`/btw` 三件套是 `resume + forkSession`，**从被复核的那条会话 fork 出来的进程继承的正是同一段上下文与同一批误解**（漏跑测试、误读需求、把 mock 当实现），它不是独立证据而是同一个模型的第二次自评；它给出的「一致」贴在待收条目上、在手机上就是一枚让人更快点 ✓ 的**假绿灯**。而你的验收判据本来就是确定性的、写在 AGENTS.md 里的一张命令表（wire build+vitest / web vitest+build+tsc 零错误 / cli test+运行冒烟 / server tsc+vitest）。

**提案**：① T-09 的 `how_to_verify` **不写自然语言，写成一组可执行命令**（默认取仓库根声明的门禁命令）+ 一句「明确没跑的是什么」。②队列「跑完待收」条目上的动作是**「跑一遍验收」**：在该会话的 cwd/worktree 起一个短命执行体真跑这些命令，把命令、退出码与输出尾部贴在条目上（三态：通过 / 失败 / 未配置），结果不进主对话；失败自动变成一条「需要决定」条目，可一键交回原会话去修。outcome 里声称跑过却没有退出码的项显式标为「未证实」。③只有当改动跑不了命令（纯文档、设计、运维类）才回落模型复核，且必须是**干净上下文**：新建一次性旁路会话，输入只有 T-11 的累计 git diff + outcome 声明 + 目标描述，**不喂主会话 transcript**（仍用 `persistSession:false` + `disableAllHooks` + 显式 `claudeEnvVars`，但**不 fork 主会话**）；结论三档「有出入（列点）/ 无法判断 / 未见出入」，视觉权重按「有出入」呈现，**不允许渲染成通过态、不用 teal**。人仍是点 ✓ 的唯一主体。④这样不必给 `specs/2026-09-btw-side-question.md` 的「不持久化」非目标开例外——贴在条目上的是命令结果，不是模型结论。

**竞品依据**：OpenClaw 的完成 handoff 附带一条要求 requester 先验证再判定完成的 review instruction；四家共同的告诫是 "green ≠ done"——正确读法是「要更硬的证据」，不是「再叠一层模型意见」。

**被挑战与让步**：4/6 推翻。接受最硬的两条：fork 复核 = 自我批准，假绿灯比没有复核更糟；确定性命令的退出码比任何模型判词都硬。让步：主形态从「旁路模型判定」换成「真跑门禁命令」。修一处全稿都没写的事实：便宜模型看会话这条车道**其实已经存在**——daemon 的 `boardAnalyzer` 起一次性 haiku 写 `metadata.board.progress`；它 opt-in、只能在机器文件里开，**而你已经开了**（mac-office `~/.happy/settings.json` 的 `"boardLlm": true`）——所以「再开一条 LLM 旁路」是重复一条**正在生产跑**的车道，不是补一个没人用的空位（原稿写的「默认关 = 没人有」的失败模式论据已被实测证伪，删除）。不接受「how_to_verify 已在 T-09、本条被吸收」：T-09 只让 agent 自述，本条要的是**真跑一遍**。

> **需要你裁**：「跑一遍验收」在哪个执行体里跑？
> **A（推荐）**：在该会话的 worktree 里起一个短命进程——结果与改动同一现场，但必须遵守铁律 16，不能在原 session id 上开第二个 wrapper。
> **B**：交回原会话让它自己跑——省事，但那是「自己给自己判分」的另一种形式，还会污染上下文。

### T-27 · 拆两条：T-27a 常设授权可见可撤销（做）／ T-27b 决策记录降级为数据（不做页面）
`horizon` NEXT ｜ `判定` 拆分 ｜ `依赖` T-03 / T-14 / T-15 ｜ `backlog` 复活 B-263 dropped 理由里预留的 allowedTools 分支；`product-map §6.13` 记的缺口今天无 backlog id，落地需新开 B-id
> **与 G-05 的关系**：G-05 是本条 a 段的最小实现（只做「查看」+ 一行入口），排在 NOW；T-27a 是完整形态（含撤销 RPC 与三态标注）。两者不是重复。

**问题**：授予这一半已上线（`sessionAllow(..., allowedTools, 'approved_for_session')` + PermissionCard），查看与撤销为零，缺口成立。但原提案「每条可撤销、即刻生效」在机制上今天做不到，这个事实错误必须修：现代路径下 `approved_for_session` 是把 SDK 自己给的 `pending.suggestions` 作为 `updatedPermissions` 交回 SDK（`claude/utils/permissionHandler.ts:290-296`），**规则住在 Claude 进程里，vh 没有撤销通道**；只有 legacy 的 `response.allowTools` 才进 vh 自己的进程内 `allowedTools` Set，且 reset 时 `clear()`、不持久、不上行。也就是说今天「常设授权」的寿命 = wrapper 进程寿命，重启会话后自动清空。第二半的 `/decisions` 路由则是过度形状：数据其实已经在 `agentState.completedRequests`（tool/arguments/status/decision/mode/allowedTools/时间，`storageTypes.ts:138-148`），缺的是渲染而不是一个子系统。

**提案**：
**T-27a 授权可见可撤销（做）**：在会话真相面（T-14 的能力行）加一节「现在生效的授权」——逐条列出工具 / Bash 命令前缀 / 路径 + 授予时间 + 来源请求 + 作用域，值取 CLI 报告，未确认时按三态标注（已生效 / 切换中 / 未确认+原因）。**撤销诚实分两种**：vh 自己持有的（legacy allowTools / bash 前缀）→ 新增一条 session RPC 即刻移除，受铁律 17 约束（旧 daemon 无该 RPC 时按钮禁用并写明原因，不得静默失败）；SDK 持有的 suggestions → 文案写成「移除并重启执行体」（复用 T-15 的 Restart）或「全部清空（需重启）」。写死：作用域 = 本 wrapper 生命周期，**重启后消失是设计不是 bug**；不做项目级/跨会话策略模板。
**T-27b 决策记录（降级为数据，不做页面）**：**不新增 `/decisions` 这第 15 个表面**。每条决定（时间、类型、请求摘要、决定、决定者：人 / 自动放行车道 / bot、可选理由）写进已有事件流，回看位置只有两处：该条目/会话时间线上的一行，与 T-02 队列的「今天已办」段（可按会话/机器/工具过滤）。agent 要查「这类事你上次怎么决定」时给一个**只读查询工具**，不是一个人去逛的账本；保留期与导出不做。

**竞品依据**：Claude 定时任务会积累一个 Always-allowed 清单并可在任务页审阅与撤销——注意它的作用域是「任务」，与 vh 的 wrapper 生命周期不同，不能照抄成「跨会话策略」；反例 Orca：所有 CLI 预置 bypass flag，有完整 ledger 却没有人类可见视图。

**被挑战与让步**：4/6 推翻。接受两条最硬的：①「每条可撤销、即刻生效」按原文案做出来就是第 6 次「UI 说的 ≠ 机器实际的」（已按代码修正为两种撤销 + 诚实文案）；②`/decisions` 视图是团队/合规形状，单人 Owner 的唯一读者是刚做完决定的自己（降级为数据）。**不接受一条**：reviewer 引 B-263 的 dropped 理由「单人只用 yolo/default/plan，所以面板长期是空的」——`docs/backlog.md:83` 同一句里明写「有 allowedTools 需求时再一起做」，而 T-03 正要发出「本会话始终允许」，这个需求正是这份清单自己造出来的。

> **需要你裁**：T-27b 是否随 T-26/T-28 一起裁？若代批与例行都不做，记录里就只剩「人」这一种决定者，价值只剩「我上周批过什么」。
> 推荐仍按「数据 + 两个既有落点」做——成本是渲染已有的 `completedRequests`，不是子系统；但**绝不为它单开路由**。

### T-28 · 例行工作：把一条已做过的活变成「重复」，创建即启用 + 立刻一次可见试跑
`horizon` NEXT ｜ `判定` 保留（重写、收成一个原语）｜ `依赖` T-02 / T-09 ｜ `backlog` 无 id，落地需新开 B-id + spec（不能挂在 roadmap 那句话下）；复用 daemon `POST /spawn-session`、board tasks KV、账号 webhook 出站

**问题**：零实现零规划已复核：`packages/happy-server/sources` 无 cron/队列依赖只有 in-process `setInterval`，backlog 全文 grep 定时/schedule/cron 只命中 B-025、B-001，仅 `docs/roadmap.md:76` 一句承诺。但原提案的触发机制指错了源：「从 T-27 账本数出同一类请求出现 3 次」——账本记的是权限决策，而它举的四个例子是 composer 里打的 prompt，**根本不进账本**，按字面实现 promotion 永远不会对自己举的例子开火。四个例子本身也只有 triage backlog 是判断题：清 verify-queue 按定义是人眼真机验收、盯 PR 合并已经是 `land-pr.sh`、看发布 SHA 已经是 `check-release.mjs` + 首页 entry 资产名。

**提案**：**一个原语，不是一套调度产品。** 「重复」是任务/队列条目的一个属性：在 T-02 队列里清掉一个条目、或在一条已完成的任务上，出现一个动作「每个工作日再来一次」——确认的是一句自然语言 + 时间 + 机器/目录（未来加角色），**不写 cron 表达式**。**创建即启用并立刻跑一次可见试跑，失败就撤销这条重复**（没有东西会监督一个 disabled 的 job）。每次运行**新建会话**并注入上次 outcome 摘要，不把 prompt 打回同一个会话（铁律 16；那个会话可能已归档/离线）。产出**只在有发现时**进 T-02 队列，无发现自动收，不新增第三个列表；运行记录（含跳过原因：机器离线 / 上次还在跑 / 探针未过）挂在这条重复自己的条目上，不做独立 roster 页与运行历史页。
**落点是硬约束不是实现细节**：调度必须住在 relay/server（账号级唯一常驻组件）——daemon 在 mac-office 这台会睡的笔记本上，机器离线时会话连列表都会消失（B-268）；server 是蓝绿整镜像发布（铁律 5），进程内定时器会在切换窗口漏跑或双跑，所以**运行记录必须持久化并按 (job, 计划时刻) 幂等**，「错过只补最近一次」由记录判定不靠内存。
v1 明确不做：promotion 检测器、心跳形态、precheck DSL、连续失败自动停用策略层。

**竞品依据**：OpenClaw 的 promotion——确认的是自然语言句子而不是 cron；创建后立即以可见测试跑一次，失败就删除；Codex Scheduled 视图**就是收件箱**（有 findings 才未读、可批量已读/归档）。

**被挑战与让步**：4/6 推翻。接受三条：①promotion 检测器解决的是「用户发现不了这个功能」，单 Owner 兼产品设计者没有这个问题，且它依赖的账本里没有 prompt；②「例行任务/心跳」二分 + roster + 运行历史 + precheck + 自动停用是一整套调度产品，与减法纪律和 90 项待验的验证带宽正面冲突；③心跳打回同一会话与铁律 16 冲突。半接受一条：「瓶颈是你的判断带宽，自动开工只是加队列深度」——对，所以产出改成有发现才进队列；但「盯 PR/看 SHA 由 T-22 覆盖」推不掉「定时发起一批准备工作」这类真需要人记得发起的活。不接受：「roadmap 承诺过」不是必要性论据（已从 problem 删掉）。

> **需要你裁**：第一版只做「定时发起一次任务」，还是同时要「盯着一个东西直到有发现」的心跳？
> 推荐只做前者：心跳与单写者锁、归档语义的交互从没人交代过，盯 CI 由 T-22 的事件卡覆盖。
> **第二刀（可现在定也可延后）**：第一条例行具体是哪件活——它决定 v1 需不需要「注入上次 outcome」。

### T-30 · 额度触顶是队列里的一张卡，不是侧栏上的一条报表
`horizon` NEXT ｜ `判定` 保留（重写、削成一张卡）｜ `依赖` T-02 / T-28 ｜ `backlog` 扩展 B-211（统一 Usage，doing）只加「触顶事件 + 到点行为」；`rate_limit_event` 上行属 B-211

**问题**：原条目一条里塞了三样，只有一样会改变你的一天。已核实：会话内上下文百分比已在（`screens/session/contextWindow.ts`），每轮 model/token/费用已在（`MessageMetaRow.tsx:43`），会话级归因正是 B-211 在铺（`sync/usageDashboard.ts` 已按 `report.sessionId` 聚合并带 `cost/costKnown`）——所以「页脚一行 $x · 上下文 62%」是重复。侧栏常驻 `Claude 78% · 5h` 更危险：订阅制不给窗口余量，Claude SDK 的 `rate_limit_event` 今天在 `sdkToLogConverter.ts:268` 被**显式丢弃**，没有上行就只能估一个数并渲染成事实——那是「UI 说的 ≠ 机器实际的」在额度上的复发。真正的缺口是第三样：撞额度今天只有一行死文案（`Usage limit reached until {time}`），一批并行会话同时停摆而没有任何东西叫醒人；而**重置时间戳其实已经在手里**（`sync/reducer/messageToEvent.ts:34` 解析 `Claude AI usage limit reached|<epoch>`）。

**提案**：只做一件事：额度触顶成为一个可作答的队列事件。①会话状态增加 blocked 原因 `quota`；同一个窗口卡住的一批会话**聚合成一张卡**（不是 6 条）：`额度用尽 · 14:30 恢复 · 影响 6 个会话`，动作「到点自动继续 / 换模型继续 / 我自己来」。②这张卡走 T-03/T-08 的同一形态，手机推送里可直接作答，桌面同一张卡。③「到点自动继续」= 到点把那一轮重发，失败必须显式（铁律 17）；它需要一个**服务端唤醒原语**，即 T-28 的调度（浏览器开着不算），若 T-28 不做则降级为「到点提醒」，不许静默什么也不发生。④明确删掉：侧栏常驻额度段、per-provider roster、80% 警告、页脚 `$x` 与上下文百分比。⑤若仍要「还剩多少」，前置是把 `rate_limit_event` 上行成账号级 quota 事件，拿不到真值就写「未知」而不是估算；展示位是 B-211 的报表页，不是常驻表面（配额条尤其禁止用 teal）。

**竞品依据**：Orca 状态栏 per-provider 用量段 + 80% 警告 + roster 与 Paseo provider usage bars——两家用户自带 API key、token 自己计账所以百分比是真值，vh 是订阅制，这一半不可照抄；Claude 的额度卡提供 "Auto-continue when limits reset" 并显示恢复时间——**这一半可照抄**，因为重置时刻是 provider 给的真值。

**被挑战与让步**：4/6 推翻。接受三条：①侧栏 footer 在手机上根本不可见（B-046 正是这么被 dropped 的），而撞额度最常发生在人不在桌面时；②per-task `$x` 对单人订阅制没有可作答的决策；③百分比没有数据源就是编。不接受「这就是 T-02 的一种卡片类型，不值一条」：卡片容器是 T-02 的，但 quota 这条链路要新增三样有主的东西——blocked 原因、跨会话聚合、到点重发。

> **需要你裁**：到点行为的默认值。
> **A**：默认「到点自动继续」——省一次操作，但你可能不在场，恢复瞬间会有一批会话同时开跑。
> **B（推荐）**：默认「到点提醒」，继续要你按一下——与「人只在欠决策时被打断」一致，而且不依赖 T-28 就能先落地。

### T-26 · 权限请求上的风险标注 + 写进产品的硬边界；LLM 代批不做，门槛写死
`horizon` NEXT ｜ `判定` 保留（重写、砍掉代批权威）｜ `依赖` T-02 / T-27 / T-28 ｜ `backlog` 扩展 `sync/yoloEnforcement.ts` 与 `specs/2026-08-permission-mode-source-of-truth.md`；复用 B-061/B-063 的 assistant sticky denylist

**问题**：「便宜模型替我判定权限请求」在 web/CLI/server 全为零，无 spec 无 backlog，所以不是重复；但原提案的两条论据站不住。①它自己列的硬边界（生产写入 / git push / 删除 / 对外发送 / 未列域名出站）已经把真正危险的动作划进「永远停」，剩下交给模型代批的**恰好是在 worktree 里本来就安全的那类**，安全边际收益 ≈ 0。②Codex 的 `Approve for me` 承重件是**沙箱边界**（判错被沙箱兜住），vh 跑在 mac-office 上**没有沙箱**、共享生产状态（`~/.happy` 是生产 daemon 的 home）；而 `git push`/删除/对外发送在 Bash 一行里有无数写法，命令前缀黑名单挡不住。另需更正一处全稿都写错的事实：**vh 并非「没有非人放行」**——`sync/yoloEnforcement.ts` 已经是一条你批准过的 web 侧自动批准车道，带硬边界 `NEVER_AUTO_APPROVE = {AskUserQuestion, ExitPlanMode}`（:39），而**这条车道的放行今天在会话页完全不可见**。

**提案**：拆成「现在做」和「门槛写死后才谈」两半。
**现在做（不新增任何权限权威）**：①旁路便宜模型只写**建议**不做决定——给队列/决策卡上的每个权限请求补一行 mono 注解 `风险 低 · 只读 git 命令 · 建议批准`，人仍按一个键，同工具同风险可连批；风险等级用 text 三阶不着色。②把「永不自动放行」清单写进产品而不是 prompt：作为 `yoloEnforcement.ts` 那个纯函数的一张常量表（与 `NEVER_AUTO_APPROVE` 同处、同一批单测），并把 CLI 侧 sticky denylist 机制（`assistant/dispatcherTools.ts:withAssistantDenylist`，per-message override 只能加不能减）从 assistant 车道推广到所有 bot/定时车道。③**确定性熔断**：一次运行内被拒 N 次或触到永不清单 → 中止本次运行并生成一张队列卡（不是静默停摆）。
**门槛写死后才谈（默认不做）**：LLM 代批放行——三条全满足才立项：T-28 例行连续 4 周真跑；运行记录显示每周 ≥3 次因等审批过夜空转；T-14 落地且能在会话页与手机上回答「这一项是谁放行的」。任何非人放行都必须经既有唯一执法点落地，不新增出站字段、不新增模式（铁律 14），且处于自动放行车道的会话必须有一枚与人工模式明确不同的 chip。

**竞品依据**：Codex `Approve for me` = 独立 reviewer agent 在**沙箱边界**上判定，带 rationale / risk level / 三连拒断路器——可借的是「rationale + risk level + 断路器」，不可借的是它的沙箱；Codex rules 与 permission profiles 是确定性的那一半；反例 Orca 给所有 CLI 预置 bypass flag。

**被挑战与让步**：4/6 推翻（exists 两票确认零实现）。接受三条：①无沙箱 + shell 层黑名单挡不住 → 安全故事落回模型判断，属于「照抄机制没照抄承重件」；②条目自陈「必要性只有在定时/派工真跑之后才成立」；③代批把「你的评审带宽」换成「评审 reviewer」这层新工作，错放行不可逆而账本只能事后发现。**不接受「本轮整条删除」**：确定性的那一半今天就该存在，因为 `yoloEnforcement` 的自动放行已经在跑且完全不可见——这是真缺口，且与 LLM 无关。

> **需要你裁**：你要不要「无人值守时由非人放行」这件事本身？
> **A（推荐）**：不要——只做风险标注 + 硬边界 + 越界即入队。代价：定时/派工在夜里会停下等你早上一次批完。
> **B**：现在就做 LLM 代批。代价：mac-office 无沙箱、黑名单在 shell 层挡不住、并在唯一执法点旁再立一个真相源（这是本仓库唯一有 5 次事故记录的失败模式）。

### T-32 · 拆开：①在当前表面里查找 ②跨天回看搜派生层（不建 transcript 全文索引）
`horizon` NEXT ｜ `判定` 拆分 ｜ `依赖` T-09 / T-27 ｜ `backlog` T-32a 执行 B-038 的搜索部分并与 B-037 合成同一入口同一键位，与 B-044 同批交付；T-32b 以新论据部分推翻 B-039 的 dropped（只取分支/PR/结果维度）

**问题**：缺口一半是真的、一半立论错了。真的那半已核实：全仓无 `SearchAddon`，会话页零搜索，⌘K 与侧栏搜索只在 title/subtitle/path + `#tag` 上做子串匹配；B-038（会话内搜索 + 导出）与 B-037（终端 scrollback 搜索）分别 todo，两者会抢同一个键位。错的那半必须修掉：①「转写在 server 侧加密所以 grep 不到」——会话正文确实是客户端按会话密钥加解密，但**你的 Claude 转写在 mac-office 本地是明文 JSONL**（`workflow-layer §1.8` 的零使用证据正是这么取到的），你还有一个跨 Claude/Codex/Cursor 的 sessions skill；②按你自己的硬纪律（「需求/bug 当场记 backlog，不靠记忆」「大改动先出 spec」），「上周那个会话怎么决定的」的事实源是 backlog/spec/PR 而不是转写；③原稿把跨会话语料定成「最近 N 条消息」是**致命形态错误**——那只覆盖客户端已加载的分页，用户无法区分「没有」和「没搜到」，静默假阴性比没有搜索更坏。

**提案**：
**T-32a 在当前表面里查找**：会话 transcript 与终端 scrollback 共用同一条搜索栏、同一交互与键位（按 pane 定向的 ⌘F / Ctrl+F），命中跳转 + 高亮，会话侧覆盖工具参数与 diff 文本；结果栏必须**显式声明语料**（「已加载 N 条 · 加载完整历史再搜」按钮），**禁止做一个静默不全的搜索**；手机在会话 header 给一个搜索图标，终端复用同一组件。与 B-044（ChatList 虚拟化）同批交付——虚拟化会打断浏览器原生查找，不同批就会造出「原来能找、现在找不到」的回归。
**T-32b 跨天回看搜派生层**：⌘K 增加一段「决定 / 结果」，语料是明文可索引的**派生对象**——T-09 outcome 的 headline/facts、T-27 决策条目、分支 / PR / tag / 机器 / workspace；一条会话一行并直接显示命中的那个决定。明确非目标：**不为原始 transcript 建全文索引**（那是第二个真相源，且与「结果要有结构化表示、人和 bot 都不必重读 transcript」方向相反）。

**竞品依据**：Codex「Search chats matches content **and Git branch names**」；Paseo History 可按 workspace/agent/branch 搜；Orca `Cmd-J` 支持 PR/MR 号搜索——三条里两条半检索的是**元数据/派生属性**。

**被挑战与让步**：4/6 推翻。①最强反驳已写进 problem：你的决定不在 transcript 里，本地 JSONL 明文可 grep，还有 sessions skill——跨会话内容搜索解决的是你已用更好工具解决的问题。让步：跨会话那半从「搜原文」改成「搜派生层」。②「全文搜索返回草垛，账本返回那根针」——已吃进。③「最近 N 条 = 静默假阴性」与「⌘F 键位已被 B-037 预定」——已写成 T-32a 的两条硬约束。④reviewer 纠正一处：server 侧索引不是「做不到」而是「要新开一条明文路径」——核实后升格为下方裁决。保留的分歧：会话与终端两个主表面今天都没有查找，这是可辩护的基础缺失，且它是唯一一处你在手机上完全无替代的场景。

> **需要你裁**：跨会话原文检索这一刀。
> **A（推荐）**：维持 T-32b——只索引派生层（outcome / 决策 / 分支 / PR / tag），**永不为 transcript 建全文索引**。代价：「某句原话在哪条会话说过」仍要回 mac-office grep 本地 JSONL，手机上只能经 web 终端。
> **B**：在 relay 里新开一条服务端明文 transcript 索引路径（今天 server 零处解密会话正文，这会是第一处），换来手机上可搜全部历史。代价：把「服务端可信但不读正文」这条现状事实改掉，并给未来任何 bot 打开同一个口子。

### T-31 · 「引用」一个原语：指着引用文件，而不是背路径
`horizon` NEXT ｜ `判定` 保留（重写）｜ `依赖` — ｜ `backlog` 扩展 B-035（斜杠一半已上线，本条把剩下一半重定义为「引用」原语并新增发送前解析）；与 B-241 / `specs/2026-08-any-file-attachments.md` 的拖放语义划界

**问题**：缺口是真的，但原稿把它说错了地方。已核实：`sync/suggestionFile.ts`（ripgrep + Fuse + 每会话 5 分钟缓存）**全仓无 importer**，而斜杠一侧已经接线（`slashSuggestions.ts` 被 `AgentInput.tsx:68` 消费），所以「斜杠建议只补命令名」只剩一半成立；B-035 自 2026-08-13 todo。必须修掉两处被证伪的论据：①「打错路径 = 一轮无效 turn」在取证底图里查无实据，agent 拿到近似路径通常自己 Glob/Grep 找回来；②「代码已在只差接线」是工作量论证，按你的规则不能当必要性。真正的缺口是 **Files 面板与 Changed files 面板今天是只读展示**：屏幕上明明列着那个文件，却没有任何动作能把它变成下一条 prompt 的输入——路径召回是纯操作性上下文，手机上代价最高。

**提案**：收敛成一个原语「引用」，插入的是**纯文本路径 token**，不承诺附件语义。①凡是已经列出文件的地方各给一个「引用」动作（Files 面板行、Changed files 行；手机同形态），点一下在 composer 光标处插入路径——**这是主路径**，不需要记忆、不需要在 iOS 上切键盘打 @。②composer 输入 `@` 触发补全作为加速器：直接接线已有的 `suggestionFile.ts` + `sessionRipgrep`，不新建持久索引。③**发送前解析一次**：`@path` 在 daemon 侧 stat 不到就当场在 composer 下给候选并拦住发送——这是唯一真能省掉一轮的动作。④**诚实副文案（硬约束）**：消息经 SDK 以纯文本送出，CLI 不会把 `@path` 展开成文件内容，所以 UI **不得渲染成附件/芯片样式**。⑤拖放语义当场裁定：OS 文件拖入 composer = 附件上传（保持 `AgentInput.tsx:511` 现语义）；面板内的行拖出 = 插入路径，桌面 nice-to-have、不作验收项；手机不做拖拽。⑥删掉「最近改动文件优先」这个承诺——ripgrep 没有 mtime/git 维度，要排序就从 T-11 的 git changed files 取。⑦hunk 级引用交还 T-12。

**竞品依据**：四家都有 `@`-mention，但它们的 composer 是唯一通道；vh 还有 Files / Changed files 面板与终端，所以落点应是「指着引用」而不只是「打字补全」。

**被挑战与让步**：4/6 推翻。①「这条就是 B-035，应当去修订 B-035 而不是新开一条」——核实属实，已写成扩展 B-035 并只保留它没有的三样。②**最硬的一条显性偏好反证**：「代码躺在仓库里三周、期间 351 个 web commit、v0.2.93–v0.2.100 一大批发布都没接这根线，说明它从没疼到进 triage」——无法反驳，原样交给你（见裁决），只把必要性重锚到「引用面 + 手机输入成本」。③「@ 补全仍要求你先记得路径存在，真正贴北极星的是指着引用」「hunk 引用与 T-12 是同一原语的两种叫法」——已全部吃进。

> **需要你裁**：这条要不要占一个批次位。
> **A**：进批，范围就是上面七条（引用面 + 发送前解析 + 拖放裁定，@ 补全顺带接线）。
> **B**：退回 B-035 的备注，只把「Files / Changed files 每行一个引用动作」并进 T-11/T-12 的评审面，不单列。
> 推荐 A，但理由只能是「引用面 + 手机输入成本」；**如果你认同那条显性偏好反证（三周没接 = 不疼），B 更诚实**。

### T-33 · 扫读靠默认态，不靠模式：折叠行写事实 + 顺手清掉两项死设置
`horizon` NEXT ｜ `判定` 保留（重写、削成极窄一条）｜ `依赖` T-09 ｜ `backlog` 承认 B-250（done）已交付原稿的中间档；延伸 B-209（doing）；执行 B-041 中的 `groupToolCalls` / `expandTodos` 两项（**判为删除而非实现**）

**问题**：原稿的前提今天已经不成立：B-250（done，线上默认）已经把每个已完成 turn 的 commentary / thinking / tool 收进 `TurnActivityView`（`screens/session/chatTurns.ts` 的 `buildChatRows`），正文只留用户消息与最终回答——**vh 的默认渲染已经等价于 Claude 的 Summary 档**。所以三档里的中间档是既成事实、「完整」档等于逐条展开也已存在，真实增量只剩一个：**那条折叠行的信息量**——它今天只写耗时，写不出「改了 3 个文件 +42 −7 / 跑了 pnpm test 退出 0」，所以人才必须展开。原稿的形态还有两处自伤：「记忆到设备、手机默认与桌面不同」会让同一条会话在两台设备上包含的行不一样（撞 T-01）；而 `groupToolCalls` / `expandTodos` 这两个 synced 设置全仓只有 i18n 文案、零消费者，把它们复活成档位正是死设置的生成方式。

**提案**：**不做模式，做默认。** 三件交付物：①**折叠行携带事实**：那一行除耗时外固定渲染「改了 N 个文件 +x −y / 关键命令与退出码」，字段取自 T-09 的 outcome facts，渲染语言归 B-209 的 disclosure 规范——默认态即「仅结论」，零新设置、零跨端分叉、桌面与手机同一默认。②一个**一次性动作**「展开 / 折叠本会话全部工具」：只作用于当前视图，不记忆、不进设置、不跨设备同步。③**删掉** `groupToolCalls` / `expandTodos` 两项 synced 设置（改 synced settings 时注意铁律 1）。
明确不做：三档全局密度、设备级记忆、手机与桌面不同默认、回退到 B-250 之前的「完整」档。长会话扫读的另一个真实瓶颈是 B-044 虚拟化，单独排期。

**竞品依据**：Claude 的 Summary 档定义是「only Claude's final responses **and the changes it made**」——关键词是 changes it made：vh 缺的正是这半（事实），不是模式。Paseo 的「Summarize tool calls in a single collapsed item」+ turn footer「Worked for 31m 46s」同样是折叠行带事实的形态。

**被挑战与让步**：5/6 推翻，且原稿自带分歧与「可撤」条件句——两点都接受为出局条件，因此重写而不是保留原形。「中间档就是今天的默认（B-250），真实增量只剩把折叠行的事实写出来」核实属实；「三档全局模式与 B-209 争同一批默认折叠规则会出现双真相」「新增一个记忆到设备的开关正是 B-041 那 12 项死设置的生成方式」——全部吃进，模式整个删掉。一处反向采纳：exists#1 建议把开关载体复活成 `groupToolCalls` 档位字段——反向处理为**删除**。

（本条无需裁决。）

### T-24 · 分叉只做接线（仅截断对话，不碰工作树）；「带简报继续」不新增生成器
`horizon` NEXT（a 可提前到 NOW）｜ `判定` 拆分 ｜ `依赖` T-09 / T-16 ｜ `backlog` 接上休眠的 `sync/ops.ts` fork 三件套 + `utils/sessionFork.ts`（零 UI 调用点）；扩展 B-290（done 2026-09-03，`ImportClaudeHistoryModal`，picker 形态与血统字段可共用）

**问题**：原文「fork 是上游遗留死字符串、web-v2 零入口」只对了一半且低估现状：daemon 侧 `claude-fork-session` / `claude-list-rewind-points` / `claude-duplicate-session` / `codex-fork-thread` 是**活 handler**，web 侧 `sync/ops.ts:903/930/960` 与 `forkAndSpawn:1756`、`utils/sessionFork.ts:25` 全套封装都在，12 语言文案齐——**唯独零 UI 调用点**。B-290（2026-09-03 已发布）刚做了同源的 `ImportClaudeHistoryModal` picker，但它用 `trackedClaudeSessionIds` 排除 vh 已拥有的会话，所以「从自己正在跑的会话分叉」仍然做不到。另一处必须修的事实：`claude-duplicate-session` **只截断复制 JSONL、从不碰工作树**，原文「对话与文件都回退、改动进 stash」是凭空发明的新能力。

**提案**：拆两条，并砍掉一件。
**T-24a 接线（S，可提前到 NOW）**：会话菜单 + 用户消息的**溢出/长按**菜单（不加常显控件——手机无 hover，且 B-209 正在给对话降噪）里一个「从这里另起一个执行体」：`claudeListRewindPoints` 选点 + `claudeDuplicateSession(cutAfterUuid)`，rewind picker 直接复用 B-290 已做好的 picker 形态；原会话不动；父子关系用 header 上的 `Forked from ↑` chip（`forkedFromLabel` 文案已在），**不改侧栏排序**。必须按 capabilities 分版本（铁律 14），Codex 走 `codex-fork-thread`；rewind 点以磁盘为准（铁律 18：server metadata 的 `claudeSessionId` 在 `/clear` 后是旧的）。血统字段统一成一套（`parentSessionId`/`forkedFromMessageId` 与 B-290 的 `importedFromClaudeSessionId` 不能各说各话）。
**T-24b 带简报继续（M）**：**不新增第三个生成器**——简报由 T-09 的 outcome + T-10 的 recap 渲染，走 T-16 的预填深链新建会话（可选新 worktree），原会话不动、两边互链。需要现场生成时复用 B-283 的旁路查询三件套（铁律 18），不新开推理通道。
**砍掉：文件级 rewind / stash 恢复点**。理由不是难做：产品在共享 cwd 上原地回退文件，与铁律 16 的单写者纪律和「Web 只做控制面、不越过 daemon 改文件」的边界冲突，而 stash 在产品里不可见、不构成恢复路径；**git 本身就是 rewind**。

**竞品依据**：最贴我们的是 Orca 的 "Continue in New Session…"——从 transcript 生成一份有界 handoff prompt，原会话不动，**而且它没有做文件回退**。

**被挑战与让步**：四票推翻：①三个机制捆成一条，唯一通用理由是「四家都有」；②文件 rewind 是从手机发起的破坏性文件操作，目标是你生产 daemon 的宿主；③「带简报继续」与 T-09/T-10 生成同一批字段；④把两个动作挂到每条用户消息与 B-209 降噪反向；⑤未按 capabilities 分版本。让步：文件 rewind 整个砍掉；简报改为复用 T-09/T-10；入口移进溢出/长按菜单；血统与分版本写死。**不让步的一点**：`forkAndSpawn` 在 2026-08-31 的 B-262 批次里仍被维护（继承父会话权限模式），说明这条路径一直被当成活代码在养，只是没人给它一个按钮；而 B-290 刚上线的导入弹窗证明这类入口是你要的，只是当时的形状排除了 vh 自己的会话。

> **需要你裁**：「带简报继续」的产物落在哪？
> **A（推荐）**：写成当前 worktree 里的一个 markdown（与 T-19a 的工作记忆同一个文件），新会话首条消息只是「读 <file> 继续」。代价：多一个文件约定。好处：可改、可提交、可复查。
> **B**：简报只作为新会话的首条消息存在。代价：易逝、不可复查、改一遍要重生成。
> 另外 T-24a 是**纯接线**（管道、文案、血统字段都已在），它不需要你裁形状，只需要你决定它排在这一批还是下一批。

### T-35 · 账号级 agent 面拆成两条：a 只读 + 订阅（现在就有人类消费者）／ b 写 + 统一派工（等门槛）
`horizon` NEXT（a）/ FUTURE（b）｜ `判定` 拆分 ｜ `依赖` T-01 / T-09 / T-03 / T-26 / T-27 ｜ `backlog` 升级 `docs/channels.md` 为账号级 agent 契约（同批删掉 assistant variant 的 11 工具行）；保留 `HAPPY_SPAWNED_BY` + `/session-event` 骨架；实现前须出 spec

**问题**：缺口属实——账号级读取面、事件订阅、统一派工原语、人接管信号，仓库里一个都没有：agent 今天只有 assistant variant 的 11 个本机工具（≤14 天、最近 15 条、跨机器直接 No local key），唯一的主动通道 `/session-event` 只覆盖 `HAPPY_SPAWNED_BY` 且 5 分钟冷却。但原稿两处论据必须修：①**「四条互不相通的派活路」不准确**——核实后三条（web `machineSpawnNewSession`、CLI `very-happy spawn`、助手 `session_spawn`）实际都打到 daemon 同一个 `POST /spawn-session`；真实不一致是**各调用方暴露的参数面不同**。②**「server 可信非 e2e，这个口子本来就是开的」不成立到可以据此设计**：账号 secret 确实以服务端密钥托管，但会话正文今天是客户端按会话密钥加解密、通知正文是 libsodium box 到账号公钥，**服务端零处解密会话内容**；在 relay 里新开一套明文 REST 读写面 = 第一次引入明文路径 + 第三条权限权威，正撞铁律 14 与 16。

**提案**：
**T-35a（NEXT）只读 + 订阅**：`sessions/tasks.list(filter)`（返回 T-01 状态 + T-09 outcome + capabilities）、`read(tail|since_seq)`、`terminals.list/read`、`machines.list`、`permissions.pending`（**只读**）；订阅 `turn-end-idle / needs-decision / failed / human-took-over / marked-done`（把 `spawnedBy` 泛化成 `reportTo`，见 G-04）。**实现形态钉死为 bot = 同账号的 headless 客户端**：持账号级 scoped 凭据、走同一条 socket、复用 web 的 store 投影与 `boardItems.lifecycleOf` 分类，**不在 relay 里新增服务端解密路径**。同一套能力暴露为 CLI（`very-happy sessions ls --json`）与 MCP 只读工具——**这一半今天就有消费者**：你自己的 agent 集群与定时脚本。「人接管信号」不新建 durable 日志：事实源是铁律 16 的 `~/.happy/session-locks/<id>.json` 加已有 `/session-event`，只补一条合并通知**推给远端 watcher**；不在会话页对你复述「你 14:02 直接介入过」。
**T-35b（FUTURE，见下节）**。

**竞品依据**：Codex CLI 0.150 的 `codex_tui` 任务工具走「authenticated local MCP server with explicit approval prompts」；Claude 的 cross-session messaging 给了完整安全语义与 `notify_when_idle`（取代轮询）。

**被挑战与让步**：4/6 推翻。①最硬一击：「全部必要性写在一个你明说现在不做的角色身上，而 T-39 给它的五条门槛今天全部为零」「整份清单没有任何 NOW 条目依赖 T-35」——接受，写面整体推到 future，只保留今天就有真实消费者的最小只读面。②「它不是 T-34 的前提，因果说反了」——接受，T-34 已删该依赖。③XL 不可评审——已拆。④「人接管信号是第二真相源」——已改为复用单写者锁。⑤「`permissions.pending` / `permission.respond` 做成通用 agent 接口等于绕过 T-26 的闸门」——写成红线：pending 只读，respond 只走 T-26。⑥服务端加密现状的纠正——已改写形态为 headless 同账号客户端。

> **需要你裁**：T-35a 的范围与时点。
> **A（推荐）**：现在只做最小只读面——`sessions/machines ls --json` + 同能力 MCP 只读工具 + `spawnedBy → reportTo` 字段泛化；消费者是你自己的 agent 集群与定时脚本，验收不依赖任何 bot，也不急着把它固化成对外契约。
> **B**：读 + 订阅整套一次做完并写进 `docs/channels.md` 成为对外契约。代价：在 T-01 状态词汇、T-09 outcome、T-27 账本这三个对象还在被重新定义时就背上双向兼容包袱（铁律 4）。

### T-38 · 派工预设 / 可登记角色：把硬编码的 `variant:'assistant'` 泛化成 N 个
`horizon` NEXT ｜ `判定` 保留（重写、砍掉人设那一半）｜ `依赖` T-35 / T-28 / T-29 ｜ `backlog` 无对应 id；扩展已发布的 B-251 `agentDefaultOverrides`；替换 `variant:'assistant'` 临时约定；需改 `specs/2026-08-agent-guidance.md` 的单 `BASE_SYSTEM_PROMPT` 常量为「全局常量 + per-profile 追加段」

**问题**：草稿说「今天 `variant` 只是一个自由字符串，没有角色登记表」——前半对（`storageTypes.ts:67-72` 注释「Optional string (not an enum) so future variants pass through」），后半严重低估已有实现。事实是：**一个完整的角色对象已经存在，只是硬编码成唯一一个 `variant:'assistant'`**——`packages/happy-cli/src/assistant/bootstrap.ts` 在 `~/.happy/assistant/` 铺 CLAUDE.md（人设）+ memory/personal.md + memory/journal/，`assistantTools.ts` / `dispatcherTools.ts` 是它的工具面（显式禁 bash/edit/write），`spawnDirectory.ts` 是它的目录规则，B-061 的默认跳过审批是它的权限车道；再加上 B-251 已发布的 `agentDefaultOverrides`（per-agent 持久化 permissionMode/modelMode/effortLevel）已经是「记住这个 agent 怎么用」的一半。真实缺口只有一个：**这整套只服务于一个角色，而那个角色恰恰是你不用的那个**。

**提案**：把已有的单角色机制泛化成角色表，**不新增页面、不新增颜色轴**。
- 对象：`profile` = `agentDefaultOverrides` 的超集 —— {名字（mono，**无身份色**）, agent + model + effort, 权限车道, 默认机器 + 目录规则, 追加系统提示, 工具白/黑名单（复用 `dispatcherTools` 的收窄方式）, `reportTo`, **所需 session capability 与旧 daemon 上的降级行为**}。最后一项是草稿漏掉、也最会伤人的字段：铁律 14 下 wrapper 不随 daemon 热升级，**一个会静默降级的角色比每次手选参数更糟**——降级必须在 Dispatch 确认卡上说出来。
- 桌面：不新增 Settings → Roles 页。创建 = Dispatch 卡上「把这次派工存成角色」（终端快捷指令 presets 是同款就地保存先例）；召回 = Dispatch 卡下拉 + ⌘K；显示 = 会话行、队列条目的「执行者」字段、outcome 里一枚 **mono 名字芯片**。
- 手机：只显示芯片，不提供角色编辑；375px 下角色芯片让位于状态词与机器。
- 记忆：角色可选带家目录 `~/.happy/roles/<id>/`（沿用 assistant 的布局）；默认不自动写，只有角色自己调 memory/journal 工具时才写。
- 明确不做：身份色/图标（tokens.css 里没有身份色轴；等宽体本来就是机器层身份）、独立 Roles 页、per-role 预算与队列。地址、注意力状态、拥有的例行任务、可提议新建角色 = §7 的定义，本条不出现。

**竞品依据**：Grok Bot「Bot = 名字 + 职责 + 自己的会话 + 持久记忆」，chief of staff 只是 description 字段（第三方复核原话「There is no manager Bot type」）；OpenClaw 的 agent = 完整 per-persona scope。**反面证据同样来自这份研究**：「persona without mechanism」被点名为反模式，并直接点名 very-happy 今天的 assistant 页就处在这个状态。

**被挑战与让步**：6 票 4 推翻，核心两条接受：①「这就是拒绝表里的『现在就做角色花名册 / persona without mechanism』」——部分成立，砍掉人设那一半（独立 Roles 页、身份色/图标、装饰性芯片）；②身份色撞设计契约（`docs/design-language.md` 第 17/30 行）——核实属实，草稿写「不用 teal」不构成豁免，已删除。③「字段逐项被 T-35 的 Dispatch 对象吸收」——大体成立，降级为「Dispatch 对象的具名预设 + 一个可选家目录」。**未让步的一处**：多数票主张「删掉记忆、只做参数预设」，我采纳 exists#2 的反向意见——今天的 assistant 已经有 personal.md + journal，把记忆排除掉相对现状是**能力倒退**；折中为「家目录可选、默认关、只由角色自己写」。

> **需要你裁**：角色带不带家目录与记忆？
> **A**：纯预设——一组参数、零文件、零记忆。最小、无新磁盘状态，但等于确认「角色只是派工模板」，assistant 现有的 CLAUDE.md + personal.md + journal 无处安放。
> **B（推荐）**：预设 + 可选家目录（默认关，只有声明为常驻角色时才铺）。代价：多一处磁盘状态和「谁能写它」的纪律（写入只能由角色自己的 memory/journal 工具发起）。

### T-37 · 外部事件的来处信封与账本（触发器登记表拆出并入 T-28）
`horizon` NEXT（a）/ FUTURE（b）｜ `判定` 拆分 ｜ `依赖` T-28 / T-35 / T-27 / T-09 / T-02 ｜ `backlog` 扩展 `docs/channels.md` 与 `specs/2026-08-tanka-channel.md`（Shipped）；吸收 B-026；**不**重开 B-002

**问题**：草稿的两条必要性论据经核实**都是错的**，必须先撤掉：①「入站没有允许名单、没有审计」不成立——`specs/2026-08-tanka-channel.md`（Shipped）安全不变式 1/3 明写「sender 与 chat 双 allowlist、fail closed、去重、限流、脱敏审计日志」，`docs/channels.md:389-405` 把这些强制成适配器责任，且入站口是 daemon 的 **127.0.0.1 loopback** 控制服务，没有可被陌生身份触达的监听面；②「两条路互不相通、每条外部触发都要人回 vh 手工收尾」不成立——出站 `session: <id>` trailer + 引用回复回灌同一会话已 Shipped，你私有 skills repo 里 514 行的 `skills/messaging/scripts/tanka/jojo-agent-gw.mjs` 正在生产跑 `[happy] <任务>` → `very-happy spawn`、引用回复 → `very-happy send`。
**真实的缺口窄得多，但是真的**：出站 payload 只有 `sessionId/taskId/link`，**不带来处**，所以那个网关把所有回执统一投进一个固定通知群——从哪来的活，回不到哪去；vh 内部也没有任何「这条会话是外部事件起的 / 有个事件到了但没跑，因为 X」的记录；而 `packages/happy-server/sources/modules/github.ts` 挂在 `connectRoutes.ts:222` 的 GitHub webhook 接收器过了 HMAC 校验后**五个 handler 全部只 log**，是「看起来有能力其实没有」的死脚手架。

**提案**：
**T-37a 来处信封 + 外部事件账本（NEXT，不含任何触发器配置）**：
- 数据：`very-happy spawn/send` 接受 `origin = {channel, thread_ref, actor, event_id, received_at}`，作为**明确标注不可信的文本**存进 session metadata；出站 `/v1/webhook/notify` 的 payload 原样回显 origin（JSON 字段 + 一行稳定 trailer，形式沿用已经在跑的 `session: <id>`，老接收方忽略即可，符合铁律 4）。
- 桌面：会话行与队列条目上一枚 mono「来处」芯片（`tanka:奇妙通知群` / `github:PR#158`），点它回到原处。**不新增 `/activity` 路由**（原稿给了它一个页面，与 T-27b 写死的「不新增第 15 个表面」、§6 显式拒绝表的 `/decisions` 一条以及 T-20a 的一进一出净预算直接冲突，已删除）：外部事件账本沿用 T-27b 的两个既有落点——条目/会话时间线上的一行，与 T-02 队列的「今天已办」段，在那里加一个**「来处」筛选位**；没起会话的事件（四态：无路由 / 被适配器过滤 / 机器离线 / 配置不可用）作为**没有会话的条目**进同一段，出站投递成功与否挂在该条目上。**这本账就是 T-27b 的那本账**，不新开第三本、也不给它页面（因此本条**不进 T-20a 的新增表面清单**）。
- 手机：不新增表面。外部事件只以队列条目出现，条目带来处芯片；回执由适配器发回原线程。
- 边界（关键）：vh **不持有 IM/GitHub 线程凭据、不代发线程回复**——只保证 origin 原样回流；允许名单继续留在适配器，vh 只负责让「谁触发的、跑没跑、为什么没跑」在产品里可见可查。
- 吸收 B-026：出站 3 次指数退避 + 投递失败计数进同一本账本与诊断页，投递语义仍是 best-effort。
**T-37b 命名触发器（FUTURE，见下节）**。

**竞品依据**：Paseo Connections 的「Known unrouted events」记 `no_project_route / no_trigger_for_source / trigger_filters_rejected / configuration_unavailable` 四类未路由原因——**只借这一件**，不借它的白名单形态（那是多租户公网 Hub 的威胁模型，vh 入站是 loopback）；Claude routines 把 API 触发的 text 包进 `<routine-fire-payload>` 并标注 untrusted，是 origin 载荷必须标注不可信的先例。

**被挑战与让步**：6 票 4 推翻。①「入站没有允许名单/审计」「这是补允许名单的唯一位置」「两条路互不相通」全是事实错误——核实属实，已从 problem 全部删除。②「把触发器做成产品内的六字段配置对象，等于把拒绝表里已否掉的 Paseo Hub 换个地方重建」——接受，a 段完全不含触发器配置。③「结果同时落 IM 线程和队列制造读状态分叉」——接受，改成「只有欠决策进队列，其余只回来处」，账本与 T-27b 合并。④「离线重放正面推翻 Shipped spec 的非目标」——接受，从提案里拿掉，改成下方裁决。**未让步一处**：「没有证据表明这个痛点正在发生、IM 适配器只是伪代码」——不成立，你的 514 行 Tanka 网关正在生产跑这条路。

> **需要你裁**：入站/出站要不要变成有保障的投递？
> **A（推荐）**：不变——保持 tanka-channel 的非目标「webhook delivery 不是 durable queue」，只做 B-026 的 3 次退避 + 失败可见。代价：daemon 离线期间的外部事件仍然丢，但**丢得看得见、可追**。
> **B**：正面推翻那条已 Shipped 的非目标，入站事件落 server 队列可重放。代价：多一套投递状态机、多一份「重放会不会重复起会话」的去重责任，并要改一条已发布的 spec。

### G-02 · dev server 的可达 URL：让「真实视口验证」在手机上真的可能
`horizon` NEXT ｜ `判定` 保留 ｜ **`来源` critic 补齐 · 未经 6 票对抗评审** ｜ `依赖` — ｜ `backlog` **推翻 B-142（`open_url`，dropped「提议级」）的判定并改形状**；与 B-131 `open_preview`（文件预览，含 denylist）相邻但语义不同，不复用其路径规则

**问题**：AGENTS.md 验收节把「窄屏、主题或第三方嵌入组件的视觉改动必须在受影响的真实浏览器视口验证交互、溢出与布局」写成硬要求，但 agent 刚在 mac-office 起的 dev server **只在 `127.0.0.1:<port>` 上——你的手机打不开**。于是这条纪律要么被跳过、要么把结论推进 `docs/verify-queue.md`（90 项待验、最老 2026-08-13，其中大多是移动端/IME/PWA）。产品今天给的是 `open_preview`（B-131，推一个**文件路径**，web 端用 fs-read 渲染），解决不了「打开一个跑着的服务」；B-142 的 `open_url` 被判 dropped「提议级」，且即便做了也不解决可达性——`http://localhost:5173` 在手机上是死链。合并稿的拒绝表自己写着「需要的只是 dev server 的可访问 URL」，却没有对应条目。

**提案**：在**已有的 relay 上**加一条鉴权 HTTP 反代，不新增对公网暴露的服务（与拒绝表「独立 Hub 式多租户触发服务」一致）：
- **地址确定性**：`https://veryhappy.dev/dev/<machine>/<port>/`（或 `<port>--<machine>.veryhappy.dev`），账号鉴权、默认只对你自己；链接可直接扔进手机。
- **显式开启，一次一个端口**：会话行 / 终端行 / 机器页上一枚 mono chip `dev :5173 · 打开 / 关闭`，来源必须是用户或 agent 的显式请求；**不扫端口、不自动暴露**；关闭即失效，daemon 掉线即失效。
- **必须透传 WebSocket 与 SSE**，否则 Vite HMR 不可用，这条就没有意义。
- **agent 侧**：把 B-142 的 `open_url` 收窄成 `open_dev_server(port, label?)`——agent 只声明端口，URL 由产品生成并推到当前设备（复用 `open_preview` 已有的推送通道与「本设备是否接收」开关），agent 拿不到也不需要拿公网地址。
- **明确不做**：内嵌浏览器 pane、Design Mode、computer use（拒绝表已裁，理由仍成立：vh 本身就跑在浏览器里）。
桌面：chip + 新标签页打开；手机：同一枚 chip，点开即在真实视口里打开 agent 刚改的页面。

**竞品依据**：Paseo 把它做成基础设施：`paseo.json` 里 `type: service` 的脚本由 daemon 监管、分配独占端口、反代到 `http://<script>--<branch>--<project>.localhost:<daemon-port>`（WebSocket-capable）。更硬的是 Paseo 官网自己的对比表把「Per-worktree dev server URLs」列成 `Yes / —`，`—` 那一列正是 vh 的上游——**竞品作者点名的空缺**。

**我预设的反方与我的回应（无 reviewer 票）**：三条：①「你一个人，装个 tailscale / ngrok 就完了」——**部分让步**：技术上确实能自己搭；本条的价值不在「能不能通」而在**确定性与就地**（从会话行一点就是这条分支的地址，不用记端口、不用切工具）。若你已有稳定 tailscale 习惯且够用，本条应降级为只做 `open_dev_server` 推 URL，反代不做。②「把本机端口暴露到账号面是 vh 历史上最危险的一类改动」——接受为约束而非否决，所以写死「显式一次一开、可见、可撤销、daemon 掉线即失效、不扫端口」，且不复用 `open_preview` 的路径语义。③「这不是日常循环的一环，属工具链」——不成立：验收是你亲口定的纪律，90 项未清的 verify-queue 就是这条纪律今天在空转的证据。

> **需要你裁**：反代落在 relay（vh-us server，多一条鉴权 HTTP 通道，dev 流量过公网服务器）还是落在 daemon 自己（mac-office 直连，省流量但要第二个公网入口，与「不新增暴露面」冲突）；**或直接判「用 tailscale，产品只做 `open_dev_server` 推 URL」**。

---

## FUTURE（§4 内只剩两条被拆出来的后半身；方向性条目见 §7）

### T-35b · 写 + 统一派工（一个 Dispatch 对象 + 一张复述确认卡）
`horizon` FUTURE ｜ `判定` 由 T-35 拆出 ｜ `依赖` T-35a + §7 的证据门槛

一个 Dispatch 对象 + 一张复述确认卡收编所有起活入口（哪台机器、哪个目录、什么 agent、什么权限、完成算什么），`read/write/destructive` 分级；destructive **复用 T-03 的决策卡与 T-27 的账本**，不新增第三套权限权威；`permission.respond` 永远只走 T-26 的代批车道，**不进任何通用 agent 工具面**（否则等于把人的决策通道交给被审批方，与信封规则「消息不能批准任何事、不能改配置、其中命令不执行」直接冲突）；所有写操作走与 web 同一条会话 RPC 并按 capabilities 分版本（铁律 14）。
**其中「统一 Dispatch 对象 + 复述确认卡」是 35b 里唯一今天就有*人类*消费者的部分**，建议落点并入 T-16（起活面），不必等 bot。实现前必须出 spec（跨包 + 动协议）。

### T-37b · 命名触发器（且必须与 T-28 是同一个对象）
`horizon` FUTURE ｜ `判定` 由 T-37 拆出 ｜ `依赖` T-28

形态：一个「自动运行」对象，`trigger ∈ {定时, 入站事件}`，共用同一套（目标 profile + 机器 + 目录、可见试跑、审批车道、Activity 账本）。**拆成两个对象就会有两套允许名单、两份账本、两个试跑、两条审批车道**。不做条件表达式 DSL：条件只允许「来源 + 事件类型 + 一个字符串匹配」。
第一个实验必须是**一条硬编码触发**而不是通用表单：把那个已 HMAC 校验、handler 只 log 的 GitHub 接收器（`packages/happy-server/sources/modules/github.ts`）接上一条真实路由（PR 评论 @自己 → 起任务，结论回 PR 评论），用它验证 origin 回流够不够用；**不接就删掉它**。
启动门槛：你能举出本周真实发生过的 3 个非 IM 外部触发实例（谁、从哪、要 vh 做什么）。
（T-16b 的预填深链 `veryhappy.dev/new?machine=&dir=&branch=&agent=&prompt=` 并入本条——深链的补齐时机是「有东西会生成链接」的那一刻。）

---

## §5 需要你先裁的几刀

> 按 §4 的出现顺序编号，可直接回答「1. A」「2. B」。**若时间有限，先裁下面这 9 条**——它们会改变其他条目的形状：`1`（队列宿主）、`3`（accent 豁免）、`7`（每轮 ref 快照）、`12`（推翻 recoverability 非目标）、`15`（engine 准入门槛）、`16`（推翻 queued-message 非目标）、`21`（chunk 名去 SHA）、`22`（语音链去留）、`24`（author 字段）。
> **其中 `15`(G-03)、`21`(G-01)、`24`(G-04) 来自 critic 补齐的 G-* 条目，未经 6 票对抗评审**——它们没有被三视角 reviewer 试着推翻过，请按「只有作者论证」的强度读，别当成已被对抗审过的刀。

### NOW

1. **T-02 队列宿主**：A 侧栏「状态」镜头（常驻、手机天然是根页；代价：280px 宽列展开决策卡偏挤，要把 board 的 ✓/今日完成/`waiting 4m` 搬过来，**且必须同批把触屏默认 `sidebarView` 改成 `'status'`**——见第 17 条，否则手机上队列仍不是默认镜头）／ B `/board` Lifecycle 页（卡片空间够、✓ 已在；代价：桌面每次分诊都要离开当前页）。**另一个同批删掉。推荐 A**。
2. **T-03 「本会话始终允许」（一刀四选项；原第 14 条已并入此条）**：A 等 T-27a 授权面上线后再放这个按钮 ／ **B（推荐）**卡上自带「已允许 n 项 · 重启即清（展开/收回）」一行——值必须取 CLI 只读 RPC，旧 wrapper 上禁用并写明原因（G-05 是它的实现约束）／ C 降级为「本 turn 内同类自动放行」／ D 把按钮删掉，只留单次批准/拒绝/模式切换。**不可接受的形态只有一个：保留按钮、不给出口。**
3. **T-01 「等你决策」要不要放弃 accent**：**A（推荐）**严格 accent=live，改用 ink + mono 计时 + 永远排最前（代价：最紧急的信号从此没有颜色）／ B 给设计语言开明文豁免 accent =「live 或 blocked-on-you」（代价：teal 从此两个语义，谁都能援引）。**同条第二刀**：T-01 独立成条 ／ 并进 T-02 的实现条款 + 一条着色纠正（这是 critic 的原始建议；注意合并后别把「终端 since 由 daemon 盖戳」这条必做项做丢）。
4. **T-04 延后 vs 标记未读**（不要都做）：**A（推荐）**只做 snooze，有到期时间会自己回来 ／ B 只做 mark unread（本质是没有时限的 snooze，容易积成一片永远亮着的点）。
5. **T-06b IM 腿延迟发**：**A（推荐，N=3min）**等你类延后 N 分钟再发、发前重查已答则不发 ／ B 保持即时 fire-and-forget（桌面 10 秒批掉的请求群里照样弹）。T-06a 是 bug，不需要裁。
6. **T-09 「发现的后续事项」出口**：**A（推荐）**只写成 backlog 候选行，人 triage 后才开工 ／ B Claude 式 task chip 直接起新 worktree 会话（绕过 triage，而活跃区已 31 项非 done）。
7. **T-11 每轮 ref 快照**：**付（推荐）**——「最近一轮」镜头成立，T-25/T-12 都有确定基准；代价是 wrapper 改动、按 capabilities 分版本、存量会话拿不到 ／ **不付**——只做「工作树 / 自起点」两镜头。
8. **T-12 「diff → 输入框」手势归谁**：**A（推荐）**归 T-12（批注与引用共用同一个草稿缓冲，T-31 降为纯 `@文件` 补全）／ B 归 T-31（T-12 本批只剩空壳）。
9. **T-05 boardAnalyzer 生成范围**（**`boardLlm` 在你机器上已经是 `true`**，「先看你会不会去开」的问法作废；投影 + 诚实降级 + 开关搬 Web 无需裁）：A 维持现状——开着就按现有节流生成，含在跑的行 ／ **B（推荐）**收窄为只在 turn 结束、只对「跑完待收/失败」两类行生成。两案都保持代码默认关。
10. **T-10 独立成条还是并入**：**推荐保留独立**——它拥有「队列行展开即读完、不必进会话」这个承诺；若合并进 T-09，务必把「两处渲染」写进 T-09 的验收条款。
11. **T-13 优先级（不是形状）**：把 B-027（ErrorBoundary）+ B-003（RPC 假 ack 收口）提到本批执行，并接受「横幅按原因措辞、词表来自 T-15」这层约束。**若判不做，请顺带明确「宿主机掉线横幅」的去留**（它从被否决的 T-18 并进来，会随本条一起消失）。
12. **T-15 是否显式推翻 `specs/2026-09-session-recoverability.md` 三条非目标**：**A（推荐）**批准推翻，判定下沉为 daemon 单一 revive RPC + 词表收敛（代价：新出一份 spec，B-265/B-268 的 banner 文案要再改一次）／ B 维持非目标，只做表面收敛（代价：两套规则文件与四套词继续存在，第 9 个 spec 大概率还会来）。**gate 在 B-265/B-268 合入之后动手**。
13. **T-14 要不要把 B-279（空闲自动换代 wrapper）提到本批**：推荐两件都做，顺序是「就地原因先落（无协议改动、立刻止血）→ B-279 出 spec 再上」。
14. **（已合并进第 2 条——同一个决定，编号保留占位以免打乱交叉引用）** G-05 不再单独裁；它只承载第 2 条选 B 时的实现约束：值取 CLI 报告的授权集（不是浏览器点击历史）、旧 wrapper 上禁用并写明原因（铁律 14/17）、卡上写死「重启即清」。**注意 G-05 是 critic 补齐条目，未经 6 票对抗评审。**
15. **G-03 engine 准入门槛**：把「四动作（回答/批准/拒绝/停止）+ 一条队列行」定为接新 engine 的**硬门槛**（付不起就不接）／ 只承诺「显式说明不支持」，接受队列在非 Claude 会话上留洞。
16. **T-17 是否显式推翻 `specs/2026-08-queued-message-controls.md` 两条非目标**（不做跨设备队列同步；wire 不新增持久字段）：**A（推荐）**批准，先出 spec 再实现（wire 新字段 + server 持久 + wrapper 侧释放 + web 退化为视图）／ B 不动协议，只加「离开这台设备就作废」的诚实标注与到期清除（手机→桌面这条路径永远断）。**新论据不是「跨设备方便」，是「释放逻辑在客户端 → 指令可以延迟数小时打到已经变了的仓库上」。**
17. **T-08 触屏默认 `sidebarView`（从属于第 1 条，不是独立一刀）**：**第 1 条选 A → 随之改成 `'status'`（推荐）**，否则 A 的卖点「手机上天然是根页」落空、队列在手机上仍不是默认镜头（代价：8 条终端并行时最常用的手动排序列表退到第二眼）／ **第 1 条选 B → 不改**，手机入口靠 T-08a 的芯片提供。
18. **T-07 要不要为「手敲的 claude」扩 terminal-hooks 契约**（PreToolUse/Notification → 真 `agentState.requests`）：做（权限与 plan 有权威源，零屏幕解析；代价：动用户 `~/.claude/settings.json` 的 hook 契约 + 新增一个「谁在替我批」的执法面）／ 不做（终端里的 claude 永远只有「点选已渲染的问题」这一档）。**推荐本批只做第一层。**
19. **T-16 / T-21 合并后的 worktree 所有权（一刀两问，原第 26 条已并入）**：**① 创建**：a 默认隔离（每个新会话自动开 worktree）／ **b（推荐）**产品拥有创建但作为**非默认选项**（`当前 checkout` 默认 / `已有 worktree` / `新建 worktree（从 <base>）`，加「n 个会话在这」的撞车拦截）／ c 产品不创建，只给「开终端并预填 `git worktree add`」。**② 删除**：**d（推荐）**仅工作区视图里的显式清理，有未提交/未推送时阻止 ／ e 产品不拥有删除。**删除永不挂在关闭/归档路径上。**
20. **T-19 侧栏第一层是执行体还是任务**：**A（推荐）**保持执行体，任务只做第四个镜头 + 一个任务页 ／ B 第一层换成任务（必然长出「未归任务」伪组，IA 变更不可回退）。
21. **G-01 chunk 文件名去掉 release SHA、只留内容哈希**（entry 保留 SHA 以喂 B-285 门禁）：做 ／ 不做。做则「每次发版重下」结构性消失；不做则本条只剩换版可见性的体感修补。
22. **T-34 语音链去留**（必须和删页面同刀裁）：**A（推荐）**整条删掉，含 ElevenLabs STT/TTS 与服务端 key 面，手机听写走系统键盘 ／ B 把按住说话挂到普通 composer 当输入法、TTS 降为可选朗读（等于把刚删掉的表面换个位置长回来，并继续背 V-022~026）。
23. **T-20b `/todos`**：**A（推荐）**修——面板保留、条目成为队列的一个来源、agent 可读、同批验掉 V-073/074 ／ B 下线路由，保留 CLI 侧 `todoProvider` 契约。
24. **G-04 现在就把 `author` 写进队列条目的数据模型**（成本约等于零）／ 等真有 bot 时再加（届时要迁移已有条目并改所有渲染点）。**只需要一个是/否。**

### NEXT

25. **T-22 CI 失败推送还是拉取**：**A（推荐）**带闸门推送（只对「你推的、有开着 PR 的分支」入队，同一 head SHA 只叫一次，可对单 PR 静音；代价：闸门写错会漏叫）／ B 只改行状态、人显式说「等它绿」才入队（回到今天的主动轮询）。可折中：按 A 上线但默认静音，观察一周。
26. **（已合并进第 19 条——同一个决定，编号保留占位以免打乱交叉引用）** T-21 的 worktree 所有权按第 19 条一次答完；本条原来的推荐（产品不创建）与第 19 条原来的推荐（产品创建）互斥，已统一为「非默认的创建选项 + 仅工作区视图里的显式清理」。
27. **T-25 独立成条还是作为 T-17 队列对象的一个字段**：推荐后者（它天然是队列属性；独立成条会诱使实现者又做成一档模式）。**若 T-17 被裁掉，它必须独立存在**，否则 T-11 的评审面没有触发器。
28. **T-29 「跑一遍验收」在哪个执行体里跑**：**A（推荐）**在该会话的 worktree 里起一个短命进程（遵守铁律 16，不在原 session id 上开第二个 wrapper）／ B 交回原会话自己跑（自己给自己判分，还污染上下文）。
29. **T-27b 是否随 T-26/T-28 一起裁**：推荐仍按「数据 + 两个既有落点」做（成本是渲染已有的 `completedRequests`）；**绝不为它单开路由**。
30. **T-28 第一版做定时还是也要心跳**：推荐只做「定时发起一次任务」（心跳与单写者锁、归档语义的交互没人交代过；盯 CI 由 T-22 覆盖）。**第二刀**：第一条例行具体是哪件活——它决定 v1 需不需要「注入上次 outcome」。
31. **T-30 额度到点行为默认值**：A 默认「到点自动继续」（恢复瞬间一批会话同时开跑，而你可能不在场）／ **B（推荐）**默认「到点提醒」，继续要你按一下（且不依赖 T-28 就能先落地）。
32. **T-26 你要不要「无人值守时由非人放行」这件事本身**：**A（推荐）**不要——只做风险标注 + 硬边界 + 越界即入队（代价：夜里会停下等你早上一次批完）／ B 现在就做 LLM 代批（mac-office 无沙箱、黑名单在 shell 层挡不住、并在唯一执法点旁再立一个真相源）。
33. **T-32b 跨会话原文检索**：**A（推荐）**只索引派生层（outcome / 决策 / 分支 / PR / tag），**永不为 transcript 建全文索引**（代价：「某句原话在哪」仍要回 mac-office grep 本地 JSONL）／ B 在 relay 里新开一条服务端明文 transcript 索引路径（今天 server 零处解密会话正文，这会是第一处，并给未来任何 bot 打开同一个口子）。
34. **T-31 要不要占一个批次位**：A 进批（引用面 + 发送前解析 + 拖放裁定，@ 补全顺带接线）／ B 退回 B-035 备注，只把「每行一个引用动作」并进评审面。推荐 A；**但如果你认同「代码躺了三周、351 个 commit 都没接 = 不疼」这条显性偏好反证，B 更诚实**。
35. **T-24b 「带简报继续」的产物落在哪**：**A（推荐）**写成当前 worktree 里的 markdown（与 T-19a 同一个文件），新会话首条只是「读 `<file>` 继续」／ B 简报只作为新会话的首条消息（易逝、不可复查）。T-24a 是纯接线，只需决定排这批还是下批。
36. **T-35a 范围与时点**：**A（推荐）**只做最小只读面（`sessions/machines ls --json` + MCP 只读工具 + `reportTo` 泛化），消费者是你自己的 agent 集群 ／ B 读+订阅整套并写进 `docs/channels.md` 成为对外契约（在三个对象还在被重定义时就背上双向兼容包袱）。
37. **T-38 角色带不带家目录与记忆**：A 纯预设（零文件零记忆；但 assistant 现有的 CLAUDE.md + personal.md + journal 无处安放）／ **B（推荐）**预设 + 可选家目录（默认关，只由角色自己的 memory/journal 工具写）。
38. **T-37a 入站/出站要不要变成有保障的投递**：**A（推荐）**不变——保持 tanka-channel 的非目标，只做 B-026 的 3 次退避 + 失败可见（丢得看得见、可追）／ B 推翻那条已 Shipped 的非目标，入站事件落 server 队列可重放（多一套投递状态机 + 重复起会话的去重责任）。
39. **G-02 dev server 反代落在哪**：relay（vh-us server，多一条鉴权 HTTP 通道）／ daemon 自己（省流量但要第二个公网入口）／ **直接判「用 tailscale，产品只做 `open_dev_server` 推 URL」**。

### 方向性（§7）与已否决项的残值

40. **T-39 「门槛达成前不新增任何常驻 bot 表面」要不要升格为写死的约束**（写进 `docs/roadmap.md` 虚拟办公室那节 + 显式拒绝表）：**推荐升格**——成本为零，是唯一能真正阻止第二个 `/assistant` 的可执行条款；不升格的代价是下一个 agent 会把「未来要做虚拟办公室」读成「现在可以先加一个 bot 页面」。
41. **T-36 现在就在队列条目 schema 里给 `author` 留位吗**（与第 24 条同一件事的边界版）：**A（推荐）**留位但**只有「产品自身」与「会话自身」两个作者可写**，`bot` 作者要等门槛达成后显式开启 ／ B 现在不动 schema。注意「省一次迁移」是工作量论证，不能单独作为选 A 的理由——选 A 的真理由是它同时写下了一条**默认关闭的边界**。
42. **T-40 要不要现在就把「控制面 harness 中立」写成 T-35 的验收标准**：**A（推荐）**写成验收标准——同一能力必须有 CLI 与 MCP/HTTP 两种绑定各一个真实调用点 ／ B 只留作方向（极可能在实现时把 SDK/MCP 细节漏进协议面，将来换协调层 harness 要连协议一起重做）。
43. **T-23（已否决）的残值**：若你认为手机端确实需要一个不用打字的收尾入口——先用 `promptPresets` 加一条「按 AGENTS.md 提交、推送、开 PR、补 CHANGELOG」的快捷指令（**今天就能做、零代码**）／ 还是在 T-22 的 PR 区块上加一个单一语义的 `land`（跑 `scripts/land-pr.sh`，输出流式回显）。**推荐先用 preset 试两周。**

---

## §6 被证伪 / 不做

### 本轮判定不做的条目（verdict=kill）

| 条目 | 为什么不做 |
|---|---|
| **T-18 机器健康成为一等信息**（芯片轨 + 掉线横幅 + 筛选 + 任意机器起活） | 四个组成部分里两件已交付、一件属于别条，只剩一件必要。已交付：`NewSessionModal` 只列在线机器、展示 `cliAvailability` 与未安装 agent 的安装命令、目录不存在时 daemon 回 `requestToApproveDirectoryCreation`，且移动端用同一个 modal——「手机可在任意在线机器上起活」今天就能做；机器页 `/machine/:id` 已聚齐 `daemonState`/`cliAvailability`/`claudeAuth`（B-275/B-276 done）。「机器只存在于设置与诊断页」也不准确：侧栏默认镜头就是 `machine+cwd` 分组、组头带机器名（`sidebarWorkspaceGroups.ts`）。真正缺的一条（掉线时产品不开口）已并入 T-13 的全局横幅槽；队列里同机离线条目聚合成一行 → T-02 的渲染规则；机器可用性四校验 → T-16a 的控件。**判定依据不是「Owner 只有一台机器」**（backlog 里出现过同事的 ECS 与 simon 的机器，无法从仓库确认是否同账号），而是「常驻一条几乎恒定的轨」+「点击=过滤并记忆的粘性隐藏过滤器会让会话消失」。**重开条件**：你账号下实际常用 daemon 机器 ≥3 台时，把「按机器筛选」做成 workspace 分组的一个 key，而不是另起一条芯片轨。顺带清理：`showOfflineMachines` 文案在 `text/_default.ts:198` 与全部语言包里都在、web 里零组件消费，归 B-041。**风险提示**：若 T-13 只做工程债部分而不做按原因措辞的横幅，「宿主机掉线时产品要开口」必须单独留下来。 |
| **T-23 Ship bar**（暂存/提交/推送/PR/合并的产品内 git 流） | 缺失是真的（`sync/gitStatusFiles.ts` 只跑 `git status --porcelain=v2` / `diff --numstat`，CLI 无 commit/push/PR handler），但立论的两个前提都不成立：①「要合并 agent 的成果必须离开 vh 去终端」——同机 web 终端就是 vh 自己的一等表面；②你的 ship 路径里根本没有人手工 git 的那一步：agent 自己 commit（带强制 trailer）、自己 push、自己 `gh pr create`，人的动作只有 `scripts/land-pr.sh <pr>`。此外：通用 ship bar 要么绕过 AGENTS.md 门禁与 B-285 changelog 门禁（tag 失败还会烧版本号），要么重实现一遍 `land-pr.sh` 并永远滞后；便宜模型生成的 commit message 连仓库要求的 trailer 与 CHANGELOG 条目都不会带；「随状态提升的主按钮」是模式错误发生器，而 vh 已因「控件说的 ≠ 机器要做的」翻车五次；底部常驻主按钮还与手机 composer/键盘抢同一块位置（V-077 已登记键盘遮挡）。**追加的证伪**：reviewer 提的最小残值「一个『让它收尾』动作」**今天已经能做**——B-052 的 `promptPresets` 是账号同步的快捷指令列表，`PresetsMenu.tsx` 与 `TermPresetsMenu.tsx` 桌面手机同一份，零代码。残值去向：`land` 与「hook 失败/冲突 → 带界交回该会话」并入 T-22 的失败卡；累计 diff 与逐 hunk 归 T-11。**重开条件**：当 T-11/T-12 真做到逐 hunk 选择、且反复出现「只提交这几个 hunk」的需求时，才谈一个窄动作。 |

### 显式拒绝（竞品有、我们故意不学；含本轮评审新增）

| 想法 | 拒绝理由 |
|---|---|
| Cowork Dispatch 式「单一常驻调度线程」 | 官方自陈无法开第二条线程；没有队列的 dispatcher 会退化成聊天。`/assistant` 已用零使用量证明；由 T-02 取代 |
| Grok 式 bot 群聊（2–6 个 bot 同处一会话、`@everyone`） | 单 Owner 没有协调问题；官方自己警告「太多并行交接会产生重复工作」，唯一防线是建议不是机制 |
| Claude agent teams（lead + teammates + 共享任务表 + 文件锁） | 连 Anthropic 自己都是实验、CLI-only、不能 resume；在 outcome 与队列存在前做这层等于把不可靠性藏进模型 |
| Orca 式只有 CLI、无人类视图的编排 ledger | 可靠性押在 42KB 协议 prompt 上，人看不见账本，跑偏要等终端里躺着一段任务文本才发现 |
| 编排脚本 DSL（Grok Build `.rhai`、Claude dynamic workflows、pi SubagentWorkflow） | 瓶颈是判断与注意力，不是扇出的表达能力；引入一门语言 + 运行时 + 审批卡是纯增表面 |
| 让 bot 自动创建 bot | roster 膨胀、审计变难；即使到了虚拟办公室阶段也必须人批准 |
| 人设文件族（SOUL.md / IDENTITY.md / 头像性格）/ 现在就做角色花名册 | 「persona without mechanism」正是今天助手失败的形态；机制（队列、推送、记忆、出口）先于人格 |
| 语音优先的助手台 / wake word / 实时对话 | 只在上线当天被用过；两个真实场景里「按住说话」都不是最省力的输入。见第 22 条裁决 |
| 独立的 Hub 式多租户触发服务（Paseo Hub） | 单 Owner 不需要第二个对公网暴露的服务与第二套鉴权；vh 的入站口本来就是 daemon 的 loopback |
| 云端沙箱会话 / 托管 VM / teleport | vh 的前提是你自己的机器 + 自托管 relay；每多一个执行基底就多一套 onboarding 与能力矩阵 |
| 原生手机 App / 原生桌面 app | 零安装、永远最新的 PWA 是结构性优势；竞品实测问题恰是 store 滞后、36 小时灰度、RN JS stall、配对三通道。**前提是 G-01 成立**。**注意此项与在册 roadmap 直接冲突**：`docs/roadmap.md:79-81` 仍写着「Keep the installable Web/PWA as the default client **while evaluating the retained Tauri shell as an optional desktop client** with tighter operating system integration」，`packages/happy-app/package.json:38-40` 也仍保留 `tauri:dev` 与三个 `tauri:build:*` 脚本——**批准这条拒绝 = 同批注销该 roadmap 条目与 happy-app 的 tauri 构建面**，请当成一次显式裁决而不是顺带结论 |
| 每个任务一个内嵌浏览器 + Design Mode + computer use | vh 本身就跑在浏览器里；Orca 自认它是最大内存消耗项且送不到手机。需要的只是 dev server 可访问 URL（G-02） |
| 插件 / 扩展平台与市场 | 用户只有一个人且能直接改仓库；Paseo 自己的信任模型是「插件是不沙箱的 daemon 代码」 |
| 多会话分屏 / pane tree | 第三方一致反馈「你开始花时间管理窗口」；vh 的答案是队列 + 键盘分诊 + 就地决策 |
| Best-of-N 赛马作为主打流程 | 四家里没有一家有 compare/merge 界面；对单人来说瓶颈本来就是评审带宽，赛马把瓶颈乘以 N 还多 N 倍 token |
| 只读分享快照 / 公开分享链接 / artifacts | 单 Owner 无受众，却要引入脱敏、撤销、公开面一整套风险 |
| Orca 式 yolo-by-default | 直接冲撞结构化权限通道与 `yoloEnforcement`（铁律 14）；「worktree 就是沙箱」在「远程 web 客户端 + 共享 Owner 机器」下不成立 |
| `dontAsk` / `auto` 权限模式枚举（B-263） | 不重提。T-25 的「跑完停一下」与「不问就干」语义相反，且它已改成队列属性而非模式 |
| presence 作为投递门槛（Paseo 180s 窗口） | 已被证明会静默吞掉权限提示（#1764）；**vh 今天更狠，是账号级——这是 T-06a 要修的 bug** |
| 「模型自行决定何时推送」作为唯一通知机制 | 不可配置、不可预期；确定性事件 + presence 路由才是骨架，模型只允许改文案 |
| 定时任务默认 `approval_policy=never`、「测试运行就是真运行」 | 安全上不可接受；用可见试跑 + 审批车道替代 |
| 多套并存的「会话列表」 | 明确反模式「One registry, one list, one truth」；vh 今天已有两套「等我」，T-02 要求删掉其中一套 |
| 手工拖拽的看板列 | 状态必须由事实推导；人拖出来的列会立刻与真相分叉 |
| AI/人类逐行归属 gutter（Orca attribution） | 你评审的是自己 agent 的产出，不存在第二方需要归属 |
| 「关掉 tab = 归档」（Paseo 的历史包袱） | Paseo 作者自承是为了不改用户既有习惯；视图与生命周期耦合是明确的坏设计 |
| 吉祥物 / 浮窗宠物 / 硬件状态键 | PWA 没有常驻原生表面；「先做吉祥物再做状态模型」是明确反模式 |
| 跨机器**搬运**任务 / Handoff | 只有一台开发机；机器筛选与「在任意在线机器上起活」已并入 T-16a。等第二台开发机出现再谈 |
| 跨会话消息 / `@session` 互发（现在就做） | Orca 与 Codex 的共同教训是这些边在人这边不可见；信封规则先写进 T-35 的实现 |
| **（新增）** LLM 代批权限放行 | mac-office 无沙箱、命令前缀黑名单在 shell 层挡不住、并在唯一执法点旁再立一个真相源。门槛见第 32 条裁决 |
| **（新增）** `/decisions` 决策账本页面 | 团队/合规形状；单人的唯一读者是刚做完决定的自己。降级为数据 + 两个既有落点（T-27b） |
| **（新增）** transcript 密度三档模式 | 中间档已经是 B-250 的线上默认；真实增量只是折叠行的信息量。模式本身是操作性上下文（T-33） |
| **（新增）** 文件级 rewind / stash 恢复点 | 在共享 cwd 上原地回退文件与铁律 16 单写者纪律冲突，stash 在产品里不可见不构成恢复路径；**git 本身就是 rewind**（T-24） |
| **（新增）** 通知升级阶梯（叫了不理就加大力度） | 一个人、同一台手机，重复叫不会让决定更早做出，只会让你把通道静音；四家无一先例（T-06） |
| **（新增）** 事件 × 通道 × 时段的通知矩阵 | 给一个人做的三维配置面；B-041 已经躺着 12 项无消费者的设置（T-06） |
| **（新增）** `dismissedRequestIds` / `attentionClearedAt` / `lastSeenSeq` | 重复真相 + 破坏「一 key 一 max」这个让 KV 载体并发安全的唯一理由（T-04） |
| **（新增）** relay 侧生成进展句 | 把模型凭据、常态 token 成本与一条新失败面搬进生产镜像；已认证的 claude 二进制与订阅额度都在机器上（T-05） |
| **（新增）** 侧栏常驻额度百分比 | 订阅制不给窗口余量，`rate_limit_event` 今天被显式丢弃，没有上行就只能估一个数并渲染成事实（T-30） |
| **（新增）** 角色身份色 / 图标 | tokens.css 没有身份色轴，加一族彩色就是给 UI 新增颜色维度；等宽体本来就是机器层身份（T-38） |
| **（新增）** 终端屏幕解析器（「最后一屏问题块 + y/n 选项」） | classifyPane 是刻意粗糙的四态降级信号，且 tmux 输出按版本/locale 被 munge（铁律 19）；猜错一次＝替人按了别的选项（T-07） |
| **（新增）** 合并后自动收摊 / 24h 自动归档 | 由外部状态触发的破坏性自动化；默认关、后果不可见的定时开关正是 B-041 的病，B-177 已有「归档被自动翻回」的前科（T-22） |

---

## §7 未来方向（不是 todo）

这一节回应你的三个未来思考——meta 助手「感觉做的不够好，也不使用」、想参考 grok bot 做成机器人视角 / chief of staff、未来想做虚拟办公室与不同职能的虚拟 bot、可能自己做 harness（第一手用 pi）。**这里没有待办**：三条原本的条目（T-36 / T-39 / T-40）在终审里都被判为「不是一个 item，是一段设计纪律」，它们的可执行残值已经拆进 §4（G-04 的两个字段、T-35a 的只读面、T-38 的角色预设）和 §5 的第 40–42 条裁决。

### 7.1 横向研究得出的两条恒量

跨 grok bot / Grok Build / Cowork Dispatch / ChatGPT tasks / OpenClaw / pi 六个参考，只有两条结论稳定复现：

1. **角色 = (地址, 常驻规则, routine 的归属, 注意力状态, 记忆)——不需要更多**（`adjacent/orchestration.md §7` 恒量 1 原文：「A role/bot is (address, standing rules, owner-of-routines, attention state, memory) — nothing more is needed to feel like delegation」）。人设、头像、性格描述都不在这五元组里；grok 的 chief of staff 就是一个 description 字段，第三方复核原话是「There is no manager Bot type」。
2. **真正减少盯梢的不是更好的 dispatcher，是一个决策收件箱**（恒量 2）：条目说清 来源 / 为什么重要 / 建议的下一步 / **我是否欠一个决定**。grok 的 chief-of-staff 模板、OpenClaw 的 heartbeat 契约 + attention chip、ChatGPT 的「approval pauses the task」、Cowork 的「push when needs go-ahead」全部收敛到这一点。
   另外三条支撑性恒量：完成必须是**推**而不是轮询，且要**带一条 review instruction**（OpenClaw）；**promote, don't author**——例行任务从已经做过的活提升而来，cron 表达式永远不是主 UI；**人进入 worker 会话必须让管理者的假设失效**（OpenClaw 的 signal log），没有这条，chief of staff 是危险的。

**对 vh 的直接含义**：这五元组里，vh 今天有「记忆」（`~/.happy/assistant/` 的 CLAUDE.md + memory/journal，硬编码给唯一一个 variant）与半个「地址」（`spawnedBy` 是自由字符串但 sink 硬绑助手）；没有的是注意力状态、routine 归属与常驻规则的登记表。而恒量 2 说的那个收件箱，正是 §4 的 T-02——**先做队列，再谈 bot**。

### 7.2 meta assistant 为什么零使用（硬证据）

这不是观感问题，是实测：`~/.happy/assistant/` 下 9 份会话 JSONL **全部落在 2026-08-13**（上线当天）；`memory/personal.md` 至今 **315 字节的种子内容、从未被改过**；`memory/journal/` 为空；2026-08-24 起的 1318 个 daemon 日志文件里 **0 条 assistant 记录**。同时 V-022~026 / V-032~034 / V-040 **九项真机验证从 2026-08-13 挂到今天**。

失败的形态可以精确命名，adjacent 研究里就有这个词：**persona without mechanism**——一个人格化的页面，背后没有 scheduler、没有收件箱、没有信号日志。这份研究在点名反模式时**直接点了 very-happy 的 assistant 页**。归因排序（不是「模型不够好」）：①视野比侧栏还窄（工具面是 ≤14 天、最近 15 条、跨机器直接 No local key）；②没有收件箱，它说的话进不了任何出口（`/session-event` 只覆盖 `spawnedBy==='assistant'` 且 5 分钟冷却）；③形态割裂（另开一个页面，而你的日常循环只用侧栏/会话/终端三个表面）；④延迟只排第四（每问一句 = 一整个 Claude turn）。**换 harness 一条都救不了。**

**不重蹈覆辙的唯一路径**：未来任何 bot 的出口只能是**决策队列里的一条条目**，永不再开 bot 页面。这句话应写进 T-02 的 spec 与显式拒绝表。对应的机制已经在 §4 里备好：条目的 `author` 字段（G-04 / 第 24 条裁决）、`spawnedBy → reportTo` 泛化（G-04）、bot = 同账号 headless 客户端而不是 relay 里的新明文路径（T-35a）。存储形态也不新建：给已有的 `/v1/feed` + `sync/feedTypes.ts`（`permission_request|reply_done|input_needed|error` 的 discriminated union，账号公钥加密、服务端读不到正文、跨设备已读）加一个带 author 的变体即可。

### 7.3 T-36 · 方向：未来任何 bot 的唯一出口是决策队列里的一条条目
`判定` 降级为方向 ｜ 原 horizon future

**为什么不是待办**：按它自己的说法，今天要落地的只有「条目结构与作者字段」——那是 T-02 定 schema 时的一刀，已由 G-04 承担。它还重新发明了一个已经存在的对象（`/v1/feed` 收件箱，见上）。而两条你亲手裁掉的先例必须摆上桌：**B-008「更好的通知系统（分级/聚合）」dropped**，理由「需求不具体；通知中心 + webhook 已够用」；**B-141「`notify(text, level)` MCP 工具，agent 主动推站内通知」dropped**，理由「提议级，且与 attention: blocked/review 重叠」——「bot 写进队列」正是 B-141 的加强版。

**现在就钉死的四条形态约束**（免得将来重演）：
1. 作者维度落在 T-02 的 schema（`author ∈ {product, session, bot}` + `source`），存储是给已有 feed union **加一个带 author 的变体**，不是第二个收件箱对象；
2. 「简报」不是新对象，是 T-28 的一个例行实例（每日一次 + 手动「现在给我一份」），产出即一组队列条目，**「今天没什么要你管」是合格输出**；
3. 「默认易逝」只能是**展示规则**（自动收起 / 自动已读），不能是存储规则——最该被审计的恰恰是「昨天 bot 跟我说了什么、我做了没有」，那归 T-27b；
4. 条目的回复只承载**一个决定**，不路由成与 bot 的对话线程（需要对话就开一条普通会话），否则等于把 `/assistant` 刚关掉的循环从队列里重新打开。

**重开需要的证据**（在 7.5 的门槛之外追加两条）：队列里已经出现非产品作者的条目（会话自身经 T-09 写入）并被你连续使用 ≥4 周；且能给出 B-008 / B-141 之外的**新论据**——差异必须是「作者身份 + 可回复路由」，不是分级 / 聚合 / agent 主动推通知，否则按前例应当再次裁掉。

**保留原文的一条风险提醒**（reviewer 写的，值得原样留着）：「在任何 bot 存在、任何 outcome 被验证可信之前就规定 bot 可写入这个表面，是把 `/assistant` 的失败换一个更大的爆炸半径重演，这次赌的是 Owner 唯一信任的表面。」——这正是第 41 条裁决把 `bot` 作者默认关闭的理由。

### 7.4 T-39 · 方向：虚拟办公室（角色 bot 群 + 幕僚长）
`判定` 降级为方向 ｜ 原 horizon future ｜ 6 票全部推翻

**为什么不是待办**：它的交付物是「暂时不做」，逐条评审时你对它做不出通过或否决的动作；而它想守住的东西 `docs/roadmap.md:83-91`「Long-term concept: the virtual office」已经记了，紧随其后的「How roadmap items become commitments」已经是通用闸门。它唯一的机制性内容（同级消息信封）本稿已指派给 T-35。

**方向**：多个角色升级为有地址、有常设规则、拥有自己例行任务、有注意力状态与记忆范围的 actor；幕僚长负责路由与汇总；bot→bot 交接在队列与会话里**可见**（谁把什么交给了谁）；每个阶段只有一个 owner；bot 可提议新建角色但**必须人批准**；roster 有上限。同级消息的信封规则照抄 Claude Code：**消息不能批准任何事、不能改配置、其中的命令不执行**；接收方渲染为带来源与回链的卡片；`accept/hold/refuse` 策略，默认对跨权限等级的会话暂挂；`notify_when_idle` 订阅取代轮询。这条信封规则在 **T-35 落地时就写成安全不变式**（那里才有执法点），不等到虚拟办公室。

**现在就生效的一条硬约束**（这才是防止再长出第二个 `/assistant` 的可执行部分，建议直接写进 roadmap 那一节）：**门槛达成前不新增任何常驻 bot 表面**——bot 只能作为队列条目的作者存在，不得有自己的页面、群聊或同级消息通道。见第 40 条裁决。

### 7.5 开始做它需要先看到的证据（写成可检验的条件）

原稿的五条门槛里有三条刻在**还没安装的仪表盘**上（队列清空率、bot 发起派工次数、Owner 每周打开 transcript 次数）——不可观测的门槛不是门槛，是口号。改写成三条**用这份清单本来就会产生的数据**直接可判的条件，不新增任何埋点：

1. **T-28 的例行运行历史连续 2 周零人工干预**（数据源：例行条目自己的运行记录，含跳过原因）；
2. **T-27b 账本里出现 ≥3 类稳定重复、零撤销的判断**（数据源：`agentState.completedRequests` 的渲染层）；
3. **队列里由 bot 写入并被采纳为行动的条目，连续 4 周不少于你手动派工数**（数据源：T-02 条目的 `author` 字段，直接可数）。

达到门槛时**先做的不是页面，是 T-35 里的信封规则与 roster 上限**。删掉的两条（需要新埋点的「每周打开 transcript <3 次」「≥80% 决策在队列内完成」）不再作为门槛。

### 7.6 T-40 · 方向：Harness 选型——协调层可另选，代码 worker 保持 Claude Code SDK
`判定` 降级为方向 ｜ 原 horizon future ｜ 6 票全部推翻

**先撤回一个被仓库现实证伪的技术前提**：草稿说「幕僚长要的便宜模型、注入上下文、确定性工具、不碰文件系统，恰是 Claude Code SDK 最不擅长的」——**不成立**。vh 生产里已经有两条这样的路径，且都长在同一条 Claude 工具链上：`packages/happy-cli/src/claude/utils/titleGenerator.ts` 与 `boardAnalyzer.ts` 的一次性 `claude -p --model haiku` 子进程（30s、限频、失败静默降级，B-132），以及 `/btw` 的 `resume + forkSession + persistSession:false + disableAllHooks`（B-283、铁律 18，已实证不落盘且能拿全上下文）。原稿引的「一整个 turn 的延迟」出处是**语音链路**，而 T-34 正要退役语音台。结论层面它也已经写在仓库里：`docs/roadmap.md:59-60`「Add adapters only where they improve real workflows. **Pi is a candidate, not a supported integration until it is implemented and tested.**」

**方向（对你的问题的答复）**：**代码 worker 永远保持 Claude Code SDK**——权限回调、hooks、skills、订阅计费、`/btw` fork 全押在它上面，换掉就是把这些重写一遍。**协调层（简报、幕僚长、复核）可以另选 harness**（pi-agent-core 或直接 API），但**今天没有必要**，因为便宜、确定、无文件系统的旁路在现有工具链上已经跑了一年多。adjacent 研究的原话是：没有任何观察支持把 Claude Code 换掉作为代码 worker，所有观察支持的是**不要让它当幕僚长**。

**现在就必须交给 T-35 执行的一条约束**（留在 FUTURE 就一定会漏掉）：**控制面即协议**——读 / 订阅 / 写三面以 vh 自己的 happy-wire schema 定义，同时至少有 CLI 与 MCP/HTTP 两种绑定，任何一种绑定都不得是唯一实现，也不假设调用方跑在 Claude Code SDK 上。做到这条，「某个角色跑在哪个 harness 上」按定义就退化成实现细节，不再需要一条待评审的选型条目。见第 42 条裁决。

**给未来简报的实现口径**：简报与队列条目由一次性便宜调用产出（沿用 titleGenerator/boardAnalyzer 先例：`claude -p --model haiku`、限频、失败静默降级为无条目），**不是一个常驻 bot 会话**；这也顺带消灭了「秘书慢」这个症状。

**换 harness 的证据门槛（压成两条可核验的）**：①先用现有 haiku 路径实测一条简报/队列条目的端到端延迟与成本，并证明它是瓶颈；②出现第二个 provider 的**真实需求**（不是偏好）。删掉原稿里「≥70% 的 bot turn 是纯读 + 总结」这类要先有 bot 才能统计的循环门槛。

**为什么不与 7.4 合并**：虚拟办公室是产品形态决策，harness 是工程选型决策，两者的重开触发条件与执行者都不同；合并会让 7.6 里唯一现在就要执行的协议约束再次被埋掉。

---

## §8 取证与来源

### 研究文件清单（全部 2026-09-03 生成，只读取证）

| 路径 | 它证明了什么 |
|---|---|
| `self/product-map.md` | vh 的全部产品表面、路由与组件落点；「permission 只能在 transcript 底部审批」「常设授权无查看/撤销入口」等缺口的原始编号（§6.x） |
| `self/pains-and-planned.md` | 已知痛点带证据（终端几何 ~30% 投入、权限模式骗了 5 次、90 项待验最老 2026-08-13）+ 已规划项，用于与竞品分析去重；§6 是五个第一性弱点 |
| `self/workflow-layer.md` | 工作流抽象层现状：五个缺口（账号级读取面 / 事件订阅 / outcome / bot 出口 / 角色模型）、daemon spawn 参数面、`HAPPY_SPAWNED_BY` + `/session-event` 骨架、assistant 零使用的 JSONL 与日志证据 |
| `vendors/claude-code-desktop-rc/{inventory,flows,orchestration}.md` | 四态词汇与 peek-and-reply、diff 行评论批量提交、CI status bar、cross-session messaging 的信封规则、Desktop 定时任务的 Always-allowed 面板、presence-aware push |
| `vendors/codex-desktop-remote/{inventory,flows,orchestration}.md` | run location + Handoff、`Last turn` diff 镜头、逐 hunk stage、`⌘⌥A`/`⇧Esc`、`Approve for me` 的沙箱承重件、`codex_tui` 任务工具、Scheduled 视图即收件箱 |
| `vendors/paseo/{inventory,flows,orchestration}.md` | 状态分组 + `statusEnteredAt` + priority unmasking、`clear_attention` 在 host 侧、presence 门事故 #1764、Auto Review、in-app GitHub 流、per-worktree dev server URL、Hub 的四类未路由原因；**以及 `/alternatives/happy-coder` 对上游的逐项判词** |
| `vendors/orca/{inventory,flows,orchestration}.md` | 一套 glyph 贯穿五个表面、`Cmd-J` 空态规则、Annotate AI Diff 的批处理理由、Restart chip + 幸存矩阵、worker contract（结构化 `ask` 而非 TUI prompt）、yolo-by-default 与「approvals are text, not decisions」这两条反面 |
| `vendors/adjacent/orchestration.md` | grok bot / Grok Build / Cowork Dispatch / ChatGPT tasks / OpenClaw / pi；§7 的两条恒量与五元组；§10「persona without mechanism」反模式（点名 vh 的 assistant 页） |
| ~~`synthesis/candidates-{A,B,C}-*.md`~~ **未归档** | 三路独立合成的原始候选清单（日常循环 / 第一性原理理想产品 / 幕僚长方向）。其内容已被 `merged-draft.md` 合并、再被本文档改写，只留在生成时的会话临时目录里，随会话消失 |
| `merged-draft.md` | 40 条合并稿（本文档的输入），含产品论点与显式拒绝表 |
| `critic.md` | 完备性 critic：保留集内部的 5 处依赖断裂（G-04 / G-05 两条就是它点出来的）+ 全稿从未覆盖的两处（PWA 更新时刻 → G-01；dev server 可达 URL → G-02） |
| ~~`synthesis/verdicts/T-*.json`~~ **未归档** | 每条的 6 票对抗评审逐票理由（本文档 §4「被挑战与让步」的来源，只覆盖 T-01…T-40）。原始 JSON 随会话消失，**本文档每条的「被挑战与让步」段是它唯一留存的形式**——评审时若想追某一票的完整原文，已经追不到了 |

代码事实全部在本机 `main@796565d5` 上核实；线上事实（`AppRoot` 590,599 字节、entry 资产名）2026-09-03 对 `veryhappy.dev` 实测。

### 已知局限（请据此打折）

1. **竞品只读公开文档、变更日志与截图，没有实际使用 Paseo / Orca / Codex / Claude Desktop 的付费账号跑一遍**。凡是标 OBSERVED 的都能追到 URL，但「用起来是什么感觉」「这个机制在真实并发下是否成立」没有第一手证据；竞品报告（`vendors/**`）里第三方 hands-on 与官方文档已分开标注（OBSERVED / INFERRED），但 §2 表格已压缩掉这层区分；抓取到的竞品原始页面（`raw/` 快照，约 5 MB）按 `docs/competition/AGENTS.md` 的规矩未入库。**其中一条要单独点名**：§3 强项 1「Paseo 终端没有 tmux 式 durability」属于**缺席证据**（raw 全量 grep 中 "tmux" 0 命中 → 研究者标 INFERRED），不是竞品自己承认的短板；vh 头号差异化优势的证据等级到此为止，别再往上抬。
2. **reviewer 被明确要求「拿不准就判推翻」，所以可能误杀**。T-25（6/6 推翻）与 T-33（5/6 推翻）都是被推翻后我重写形态并保留的；反过来 **T-04 / T-11 / T-34 三条是 0/6 推翻**（全票保留）。**推翻票数不是价值排序**，请按 §4 各条的「被挑战与让步」自己判断。
3. **多处草稿事实错误是在终审阶段才被代码核实推翻的**（T-01 的「三套并行分类」、T-02 的「没有任何队列」、T-04 的「未读只是内存态」、T-13 的「白屏丢输入」、T-20 的「/todos 无消费者」、T-24 的「fork 是死代码」、T-31 的「打错路径=一轮作废」、T-37 的「入站没有允许名单」、T-40 的「SDK 做不了便宜旁路」）。这说明**同类错误可能还有残留**——任何一条实施前应先重跑一次代码核实，不要直接照本条的 problem 段落动手。
4. **使用量证据只有 `/assistant` 一条是硬的**（JSONL + 日志 + 文件 mtime）。其余「你会不会用」的判断都是推断；T-31 的「三周没接线 = 不疼」这类显性偏好论证已原样交给你裁决，没有替你下结论。
5. **移动端相关的所有提案都缺闭环验收基线**：verify-queue 90 项待验、最老 2026-08-13，移动端从未被闭环验收过。手机形态的每一条（T-08、T-03 的手机卡、G-01 的蜂窝网首屏）都应当**当批验收**，不要再往 verify-queue 里堆。
6. **本文档不含工作量估算**，因为你明确要求不计工作量。但 §5 的裁决顺序隐含了依赖关系：`1 → 2/3 → 其余`，先裁的那 9 条会改变后面若干条的形状。
