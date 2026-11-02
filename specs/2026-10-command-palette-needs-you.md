# ⌘K 面板：空查询置顶「等我看」+ 无匹配时「新建对话：<查询>」

> 状态：Final
> 日期：2026-10-12 ｜ 关联 backlog：B-552 ｜ 出处/前身：Orca Cmd-J（Recent Chats & Terminals、Create worktree 行）对照

## 背景

⌘K 打开后空查询列出全部动作（约 15 条）再列全部对话，真正要处理的对话（等授权、跑完没看）
被压在折叠线下面，用户还得再去侧栏/看板找。Orca 的 Cmd-J 空查询直接把「需要你」的会话放在
最上面、每行带实时状态与「多久前」；打字没命中时给一行「用查询新建」。本项只移植这两点。

## 目标

1. 空查询时，面板最上方出现「等我看」段：最多 6 个对话，成员与顺序即看板 lifecycle 的
   waiting 列（同一个分类器与总序，不另写排序）。当前正在看、且不是紧急（只是空闲/已结束）的
   那个对话不列出；它若在等授权等紧急状态则仍列出。
2. 每行行尾显示与侧栏同语义的状态位（运行/等待/未读/离线/未知，不显示空闲）+「多久前」。
3. 成员与顺序在面板打开时冻结，打开期间状态变化只更新行尾状态位，行不跳动；Enter 不会因为
   重排落到别的行上。
4. 有查询时保持现有匹配（子串 + `#tag` 语法）不变；若没有任何**对话**命中且查询带自由文本，
   在列表最后追加一行「新建对话：<查询>」。选中后走现有 `createChatOrConfigure`：
   快速路径把查询写成新会话（pending 页）的输入框草稿，**不自动发送**；需要选项时打开
   NewSessionModal，查询预填到「初始指令」字段（用户在弹窗里确认后才创建并发送）。
5. 键盘导航（↑↓/Enter/Esc）按屏幕显示顺序移动；B-549 的「搜索历史对话…」保留。

## 非目标

- 不改看板/侧栏的分类、排序与渲染（`screens/board/**`、`Sidebar.tsx` 归其他任务）。
- 不加 ⌘1–6 数字直达、不加 terminal 到「等我看」段（任务限定对话）。
- 不改模糊匹配算法、不加最近工作区段。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 看板分类与总序：`buildBoardItems` 排序（attention 等最久优先 → working → idle 新优先 → unknown → ended），`buildLifecycleColumns` 只过滤不重排 | `packages/happy-web-v2/src/screens/board/boardItems.ts` `buildBoardItems` 末尾 sort、`buildLifecycleColumns` |
| 紧急等待原因集合 | `boardItems.ts` `URGENT_WAIT_REASONS` |
| store 接线 hook（侧栏、通知生成器已在用） | `screens/board/useBoardItems.ts` `useBoardItems`；`screens/sessions/Sidebar.tsx` `useBoardItems()` |
| 侧栏行状态位：BoardItem→AgentExecution 映射内联在 `executionByKey`，图形由 `agentStatusSignal` + 内联 JSX 决定（无独立组件） | `Sidebar.tsx` `executionByKey`、`sb-row-status` span；`sync/agentStatus.ts` `agentStatusSignal` |
| 「多久前」现有格式化 | `utils/sessionUtils.ts` `formatLastSeen` |
| 新建对话唯一入口；快速路径 `pendingSessions.create` 后跳 `/session/<pendingId>` | `app/newChat.ts` `createChatOrConfigure` |
| pending 页初始输入框文本读 `sessionDrafts[pendingId]`，spawn 后 `migrateDraft` 迁到真 id | `sync/pendingSessionsRuntime.ts` `pendingDraft` / `migrateDraft`；`SessionDetailScreen.tsx` `pendingInitialDraft` |
| `updateSessionDraft` 对 store 里不存在的 id 也会持久化草稿 | `sync/storage.ts` `updateSessionDraft` |
| NewSessionModal 有 `initialCommandDefault` 预填初始指令 | `screens/sessions/NewSessionModal.tsx` |
| 现有面板键盘按 `filtered` 顺序走，渲染按分组顺序，两者可错位 | `screens/command/CommandPalette.tsx` `onKeyDown` / `groups` |

## 设计

- 新纯函数模块 `screens/command/paletteModel.ts`（+ 单测）：
  - `selectNeedsYouSessions(items, { currentSessionId, limit = 6 })`：`buildLifecycleColumns(items).waiting`
    → 只要 `kind === 'session'` → 去掉「当前 + 非紧急」→ 截断。不排序，顺序完全继承看板。
  - `boardItemExecution(item)`：BoardItem → AgentExecution，与侧栏 `executionByKey` 同表。
  - `filterPaletteItems(items, query)`：从组件搬出的现有过滤（行为不变）。
  - `orderPaletteItems(items)`：按显示分组（needsYou → actions → sessions → terminals → create）稳定重排，
    键盘与渲染共用这一份顺序。
  - `newChatDraftFor(query, matched)`：有自由文本、且命中里没有 `sessions`/`needsYou` 行时返回草稿文本，否则 null。
- 面板拆成「常驻壳（快捷键、弹窗状态）」+「打开时才挂载的 `CommandPalettePanel`」，`useBoardItems`
  只在面板打开时订阅。
- 冻结（`freezeNeedsYouKeys`）：session store `isDataReady` 之前不冻结、也不渲染「等我看」段；ready 后立刻冻结
  当时的选择（空也冻结），之后按 key 取最新 BoardItem 渲染状态位；某 key 已不在 board（被归档）就不渲染该行。
- 高亮按行 key（`resolveActiveIndex` / `moveActive`）：面板挂载后立即把高亮钉到具体 key，其他行插入/移除不移动它；
  高亮行消失时退到滑入其原位置的相邻行（原为末行则退到新末行）。
- 状态位文案：`utils/agentStatusLabel.ts` 纯函数复刻侧栏的拼装（agent 前缀、offline/unknown 说明、legacy 注），
  面板调用；Sidebar.tsx 不改（并行任务热区），其内联拼装与此函数「文案 key 与拼装规则一致」，后续可切换。
- 行尾状态位：新组件 `screens/command/PaletteStatusMark.tsx`，图形/颜色/提示文案与侧栏一致
  （同 lucide 图标、`Spinner`、`sidebar.*` 文案键，颜色 token 与 `.sb-row-status*` 相同）。
  侧栏的状态位是 Sidebar.tsx 内联 JSX，属并行任务热区，本项不改 Sidebar；后续可让侧栏改用此组件。
- 「多久前」：`formatLastSeen(attentionSince ?? lastActivityAt)`，Mono 小字。
- `createChatOrConfigure` 的 `context` 增可选 `draft?: string`：快速路径在 `navigate` 前
  `updateSessionDraft(pendingId, draft)`；configure 回调多传第二参 `{ draft }`，面板据此给
  NewSessionModal 传 `initialCommandDefault`。其他调用方不传则行为不变。

## 兼容矩阵与发布顺序

纯 Web 改动，无 wire/server/CLI 字段、无 migration、无新 RPC。

| 组合 | 行为 |
|---|---|
| 新 Web × 旧/新 server × 旧/新 CLI | 「等我看」只读已有 board 分类（presence/agentState/heartbeat/metadata.board），旧 CLI 没有 LLM 判定字段时只少 review/blocked 原因，与看板一致；新建对话走已有 spawn RPC，草稿只存浏览器本地 |
| 旧 Web × 任意 | 无变化 |

发布顺序：随常规 server/Web 镜像发布即可；回滚 = 回滚 Web 镜像。

## 风险

1. 面板打开时多一份 `buildBoardItems` 计算 —— 只在打开期间挂载，关闭即卸载；接受。
2. configure 路径的「初始指令」在用户点创建后会作为首条消息发送 —— 这是用户在弹窗内显式确认，
   且字段可编辑/清空；快速路径严格只写草稿。接受并在验收中注明。
3. 冻结后某行状态变为 running 仍显示在「等我看」段 —— 与 Orca 一致（防跳动），行尾状态位会实时显示运行中。

## 验收标准

- [ ] 空查询：最上方「等我看」段 ≤6 行，顺序 = 看板「等我看」列中对话的顺序；当前空闲对话不出现。
- [ ] 行尾状态位与侧栏同图形，后跟「多久前」。
- [ ] 输入不匹配任何对话的文本：最后一行「新建对话：<查询>」；回车后进入新对话页，输入框含查询，未发送。
- [ ] ↑↓ 按屏幕顺序循环、Enter 打开、Esc 关闭；「搜索历史对话…」仍可搜到。
- [ ] 1280 与 390（coarse）× 亮/暗 无溢出，行高触屏 ≥44px。
- [ ] `paletteModel.test.ts` 覆盖选择/过滤/排序/草稿判定；web tsc、vitest、vite build 通过。

## B-865：搜索合并为一个入口（2026-11-02）

Owner：「cmd +k 需要也能搜索对话和侧边栏右上角的一样，搜索入口需要 all in one」。B-650 的会话搜索面板（`specs/2026-10-projects.md` §7）并入本面板，不再单独存在。

- **入口**：⌘K、⌘⇧F（Ctrl+Shift+F；非 macOS 在 web 终端内仍归终端查找，`matchSessionSearchChord`）、侧栏 🔍、更新说明里的「会话搜索」动作，全部打开同一个面板、同一份状态（`openSessionSearch` = 派发 `COMMAND_PALETTE_OPEN_EVENT`）。不设「只看对话内容」模式：三个入口行为一致，少一个要记的状态。⌘K 里原「搜索会话…」动作删除。
- **筛选条**：输入框下一行 chip：状态（默认「未归档」，可选等你/含归档/仅归档）、项目、机器、Agent、时间，非默认时出现「重置」。筛选作用于「等我看」「会话」「对话内容」三组；动作、终端、设置不受影响。默认不含归档：空查询也列会话，而侧栏列表本来就不含归档。
- **「对话内容」组**（位于「会话」之后、「终端」之前）：自由文本 ≥2 个字符（`CONTENT_MIN_CHARS`）才搜。本地标题/元数据 + 已加载消息在 120ms 防抖后算，daemon `history-search` 再等 130ms（合计约 250ms）并发到每台在线机器；其余分组即时出结果、不等它。过时请求的回包按轮次丢弃（`useContentSearch` 的 round 计数）。
- **去重**（`paletteModel.splitSearchRows`）：一个会话只出现一次。标题已在「会话」组命中的，内容片段挂到那一行下面，Enter 仍只是打开会话（快速切换不能落到对话中间），点片段才跳到命中处；标题没命中的会话进「对话内容」，Enter 跳到第一条命中；只在元数据（项目名、机器名、多词 AND）命中而子串没命中的会话补进「会话」组；没有会话对应的历史对话是「可导入」行，点开机器历史导入。
- **状态行**：「对话内容」组标题旁写「正在搜索 N 台机器… · M 台离线 · CLI 过旧 · 未响应 · 建索引中」，下附机器名；还没有内容结果时组标题照样占位。高亮按行 key 跟踪，结果流式插入不挪动选中行。
- **键盘**：↑↓ 在所有分组间连续移动（只在搜索框里生效；聚焦的筛选 chip、片段按钮保留自己的按键）；Esc 先关打开的筛选菜单（`pickerOwnsKey`），再关面板，并 `preventDefault`（B-857b：只关最上层）。
- **手机**：面板全屏（与原会话搜索一致），右上角关闭按钮、片段、chip 触控高度 ≥44px，筛选条横向滚动。
- 原面板里没有「导出」功能（只有「可导入」行），保留的是导入。

## 留真机验证项

- iOS 软键盘弹出时面板与「新建对话」行可点（浏览器 coarse 模拟验不了真软键盘遮挡）。
