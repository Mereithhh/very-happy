# Claude Code Queue + Steer 输入语义

> 状态：Final
> 日期：2026-08-28 ｜ 关联 backlog：B-244

## 背景

Owner 在 Claude Code 对话模式工作中发送新消息后，上一轮显示
`[Request interrupted by user]`，随后又显示内部 `[ede_diagnostic]...`。这里需要的不是
“发送即停止”，而是两条明确分开的路径：

- 默认发送（Queue）：等当前 turn 结束，再自动开始下一 turn；
- `Steer`（中文“调整方向”）：把输入注入仍在运行的当前 turn，让 Claude 尽快按新方向继续；
- `Stop`：唯一显式终止当前工作的动作。

Codex 只是交互类比；本项只修改 Claude Code 对话模式。主线已有的本地可编辑 queue
继续保留；问题在于原“立即干预”先调用 `Query.interrupt()`，再发送下一条普通消息。

## 结论

不能只改前端。Web 只能写入加密消息流，正在运行的 Claude Agent SDK `Query` 和它的
`AsyncIterable<SDKUserMessage>` 均由 CLI 持有。前端负责表达 Queue/Steer 意图，CLI 负责把
Steer 送进当前 query。

## 目标

- Claude 工作中，普通 Enter/发送始终为 Queue，不触发 abort。
- queue 中有独立 `Steer`；它取出该项并注入当前 SDK query，不调用 `Query.interrupt()`。
- `Stop` 保持独立 danger 动作。
- Steer 到达过晚、当前不是 remote query、或消息改变了当前 query 不能热切换的 mode 时，
  不丢消息，安全降级为 Queue。
- Claude interrupt sentinel 与 EDE 内部诊断不进入用户可见正文；已知的纯 EDE
  interruption 归一为 `cancelled`。

## 非目标

- 不修改 Codex、Gemini、OpenClaw 或终端原生输入语义。
- 不让 `/clear`、`/compact`、`/mcp`、`/skills` 走 Steer；特殊命令保持原隔离语义。
- 不在当前 query 中热切换 model、system prompt、tools 或 effort；mode 不同则 Queue。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 用户消息 meta 会被 Web 与 CLI 两侧 Zod schema 解析，未知字段会被剥掉 | `packages/happy-web-v2/src/sync/typesMessageMeta.ts`、`packages/happy-cli/src/api/types.ts` |
| Queue 已由 `MessageQueue2` 保存，Claude remote 只在 SDK `result` 后调用 `nextMessage` | `packages/happy-cli/src/claude/claudeRemote.ts` |
| SDK streaming input 的 `SDKUserMessage` 支持 `priority: 'now'` | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` |
| SDK query 的显式停止 API 是独立的 `interrupt()`；Steer 无需调用它 | 同上 `Query` 类型 |
| Web session metadata 是 strict schema，能力字段必须显式加入，否则会被剥掉 | `packages/happy-web-v2/src/sync/storageTypes.ts` |

## 设计

### 1. Web 输入区

- `doSend()` 默认 `delivery='queue'`，键盘 Enter/发送仍进入现有本地可编辑 queue。
- 工作中始终显示独立 Stop 与排队发送按钮。
- 仅当以下条件同时满足时，queue item 才显示 Steer：Claude flavor、新 CLI 在 metadata 声明
  `capabilities: ['claude-steer-v1']`、会话由 remote 模式控制。
- Steer 从本地 queue 原子取出该项后调用 `sendQueuedItem(item, 'steer')`；
  `sync.sendMessage` 仅为它写入 `meta.delivery='steer'`。
  Queue 省略字段，确保旧消息和旧 Web 天然仍是 Queue。
- 新 Web 不再调用旧的 `steer` RPC，也不会在 RPC 缺失时回退到 abort；该 RPC 只为旧 Web
  与新 CLI 的兼容保留。

### 2. CLI 路由

`runClaude.onUserMessage` 完成附件归属和 mode 解析后：

```text
delivery=steer + remote
  └─ Session.trySteer
       ├─ thinking=false / 无 live sink / mode 不同 → MessageQueue2（fallback）
       └─ accepted → 当前 claudeRemote query

delivery 缺省或 queue
  └─ MessageQueue2 → 当前 SDK result → nextMessage → 下一 turn
```

`Session.trySteer` 以当前 `thinking` 状态做竞态门禁。Web 点击时看到 working，但消息到达 CLI
前 turn 已结束，是正常竞态；返回 false 后走 Queue，不能丢失或吞掉用户输入。

### 3. SDK 当前轮注入

`claudeRemote` 在创建 query 后暴露一个窄 `steer(message, mode)` 控制面。它向同一个
`PushableAsyncIterable<SDKUserMessage>` push：

```ts
{
  type: 'user',
  parent_tool_use_id: null,
  priority: 'now',
  origin: { kind: 'human' },
  message: { role: 'user', content }
}
```

`priority:'now'` 是 Claude Code 的 steering 路径：它可抢占当前单次模型生成并在当前 agent
turn 内处理新方向，但不会调用 Happy 的 Stop 或 SDK `Query.interrupt()`，也不会关闭当前
Happy turn。普通 queued input 不带该优先级。

### 4. 附件与 mode

Queue 与 Steer 共用 `buildClaudeMessageContent`，避免附件在两条路径出现行为差异。Steer 只在
消息 mode hash 与 live query 相同时接受；不同 mode 需要重建 query，因此回退 Queue。

### 5. 中断噪音归一

保留原修复：在 Claude SDK→日志边界识别精确 interrupt sentinel，以及只含
`[ede_diagnostic]` 的已知 interruption result/error：

- sentinel 不生成消息记录、不更新 parent chain；
- interruption result 关闭 turn 为 `cancelled`；
- 纯 EDE error 不产生可见“Process exited unexpectedly”；
- assistant `error` 暂存与已持久化 lifecycle event 同样过滤纯 EDE，避免
  `stop_reason=tool_use` 作为普通事件回显；
- 混有其他错误的真实失败仍走 `failed`。

## 兼容矩阵与发布顺序

| Web | CLI | 行为 |
|---|---|---|
| 旧 | 新 | 旧 Web 仍可调用 legacy interrupt-steer；新 CLI 继续过滤其内部中断噪音 |
| 新 | 旧 | 旧 CLI 不声明 capability，Web 不显示 Steer；普通消息仍留在现有本地 Queue |
| 新 | 新 | Queue / Steer / Stop 三条语义完整 |

推荐 Web/server → CLI 发布：新 Web 遇到旧 CLI 时因能力缺失而隐藏 Steer，普通 Queue 不受影响；
随后更新 CLI 才开放完整语义。server 只中继加密内容，无需协议逻辑改动。

## 风险

1. `priority:'now'` 会抢占当前模型生成片段，这是 Steer 的预期；回归测试必须证明同一个 query
   继续运行、没有 `interrupt()` 调用，且 Steer 在第一个 `result` 前进入 input stream。
2. Web working 状态可能滞后：CLI 以实时 thinking + sink 做最终判定，失败则 Queue。
3. mode 改动无法在 query 中原子热切换：hash 不同必须 Queue，不能只更新 permission handler。
4. queue item 的 Steer 与编辑/删除操作会挤压移动端，320px/390px 留真机检查。

## 验收标准

- [ ] 工作中普通 Enter/发送只进入现有本地 Queue；上一 turn 不显示被用户打断。
- [ ] Steer 在当前 SDK `result` 前进入 input stream，携带 `priority:'now'`，不调用 `interrupt()`。
- [ ] Steer 到达过晚或 mode 不同自动 Queue，消息不丢失。
- [ ] 旧 CLI 会话不显示 Steer。
- [ ] Stop 仍独立可用。
- [ ] interrupt sentinel / 纯 EDE diagnostic 不产生可见正文，真实错误仍为 failed。
- [ ] Web 与 CLI 质量门禁通过。

## 留真机验证项

- 320px/390px 触屏宽度：工作中 composer 的 Stop + Queue，以及 queue item 的 Steer/编辑/删除，
  均无横向溢出或误触。
- 长工具调用中先 Queue 一条、再 Steer 一条：Steer 应先影响当前工作，Queue 应在当前 turn 完成后
  自动开始下一 turn。
