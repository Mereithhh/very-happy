# Claude SDK 会话的流式增量与运行态 UI

> 状态：Final
> 日期：2026-09-03 ｜ 关联 backlog：B-309 / B-310 / B-311 ｜ 前身：B-250 / B-252 / B-253（turn 活动流与 loading 的三次迭代，均在「只有完成态」的前提下做的）

## 背景

Owner 实报三件事，指向同一个根因：

1. 「对话有些延迟」；
2. 「loading 动画需要更炫酷、要有明显提示，比如 Claude Code 终端那种持续更新的 token 计数」；
3. 「终端里能看到中间的 thinking 过程，会话端基本看不到；SDK 会话的中间 toolcall 是不停连续的，终端却会展示文字的思考过程」。

第 3 点过去被记成「SDK 未暴露思考正文」（B-253 的结论），本次复核证明该结论是错的：
SDK 一直能给，只是我们**从未开启流式、并且把能用的进度帧全部丢弃**。

## 实测校正（2026-09-03，实跑 SDK 0.3.232）

写 spec 时假设「开了 partial 就能逐字看到 thinking 正文」。**实跑推翻了这一半**，
证据见 `~/code/github/skills/tmp/sdk-chat-ux/probe*.mjs`：

| 实测 | 结果 |
|---|---|
| `thinking_delta.thinking` | **恒为空字符串**，只带 `estimated_tokens` |
| 最终 assistant 消息的 `thinking` block | `thinkingLen = 0`，正文同样为空 |
| `system/thinking_tokens` | 正常，14 次递增到 1300 tokens |
| `text_delta` | **345 帧 / 3969 字符 / 跨度 20.0s**，中位 10 字符，首帧 2.6s |
| `message_start.message.id` vs 最终 `assistant.message.id` | **完全相同** → `streamKey` 对齐方案成立 |
| content block index | `0=thinking, 1=text`，与 mapper 遍历的 content 数组顺序一致 |

结论修正：**Claude 的推理正文被 API redact，任何客户端都拿不到**（B-253 当年的
观察是对的，只是归因错了——不是 SDK 没暴露，是上游不给）。终端里看起来「能看到
思考过程」的东西，实际是两样：**流式的 assistant 正文** + **持续跳动的 thinking
token 计数**。这两样我们现在都拿得到，而且正是本次要补的。thinking_delta 的分支
照样接好并测好——API 哪天放开，无需再改一行。

量化收益：同一段回答，改造前 web 在 **20 秒里一个字都没有**，然后 3969 字一次性
出现；改造后 **2.6 秒**出现第一个字并持续增长。80ms 合批把 345 次 delta 压成约
251 帧（约 12.5 帧/秒，含加密与 base64 约 2KB/s），远低于 server 的 200 事件/秒限流。

## 目标

- Web 会话在 Claude 生成期间**逐字看到正文**（thinking 正文受上游限制不可得，改为
  以 token 计数呈现进度），观感与终端 `claude` 一致。
- 运行态状态条给出**持续更新的量化进度**（token 计数 / 已用时 / 当前工具 / 阶段），而不是一个孤零零的脉冲点。
- 首字节可见时间（用户发出消息 → 屏幕上出现第一个字符）从「整条 assistant 消息落库后」降到「模型吐出第一个 token 后 ~100ms」。
- 不改变持久化语义与加密模型：流式增量**不落库、不参与 seq、对 server 不可读**。

## 非目标

- 不动 `storeSessionMessages` 的事务结构、不动 seq 分配、不动 `AsyncLock` 串行（持久化路径原样保留；流式通道是旁路，不是替代）。
- 不改 reducer 的消息模型（草稿不进 `messagesMap`、不进 reducer、不进历史）。
- 不做终端历史重排、不碰 xterm（与铁律 9 无关）。
- 不重做整个会话 UI 布局；只改运行态表面与流式草稿的呈现。
- 不给 Codex / Gemini / OpenClaw runner 接流式（本次只做 Claude SDK remote 路径）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 主会话 SDK options **没有 `includePartialMessages`**，SDK 默认 false → 不产生任何 `stream_event` | `packages/happy-cli/src/claude/claudeRemote.ts:138-161` |
| 我们自己的 query wrapper **支持**透传该选项，只是主会话没传 | `packages/happy-cli/src/claude/sdk/query.ts:64`、`src/claude/sdk/types.ts:77-78` |
| 旁路问答已经开了 partial，只取 `text_delta`，明确忽略 `thinking_delta` | `packages/happy-cli/src/claude/sideQuestion.ts:87,115-123` |
| `stream_event` / `tool_progress` 在转换器里直接 `return null` | `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts:264-271` |
| **所有 `type:'system'` 帧都不发给 server**（一刀切），连带丢掉 `thinking_tokens` 与 `status` | `packages/happy-cli/src/claude/utils/OutgoingMessageQueue.ts:124` |
| SDK 有 `SDKThinkingTokensMessage`（`estimated_tokens` / `estimated_tokens_delta`），**不需要 partial 即可获得** | `@anthropic-ai/claude-agent-sdk@0.3.232` `sdk.d.ts:4826` |
| SDK 的 token 级增量唯一载体是 `SDKPartialAssistantMessage`（`type:'stream_event'`） | `sdk.d.ts:4410`，开关 `sdk.d.ts:1653-1657` |
| thinking 完成块被正常映射成 `{t:'text', thinking:true}` 信封 | `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts:699-701` |
| 含 `tool_use` 的 assistant 消息被主动延迟 250ms，且队列按序发送、队首未 release 会阻塞其后全部消息 | `claudeRemoteLauncher.ts:311-313`、`OutgoingMessageQueue.ts:109-133` |
| 会话消息走 **HTTP POST** `/v3/sessions/:id/messages`，seq 由 server 分配 | `packages/happy-cli/src/api/apiSession.ts:600-633` |
| server 每批消息串行 + 一次完整事务（账号行锁 → `Session FOR UPDATE` → 配额 → seq → insert）后才广播 | `sessionUpdateHandler.ts:159-212`、`sessionMessageStore.ts:38-120` |
| keepAlive payload 只有 `sid/time/thinking/mode`，**零进度信息**，且是 `volatile` | `apiSession.ts:900-908` |
| 已有一条「加密 payload + socket 中继 + 不落库」的成熟先例：clipboard-push / file-preview-push | `apiSession.ts:926-963`、`packages/happy-server/sources/app/api/socket/clipboardHandler.ts`、`packages/happy-web-v2/src/sync/clipboardPush.ts:130-166` |
| Web 侧 thinking 渲染路径**早就存在**，只是永远只拿到完成态 | `typesRaw.ts:780-783`、`reducer.ts:920-949`、`screens/session/MessageView.tsx:134-158`、`screens/session/thinking.ts` |
| 运行态 UI 只有一个脉冲点 + 秒表 + `"Thinking 12s"` / `"Bash · 12s"` | `screens/session/SessionLiveStatusBar.tsx:13-60`、`text/_default.ts:560-562` |
| 会话内没有累计 token 的常驻展示；turn meta 只挂在整段 transcript 的最后一条 final agent-text | `screens/session/MessageMetaRow.tsx`、`chatTurns.ts:56,118` |
| 一整套 Claude Code 风格动词列表已存在但**无人消费** | `utils/sessionUtils.ts:242` `vibingMessages` |
| 未使用的文案 `working: "Working ${seconds}"` | `text/_default.ts:561` |
| 会话 transcript 无虚拟化、无任何 `React.memo` | `ChatList.tsx:305`（`rows.map`），`screens/session/*.tsx` 零 memo |
| `MarkdownPathProvider` 的 context value 每次消息变化都换新 identity → 全 transcript 的 consumer 重渲染 | `screens/session/Markdown.tsx:384-388` |
| `AgentText` 内部订阅 `useSession` → 每 2s keepAlive 就让每个 thinking 块重渲染一次 | `MessageView.tsx:110` |
| `useSessionRunningTool` 每次 store 变更都全量线性扫描 messages | `sync/storage.ts:1708-1723` |

## 设计

### 一、新增旁路通道 `session-stream`（不落库、server 不可读）

完全复制 clipboard-push 的成熟形状，理由：它已被证明能跨 relay 正确工作、有限流、有大小上限、`sourceType` 由**认证连接**盖章而非事件体（防会话冒充）。

```
CLI(mac-office) --socket 'session-stream'--> server --ephemeral 广播--> web(user-scoped room)
```

- CLI emit：`{ payload: base64(encrypt(sessionKey, JSON.stringify(frame))), enc: true }`，用 `socket.volatile.emit` —— **断连期间丢弃即可，草稿本来就是可丢的**（与 keepAlive 同性质）。
- server：`sessionStreamHandler`，只接受 `session-scoped` 连接，`sessionId` 从连接盖章，走 `allowAccountRelay` 限流（新 resource `session-stream-relay`），payload 上限 **64KB**（远低于 clipboard 的 1MB：单帧只装一小段增量文本），然后 `io.to(user:<id>:user-scoped).emit('session-stream', {...})`。**不落库、不进 update seq、不进 `eventRouter.emitUpdate`。**
- web：`apiSocket.onMessage('session-stream', …)` → 用 sessionId 取解密器（`clipboardPush.ts:resolveDecryptor` 同款）→ 解析 → 写入 `liveStreamStore`。

### 二、帧格式（wire 新模块 `streamProtocol.ts`）

```ts
sessionStreamFrameSchema = discriminatedUnion('t', [
  { t: 'block-start', mid: string, idx: number, kind: 'text' | 'thinking' },
  { t: 'block-delta', mid: string, idx: number, text: string },
  { t: 'block-end',   mid: string, idx: number },
  { t: 'progress', thinkingTokens?, outputTokens?, status?: 'requesting'|'compacting', tool?: { name, startedAt } },
  { t: 'turn-end' },
])
```

- `mid` = API message id（来自 `stream_event` 的 `message_start.message.id`），`idx` = content block index。二者组成草稿的稳定 key `mid:idx`。
- 一帧一 emit，但 **CLI 侧对 `block-delta` 按 80ms 合批**：同一 `mid:idx` 的连续 delta 先在内存里拼接，到期一次性发出。80ms 低于人眼对「卡顿」的感知阈值，同时把事件率压到 ≤12/s（对比不合批时 Claude 的 token 速率可达 100+/s）。
- `progress` 帧同样 250ms 节流；`turn-end` 立即发。

### 三、草稿与持久化消息的对齐（零闪烁）

问题：草稿先到（快通道），持久化 assistant 消息后到（HTTP + 事务 + 跨洋）。两者必须**精确替换**，否则会出现「文字闪一下消失再出现」。

方案：`sessionEnvelopeSchema` 增加可选字段 `streamKey: string`（`"<mid>:<idx>"`），由 `sessionProtocolMapper` 在映射 `text` / `thinking` content block 时写入。web 收到带 `streamKey` 的持久化消息 → 立刻删除同 key 的草稿。同一帧渲染内完成，无中间态。

兜底（旧 CLI 或 mapper 没给 key）：
- `turn-end` 帧后 1500ms 清空该 session 的全部草稿；
- `sessionLive` 变 false 时清空；
- 草稿总体 TTL 5 分钟。

### 四、CLI 侧接线

1. `claudeRemote.ts` sdkOptions 加 `includePartialMessages: true`。
2. `claudeRemote.ts` 的 `for await` 循环里，在 `opts.onMessage(...)` **之前**分流：
   - `message.type === 'stream_event'` → `opts.onStreamFrame?.(...)`，**不再进 onMessage**（避免白白穿过转换器再被丢弃，也避免 `OutgoingMessageQueue` 的排序队列被高频帧冲击）；
   - `message.type === 'system' && subtype === 'thinking_tokens'` → 进 progress 聚合器；
   - `message.type === 'system' && subtype === 'status'` → 进 progress 聚合器；
   - `message.type === 'tool_progress'` → 进 progress 聚合器。
   其余原样走 `onMessage`。
3. 新模块 `packages/happy-cli/src/claude/streamRelay.ts`：纯函数式聚合器 + 合批调度（可单测，不依赖 socket）。构造时注入 `send(frame)`。
4. `sdkToLogConverter.ts` 的 `stream_event` 分支保留 `return null`（防御：即使有别的路径漏进来也不污染 transcript），但补注释说明流式走旁路。
5. `OutgoingMessageQueue.ts:124` 的 `type !== 'system'` **不动** —— 我们不再需要让 system 帧走持久化路径，进度信息已经走旁路了。这样避免污染 transcript / 历史导入。

### 五、Web 侧

**`sync/liveStream.ts`**（纯逻辑 + zustand store）
```
liveStream[sessionId] = {
  blocks: Array<{ key, kind: 'text'|'thinking', text, done }>,   // 按到达顺序
  progress: { thinkingTokens?, outputTokens?, status?, toolName?, toolStartedAt? },
  updatedAt
}
```
纯 reducer 函数 `applyStreamFrame(state, frame)` 单独导出并单测（本仓「新逻辑抽纯函数」的既有纪律）。

**渲染 `LiveStreamView`**：挂在 transcript 末尾、`SessionLiveStatusBar` 之上。
- `thinking` 块：复用 `.msg-thinking` 样式，运行中恒展开、实时追加，带一个游标（`▍` 闪烁）。
- `text` 块：草稿用 **Markdown 渲染但跳过 shiki 高亮**（新增 `plain` prop 走 CodeView 的纯文本分支）—— 流式期间每 80ms 重跑一次高亮既浪费又会抖；落地后的持久化消息才高亮，代码块「先普通色后高亮」与终端观感一致。
- 草稿容器不参与 `buildChatRows`，不进 reducer，刷新即消失（本来就是瞬态）。

**`SessionLiveStatusBar` 重做**（Claude Code 终端形状）：
```
✳ Cerebrating…  14s · ↑ 1.2k tokens · Esc to interrupt
```
- 字符动画：`·` `✢` `✳` `∗` `✻` `✽` 循环，120ms/帧，teal（`--accent`，合法：这就是 live）。
- 动词：复用已存在的 `vibingMessages`，**按 sessionId + turn 稳定选种**（不能每次渲染随机，否则重渲染就跳字），每 4s 前进一个。
- token：`progress.thinkingTokens` 优先（思考阶段），否则 `outputTokens`；无数据则整段省略（旧 CLI 天然降级）。
- 工具运行时仍优先显示工具名 + 计时（保留今天的行为）。
- `prefers-reduced-motion`：关闭字符动画与动词轮换，退化为静态 `✳` + 现有文案；脉冲点已有的降级逻辑保留。

**性能修复（B-311，属于「延迟感」的一部分）**
- `Markdown.tsx:384-388`：context value 的 `useMemo` 依赖从 `messages`（每次换 identity）改为 `collectSessionFilePaths` 结果的稳定 join key。
- `MessageView` / `ToolGroupView` / `TurnActivityView` 加 `React.memo`。
- `MessageView.tsx:110` 的 `useSession` 订阅收窄为只取 `thinking` 布尔（`useSession(id, s => s?.thinking)` 形状），避免每 2s 心跳导致 thinking 块重渲染。
- `useSessionRunningTool` 的线性扫描加 reducerState 版本号短路。

### 被否方案

1. **把增量当普通消息发（走持久化）**：每 80ms 一条消息 = 一次事务 + 一个 seq + 永久占用存储与配额，长会话会把 transcript 撑爆，且 `AsyncLock` 串行会让持久化路径彻底堵死。否决。
2. **明文走 ephemeral（像 activity/usage 那样）**：thinking 正文是最敏感的内容之一，明文经过 server 会单方面降低现有隐私等级（今天连一个文件路径都是加密后才上中继，见 `apiSession.ts:939-947` 的注释）。否决。
3. **复用 `session-alive` 心跳携带进度**：它是 2s 一拍的 `volatile` 心跳，粒度太粗且语义是「活性」，塞进度会让 B-295 好不容易收敛到单一入口的活性判据重新变浑。否决。
4. **web 侧对草稿做完整 markdown + shiki 高亮**：流式期间每帧重算高亮，长代码块会直接卡住主线程。否决（落地后再高亮）。
5. **拆掉 `claudeRemoteLauncher` 的 250ms tool_use 延迟**：它是为了与 permission request 合并、避免工具卡片闪烁而存在的。有了流式草稿后这 250ms 不再可感，动它属于用风险换不可感知的收益。**本次不动**。

## 兼容矩阵与发布顺序

| 端 | 旧 → 新 | 行为 |
|---|---|---|
| 旧 web + 新 CLI | 新 CLI emit `session-stream` | 旧 web 没注册该事件名 → socket.io 丢弃，无副作用。envelope 上新增的 `streamKey` 被旧 web 的 zod 剥掉（未知键），行为与今天完全一致 |
| 新 web + 旧 CLI | 旧 CLI 从不 emit | 新 web 的 `liveStream` 永远为空 → `LiveStreamView` 不渲染任何东西；状态条的 token 段落因无数据而省略，退化成今天的样子 |
| 新 web + 旧 server | 旧 server 无 `session-stream` handler | 事件被服务端忽略，等同「旧 CLI」路径，无报错 |
| 新 server + 旧 CLI/web | handler 空转 | 无影响 |

**发布顺序：server/web（同一镜像）→ CLI。** server 先具备中继能力，web 先具备接收能力，然后 CLI 才开始发。反序会让新 CLI 的帧被丢弃一段时间（无害但白费）。

**回滚点**：三端各自独立可回滚。回滚 CLI = 停止发帧，web 自动退化；回滚 web/server 镜像 = 帧被丢弃，CLI 无感（`volatile` emit 不阻塞）。

**能力位**：不需要 `session.metadata.capabilities` 门（铁律 14 关心的是「web 要不要为旧 CLI 改行为」；这里旧 CLI 的表现就是「没有草稿」，与今天一致，天然安全降级）。

## Review 修正（2026-09-03，三轮对抗 review + 实测）

定稿后做了三轮对抗 review（CLI 正确性 / web 正确性与性能 / 安全与兼容），逐条推翻前提。
改掉的都不是纸面问题，其中三条会直接毁掉本次要达成的效果：

| 发现 | 证据 | 修法 |
|---|---|---|
| **`streamKey` 的 block index 恒为 0** | SDK 把一条 API 消息**按 content block 炸成 N 条 `assistant` 帧，每帧 content 长度恒为 1**（SDK 二进制 normalizer `q0v`；本机 transcript `10264/10264` 全是长度 1）。原实现用帧内数组下标 → 每帧都算 0 | mapper 跨帧维护 block cursor（两个标量，非 map）；**sidechain 不参与**，否则子代理帧会在主链两帧之间把 cursor 清零 |
| **CJK 帧被服务端静默丢弃** | wire 上限是**字符**、relay 上限是**字节**。32K CJK 字符 = 96KB 明文 → base64 ≈131KB > 64KB → server 直接 return，CLI 侧 `volatile` 无 ack，永远不知道 | CLI 按 **UTF-8 字节**提前 flush（16KB）；wire 常量降到 16K 并改成字节语义的说明 |
| **turn 中途被 sweep 掉整段草稿** | `block-end` / `progress` 没有解除已 arm 的 sweep。liveness 抖动 → arm → 此时 agent 正在跑工具、只有 progress 帧 → 1.5s 后整段答案被删，下一个 delta 从空重开 → **可见截断** | 除 `turn-end` 外**任何帧**都解除 sweep |
| SDK 中途重试（stall / 529 / refusal fallback）换新 mid，旧 mid 的块永远无人认领 | SDK 会 `continue` 重发整个请求并从 block 0 重新流 | 已 done 且 10s 未被认领的块视为孤儿丢弃 |
| 每个 `stream_event`（~100/s）都过一次 `contentLogMetadata` + **同步写盘** | `logger.debug` 在分流之前 | 分流上移到日志之前 |
| 草稿抽干账号令牌桶 → **终端 socket 被踢** | 该桶的溢出策略是 disconnect，而草稿稳态 ~17 事件/s/会话，约 12 个并发会话就吃满 | 独立限流桶 + 独立 env |
| 超尺寸帧不计费 | 收费在三个 early-return 之后，违反该文件自己写的「先收费再解析」 | 收费移到最前 |
| 丢帧零观测、无法关闭 | 丢弃路径不发 `limit-reached`，全仓无第二处引用 | `session_stream_frames_total{outcome}` 指标 + 两端 kill switch |
| 12/s 更新的 `aria-live` 区域 | 读屏会反复重播整段草稿 | 去掉 `aria-live`/`aria-busy`，由落地的真消息播报 |
| reduced-motion 下动词仍每 4s 跳字 | spec 要求关，实现只关了字符动画 | reduced-motion 用固定词 |
| 草稿与真实回复视觉不可分，且能被任意持账号凭证者注入并长期驻留 | 中继只校验 session 归属，不校验「是否真在跑 turn」 | 只在 agent live 或已 arm sweep 时渲染草稿 |
| 持久化消息可能**先于**自己的草稿到达（消息走就近 relay，草稿必走 origin） | 远地域 | claim 记住 key，晚到的帧不再重画 |
| 状态条订阅整个 stream → 12/s 重渲染 | `updatedAt` 每帧都变 | 只订阅 progress 切片 |
| 草稿每帧对每个叶子跑 `findPathHits` | ~0.4ms/帧 | 草稿包在既有的 `NoPathLinks` 里 |
| `turn-end` 抢在本轮消息出队之前 | launcher 在 `flush()` 之前 sweep | sweep 移到 flush 之后，`result` 处不再 sweep |

未处理、已知并接受：**没人在看的会话也照样全量上传**（需要反向信令告知「有无观众」，本次不做）；**多副本下每帧都进 Redis adapter 流**（当前生产单副本，多副本前需重新评估）。两条都记在下面的风险里。

## 风险

1. **流量**：实测稳态约 12.5 delta 帧/s + ≤4 progress 帧/s ≈ **17 事件/s 每个运行中的会话**（不是「与 clipboard 同量级」——clipboard 是每次用户动作一个事件）。缓解：80ms 合批 + 16KB 字节闸门 + **独立**的账号级令牌桶（默认 400 事件/s、512KB/s，`SESSION_STREAM_RELAY_*` 可调）+ `volatile`。丢弃计入 `session_stream_frames_total{outcome="throttled"}`，两端各有 kill switch（`SESSION_STREAM_RELAY_DISABLED` / `HAPPY_SESSION_STREAM_DISABLED`）。
1b. **没有观众也照发**：CLI 不知道有没有 web 客户端在看，所以一个无人观看的会话同样上传全量草稿。需要反向信令才能修，本次接受。
1c. **多副本 Redis 放大**：`io.to(room).emit` 走 redis-streams adapter，每帧都会进那条与所有广播共用的流。当前生产是单副本，**上多副本前必须重新评估**（连同上面那条「除以副本数」的限流纪律）。
2. **草稿与最终消息不一致**（模型改写、compact、中断）：草稿是瞬态且有 `turn-end`/`sessionLive`/TTL 三重清理；持久化消息永远是唯一事实源。接受。
3. **`streamKey` 对齐失效**（mapper 与 stream 的 block index 口径不一致）：兜底清理保证最坏情况是「草稿多显示 1.5s 后消失」，不会重复堆积。已在验收清单里单列一条对齐验证。
4. **`includePartialMessages` 对 SDK 行为的副作用**：该选项只增加 `stream_event` 的发射，不改变其余帧序列（`sdk.d.ts:1653-1657`）。旁路问答已在生产用了同一选项（`sideQuestion.ts:87`）作为先例。风险低。
5. **状态条动画在低端设备耗电**：120ms 字符帧是纯文本换字，无重排；`prefers-reduced-motion` 完全关闭。接受。
6. **web 性能改动引入回归**（memo 漏依赖导致不更新）：memo 只加在纯展示组件上，且每个都有既有测试覆盖渲染输出；`Markdown` 的 context key 改动附单测。

## 验收标准

- [ ] 发一条会触发长思考的消息，Web 在**模型吐出第一个 token 后 ~100ms 内**出现文字，且逐段增长（不是整块出现）。
- [ ] turn 结束后草稿收敛成持久化消息，**无闪烁、无重复**（`streamKey` 精确替换）。
- [ ] thinking：状态条给出持续跳动的 token 计数（正文受上游 redact 限制不可得，见「实测校正」）。
- [ ] 状态条显示动词 + 字符动画 + 已用时 + **持续跳动的 token 计数**；工具运行时仍显示工具名与计时。
- [ ] `prefers-reduced-motion` 下动画全部退化为静态，信息不丢。
- [ ] 草稿不进历史：刷新页面后 transcript 与今天完全一致（只有持久化消息）。
- [ ] 旧 CLI（未升级的 daemon）连上新 Web：无草稿、无报错、状态条退化成今天的样子。
- [ ] `session-stream` 帧在 server 侧不产生任何 DB 写入（用 SQL 计数或日志断言）。
- [ ] wire / cli / web / server 四包门禁全绿（含 web tsc 0）。
- [ ] 纯函数 `applyStreamFrame` 与 CLI 侧聚合器各有单测；关键断言过 `mutation-check`。

## 留真机验证项

- 手机窄屏下流式草稿的滚动跟随（自动贴底与 `ResizeObserver` 的交互）。
- 长时间（>5min）单 turn 的草稿内存占用观感。
- 弱网/断连重连期间草稿丢失后的恢复观感（`volatile` 丢帧是预期行为）。
