# Web 健壮性：局部错误边界 · 归档/完成可撤销 · 自动已读要求人在场

> 状态：Draft
> 日期：2026-10-13 ｜ 关联 backlog：B-565、B-566、B-567（B-565 落实 B-027 第一件）｜ 出处：Orca 对照第三轮（`RecoverableRenderErrorBoundary`、`activity-clear-completed`、`useAutoAckViewedAgent` / `agent-auto-ack-presence`）

## 背景

1. **渲染异常 = 整页白屏**。全仓没有 `componentDidCatch` / `getDerivedStateFromError`，唯一的兜底是路由级
   `errorElement`（→ `RouteError` → `ChunkFailure`「页面暂时无法加载」）。一条畸形消息、一个 mermaid 块、
   一个工具卡的 bug 就让整个工作台不可用，用户只能刷新，刷新后同一条消息再次把页面打挂。
2. **归档要确认、完成不可撤销**。侧栏/看板/⌘W 的归档每次 `Modal.confirm`；看板 ✓「完成」一次点击立即
   archive + kill，误点无法挽回（Owner 定的「完成必须一次点击」边界不允许加确认框）。业界做法是「先执行、
   给撤销窗口」。
3. **自动已读只看 `visibilityState`**。窗口可见但人不在（副屏常开、离开座位、另一个应用在前台）时，
   到达的通知会被 `seenOnArrival` 立即清掉、被 60s 心跳清掉，用户回来后看不到「这期间完成了什么」。

## 目标

- B-565：消息行、工具卡、markdown/mermaid 块、右侧工作区每个标签面板、侧栏各自的渲染异常只影响自己那一块，
  其余界面照常；兜底提供「重试 · 复制错误」；内容变化（resetKey）自动复位；懒加载 chunk 失败仍走现有
  `ChunkFailure` 自愈。
- B-566：归档与完成都改为「乐观隐藏 + 约 6s 撤销窗口 + 窗口结束才提交」；去掉归档确认框；页面关闭/隐藏
  时立即提交；toast 支持「文字 + 按钮」。
- B-567：自动已读（到达即 stamp、停留 stamp、心跳 stamp、退出 stamp）要求「人在场」：visible 且
  `document.hasFocus()` 且最近 5 分钟内有可信输入；presence 未知时不清。

## 非目标

- B-027 的另外两件（离线/重连横幅、store 消息 LRU 逐出）本次不做，仍 todo。
- 不上报崩溃到服务器（没有现成通道，只 `console.error` 带区域名）。
- 不改 `resumeSync` / `checkLiveness` / 任何恢复通路（铁律 13）；不新增 focus 监听。
- 不改命令面板（`CommandPalette.tsx`，归 r3-nav）的归档入口：它仍走 `archiveSessionNow` 立即提交，
  留作后续统一。看板「任务完成」批量归档（`TaskBoardScreen` 已有 destructive 确认框）不变。
- 终端「结束进程」/「关闭终端」确认框不动。
- 不把 `pointermove` 算作在场信号：Chrome 在内容滚动（流式输出自动滚到底）时会为静止光标派发合成
  mousemove，会把「人不在」误判为在场。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 仅路由级 errorElement，无组件级 ErrorBoundary | `packages/happy-web-v2/src/app/AppRoot.tsx:207`、`app/PublicRoot.tsx:18` → `app/RouteError.tsx` → `app/ChunkFailure.tsx` |
| chunk 失败判定与自愈 | `app/chunkRecovery.ts:2 isChunkLoadError`、`app/ChunkFailure.tsx`（`recoverChunkLoad`） |
| 单条消息由 memo 的 `MessageView` 渲染，memo 判据是 message 引用（reducer 只重建变了的消息，B-311） | `screens/session/MessageView.tsx:406-459` |
| 工具卡：`ToolGroupView`（行）→ `ToolView`（展开体） | `screens/session/ToolGroupView.tsx:194,307`、`screens/session/ToolView.tsx:361` |
| mermaid 在 markdown `pre` 覆写里渲染 | `screens/session/Markdown.tsx:214` |
| 右侧工作区每个标签面板都包在 `WorkspacePane`（会话工具、文件查看、终端工作区） | `screens/workspace/WorkspacePane.tsx`；调用点 `SessionWorkspacePanel.tsx:84`、`FilesPanel.tsx:278`、`TerminalWorkspacePanel.tsx:26-28` |
| 侧栏挂在 `AppLayout` 的 `sidebar` 插槽 | `screens/AppLayout.tsx:99` |
| 归档确认框 | `app/rowActions.ts:102 confirmArchiveSession`（`Modal.confirm`） |
| 完成：一次点击 → completion 记录 → `archiveSessionNow`（服务端提交后停进程） | `app/rowActions.ts:132 markSessionDone`、调用 `screens/board/BoardCard.tsx:90` |
| 归档提交 = HTTP `POST /v1/sessions/:id/archive`（fetch；凭据读 localStorage，无真实 I/O） | `sync/ops.ts:1835`、`sync/apiSocket.ts:655`、`auth/tokenStorage.ts:13` |
| 乐观隐藏 = `setSessionActiveLocal(false)`（侧栏 list 视图只显示 `active`），附 5s 活性 hold 防止旧心跳复活 | `sync/storage.ts:1342`、`sync/sessionArchiveHold.ts`、`screens/sessions/sidebarRows.ts:16` |
| 恢复已归档 = 新 spawn（`machineResumeSession`），机器离线会失败 | `app/sessionRestore.ts` |
| Toast 只有「点整条触发」的 `onAction` | `ui/Toast.tsx` |
| 已读写入：DWELL 700ms + visible + 60s 心跳 + went-hidden/pagehide/route-exit 退出 stamp | `app/useSeenTracker.ts`、`sync/notificationSeen.ts:199 shouldStampVisit` |
| 到达即已读只看 visible | `sync/seenOnArrival.ts:30`、`sync/notificationSeen.ts:234 shouldStampOnArrival` |

## 设计

### B-565 RecoverableBoundary

新组件 `ui/RecoverableBoundary.tsx`（class 组件）：

- props：`region`（必填，console 前缀与 `data-boundary` 属性）、`resetKey?: unknown`、`compact?: boolean`、
  `label?: string`（兜底文案）。
- `getDerivedStateFromProps`：`resetKey !== state.resetKey` 时清错误（内容变了自动重试一次）。
- `componentDidCatch`：`console.error('[boundary:<region>] render crash contained', error, info.componentStack)`。
- **chunk 失败交回**：`render()` 里若错误是 `isChunkLoadError`，直接 `throw` 给上层 → 路由 errorElement →
  `ChunkFailure` 走现有 `recoverChunkLoad` 自愈。局部重试无法修复缺失的 chunk，整页恢复才是对的。
- compact 兜底：一行 `这条内容渲染失败 · 重试 · 复制错误`（`role="alert"`）；非 compact：同样内容的块级
  面板（侧栏 / 工作区面板）。复制内容 = `region + message + stack`（截断 4KB）。
- 样式只用 token：`--text-faint` 文字、`--line` 虚线边、`--danger` 小图标；不用 `--accent`。
- 纯函数 `boundaryErrorText(region, error)`（复制文本）、`shouldRethrowToRoute(error)` 单测。

包裹点（最小挂钩，不改组件内部逻辑）：

| 区域 | 位置 | resetKey |
|---|---|---|
| 单条消息 | `MessageView` 导出处包一层，内部函数改名 `MessageViewBody` | `message` 对象引用（= id + 内容版本：reducer 只在内容变化时重建对象） |
| 工具卡行 | `ToolGroupView` 每个 `ToolRow` | `message` 引用 |
| 工具卡展开体 | `ToolView` 导出处包一层 | `message` 引用 |
| markdown 块 | `Markdown` 导出处包一层 | `text` |
| mermaid 块 | `Markdown.tsx` `pre` 覆写里 `MermaidView` 外层 | `code` |
| 工作区标签面板 | `WorkspacePane` 内部包 children（覆盖会话工具、文件查看、终端工作区三处调用） | 无（手动重试） |
| 侧栏 | `AppLayout` 的 `sidebar` 插槽 | 无 |

侧栏只能整体包（`Sidebar.tsx` 本轮归 r3-nav，不改内部）；侧栏崩溃时主内容区照常，侧栏位显示块级兜底。

### B-566 归档 / 完成可撤销

**二选一的结论：延迟提交（窗口结束才调用归档 RPC），不选「立即归档 + 撤销走 restore」。** 理由：

| 判据 | 延迟提交 | 立即归档 + restore |
|---|---|---|
| 不丢数据 | 窗口内什么都没发生；撤销 = 本地还原 | 归档会 kill 进程：正在跑的一轮被打断；restore 是新 spawn，机器离线即失败 |
| 跨设备一致 | 窗口内其他设备看到的仍是活跃（服务端事实没变）；提交后正常推送 | 其他设备看到「归档→复活」闪烁，restore 后是另一个进程 |
| 页面关闭 | 立即提交（见下）；万一请求没发出 → 会话保持未归档（安全方向，用户可再归档） | 已提交，无歧义，但撤销不了 |

机制（`app/deferredCommit.ts`，纯模块 + 注入 timer，单测）：

- `scheduleDeferredCommit(key, { delayMs, commit, revert })` → `{ undo(): boolean, flush() }`。
  同 key 已在等待时不重复调度。`undo()` 在提交前返回 true 并执行 `revert`；已提交返回 false。
- `flushAllDeferredCommits(reason)`：立即提交所有待提交项。挂在 `pagehide`、`beforeunload` 和
  `visibilitychange→hidden` 上（模块级单例监听）。visibility hidden 也提交，因为 iOS PWA 后台被杀时不保证
  `pagehide`，冻结页面的 timer 也不跑；这是提交通路，不是恢复通路，与铁律 13 无关。
- 页面卸载时的提交用 `fetch(..., { keepalive: true })`：`sessionArchive(id, { keepalive: true })`
  （新增可选参数，旧调用不变）。凭据读取是同步 localStorage 包在 async 里，只经微任务，能在
  pagehide 任务内发出请求。
- **切换会话**：调度在模块级，不随组件卸载取消；路由切换不影响提交，窗口结束照常提交。

归档（`archiveSessionWithUndo`，`confirmArchiveSession` 保留同名同签名作为它的别名，调用方 Sidebar /
BoardCard / ⌘W 无需改动；返回 true 表示已乐观隐藏，调用方照旧导航到下一个会话）：

1. 乐观：`setSessionActiveLocal(false)` + `setSessionArchivedAtLocal(now)`，并把活性 hold 延长到窗口 + 5s，
   防止窗口内 CLI 心跳把行复活。
2. toast「已归档 · 撤销」，持续 = 窗口 6s。
3. 窗口结束：`commitSessionArchive(sessionArchive)`；失败 → 回滚乐观状态 + `Modal.alert`（与原行为一致）。
4. 撤销：还原 active/archivedAt、释放 hold。

完成（`markSessionDoneWithUndo`，BoardCard ✓ 使用；原 `markSessionDone` 保留为立即提交版，供任务级
批量完成）：同上；提交顺序保持 completion 记录 → 归档 → webhook，撤销则三者都不发生。

⌘W（`viewShortcuts.ts`）：会话分支两种设置（`closeViewConfirm` 开/关）都走 `archiveSessionWithUndo`；
终端分支不变。

Toast 扩展（不破坏 `toast.action` / `toast.show` / `success` / `error`）：

- `ToastOptions` 新增 `button?: { label; onClick }` 与 `durationMs?: number`；新便捷 API
  `toast.undoable(message, label, onClick, durationMs)`。
- 按钮点击 `stopPropagation`，执行后关闭；带按钮的 toast 正文不再可点。
- 触屏（`pointer: coarse`）按钮最小 44×44px。

### B-567 自动已读要求人在场

新模块 `app/userPresence.ts`（唯一的输入时间戳监听点）：

- `window.addEventListener(type, h, { capture: true, passive: true })`，type ∈
  `pointerdown`、`keydown`、`wheel`、`touchstart`；仅 `event.isTrusted` 记录 `lastInputAt`。
- 懒安装（首次调用 `ensurePresenceTracking()` 时），`subscribePresenceInput(cb)` 供 tracker 在
  「输入到达」时重新评估（≤1 次/秒）。
- 纯函数 `isUserPresent({ visible, focused, lastInputAt, now, windowMs = 5min })`：
  `visible && focused === true && lastInputAt != null && now - lastInputAt <= windowMs`。
  `focused` 取不到（无 `document.hasFocus`）记为 `null` → 不在场；从未有输入 → 不在场（presence 未知时不清）。
- 纯函数 `wasRecentlyActive(...)`：只看最近输入（退出类 stamp 用，因为此时页面已经 hidden/失焦）。

判定表（`shouldStampVisit` 的第三个参数从 `visible` 换成 presence 快照）：

| 事件 | 旧 | 新 |
|---|---|---|
| dwell-elapsed | visible | 在场；不在场则等下一次可信输入重新起 dwell |
| heartbeat | counted && visible | counted && 在场；错过的心跳在下一次输入时补 stamp |
| went-hidden | counted && !visible | counted && !visible && 最近有输入 |
| pagehide | counted && visible | counted && visible && 最近有输入 |
| route-exit | counted && visible | counted && visible && 最近有输入 |
| 到达即已读（seenOnArrival） | visible && 自视图 | 在场 && 自视图 |

手机：PWA 前台时 `hasFocus()` 为 true；打开会话本身是一次 touch（`touchstart`/`pointerdown`），所以「点进
会话即已读」仍成立。行为变化：从系统通知横幅点进来（SW `notificationclick` 打开/聚焦窗口，页面内没有
输入）时，要等第一次触摸/滚动才标已读——这是有意的「presence 未知不清」。同理，地址栏直接打开 / 刷新页面后，第一次点击、按键、滚轮或触摸之前不标已读。

### Review 修正（2026-10-13）

1. **窗口内重新使用会话 = 撤销**：`restoreSession`（横幅「恢复」、输入框 restore-first 发送、行菜单恢复的共同入口）
   先 `deferredCommits.undo(archiveCommitKey(id))`。原本在跑的会话恢复显示后直接返回，不发 resume RPC，延迟归档也不再执行；
   原本就离线的会话撤销后继续走正常恢复。toast 上的「撤销」随之变成静默无操作（handle 状态为 reverted，不提示「太晚」）。
2. **presence 监听在启动时安装**：`main.tsx` 首先 import `app/presenceBoot.ts`（副作用模块），冷启动时点进第一个会话的那次触摸也会被记录。
3. **推送点击记一次在场**：`public/push-sw.js` 的 notificationclick 给目标 URL 加一次性 `vh_presence=1`（只处理同源 URL）；
   `presenceBoot` 读到后记一次可信输入，并用 `replaceState` 去掉标记（保留 history.state 与 hash）。用 URL 标记而不用 postMessage，
   是因为 `client.navigate()` 会整页导航，postMessage 发给的是即将销毁的旧文档。
4. **「完成」在页面关闭时提交**：完成记录、归档、webhook 三件事在提交起点同一任务内并发发出；归档和 webhook 用 keepalive fetch。
   完成记录走 socket 的 `update-metadata`（没有 HTTP 路由），只能尽力而为。
5. **hidden ≠ 卸载**：visibility hidden 和 beforeunload 仍用 keepalive 提交，但失败时照常回滚该行并弹窗说明原因（带服务器错误信息）；
   只有 `pagehide` 被视为真正卸载，失败只记 console。

## 兼容矩阵与发布顺序

三项都是纯 Web 改动，无 wire 字段、无 server/CLI 改动、无 migration。

| 组合 | 行为 |
|---|---|
| 新 Web × 旧/新 server × 旧/新 CLI | 归档仍是同一个 `POST /v1/sessions/:id/archive`，只是晚 6s 发出；server 侧语义与停进程路径不变，旧 CLI 无感知。已读仍写同一个 KV（notificationSeen），只是写得更保守；旧 Web 设备照常读取 |
| 旧 Web × 新 server/CLI | 无变化 |
| 新旧 Web 混用多设备 | 已读：旧 Web 设备仍按 visible 规则写 stamp（会比新设备更早清），时间戳单调合并，无冲突。归档：任一设备提交后其余设备按推送更新 |

发布顺序：随常规 server/Web 镜像发布，无 CLI 依赖。回滚：镜像回滚即可，无持久化状态残留（待提交项只在内存）。

## 风险

1. 窗口内关闭页面而 keepalive 请求被浏览器丢弃 → 会话未归档。缓解：安全方向（不丢数据），用户再次归档即可；
   visibility hidden 也提交，覆盖移动端。
2. 窗口内其他设备看到会话仍活跃（6s）。接受：服务端事实确实没变。
3. 错误边界吞掉错误后用户不报告。缓解：console 带区域名；兜底行提供「复制错误」。
4. `MessageView` memo 外包一层 boundary，增加一层 fiber。接受：class 组件无 hooks，开销可忽略；memo 判据不变。
5. 自动已读变保守：人在但 5 分钟没输入时，到达的通知不会被即时清，下一次输入时补清。接受，符合「人不在不清」。
6. 侧栏整体包裹：侧栏崩溃时整个侧栏变兜底面板（含设置入口）。接受：主区仍可用，重试可恢复；行级包裹待 r3-nav 合并后再做。

## 验收标准

- [ ] 故意抛错的子组件只灰一行，兄弟消息正常渲染（vitest）。
- [ ] resetKey 变化后自动恢复；点「重试」恢复（vitest）。
- [ ] chunk 失败错误被重新抛给上层（vitest）。
- [ ] 归档无确认框，toast「已归档 · 撤销」6s；撤销后行回来且未发 RPC；窗口结束才发 RPC（vitest，假 timer）。
- [ ] 完成同理；撤销则不 kill、不写 completion、不发 webhook（vitest）。
- [ ] pagehide / beforeunload / visibility hidden 立即提交；路由切换不取消（vitest）。
- [ ] 触屏 toast 按钮 ≥44px（css-probe，390 coarse）。
- [ ] presence 纯函数单测；`shouldStampVisit` 新判定表单测；输入监听 capture+passive、仅 isTrusted（vitest）。
- [ ] 未改 `resumeSync` / `checkLiveness`，未新增 focus 监听（grep）。
- [ ] vitest / tsc / vite build 全绿；1280 与 390 × 亮暗看兜底行与撤销 toast（DEV harness `/dev/robustness?theme=light|dark`）。

## 留真机验证项

- iOS / Android PWA：点进会话即已读仍成立；从推送横幅点进来，首次触摸后标已读。
- iOS PWA 窗口内切到后台：归档在切走时提交。
- 触屏点「撤销」按钮手感（44px）。
