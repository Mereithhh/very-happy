# 运行中输入队列

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-231 ｜ 出处/前身：用户截图与生产只读核验

## 背景

用户在 Claude 正执行长工具调用时继续发送普通聊天消息。消息已经到达 Server 和 daemon，
但 Claude SDK 的 streaming input 只会在当前 query 产出 `result` 后取下一条。Web 立即把输入画成
普通 user bubble，因而错误暗示 agent 已在当前 turn 中看到并处理它。

## 目标

- agent working 时发送的普通聊天消息立即可靠上送，但显示在 transcript 外的待处理队列。
- 收到既有 `turn-end` 后，把此前 queued 的输入恢复为正常 transcript 消息。
- 只升级 Web 即可改善旧 CLI 用户；不要求 daemon/CLI 静默升级。
- AskUserQuestion 与权限回答沿用独立交互语义，不进入普通输入队列。

## 非目标

- 本批不改变 Claude SDK 的 query 生命周期。
- 本批不增加队列编辑、删除、拖拽排序或“中断并发送”。
- 本批不改变 terminal pane：终端键入仍是直接 PTY 字节流。
- 本批不发布或重启生产服务。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 在 `sendMessage` 内先 optimistic enqueue，再写 durable outbox | `packages/happy-web-v2/src/sync/sync.ts:593` |
| 普通 composer 在 working 时仍调用同一个 `sendMessage` | `packages/happy-web-v2/src/screens/session/AgentInput.tsx:169` |
| reducer 当前吞掉 `ready`（session `turn-end`）而不保留消费边界 | `packages/happy-web-v2/src/sync/reducer/reducer.ts:418` |
| CLI 将用户消息推入 `MessageQueue2` | `packages/happy-cli/src/claude/runClaude.ts:509` |
| Claude remote 只在 SDK result 后调用 `nextMessage` | `packages/happy-cli/src/claude/claudeRemote.ts:254` |
| AskUserQuestion/权限回答使用 `source: question`，可与普通 chat 区分 | `packages/happy-web-v2/src/screens/session/PermissionCard.tsx:77` |

## 设计

Web 发送普通消息时读取当前 session 的 `thinking` 与 running tool 状态。若为 working，则在
加密文本及附件事件的可选 metadata 中写入同一个 `queuedAt`。消息仍立即进入 durable outbox；队列只是诚实展示状态，不把可靠性
退回浏览器本地草稿。

Reducer 记录最新 `turn-end` 时间边界。带 `queuedAt` 的 user message 在没有更新的 turn-end 时
输出 `inputState: queued`；收到 turn-end 时重算并更新所有已越过边界的 queued message。
ChatList 将 queued message 从正常 rows 中移除，集中显示在 composer 上方的队列面板；越过边界后
它按该 turn-end 的消费位置进入 transcript（保留原始 seq/createdAt，仅增加显示排序键）。
`source: question` 不写 queued metadata。

`queuedAt` 是提示性、可选 metadata：Server 仍只存 opaque ciphertext；CLI 的旧 Zod schema 会剥掉
未知 metadata，不影响 prompt 文本与模式字段。队列消费以现有 `turn-end` 为兼容边界，不新增 CLI
ack，因此不会把修复绑定在客户端升级率上。

## 兼容矩阵与发布顺序

| Web | CLI | 行为 |
|---|---|---|
| 新 | 旧 | 新 Web 显示 queued；旧 CLI 忽略 `queuedAt`，既有 `turn-end` 解除队列 |
| 新 | 新 | 同上；无需新 CLI 能力 |
| 旧 | 新 | 旧 Web 不写/不显示 queued；行为保持现状 |
| 旧 | 旧 | 完全不变 |

发布只需要 Web。回滚为上一 Web bundle；消息正文、Server schema 与 CLI queue 均未改变。

## 风险

1. Web 与 daemon 时钟有偏差：`turn-end` 与 `queuedAt` 都是 epoch 时间；常规 NTP 环境可正确比较。
   reducer 测试覆盖同批 history 与增量到达。若未来需要跨严重时钟漂移的精确 ack，再增量引入
   localKey consumption event，不作为旧 CLI 修复前置。
2. AskUserQuestion 被误排队：只对非 `question` source 且 working 的消息写 marker，并加发送单测。
3. queued 消息污染语音 latest exchange：assistant 派生层忽略 `inputState: queued` 的 user message。

## 验收标准

- [ ] working 时连续发送两条普通消息，transcript 不出现伪正常 user bubble，队列按发送顺序显示两条。
- [ ] 收到 turn-end 后两条消息退出队列并进入 transcript。
- [ ] idle 发送、AskUserQuestion/权限回答均保持现状。
- [ ] 历史一次性加载与实时增量到达得到相同队列状态。
- [ ] Web 全量 vitest、vite build、tsc 通过。

## 留真机验证项

- iPhone/窄屏确认队列面板不遮挡 composer，长消息可读且无横向溢出。
