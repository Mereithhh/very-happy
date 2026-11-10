# 会话内置「收尾」与「交接给…」

> 状态：Final（实现中）
> 日期：2026-11-11 ｜ 关联 backlog：B-915 ｜ 前身：[汇报板](2026-10-owner-briefing.md)、[会话间消息](2026-09-session-peer-messaging.md)（跨机 B-506、离线留言 B-646）

## 背景

关会话前，用户每次都要粘贴同一段「收尾」指令（做了什么、改了哪些文件、还剩什么、能不能关），然后手动关闭；在会话之间转交工作时，也要手动指定目标会话，再让 agent 写摘要发过去。这两个动作频率很高，VH 里却没有对应功能。主 agent（B-910）以后也要批量调用它们，所以要同时提供 UI 入口和可编程入口。

## 目标

1. **收尾**：会话菜单（会话头、侧栏行）和输入框 `/wrapup`（别名 `/收尾`）一键触发。模板按账号配置，默认模板是通用写法。触发后作为普通一轮发给 agent。完成后在汇报板出一张卡：摘要、文件、提交、待确认项（勾选持久化）、「归档」按钮。
2. **交接给…**：会话菜单选目标会话，源会话写一份带产物路径的摘要，经现有会话消息通道投递，目标在别的机器上也能用。可以选择「交接成功后归档」，只有投递确认后才归档。
3. **可编程**：CLI `very-happy sessions wrapup <id...>`、`very-happy sessions handoff <from> --to <id>`；MCP 工具 `session_wrapup({ session_ids, template? })`、`session_handoff({ from, to, archive_after? })`（对齐 B-910 契约；回执 `{sessionId, state: queued|running|error}`；`to` 只能是已存在的会话，交接给新会话需先 spawn）。可批量调用，且幂等：会话正在收尾或交接时再调，返回 `already-running`。

## 非目标

- 闲置自动收尾（B-910 第二期由主 agent 列出闲置会话、用户勾选后批量调用本接口）。
- 自动归档收尾后的会话：归档只由用户点卡片按钮，或交接时明确勾选。
- 模板加密：模板存在账号 KV，明文保存在服务器上，设置页提示不要写入密钥（与 todo 的 KV 做法一致）。

## 设计

### 入口与发送

| 入口 | 行为 |
|---|---|
| Web 菜单「收尾」/ `/wrapup` | 读 KV `vh.wrapup.v1` 的模板，没有就用默认模板（中/英）。`buildWrapupPrompt` 拼上协议尾后发普通用户消息：`localId = wrapup-<nonce>`，`meta.displayText = 收尾`，消息流里只显示一个标签 |
| Web 菜单「交接给…」/ `/handoff` | 对话框：目标会话（搜索，排除自己、已归档、共享给我的）+ 附言 + ☐「交接成功后归档本会话」。给**源会话**发 `buildHandoffPrompt`（`localId = handoff-<nonce>`） |
| CLI / MCP | 同一套 wire 纯函数，同一段话；本机会话直接投递，别的机器经该机 daemon 的远程 send（B-506）透传 localId / displayText |

协议尾（英文，wire `WRAPUP_PROTOCOL_TAIL`）让 agent 最后调用 `wrapup_report`；没有这个工具（旧 wrapper）时，退回到在回复末尾列出四项。

### 卡片（汇报板条目）

- `kind: 'wrapup'`，每个会话一张收尾卡（`key: 'wrapup'`）和一张交接卡（`key: 'handoff'`）。重跑时 repost 覆盖并重新打开。
- wrapper 收到 `wrapup-` / `handoff-` 前缀的消息后，先写一张 `status: 'running'` 卡（`needsOwner: false`，不计入「需要我」），这也是幂等判断的依据（`wrapupInProgress`；超过 2 小时视为放弃，可重新发起）。
- `wrapup_report` 把卡写成 `status: 'done'`（`needsOwner: true`），payload 带 summary、files、commits、pending（`{id,label,checked}`）、canClose。收尾卡**从不推送**。
- 用户勾选 → `POST /v1/attention-items/:id/owner-respond { action:'check', checkId, checked }`，只改 payload，条目状态不变；重复勾选同一值是 no-op。
- 「归档」复用 Web 的归档流程。有未勾选项时先确认。归档后现有钩子把卡置为 `dismissed / session-archived`。

### 交接

- 源会话调 `handoff_send({ to, machine_id?, summary, artifacts?, archive_after? })`，复用 `sendPeerMessage`：同机直接投递；别的机器经该机 daemon 的 `sessions.message` RPC；目标不在跑但同项目时存为离线留言。消息头沿用 `[Very Happy session message …]`，加字段 `; kind handoff`（旧 Web 解析时忽略未知字段），footer 换成交接说明。
- 源会话的交接卡 `payload.handoff = { to, toTitle, delivery: delivered|offline-stored|failed, error, machine, archiveAfter, archived }`。
- **只有 `delivery === 'delivered'`（同机投递成功或跨机 RPC ack）且勾了 archive_after**，wrapper 才在本轮 turn-ended 后归档自己，归档前先把卡写成 `archived: true`。离线留言和投递失败都不归档；失败时 `status: 'failed'`，卡片标红并显示原因。

### 数据与协议变更

| 层 | 变更 |
|---|---|
| wire | `ATTENTION_KINDS += 'wrapup'`；`AttentionWrapupPayloadSchema`；POST 新增可选 `payload`（仅限、且必须用于 wrapup）；条目新增可选 `payload`；owner-respond 新增 `check`；`attentionItemNeedsOwner` / `wrapupInProgress` / `applyWrapupCheck`；`wrapup.ts`（模板、prompt、KV 编解码、localId 前缀、能力 `wrapup-v1`） |
| server | 迁移 `20261111120000_attention_payload`：`ALTER TABLE "AttentionItem" ADD COLUMN "payload" JSONB`（可空、不回填、无外键）；store 写 payload、按 status 算 needsOwner；`check` 动作 |
| CLI | 工具 `wrapup_report`、`handoff_send`（做事的会话调）与 `session_wrapup`、`session_handoff`（让别的会话收尾/交出，B-910 用）；running 卡；自归档；`sessions wrapup|handoff`；能力 `wrapup-v1` |
| Web | 菜单、slash、交接对话框、`WrapupCard`、设置「收尾模板」、peer 消息「交接」标签 |

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 server（无列）+ 新数据 | 不存在：新 server 先发。回滚到旧镜像时，旧 Prisma 不读写 `payload` 列（显式列出字段），条目照常可读，wrapup 卡退化为普通条目 |
| 新 server + 旧数据 | 旧条目 `payload = null`，`itemView` 输出 `payload: null`；`needsOwner` 按 kind 计算，结果不变 |
| 新 server + 旧 Web | 旧 Web 的 schema 不认识 `payload`，直接剥除；`kind: 'wrapup'` 用 `kindLabel` 兜底显示原名和标题，没有勾选和归档按钮 |
| 旧 server + 新 CLI | POST 返回 400（未知 kind）或 404（看板关闭）→ `wrapup_report` 返回「卡片未写入」，让 agent 在回复里列出；running 卡写失败时静默跳过 |
| 新 Web + 旧 wrapper（无 `wrapup-v1`） | 收尾照发；toast「升级 CLI 后可生成收尾卡片」；交接的「归档」勾选置灰，prompt 让 agent 改用 `session_message` |
| 新 CLI → 旧远程 daemon | 远程 send 忽略 localId / displayText：目标照常收到 prompt，但不出 running 卡（结果卡照出） |

发布顺序：**server（迁移只加列，需 `VH_RELEASE_MIGRATIONS_REVIEWED`）→ Web → CLI**。回滚：Web/CLI 回退即可，列保留无害；彻底移除按迁移文件注释执行 `DROP COLUMN`。

## 风险

1. 模板明文存服务器：设置页明确提示，不放密钥。
2. agent 不调 `wrapup_report`：卡片停在 running，2 小时后可重新发起；用户也可以直接在会话里看到回复。
3. 自归档误伤：只在投递确认之后、用户明确勾选时执行，属于用户意图（AGENTS #7 允许）。

## 验收标准

- [ ] wire：schema、needsOwner、push、check、prompt / KV 纯函数单测。
- [ ] server：PGlite + `startApi` 真路由覆盖 payload、needsOwner、不推送、check、归档 dismiss；迁移只加列且可回滚；关键分支做变异检查。
- [ ] CLI：工具入参、running 卡、D2 跳过、handoff 头字段、归档判定、幂等、CLI 参数；隔离 daemon 真实模型验证。
- [ ] Web：菜单、slash、对话框、卡片、设置、peer 标签；浏览器桌面加手机验证。
