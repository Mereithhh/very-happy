# 消息就地编辑与删除（替换语义）

状态：Implemented（待发布）· B-528 · 2026-10-03

## 问题

B-389/#363 后「编辑」只是把改过的文本当新消息发出：旧消息和它的回复还在，Agent 上下文也还记着旧版本。Owner 要求改成替换语义（参考 Claude Desktop / Codex：编辑早先的消息 = 从那里回退再发），并支持删除中间某条消息。

## 方案

1. **Agent 侧（CLI，Claude runner）**：wrapper 推给 SDK 的每条 prompt 带 `uuid = web localId`（MessageQueue2 批次带 `sourceIds`，批内后续 id 记 alias）。新 session RPC `conversation-rewind {action: edit|delete, sourceId?, text?}`：运行中先走 Stop 路径并等空闲 → 从当前 Claude JSONL 写一份新文件（`claudeTranscriptRewind.ts`：edit 保留目标之前；delete 去掉目标 prompt 到下一条顶层 prompt 之间的整轮，并把后续首条的 `parentUuid` 接到目标的 parent）→ `session.onSessionFound(newId)`（无剩余则 `clearSessionId`）→ 静默 abort 让 launcher 以新 id 重启（不发 "Aborted by user"）。定位：先精确 uuid，再唯一全文匹配，重复文本拒绝。源 JSONL 不改，文件改动不回滚。
2. **Web 侧**：RPC 成功后才写 `transcript-drop {fromSeq, toSeq?, reason}` tombstone（role user，同 queue-cancel 路径）；reducer 在 tracing/去重之前收区间（乐观副本 toSeq=∞，回声带 seq 后收口），storage 构建列表时按 seq 过滤，map 保留原消息。edit 区间 = [目标 seq, tombstone seq)，随后发送新文本；delete 区间 = [目标 seq, 下一条用户消息 seq)。
3. **交互**：气泡原位变成同样式的自适应输入框；Enter 发送（跟随输入框的回车发送设置，⌘/Ctrl+Enter 总是发送）、Shift+Enter 换行、Esc 取消、IME 安全；未改动直接关闭。删除在气泡下方内联确认。仅 Claude 会话、已被服务端确认的消息显示编辑/删除。

## 兼容

| Web | CLI | 行为 |
|---|---|---|
| 新 | 旧 / Codex / pi | RPC 不存在 → 提示升级 CLI，不写 tombstone，不改任何东西 |
| 旧 | 新 | 旧编辑行为不变；新 CLI 的 prompt uuid 对旧 web 无感 |
| 旧 web 看到新 tombstone | — | zod 解析失败被忽略，仍显示被删范围（仅展示差异，无数据丢失） |

无 server schema 变化。发布顺序：CLI 与 web 任意；能力需新 CLI 才生效。

## 已知边界

- 只有 Claude runner；Codex/pi 可后续按 `codex-rewind-before-message` 思路接入。
- 新 CLI 之前发出的消息靠唯一全文匹配；被合批或 steer 进来的消息在 wrapper 重启后可能定位不到（明确报错）。
- 压缩（compact）之前的轮次被删除时，摘要里仍有其内容。
- CLI `sessions read` 等直接读 transcript 的工具还不认 tombstone。

## 验证

- CLI：`claudeTranscriptRewind.test.ts`、`conversationRewind.test.ts`；Web：`transcriptDrop.spec.ts`、`conversationRewind.test.ts`、`MessageActions.test.tsx`。
- 本地 standalone server + web + 真 daemon（Opus 5.5）：记三条事实 → 删第二条 → 编辑第三条 → 询问，Agent 回答「颜色不知道、宠物=编辑后的名字」；JSONL 新文件中第二轮消失、链路重接；运行中编辑会先停止并替换；刷新后隐藏保持；深/浅色与 390px 无溢出。
