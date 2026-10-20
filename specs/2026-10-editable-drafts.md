# 会话正文里的可编辑草稿（Editable drafts）

> 状态：Final（随实现 PR 一起提交）
> 日期：2026-10-21 ｜ 关联 backlog：B-642

## 背景

模型写出的对外文案（消息草稿、邮件、公告）现在只能复制到别处改，改完模型也不知道最终版本；
下一轮让它「按我改过的发」时，用户还得把整段再贴回来。

## 目标

1. 模型显式标记的草稿在会话正文里显示为**可编辑框**，框上保留复制按钮（复制的是当前版本）。
2. 编辑**不打断**模型；用户下一次发消息时，自动把「编辑后的全文 + 精简 diff」附在这条消息里发给模型，
   输入框上方显示可移除的「已附带编辑后的草稿」chip。
3. 编辑即保存（不必再发消息）：服务端持久化，刷新、换设备、另一个 tab 看到的都是编辑后版本，
   并能看出「已编辑」、可以「恢复原文」。
4. 旧 Web / 旧 CLI 不受影响（见兼容矩阵）。

## 非目标

- v1 不做「把任意代码块/段落手动转为可编辑」（v1.1 候选，见文末）。
- 不做多人协作实时合并（同一草稿两端同时打字按 LWW，后写者赢）。
- 共享会话（B-619 SessionGrant）的协作者看不到 owner 的编辑：存储是 owner 账户级 KV。
- 不给 pi（ACP）注入标记说明：pi 忽略 `meta.appendSystemPrompt`，要改 CLI，留 v1.1。
  pi 若自己输出 ```draft 块照样可编辑。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 围栏代码块在 `components.pre` 分派（mermaid 先例），流式草稿以 `plainCode` 渲染 | `happy-web-v2/src/screens/session/Markdown.tsx:203-218`、`LiveStreamView.tsx` |
| `components` 被 memo，没有消息身份；按 context 注入（`PathLinkContext` 先例） | `Markdown.tsx:50-75,359` |
| agent-text 的 `id` 每端随机生成，不能当持久 key；`seq` 是服务端会话序号，各端一致，但一条服务端消息可拆成多个同 seq 的 agent-text | `sync/reducer/reducer.ts:1594,1016-1036`、`sync/typesMessage.ts:102` |
| Web 每条消息都把 `systemPrompt`（`<options>` 说明）作为 `meta.appendSystemPrompt` 发出 | `sync/prompt/systemPrompt.ts`、`sync/sync.ts`（`buildOutboundUserRecord`） |
| Claude remote 把 `meta.appendSystemPrompt` 追加到 SDK system prompt；它是 relaunch hash 的一部分 | `happy-cli/src/claude/claudeRemote.ts:193`、`claude/claudeModeHash.ts` |
| Codex 每个 thread 注入一次 `appendSystemPrompt`（`/clear` 后重注入）；Gemini 首条注入；ACP/pi 忽略 | `happy-cli/src/codex/codexPrompt.ts:26-46`、`runCodex.ts:865,1054`、`gemini/runGemini.ts:282`、`agent/acp/runAcp.ts:1054-1065` |
| CLI 自己的 `AGENT_GUIDANCE` 只进 Claude，且有 1200 字上限测试 | `happy-cli/src/claude/utils/agentGuidance.ts:22-39` |
| 用户消息 `meta.displayText`：模型收 `content.text`，Web 显示 `displayText ?? text`；旧 Web 早已支持 | `sync/reducer/reducer.ts:1853`、`MessageView.tsx:62`、`happy-server/.../sessionShares.ts:375` |
| 用户消息里附带机器块、Web 端剥离显示的先例：`<attached_files>` | `screens/session/attachedFiles.ts` |
| 服务端 prompt 队列只存 `text + modeMeta`，没有 displayText | `sync/promptQueue.ts:222`、`AgentInput.tsx:606` |
| 账户级 KV：`(accountId,key)` 唯一，CAS version，409 带胜者值，写后向该账户所有 user socket 推 `kv-batch-update`；单值 256 KiB、5000 条、240 写/分钟 | `happy-server/sources/app/kv/kvMutate.ts`、`kvRoutes.ts` |
| Web 已有 KV 推送分发与一键一记录的 store 模板（debounce + CAS 重试 + LWW + 前缀刷新） | `sync/kvUpdates.ts`、`sync/notesStore.ts` |
| Web 写 session metadata 会丢掉 Web schema 未声明的顶层字段，每次写广播给 CLI | `sync/encryption/sessionEncryption.ts:166`、`sync/ops.ts:1512` |

## 设计

### ① 识别：模型显式标记

- 约定 ` ```draft ` 围栏，info string 其余部分是可选标题：` ```draft 给张三的回复 `。
- 说明写进 Web 的 `systemPrompt`（新增 `# Drafts` 一节，约 450 字符）：给用户可能要改/要发的文案用
  ` ```draft <标题> ` 包起来；只包文案本身；用户编辑后会以 `<edited_drafts>` 块回传，以其中的
  final 为准。
- **为什么放 Web 的 appendSystemPrompt 而不是 CLI 的 AGENT_GUIDANCE**：前者一次 Web 发布就覆盖
  Claude remote + Codex + Gemini，且不需要 CLI 发版；后者只进 Claude、要 CLI 发版，且已贴着 1200 字上限。
  代价：appendSystemPrompt 进 Claude relaunch hash，Web 发布后每个活着的 Claude 会话在下一条消息时
  relaunch 一次（约 0.7 s，按 transcript resume，内容不丢）；prewarm 的首条预测失配一次。
  这与以往任何 `systemPrompt` 改动相同，接受。
- Claude local（终端模式）不经 Web 发消息，拿不到说明；终端里也没有 Markdown 渲染，无影响。
- 流式期间（`plainCode`）按普通代码块显示；落库后才变成可编辑框。
- 只在**会话正文的 agent 文本**里启用（`AgentText` 提供 `DraftScope` context）；thinking、子代理详情、
  工具输出、文件预览等调用方没有 scope，仍显示为普通代码块（只读）。

### 草稿身份

`draftKey = <seq>.<fnv1a32(原文) base36>`，KV key = `vh.draft.v1.<sessionId>.<draftKey>`。

- seq 各端一致；原文哈希区分同 seq 的多个块。同一消息里出现两个**完全相同**的草稿会共享编辑——
  构造性极强，接受。
- 没有 seq 的消息（理论上只有乐观消息，而它们都是用户消息）不启用编辑。

### ③ 保存与同步：账户 KV，一草稿一 key

记录（JSON，base64 存 KV）：

```ts
{ v: 1, sessionId, key, title?: string,
  original: string,     // 模型原文（恢复原文、diff 基线的初值）
  text: string,         // 当前编辑版本
  base: string,         // 模型最近一次「看到」的版本：初值 = original，每次回传后 = 回传的 text
  skip?: string,        // 用户在 chip 上移除时的 text；text 再变才重新附带
  updatedAt: number }
```

- **待附带（pending）** = `text !== base && text !== skip`。「已编辑」= `text !== original`。
- 恢复原文 = `text := original`（是一次普通编辑：若模型已经看过编辑版，会再把恢复回传给它）。
- 写入：notesStore 同款——每 key debounce 600 ms、CAS 最多 4 次、冲突按 `updatedAt` LWW；
  `pagehide`/隐藏时 flush；本地 MMKV 不做镜像（草稿正文按会话加载即可，离线编辑只保留在内存直到推送成功）。
- 读取：打开会话时 `kvGetByPrefix('vh.draft.v1.<sessionId>.')`；`kv-batch-update` 实时吸收其他端改动
  （自己的回声按 version 过滤）；页面回到前台时节流刷新补 socket 缺口。
- 只有**编辑过**的草稿才写 KV；未编辑的草稿零存储。
- **为什么不用 session metadata**：Web 写 metadata 会丢 CLI 写的未声明字段、每次写都广播给 CLI、
  占 session state 写额度，打字级频率不合适（AGENTS 约束 1/4 的风险面）。
  **为什么不用消息机制**（发一条隐藏 session 事件）：消息不可改、按 seq 只增，每次按键都要新事件，
  reducer 要新增折叠逻辑（约束 15 的排序面），收益为零。KV 已有版本与推送，零服务端改动。
- 值是明文 base64：与 notes/seen 同级，服务端本就是可信存储（非端到端加密）。

### ② 回传：随下一条用户消息附带

- 输入框上方显示 chip 列表：每个 pending 草稿一个 chip（铅笔图标 + 标题/首行 + ✕ 移除）。
  ✕ = 写 `skip = text`；不删编辑本身。
- 用户在输入框发送（直发、本地队列、服务端队列三条路径都在 `doSend` 提交时刻）：
  把 pending 草稿序列化为 `<edited_drafts>` 块追加到发给模型的 `text`；**发送成功/入队成功后**
  对每个附带的草稿写 `base = 附带时的 text`（期间用户又改了就继续 pending）。失败不动，chip 留着。
- `/btw`、选项按钮（`<options>`）、待建会话（B-516 pending）路径不附带。
- 块格式（diff 是行级 LCS，只列改动行；超过 4000 字符省略 diff、只给全文）：

```text
<edited_drafts>
The user edited these drafts you wrote. Each <final> is now the authoritative text; use it instead of your earlier version.
<draft title="给张三的回复">
<diff>
- 原来的一行
+ 改后的一行
</diff>
<final>
……编辑后的全文……
</final>
</draft>
</edited_drafts>
```

- 显示：`sync.sendMessage` 看到 text 里有 `<edited_drafts>` 且调用方没给 displayText 时，
  自动设 `displayText = 去掉块后的正文`（旧 Web 也显示干净正文）。新 Web 在用户气泡、会话预览、
  对话侧轨、队列 dock 里剥离该块，气泡下方显示「附带了 N 份编辑后的草稿」。
  服务端队列 pop 出的消息没有 displayText（服务端 builder 不带），新 Web 靠剥离显示干净；旧 Web 会看到块原文
  （可读文本，不影响功能）。
- 队列 dock 编辑排队消息时只编辑正文，保存时把原块接回去。
- 只剥离**用户消息**里的块；agent 正文不剥（agent 可能在讨论这个标签，同 `<attached_files>` 的教训 B-355）。

### UI

- 可编辑框沿用代码块的外形（`--surface-code`、`--r-code`、单一闭合边框），正文用 Sans 对话字号
  （文案不是代码）。顶栏：「草稿」+ 标题、「已编辑」标记、「恢复原文」（仅已编辑时）、复制按钮。
- 编辑区是自动增高的 `<textarea>`（触屏 16px 防缩放），不折叠；不另套卡片（1-Border Rule）。
- chip 复用 `ci-att` 系的视觉台阶（`--bg-2`、`--r-sm`），放在附件条同一位置之上。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 任意 CLI（Claude/Codex/Gemini） | 说明随 appendSystemPrompt 生效；`<edited_drafts>` 只是用户文本的一部分，任何 CLI 原样转给模型 |
| 新 Web + ACP/pi | 无说明；若模型输出 ```draft 仍可编辑与回传 |
| 旧 Web 打开含 ```draft 的会话 | 普通 `draft` 代码块（只读 + 复制），零报错 |
| 旧 Web 看新 Web 发的带块消息 | 直发/本地队列：显示 displayText（干净）；服务端队列：显示含块原文 |
| 旧 Web 与新 Web 同时打开 | 旧 Web 不读 KV，看不到编辑版；新 Web 正常 |
| 旧 server | 不涉及：KV 路由与 `kv-batch-update` 早已上线；无 schema/migration 变更 |
| CLI | 无改动、无需发版 |

**发布顺序**：仅 Web（随 server/Web 同镜像正常发布）。回滚 = 回滚镜像；已写入的 KV 记录无害残留
（旧 Web 不读），回滚后用户消息里的 `<edited_drafts>` 块在旧 Web 以 displayText 或原文显示。

## 风险

1. Web 发布后活着的 Claude 会话下一条消息 relaunch 一次——同任何 systemPrompt 改动，接受。
2. KV 5000 条/账户共享上限：只有编辑过的草稿占位；会话删除后记录不回收（v1 接受，量级远低于上限）。
3. 两端同时编辑同一草稿：LWW，后写者覆盖——单人产品，接受。
4. 模型不遵守标记约定：退化为现状（普通代码块/正文），不比现在差。
5. diff 是行级：一段长段落改一个字会整段 -/+；同时给全文，模型以 final 为准。

## 验收标准

- [x] ```draft 块在会话正文里是可编辑框，有复制按钮，复制当前版本
- [x] 编辑后刷新仍是编辑版，另一 tab 实时同步，可见「已编辑」，可恢复原文
- [x] 下次发消息时 chip 出现、可移除；模型收到的 text 含 `<edited_drafts>`（final 全文 + diff）
- [x] 用户气泡显示干净正文 + 「附带了 N 份编辑后的草稿」
- [x] 纯函数单测：key/记录解析/pending 判定/LWW/diff/块序列化与剥离
- [x] 旧客户端兼容：旧 Web 渲染 ```draft 为普通代码块（无代码路径变化）、displayText 生效

## v1.1 候选

- 手动「转为可编辑」：给任意 agent 代码块加一个动作，复用同一 DraftBlock 与 key（hash 原文），
  成本主要在 UI 入口与误触。
- ACP/pi 注入说明（CLI `runAcp.ts` 首条 prompt）。
- 会话删除时清理该会话前缀的 KV。
