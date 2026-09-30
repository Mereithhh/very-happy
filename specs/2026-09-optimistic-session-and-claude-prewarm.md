# 新会话乐观打开 + Claude 预热

> 状态：Draft
> 日期：2026-09-30 ｜ 关联 backlog：B-515（Claude 预热）、B-516（新会话乐观打开）｜ 前身：`specs/2026-09-fast-session-and-send.md`（B-512）

## 背景

B-512 把 spawn→webhook 压到 dev-sg ~0.5 s 模块加载 + 少量往返。剩下两段体感等待：

1. **点「新建」→ 会话页可输入**：仍要等 web→server→daemon RPC（含 relay-ping 预检 2–3 次往返）+ wrapper 启动 + 会话入 store，估计 0.8–1.2 s，期间只有按钮 loading。
2. **首条消息 → 首个回复**：Claude 进程懒启动，首条消息到达后才 spawn。实测（CLI 0.2.157 wrapper 日志 4 例）spawn+握手 1.1–1.3 s，握手→`system/init` 再 2.1–2.4 s，首个 assistant 输出在消息后 +4.9～+6.6 s；同会话第二轮 init 仅 25 ms。

Owner 2026-09-30：「按照你的顺序来」（先发 B-512，再做乐观跳转与 Claude 预热）。

## 目标

1. **B-516**：点「新建」后 ≤100 ms 进入会话页、输入框可输入；首条消息可立即「发送」（显示 B-513 的发送中态），会话建成后自动送达；失败时文本回到输入框。
2. **B-515**：新建会话的首条消息不再付 Claude 进程 spawn+握手（~1.2 s），目标首个 assistant 输出提前 ≥1 s；预测不中时退回现状，不更慢。

## 非目标

- 协议字段变更之外的 server 改动；daemon 预起 wrapper 进程池。
- 为 reconnect/resume/fork/assistant/teams/automation 会话预热（只预热 web 新建的全新 Claude remote 会话）。
- 预热 Codex/Gemini/ACP/pi。
- 乐观打开覆盖 NewSessionModal 之外的 MachineScreen、Teams、Import（它们维持现状）。

## 现状事实

| 事实 | 位置 |
|---|---|
| 快速「+」`createChatOrConfigure` 等 spawn 返回才 `navigate`；全局 `inFlight` 防连点；目录需确认时转对话框 | `happy-web-v2/src/app/newChat.ts:52-107` |
| NewSessionModal spawn 后 `void sync.sendMessage(id, first)` 再 navigate | `screens/sessions/NewSessionModal.tsx:172-227` |
| `SessionDetailScreen` 无会话时只渲染 loader；`ChatList/AgentInput key={id}` → 换 id 必重挂 | `SessionDetailScreen.tsx:161-170,202,211` |
| `AgentInput.doSend` 无 session 直接 return；`sync.sendMessage` 缺会话/加密时静默丢弃（仅 console.error） | `AgentInput.tsx:447`、`sync.ts:940-961` |
| 草稿、permission mode 可先于会话写入；model/effort setter 在会话缺失时 no-op | `storage.ts:1141-1155,1208-1218,1235-1238` |
| spawn RPC 结果三态；web 60 s 超时、relay 失败不重试（防重复 spawn）；daemon webhook 15 s 超时杀子进程 | `sync/ops.ts:142-145,299-334`、`apiSocket.ts:250,464-468`、`daemon/run.ts:1045-1073` |
| spawn 携带 permissionMode（`--permission-mode`）；Claude 的 model 不随 spawn 下发 | `daemon/run.ts:457-458` |
| web 首条消息固定带 `appendSystemPrompt`（~1.1 KB 常量）与 model；effort 默认 null | `sync/outboundUserRecord.ts:21-39`、`sync/prompt/systemPrompt.ts`、`sync/messageMeta.ts:14-84` |
| SDK `startup()` 与 `query()` 同一构造器：进程与全部选项（含 systemPrompt、tools、resume、hooks、回调）在 startup 时定死，`WarmQuery.query()` 只能传 prompt 一次；握手超时抛错 | `claude-agent-sdk/sdk.mjs:150-151`、`sdk.d.ts:9165,9547` |
| 可在线改：model（`setModel`）、permissionMode；需重启：plan 切换、fallbackModel、custom/appendSystemPrompt、allowed/disallowedTools、effort | `claudeModeHash.ts:30-39`、`specs/2026-09-claude-mode-live-vs-relaunch.md` |
| SessionStart hook 在 startup 期间即触发，转发器调用 `onSessionFound` 发布 `claudeSessionId`；Owner 的 `~/.claude/settings.json` 在 SessionStart/End 挂了 peon-ping 声音 | `runClaude.ts:606-638`、`session.ts:297-305` |
| 首条消息 options 构建与 `query()` 调用点 | `claudeRemote.ts:111-233` |

## 设计

> 2026-09-30 经两路对抗式 review 修订（B-516：3 BLOCKER/8 MAJOR；B-515：7 MAJOR），下文为修订后方案。

### B-516 新会话乐观打开（仅 web，无协议变更）

1. **pending store（不挂在 React 上，持久化 localStorage）**：`{pendingId, machineId, path, agent, permissionMode, onSpawnedTask?, createdAt, state:'spawning'|'needs-approval'|'failed'|'landing', realId?, outbox:[{text}], error?}`。它负责发 spawn RPC、处理结果、按序送出 outbox。
2. **点击**：快速「+」/ NewSessionModal 提交 → 建 pending 记录 → 立即 `navigate('/session/'+pendingId)`；新建入口在 pointerdown/空闲时预取 `SessionDetailScreen` 懒加载 chunk（100 ms 从非会话路由量）。全局 `inFlight` 在 pending 页出现后即释放，改为 pendingId 级去重。
3. **单棵树渲染**：`SessionDetailScreen` 计算 `effectiveId = pending.realId ?? routeId`，渲染正常布局 + `pending` 标记：
   - 头部显示机器/路径 +「正在启动…」；消息区用一个小的 outbox 行列表（样式复用现有队列行，文案「会话启动后发送」），不用 ChatList；
   - `AgentInput` 显式接收 `agentFlavor`（session 为 null 时用于渲染选项与写 agent 默认覆盖，避免写到 Claude 槽）；pending 时发送 = 追加到 pending outbox，附件禁用（粘贴/拖入提示「会话启动后可添加附件」），`/btw` 暂不可用；
   - `AgentInput key` = `pendingAlias ?? id`（tab 生命周期内保留 realId→pendingId 反查），id 只允许从 pendingId 变为它自己的 realId；换 id 时删除 pendingId 下的草稿/队列/权限键；
   - pending 时跳过 `setCurrentViewingSession`/`onSessionVisible`/`SessionPreviews`；笔记绑定、⌘W（= 取消 pending）、「+」上下文按 pending 记录处理。
4. **权限模式**：pending 页上的选择写回 pending 记录；spawn 成功后以 pending 记录的值（而非 spawn 时的值）写 `realId`，在发送任何 outbox 之前完成。model/effort 的选择同理在会话入 store 后应用。
5. **成功后**：等 `storage.sessions[realId]` 出现（会话解码先初始化加密，入 store 即可发送），按序 `sync.sendMessage(realId, text)`，逐条检查 receipt；**成功后永不进入 failed**——若会话迟迟不到，把 outbox 文本写成 `realId` 的草稿（草稿 store 接受未见过的 id），同时导航过去。outbox 全部拿到 receipt 后才把输入框切到真实会话（防止新消息越过 outbox）；只有当前仍在该 pending 页才 `navigate(realId,{replace:true})`（保留 search）。
6. **目录确认**：两种入口都在 pending 页内确认（路径 +「创建并启动 / 取消」）；取消 = failed 态，文本留在 pending 输入框。
7. **失败/中断**：spawn error/超时 → pending 页「重试 / 返回」，文本留在输入框；用户已离开时 toast「新会话启动失败 · 打开」；侧栏显示 pending/failed 行。刷新：pending 路由读持久化记录，已有 realId 则跳转，否则显示「启动已中断」且文本可取回。relay 丢 ack：failed 页监听同机器/路径/agent 且 createdAt 晚于 pending 的 `new-session`，出现则提供「进入这个会话」。
8. **任务看板**：`onSpawned → attachSession` 移入 pending store 成功回调。`recordRecentMachinePath` 只在成功时。
9. **打点**：新增 `pending-shown`；composer-mounted 标记不对 pendingId 触发。

### B-515 Claude 预热（先量后做，CLI 内部，无协议变更）

**阶段 0（本批必做）测量**：首轮 result 消息自带 `time_to_request_ms` / `time_to_request_from_spawn_ms` / `ttft_ms`（`sdk.d.ts:5530-5555`）——wrapper 日志里记录冷启动首轮这三项；并在隔离 HAPPY_HOME_DIR 下探测空闲进程调用 `mcpServerStatus()` 能否提前完成延迟启动。**只有测得可省 ≥0.8 s（在 B-516 立即发送场景下）才进入阶段 1**，否则 B-515 关闭为「不做」并记录数据。

**阶段 1（条件实施）**：
1. 不用 `startup()`/WarmQuery：`query()` 本身即立即 spawn + 握手；在 `claudeRemote` 里对合格会话（全新、非 resume/fork/import/reconnect/assistant/teams/automation、`daemonState.claudeAuth` ok、每 daemon 并发预热 ≤2）于 `await opts.nextMessage()` 之前，用预测 mode 构建 `sdkOptions` 并以空 `PushableAsyncIterable` 调现有 `query()`——回调、abort、env、settingSources 全部沿用。
2. 预测 mode：抽出纯函数 `resolveMessageMode(current, meta)`（`runClaude.ts:797-925` 现逻辑），预测用 CLI 当前状态 + 缓存在 `~/.happy` 的最近一次 web `appendSystemPrompt`（web 部署才变），经同一归一化后算 `claudeModeHash`。不从 web 预测 model/effort。
3. 首条消息：hash 相同且 permissionMode 完全相同（或先 `await setPermissionMode()`），必要时 `setModel`，再 push prompt；不同 → `messages.end()` + abort 预热 → 走现有冷路径。握手未完成时**等待**预热而不是另起冷启动。`/clear`、`/compact`、15 分钟空闲、握手失败同样丢弃。
4. 所有预热 promise 创建即挂 `.catch`（未处理 rejection 会触发 archive 清理），测试：空闲时杀预热子进程，会话不被归档。
5. SessionStart hook：每个进程独立 hook 标记；预热进程回报的 id 丢弃，直到被采用；采用后以 `system/init` 路径发布 id 并补上 remote scanner 通知（修 B-355 旁路 resume）。`onQueryReady` 只在采用时调用（防 /btw 与运行时控制绑到无 transcript 的进程）。
6. 代价披露：预热进程也会启动用户 `~/.claude` 的 stdio MCP；设置项 `claudePrewarm` 可关。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web × 任意 daemon | 乐观打开纯 web 生效，spawn RPC 不变 |
| 任意 web × 新 CLI | 预热（若阶段 1 实施）纯 CLI 内部 |

发布顺序互不依赖：web（B-516）先发；CLI 阶段 0 打点随下个 CLI 版本，阶段 1 视数据。回滚：web 回上一槽；CLI 回上一 npm 版本或 `claudePrewarm: off`。

## 风险

1. **每个未发消息的新会话多一个 Claude 进程（估计 150–250 MB RSS）**：15 分钟空闲回收；开关可关。
2. **预测不中白启动一次**：预测经与首条消息同一纯函数 `resolveMessageMode` 归一化；不中只多一次进程启动/关闭；握手未完成时等待预热而非另起冷启动。
3. **SessionStart hook 副作用**（声音、外部 hook）：接受并可关；预热进程的 hook id 在采用前丢弃，采用后经 `system/init` 发布并通知 remote scanner。
4. **乐观页在会话建成前的 UI 差异**（capabilities/flavor 未知）：pending 时按 agent 默认值渲染，转正后按真实 metadata 刷新；附件在 pending 时禁用。
5. **relay 丢 ack 导致孤儿会话**：不自动重试，文案提示；与现状一致。
6. **首条消息在会话建成前被丢弃**：`sync.sendMessage` 缺会话时返回 undefined（无 receipt）；pending store 只在 `storage.sessions[realId]` 出现后发送并逐条检查 receipt，不改 `sendMessage` 契约。

## 验收标准

- [ ] 点「新建」到 pending 页输入框可用 ≤100 ms（本地 E2E 计时）。
- [ ] pending 时发送的文本在会话建成后送达且只有一条；spawn 失败时文本回输入框；需要目录确认时页内确认可继续。
- [ ] 用户在 pending 期间切走不会被拉回。
- [ ] B-515 阶段 0：wrapper 日志记录首轮 `ttft_ms`/`time_to_request_ms`/`time_to_request_from_spawn_ms`；据此决定阶段 1。
- [ ] 预测不中（改 effort）时退回冷启动，结果正确。
- [ ] 空闲 15 分钟回收 warm 进程；wrapper 退出无残留 claude 进程。
- [ ] 全部门禁绿；mutation-check 覆盖 hash 比较、claudeSessionId 延迟发布、pending 转正路由守卫。

## 留真机验证项

- 移动端 pending 页观感与目录确认条可点性。
