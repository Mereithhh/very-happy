# 工具卡片带结果：`tool-call-end.result` 覆盖所有工具

> 状态：Final
> 日期：2026-10-23 ｜ 关联 backlog：B-771 ｜ 出处：QA4 D1、D2；前身 [子代理生命周期](2026-09-subagent-lifecycle.md)（`result` 字段）、B-754 工具卡片

## 背景

v4 发布说明写「结果按 diff / 代码 / 列表 / 命令输出展示」，但 Claude 会话里 Bash 无输出、Read 无文件内容、WebSearch 无结果，「原始数据」也只有参数。原因是协议层：Claude mapper 对普通工具的 tool_result 只发 `{ t: 'tool-call-end', call }`，`result` 只给前台子代理用。Web 卡片（B-754）本身能渲染字符串结果，只是没收到。D2：无参数 MCP 工具（jina primer）因此显示「未产生输出」。

## 目标

- 所有 runner 的普通工具结束时，`tool-call-end.result = { text, truncated?, isError? }` 带上输出（Claude、Codex、ACP/pi/opencode；Gemini 走旧 ACP 消息，已带输出）。
- 单条结果上限 32 KiB（UTF-8），按 code point 截断并标 `truncated`；图片 / 文档 / 音频只写 `[image image/png, 12 KB]`，不带字节。
- `is_error` / 非零退出 → `isError`，卡片标红。
- Web：截断时卡片底部提示；无参数且无结果的卡片不再误报「未产生输出」。

## 非目标

- 不改 wire schema（字段 B-260-P2 已存在）；不新增结构化结果（Bash stdout/stderr 分开、Edit structuredPatch）。
- Codex 实时 MCP / web search 调用（app-server `mcpToolCall` 等）目前根本不转发，属于另一条缺口，不在本次范围。
- Codex reasoning / diff 处理器的 `tool-call-result`（推理正文）保持原样。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude 普通 tool_result → 裸 `tool-call-end` | `happy-cli/src/claude/utils/sessionProtocolMapper.ts`（B-771 前 :913） |
| Codex 实时 `exec_command_end` 带 `output`（aggregatedOutput）、`exit_code`，mapper 丢弃 | `codex/codexAppServerClient.ts:597-606`；`codex/utils/sessionProtocolMapper.ts`（B-771 前 :638-642） |
| Codex 历史导入把输出发成 `thinking: true` 文本，Web 不展示在卡片；MCP 结果 `String(obj)` → `[object Object]` | `codex/utils/sessionProtocolMapper.ts` `emitHistoricalToolCall` / `mcpToolCall` |
| ACP 只保留 pi bash 文本（64 KB 尾部），其余结果丢弃 | `agent/acp/AcpSessionManager.ts` `toolCallEndResult` |
| Gemini 旧 ACP `tool-result` 带完整 `output`，但不设 `isError` | `gemini/runGemini.ts` tool-result 分支 |
| Web `tool-call-end.result.text` → `tool-result.content`，`truncated` 被丢 | `happy-web-v2/src/sync/typesRaw.ts` |
| 分享链接投影对 `tool-call-end.result.text` 走通用遮罩（`mapValues` → `budget.text`），与 pi 输出同一槽位 | `happy-server/sources/app/session/linkProjection.ts:319-321,418` |

## 设计

- CLI 共享纯函数 `src/sessionProtocol/toolResultPayload.ts`：`toolResultContentText`（Claude / MCP / ACP 内容块 → 文本，二进制只写类型和大小，ACP `diff`/`terminal` 块跳过——参数里已有）、`capUtf8`（按 UTF-8 字节、code point 边界截断）、`toolResultPayload` / `textResultPayload`（空且成功 → 不带 result）。
- Claude：普通 tool_result → `toolResultPayload(block)`；子代理存根 / 前台报告路径不变。
- Codex：实时 `exec_command_end` 带输出，非零退出追加 `[exit code N]` 并 `isError`（同 pi）；历史导入完成的调用把输出放进 `tool-call-end.result`（运行中的调用没有 end，仍发 thinking 文本）；MCP 结果取 content 文本，否则 JSON。
- ACP：字符串、内容块数组、`{ content }` 都转文本；`failToolCall` 的 `{ error, status }` → `isError`。
- Gemini：失败结果补 `isError: true`。
- Web：`truncated` 经 normalize → reducer 进 `ToolCall.resultTruncated`，卡片底部「输出已截断」（子代理卡已有自己的标记，不重复）。DefaultView 空状态：运行中 →「运行中」；结果为 null（旧 CLI 或无输出）→「无参数」；结果确为空串 →「未产生输出」。
- 上限取 32 KiB：每条结果都落库并同步到每台设备；Read 默认 2000 行常超出，截断后卡片提示，完整内容仍在 agent 侧。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 旧 CLI | 与今天相同（无结果）；D2 改为「无参数」而非「未产生输出」 |
| 旧 Web（未刷新）+ 新 CLI | 旧 Web 已把 `result.text` 放进 tool-result，卡片即显示输出；`truncated` 被剥（无提示），`isError` 生效 |
| 新 Web + 新 CLI | 输出、截断提示、标红 |
| 分享链接 | 输出经同一遮罩流水线（与 pi 输出相同）；B-745 时「Claude/Codex 输出不在信封里」的前提不再成立 |

发布顺序：server/Web 先（仅 Web 展示改动，无 server 变更），再 CLI tag。回滚任一端都退回今天的表现。

## 风险

1. 消息体积变大：每条结果 ≤32 KiB，按工具调用数线性增长。接受；空输出不发，二进制不带字节。
2. 输出可能含密钥：与 pi 输出同样走分享遮罩；会话本身在服务端可信存储（非 E2E），与助手正文同一信任边界。

## 验收标准

- [x] Claude / Codex / ACP mapper 单测：每种工具一个 fixture、is_error、超大输出、CJK 与 emoji 截断
- [x] Web：envelope → normalize → reducer → 卡片测试；旧 CLI 兼容；D2 空状态
- [x] mutation-check
- [x] dev-sg 隔离 daemon + standalone server 实跑 Claude 会话（Bash、Read、Edit、WebSearch、MCP），桌面与手机截图
