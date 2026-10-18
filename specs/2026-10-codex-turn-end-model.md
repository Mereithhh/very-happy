# Codex wrapper：一轮何时结束（thread 作用域 + turn/completed 唯一判据）

- 状态：Shipped（PR #559 → `main@22ac3e37f`，CLI v0.2.175；真机项 V-180）
- 关联 backlog：B-625（承接 B-622）
- 包：仅 `packages/happy-cli`（`src/codex/codexAppServerClient.ts`、`runCodex.ts`、`codexFailureText.ts`）
- 参照：stablyai/orca `src/main/codex/`（MIT；只借做法，不拷代码）：
  `codex-structured-journal-translation-turn-boundaries.ts`、`codex-structured-turn-end-settlement.ts`、
  `codex-structured-turn-open-wait.ts`、`codex-background-task-frames.ts`、`codex-app-server-connection.ts`

## 背景

B-622 修掉了「agent message 当一轮结束」。对照 Orca 的 Codex wrapper 后，我们的 app-server client
还有三处与 Codex 的实际行为不一致，每一处都会让网页在 Codex 仍在跑时显示空闲，或把失败吞掉：

1. **不分 thread**。`codex app-server` 一个进程承载会话自己的 thread 和 `spawn_agent` 开出的子 thread，
   所有通知都从同一条 stdout 来，我们的 client 不看 `threadId`：子 thread 的 `turn/completed` 会让主轮
   `thinking=false` + 推「done」，子 thread 的 `turn/started` 会把 `_turnId` 换成子轮，之后用户点停止
   发出的 `turn/interrupt` 打到子轮上（找不到就 3 s 后强制重启 app-server）。
2. **`thread/status/changed: idle` 直接当一轮结束**。resume 后的 thread 会在 `turn/start` 在飞时上报一次
   idle（陈旧状态），client 立刻 resolve 这一轮；Codex 真正结束时的 `turn/completed` 再被去重吞掉。
3. **app-server 进程死掉时静默 abort**：pending 的一轮只被 resolve 成 aborted，用户什么也看不到，
   Codex 的 stderr 只进 debug 日志。

## 目标

- 主轮的开始/结束/错误只听会话自己的 thread；子 thread 的生命周期不碰主轮状态。
- 一轮结束的唯一判据是 Codex 的 `turn/completed`；状态通知只做兜底。
- 任何非正常结束（进程退出、thread 关闭、沉默超时）都给用户一句话。

## 非目标

- 子 thread 的 item（命令、消息）如何在对话里呈现（现状：扁平进主对话 + B-614 的子线程卡）不改
  → **B-628 做了**（`specs/2026-10-codex-steer-subagents-process-tree.md`）。
- `turn/steer`（Orca 轮中插话）不做；轮中消息仍排队到下一轮（B-509）→ **B-628 做了**。
- 进程树杀（Orca `killCodexAppServerProcessTree`）不做；app-server 自己回收子进程 → **B-628 做了**。

## 现状事实（代码已确认）

- codex 0.154.0 的 v2 通知都带 `threadId`（`app-server-protocol/src/protocol/v2/{turn,thread,notification}.rs`：
  `TurnStartedNotification.thread_id`、`ThreadStatusChangedNotification.thread_id`、`ErrorNotification.thread_id/turn_id`）。
- 成功一轮（本机 mock 上游实测 2026-10-18）：`turn/started` → `item/*` → `thread/status/changed idle` →
  `turn/completed status=completed`，idle 比 turn/completed 早 1 ms。
- 失败一轮：`error willRetry=true`（重试）→ `thread/status/changed systemError` → `error willRetry=false` →
  `turn/completed status=failed error.message=…`。
- app-server 对一个正在跑的 turn 不会上报 idle（`app-server/src/thread_status.rs` `resolve_thread_status`：
  有 in-progress turn 时 idle/notLoaded 一律改报 active）。
- Orca 的判据：「Codex ends every turn with exactly one `turn/completed`, a failed one after its `error`
  frame included」；**0.148 之前**，`turn/start` 已应答但从未 `turn/started` 的一轮失败时没有 `turn/completed`，
  其最后一个 `error`（willRetry=false）就是它的结束（`unopenedTurnFailure`）；已经 opened 的一轮仍有自己的 `turn/completed`。
- Orca 的 thread 归属规则：通知没带 threadId 就属于它被问到的那个 thread；带了且不等于自己的 = 子 thread。
- 我们的 client（B-622 后）：`pendingTurnCompletion` 在 `turn/start` 发出前登记；`turn/completed`/`thread/status/changed idle`
  都调 `emitRawTurnCompletion`；`proc.on('exit')` 只 `resolvePendingTurn(true)`。

## 设计

1. **thread 作用域**（`isOwnThreadFrame`）：`turn/started`、`turn/completed`、`thread/status/changed`、`error`、`thread/closed`
   只在 `threadId` 缺失或等于 `_threadId` 时作用于主轮；子 thread 的只记 debug 日志。legacy `codex/event` 路径不变（无 threadId）。
2. **一轮的结束**：`turn/completed`（唯一主判据）。兜底：
   - 自己的 thread 上报 idle/systemError，且这一轮已 opened（见过 `turn/started`）→ 起 1.5 s 宽限；
     宽限内没有 `turn/completed` 才按 idle=completed / systemError=failed（附最后一个 `error`）结束。
     未 opened 时的 idle 视为陈旧，忽略。`active` 取消宽限。
   - `error willRetry=false` 且这一轮未 opened → 立即按失败结束（0.148 之前的唯一结束信号）；
     之后再来的 `turn/completed failed` 由 `failedTurnIds` 去重，失败只报一次。
   - `thread/closed`（自己的 thread）→ aborted +「Codex closed the thread before the turn ended」。
   - 进程退出 → `turn_aborted reason=process-exit`，message = `Codex process exited (code=…): <stderr 末 400 字>`；
     等待 RPC 应答时死掉的，拒绝错误上挂 `codexStderrTail`，runner 的「Process exited unexpectedly」后面接同一段。
   - B-622 的沉默看门狗（10 分钟无任何通知）保持最后一道。
3. 去重：`completedTurnIds` 一轮一次成功帧；带失败的帧放行一次（`failedTurnIds`）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI × codex ≥ 0.148（含 0.154） | `turn/completed` 结束；idle 宽限几乎不触发；子 thread 完全隔离 |
| 新 CLI × codex < 0.148 | 未 opened 的失败轮由最后一个 `error` 结束（原来会挂到看门狗）；其余同上 |
| 新 CLI × 只发 legacy `codex/event` 的 codex | 路径未改 |
| 新 CLI × 不带 threadId 的旧 v2 通知 | 视为自己的 thread（Orca 规则），行为同 B-622 |
| 旧 CLI（不升级）× 任何 server/web | 不受影响：纯 CLI 内部状态机，无 wire/metadata 字段变化；`turn_retry`/`turn_aborted reason` 只在 wrapper 进程内消费 |
| 新 CLI × 旧 server/web | 不受影响：对外只多了 session event 文字 |

发布顺序：只发 CLI（tag → npm → promote），server/web 不动；运行中的老 wrapper 要「重启会话」才换代码。

## 风险

- 某个 codex 版本既不发 `turn/started` 也不发 `turn/completed`（Kirill 2026-04 的假设）：idle 宽限因未 opened 不触发，
  退到 10 分钟看门狗——与 B-622 后相同，不比现在差。
- 子 thread 的 item 仍扁平进主对话（非目标），子 thread 的 `error` 现在不再显示（以前也只在它恰好结束主轮时间接可见）。

## 验收标准

- `codexAppServerClient.test.ts` B-625 五例：子 thread 全生命周期不动主轮且 interrupt 打主轮；
  陈旧 idle 不结束、opened 后 idle 经宽限结束一次；0.148 前未 opened 失败轮由 error 结束且只报一次失败；
  进程退出带 stderr 尾；`thread/closed` 结束。B-622 的「失败帧放行」改走宽限路径。
- CLI 门禁全绿；本地 `codex app-server` 0.154.0 mock 探针（`skills/tmp/vh-codex-thinking/probe/`）顺序不变。

## 留真机验证项

- 真实 `spawn_agent` 子 agent 场景下主轮转圈不中断（需 Codex collab 功能；登记 verify-queue）。
