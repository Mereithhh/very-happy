# 对话阅读辅助：选中引用、中断后继续、提问导航轨

> 状态：Final（实现随分支 `feat/orca3-chat`）
> 日期：2026-10-13 ｜ 关联 backlog：B-577、B-578、B-579 ｜ 出处：Orca native-chat（MIT）的 `NativeChatSelectionQuote`、`NativeChatInterruptedContinue`、`NativeChatMessageRail`，只借做法

## 背景

长对话里三个高频小摩擦：

1. 想针对回复里的**一句话**追问，只能整条引用（B-454 的引用按钮）再手删。
2. 自己按了停止之后，transcript 只剩一行「已由你停止」，要继续就得自己敲「继续」。
3. 长会话里找回自己之前问过的某个问题，只能一路滚。

## 目标

- B-577：选中消息（agent 回复或用户气泡）里的一段文字 → 一键把这段以引用格式插到输入框光标处并聚焦。
- B-578：最近一次「已由你停止」那一行带中性按钮「继续」，点一下发出普通用户消息「继续 / Continue」。
- B-579：桌面在对话列右侧显示「你的提问」刻度轨；窄屏/触屏提供「上一条提问 / 下一条提问」按钮。

## 非目标

- 不改协议、不加 wire/server 字段、不加 migration；三项均为纯 Web。
- 不做 Orca 的 `continueInterrupted` 专用 RPC（「先检查上一步是否完成」那套）。继续 = 一条普通消息。
- 不做 ChatList 虚拟化（B-044）；导航轨只覆盖已加载的消息。
- 不改整条引用（B-454）的「追加到末尾」行为。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 整条引用经 window 事件 `vh:message-quote` 交给输入框 | `packages/happy-web-v2/src/screens/session/messageQuote.ts:1-13` |
| 输入框收到引用后**追加到草稿末尾**（`> ` 前缀、前后空行）并聚焦 | `screens/session/AgentInput.tsx:395-398`、`messageActionsModel.ts:19-22` |
| 「已由你停止」是 service event `Aborted by user`/`turn aborted` 的展示 | `serviceEvent.ts:46-48`、`MessageView.tsx:341-343` |
| CLI 只在用户停止时发 `Aborted by user`（Claude / Codex / Gemini） | `happy-cli/src/claude/claudeRemoteLauncher.ts:755,792`、`codex/runCodex.ts:493`、`gemini/runGemini.ts:1170` |
| 无最终回答的已结束 turn 会把除失败以外的所有事件折进 activity 抽屉，**停止行也被折叠**（只有失败被提出来，B-487） | `chatTurns.ts:342-360`、`isTurnFailure` `chatTurns.ts:157-161` |
| B-520 的建议选项点击直接走 `sync.sendMessage(sessionId, text, { source: 'chat' })` + `requestChatFollow` | `MessageView.tsx:195-199` |
| 输入框非排队路径同样落到 `sync.sendMessage`（`sendQueuedItem` → `deliverQueuedMessage`）；排队只在 agent 工作中或 `restore-first`（已归档）时介入 | `AgentInput.tsx:451-467, 565-617`；`app/sessionRestoreRules.ts:153` |
| 镜像会话（B-105）只读，没有输入框 | `SessionDetailScreen.tsx:235, 284-300` |
| transcript 滚动容器 `.cl-scroll`、内容列 `.cl-inner`（最宽 820px 居中），无虚拟化 | `ChatList.tsx:331-345`、`chatlist.css:25-48`；backlog B-044 |
| 更早历史按页加载，`hasMoreOlder` 时顶部有「加载更早消息」 | `ChatList.tsx:340-351` |
| ChatList 渲染顺序旧→新（铁律 15：`transcriptChronological`） | `transcriptMessages.ts` |
| 代码块 DOM：`.cv` > `.cv-bar .cv-lang` + `.cv-body` | `CodeView.tsx:67-82` |

## 设计

### B-577 选中引用

**可引用范围**：带 `data-quote-source` 的元素——agent 正文 `.msg-agent-text`、用户气泡正文 `.msg-bubble-text`。思考块、工具输出、事件行不可引用。

**选区判定**（`selectionQuoteRange.ts`；文件名避开组件 `SelectionQuote.tsx`，macOS 大小写不敏感）：

- 选区必须非空、单 range，第一段真正选中的文字落在 transcript 内某个 quote source 里（起点在标题栏/输入框等 transcript 之外则不提供）。
- **跨多条消息：桌面只取起点消息内的部分**——把选区本身收回到起点消息末尾（所见即所引，`selection.toString()` 保留块间换行）。三击选段时浏览器把终点放到下一个块的开头，这一规则顺带解决它。裁剪后为空则不提供。**触屏不改用户的选区，跨消息直接不提供。**
- 选区起止都在同一个代码块 `.cv-body` 内 → 保持原文，用 ```` ```<lang> ```` 包起来再加 `> ` 前缀；否则按普通文本引用。
- 引用格式与 B-454 一致：逐行 `> `，空行写成 `>`。

**插入**：`messageQuote.ts` 的事件 detail 追加可选 `mode: 'cursor'`（旧监听者忽略），AgentInput 只追加这一个「引用插入」接口：

- `mode: 'cursor'` 且输入框在本次挂载后聚焦过（光标位置可信）→ 在 `selectionStart..selectionEnd` 处插入（替换选中的草稿文字），前后补空行，光标落在引用之后的空行上，聚焦。
- 从未聚焦过 → 退回追加到末尾（与整条引用相同）。
- 不带 mode 的整条引用行为不变。

**桌面（`pointer: fine`）**：选区稳定后在选区**上方**、靠终点处浮出单个按钮「引用」（`Quote` 图标 + 文字，中性表面）。

- 鼠标单击/三击松开立即判定；**双击后等 500ms**再出，避免第三击正好落在按钮上（Orca 同款）；键盘选区（Shift+方向键）在 keyup 时判定。「选区有没有变」除了 `selectionchange` 标记，还比较按下时的选区文字——双击的选词发生在 mousedown，`selectionchange` 可能晚于 mouseup 才到（真浏览器实测漏掉过）。
- 按钮 `mousedown` 阻止默认，点击不丢选区；点击后按钮消失、选区保留。
- 选区变化、在别处按下、Esc、窗口失焦、视口尺寸变化 → 收起。transcript 滚动时按钮跟随选区，选区滚出 transcript 可视区则隐藏。
- 没有输入框（镜像会话）不提供。

**触屏（`pointer: coarse`）**：不画浮层，不干扰系统选区菜单。`selectionchange` 停止 500ms 后若选区可引用，该消息自己的操作栏（`MessageActions`）多出一个「引用选中」按钮（44px）；点击用的是当时记下的文字，按钮 `pointerdown` 阻止默认以保住选区。选区收起同样要静止 500ms 才撤掉按钮，避免「点按钮时系统先清选区」导致按钮消失点不到。

### B-578 中断后继续

**谁有按钮**（纯函数 `continueOfferStopId`）：transcript（旧→新）里最后一个「已由你停止」事件，且它之后没有任何 user-text（包括任务通知——agent 已经被别的输入接上了）。只这一行有按钮，历史上的停止行没有。

**什么时候显示**（组件判定）：

- 非镜像会话；
- agent 不在工作（与 ChatList 同一个 `isAgentWorkLive` 判据）——工作中点继续会变成排队消息，语义不对；
- `composerGate(session) === 'send'`。已归档会话的输入框是「先恢复再发」，那条路径归输入框所有，这里不复制，按钮不出现，用户照旧在输入框发消息。

**停止行不再被折叠**：已结束且没有最终回答的 turn，末尾的停止事件像 B-487 的失败一样提到 activity 抽屉外单独成行（否则按钮看不见）。有回答的 turn 停止行本来就在外面。

**发送**：点击 → 按钮立即禁用 → `requestChatFollow` + `sync.sendMessage(sessionId, 继续|Continue, { source: 'chat' })`，与 B-520 选项、输入框的直接发送同一条路径；发送状态（B-513 发送中/失败重试）由那条用户消息自己承担。新用户消息一落地，按钮按规则消失；`sendMessage` 抛错或返回空则恢复可点。

**文案**：按界面语言——中文「继续」，繁中「繼續」，其余 `Continue`；按钮文字即发送内容。按钮中性（`--bg-1` 底、`--line` 描边，hover 只变中性色阶），**不用 accent**；触屏 44px 命中区。

### B-579 提问导航

**条目**（纯函数 `chatRail.ts`，由 ChatList 已有的 rows 推导）：每个渲染成用户气泡或 `/命令` 的 user-text 一条；不含 AskUserQuestion 的答案投影（`:answer`）、任务通知、team/peer 卡片。预览 = 你的话（压成一行，截 120 字）+ 该 turn 第一条可见 agent 正文的首个非空行（截 120 字）。顺序即 rows 顺序（旧→新）。

**桌面轨道**（`pointer: fine`，且对话列右侧留白 ≥ 40px，即 `.cl` 宽度 − `.cl-inner` 宽度 ≥ 2×40；条目 ≥ 2 才出现）：

- 位于 `.cl` 右侧留白，纵向覆盖 transcript 可视高度（顶部留 12px，底部让出「跳到最新」按钮的 64px，两者不重叠），每条一个横向细刻度，`top = 消息 offsetTop / 内容总高`（按会话中的位置比例分布）。内容尺寸变化（ResizeObserver）与 rows 变化时重算。
- 当前提问高亮：贴底时取最后一条；否则取「顶部 1/4 处之上的最后一条」。高亮用 `--text`，普通刻度 `--text-faint`，**不用 accent**。
- 悬停/键盘聚焦刻度 → 左侧出现单个预览卡（你的话 2 行截断 + 回复首行 2 行截断）。
- 点击 → 只滚 `.cl-scroll` 到该消息上方 12px（`scrollTo`，系统减少动态效果时 `behavior: 'auto'`，否则 smooth），不用会滚祖先的 `scrollIntoView`。
- 轨道是一个 `role="toolbar"`，单一 tab stop（当前项）；焦点在轨道上时 ↑/↓ 前后跳并滚动，Home/End 到首尾。
- `hasMoreOlder` 时轨道顶部一个小按钮「更早的消息未加载」（点击 = 加载更早消息），未加载的消息没有刻度。

**窄屏 / 触屏**（轨道不显示时）：选「上一条提问 / 下一条提问」两个 44px 圆钮，竖排在「跳到最新」按钮正上方，**只在离开底部（与跳到最新同一条件）时出现**，不常驻；没有目标的方向按钮禁用。排队 dock 出现时（跳到最新挪进 dock）不显示这组按钮，避免压住 dock。否决长按菜单：长按在触屏上与系统选区/上下文菜单冲突，且不可发现。

「上一条」= 视口顶部之上最近的提问，「下一条」= 视口顶部之下最近的提问；滚动规则同桌面。

### 挂载与文件

- 新纯函数：`selectionQuoteRange.ts`、`chatRail.ts`、`continueOffer.ts`、`messageActionsModel.insertMessageQuoteAt`（含测试）；组件：`SelectionQuote.tsx`、`ChatPromptRail.tsx`、`selectionQuoteOffer.ts`（触屏选区 → 操作栏的小 store）、`chatReadingAidsCopy.ts`（中英文案，沿用 `messageActionsCopy` 的按语言模块写法，不动共享热区 `text/_default.ts`/`zh-Hans.ts`）、`chatReadingAids.css`。
- ChatList 只做最小挂钩：渲染 `<SelectionQuote>` 与 `<ChatPromptRail>`。MessageView：quote source 标记、用户气泡的 `data-chat-prompt-id`、停止行的继续按钮。MessageActions：触屏「引用选中」。chatTurns：停止行提到抽屉外 + `continueOffer` 标记。

## 兼容矩阵与发布顺序

三项都只读已有消息与 session 字段，只写普通用户消息；不新增任何字段。

| 组合 | 行为 |
|---|---|
| 新 web × 旧 CLI（daemon+wrapper） | 全部可用。「继续」是普通用户消息，任何 CLI 都当作普通 prompt；停止行依赖的 `Aborted by user` 事件由已发布 CLI 产生，更老的 CLI 若不发该事件，只是没有按钮（与今天相同）。 |
| 新 web × 新/旧 server | 不涉及 server 改动，行为相同。 |
| 旧 web × 任意 | 无变化。 |
| 新 CLI × 旧 server | 不涉及。 |

发布顺序：随常规 server/web 镜像发布，无 CLI 要求。回滚 = 回滚 web。

## 风险

1. **选区 DOM 判定在各浏览器不同**（三击、`user-select: none` 的行号）：用「裁到起点消息」+ 判空兜底；真机项进 verify queue。
2. **触屏点按钮时系统先清选区**：按钮用记下的文字 + 延迟 400ms 移除；iOS 真机行为浏览器验不了，进 verify queue。
3. **继续被误点两次**：点击即禁用，新用户消息落地后按钮按规则消失。
4. **长会话轨道刻度过密**：刻度按位置比例绘制，相邻重叠可接受（悬停预览仍能区分）；ChatList 没虚拟化，测量为 O(提问数) 的 offsetTop 读取，只在尺寸/rows 变化与滚动（rAF 合并）时做。
5. **停止行从抽屉移出**改变了无回答停止 turn 的外观：这正是本需求要的可见性，与 B-487 的失败行一致。

## 验收标准

- [ ] 桌面选中 agent 回复中一段 → 选区上方出现「引用」→ 点击后输入框光标处出现 `> …` 并获得焦点；选中代码块内文字 → 引用里是 ```` ``` ```` 包裹的原文。
- [ ] 选区从一条消息拖到下一条 → 只引用起点消息内的部分。
- [ ] 双击选词 500ms 内不出现按钮。
- [ ] 触屏选中后无浮层；该消息操作栏出现「引用选中」（44px）。
- [ ] 停止后最近一次停止行有「继续」（中性色）；点击发出「继续/Continue」，之后按钮消失；agent 工作中、镜像、已归档会话不出现；更早的停止行没有按钮。
- [ ] 1280 桌面：右侧轨道刻度与提问一一对应、比例分布；悬停预览；点击滚动到提问；↑/↓ 跳转；当前项高亮为中性色；有未加载历史时顶部提示。
- [ ] 390 coarse：无轨道；离底时「上一条/下一条提问」44px 可用。
- [ ] 亮/暗两主题、无横向溢出；纯函数单测覆盖判定规则。

## 留真机验证项

- iOS/Android 选中文字后系统菜单仍正常，操作栏「引用选中」可点到（选区不会先被清掉）。
- 触屏「上一条/下一条提问」与软键盘、排队 dock 共存时的位置。
