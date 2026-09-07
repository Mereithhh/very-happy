# very-happy 优化 TODO — 合并稿（编辑合稿，供 Owner 逐条评审）

> 输入：`candidates-A-daily-loop.md`（日常循环视角）、`candidates-B-first-principles.md`（理想产品视角）、
> `candidates-C-chief-of-staff.md`（幕僚长/编排视角）；取证底图 `research/self/{product-map,pains-and-planned,workflow-layer}.md`
> 与 `research/competitors/{claude-code-desktop-rc,codex-desktop-remote,paseo,orca,adjacent}/*.md`（均 2026-09-03）。
> 规则：不受现有架构与代码约定约束、不计工作量；horizon 只表示**依赖与价值顺序**，不表示大小。
> 每条都要能被怀疑者接受为**必要**。三份清单意见不一致的地方**保留分歧**，写在「问题」里，标 `⚔ 分歧`。
> 设计语言约束照旧：穿在浏览器里的终端、克制 ink/mono、teal 只表示 live。

---

## 0. 产品论点（这份清单服务的唯一命题）

very-happy 的瓶颈不是 agent 的产能，而是 **Owner 一个人的判断带宽**；而今天产品的基本单元是**进程**，
三个日常表面（侧栏、会话、终端）都只回答「发生了什么」，没有一个表面回答「下一个需要我拍板的是什么、拍完就走」。
于是 Owner 本人就是调度器：轮询列表、逐个点开、滚到底做一个一比特的决定；评审与交付（累计 diff、PR、CI、合并）
100% 发生在产品之外的终端里；跨设备时未读与排队消息还会失忆。四家竞品在完全不同的架构下收敛到同一个答案——
**一套状态词汇、一个按「谁在等我」排好的可清空队列、决定就在队列里做完、每行有一句由模型或 agent 写的话说明发生了什么、
读 diff 能直接变成下一条指令、闭环终点是合并而不是「agent 说完了」**。因此这份清单只做四件事并主动做减法：
①把活动压成一小队可就地作答的决策；②让「结果」有结构化表示，人和 bot 都不必重读 transcript；
③把评审到合并搬进产品；④删掉不服务于这个循环的表面。未来的幕僚长/角色 bot 不靠再开一个 bot 页面实现——
`/assistant` 已用零使用量证伪——**唯一不重蹈覆辙的路径是把这个队列做成 bot 可以写入、可被审计的收件箱**。

---

## NOW

### T-01 · 一套状态词汇，一处判定，处处渲染
- **horizon** now ｜ **category** foundation ｜ **size** M ｜ **来源** A-01 / B-02 / C-01
- **问题**：今天「等我」有三套并行表面且语义不完全一致（侧栏 Status 视图、看板 Waiting 列、通知铃面板，`product-map §6.1`）；
  终端行只有 `needs_input` 没有未读；侧栏排序策略换了 4 次后**被禁用**（`pains E5`：B-070/B-067/B-076）——因为排序回答不了
  「下一个该处理谁」。第一性原理：所有下游（队列、通知、bot 判断、角标）都建立在「哪条在等我、等了多久、为什么」这一个位上。
- **提案**：一张词表全端唯一：`等你决策`（reason: permission / question / plan / CI 失败 / 终端待输入）、`在跑`、
  `待评审/待收`、`已完成`、`失败`；每条带 `since` 与 `reason`，对结构化会话、镜像会话、web 终端、接入的 tmux 一视同仁。
  采用 Paseo 的 **priority unmasking**（高优先原因清掉后回落低优先，`since` 不重置，否则「等了 2 小时」会显示成「刚刚」）。
  判定只有一个纯函数（把 `boardItems.lifecycleOf` 提升为唯一事实源），被侧栏行、看板卡、队列行、⌘K 行、通知文案、
  浏览器标题、PWA 角标、webhook 正文共用。teal 只给 `在跑`/live；`等你决策` 用 ink 高反差 + mono 计时，不引入第二强调色。
- **证据**：Claude agent view 分组 `Pinned/Ready for review/Needs input/Working/Completed` + 计数进终端标题与 `← 2 agents` 页脚
  （`claude-code-desktop-rc/flows.md §1.3`）；Codex `Running/Needs input/Ready/Blocked` 同一套投影到 Activity 视图、pet、
  硬件键、手机 Priority 视图（`codex/flows.md §3`）；Paseo workspace 状态枚举 `needs_input|failed|running|attention|done`
  + 四桶 + `statusEnteredAt`（`paseo/inventory.md §4`、`flows.md §0.1`）；Orca 一套 glyph 贯穿 sidebar/tab/palette/mobile
  （`orca/flows.md §2`）。自身：`pains E5/E1`、`product-map §6.1`、`sidebarStatusView.ts`/`sidebarAttention.ts`/`boardItems.ts` 已同源、B-085 两级信号点是雏形。
- **替代/扩展**：确立 `boardItems.lifecycleOf` 为唯一分类器；替换侧栏 Status 视图 / 看板 Lifecycle 列 / 通知类别三套分类；扩展 B-085；吸收 B-069b（冷终端上浮）判定。
- **依赖**：—
- **必要性**：四家竞品都把同一套词投影到所有表面；vh 的三套并行分类是用户每次都要重新翻译的税，也是「排序换四次然后禁用」的根因。

### T-02 · 决策队列：一个可清空、可就地作答的收件箱（含键盘分诊入口）
- **horizon** now ｜ **category** attention ｜ **size** L ｜ **来源** A-01 / A-11 / B-03 / B-26 / C-02
- **问题**：N 个 agent 并行时的核心循环是「下一个需要我的 → 决定 → 回去」。今天没有任何有序、可就地决策、可清空的队列；
  三套表面都是「看」的不是「办」的；roadmap 承诺的「决策/阻塞回流」零代码；B-032（列表内直接批权限，Owner 自称
  「多会话并行的最高频点击链」）自 2026-08-13 todo 至今。桌面上从「知道有人等我」到「站到那个决定面前」还要经过
  看列表 → 认出哪行 → 点击 → 滚动；`⌘1-9` 只在侧栏挂载时可用且按位置而非紧急度（`product-map §1.3/§6.20`）。
  **⚔ 分歧**：A 主张**不新增表面**，把队列做成侧栏所有镜头之上的一条常驻带（`等我(n) / 在跑 / 今天完成`），
  理由是减面与验证带宽；B/C 主张做成**一等表面**（`/inbox`，可设为登录后首页、手机根页），理由是「队列是主循环，
  不该是列表的附属」。两者对内容与动作的定义一致，只是落点不同——请 Owner 先裁这一刀。
- **提案**：内容不是会话列表，而是**欠我一个决定的事项**：主体（会话/终端/任务/定时运行/机器）+ 原因 + 一行「为什么重要」
  + 建议的下一步 + 等待时长 + 来源（machine · cwd · 标题）。三段：`需要决定`（可就地办）/ `跑完待收`（读 outcome、✓ 或追问）/ `出错了`。
  办完原地消失，留在「今天」区可撤销；空态即产品目标（「没有等你的事」+ 最近 3 条已办）。
  键盘：`j/k` 移动、`Enter`/`Space` 展开决策卡、`1..9` 直选项、`.` 跳下一个欠决策、`Shift+Esc` 全部已读；
  `⌘K` **空查询**不再列全部 Actions，而是「等你决策 → 待评审 → 在跑」前 6 行带 `⌘1..6`，打开期间成员冻结、
  省略你正在看且无待办的那个；无匹配时首行是「新建：<输入的文字>」。
- **证据**：Claude agent view 的 peek-and-reply「Most of the time the peek panel is enough and you don't need to open the full
  transcript」+ `waiting 3m` 时钟（`claude-code-desktop-rc/orchestration.md §2.2`）；Codex Activity view + `⌘⌥A` next chat
  needing attention + `⇧Esc` clear all unread（`codex/flows.md §3`、`inventory.md §4`）；Paseo `Waiting on you` 桶 +
  `workspace.clear_attention`（host 侧执行、对未加载会话也生效、支持批量，PR #1317）；Orca `Cmd-J` 空态 = needs-you → done → idle
  六行 + 数字键 + 成员冻结 + 省略当前 idle tab「so the list stays actionable」（`orca/orchestration.md §3`）；
  adjacent 横向结论「真正减少 babysitting 的是 decision inbox」（`adjacent/orchestration.md §7`）。自身：`pains §6.4`、B-032 todo、B-039/B-043 dropped（新论据：诉求不是「加更多命令/过滤器」，而是回答「下一个是谁」）。
- **替代/扩展**：实现并超出 B-032；以新论据推翻 B-039、B-043 的 dropped；与 `specs/2026-08-workspace-context.md` 非目标
  「不做 review queue」冲突——新论据：那条非目标是对 workspace lens 的范围声明，这里是账号级、跨机器、可执行的另一个对象。
- **依赖**：T-01、T-04
- **必要性**：这是 Owner 自己认定的最高频点击链今天缺的容器；队列存在但要用鼠标找等于没有队列。

### T-03 · 就地决策卡：批准 / 本会话始终允许 / 拒绝 / **改口令**（桌面与手机同一张卡）
- **horizon** now ｜ **category** decision ｜ **size** L ｜ **来源** A-02 / A-18 / B-11 / C-03
- **问题**：权限审批只能在会话页 transcript 底部做（`product-map §6.2`、`J3`）；侧栏行、看板卡、通知条目都不能就地决定；
  通知正文只有类别（「Asking to run a tool」）不含它到底要跑什么。每个一比特的决定要付一次导航往返 + 一次滚动 + 一次返回。
  手机上「回答」= 在三行 composer 里打字或在 xterm 底栏按键。
- **提案**：一个可复用组件，出现在队列行展开、侧栏行右键/长按、看板卡、通知面板条目、以及手机推送深链的落地页：
  权限请求 = 工具名 + 参数（Bash 显示完整命令，文件工具显示路径）+ `批准 / 本会话（或本任务）始终允许 / 拒绝 / 改口令`；
  AskUserQuestion = 选项按钮（含 Other）；ExitPlanMode = 计划摘要 + 批准/驳回；`跑完待收` = outcome 摘要 + `✓ 完成 / 继续追问 / 打开会话`。
  **`改口令`** = 一行输入框，回车即 deny + 把这句话作为 steer/queue 送进同一 turn（把拒绝变成指令）。
  每张卡带 `waiting 4m`、来源、以及**是谁在等**（子代理发起的请求标出来源子会话）。处理完自动前进到下一条，支持连批。
  手机形态：大按钮 + `继续/可以/先别动` 常用回复芯片（复用 Snippets）+ 系统听写 + 相机/相册直接进 prompt。
  通知（本地/Push/webhook）正文改为携带**请求正文**而不是类别词。决策后原地反馈，失败必须显式（受铁律 17 约束：先查 RPC `error` 字段）。
- **证据**：Claude peek-and-reply（`Space` 展开精确问题 + 编号选项 + `Tab` 填建议回复）（`claude-code-desktop-rc/orchestration.md §2.2`）；
  Codex 手机审批卡 `Approve / Always approve / Tell Codex what to do / Deny`，桌面 Enter 批 / Esc 拒 / ⌘Enter 带反馈
  （`codex/inventory.md §8`、`orchestration.md §6`）；Paseo `list_pending_permissions`/`respond_to_permission` +
  「agent 等权限时发消息会先 deny 再把消息送进同一 turn」（`paseo/orchestration.md §8`、`flows.md §3`）+ 通知会摘要
  Claude 要什么输入（`paseo/flows.md §7`）；Orca 反面：手机上审批只能打 `y/yes`，「approvals are text, not decisions」
  （`orca/flows.md §3.3`），其 canned replies + dictation 则是正面（同节）。自身：B-032 todo、`product-map §2.4` PermissionCard
  已有全部数据结构、`agentState.requests` 是权威源（`workflow-layer §4.2`）；受铁律 14 约束（普通 approve 不得带 `mode`）。
- **替代/扩展**：B-032 的实现形态，并升级为跨五个表面复用的同一张卡；扩展 Snippets（`⌘.`）到手机决策卡。
- **依赖**：T-02
- **必要性**：这是 Owner 一天里重复次数最多的动作，今天每次都要付整整一次页面往返；队列若不能就地办，就只是第八个通知面板。

### T-04 · 未读与「已处理」跨设备落账号，不再是内存态
- **horizon** now ｜ **category** attention ｜ **size** S ｜ **来源** A-03 / B-02 / C-01
- **问题**：未读是**内存态、换设备即丢**，只有「已读」跨设备同步（`product-map §2.3/§6.1`）。早上手机上看到的未读与昨晚桌面上的
  处理进度无关；在手机上分诊完，回到桌面又是一片新的。队列只要不可信，人就会退回逐个点开。
- **提案**：把 `useSeenTracker` 的已读水位扩成**每会话/终端一条 attention 记录**（账号 KV：`lastSeenSeq`、`attentionClearedAt`、
  `dismissedRequestIds`），实时推送到所有客户端：灰点在任一设备打开或点「已处理」后全端消失；队列计数全端一致；
  提供显式 `标记为未读`（右键/长按）用于「我看过了但等会儿再处理」。
- **证据**：Orca 右键 `mark unread`「triaged 了但想稍后回来」+ bell 未读跨 worktree + Dock badge 镜像（`orca/flows.md §2`）；
  Codex `⇧Esc` clear all unread、`⌘⇧U` mark unread、pinned 集合 desktop↔iOS 同步（`codex/inventory.md §4`）；
  Paseo `workspace.clear_attention` 在 host 侧执行、对未加载会话也生效（PR #1317）。自身：`product-map §1.3` 已做了「已读」的一半。
- **替代/扩展**：扩展 `useSeenTracker` / seen 水位 KV。
- **依赖**：—
- **必要性**：Owner 一天至少四次在手机与桌面之间切换；队列每次切换都失忆，T-02/T-03 的价值直接归零。

### T-05 · 每行一句话：现在在干嘛（agent 自写优先，便宜模型兜底，**默认开**）
- **horizon** now ｜ **category** orientation ｜ **size** M ｜ **来源** A-04 / B-10 / C-06
- **问题**：行副标题是 `host · agent · 摘要`（静态标题级），「它现在在干嘛/产出了什么」必须点进去看；看板的一句话进度依赖
  `report_progress` 或 daemon haiku 旁路，而后者**默认关闭且只能在机器的 `~/.happy/settings.json` 里开**
  （`product-map §2.7/§6.4`：「默认关闭意味着大多数用户看板卡片永远没有进度句」）。`report_progress` 只有 Claude 有、
  30s 节流、15min 新鲜期，且没有「我卡住了/我需要一个决定」的语义——Codex/Gemini/OpenClaw 会话在看板上永远是哑的。
- **提案**：每个会话行/看板卡/队列行固定携带一行 **headline**。来源优先级：①跨 agent 的 `session_status {state, line, ask?, next?}`
  工具（ACP/Codex/OpenClaw bridge 一并注册，纪律：先读后写、不覆盖人写的目标、卡住必须写 `ask`）＞②便宜模型在 turn 结束写一次、
  运行中节流刷新（**改由 relay 侧兜底，不再依赖机器本地开关**）＞③最后一条 assistant 文本截断。**默认开启**，开关搬到 Web 的
  Appearance（今天那里只有一段说明文字），提供「省钱模式」= 只在 turn 结束写。没写状态的会话不伪装成有进展，显示 `no update · 12m`。
  同一句话复用为：侧栏副标题、看板卡进度句、队列标题、通知正文、webhook 正文、手机列表行、`⌘K` 结果行；终端行同样有。
- **证据**：Claude agent view 行摘要由 Haiku 级模型写、运行中 ≤15s 刷新、turn 结束重写，官方称之为把「raw tool call text 换成
  colored state word + classifier-written headline」（`claude-code-desktop-rc/flows.md §1.3`、`orchestration.md §3`）；
  Orca `orca worktree set --comment/--workspace-status`「keeping human collaborators in the loop without forcing chat」+ read-before-write
  （`orca/orchestration.md §3`）；Paseo 小模型 haiku→gpt-5.4-mini→minimax 回落链生成标题/分支/commit/PR 并可按 repo 覆写措辞
  （`paseo/inventory.md §5/§15`）；OpenClaw 每会话 live digest headline 同时是侧栏副标题与手机列表文案（`adjacent/orchestration.md §5`）。
  自身：`product-map §6.4`、B-132、`metadata.board.progress`/`boardAnalyzer` 已存在但默认关。
- **替代/扩展**：扩展 B-132/`boardAnalyzer` 的产物到侧栏、队列与通知；把 `boardLlm` 机器本地开关从「唯一来源」降级；把 Appearance 的说明文字变成真开关。
- **依赖**：T-01
- **必要性**：没有这句话，队列排得再好也只能告诉他「该看谁」，不能告诉他「要不要现在看」，他还是得逐个点开。

### T-06 · 通知：presence 只做路由，不做投递门槛；一处处理，全端安静
- **horizon** now ｜ **category** notification ｜ **size** M ｜ **来源** A-13 / B-09 / C-04
- **问题**：7 个信号源（铃、看板、侧栏点、webhook、web push、提示音、PWA badge）；presence 门只覆盖 web push，
  webhook/IM 明确 `PRESENCE-INDEPENDENT`（群里重复轰炸），提示音只看当前页面可见（`pains E4`、`pushDispatch.ts` 注释）；
  webhook 零重试（B-026，IM 抖动 = 通知永久丢）；没有分级、没有升级、没有「我处理了全端安静」。B-008 曾以「需求不具体」dropped。
- **提案**：事件集合确定化，只有三类可推：`需要决定`（权限/问题/plan/终端待输入/CI 失败）、`跑完待收`、`失败`；模型只允许改文案，
  不得新增推送事件。规则写死：**「等你类」永不因 presence 抑制**，只做**去重**（同一请求跨渠道只提醒一次，任一端处理后其他渠道撤回）；
  「完成类」若任一客户端最近 N 秒可见且聚焦该主体则只更新角标；webhook/IM 纳入同一判定。升级阶梯：`需要决定` 超 N 分钟未处理升级一次
  （浏览器通知 → push → IM），每条最多升一次。断线期间产生的决策进服务端队列，重连后按序补齐并提示「你离线时有 2 个决策已补齐」。
  webhook 指数退避重试 + 投递失败进诊断。设置从「四类开关」改为「事件 × 通道 × 时段」小矩阵 + 免打扰。推送点击直达决策卡（T-03），不是会话底部。
- **证据**：Claude RC 在你于该终端打字/聚焦时跳过推送，`CLAUDE_CLIENT_PRESENCE_FILE` 把「我在这台机器前」纳入抑制，并有明确
  reconnect queueing 契约「queues messages, permission prompts, and status updates … delivers them once the connection recovers」
  （`claude-code-desktop-rc/inventory.md §8/§10`）；**反面**：Paseo 180s presence 窗口曾让**权限提示整类不推送**
  （issue #1764，`paseo/inventory.md §12`）；Orca 无 presence 抑制，看着的面板跑完照样响铃（`orca/flows.md §3.2 Friction`）。
  自身：`pains E4/E3`、B-026 todo、B-008 dropped（新论据：事件集合已被 T-01/T-02 具体化，不再是「不具体」）。
- **替代/扩展**：扩展 `pushDispatch.ts` 的 presence 门到 chime/webhook/IM；实现 B-026；以具体可测试规则复活 B-008。
- **依赖**：T-01、T-02、T-04
- **必要性**：队列的价值等于它的可信度——漏一次权限请求或多响一次，人就会退回「自己巡视」，整层投资归零。

### T-07 · 终端里等输入的 agent，也能在队列里被回答
- **horizon** now ｜ **category** decision ｜ **size** M ｜ **来源** A-15 / B-11 / C-03
- **问题**：终端里手敲的 claude 有只读结构化镜像，但镜像**看不到 TUI 审批对话框**，只有一条「Claude is waiting for input in the
  terminal → Switch back」横幅；手机上意味着切回 xterm 用底栏按键（`product-map §2.4/§6.2`、`J3`）。于是「终端里的 agent」
  在注意力队列里是二等公民：能报 needs_input，不能被回答。
- **提案**：镜像流识别到 agent 处于 needs_input 时，渲染成 T-03 的同一张决定卡：展示检测到的提示原文（最后一屏问题块）与可选项
  （`y/n`、编号选项），按钮通过既有 bracketed-paste 通道把对应按键/文本 + 回车送进 pane（唯一写入通道不变，保持镜像只读原则）；
  无法可靠解析时降级为「一行输入 + 发送」，并保留 `切回终端` 兜底。手机上这张卡出现在队列里，不需要打开 xterm。
- **证据**：Claude RC 让权限提示与 AskUserQuestion 在远端设备上**永不过期**直到被回答（其余对话框 5 分钟）
  （`claude-code-desktop-rc/inventory.md §7`）；Codex 手机审批卡四按钮（`codex/inventory.md §8`）；
  Orca 反面：Manual 模式下手机只能靠 scrollback 打 `y/continue`（`orca/flows.md §3.3`），而其 Chat UI 会把 AskUserQuestion
  渲染成带 Submit 的卡片（`orca/inventory.md §6`）。自身：`product-map §6.2`、B-105 镜像、B-271 镜像 reconcile、MirrorInputBar 写入通道已在。
- **替代/扩展**：扩展 terminal-mirror（`specs/terminal-mirror` 的「只读」非目标不变：写入仍走既有 paste 通道）。
- **依赖**：T-03
- **必要性**：Owner 与同事大量工作发生在 web 终端里；这些 agent 今天在队列里只会亮灯不会被回答，队列因此是不完整的。

### T-08 · 手机：让「下一个决定」在任何页面上都触手可及
- **horizon** now ｜ **category** mobile ｜ **size** M ｜ **来源** A-12 / B-27 / C-12
- **问题**：手机没有底部导航，看板/通知/Todos/Notes 都要**先回根侧栏**；通知铃在会话详情页不可达（`product-map §5/§6.20/§6.21`，
  B-046 dropped）；推送落地在会话底部而不是要决定的地方；根页面是一个为桌面设计的会话列表。而「离开桌面也能推进」正是 vh 的差异化，
  同时 `pains F4` 说明移动端从未被闭环验收（待验 90 项，最老 08-13）。
- **提案（⚔ 三方分歧，请 Owner 裁）**：
  - **A**：**不改导航结构**，在所有手机路由常驻一个右下角注意力芯片 `⚡3`，点击从底部升起队列 sheet，在 sheet 内展开决策卡、
    处理完自动前进；芯片为 0 时降为极淡轮廓；终端页让位给底栏。理由：最小侵入、不与终端底栏打架。
  - **B**：手机根页 = **舰队状态页**（顶部「3 个等你 · 2 个待评审」大按钮 → 队列；在跑卡片列；机器行；快速动作）+
    **底部四 tab**（决策 / 任务 / 终端 / 我），任何详情页都能看到未读角标。理由：三家竞品的手机首页都是状态页而非列表页。
  - **C**：手机根路由**直接就是收件箱**（设置里可改回列表），左滑 snooze、下拉刷新、PWA badge = 需要决定的条数、
    推送深链 → 决策卡 → 「回收件箱 / 打开会话」两个出口。
  共识部分（无论选哪个都要做）：推送深链落在决策卡；PWA 角标 = 需要决定数；决策卡主按钮在拇指区；详情页可达未读入口。
- **证据**：Orca 手机首页就是 fleet 页（统计 tile、DESKTOPS 主机卡 `● Connected · 200 worktrees · 47 active`、RESUME、TASKS、
  ACCOUNT USAGE、两个快速动作）且 push 深链到 worktree+pane（`orca/flows.md §3.3`）；Codex iOS Priority view 把
  running/unread/awaiting 顶到最上（`codex/inventory.md §4`）；Claude 手机 Code tab 用 Devices 卡 + 一行一状态词的大字排版
  （`claude-code-desktop-rc/flows.md §1.2`）；OpenClaw 把 pending approvals 做成 sidebar 之上的 attention chip（`adjacent/orchestration.md §5`）。
  自身：`product-map §5`、B-046 dropped（新论据：诉求不是「详情页要有铃铛」，而是「决定要能在不返回的情况下做完」）。
- **替代/扩展**：以新论据取代 B-046；是 T-02/T-03 在手机上的落点。
- **依赖**：T-02、T-03
- **必要性**：Owner 离桌时间不短，手机上每个决定今天要付 2–3 次导航；这是移动端唯一真正值钱的结构改动。

### T-09 · 结构化 outcome：每轮/每会话产出机器可读的结果
- **horizon** now ｜ **category** outcome ｜ **size** M ｜ **来源** B-20 / C-05
- **问题**：「跑完了」今天只有一个标题（`metadata.summary`）、一行可选 LLM 进度（默认关）、和一堆 transcript；
  `workflow-layer §5 缺口 3` 明确「没有会话 outcome 的结构化表示」；助手只能复述被截断的转写（`workflow-layer P6`）。
  B-260 的子代理 `stop{status,result,usage}` 是仓库里唯一接近的形状，但只在子代理层。
- **提案**：turn 结束（以及会话结束/失败）由 wrapper 写一条 `outcome`：`headline`（≤60 字）/ `facts`（改动文件数与 +/-、分支、
  跑过的命令与退出码、创建的 commit/PR、耗时与 token）/ `state`（`ready-to-collect|blocked|needs-decision|failed` + `blocked_on` 一句话）/
  `next`（agent 自述下一步）/ `owes_decision`（布尔 + 一句话）/ `how_to_verify` / `发现的后续事项[]`。
  展示：turn 尾部一张紧凑卡（不新增面板）；列表/队列/看板副标题；「发现的后续事项」渲染成可点的**新任务候选**
  （点一下在新 worktree 开一个新会话，当前会话不中断）。消费方：recap、队列「待收」卡、webhook 正文、`/btw`、未来的 bot。Owner 可就地改写 headline。
- **证据**：Claude task chips「当它发现超出当前范围但值得做的事，就在聊天里给一个 chip，点一下在新 worktree 里开一个会话，
  当前会话不受影响」（`claude-code-desktop-rc/inventory.md §3`）；Orca `worker_done --outcome succeeded|failed` 与
  `worker-read --source auto`（`orca/orchestration.md §4`）；OpenClaw 完成 handoff 带 `Result/Status/token stats` 以及
  **一条要求 requester 先验证再判定完成的 review instruction**（`adjacent/orchestration.md §5`）；Cowork Dispatch
  「messages you the outcome … rather than showing you every step」（`adjacent/orchestration.md §3`）。自身：`workflow-layer §5`、B-260 wire 形状。
- **替代/扩展**：把 B-260 的子代理 wire 形状提升到会话级；替换 `metadata.summary + board.progress` 作为唯一结果表示。
- **依赖**：T-01
- **必要性**：只要「结果」还只存在于 transcript 文本里，任何摘要、通知、看板、复核与未来的秘书都只能重新读一遍对话——这是所有上层抽象的公共前置。

### T-10 · 回到会话时的「你离开期间发生了什么」
- **horizon** now ｜ **category** memory ｜ **size** M ｜ **来源** A-05 / B-12
- **问题**：回到一个跑了 40 分钟的会话只有未读点和「↓ n」条数（`product-map §6.3`）；roadmap 承诺的 durable work memory
  零代码；`pains 判断 #1`「中断恢复 = 复活进程，不是复活上下文」。Owner 每天要重新进入十几个会话，重建上下文的成本与 transcript 长度成正比，
  而他真正需要的是四个事实：改了什么、决定了什么、卡在哪、下一步是什么。
- **提案**：会话/任务打开时在最后一条已读消息处插入一张 **recap 卡**（不进 transcript、不发给 agent）：
  `自你上次查看：n 轮 · +x −y 行 / m 个文件 · k 个工具`；3–6 条 turn outline（做了什么 / 做了什么决定 / 遇到什么错误，
  由 T-09 的 outcome 聚合，缺失时便宜模型对未读区间生成）；一行 `现在的状态`；动作 `跳到这里 / 全部展开 / 收起`（记忆偏好）。
  打开即消费掉，可再次展开。手机上同一张卡是首屏内容。
- **证据**：Claude transcript 的 **Summary 模式**文档明写用途「when you're running multiple sessions and want to scan results quickly」
  （`claude-code-desktop-rc/inventory.md §3`）；Orca Agents feed 被定义为「the catch-up surface when you've been away」，每条带
  last-response preview（`orca/orchestration.md §3`）；OpenClaw session rail 展开即 assessment / plan progress / PRs / elapsed
  （`adjacent/orchestration.md §5`）。自身：`product-map §6.3`、`pains D3/判断 #1`、`workspace-context` spec 非目标「不做 turn outline」（新论据：turn outline 的用途不是浏览历史，是重新进入的成本）。
- **替代/扩展**：兑现 roadmap「durable work memory」的最小可用形态；与 B-209（disclosure 降噪，管单条消息的展开语言）互补不重叠（这条管**区间**）。
- **依赖**：T-09
- **必要性**：一天十几次重新进入会话，每次省下的滚动与重读是这份清单里第二大的时间块。

### T-11 · 累计变更视图：以 git 为真相，不是以工具调用为真相
- **horizon** now ｜ **category** review ｜ **size** L ｜ **来源** A-07（前半）/ B-04
- **问题**：评审停留在工具级——Edit/Write 卡各自一小段 diff；Changed files 只有文件名 + 增删行，**点开是整文件不是 diff**
  （`product-map §6.6`，B-036 dropped/并入 B-208）；没有整会话/任务累计 diff、没有逐 hunk，`open_preview` 的 diff 模式明确「不可用」。
  于是 Owner 的真实动作是开一个 web 终端跑 `git diff` 用 xterm 读。
- **提案**：右栏 `变更` tab 升级为累计 diff：作用域切换 `工作树 / 最近一轮 / 相对起点分支`（三个镜头都必须有），
  左文件树（目录级 +/−）、右 unified diff（可切 split）、逐 hunk 折叠、行号、语法高亮、图片 diff、二进制提示；
  顶部 `+466 −124` 与文件数；`j/k` 换文件、`n/p` 换 hunk。手机：全屏，文件树抽屉，diff 默认换行。
- **证据**：Codex review pane 作用域 `Unstaged / Staged / Commit / Branch / Last turn`，且明确「reflects Git state, not only agent edits」
  （`codex/inventory.md §6`）——「Last turn」这个镜头正是 vh 今天最难回答的「这一轮改了什么」；Orca 组合 diff vs start-from ref，
  可 retarget 到任意 commit/branch（`orca/inventory.md §5`）；Paseo Changes/Files/Commits + 目录树 +/−（`paseo/flows.md §5`）；
  Claude `+12 -1` 指示器进 diff viewer（`claude-code-desktop-rc/inventory.md §5`）。自身：`product-map §6.6`、B-036 dropped、B-208 doing（`?panel=changes` 已有 URL 位）。
- **替代/扩展**：以「累计 + git 作用域」为新论据复活 B-036 并扩展 B-208 的 Changes 面板。
- **依赖**：—（有 T-21 时以任务为作用域，无则以会话/工作区为作用域）
- **必要性**：人的判断带宽花在读 diff 上才是有价值的；今天 vh 把这段推给了终端，等于把工作台最核心的一屏外包出去。

### T-12 · 行内批注 → 一条批量指令，批注跨修订存活
- **horizon** now ｜ **category** review ｜ **size** M ｜ **来源** A-07（后半）/ B-05
- **问题**：要纠正 agent 的一处改动，今天只能在 composer 里用自然语言描述「你在 auth.ts 47 行附近那段改成…」——把定位工作从机器推给人；
  `pains D7` 里 Notes（B-094）的存在正是「等 agent 时没地方攒下一句 prompt」的补丁。
- **提案**：diff 行号处点击或按 `c` 写 markdown 批注 → 汇总成一条**行锚定的批量指令**（`at src/auth.ts:47, …`），`⌘Enter` 发送，
  可选「发给哪个执行体」；批注在 agent 改完后**仍留在原位**作为验收清单，`解决` 折叠，未解决的自动进下一批。
  手机：同一视图全屏，行号点按加批注，键盘上方固定 `发送 n 条批注`。
- **证据**：四家全有且三家明确批量——Orca Annotate AI Diff 把批处理理由写进文档：逐条发送会让 agent「swing back and forth」，
  批量给一轮思考命中率更高，且批注跨修订跟随（`orca/inventory.md §5`、`flows.md §3.4`）；Claude 点行评论、`Cmd+Enter` 一次提交全部，
  web 上评论排队到下一条消息一起发（`claude-code-desktop-rc/inventory.md §5`）；Codex 行内评论作为 review guidance
  （`codex/inventory.md §6`）；Paseo 点行号批注直接回灌 agent（`paseo/flows.md §5`）。自身：B-094（Notes 的真实用途）。
- **替代/扩展**：替换「用 Notes 攒下一句 prompt」的用法；扩展 T-11。
- **依赖**：T-11
- **必要性**：评审的产物必须能直接变成下一条指令，否则每一次评审都要人手工重述位置——这是四家竞品唯一一致的高价值机制。

### T-13 · 失败可读：ErrorBoundary + 按原因措辞的连接横幅 + 缓存先上屏
- **horizon** now ｜ **category** resilience ｜ **size** M ｜ **来源** A-17 / B-25
- **问题**：Web 无 ErrorBoundary（渲染异常 = **白屏**），无离线/重连横幅（`pains F1`、B-027 todo）；而铁律 17 记录了 RPC handler
  抛错被包成正常 ack → store 当成功 → 渲染层拿到 undefined 直接白屏（B-003 todo）。日常代价：一次白屏 = 一次刷新 + 丢失滚动位置与未发送输入。
- **提案**：全局 + 每个主要区域（transcript / 终端 / Files / 侧栏 / 队列）各一层 ErrorBoundary，出错时该区域降级为一张卡
  （`这块出问题了 · 重试 · 复制诊断`），其余界面照常可用；连接状态横幅**按原因措辞**（`正在重连… / 这台机器离线 / 会话在别处被接管 /
  服务端已更新，点此重载`），并在「被接管/已结束/已删除」时**撤掉重连建议**；恢复顺序 = 先用本地缓存画出列表与最近 transcript，
  再按 seq 游标补齐；后台重试静默指数退避，只有用户点 `重试` 才显示 in-flight 状态。任何 RPC wrapper 先检查 `error` 字段（铁律 17）。
- **证据**：Claude RC 把 8 秒 toast 换成**常驻失败指示器**并按原因分文案（taken over / ended / archived elsewhere / server can't find it），
  在这些情形下撤掉重连建议（`claude-code-desktop-rc/flows.md §2.5`、`inventory.md §10`）；Paseo 重连先画缓存的 projects/workspaces/timelines
  再做分页 gap recovery，后台重试静默、用户触发的 Retry 才有 pending 态，且区分「daemon 重启」与「网络中断」（`paseo/flows.md §6`）。
  自身：B-027/B-003 todo、铁律 17、`pains C9/F1`。
- **替代/扩展**：实现 B-027 + B-003，并按竞品的「按原因措辞」升级文案契约。
- **依赖**：—
- **必要性**：白屏是唯一一种会让 Owner 丢失当前输入的故障，而它今天没有任何兜底；队列与状态词汇全部建立在「屏幕上写的是真的」之上。

### T-14 · 会话真相面板：这条会话能做什么、模式是不是真的生效了
- **horizon** now ｜ **category** orientation ｜ **size** S ｜ **来源** A-24 / B-25（规则 1）
- **问题**：同一账号里两个会话的能力可能不同（wrapper 不随 daemon 热升级，铁律 7/14），几乎每个新功能都有「旧 daemon → 隐藏/提示升级」分支
  （`pains C8`）；模式副文案已经诚实到需要七种状态（`· unconfirmed (web auto-approves)` 等，`pains C1/判断 #2`）。
  用户无法建立可预期心智模型：不知道这条会话为什么没有 `/btw`、为什么模式切了没生效。
- **提案**：会话 header 的连接点点击 → 一张只读小卡：`CLI v0.2.9x · 能力：btw ✓ / steer ✓ / 即时改模式 ✗ / 附件 ✓`、
  `当前生效模式：plan（CLI 报告）`、`进程启动于 …（重启会话可获得新能力）`，附 `重启会话` 动作。
  并把这条升级为**组件层规则**：任何反映远端事实的控件必须显示 `已生效 / 切换中 / 未确认（原因）` 三态之一（沿用 B-262 已被证明有效的诚实副文案写法），
  扩展到模式、能力、队列、授权、终端几何；散在各处的「请升级」提示统一收敛到引用这张卡。
- **证据**：Claude 从 2.1.234 起把 permission mode 发布给已连接客户端并双向同步 model/effort，RC 明确列出「哪些模式在手机上不可选」
  （`claude-code-desktop-rc/inventory.md §7/§10`）；Codex 权限卡把 `SANDBOX / APPROVALS POLICY / REVIEWER` 三格并列，把「能做什么」
  与「谁批准」显式分开（`codex/flows.md §7`）。自身：`pains C1/C8/判断 #2`、B-262 四轮对抗 review 的结论、`metadata.capabilities` 已在。
- **替代/扩展**：收敛现有七态副文案与各功能各自的升级提示；把 B-262 的做法从一个控件推广成规则。
- **依赖**：—
- **必要性**：并行多会话时能力不一致是每天都会遇到的困惑，今天只能靠试；vh 已有 5 次记录在案的「UI 说的 ≠ 机器实际的」失信。

### T-15 · 「还在不在」收敛成两个事实 + 一个 Restart
- **horizon** now ｜ **category** orientation ｜ **size** M ｜ **来源** B-13
- **问题**：`pains B7`：用户要理解 ~8 种「不在」（列表/归档/离线/已结束终端/墓碑/processFailed/可恢复/镜像 ended），背后是两套规则文件
  `sessionRestoreRules.ts` / `sessionRestartRules.ts`；`pains B1/B2`：归档会话发消息是黑洞、离线会话从列表消失只能先归档再恢复。
  8 个 spec（B-083/B-177/B-149/B-150/B-265/B-268/B-264/B-272）之后同事仍会问「它还在不在」——问题不在机制而在暴露的词汇量。
- **提案**：工作（会话/任务）永远在，除非删除。执行体只有两态：`活着` / `不在（[重启]：同 id、同 cwd、同模型、同授权）`。
  执行体卡片写清**什么幸存了**：转写 ✓、工作区 ✓、进程 ✗。发消息永远可写：不在就先重启再发，UI 只显示一次「正在重启…」。
  「归档」一词从 UI 消失（保留为数据保留策略）。
- **证据**：Orca Restart chip「一键重启同 agent、同 cwd、同账号」+ 文档诚实的幸存矩阵（`orca/flows.md §3.5`）；
  Claude「message it to revive it」是最低摩擦的崩溃恢复（`claude-code-desktop-rc/flows.md §2.5`）；Paseo idle agent 自动释放进程、
  按需恢复（`paseo/inventory.md §5`）。自身：B-264/B-265/B-268/B-272 机制已齐（doing/done），缺的是词汇收敛；铁律 16（单写者锁）是安全前提。
- **替代/扩展**：延伸 B-265/B-268（不重复其机制），替换「归档/离线/墓碑/已结束」四套文案。
- **依赖**：—
- **必要性**：8 个 spec 之后困惑仍在，说明再修机制也解决不了；不收敛词汇，第 9 个 spec 还会来。

### T-16 · 起活不用打路径：发现式目录/仓库选择器 + 预填深链
- **horizon** now ｜ **category** launch ｜ **size** M ｜ **来源** A-08 / A-23
- **问题**：新建会话必须**手输目录**，预设是手工维护的 chip 列表；快速建聊只记一个「最近机器+目录」（`product-map §6.11`、`J1`；B-042 后半段 todo）。
  Owner 一天起 5–10 个会话，每次都在打路径或翻 chip，打错就起一个错目录的会话（要杀掉重来）。而想法通常出现在别处（IM、todo、issue），
  今天从外部起活只有 `very-happy spawn`（要在机器上）或手工在 Web 里重建。
- **提案**：NewSessionModal / `⌘K` 的目录位改成**发现式选择器**：daemon 上报「最近使用过的目录 + 该机器上的 git 仓库根（含 worktree 列表）
  + 当前分支 + 是否有未提交改动」，按最近使用排序，可模糊搜索，保留手输与目录浏览器兜底；每项显示 `repo · branch · 3 个会话在这`（避免撞车）。
  另加 `https://veryhappy.dev/new?machine=&dir=&branch=&agent=&prompt=`（只预填、不自动发送）与会话/终端页的 `复制深链`。
- **证据**：Codex 项目 = 一或多个文件夹、`⌘P` 切项目、Search chats 连**分支名**一起匹配（`codex/inventory.md §2/§3`），
  `codex://new?prompt=&path=&originUrl=` 预填但不自动发送（`codex/inventory.md §2`）；Paseo New workspace 项目模糊搜索 +
  粘 PR 链接即 checkout（`paseo/inventory.md §5`）；Orca Create Workspace 的 Repository combobox + `Cmd-J` 无匹配时给「Create worktree」行
  （`orca/flows.md §3.1`）；Claude `claude://code/new?q=&repo=&branch=&mode=` 文档明说用途是「从 issue tracker 打开」（`claude-code-desktop-rc/inventory.md §13`）。
  自身：B-042 todo、`product-map §6.11`、`docs/channels.md` 入站契约缺人可点的一环。
- **替代/扩展**：实现 B-042 的「最近路径/目录补全」部分；扩展 `docs/channels.md` 入站面。
- **依赖**：—
- **必要性**：每天 5–10 次、每次十几秒的机械输入 + 打错重来；深链把「想到 → 开工」从多步压到一次点击且不新增服务端概念。

### T-17 · 排队消息是会话的属性，不是这台设备的属性（并把 Steer/Queue 显式化）
- **horizon** now ｜ **category** input ｜ **size** M ｜ **来源** A-06 / B-15
- **问题**：运行中发送 = 进「Queued · n · **this device**」本地队列，spec `queued-message-controls` 明确非目标「不做跨设备队列同步」
  （`product-map §2.4`、`pains §4`）。Owner 的真实动作是：手机上把下一步排进去 → 锁屏 → 到桌面继续；今天这条消息**要么看不见，
  要么在关闭 tab 时静默丢失**——这是数据丢失级别的体验。同时 Steer 藏在队列条目的 ↳ 图标里、`⌘/Ctrl+Enter` 是隐藏键（B-231/234/240/244 两天四个 spec）。
- **提案**：队列升级为服务端对象（会话级、账号可见）：composer 上方 queue track 在所有设备一致，条目可编辑/重排/删除/`Steer 当前 turn`，
  每条标注来源设备与时间（`来自手机 · 3m`）；turn 结束由 wrapper 侧释放（已有服务端持久队列/command buffer 先例），关闭标签页不影响；
  归档会话保持「先恢复再释放」语义。composer 上给一个显式二选一（记忆到账号）：`发送 = 排队到下一轮` / `发送 = 插入当前轮（steer）`，副文案说明差别；
  agent 正等权限时发消息 = 先拒绝那条权限再把消息送进同一轮。
- **证据**：Codex「queued prompts sync with the host from iOS and send even when the phone app is backgrounded」，队列条目在 composer 上方
  可编辑/重排/删除，`Follow-up behaviour` 是一个设置项（`codex/inventory.md §4`、`flows.md §4`）；Claude RC「mid-turn prompts from a device
  are queued and kept in the transcript」，重连期间消息/权限/子代理状态一并排队投递（`claude-code-desktop-rc/inventory.md §10`）；
  Paseo Default send 设置 + Steer vs Queue 是 track，且 0.5.0 修过「composer steers remaining unread while Claude waited on permission」（`paseo/flows.md §3`）。
  自身：`product-map §2.4`、B-244。
- **替代/扩展**：扩展 B-244 的 composer 语义；**推翻 `queued-message-controls` 的「不做跨设备队列同步」非目标**（新论据：跨设备是 Owner 的默认状态，
  当初的非目标理由是复杂度而非用户价值；一个会静默吞掉输入的队列比没有队列更糟）。
- **依赖**：—
- **必要性**：跨设备是 Owner 每天的默认状态；手机上写下的下一步桌面看不到，用户就会改用 Notes 手工搬运（这正是 B-094 出现的原因）。

### T-18 · 机器健康成为一等信息（芯片 + 掉线横幅 + 筛选 + 任意机器起活）
- **horizon** now ｜ **category** orientation ｜ **size** S ｜ **来源** A-14 / B-14（前半）/ C-22
- **问题**：机器只存在于设置与诊断页；侧栏/看板没有按机器筛选，机器离线时会话行只是变灰、**没有全局提示**（`product-map §6.17`）。
  mac-office 睡了或 daemon 挂了时，表现是「所有 agent 都不动了」，Owner 会先怀疑会话。
- **提案**：侧栏（手机在状态页/队列顶部）一条机器轨：每台一个 chip（名字 + 在线点 + `Claude ✓` + `cliAvailability` + 在跑数），
  点击 = 过滤并记忆；任一有活跃会话/终端的机器掉线 → 一条中性横幅 `mac-office 已离线 4 分钟 · 6 个会话与 3 个终端受影响 · 查看机器页`，
  恢复后自动消失并提示「已恢复，正在追平」；队列里该机器的条目**聚合成一条**「mac-office 离线，3 项无法推进」，而不是 3 条灰行；
  新建会话的机器选择显示在线/CLI 可用性/Claude 登录/目标目录是否存在（daemon 侧校验），手机可在任意在线机器上起活。
- **证据**：Codex Remote 顶部 host chips（`All / MacBook / Studio`）各带绿点（`codex/flows.md §4`）；Claude 手机 **Devices 卡**列出跑着
  remote-control 的机器并可从手机在那台机器上开会话（`claude-code-desktop-rc/inventory.md §1`、`flows.md §1.2`）；Paseo 侧栏底部当前 host +
  绿点、可命名与配色、行上 host 徽标（`paseo/orchestration.md §2.2`）；Orca 手机 DESKTOPS 主机卡带 worktree/active 计数（`orca/flows.md §3.3`）。
  自身：`product-map §6.17`、机器页已有全部数据（`daemonState`、`cliAvailability`、`claudeAuth`）。
- **替代/扩展**：新增（机器页保持为详情页）；替换 Settings → Machines 作为唯一入口。
- **依赖**：T-01
- **必要性**：单点故障（mac-office）是他每天所有工作的宿主，掉线时产品今天不说话，排查从错误的一端开始。

### T-19 · 任务对象：比进程活得久的容器（含工作记忆）
- **horizon** now ｜ **category** foundation ｜ **size** XL ｜ **来源** B-01 / C-17（工作记忆并入）
- **问题**：用户看到的一切都是进程状态；`pains 判断 #1`「产品的基本单元是进程而不是工作」，8 个 spec 连环修「这个会话还在不在」；
  Notes（B-094）与 `/btw`（B-283）都是「没有一个容器装当前这件事」的旁证；`workspace-context` spec 明确非目标「不新增 Workspace 表」，
  于是工作区只是从 `machineId+cwd` 派生的一个镜头。中断恢复全是进程级，roadmap 承诺的 durable work memory 只有看板一行摘要。
  **⚔ 分歧**：B 认为这是地基，其余多数条目应挂在它上面（新建即建任务，会话/终端降级为执行体，侧栏第一层是任务）；
  A 明确**不引入新对象**，主张在会话上补齐 worktree/分支属性 + 队列 + 看板任务即可，理由是表面与状态越少越好（`pains 判断 #5`：
  表面数量已超过单人验证带宽，待验 90 项）；C 居中（保留会话为单位，但要求 workspace 级持久记忆与 outcome）。
- **提案**：任务 = `目标 + 起点(base ref) + 隔离(worktree/目录) + N 个执行体（结构化会话/终端） + 累计变更 + outcome + 状态`。
  任务页一屏：左「执行体」列（可加可关，关掉不影响任务）、中对话/终端、右变更/文件/PR。侧栏第一层是任务。归档 = 任务级动作；
  历史与变更永不消失。任务自带一份**可编辑的工作记忆**：`目标 / 已定的决策 / 关键文件 / 未决问题 / 下一步 / 约束`——
  outcome（T-09）与决策（T-27）按规则产生**候选条目**，人一键采纳/否决（不自动写正文），新会话在该任务下起时自动注入摘要（可关），
  Notes 升级为它的一部分（人写的优先级最高，agent 只能追加候选）。若 Owner 否决任务对象，本条降级为：把工作记忆挂在 B-208 已有的
  `machine+cwd` workspace key 上，其余条目按会话作用域实现。
- **证据**：Paseo「Paseo is organized around workspaces, not chats」，workspace 可先建后挂 agent（`paseo/orchestration.md §2.1`）；
  Orca worktree 生命周期 create→work→review→ship→archive（`orca/inventory.md §2`）；Codex chat 拥有 run location 且可 Handoff
  （`codex/inventory.md §2/§5`）；Claude Desktop 每个 session 自动一个 worktree、archive 同时删 worktree（`claude-code-desktop-rc/inventory.md §4`）；
  记忆侧：Cowork 可编辑记忆 / Grok bot memory / OpenClaw MEMORY.md（`adjacent/orchestration.md §1/§5`）。
  自身：roadmap Next「workspace/project/checkout/task 一等化」= 零落地；B-208 doing 只做到分组镜头；`vh.board-tasks.v1` KV 是任务表的前身。
- **替代/扩展**：延伸 B-208（镜头 → 真对象）；吸收 board 的 Tasks 泳道；兑现 roadmap 的 durable work memory。
- **依赖**：T-01
- **必要性**：没有比进程活得久的对象，「中断恢复」「跨设备继续」「评审到合并」「让 agent 汇报」四件事都无处挂载，只能继续用第 9 个 spec 修同一个洞。

### T-20 · 减法：把不服务于这个循环的表面删掉或并掉
- **horizon** now ｜ **category** subtraction ｜ **size** M ｜ **来源** B-19
- **问题**：`pains 判断 #5`：Owner 的日常只用 3 个表面，产品却有 ~14 个；每多一个表面就多一份状态、兼容分支和验证项
  （待验 90 项、最老 08-13）；B-041 记录 12 项设置无消费者。
- **提案**：明确删/并：`/todos`（外部 provider、agent 不可见、四种失败态 → 删，真正的待办进队列/任务）；
  `Notes dock`（并入任务/工作区的笔记区，`⌘J` 打开当前工作的笔记）；`剪贴板历史面板`（并成 outcome 的一种附件）；
  `/board` 的 `Tasks` 泳道（并入任务列表，Lifecycle 列并入队列）；同批清掉 B-041 的死设置。保留并强化：队列、任务/会话、终端、机器、设置。
  （`/assistant` 的退役单列为 T-34，因为它有替代路径要一起决定。）
- **证据**：Paseo 与 Orca 都**没有** notes/todo/board 表面，替代物是 workspace labels + History（`paseo/inventory.md §17`）与 worktree checkpoint
  （`orca/orchestration.md §3`）；Claude/Codex 也无（`claude-code-desktop-rc/inventory.md §18` 把 board/notes 列为 vh 独有）；
  Codex 反面教训：把编码工作台塞进三模式超级 app 造成「我的项目去哪了」（`codex/orchestration.md §10`）；Orca 反面：注意力分散在 5 个表面
  且 3 个在 Experimental 后面（`orca/flows.md §8`）。自身：`pains 判断 #5`、B-041 todo、V-073/074（todo 面板失败态）三周未清。
- **替代/扩展**：删除 `/todos`；合并 Notes、剪贴板、board Tasks 泳道；执行 B-041。
- **依赖**：T-02、T-19（先有承接的地方再删）
- **必要性**：单人验证带宽是硬约束（90 项待验就是证据）；不做减法，新的核心循环只会变成第 15 个表面。

---

## NEXT

### T-21 · worktree / 分支成为一等属性
- **horizon** next ｜ **category** launch ｜ **size** L ｜ **来源** A-09 / B-08
- **问题**：产品里没有 worktree/分支概念，`NewSessionDraft.sessionType` 字段零 UI（`product-map §6.5`、`pains H1`、B-042 todo）。
  Owner 的实际契约就是「每事项一个 worktree + 分支」（AGENTS.md），于是他在终端里手工建 worktree 再回 Web 起会话，
  侧栏只显示 cwd——**无法从行上判断这个会话在哪条分支上**，也无法防止两个会话踩同一个 checkout。
  **⚔ 分歧**：B 主张**隔离是默认**（新建即新 worktree，选 base ref，仓库根 `vh.json` 声明 setup/teardown 与要拷贝的 gitignore 文件）；
  A 主张做成**新建时的一个「运行位置」选项**（`当前 checkout` / `新建 worktree（从 <base>）`），保留 Owner 既有的手工 worktree 流。
- **提案**：新建时选 `运行位置`；分支名可由便宜模型从首条 prompt 生成；行副标题与卡片显示 `repo · branch`（可在 Appearance 选显示分支而非路径）；
  侧栏工作区分组 key 从 `machine+cwd` 自然扩展到 worktree；归档/关闭时询问「同时删除 worktree 与分支？」，有未提交/未推送先警告；
  setup 命令复用 Settings → Shortcuts 的 startup command 语义。
- **证据**：Claude Desktop 每 session 一个 worktree（`.claude/worktrees/`、branch prefix、`.worktreeinclude`、归档即删）+ RC `--spawn worktree`
  （`claude-code-desktop-rc/inventory.md §4`）；Codex `Local / Worktree / Cloud` 是 chat 的可变属性，带 base-branch、setup script、15 个上限、
  删除前快照可恢复（`codex/inventory.md §5`）；Paseo isolation `local|worktree`（branch-off / checkout-branch / checkout-PR）+ `paseo.json`
  setup/teardown + 最后一个 workspace 归档后自动 teardown（`paseo/inventory.md §8`）；Orca 把 worktree 当作工作单元本身，并被第三方指出
  「worktree 不隔离数据库、端口、凭据」（`orca/inventory.md §2`、`orchestration.md §2`）——所以要有 setup 脚本。自身：B-042 todo、AGENTS.md 开发流程。
- **替代/扩展**：实现 B-042 的 UI 半边；扩展 B-208 的工作区 key。
- **依赖**：T-16、（T-19 若落地则 worktree 是任务的属性）
- **必要性**：并行 agent 的第一性约束是不能互相踩；Owner 的开发流程契约就是 worktree-per-item，产品今天对此一无所知。

### T-22 · PR / CI 状态上行到行与队列，失败一键交回，合并即收摊
- **horizon** next ｜ **category** review ｜ **size** L ｜ **来源** A-10 / A-22 / B-07
- **问题**：`pains §5`「无任何 dev-provider（GitHub/PR/CI）集成」；Owner 成批 land PR，今天靠 `scripts/land-pr.sh` + 反复 `gh run view`。
  一个事项的**完成态**客观上是「PR 合了 / CI 绿了」，而产品的完成态只有人点 ✓，两套完成态并存意味着他要自己对账；
  已合并 PR 对应的会话/worktree 也仍然要人手收。
- **提案**：会话/任务若关联分支且存在 PR，行与卡显示 `#158 ✓/✗/⏳`（颜色只表示 checks 状态，遵守 accent 纪律，不占用 teal）；
  会话页右栏 `PR` tab（标题、checks 失败优先、review threads）；CI 失败**自动生成一条决策卡**：失败 check 名 + 日志尾部 +
  `把失败交给它 / 我自己看 / 忽略`（打包成 prompt 发给该会话，不自动提交、不绕过）；PR 被合并/关闭 → 卡上出现 `已合并 · 收摊?`
  （写 `completedAt` + 归档 + 询问删除 worktree/分支 + 发 webhook），Settings 里可选「自动收摊（合并后 24h）」，默认关。
  数据源：daemon 侧 `gh`（机器上已认证），未装/未认证时该区块隐藏并给一行说明。
- **证据**：Claude CI status bar（gh 轮询、Auto-fix/Auto-merge、CI 完成通知、PR 合并后自动归档）+ agent-view 的 PR chip 按 CI/review 状态着色
  （`claude-code-desktop-rc/inventory.md §5`、`flows.md §1.3/§2.4`）；Paseo PR 面板 checks failure-first 分组 + **一键把 failed check logs 附到 chat**
  + 合并后自动归档 workspace（归档时若有未提交/未推送先确认）（`paseo/inventory.md §5/§9`）；Orca 红色 chip + `Fix broken checks` 把 check 名与链接交给 agent
  （`orca/flows.md §3.4`、`orchestration.md §5`）；Codex PR Chat + `@codex fix the P1 issue`（`codex/inventory.md §6`）。
  自身：`pains §5`、`docs/PROCESS.md` 批次制以 PR 为交付单位、`rowActions.ts` 的 ✓ 流程（记录 + kill-first archive + webhook）已有，只差触发源。
- **替代/扩展**：新增（roadmap「deepen development-provider integration」的最小落地）；扩展看板 ✓ 流程与 T-01 的 `待评审` 判据。
- **依赖**：T-21、T-02
- **必要性**：Owner 每天成批 land PR，这一段今天 100% 在产品之外，且是「事项是否真的完成」的唯一客观依据；不收摊的队列会慢慢失去信噪比。

### T-23 · Ship bar：暂存 / 提交 / 推送 / PR / 合并，失败带界地交回 agent
- **horizon** next ｜ **category** ship ｜ **size** L ｜ **来源** B-06
- **问题**：要合并一个 agent 的成果必须离开 vh 去终端或 GitHub；Paseo 的对比页把「无 in-app git/PR 流」作为对 Happy 系产品的主要判词，
  研究者逐条核对后判定「对 very-happy 成立」（`paseo/flows.md §10`）。评审（T-11/T-12）如果没有终点，工作台就只是一个观察窗。
- **提案**：任务/会话页底部一条随状态提升的主按钮：`暂存 → 提交（消息由小模型生成、可编辑）→ 推送 → 创建 PR（标题/正文生成、可 draft）
  → CI → 合并（squash/merge/rebase 明示）`；`--force-with-lease` 永远是单独且带标签的动作；失败态各配一个**带界的**交回动作：
  `hook 失败 → 交给 agent 修（只给失败输出，禁止绕过）`、`冲突 → 交给 agent 解`。合并后触发 T-22 的收摊。
- **证据**：Paseo in-app GitHub 流（commit/push/PR/checks/reviews/merge）（`paseo/inventory.md §9`）；Orca Source Control 的状态提升主按钮 +
  `Fix with AI`（只修不绕过）+ `Resolve with AI`（`orca/flows.md §3.4`）；Claude 的 Auto-fix/Auto-merge（`claude-code-desktop-rc/inventory.md §5`）；
  Codex 逐 hunk stage + push modal（`codex/inventory.md §6`）。自身：`pains §5`、Owner 现有 `scripts/land-pr.sh` 流程（产品应能替代其人工部分，不替代 CI 门禁）。
- **替代/扩展**：新增；使 T-11/T-12 的评审有终点。
- **依赖**：T-11、T-22
- **必要性**：如果「完成」的最后一公里必须换工具，评审投资的一半会漏在外面；四家竞品都把 ship 放进了同一个界面。

### T-24 · 从某一步分叉：fork / rewind / 带简报换一个会话继续
- **horizon** next ｜ **category** memory ｜ **size** M ｜ **来源** A-21 / B-18
- **问题**：`session.forkAction/duplicateAction` 是上游遗留死字符串，web-v2 零入口（`product-map §6.8`，类型已在、零调用点）；
  想「从这一步重来」只能去终端 `claude --resume` 自己 fork。上下文长了以后 Owner 的真实需求是「换个干净会话，但别让我重讲一遍」。
- **提案**：transcript 每条用户消息处两个动作：`从这里分叉`（复制到此为止的上下文，起新执行体，可选同任务或新任务+新 worktree，可换 agent/模型）
  与 `回到这里`（rewind：对话与文件都回退，改动进 stash 可恢复）；会话菜单加 `带简报继续`：用便宜模型生成结构化 briefing
  （任务/现状/相关文件/试过什么/已定决策/验收标准/约束）作为新会话首条消息，原会话不动，两边互相带链接；侧栏用缩进显示父子关系（复用 `parentSessionId`）。
- **证据**：Paseo fork 到新 tab 或新 worktree、运行中也能 fork、从失败 turn fork、**跨 provider fork**，并有 `Rewind chat or files from any user message`
  （`paseo/inventory.md §5`）；Codex `/fork` 复制成新 chat 或 worktree、fork 之间互相链接（`codex/inventory.md §3`）；
  Claude `/fork` 进后台自带 worktree（`claude-code-desktop-rc/inventory.md §2`）；Orca "Continue in New Session…" = 从 transcript 生成**有界 handoff prompt**，
  原会话不动（`orca/orchestration.md §6`）。自身：`product-map §6.8`、`ClaudeForkSessionOptions` 已在、`pains §7` 允许「带新论据重提」。
- **替代/扩展**：给已有的 fork 类型层接上 UI。
- **依赖**：T-21
- **必要性**：agent 跑偏时人的最优动作往往是回到岔路口而不是继续硬掰；上下文膨胀是每天都会撞上的墙，今天唯一出路是离开产品到终端里 resume。

### T-25 · Auto Review：plan 与 yolo 之间的第三档（每轮停下等我看）
- **horizon** next ｜ **category** safety ｜ **size** M ｜ **来源** B-16（前半）
- **问题**：今天只有 `default / plan / acceptEdits / yolo`——要么每个工具都问，要么全放开（`pains C1`：模式已经骗了用户 5 次，B-243→B-262）。
  单人监督多 agent 时逐工具审批不可持续，而 yolo 把风险推到评审之后；缺这一档，用户只能在「烦」和「险」之间选。
- **提案**：新增一档 `每轮停下等我看`：轮内工具不问，**每个 assistant turn 结束自动停住并把该会话置 `待评审`**，
  人看完累计变更（T-11）点「继续」或写批注（T-12）。模式副文案沿用现有诚实口径；**不新增出站 permission mode 枚举值**
  （铁律 14：CLI zod 不认识的值会让整条消息被静默丢弃），只在 web/relay 侧作为一条停靠策略存在。
- **证据**：Paseo 的 `Auto Review` 模式就是「每个 assistant turn 后停下等 review」（0.1.76，`paseo/flows.md §3`）；
  Claude 从 2026-08-14 起把 Auto（分类器）设为 Pro/Max 新会话默认（`claude-code-desktop-rc/inventory.md §7`）。
  自身：B-263 dropped 的是 `dontAsk`/`auto` **枚举**（语义是「不问就干」），与本条语义相反，不是重提。
- **替代/扩展**：新增第三档（明确不是 B-263）。
- **依赖**：T-11
- **必要性**：并行 agent 数量上去后，逐工具审批是不可持续的；这一档是唯一既不放弃控制又不逐工具打断的形态。

### T-26 · 代批车道（reviewer lane）+ 硬边界 + 熔断 + 全量入账
- **horizon** next ｜ **category** safety ｜ **size** L ｜ **来源** C-20 / B-16（后半）｜ **⚔ A 反对**
- **问题**：定时/派出的工作要么卡住等人，要么必须开 yolo。**⚔ 分歧**：C（与 B 的后半）主张加一条「代我判断」的审批车道；
  A **明确反对现在做**，理由是它在 web/CLI 之间再插入**第三个权限权威**，而 vh 刚用 5 个 backlog + 2 个 spec + 4 轮对抗 review
  才把「UI 说 yolo 实际在问」收敛到唯一执法点（铁律 14），现在加一层会让真相问题重新变成组合爆炸；A 的条件是「等模式源稳定且
  T-14 真相面板落地后再评估」。
- **提案（若采纳）**：权限请求先交给便宜的旁路 reviewer（策略是可读可改的文本），返回 `allow/deny + 理由 + 风险等级`；
  硬边界写在产品里而不是 prompt 里（`永远停`：生产写入、`git push`、删除、对外发送、未列域名的网络出站）；
  熔断：连续 N 次 deny 或 M/50 → 中止本 turn 并升级给人；全部自动决策进账本（T-27），会话页显示「本 turn 由 reviewer 放行了 3 项（查看）」；
  实现红线同 T-25：**不作为新的出站 permission mode 枚举值**。
- **证据**：Codex 的 `Approve for me` 是独立 reviewer agent 在沙箱边界判定，带 rationale / risk level / 三连拒断路器 / `/approve` 单次重试
  （`codex/inventory.md §8`）；Claude 的 Auto 分类器（`claude-code-desktop-rc/inventory.md §7`）；反面：Orca 给所有 CLI 预置
  `--dangerously-skip-permissions`（`orca/flows.md §8 反模式 1`）。自身：铁律 14、`yoloEnforcement.ts` 唯一执法点、`specs/2026-08-permission-mode-source-of-truth.md`。
- **替代/扩展**：扩展 `Approve for session` 与执法边界；**不是** B-263 的模式枚举。
- **依赖**：T-14、T-25、T-27
- **必要性**：没有中间档，定时与派工要么不可靠要么不安全——但这条的必要性只有在「定时/派工真的开始跑」之后才成立，所以排在 T-28 之前一步、且带 A 的反对意见供裁决。

### T-27 · 常设授权可见可撤销 + 决策账本
- **horizon** next ｜ **category** safety ｜ **size** L ｜ **来源** B-17 / C-16
- **问题**：`product-map §6.13`：`Approve for session` 之外没有规则管理——不能查看/编辑「本会话已允许的工具」，更没有跨会话或项目级策略 UI；
  bot 会话默认 skip permissions 且从所有列表隐藏，审计只能靠记 URL（`workflow-layer P9`）；同一个判断今天要做很多次。
- **提案**：①`授权` 小面板：列出这个会话/任务已给的常设许可（工具 / 命令前缀 / 路径），每条可撤销（即刻生效），带授予时间与来源；
  决策卡上的「始终允许」写进这里；离开该会话不继承；可选项目级模板。②`决策账本`：每个决策一条记录（时间、主体、类型、请求摘要、决定、
  决定者：人 / reviewer lane / bot、可选理由），`/decisions` 视图可按会话/机器/工具过滤；agent 只读可见（提问前先查「这类事你上次怎么决定」）；
  保留期与导出可配。
- **证据**：Claude 定时任务会积累一个「Always allowed」清单，可在任务页**审阅与撤销**（`claude-code-desktop-rc/inventory.md §7/§13`）；
  Codex 的 rules（allow/prompt/forbid 命令前缀）与 permission profiles（deny-globs 如 `**/*.env`、网络域名白名单）（`codex/inventory.md §8`）；
  反例：Orca 全部 CLI 预置 bypass flag（`orca/flows.md §8`）。自身：`product-map §6.13`、`permissionSuggestions`、铁律 14。
- **替代/扩展**：扩展 `Approve for session` 与 `permissionSuggestions`。
- **依赖**：T-03
- **必要性**：不可见的授权等于不可撤销的授权；vh 已经因为「UI 说的 ≠ 机器实际的」踩过 5 次，权限尤其不能再有隐形状态；账本同时是审计、记忆与「提升为例行」的数据源。

### T-28 · 例行工作：从「你已经让我做过三次」提升而来，创建即启用 + 可见试跑
- **horizon** next ｜ **category** automation ｜ **size** L ｜ **来源** A-25 / B-21 / C-14 / C-15
- **问题**：定时/重复工作**零代码**（`pains §5`：grep schedule/cron 只有内部 scheduler 名；Landing 曾画出 scheduler control plane 后被迫
  `keep scheduler agent claims honest` 回收口径）。Owner 每天有固定动作（清 verify-queue、triage backlog、盯 PR、看发布 SHA），今天全靠人记得发起。
- **提案**：不做 cron 表单，做**提升**：同一类请求出现 N 次（从 T-27 账本数出来）→ 产品/幕僚长提议「要不要每个工作日 09:00 自动做这件事？」
  → 确认的是**一句自然语言**而不是 cron 表达式 → **创建即启用并立刻跑一次可见试跑**（失败就撤销，理由：没有东西会监督一个 disabled 的 job）。
  两种形态：`例行任务`（每次新建一个任务/会话跑）与 `心跳`（把 prompt 打回同一个会话，用于盯 CI、长跑迁移；每次唤醒前按 outcome 压缩上下文）。
  `precheck`（一条便宜 shell 探针，不满足记 skipped 而不是空跑）；运行历史列出每次结果与**跳过原因**（机器离线 / 上次还在跑 / precheck 未过），
  可 Rerun；错过的运行只补最近一次；连续失败 N 次自动停用并通知。**有发现才进队列**，无发现自动收（不新增第三个列表）。
- **证据**：OpenClaw 的 promotion 机制（「你多次要求同一件事时 agent 提议做成 schedule，确认的是自然语言句子而不是 cron；创建后立即以可见测试跑一次，
  失败就删除」）（`adjacent/orchestration.md §5`）；Claude Desktop 定时任务的错过补跑一次、运行历史带跳过原因、每任务 Always-allowed 面板
  （`claude-code-desktop-rc/inventory.md §13`、`orchestration.md §2.4`）；Codex Scheduled 视图**就是收件箱**（有 findings 才未读、可批量已读/归档）
  + standalone vs in-chat heartbeat 二分（`codex/inventory.md §12`、`orchestration.md §5`）；Orca 的 `--precheck` / `--reuse-session`（`orca/orchestration.md §5`）。
  自身：roadmap「scheduled work and repeatable pipelines」= 0。
- **替代/扩展**：新增（roadmap 承诺的首次落地）；产出必须进 T-02 的队列。
- **依赖**：T-02、T-09、T-27
- **必要性**：一个人 + 一群 agent 的产能上限受制于「人记得去发起」；这是唯一能把「每天固定的十几分钟」变成零的机制——但只有队列先存在时它才不会变成新的噪音源。

### T-29 · 复核与验收：`✓` 之前有据可依
- **horizon** next ｜ **category** decision ｜ **size** M ｜ **来源** C-19
- **问题**：「跑完 ≠ 完成、完成必须是人点 ✓」是 Owner 明确的管理哲学（`workflow-layer §2.1`），但产品对「怎么验」零支持：✓ 全靠印象。
  管理者盲信是多 agent 的主要失败模式（「green ≠ done」是四个参考产品共同的告诫）。
- **提案**：outcome（T-09）带 `how_to_verify`（agent 自述：跑了什么、还没跑什么）；队列「待收」条目上一个 `复核` 动作：
  用旁路 query（`resume + forkSession + persistSession:false + disableAllHooks` 三件套）让另一个角色（可指定便宜模型）**只读地**检查
  「outcome 说的与实际改动是否一致」，结论作为注释贴在条目上、不进主对话；结论只有三种：`一致 / 有出入（列点）/ 无法判断`。人仍是点 ✓ 的唯一主体。
- **证据**：OpenClaw 的完成 handoff 附带**一条要求 requester 先验证再判定完成的 review instruction**（`adjacent/orchestration.md §5`）；
  Orca 的 `worker_done --outcome` + `worker-read --source auto`（`orca/orchestration.md §4`）。自身：`/btw`（B-283）已实证三件套可行
  （铁律 18）；需对 `specs/2026-09-btw-side-question.md` 的「不持久化」非目标开一个例外（复核结论要贴在条目上）。
- **替代/扩展**：扩展 `/btw`（B-283）。
- **依赖**：T-09、T-02
- **必要性**：Owner 的完成判据是人点 ✓，而今天他点 ✓ 时手上没有任何比印象更硬的东西；vh 已经有做这件事最便宜的机制。

### T-30 · 额度：从月度报表变成当天的一个决策
- **horizon** next ｜ **category** cost ｜ **size** S ｜ **来源** A-20 / B-30
- **问题**：用量只有 Settings → Usage 的聚合视图，会话内只有上下文表，没有本会话/任务花了多少 token/钱（`product-map §6.19`）；
  撞到额度时 transcript 只有一行 `Usage limit until HH:MM`，之后什么也不发生（人必须记得回来）。真正影响当天行为的不是月报，
  而是「我还剩多少 5 小时窗口，而现在有 6 个会话在烧」。
- **提案**：侧栏 footer 一枚极小额度段（`Claude 78% · 5h`），≥80% 变提示态；点开是按 provider 的 roster，按**最紧的窗口**排序，显示重置倒计时；
  会话/任务页脚一行 `本任务：$x · N tokens · 上下文 62%`；撞额度时队列出一张卡：`额度用尽，14:30 恢复` + `到点自动继续 / 换模型继续 / 我自己来`。
- **证据**：Orca 状态栏 per-provider 用量段 + 80% 警告 + roster 按最紧限额排序 + 重置倒计时（`orca/inventory.md §13`、`flows.md §3.8`）；
  Claude 的额度卡提供「Auto-continue when limits reset」并显示恢复时间（`claude-code-desktop-rc/inventory.md §15`）；
  Paseo provider usage bars 接近限额时警告（`paseo/inventory.md §7`）。自身：B-211 doing（做的是归一化与聚合，本条明确不重复它的报表）。
- **替代/扩展**：扩展 B-211（只加**归属**与**到点行为**）。
- **依赖**：T-02
- **必要性**：触顶会让一批并行会话同时停摆；今天它是一条死文案，把它变成一个可作答的决策是「人只在欠决策时被打断」的直接推论。

### T-31 · composer 的 `@文件` 补全与拖入即引用
- **horizon** next ｜ **category** input ｜ **size** S ｜ **来源** A-16
- **问题**：没有 `@文件` 引用与路径补全，斜杠建议只补命令名（`product-map §6.10`；B-035 自 2026-08-13 todo，**代码已移植但零接线**）。
  Owner 每条 prompt 都在手打路径，打错就是一轮无效 turn。
- **提案**：composer 输入 `@` 触发路径补全（daemon 侧按 cwd 索引，最近改动文件优先）；从 Files 面板/Changed files 拖一个文件到 composer = 插入 `@path`；
  选中的 diff hunk 支持「引用到输入框」（与 T-12 互补：批注是批量回灌，引用是写新 prompt 时用）。手机：Files 面板每行一个「引用」动作。
- **证据**：Claude Desktop `@file` 自动补全（local/SSH）（`claude-code-desktop-rc/inventory.md §9`）；Paseo composer 明示「Message the agent,
  tag @files, or use /commands and /skills」，支持 dot-folder 与深路径（`paseo/inventory.md §13`、`flows.md §1`）；Orca 手机也有 `@` file mentions、
  桌面支持从文件树拖到 agent 终端（`orca/inventory.md §9`）；Codex `@`-mention。自身：B-035 todo。
- **替代/扩展**：实现 B-035。
- **依赖**：—
- **必要性**：每天几十条 prompt 里的路径输入与打错重来，是最便宜也最确定的一笔时间；代码已在，只差接线。

### T-32 · 会话内搜索与跨会话内容搜索
- **horizon** next ｜ **category** orientation ｜ **size** M ｜ **来源** A-19
- **问题**：没有会话内搜索、没有 transcript 导出（B-038 todo 自 08-13）；`⌘K` 只搜标题与 tag。「上周那个会话是怎么决定的」今天只能靠记忆 + 手动翻，
  而转写在 server 侧是加密的，终端里 grep 不到。
- **提案**：会话页 `⌘F` 搜当前 transcript（命中跳转 + 高亮，含工具参数与 diff 文本）；`⌘K` 增加「内容」段，范围 = 标题/摘要/最近 N 条消息/分支名，
  结果行显示命中片段。手机：会话 header 的搜索图标。
- **证据**：Codex「Search chats matches content **and Git branch names**」（`codex/inventory.md §3`）；Paseo History 可按 workspace/agent/branch 搜
  （`paseo/inventory.md §6`）；Orca `Cmd-J` 支持 PR/MR 号搜索（`orca/flows.md §2`）。自身：B-038 todo。
- **替代/扩展**：实现 B-038 的搜索部分（导出可留后）。
- **依赖**：—
- **必要性**：跨天回看是批次制工作的固有动作（Owner 每批都要回看上一批的决定），今天它在产品里没有入口。

### T-33 · transcript 密度：`仅结论` 扫读模式
- **horizon** next ｜ **category** orientation ｜ **size** S ｜ **来源** B-28 ｜ **⚔ A 反对**
- **问题**：并行 5 个会话时没人要看每个工具调用；`pains D1/D5` 记录长会话噪音大、无虚拟化。**⚔ 分歧**：B 主张加一个三档密度
  （`完整 / 折叠工具（默认）/ 仅结论`，手机默认仅结论）；A **反对**，理由是它与 B-209（disclosure 统一，doing）重叠，
  且 T-10 的 recap 已覆盖 Summary 模式的真实用途（扫结果），再加一个全局开关是设置蔓延。
- **提案（若采纳）**：会话顶部一个三档密度切换，`仅结论` = 只显示用户消息、assistant 最终结论、每轮 `改了 N 个文件 +x −y`、决策记录；
  记忆到设备；明确与 B-209 分工：B-209 管单条消息的展开语言与视觉，这条只加一个**模式维度**。
- **证据**：Claude 的 Normal / Verbose / **Summary**（"only Claude's final responses and the changes it made"），文档明确推荐 Summary
  「when you're running multiple sessions」，`Ctrl+O` 循环（`claude-code-desktop-rc/inventory.md §3`）——这是唯一一个 Claude 明说「为多会话设计」的渲染功能；
  Paseo「Summarize tool calls in a single collapsed item」设置 + turn footer「Worked for 31m 46s」（`paseo/orchestration.md §2.3`）。自身：B-209 doing、B-044 todo。
- **替代/扩展**：延伸 B-209（加模式维度，不重复其内容）。
- **依赖**：T-10（若 recap 已足够，本条可撤）
- **必要性**：并行任务数上去之后，transcript 的默认密度决定了扫一遍要几分钟——但这条的必要性依赖 recap 落地后是否仍有缺口，请 Owner 在评审时一并裁定。

### T-34 · 退役 `/assistant` 语音台，编排能力回到主工作面
- **horizon** next ｜ **category** subtraction ｜ **size** M ｜ **来源** B-29 / C-10 / C-09
- **问题**：硬证据：assistant 只在上线当天（2026-08-13）被用过——9 份 JSONL 全在 8-13、`memory/personal.md` 至今 315 字节种子、journal 空、
  8-24 起 1318 个 daemon 日志里 0 条记录（`workflow-layer §1.8`）。归因是结构性的（P1–P13）：视野比侧栏窄、没有收件箱、
  说的话被 `isHiddenSession` 从所有出口过滤、派活原语只有 directory+prompt、延迟劣于直接看 UI、形态是与工作面割裂的全屏语音台。
  同时它默认 skip permissions 且从所有列表隐藏——「最高权限 + 最难审计」的最坏组合。
- **提案**：退役 `/assistant` 全屏路由与语音台形态。语音降级为**输入法**（任何 composer 上的麦克风，含手机；TTS 保留为可选朗读）。
  编排能力以**工具面**形式回到普通会话：任何会话都能调用 `任务/会话列表 · 读 · 派 · 发消息 · 待批权限列表 · 建例行任务`（工具面见 T-35）。
  bot 会话不再隐藏：变成侧栏里可见对象（身份芯片、状态点、未读点，身份色与状态色分离、不用 teal），它的每个 destructive 动作在账本里有一条可点击记录。
- **证据**：Paseo **没有独立 dispatcher 页面**，编排是「注入到每个 agent 的 MCP 工具 + 三个 skill」，研究者据此判断「编排不该是一个独立页面，
  而是主会话里的工具」（`paseo/flows.md §10`）；Orca 同样没有 meta-assistant chat，dispatcher 是 CLI + 收件箱（`orca/orchestration.md §4`）；
  Cowork Dispatch 的单线程限制被列为反模式（`adjacent/orchestration.md §3/§10`）；Grok 的 chief-of-staff 只是角色模板，价值来自定时的、
  带来源的决策摘要而不是人格（`adjacent/orchestration.md §1`）。自身：`workflow-layer §0/§1.8/§3`、V-022…V-034 三周未清、`spec 2026-08-voice-assistant`。
- **替代/扩展**：删除 `/assistant` 路由与 `AssistantScreen.tsx`（777 行）；其人类可见价值由 T-02 承接，机器能力由 T-35 承接；保留语音链路作为输入法。
- **依赖**：T-02、T-35
- **必要性**：一个零使用、零记忆、出口被过滤的页面每次改动都要付兼容与验证成本；保留它会让「秘书」这条线继续长在错误的地基上。

### T-35 · 账号级 agent 控制面：读 + 订阅 + 派工（含统一派工原语与人接管信号）
- **horizon** next ｜ **category** agent-api ｜ **size** XL ｜ **来源** C-07 / C-08 / C-11 / C-13 / B-23
- **问题**：`workflow-layer §5 缺口 1/2/4`：agent 只能读「本机有 key 的会话」（≤14 天、最近 15 条、无状态），读别的机器直接「No local key」；
  唯一的主动通道 `[系统通报]` 只覆盖 `spawnedBy==='assistant'` 且要求助手进程活着、5 分钟冷却；bot 说的话进不了任何出口。
  派活有三条互不相通的路（看板 Dispatch / 助手 `session_spawn` / IM 适配器），能力还不一样；高权限操作的确认只存在于 prompt 文本里。
  人随时会跳进会话打字、改模式、归档、重启，bot 的假设立刻失效但它不知道。
- **提案**：一套账号级、需授权、与人类 UI 同源的接口（server 可信、非 e2e，这个口子本来就是开的）：
  **读**：`sessions/tasks.list(filter: state|machine|workspace|tag)`（返回 T-01 状态 + T-09 outcome + capabilities）、`read(tail|since_seq)`、
  `terminals.list/read`、`machines.list`、`inbox.list`、`permissions.pending`；
  **订阅**：`turn-end-idle / needs-decision / failed / human-took-over / marked-done`（把 `spawnedBy` 泛化成 `reportTo`，任意会话可声明回报目标；
  载荷 = outcome + 一条复核指令；没有 bot 在线时进队列/账本不丢，上线后按 `since` 补读）；
  **写**：`send/steer/stop`、`spawn`、`archive/restore`、`permission.respond`、`task.create/complete`——统一成**一个 Dispatch 对象 + 一张复述确认卡**
  （在哪台机器、哪个目录、什么角色、什么权限、完成算什么），所有入口（Web、CLI、bot）共用；`read/write/destructive` 分级，
  destructive 走**产品级确认**（不是 prompt 里的口头复述）并全部进账本（T-27）。
  **人接管信号**：每个会话一条 durable 信号日志（`human_message / mode_changed / archived / respawned / takeover / marked_done`），
  bot 作为 watcher 收到一条合并通知「你直接介入过，先对齐再动手」，人这边在会话页看到一行「你在 14:02 直接介入过」。
  同一套能力同时暴露为 CLI（`very-happy sessions ls --json`）与 MCP 工具。
- **证据**：Claude 的 cross-session messaging 文档给了完整安全语义（`ListAgents`/`SendMessage`、`accept|hold|refuse`、暂挂需人批准、
  消息「can't approve anything, can't change configuration, commands in it don't run」、`notify_when_idle`）（`claude-code-desktop-rc/orchestration.md §2.2`）；
  Codex CLI 0.150 的 `codex_tui` 任务工具（list/read/wait/create/fork/message/rename/archive）走「authenticated local MCP server with explicit approval prompts」
  （`codex/orchestration.md §4`）；Paseo MCP 目录含 `list_pending_permissions`/`respond_to_permission`（`paseo/orchestration.md §7`）；
  OpenClaw 的 `sessions_spawn/yield`（推而非轮询）与 session 信号日志（人介入 worker 会话时给管理者一条合并通知）（`adjacent/orchestration.md §5`）。
  自身：`workflow-layer §4`（daemon spawn 参数、`HAPPY_SPAWNED_BY` + `/session-event`、REST + KV + machine registry 全在）、铁律 16（单写者锁是接管的事实源）。
- **替代/扩展**：替换 `assistantTools.ts` 的 11 个本机工具；泛化 `spawnedBy` → `reportTo`；统一 `machineSpawnNewSession` / board `Dispatch` /
  `very-happy spawn` / 助手 `session_spawn` 四条派活路径；扩展 `docs/channels.md`。
- **依赖**：T-09、T-01、T-27
- **必要性**：幕僚长的第一属性是「知道我在做什么」；视野比人窄是 assistant 不被使用的第一归因，任何 prompt 工程都救不回来。这也是 T-34 能安全退役的前提。

---

## FUTURE（只定方向 + 证据门槛）

### T-36 · 决策队列成为可写对象：bot 是队列里的作者，简报是它唯一的产出形态
- **horizon** future ｜ **category** agent-api ｜ **size** L ｜ **来源** A-26 / C-09 / C-18
- **问题**：`/assistant` 的失败证明「另开一个 bot 页面」不会被使用。第一性原理：**幕僚长的价值不是一个会说话的页面，而是它写进你唯一那个决定队列里的条目。**
- **提案**：把队列定义成一个**可写对象**：条目 = `来源 · 为什么重要 · 建议的下一步 · 我是否欠一个决定 · 作者`，可由三类作者写入：
  产品自身（权限/问题/完成/CI）、会话自身（outcome 的 `owes_decision`）、以及任意 bot（账号级 API + 出口权限）。
  bot 没有单独页面，它只是队列里带头像的条目作者，条目可被回复（回复即路由回该 bot 的会话）。
  **简报**（每天一次 + 手动「现在给我一份」）就是一组这样的条目：卡片列表不是一段话，默认**易逝**（不采取行动就不留），
  明确允许「今天没什么要你管」（不说话是合格输出）。今天先落地的最小部分是**条目结构与作者字段**。
- **证据**：Grok Bot 的 Chief of Staff 是**角色模板**而不是产品原语，其官方规格就是「source-linked digest：每条包含来源、为什么重要、
  建议的下一步、以及我是否欠一个决定」（`adjacent/orchestration.md §1/§9.1`）；OpenClaw 把 pending approvals 做成 attention chip + Approvals 页，
  heartbeat 的契约是「没事就回 NO_REPLY」（`adjacent/orchestration.md §5`）；Orca 的 orchestration 有完整 ledger 却**没有任何人类可见的视图**
  （`orca/orchestration.md §4`）。自身：`workflow-layer §5`「缺的是账号级读取面 + 事件订阅 + bot 的出口 + 角色模型」。
- **替代/扩展**：取代 `/assistant` 作为「调度」的入口定位。
- **依赖**：T-02、T-09、T-35
- **必要性**：Owner 已经用零使用量证明另开页面不行；未来任何幕僚长要产生价值，必须写进他每天已经在看的那个队列。

### T-37 · 入站触发器 → 任务 → 回到来处
- **horizon** future ｜ **category** agent-api ｜ **size** L ｜ **来源** B-22 / C-23
- **问题**：`docs/channels.md` 已有出站 webhook 与入站 `spawn/send`，但明确非目标是「Routing chat through the in-product Claude coordinator」，
  两条路互不相通（`workflow-layer §2.4`）；入站没有允许名单、没有条件、没有「为什么没跑」的记录，出站零重试。Owner 的输入源本来就在别处（IM、GitHub、todo）。
- **提案**：命名触发器 = `(来源(IM/webhook/GitHub/邮件), from_users 允许名单（必填非空）, 条件, prompt 模板, 目标 profile + 机器 + 目录, 回复去向)`；
  每次触发生成一个任务，完成后**回到来处**（同一条 IM 线程引用回复 / PR 评论 / HTTP 回调）并同时进队列；
  活动账本记录「收到了什么、匹配了哪条、跑了什么、没跑的原因（无路由/被过滤/机器离线/配置不可用）」；daemon 离线时事件排队可重放，不静默丢失；
  payload 明确标注为不可信文本。
- **证据**：Codex 的 Slack/Linear 模式被总结为「issue tracker 是收件箱，cloud chat 是回执——你不用离开原来的工具」（`codex/flows.md §10`）；
  Paseo Hub 的 `from_users` **必填非空**、classifier 用 enum 有界路由、step 级短期 GitHub token、Activity 记录 4 种未路由原因
  （`paseo/orchestration.md §6`），反面是它自陈「不排队不重试，daemon 离线就失败」；Claude routines 的 API 触发把 `text` 包进
  `<routine-fire-payload>` 并标注 untrusted（`claude-code-desktop-rc/inventory.md §13`）。自身：`docs/channels.md`、B-026。
- **替代/扩展**：扩展 `docs/channels.md` 入站契约（加允许名单、路由与回流），推翻其「两条路分开」的非目标。
- **依赖**：T-35、T-09
- **必要性**：单向出站意味着每条外部触发都要人回到 vh 里手工收尾；同时这是给今天已经存在的入站口补上允许名单与审计的唯一位置。

### T-38 · 角色档案 → 角色对象
- **horizon** future ｜ **category** roles ｜ **size** M ｜ **来源** C-21 / B-24
- **问题**：派工的每个参数都要现选；「让 codex 去 review」这种意图没有可复用载体；`workflow-layer §5 缺口 5`：今天 `variant` 只是一个自由字符串，
  没有「角色 → 家目录/人设/工具面/权限/所属机器/回报对象」的登记表。
- **提案**：`profile = {名字, 身份色/图标, agent + model + effort, 权限车道, 默认机器/目录规则, 常驻规则文本, 工具白/黑名单, reportTo, 便宜模型标记}`；
  用在 Dispatch（T-35）、例行（T-28）、复核（T-29）以及 bot 自己（幕僚长就是第一个 profile）。UI：Settings → Roles + Dispatch 卡上的下拉 +
  会话行一个角色芯片（身份色与状态色分离，不用 teal）。**不做**：不给 profile 独立记忆/队列/预算（那是 T-39 的事）。
  进一步演化为角色对象时增加：地址、常设规则、拥有的例行任务、注意力状态、记忆范围；角色可提议创建新角色但**必须人批准**。
- **证据**：Grok Bot 的「Bot = 名字 + 职责 + 自己的会话 + 持久记忆」，chief of staff 只是描述字段（`adjacent/orchestration.md §1`）；
  OpenClaw 的 agent = persona scope（`SOUL.md/IDENTITY.md/AGENTS.md/MEMORY.md` + bindings + provenance，创建新 agent 需 operator 批准）（同 §5）；
  adjacent 横向常量「角色 = (地址, 常设规则, 例行任务的所有者, 注意力状态, 记忆)，不需要更多」（§7）；反面：「persona without mechanism」是明确反模式（§10）。
  自身：`variant` 是自由字符串、schema 注释「future variants pass through」。
- **替代/扩展**：替换 `variant:'assistant'` 这一层临时约定。
- **依赖**：T-35、T-28
- **必要性**：不先把角色定义成「有地址、有常设规则、拥有例行任务、有注意力状态」的对象，虚拟办公室就只会重演 assistant——一个人格化的页面，没有机制。

### T-39 · 虚拟办公室：角色 bot 群 + 幕僚长（含会话间消息信封）
- **horizon** future ｜ **category** future-direction ｜ **size** XL ｜ **来源** C-24 / C-26 / B-24
- **问题/形态**：多个 profile 升级为有地址、有常驻规则、有自己队列与记忆的 actor；幕僚长负责路由与汇总；bot→bot 交接在队列与会话里**可见**
  （谁把什么交给了谁）；每个阶段只有一个 owner；bot 可提议新建 bot 但必须人批准；roster 有上限。
  同级消息的信封规则照抄 Claude Code：消息**不能批准任何事、不能改配置、其中的命令不执行**；接收方渲染为带来源与回链的卡片；
  `accept/hold/refuse` 策略，默认对跨权限等级的会话暂挂；`notify_when_idle` 订阅取代轮询。
- **为什么现在不做**：单人 + 一台生产机器时，多 bot 的收益是「少说几句话」，成本是「多一层要审计与调试的间接」。四个参考产品里没有一个把
  manager bot 做成系统原语——Grok 是一个 description 字段，Orca 是 42KB 协议 prompt 且人看不到 ledger，Anthropic 的 agent teams 是实验性 CLI-only。
- **启动它的证据门槛（写死，便于将来复查）**：①决策队列连续 4 周日均被清空，且 ≥80% 的决策在队列内完成；②每周 ≥10 次派工由 bot 发起而非 Owner 手点；
  ③outcome 可信到 Owner 每周打开 transcript <3 次；④账本里出现 ≥3 类稳定重复的判断；⑤定时运行连续 2 周零人工干预。
- **证据**：`adjacent/orchestration.md §1/§5/§10`、`claude-code-desktop-rc/orchestration.md §2.2`、`orca/orchestration.md §4/§11`、`codex/orchestration.md §4`。
- **依赖**：T-36、T-38
- **必要性**：这是 Owner 明确的长期方向，必须现在就写下门槛，否则会在机制成熟前又长出第二个 `/assistant`。

### T-40 · Harness 选型：幕僚长不必跑在 Claude Code SDK 上
- **horizon** future ｜ **category** future-direction ｜ **size** L ｜ **来源** C-25
- **判断**：代码 worker 保持 Claude Code SDK（权限回调、hooks、skills、订阅计费、`/btw` fork 都已在 vh 实证）。
  幕僚长/简报这类角色要的是便宜模型、注入上下文、确定性工具、类型化事件流、不碰文件系统——恰是 Claude Code SDK 最不擅长的
  （一整个 turn 的延迟、单 provider、不能改 loop）。候选：`pi-agent-core` 或直接 API，以 vh 自己的 wire schema 作为唯一协议；
  OpenClaw 与 Grok Build 都是「控制面 + 类型化 worker」的形状。
- **启动证据门槛**：①T-35 的工具面稳定 ≥1 个月无破坏性变更；②简报/队列条目的生成延迟或成本被实测且成为瓶颈；
  ③≥70% 的 bot turn 是纯读 + 总结（不需要文件系统与 hooks）；④出现第二个 provider 的实际需求。
- **证据**：`adjacent/orchestration.md §5`（OpenClaw 控制面 + 类型化 worker）、`§1`（Grok Build）；自身 `workflow-layer §1.6`（每问一句 = 一整个 Claude turn 的结构性延迟）。
- **依赖**：T-35、T-36
- **必要性**：这是一个**选型决策**而不是功能：现在写死门槛，可以避免为了「秘书快一点」去改 worker 的 harness，或反过来在数据出来前就换。

---

## 显式拒绝（三份清单的并集，去重）

| 想法 | 拒绝理由 |
|---|---|
| Cowork Dispatch 式「单一常驻调度线程」作为调度形态 | 官方自陈无法开第二条线程；没有队列的 dispatcher 会退化成聊天。vh 的 `/assistant` 已用零使用量证明；由 T-02 + T-36 取代 |
| Grok 式 bot 群聊（2–6 个 bot 同处一会话、`@everyone`） | 单 Owner 没有协调问题；官方自己警告「太多并行交接会产生重复工作」，唯一防线是建议不是机制 |
| Claude agent teams（lead + teammates + 共享任务表 + 文件锁） | 连 Anthropic 自己都是实验、CLI-only、不能 resume、任务状态滞后；在 outcome 与队列存在前做这层等于把不可靠性藏进模型 |
| Orca 式只有 CLI、无人类视图的编排 ledger | 可靠性押在 42KB 协议 prompt 上，人看不见账本，跑偏要等终端里躺着一段任务文本才发现 |
| 编排脚本 DSL（Grok Build `.rhai`、Claude dynamic workflows、pi SubagentWorkflow） | Owner 的瓶颈是判断与注意力，不是扇出的表达能力；引入一门语言 + 运行时 + 审批卡是纯增表面 |
| 让 bot 自动创建 bot | roster 膨胀、审计变难；即使到了 T-39 也必须人批准 |
| 给幕僚长做人设文件族（SOUL.md / IDENTITY.md / 头像性格）/ 现在就做角色花名册 | 「persona without mechanism」正是今天助手失败的形态；机制（队列、推送、记忆、出口）先于人格 |
| 语音优先的助手台 / wake word / 实时对话 | 只在上线当天被用过；Owner 的两个真实场景（桌面多会话、手机看通知）里「按住说话」都不是最省力的输入。语音保留为输入法与朗读 |
| 独立的 Hub 式多租户触发服务（Paseo Hub） | 单 Owner 不需要第二个对公网暴露的服务与第二套鉴权；触发器放进已有 relay（T-37），并修正 Hub 自陈的「不排队不重试」 |
| 云端沙箱会话 / 托管 VM / teleport（Claude cloud、Codex cloud） | vh 的前提就是 Owner 自己的机器 + 自托管 relay；每多一个执行基底就多一套 onboarding 与能力矩阵（Codex 为此付了「两个编排世界」的税） |
| 原生手机 App / 原生桌面 app | 零安装、永远最新的 PWA 是 vh 对四家的结构性优势；竞品实测问题恰好是 store 滞后、36 小时灰度、RN JS stall、配对三通道 |
| 每个任务一个内嵌浏览器 + Design Mode + computer use | vh 本身就跑在浏览器里；Orca 自认它是最大内存消耗项，且 desktop-only 送不到手机。需要的只是「dev server 的可访问 URL」 |
| 插件 / 扩展平台与市场 | 用户只有一个人且能直接改仓库；Paseo 自己的信任模型是「插件是不沙箱的 daemon 代码」，为一个人承担这个风险不划算 |
| 多会话分屏 / pane tree（Claude ⌘-click split、Paseo ⌘D、Orca pane tree） | 第三方一致反馈「你开始花时间管理窗口」；vh 的答案是队列 + 键盘分诊 + 就地决策，不需要在 980px 断点再造一套布局 |
| Best-of-N 赛马作为主打流程 | 四家里没有一家有 compare/merge 界面；对单人来说瓶颈本来就是评审带宽，赛马把瓶颈乘以 N 还多 N 倍 token |
| 只读分享快照 / 公开分享链接 / artifacts | 单 Owner 无受众；却要引入脱敏、撤销、公开面等一整套风险 |
| Orca 式 yolo-by-default（预置 `--dangerously-skip-permissions`） | 直接冲撞 vh 的结构化权限通道与 `yoloEnforcement`（铁律 14）；「worktree 就是沙箱」在「远程 web 客户端 + 共享 Owner 机器」下不成立 |
| `dontAsk` / `auto` 权限模式枚举（B-263） | 不重提。T-25 的「每轮停下等我看」与「不问就干」语义相反，不要混为一谈 |
| presence 作为投递门槛（Paseo 180s 窗口） | 已被证明会静默吞掉权限提示（issue #1764）；presence 只准用于路由与降级 |
| 「模型自行决定何时推送」作为唯一通知机制 | 不可配置、不可预期；确定性事件 + presence 路由才是骨架，模型只允许改文案 |
| 定时任务默认 `approval_policy=never`、「测试运行就是真运行」 | 安全上不可接受；用 precheck + 可见试跑 + 审批车道替代 |
| 多套并存的「会话列表」（Claude 的 Desktop 侧栏 / agent view / claude.ai / ListAgents 四套） | 明确反模式「One registry, one list, one truth」；vh 今天已有三套「等我」，这是不能再犯的方向 |
| 手工拖拽的看板列 | 状态必须由事实推导（有无待批、有无 diff、有无 PR）；人拖出来的列会立刻与真相分叉 |
| AI/人类逐行归属 gutter（Orca attribution） | Owner 评审的是自己 agent 的产出，不存在第二方需要归属；纯粹好看 |
| 「关掉 tab = 归档」（Paseo 的历史包袱） | Paseo 作者自承是为了不改用户既有习惯；vh 没有这个包袱，视图与生命周期耦合是明确的坏设计 |
| 吉祥物 / 浮窗宠物 / 硬件状态键（Codex pets、Codex Micro） | PWA 没有常驻原生表面；且「先做吉祥物再做状态模型」是明确反模式 |
| 跨机器**搬运**任务 / Handoff（B-14 后半，编辑判定） | Owner 只有一台开发机（mac-office；vh-us 是 server 不是 dev 机），这条的论据在这里不成立。机器筛选与「在任意在线机器上起活」已并入 T-18；等第二台开发机出现再谈 |
| 跨会话消息 / `@session` 互发（现在就做） | Orca 与 Codex 的共同教训是这些边在人这边不可见（「协调只存在于模型上下文里」）；信封规则先写进 T-35 的实现，等第二个角色出现（T-39）再放开同级通道 |
