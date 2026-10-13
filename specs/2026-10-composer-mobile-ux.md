# 输入区移动端体验：审批固定区、多题逐题作答、发送收键盘 / 断线占位 / 图片缩放

> 状态：Final ｜ 日期：2026-10-13 ｜ 关联 backlog：B-563、B-564、B-568
> 出处：Orca 对照第三轮（`mobile/src/session/MobileNativeChatPromptStrip.tsx`、`use-mobile-native-chat-prompt-presentation.ts`、`MobileNativeChatAsk.tsx`、`use-mobile-native-chat-ask-auto-advance.ts`、`agent-send-keyboard-dismissal.ts`、`mobile-clipboard-image-downscale.ts`，MIT，仅借鉴做法）

## 背景

- **B-563**：待处理的审批 / AskUserQuestion 卡片渲染在 ChatList 滚动内容末尾。用户上翻历史时卡片随内容滚走，agent 实际卡在等你，而「跳到最新」只显示未读条数，看不出是在等审批。
- **B-564**：多题 AskUserQuestion 把所有题竖排一次性展示，手机上要来回滚动，单选题选完也不会前进。
- **B-568**：三处输入框小毛病——手机发给 agent 后键盘仍盖住正在等的回复；浏览器到 server 的 socket 断线时输入框毫无提示；图片附件原样上传（最大 50MB），手机拍照 4000px+ 原图白白占带宽与模型上下文。

## 目标

1. 待处理请求（`session.agentState.requests` 非空、非镜像会话）固定显示在输入框正上方，不随消息流滚动；可折叠成一行摘要，展开即可直接批准 / 拒绝 / 作答。消息流原位置只留一行指针，不再出现第二份可操作卡片。
2. 多题 AskUserQuestion 逐题作答：题目标签行 + 上一题 / 下一题，最后一题主按钮为「提交」；单选题选完 200ms 自动前进到下一题。单题行为不变；提交 payload 与现在逐字节一致。
3. coarse 指针设备上，非排队的发送成功后收起键盘；socket 非 connected 持续 1.5s 后占位文字变为重连提示；jpeg/png/webp 长边 > 2000px 在加入输入框时客户端缩到长边 2000px。

## 非目标

- 不改权限协议、请求字段、yolo 执法（`yoloEnforcement.ts`）、审批能力门控（`permissionCompatibility.ts` / `planApprovalMode.ts`）、批量批准 / 拒绝语义。
- 不改看板 / 侧栏 / ⌘K 对 `agentState.requests` 的读取（B-552、B-559 等）。
- 不新增 socket 重连策略、focus/visibility 监听或轮询（铁律 13）；只读现有 `socketStatus`。
- 不处理 GIF / SVG / HEIC / PDF / 其他文件，不改 50MB 源文件上限与上传协议。
- 不改终端镜像（B-105 只读）与 pending 会话（B-516）的输入行为。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| PermissionCard 在 ChatList 空态与正常态的滚动内容 `.cl-inner` 里，位于 LiveStreamView 之后、SessionLiveStatusBar 之前 | `packages/happy-web-v2/src/screens/session/ChatList.tsx:305,391` |
| PermissionCard 读 `session.agentState.requests`，镜像会话直接 `return null`；多请求时显示「全部批准 / 全部拒绝」，含交互式提问时不显示全部批准 | `screens/session/PermissionCard.tsx:141-201` |
| AskUserQuestion 在 PermissionCard 内用 `AskUserQuestionOptions` 作答，`sessionAllow(..., 'approved', { answers })` | `PermissionCard.tsx:84-92,116` |
| 消息流里的 AskUserQuestion 工具卡（QuestionView）在 `tool.permission.status === 'pending'` 时同样可点作答——目前存在两份可操作卡片 | `screens/session/ToolView.tsx:281-321` |
| 多题时 `batched = questions.length > 1`，所有题竖排、统一「提交答案」；单题单选点击即提交，单题多选/「其他」有独立提交按钮 | `screens/session/AskUserQuestionView.tsx:144-186` |
| 答案 payload：`buildQuestionAnswers(questions, answers)`，题干为 key，多选以 `, ` 连接 | `screens/session/askUserQuestion.ts` |
| 输入区底部顺序：`sd-foot` 内 SessionPreviews → SubagentDock → AgentInput；排队 dock `.cl-queue` 在 ChatList 内、滚动区之下 | `screens/session/SessionDetailScreen.tsx:278-293`、`ChatList.tsx:399-455` |
| 镜像会话不渲染 `sd-foot` | `SessionDetailScreen.tsx:278` |
| 发送结束后：桌面无条件 refocus，coarse 仅在发送前 textarea 有焦点时 refocus（B-114 一类的「无键盘焦点死状态」） | `screens/session/AgentInput.tsx:519-527,603-609` |
| 发送分三路：服务端排队（B-509）、tab 内排队、直接发送 `sendQueuedItem`；`isWorking && delivery==='queue'` 或 `restore-first` 时排队 | `AgentInput.tsx:553-595` |
| 现成 socket 状态 hook `useSocketStatus()`（`storage.socketStatus`：disconnected/connecting/connected/error） | `src/app/useConnection.ts:5-7`、`sync/storage.ts:218` |
| 附件加入时 `fileToPreview` 生成 blob URL、读宽高与 thumbhash；上传时 `readFileBytes(attachment.uri)` 读同一 blob | `screens/session/useAttachments.ts:53-108`、`sync/sync.ts:881` |
| 源文件上限 50MB，图片预览类型 jpeg/png/gif/webp | `useAttachments.ts:37-38`、`sync/apiAttachments.ts:17` |

## 设计

### B-563 审批固定区（PermissionDock）

- **位置与叠放（自上而下）**：消息滚动区 → 排队 dock（`.cl-queue`，ChatList 内，不动）→ `sd-foot`：SessionPreviews → SubagentDock（子代理任务条）→ **PermissionDock** → AgentInput。
  理由：审批是唯一阻塞 agent 的事，放离手最近的位置；子代理条与排队 dock 是「进行中的状态」，阻塞期间不需要操作，排在上方。
- **组件**：`PermissionCard` 改为固定区形态（仍是同一个组件、同一套请求行、批量按钮与门控），新增头部折叠按钮；正文 `perm-dock-body` 内部滚动（`max-height: min(45vh, 420px)`，键盘弹起时 `30vh`），不推走输入框。宽度与输入框同一 820px 基准。
- **折叠**：头部整行是按钮。折叠后一行摘要：盾牌图标 + 标题 + 首个请求摘要（工具名 + 命令/路径/题干首行，单行省略）+ 待处理数。
  折叠状态按「请求 id 集合」记：折叠时记下当前 id；**出现新 id 自动展开**，已有请求被处理不会自动展开（纯函数 `isDockCollapsed`）。状态存模块内 per-session store，换会话互不影响，不持久化（刷新后默认展开）。
- **消息流指针**：原 PermissionCard 位置渲染一行 `PermissionPointer`（「N 个请求等待你处理 · 已固定在输入框上方」+「查看」）。点「查看」= 展开固定区并把焦点移到固定区头部。它不可操作请求本身。
- **QuestionView 去重**：消息流里的 AskUserQuestion 工具卡在其 pending 请求出现在固定区（请求 id 在 `agentState.requests`、不在 `completedRequests`、且非镜像会话）时渲染为只读并显示「在输入框上方作答」；镜像会话（B-105）同样只读、不显示提示；其余（旧数据，请求不在 `requests`）保持原可点行为。
- **已决请求不残留**：固定区与指针排除已在 `agentState.completedRequests` 中的 id。
- **不变项**：yolo、能力门控、`planApprovalMode`、全部批准/拒绝、Elicitation、镜像会话不渲染、pending 会话无 session 不渲染。

### B-564 多题逐题作答

- `AskUserQuestionOptions` 在 `questions.length > 1` 且未处于只读（`stacked` 为假）时进入步进模式：
  - 顶部标签行：每题一个标签（`header` 或「第 n 题」），已答题带勾，点击跳转；当前题 `aria-current="step"`。
  - 所有题都保持挂载、只显示当前题（保留各题「其他」草稿）。
  - 底部：「上一题」（第一题禁用）+ 主按钮——非最后一题「下一题」（当前题已答才可点），最后一题「提交答案」（全部已答才可点）。
  - 自动前进：**单选题**点选一个选项后 200ms 前进到下一题；多选题、「其他」自由输入不自动前进；**最后一题不自动提交**（多题是一次原子提交，留给用户确认）。用户在 200ms 内切题/再点会取消前一次计划。
- 单题：完全沿用现有行为（单选点即提交、多选/其他有自己的提交按钮）。
- 只读（消息流已答回执 / 固定区接管）：`stacked` 时多题仍竖排展示，与现状一致。
- payload：仍由 `buildQuestionAnswers(questions, answers)` 生成，状态结构 `AskAnswers` 不变 ⇒ 与现有 CLI 兼容。

### B-568 输入框三件

1. **发送后收键盘**：纯函数 `focusAfterSend({ coarse, hadFocus, outcome })`：
   - 桌面（非 coarse）：总是 refocus（不变）。
   - coarse + `outcome === 'sent'`（直接发送或 steer 成功）+ 发送前软键盘确实弹出：`blur()` 收起键盘——轮次交给 agent，键盘挡住的正是要等的回复。软键盘判定 `isSoftKeyboardOpen` 只用现有信号：iOS 的 `data-keyboard-open`（useKeyboardViewportPin）或 visualViewport 比布局视口矮 50px 以上；Android（resizes-content）为窗口高度 < 当前朝向屏幕边长的 75%。iPad 外接键盘（Cmd+Enter）两者都不成立，保持焦点。
   - coarse + `queued`（tab 排队 / 服务端排队）：保持现有规则（发送前有焦点才 refocus）——agent 忙时用户常连续排多条，不打断。
   - coarse + `failed`：保持现有规则（草稿已放回，方便改了重发）。
   - pending 会话（B-516）与 `/btw` 路由不变。
2. **断线占位**：`useReconnectingHint()` 读 `useSocketStatus()`，且只在本 tab 连上过一次之后（`socketLastConnectedAt` 非空，冷启动首连期间不提示）；非 `connected` 持续 `RECONNECT_HINT_DELAY_MS = 1500` 后为真，恢复 connected 立即为假。为真时 textarea `placeholder` 换成「重连中…发送的消息会在恢复后送出」。不禁用输入、不改发送逻辑；不新增任何恢复监听，恢复仍只走 `resumeSync`（铁律 13）。
   注：文案承诺「恢复后送出」依赖现有发送链路的离线重试/排队（`sendStatusModel` 的 sending→failed 15s 规则仍然适用，失败时有「重试」）。
3. **图片缩放**：`fileToPreview` 读到宽高后，若 mime ∈ {jpeg, png, webp}、长边 > 2000 且不是动图（APNG：`IDAT` 前有 `acTL`；WebP：VP8X 动画位或 `ANIM/ANMF` 块；头部无法解析按动图处理）：canvas 缩到长边 2000（等比、整数像素），`toBlob` 保持原格式（jpeg/webp 质量 0.85，PNG 无损以保留透明）。结果非空且比原文件小才替换（blob URL、宽高、size；文件名不变），否则用原图；任何异常回退原图。纯函数 `computeImageDownscale(w, h, maxEdge)` 与 `shouldDownscaleImage(mime)` 单测。

## 兼容矩阵与发布顺序

三项均为纯 Web 改动，不改 wire / server / CLI 协议字段。

| 组合 | 行为 |
|---|---|
| 新 Web + 旧 CLI（daemon+wrapper）+ 新/旧 server | 审批仍通过既有 `sessionAllow/sessionDeny` RPC；AskUserQuestion 提交的 `{ answers }` 结构与键值不变 ⇒ 旧 CLI 正常注入 `updatedInput`。缩放后的图片仍是合法 jpeg/png/webp 文件事件（宽高、size 与实际 blob 一致），旧 CLI 只是收到更小的图。|
| 新 Web + 新 CLI + 新/旧 server | 同上（本批不动 CLI）。|
| 旧 Web + 任意 CLI/server | 不受影响（无协议变化）。|
| socket 断线提示 | 只读 Web 本地 `socketStatus`，与 server/CLI 版本无关。|

发布顺序：随正常 server/Web 镜像发布即可，无 CLI 依赖、无 migration。回滚点：回滚 Web 镜像。

## 风险

1. 固定区展开时占用输入区上方高度，长计划/多请求会压缩消息区 → 正文内部滚动 + 上限高度 + 可折叠；新请求自动展开保证不被遗漏。
2. 折叠后用户可能忘记 → 折叠行保留 warn 材质、图标与计数；消息流末尾仍有指针；侧栏/看板的等待状态不变。
3. 自动前进误触 → 只对单选、200ms 可取消、最后一题不自动提交，且可回到上一题改。
4. 连接从未建立（首屏）也显示重连文案 → 1.5s 延迟后才显示；首屏正常连接远快于此，慢网时提示本身也成立。
5. canvas 缩放丢 EXIF 方向 → 现代浏览器 `createImageBitmap/Image` 默认按 EXIF 方向解码（`image-orientation: from-image`），绘制结果即正确方向；EXIF 元数据（含 GPS）被剥除，属于隐私收益。超大图解码内存风险：仅处理 ≤50MB 源文件，失败回退原图。
6. 修改 `ToolView.tsx` 的 QuestionView（r3-robust 只在 ToolView 外层加错误边界）→ 改动限定 QuestionView 函数体内，报告列出供合并。

## 验收标准

- [ ] 有待处理请求时固定区出现在输入框上方；上翻消息流到顶部仍可见并可直接批准/拒绝。
- [ ] 固定区可折叠为一行摘要、可展开；新请求到来自动展开；多个请求时显示计数与全部批准/拒绝（门控不变）。
- [ ] 消息流只有一行指针，点「查看」展开固定区；消息流里的 AskUserQuestion 工具卡在固定区接管时只读。
- [ ] 多题问卷：标签行、上一题/下一题、最后一题「提交答案」；单选 200ms 自动前进；多选/其他不前进；单题行为不变；payload 与旧实现相同（单测）。
- [ ] coarse 设备直接发送后键盘收起；排队发送保持原焦点行为；桌面不变（单测 + 浏览器）。
- [ ] 停本地 server 1.5s 后占位为「重连中…」，恢复后复原，输入不被禁用。
- [ ] 3000×2000 PNG/JPEG 加入后预览宽高为 2000×1333；GIF / 小图 / 非图片不变（单测纯函数 + 浏览器）。
- [ ] 1280 与 390（coarse）× 亮/暗 真浏览器验收；web tsc / 相关 vitest / vite build 通过。

## 留真机验证项

- iOS Safari / Android Chrome：发送后键盘确实收起、排队连发键盘保持；固定区在软键盘弹起时的高度与可滚动性。
- 真实手机相册 HEIC/超大 JPEG 的缩放与方向（浏览器无法模拟相机 EXIF 方向全组合）。
