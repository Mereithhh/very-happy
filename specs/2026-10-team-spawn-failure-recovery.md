# 团队 worker 启动失败：真实原因、有界自动重启与「重试启动」

状态：Final · 2026-10-21 · B-689

## 现场（10-21，dev-sg）

Web 显示「启动需处理：Session webhook timeout for PID 2484333。修复原因后，电脑会继续重试同一次启动。」worker 永远起不来，只能取消重派。

- daemon 日志：14:56:03 spawn PID 2484333 → 14:56:14 `Child PID 2484333 exited with code 1` → 14:56:18 `Session webhook timeout` → `Teams operation … needs reconciliation`。
- wrapper 日志：14:56:05 `Failed to get or create session` ECONNRESET（TLS 前断开，机器 load 10–20）→ `[ClaudeLocal] Spawning launcher` → 14:56:12 离线重连创建了另一个 session → 无任何错误行退出。

## 根因（代码已确认）

1. **wrapper exit 1 无原因**：`api.getOrCreateSession` 网络错误返回 `null`，`runClaude.ts` 的 `if (!response)` 分支是给终端用户的离线模式——跑交互式本地 Claude 并后台重连。daemon 拉起的 wrapper `stdio: 'ignore'`、无 TTY，本地 Claude 立即非零退出，`claudeLocal` 抛 `ExitCodeError`，`main.ts` 的 catch 只 `console.error`（被丢弃）后 `process.exit(1)`。离线重连创建的 session 也从未上报 daemon。
2. **误报 webhook timeout**：`daemon/run.ts` `spawnTrackedHappyProcess` 只等 webhook 或 15 s 定时器，子进程 `exit` 不结束等待。
3. **卡死**：`teams/worker.ts` 在 `spawning` 阶段把任何 spawn 错误都报 `unknown`；之后每轮只找 `teamOperationId` 匹配的持久化 session，找不到就再报 unknown——永不重试。Web 文案「电脑会继续重试同一次启动」对 `unknown` 不成立（对 `prepared` 阶段的 `failed` 成立）。

## 修复契约

- **wrapper**：`startedBy === 'daemon'` 时经 `createSessionForStartup` 建会话：500/1000/2000/3000 ms 退避共 5 次，仍失败抛 `SessionStartupError`（含连接错误码）。daemon 拉起的 wrapper 永不进入离线本地模式；终端启动行为不变。claude/codex/acp 三个 runner 同一入口。
- **退出原因**：`main.ts` 的命令失败统一 `failCommand` → `recordExitReason` 写 `[EXIT] Exiting with code N: <reason>` 到 session 日志；`installExitReasonFallback` 保证其他非零退出也留一行。
- **daemon**：子进程在上报前退出 → 立即返回 `Agent process exited during startup (code N): <reason>`，`reason` 读该 PID 日志尾部（优先 `[EXIT]`，旧 wrapper 退回最后的 `[ERROR]/[WARN]`）。超时 → SIGTERM→2 s→SIGKILL，**确认停止后**才标 `startupExit.exited = true`。`SpawnSessionResult` error 增加可选 `startupExit`。
- **team worker**：`startupExit.exited` = 进程已确认不存在 = 确定失败（不可能有第二个写者）。receipt 回到 `prepared`（保留 worktree/scope），`fail-operation` 非 unknown，错误带「automatic retry k/5 in Ns」；退避 10/30/60/120 s，第 5 次失败后停，等 Owner。未确认停止的仍按 unknown 隔离（不变）。
- **Owner 重试**：新 action `retry-operation {operationId, claimId}`（owner；op 为 failed/unknown；spawn 需任务仍 queued 且是当前 attempt）只写 `op.retryRequestedAt`。daemon 用 receipt `retryConsumed` 记录已处理的值，每个请求只执行一次并重置预算。`unknown` 的重试由 Owner 勾选「已确认旧进程已停止」后提交；daemon 仍以「已有 wrapper 上报该 op」优先，不重复 spawn。
- **Web**：任务详情与「执行需要处理」里的启动问题显示错误、按状态的说明（failed：会自动退避重试几次；unknown：不会自动重试）与「重试启动」；daemon 未声明 `teamRetryVersion ≥ 1` 时提示升级 CLI。

## 兼容与发布

wire：新 action + `TeamOperation.retryRequestedAt?` + machine metadata `teamRetryVersion?`，均可选。旧 daemon 忽略 `retryRequestedAt`，Web 据 `teamRetryVersion` 不显示按钮。旧 server 不认识 `retry-operation`（400），只会发生在 Web 新于 server——server/Web 同镜像发布，不会出现。发布顺序：server/Web → CLI（无迁移）。

## 验证

- 单测：`startupSessionCreate`、`startupExit`（含 10-21 真实日志片段）、`exitReason`、`teams/spawnRetry`、worker 退避/耗尽/Owner 重试/未确认仍隔离、reducer `retry-operation`、Web `canRetryLaunch`/`machineSupportsTeamRetry`；接线源码断言用 mutation-check 验证。
- 端到端：隔离 `HAPPY_HOME_DIR` 的 daemon + 本地 standalone server + 故障注入代理（启动时对 `/v1/sessions` 断连/返回 503），修前复现「webhook timeout + needs reconciliation」，修后看到真实原因、自动重启成功、耗尽后 Owner 重试生效。
