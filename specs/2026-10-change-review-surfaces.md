# 改动审阅面：每轮改动汇总、审阅全部改动、文件预览跟随 agent 改动

> 状态：Final（实现 agent 起草，待主 agent review）
> 日期：2026-10-13 ｜ 关联 backlog：B-571、B-572、B-573 ｜ 出处/前身：B-554（`specs/2026-10-diff-line-comments.md`）；Orca `native-chat-turn-diffs.ts` / `NativeChatTurnDiffRollup.tsx`、`CombinedDiffViewer.tsx` + `combined-diff-toolbar.tsx`、`ExternalFileChangeBanner.tsx`（MIT，只借鉴做法）

## 背景

agent 一轮改了哪些文件，现在只能逐个展开工具卡数；想把整个工作区的改动从头看一遍，只能在改动列表里一个个点开 diff 标签；
文件预览打开后 agent 再改同一个文件，预览不会变（`FsFileViewer` 以 `[machineId, path]` 为 key 只加载一次），用户看的是旧内容而不自知。

## 目标

1. **B-571 每轮改动汇总行**：已结束的一轮末尾显示一行中性汇总「改了 3 个文件 · +40 −12」，可展开列出文件与各自增删；
   点文件就地展开该文件**本轮**的 diff（复用 `DiffView`）；行内「审阅全部」进入 B-572。运行中的轮不显示。
2. **B-572 审阅全部改动**：右侧工作区新增单实例标签「审阅改动」，一条滚动列出工作区全部 git 改动（相对 HEAD）的 diff，
   带文件导航、逐文件「已看」（本机记忆，内容变了自动失效）、全部展开/折叠、换行、忽略空白；行内批注复用 B-554（同一批草稿、同一个发送条）。
3. **B-573 文件预览跟随 agent 改动**：当前会话出现写同一路径的已完成工具事件时，预览在用户没在看细节（无选区、没在滚动）时静默刷新并保留滚动位置，
   否则显示「文件已被 agent 修改 · 刷新」条。不轮询文件系统。
4. 纯函数（turn 汇总、viewed 判定、路径规范化、写事件签名）带单测，覆盖 Claude / Codex / pi 三种消息形态。

## 非目标

- 不改 CLI、server、wire；不加 RPC、字段、Prisma migration。
- 汇总只算**本 web 已加载的消息**里记录到的写工具调用；不跑 git 求「本轮真实落盘差异」（那需要每轮快照，CLI 没有）。
- Bash/终端里 `sed -i`、`cat >`、Codex 在 shell 里直接 `apply_patch` 等**非结构化写入**不计入汇总、也不触发预览刷新（无法可靠识别路径）。
- 不做 side-by-side、不做 diff 内搜索、不做跨设备同步「已看」。
- 汇总不做「部分加载」精确告示以外的回填：更早的历史没加载时，汇总只代表已加载部分（见风险 3）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| transcript 旧→新视图唯一来源（铁律 15），ChatList 与看板共用 | `screens/session/transcriptMessages.ts:28`、`ChatList.tsx:78` |
| turn 切分：`buildChatRows` 以 user-text + `opensTurn` 切轮，`live` = 会话活着且为最后一轮 | `screens/session/chatTurns.ts:279`、`:294-296` |
| 子代理的消息挂在 Task/Agent 工具消息的 `children` 下，不在顶层 | `sync/typesMessage.ts:139-144` |
| Claude 写工具：`Edit{file_path,old_string,new_string,replace_all?}`、`MultiEdit{file_path,edits[]}`、`Write{file_path,content}`、`NotebookEdit{notebook_path}` | `screens/session/ToolView.tsx:80-125`；CLI `sessions/editPaths.ts:13` |
| Claude 旧通道 tool result 带 `toolUseResult`（Write: `type: create/update`，Edit/Write update: `structuredPatch[].lines`）；session 协议通道 `tool-call-end` 的 result 为 null（B-771 起带文本输出，仍无 structuredPatch） | `sync/typesRaw.ts:1113`、`:874-891` |
| Claude 写已存在文件前必须先 Read 过（Claude Code 工具约束），所以「之前没碰过的路径上的 Write」≈ 新建 | 推断，Claude Code 工具说明 |
| pi 写工具经 `normalizePiToolCall` 映射成 Claude 形状的 Edit/MultiEdit/Write | `components/tools/piToolMapping.ts:62-90` |
| Codex 文件改动 = `CodexPatch`，`input.changes: Record<path, {kind:{type:add/delete/update,move_path}, diff?, add?/delete?/modify?/update?}>` | CLI `codex/codexAppServerClient.ts:92-140`、`codex/utils/sessionProtocolMapper.ts:584-611`；web `components/tools/knownTools.tsx:696` |
| 改动列表来源 `sessionBash` 跑 `git status --porcelain=v2` + `--numstat`，路径相对会话 cwd | `sync/gitStatusFiles.ts:44-60` |
| 单文件 diff：`useGitFileDiff` → `gitDiffCommand` + `parseGitUnifiedDiff`，渲染上限 `REVIEW_DIFF_MAX_ROWS = 5000` | `screens/session/diffComments/useGitFileDiff.ts`、`gitDiff.ts:16` |
| B-554 diff 标签 id 前缀 `diff:`，批注组件、重锚、发送条都在 `diffComments/` | `FilesPanel.tsx:33`、`diffComments/ReviewDiffPane.tsx` |
| 工作区标签模型：`openWorkspaceTab` 同 id 重复打开即激活（单实例） | `screens/workspace/workspaceTabModel.ts` |
| 聊天里打开右侧面板靠 URL：`?panel=changes`，`?pinFile=` 由 FilesPanel 消费后删除 | `sessionPanelState.ts:6`、`FilesPanel.tsx:184-189` |
| `FsFileViewer` 以 `[machineId,path]` 为 key、effect 依赖 `[machineId,path,kind]`，只加载一次 | `screens/files/FsFileViewer.tsx:60`、`:97-162` |
| 本机存储惯例：独立 MMKV 命名空间；登出/删会话清理入口 `clearDiffCommentDrafts` | `sync/persistence.ts:379-397`、`sync/sync.ts:1445` |

## 设计

### B-571 每轮改动汇总

**纯模块 `screens/session/turnDiffs.ts`**

- `toolFileEdits(tool, ctx) → FileEdit[]`，`FileEdit = { path, added: number|null, removed: number|null, render }`：
  - 先 `normalizePiToolCall`（pi → Claude 形状）。只认 `state === 'completed'`（失败/拒绝/运行中不算改动）。
  - `Edit`：result 有 `structuredPatch` → 数其中 `+`/`-` 行（精确，含 replace_all）；否则 `replace_all` → 计数未知；否则对 `old_string/new_string` 做行级 diff
    （先剥公共前后缀行，剩余 `n·m > 250k` 时计数未知，避免 LCS 卡主线程）。
  - `MultiEdit`：逐个 edit 同上求和，任一未知 → 未知。
  - `Write`：只信 runner 自己的 result——`type === 'create'` → 全增；`type === 'update'` 且有 `structuredPatch` → 按 patch；
    没有 type（pi、session 协议通道）→ 计数未知（「已改」），不再用「本会话碰过该路径」猜新建（review 低2/低1）。
  - 有 `structuredPatch` 时（Edit/MultiEdit/Write update），展开的 diff 也由同一 patch 还原，数字与展开内容同源。
  - `NotebookEdit`：计数未知。
  - `CodexPatch`：每个 path 一项；`add`（kind.type 或 `add.content`）→ 全增；`delete` → 全删；`update`/`diff`/`unified_diff` → 数 hunk 内 `+`/`-` 行（跳过 `+++`/`---` 头）；
    `modify{old_content,new_content}` → 行级 diff；`move_path` 存在时按新路径记。都没有 → 未知。
  - 其余工具 → 空。
- `render` 是展开时给 `DiffView` 的 `{oldText,newText}`（有 structuredPatch 用它、否则 Edit/MultiEdit 每段一份、Write create 为 `''→content`、patch 由 hunk 还原新旧片段）；没有可渲染载荷时为 null，展开处提示「此改动无可显示的 diff」。
- `turnDiffSummary(turnMessages) → TurnDiff | null`：遍历本轮消息，**子代理归属**：递归进入 Task/Agent 工具的 `children`，
  其中的写入算进**包含该卡的那一轮**（子代理是那一轮派出去的工作；后台子代理在轮结束后才写完时，汇总随消息到达而更新）。
  Codex 子线程（`CodexCollaboration`）的改动不在本会话 transcript 里，不计入。按规范化路径聚合，同一路径多次编辑加总，任一次未知 → 该文件未知。
  文件顺序 = 首次被改的顺序。无文件 → null。
- 计数单位与工具卡 `DiffView` 一致（行）。总计 `+X −Y` 只加已知文件；有未知文件时总计后附「部分未计」，绝不把未知当 0 显示成精确总数。

**接入**：`buildChatRows(messages, live, { turnDiffs: true })` 对每个**非 live、非 compaction** 的轮，在该轮行尾追加
`{ type: 'turn-diff', key: 'turndiff-<userMsgId>', diff }`。选项默认关，既有调用与测试不变；ChatList 只加一个分支渲染 `TurnDiffRollup`（最小挂钩，文件归 r3-composer，主 agent 合并时注意）。
计算缓存在 `WeakMap<ToolCall, FileEdit[]>`，长会话重建行时不重复跑 diff。

**UI `TurnDiffRollup`**：一行中性文本按钮（`--text-muted`，无卡片、无 accent），chevron + 「改了 N 个文件 · +a −b」；
展开后每个文件一行（mono 路径，相对会话 cwd 显示；`+a −b` 或「已改」），点文件行就地展开该文件本轮的各段 `DiffView`；行末「审阅全部」按钮
（会话有 machineId+path 时显示）→ `?panel=changes&review=1`。触屏行高 ≥44px。

### B-572 审阅全部改动

**入口**：FilesPanel「改动」列表头部新增一行「N 个文件 · 审阅全部」；B-571 汇总行的「审阅全部」。都打开 id 为 `review:all` 的工作区标签（`openWorkspaceTab` 同 id 激活，单实例）；
URL `review=1` 由 FilesPanel 消费后删除（与 `pinFile` 同机制）。

**数据**：FilesPanel 已有的 `changed`（`gitStatusFiles` 去重后的列表）；每个文件的 diff 走 B-554 的 `useGitFileDiff`（同一 `bash` RPC、同一 5000 行上限）。
新增 `ignoreWhitespace` 选项 → 命令加 `-w`（git 的 `--no-index` 也支持，数据源能做，所以做这个开关）。
`useGitFileDiff` 加全页并发上限 4（`slotPool.ts`：释放的槽直接交给下一个等待者，杜绝第 5 个插队；pane 卸载或被新一次加载取代时，排队中的请求取消、不占槽），避免「全部展开」一次打满 RPC。
diff 结果带 `ignoreWhitespace` 标记；重锚定只对**非 -w 的行**执行并写回（关掉开关后、新结果到达前仍显示的 -w 行不会写回，review 中1）。

**结构**：把 `ReviewDiffPane` 的「行 + 批注 + 编辑器 + 底部 sheet」抽成 `ReviewDiffBody`（不含头部与滚动容器），单文件 diff 标签与审阅标签共用。
- 审阅标签 = 工具条 + 文件导航 + 一个滚动容器，内含每个文件一个 section（sticky 头：状态字母、路径、`+/−`、「已看」勾选、折叠、打开 diff 标签）。
- **懒渲染**：section 用 IntersectionObserver（`rootMargin` 一屏）首次进入视口才挂载 `ReviewDiffBody` 并取 diff；之后保持。重取 key = 该文件的 `sig + 内容 id`：git status 刷新后只有**内容真变了的文件**重拉，不是所有已展开分段（review 低4）。首次取 diff 等内容 id 查询落定，避免取两次。未挂载时按 numstat 估算高度占位（上限 600px），滚动条不乱跳。
- **工具条**：「已看 k/N」、全部展开/全部折叠、换行（本标签内开关，默认跟随 `wrapLinesInDiffs` 在触屏的语义）、忽略空白。
- **文件导航**：≥1100px 时左侧 220px 列表（点击滚到 section、显示已看勾）；窄屏收为顶部「文件」下拉列表按钮（全屏面板内）。
- **忽略空白时不重锚批注**：`-w` 下某些行不在 diff 里，重锚会把好好的批注写成「已过期」；该模式下批注只读定位（找不到的放 section 顶部「不在当前 diff」），不写回存储。新建批注仍可（锚定按真实行号与内容）。

**已看（`reviewViewed.ts` 纯函数 + `reviewViewedStore.ts`）**
- 记录 `{ path → { sig, cid, hash, at } }`：`sig` = git status 的 `状态:+N:-M`（staged+unstaged 合计）；`cid` = 工作区内容 id；`hash` = 已加载 diff 行的 FNV-1a（复用 B-554 hash）。
- 内容 id（review 中3）：每次 git status 刷新后批量一次 `git hash-object -- <路径…>`（每批 ≤100 个，路径沿用 `quoteShellArg` 按目标 shell 引用；hash-object 收的是**文件名不是 pathspec**，所以不加 `:(literal)`，`--` 防 `-` 开头被当选项）；删除的文件 id 固定为 `deleted`；输出行数对不上或命令失败 → 这批无 id，退回 `sig`。
- 判定：`sig` 不同 → 失效；双方都有 `cid` 且不同 → 失效（增删行数不变的改动也能识别）；diff 已加载且 `hash` 不同 → 失效；都未知时只看 `sig`。失效的记录在下次写入时清除。
- 已看文件默认折叠。存储：MMKV `review-viewed`，每会话一个 key，单会话 ≤500 条；读入逐条校验。登出与删会话随 `clearDiffCommentDrafts` 一起清（同一清理函数追加一行）。

**批注**：`ReviewDiffBody` 用同一 `useDiffComments` 存储、同一 `DiffCommentsBar`（FilesPanel 顶部已有），所以在审阅标签里写的批注与单文件 diff 标签互通、一次发送。

**手机**：<1100px 时右侧工作区本来就是全屏面板；工具条按钮、section 头操作、勾选命中区 ≥44px；批注走 B-554 的底部 sheet。

### B-573 文件预览跟随 agent 改动

- 纯函数 `normalizeAbsPath(path, cwd, home)`（`~`/`~/` 用会话 `metadata.homeDir` 展开，取不到则原样；`resolveAgainstCwd` + 折叠 `.`/`..`/重复斜杠）。
  **不处理大小写不敏感文件系统与符号链接**：同一文件的另一种写法不触发刷新（漏判，不误判）。
- `lastAgentWriteAt(messages, targetAbs, cwd, home) → number`：本会话已完成写工具（含子代理 children）中路径规范化后等于目标的最晚完成时间。
  只比较时间、不比较次数——次数会随更早的历史分页载入而变，误触发刷新（review 中2）。每条消息的写入路径按消息对象缓存（WeakMap），
  消息列表最多每秒采样一次（前沿立即、窗口内合并为一次尾随更新，review 低3）。
- `FsFileViewer` 新增可选 `sessionId`。记录本次读文件的时间 `readAt`；只有 `lastAgentWriteAt > readAt` 才算 agent 新写过（处理后把 `readAt` 推到该时间，同一次写不重复提示）。
  完成时间来自服务端时间戳、`readAt` 是本机时钟：本机时钟快于服务端时可能漏一次跟随（只会漏判，手动刷新仍可用）。
  FilesPanel 的文件标签与 Browse 内预览（`FsBrowser` 透传）、`open_preview` 弹层（请求带 sessionId 时）传入；机器文件页不传 → 行为不变。
- 变化时：
  - 当前是文本/markdown/代码视图，且视图内**没有非空选区**、**最近 1.5 s 没有滚动/按下**、标签可见 → **静默刷新**：
    不切 loading，新内容到达后替换并恢复 `scrollTop`（按比例夹到新高度内）。
  - 否则（有选区、正在滚、html 沙箱、图片/PDF/表格、不可见标签）→ 显示中性条「文件已被 agent 修改 · 刷新」，点刷新 = 同样的保留位置重读；关闭条不重读。
- 只由消息事件触发，不轮询文件系统、不加 RPC。

### 被否方案

- **汇总用 git 实测**（每轮结束跑 `git diff --numstat`）：要每轮基线快照，多轮之后无法区分是哪一轮改的；且要为历史轮补跑 RPC。按工具记录是唯一不需要 CLI 改动的来源，Orca 同样按「recorded edits」。
- **汇总点文件跳到右侧 diff 标签**：右侧是相对 HEAD 的累计 diff，不是「本轮」；就地展开本轮片段更贴题，右侧入口由「审阅全部」承担。
- **审阅标签自己再实现一套批注**：会出现两份草稿和两个发送入口；抽出 `ReviewDiffBody` 共用。
- **预览轮询 mtime**：新增常驻轮询（spec README 要求的「新轮询」），且 agent 写文件已有事件可用。

## 兼容矩阵与发布顺序

只改 web；不改协议、字段、RPC；读到的消息字段全部是既有字段，缺失时降级。

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 旧 | 旧/新 | 旧 | 不变 |
| 旧 | 旧/新 | 新 | 汇总按已有工具消息计算：旧 Claude 通道有 `toolUseResult` 时用精确 patch，session 协议通道无 result 时按 input 计算/「已改」；Codex `CodexPatch` 各版本都有 `changes`；pi 走既有映射。审阅标签用既有 `bash` RPC（所有版本都有）。预览跟随只看消息 |
| 新 | 旧/新 | 新 | 同上（CLI 无改动） |
| 任意 | 任意 | 新，机器离线 | 汇总照常（纯客户端）；审阅标签各 section 显示 diff 获取失败与重试；预览保持旧内容，刷新失败按既有错误显示 |
| 任意 | 任意 | 新，消息形态未知（未来工具名/字段） | 不识别 → 不计入、不触发；不报错、不丢消息 |

- 发布顺序：无约束，随下一次 server/Web 镜像。回滚：回滚 Web 镜像；本机 `mmkv:review-viewed:*` 残留无害（且登出时清理）。

## 风险

1. **计数与真实落盘不一致**：编辑后被 agent 自己再改回、Bash 写入、外部进程写入都不在汇总里。文案用「改了」而非「最终差异」，展开说明「按本轮记录的编辑统计」。接受。
2. **Write 没有 result type 时显示「已改」**：pi 与 session 协议通道下新建文件也只显示「已改」而无行数——宁可少报，不猜新建（review 低1）。接受。
3. **部分加载的轮**：长会话只加载了最近一页时，最早那一轮可能缺前半段工具消息。该轮仍显示其已加载部分（与工具卡显示一致）。接受。
4. **静默刷新打断阅读**：以「无选区 + 1.5s 内无滚动/指针按下」为闸，误判时最多是位置按比例恢复。不满足就只出提示条。
5. **大量改动文件**：懒挂载 + 并发上限 4 + 单文件 5000 行上限 + `content-visibility: auto`。上百个文件时导航列表本身是普通列表，可接受。
6. **`-w` 与批注**：忽略空白模式下不写回重锚结果（见设计），避免把批注错误标成已过期。

## 验收标准

- [ ] 已结束的一轮有写入时，回复末尾出现「改了 N 个文件 · +a −b」，展开列文件与各自增删；无法计数的显示「已改」。运行中的轮不显示。
- [ ] 点文件就地展开本轮该文件的 diff；「审阅全部」打开右侧审阅标签。
- [ ] 纯函数单测覆盖 Claude（Edit/MultiEdit/Write create/update/覆写/structuredPatch/replace_all）、Codex（add/update/delete/move、旧 MCP 形状）、pi（edit 单/多段、write）与子代理归属。
- [ ] 审阅标签单实例；一条滚动列出全部改动文件；导航、已看（改动后失效）、全部展开/折叠、换行、忽略空白可用；批注与单文件 diff 标签互通并由同一发送条发送。
- [ ] 进入视口才取 diff；单文件 5000 行上限仍生效。
- [ ] 文件预览打开时 agent 写同一文件：未交互则静默刷新且滚动位置保留；有选区时出现「文件已被 agent 修改 · 刷新」条。
- [ ] web tsc 0 错误、相关 vitest、vite build 通过；1280 / 390 coarse × 亮 / 暗 真浏览器取证。

## 留真机验证项

- iOS Safari：审阅标签全屏面板内 sticky section 头与软键盘（批注 sheet）的遮挡关系。
- 真实 Codex / pi 会话产生的改动在汇总行的计数（本机验收用模拟消息与 Claude 会话）。
