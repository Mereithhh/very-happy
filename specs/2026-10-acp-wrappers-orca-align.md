# pi / Gemini wrapper 对照 Orca：agent 进程死亡可见、一轮以协议应答结束、失败不归档

- 状态：Shipped（PR #568 → `main@ddc0bd458`，CLI v0.2.177；web deploy run 39152485734；真机项 V-182）
- 关联 backlog：B-629（共享 ACP backend + pi runner）、B-630（Gemini runner）；同批的 Claude 项见 B-631
  `specs/2026-10-claude-wrapper-orca-align.md`
- 包：`packages/happy-cli`（`src/agent/acp/AcpBackend.ts`、`runAcp.ts`、`sessionUpdateHandlers.ts`、
  新增 `acpAgentExit.ts`、`acpNotices.ts`、`acpTurnFailure.ts`；`src/gemini/runGemini.ts`、新增 `gemini/utils/turnFailure.ts`；
  `src/utils/processTree.ts`（B-628 的 `codex/codexProcessTree.ts` 搬到通用位置，原名 re-export）；
  `packages/happy-web-v2/src/screens/session/serviceEvent.ts`（一处正则）
- 参照：stablyai/orca `src/main/acp/`（MIT；只借做法，不拷代码）：`acp-agent-connection.ts`、`acp-json-rpc-peer.ts`、
  `acp-structured-turns.ts`、`acp-turn-failures.ts`、`acp-structured-session-adapter.ts`、`acp-oversized-lines.ts`、
  `acp-peer-limits.ts`、`acp-structured-stop.ts`；`src/main/pi/rpc-turns.ts`、`rpc-retry-activity.ts`

## 背景

pi（经 ACP）与 Gemini（`gemini --experimental-acp`）共用 `AcpBackend`。对照 Orca 的 ACP client 后，三类问题
会让网页在 agent 已经死了/拒了之后仍显示「工作中」，或把一次失败放大成会话消失：

1. **agent 进程死亡没人知道**。`@agentclientprotocol/sdk` 0.14.1 关流时只 abort 自己的 signal，`#pendingResponses`
   永不 reject（`dist/acp.js` `#receive` finally）；我们的 exit 处理只在 `code !== 0 && code !== null` 时发 `stopped`
   ——exit 0 与被信号杀掉都静默；stderr 只进 debug 日志。结果：Gemini OOM / pi-acp 崩 → `prompt()` 永久挂起，
   keepAlive 一直 `thinking:true`，网页永远「工作中」，Stop 无效，之后每条消息都挂死。
2. **一轮结束靠文本间隔启发式**。Gemini runner 在 `prompt()` 返回后再 `waitForResponseComplete(120000)` 等一次
   「500 ms 没新文本」的 idle；轮以工具结果结尾、或在「思考」中按 Stop 时等不到 → 120 s 后把
   「Timeout waiting for response to complete」当 agent 消息发出。pi runner 等 idle 或 5 分钟超时。
   工具调用另有 120 s 超时，到点把 call 踢出 active 集合并丢掉已流出的输出 → 超过 2 分钟的 bash 在网页里只剩 exit code。
3. **一次失败放大**。pi runner 的 catch 后 `throw` 跳出主循环 → finally 归档会话 + session-end（选了 pi 没有的
   thinking level、key 缺失都会触发）；backend `status: error|stopped` 直接让 runner 退出。Gemini 一次失败 =
   最多 3×`turn_aborted` + 3-4 条像 agent 说话的「Error: …」，404/400 也先重试 3 次；重试通告只进本地 TUI，
   重试后段落重复（累积器不按尝试清零）。
4. 另外：Gemini 的 Stop 不撤回待审批（`permissionHandler.abortAll()` 存在但没调用）；Gemini 的 SIGTERM 退出没有
   「离线」语义（daemon stop/升级杀掉 wrapper 时不发 session-end/deactivate，在线假象持续到 presence 超时）；
   dispose 只杀根进程（Windows 下根是 `cmd.exe /c gemini`，gemini 本体存活）；pi-acp 把 pi 自己的重试 /
   自动压缩 / notify 文案当 `agent_message_chunk` 发出，被我们粘进助手答案；stdout 单行无上限。

## 目标

- agent 进程任何形式退出 → 在飞的 prompt 立刻以带 exit code + stderr 尾的错误结束，网页看到
  「Process exited unexpectedly: <agent> process exited (code=…): <末 2000 字 stderr>」；下一条消息自动重启 agent。
- 一轮结束的唯一判据 = ACP `prompt` 应答（agent 在应答前已发完全部 update），读 `stopReason`；没有文本间隔
  启发式、没有工具超时、没有轮超时（Orca 同样没有死线）。
- 一次失败只是这一轮的失败：一条 service 行（agent 原话），turn-end `failed`，会话保留，下一条消息照常。
- Stop 撤回待审批；Gemini 的 SIGTERM 走离线；dispose 杀进程树；pi 的重试/压缩/notify 作为 service 行显示。

## 非目标

- pi 的 `turn/steer`（pi-acp 不传 `deliverAs`；要经注入扩展暴露）、pi 对话框保真（select → AskUserQuestion）、
  pi 子代理卡片、pi `session/load` 恢复（重启后 agent 失忆，先用提示说明）——各自单独立项。
- Gemini 的 resume（Gemini CLI 0.17.1 宣告 `loadSession:false`）。
- Orca 的 supervisor 进程组梯（宿主死则 agent 死）：只到直接子进程回收。

## 现状事实（代码已确认）

- SDK：`ClientSideConnection.prompt()` → `sendRequest` 把 resolver 放进 `#pendingResponses`；`#receive` 读到 EOF
  只 `#abortController.abort()`，不 reject（`node_modules/@agentclientprotocol/sdk/dist/acp.js` 720-760、843-864）。
  `connection.closed` / `signal` 可观察，但 pending 永远不会结算——所以在 backend 里把 `prompt()` 和「进程退出」
  赛跑。
- `AcpBackend.ts`：exit 只在 `code!==0&&code!==null` 发 `stopped`（原 484-490）；stderr 只 log（447-474）；
  `waitForResponseComplete` 120 s（1223-1242）；`cancel()` 直接 emit idle（1256-1265）；dispose SIGTERM→1 s→SIGKILL 根
  （1310-1332）；Windows spawn 经 `cmd.exe /c`（400-407）。
- `sessionUpdateHandlers.ts`：idle = 最后一块文本后 500 ms 或工具完成（180-196、330-335）；工具 120 s 超时后
  删除 `toolCallOutputs`（273-292）。
- `runAcp.ts`：`sendPrompt` 后再 `await turnEnded`（idle 或 5 分钟超时，713-719）；catch 后 `throw`（1217-1226）
  → finally 归档；`status error|stopped` → `stopRunnerFromBackendStatus` 退出（721-729）。
- `runGemini.ts`：`status: error` 既在状态处理里发 `turn_aborted` +「Error:」agent 消息，又在 catch 里再发一遍；
  finally 总发 `task_complete`；`handleAbort` 不调 `abortAll`；`registerKillSessionHandler` 不传 `processSignals`；
  `-32603` 一律重试。
- pi-acp 0.0.33 哨兵文案（`/opt/homebrew/lib/node_modules/pi-acp/dist/index.js` 1167-1203、1252-1270、1349-1359）：
  `Retrying (attempt N/M, waiting Ns)...` / `Retrying...` / `Retry finished, resuming.` /
  `Context nearing limit, running automatic compaction...` / `Automatic compaction finished; …` /
  `Pi input|editor UI request is not supported in ACP yet; cancelling it.`；notify 带 `_meta.piAcp.notify.level`。
- ACP `PromptResponse.stopReason`：`end_turn` / `cancelled` / `max_tokens` / `refusal` / …。
- Orca：进程 exit → `AcpConnectionClosedError(stderrTail)` 拒掉全部 pending、turn 结算 unknown、`session.ended`
  带 cause；turn 边界 = prompt 应答，请求无超时；拒绝的发送只是那一条 rejected（会话保留），下条消息重新 acquire；
  16 MiB 行上限，疑似应答的超长行让对应 pending 失败。

## 设计

### 1. 共享 ACP backend（`AcpBackend.ts`，pi 与 Gemini 共用）

- 每次 spawn 建一个 `processGone` promise；stderr 进 2000 字 ring；`exit`（任何 code/signal）→
  `agentExitError(agent, code, signal, tail)`（`acpAgentExit.ts`，带 `agentExited/agentExitCode/agentExitSignal/agentStderrTail`）
  → reject `processGone`、记 `exited`、`status: stopped`（detail = 该错误文本；dispose 后的退出不发）。
- `sendPrompt` = `Promise.race([connection.prompt(), processGone, inflight])`；已 `exited` 的 backend 直接 throw 该错误；
  应答后 `finishTurn()`：`waitingForResponse=false`、清 idle/工具计时器与 active 集合、发一次 `idle`；
  返回 `{ stopReason }`（`AgentBackend.sendPrompt` 签名改为 `Promise<PromptOutcome | void>`）。
- 工具调用不再有超时（删除 `startToolCall` 的 setTimeout；`getToolCallTimeout` 保留但无人调用）。
- stdout 过滤层：单行或无换行缓冲超过 16 MiB → 丢弃；若像应答（`"id": N` + `result|error`）→ 让在飞 prompt 失败
  并 `status: error`。
- dispose：`stopProcessGracefully`（POSIX SIGTERM；Windows 只 stdin EOF）→ 最多 4 s → `killProcessTree`
  （`utils/processTree.ts`，B-628 的实现搬过来）；已退出的进程不再发 cancel。
- `handleAgentMessageChunk`：agentName === 'pi' 时按 `acpNotices.ts` 识别哨兵文案 → `event: notice`。

### 2. pi runner（`runAcp.ts`）

- 删除 `pendingTurn/waitForTurnEnd/TURN_TIMEOUT_MS`：一轮 = `await backend.sendPrompt()`；`stopReason === 'cancelled'`
  或用户 Stop → turn-end `cancelled`；其它非 `end_turn` 的 stopReason 发一条「pi stopped the turn: …」。
- catch 不再 `throw`：`describeAcpTurnFailure`（`acpTurnFailure.ts`）→ service 行（进程死亡
  `Process exited unexpectedly: …`，其它 `pi error: <message>: <details>`），turn-end `failed`，继续循环。
- `status: stopped` 在首个 session 建立之后 → `backendGone`；`status: error` 中途不再退出（它就是那次 prompt
  的失败，由 catch 报一次）。启动期（`backendStarted` 之前）的 `error|stopped` 仍让 runner 退出（原行为，有测试）。
- 下一条消息遇到 `backendGone` → `restartBackend()`：卸监听、dispose 旧 backend、`createBackend()`、`startSession()`、
  重发 Todo discovery，并发一条「pi was restarted after its process exited; it does not remember the earlier
  conversation (the transcript here is kept)」。
- `event: notice` → `session.sendSessionEvent({type:'message'})`（`acpNoticeMessage`：
  「pi is retrying the model request (attempt 1/3, waiting 2s)」等），不进 transcript。

### 3. Gemini runner（`runGemini.ts`）

- 出队即 `thinking=true`（B-622 的教训）；`turnEnding` 记录这一轮怎么结束，finally 只在 `completed` 时发
  `task_complete`；失败由 catch 发一次 `turn_aborted` + 一条 service 行（`gemini/utils/turnFailure.ts`
  `describeGeminiFailure`：exited / quota / rate-limit / auth / not-found / empty / not-installed / other，文案沿用原来的）。
- 删除 `waitForResponseComplete`；读 `stopReason`（`cancelled` → aborted）。
- 重试：只对瞬时错误（空响应 / `Model stream ended` / overloaded / UNAVAILABLE / 503 / ECONNRESET…），
  每次尝试前清空 `accumulatedResponse`，通告经 `sendSessionEvent`（「Gemini is retrying after an empty response (attempt 1/3)」）。
- `status: stopped` → `backendGone`；下一条消息走现有「模型切换」重建路径（dispose + `createGeminiBackend` + 注入
  `conversationHistory` 作上下文），并发一条「Gemini was restarted after its process exited; …」。
- `handleAbort` 先 `permissionHandler.abortAll()`；`registerKillSessionHandler(..., { processSignals: true,
  onSignal: () => handleKillSession('offline') })`，`handleKillSession(intent)` 用 `settleCodexSession`（archive 盖章 /
  offline 只 session-end + deactivate）。

### 4. web（一处）

`serviceEvent.ts`：`Process exited unexpectedly: …` 前缀与 `^(codex|pi|gemini|claude) error:` 都按 agent-error
（红色、原文）显示；裸 `Process exited unexpectedly` 保持固定文案 + 重启按钮。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI × 新 web | 全部生效 |
| 新 CLI × 旧 web | 新增的全是既有信封（session event `message`、turn-end `failed`、`queue-cancel`）：旧 web 把 `Process exited unexpectedly: …` / `pi error: …` 显示为灰色 subtle 行（仍可读），其余同新 web |
| 旧 CLI × 新 web | 正则只多匹配几种前缀，旧 CLI 不发这些文本 → 无变化 |
| 新 CLI × 旧 server | 无 server 改动，无新 RPC/字段 |
| pi-acp 非 0.0.33 | 哨兵文案按整句匹配，不匹配就当普通输出（现状）；`stopReason` 缺失 → 当 completed（现状） |
| Gemini CLI 其它版本 | 同上；`stopReason` 缺失 → completed |
| Windows | 停止路径改为 stdin EOF → 4 s → `taskkill /T /F`（原来 `kill()` 只终结 cmd.exe）；无真机，登记 V-182 |

发布顺序：CLI（tag → publish → promote）与 web（`deploy-hwsg rollout=switch`）互不依赖；运行中的老 wrapper 要
「重启会话」才换代码。

## 风险

- pi 重启后失忆：提示已说明；`session/load` 恢复留后续。**已做（B-633，`2026-10-pi-session-load.md`）**。
- pi-acp 哨兵文案随版本变化会退化为普通输出（不会误伤：整句匹配）。
- 去掉工具超时后，一个永不结束的工具调用由 agent 自己负责；Stop 仍经 `session/cancel`。
- `finishTurn` 在应答后清空 active 工具集合：应答之后再来的 `tool_call_update`（协议上不应有）会被当成新 call。

## 验收标准

- `AcpBackend.lifecycle.test.ts`（真实子进程 `__fixtures__/fakeAcpAgent.mjs`）：应答即结束（含未完成的工具调用）；
  中途死亡 → prompt 以 code=3 + stderr 尾拒绝、`stopped`、再发直接拒；exit 0 也宣告；超长应答帧让 prompt 失败。
- `runAcp.test.ts` B-629 三例：死亡 → turn-end failed + 进程行 + 会话保留 + 下条消息重启 agent；拒绝 → `pi error:` +
  会话保留 + 同一 agent 继续；哨兵文案 → service 行不进 transcript。`acpNotices.test.ts`、`acpTurnFailure.test.ts`。
- Gemini：`turnFailure.test.ts`（分类与重试谓词）；`runGeminiWiring.test.ts` 源码断言（mutation-check 5/5）。
- web `serviceEvent.test.ts`；CLI/web 门禁全绿。

## 留真机验证项

- V-182：真实 pi / Gemini 会话里 kill -9 agent 进程 → 对话里出现带 exit code 的红色行、会话仍在、再发一条自动重启；
  Gemini 在思考中按 Stop → 立即结束不等 120 s、审批卡消失；pi 触发 provider 重试时对话里出现灰色重试行而不是混进答案；
  Windows 停止/归档后无残留 gemini/pi 进程。
