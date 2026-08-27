# Claude SDK 协议边界加固

> 状态：Final
> 日期：2026-08-27 ｜ 关联 backlog：B-230 ｜ 前身：B-229、B-133

## 背景

B-229 暴露了一个系统性问题：Web 已完成一次交互，不代表 Claude Agent SDK
收到了它要求的结构化返回值。对锁定版本
`@anthropic-ai/claude-agent-sdk@0.3.232` 复核后，权限 suggestions、错误结果、
模式切换、abort、MCP elicitation 和 host dialog 都存在类似的适配缺口。

## 目标

- 所有阻塞式 SDK 回调都通过同一个加密 agent-state + permission RPC 往返，并把
  用户选择还原成 SDK 原生结果。
- “本会话允许”只使用 SDK 给出的 session permission suggestions，不自行扩大规则。
- SDK 错误结果以 failed 结束并携带可见错误，不再发送 completed/done 信号。
- bypassPermissions、ExitPlanMode 和 AbortSignal 满足锁定 SDK 的契约。
- SDK 输入和输出 union 在编译期有漂移门禁。

## 非目标

- 不把 elicitation 或 dialog 明文放到 server 数据库；继续沿用 agent-state 的端到端
  加密载荷。
- 不支持任意嵌套 JSON Schema；MCP elicitation 只实现规范允许的顶层 primitive
  fields（string/number/integer/boolean/string[] 与 enum）。
- 不改变旧 permission RPC 的名称或删除旧字段。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Web 的 session approval 只回传 `[toolName]` | `packages/happy-web-v2/src/screens/session/PermissionCard.tsx:63` |
| CLI 忽略 SDK `suggestions`，裸 `Bash` 规则又不会落入本地 allow set | `packages/happy-cli/src/claude/utils/permissionHandler.ts:139,278` |
| SDK result 不论成功失败都会触发 `onReady` | `packages/happy-cli/src/claude/claudeRemote.ts:234` |
| launcher 的 `onReady` 固定发送 completed/done | `packages/happy-cli/src/claude/claudeRemoteLauncher.ts:433` |
| ExitPlanMode 不等待 `setPermissionMode()` 就 resolve allow | `packages/happy-cli/src/claude/utils/permissionHandler.ts:102` |
| query adapter 未设置 bypass safety opt-in，且只监听未来 abort | `packages/happy-cli/src/claude/sdk/query.ts:31,61` |
| `QueryPrompt` 比 SDK 的 streaming input 类型更宽 | `packages/happy-cli/src/claude/sdk/types.ts:57` |
| B-133 已确认 SDK 原生 `onElicitation` 是正确入口 | `docs/backlog.md` B-133 |

## 设计

### 权限 suggestions

CLI 把 `canUseTool.options.suggestions` 作为 pending request 的可选
`permissionSuggestions` 放入 agent-state。现代 request（带 `kind: tool`）只有看到非空
suggestions 才展示“本会话允许”，点击后只发送既有 `decision: approved_for_session`。
旧 CLI 的 request 没有 `kind`，Web 保留原先的 mutable-tool + `allowTools` 行为，避免
托管 Web 先升级后让长期未升级的 CLI 丢功能。CLI 收到现代请求后把原始
suggestions 原样返回为 `PermissionResult.updatedPermissions`；不再把 toolName 扩成
本地永久 allow。旧客户端发送的 `allowTools` 仅作为没有 suggestions 时的兼容路径。

### 统一阻塞交互

Claude `PermissionHandler` 的 pending map 扩为三种判别联合：tool、elicitation、
user_dialog。新增 agent-state request 可选字段 `kind`，参数仍放在既有 `arguments`；
响应继续复用 permission RPC 的 `approved/decision/updatedInput`：

- elicitation accept：`updatedInput` → `ElicitationResult.content`；deny → decline；abort → cancel。
- user dialog completed：`updatedInput.result` → `UserDialogResult.result`；未显式给值时，
  `refusal_fallback_prompt` 返回当前 CLI 已确认的 `retry_fallback` choice token；deny/abort → cancelled。
- 未识别 dialog kind fail-closed 返回 cancelled；只声明 Web 已实现的
  `refusal_fallback_prompt`。

新 CLI 在 agent-state 中把 elicitation/dialog 的 legacy `tool` 写成
`AskUserQuestion`：旧 Web 已知该工具必须有结构化答案，因此会隐藏普通批准和批量批准，
只能拒绝，不会把表单空批准；新 Web 通过可选 `kind` 区分并渲染真正的交互组件。

### 错误与生命周期

converter 保留 assistant `error` 与 result `errors[]`。mapper 把最终错误摘要写入
可选 `turn-end.error`，Web 将 failed ready event 渲染成可见的 service event。
launcher 按 SDK result 决定 completed/failed；failed 只发 error 通知，不发
reply_done/input_needed、通用 done push 或 assistant completed 汇报。

### 其余 SDK 契约

- bypassPermissions 自动同时设置 `allowDangerouslySkipPermissions: true`。
- ExitPlanMode 等待 `setPermissionMode()` 成功后才 allow；失败转 deny。
- 两处 AbortSignal bridge 都先检查已 aborted 状态。
- `QueryPrompt` 收紧到 `AsyncIterable<SDKUserMessage>`；converter 对 SDK 顶层
  message type 做穷尽 switch，明确忽略 meta/ephemeral 类型，新类型加入时 tsc 必须失败。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 新 CLI | 完整 suggestions、elicitation、dialog 与错误显示 |
| 旧 Web + 新 CLI | permission suggestions 由新 CLI 自己保存并原样应用；新交互使用 `AskUserQuestion` 哨兵，旧 Web 只能拒绝，不能空批准 |
| 新 Web + 旧 CLI | 没有 `kind` 时保留旧 mutable-tool + `allowTools` 的 session approval；AskUserQuestion 结构化答案仍走旧 RPC；elicitation/dialog 不可用但不影响既有功能 |
| 旧 Web + 新 `turn-end.error` | 额外可选字段被忽略，原有 failed turn-end 仍可解析 |
| 新 Web + 旧 `turn-end` | `error` 缺失时维持旧显示，不影响正常 turn |

推荐发布顺序：Web → CLI，以便新交互立即可用；但正确性不依赖顺序。server 不识别加密
agent-state 内容和 session envelope 内部字段，无需改动。回滚任一端时可选字段均被
忽略或由 legacy 哨兵 fail-closed；无需数据迁移。

## 风险

1. SDK suggestions 可能新增 update variant：agent-state 只要求 `type/destination` 并
   passthrough，Web 不解释内容，CLI 原样回传。
2. user dialog payload/result 是开放协议：仅对白名单 kind 启用；当前安装 CLI 二进制
   已确认 `retry_fallback/edit_prompt/cancelled` choice token，但仍保留真实触发联调；
   其他 kind 一律 cancelled，避免错误回答。
3. elicitation schema 不受信任：限制字段数、标签和输入长度；不渲染 HTML。

## 验收标准

- [x] Bash/Edit 的 session approval 原样返回 SDK suggestions，且无 suggestions 时不显示按钮。
- [x] SDK error result 产生带错误文本的 failed turn-end，且不产生 done/completed 通知。
- [x] ExitPlanMode 模式切换失败时返回 deny，成功时等待 SDK ack。
- [x] bypass 与 pre-aborted signal 的 adapter 单测通过。
- [x] MCP form/url elicitation 和 refusal fallback dialog 可在 Web 回答/取消。
- [x] SDK 顶层 message union 扩展会触发 TypeScript 编译失败。
- [x] happy-wire、CLI、Web 全量门禁通过。

## 留真机验证项

- MCP URL elicitation 在 iPhone PWA 打开外链、返回后点击完成的手感。
- refusal fallback 真正由 SDK 触发时的 payload/result 联调。
