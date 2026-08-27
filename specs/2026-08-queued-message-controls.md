# Queued message controls

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-234

## 背景

agent 工作时，Web 当前仍把新消息立刻投递给 CLI；移动端发送按钮还会被 Stop 按钮替代。用户无法看清、编辑或撤销尚未执行的输入，也无法从某一条排队消息直接干预当前 turn。

## 目标

- 工作中按发送，把纯文本/附件消息加入输入区上方的设备本地队列。
- 队列项可原位编辑、删除；“立即干预”原子取出该项，中断当前 turn 后优先发送。
- 当前 turn 正常结束后，每个队列项独立开启一个后续 turn，不把多项静默拼成一个 prompt。
- 桌面键盘、触摸设备、窄屏和安全区均可用；纯文本队列刷新后仍存在。

## 非目标

- 不做跨设备队列同步；队列明确属于创建它的浏览器。
- 不修改已投递、已进入 transcript 的历史消息。
- 不改 wire、server 或 CLI；旧客户端与旧 daemon 行为不变。
- 带附件的队列只保证当前页面生命周期；Blob URL 无法安全跨刷新恢复，刷新时丢弃该附件项而不伪装成仍可发送。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 工作时 composer 用 Stop 替代 Send，移动端不能排队 | `packages/happy-web-v2/src/screens/session/AgentInput.tsx` |
| `sendMessage` 会立即写本地 transcript/outbox | `packages/happy-web-v2/src/sync/sync.ts:586` |
| 真正的 mode-aware queue 位于 CLI 且无可寻址 item id | `packages/happy-cli/src/utils/MessageQueue2.ts` |

## 设计

Web 在 agent working 时截留 composer payload。队列项保存稳定本地 id、文本、创建时间和发送时的 mode 快照；附件仅内存保存。纯文本项写入 MMKV 的 session-scoped map。

发送状态机一次只释放一项：`idle → waiting-start → waiting-finish → idle`。因此下一项必须看到上一项进入 working 后再等待其结束；不会在 thinking 状态传播前把整个队列一次性灌入 CLI。

“立即干预”先从队列移除目标项，再调用既有 `abort` RPC，随后用该项保存的 mode 快照发送。其他队列项顺序不变。失败时目标项恢复到原位置并展示为可重试状态。

UI 是 composer 上方的紧凑 command buffer：一条 header（Queued + 数量 + 本设备提示），每项一行内容和三项操作。桌面操作在 hover/focus 显现；触摸设备始终可见且按钮至少 40px。teal 只用于立即干预这一 live 动作，编辑/删除保持中性。

## 兼容矩阵与发布顺序

仅 Web 改动，无协议字段。新 Web + 任意现存 server/CLI 可用；旧 Web 保持原投递行为。只需发布 Web，回滚 Web 即恢复原行为。本地未投递队列会保留，旧 Web 不读取也不破坏该 key。

## 风险

1. working 信号延迟导致批量发送：用显式三态门控，每次只释放一项。
2. 刷新后附件 Blob URL 失效：附件项不持久化，不能恢复时直接丢弃，不发送缺附件的残缺 prompt。
3. mode 在排队期间改变：保存 enqueue 时快照，并允许 `sendMessage` 接收内部 override。
4. abort 失败：不吞消息；恢复队列项供再次操作。

## 验收标准

- [ ] 工作时 Enter/点击发送只新增队列项，不出现在 transcript。
- [ ] 每项可编辑、删除；空文本不能保存。
- [ ] 立即干预先 abort，再优先发送选中项，其他项顺序不变。
- [ ] 正常 turn 结束后逐项释放，不合批。
- [ ] 刷新恢复纯文本队列，session 之间隔离。
- [ ] 390/320px 无横向溢出，触摸操作目标 ≥40px，桌面键盘焦点可见。
- [ ] Web vitest、vite build、tsc 全绿。

## 留真机验证项

- iOS/Android：软键盘打开时连续排队、编辑、删除、立即干预；横竖屏切换后无裁切。
