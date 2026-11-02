# 运行中分叉会话（B-860）

> 状态：Final（随实现 PR 定稿；合并后回标 Shipped）
> 日期：2026-11-02 ｜ 关联 backlog：B-860 ｜ 前身：B-851（Web 分叉）、B-851b（切点对齐）、B-492（`spawn --fork`）

## 背景

B-851 的 Web 分叉在会话运行中一律拦下（`forkModel.ts` `sessionForkBlock` → `running`，「等这一轮结束后再分叉」）。
Owner 11-02：「正在运行中的时候，不能 fork，你修一下」。CLI `spawn --fork` 没有拦截，但运行中整份复制会把半截轮次带进新会话。

## 行为

| 入口 | 空闲 | 运行中 |
|---|---|---|
| ⋯「分叉会话」 | 整份复制（不变） | 只带已完成轮次；正在进行的这一轮（含轮中 steer/投递的消息）不带；其中用户打的消息预填进新输入框；新会话出现 sticky 提示。首轮还在跑 → `noHistory` 原提示，不建会话 |
| 「从这里分叉」 | 切在该消息前、预填（不变） | 放行，语义不变：早消息切在已完成部分里；正在跑的那条切在它之前并预填 |
| `very-happy spawn --fork` | 整份复制（不变） | 同「分叉会话」；被排除的消息打印出来（`--json`: `excludedPrompts`）；首轮在跑 → 报错退出 |

原会话只被读取：不中断、不暂停；排队消息、权限请求、自动重启照常。离线 / 不支持的 flavor / 无历史三种拦截不变。

## 实现

- **Claude**（`claudeSessionFork.ts`）：`completeLines` 丢弃还没写完的末行（无换行且解析失败）；
  `findUnfinishedTurn` 从末尾往回收集 prompt，遇到「收尾条目」停：assistant `stop_reason` 不是
  `tool_use`/`pause_turn`、`[Request interrupted by user…]`、`<local-command-stdout|stderr>`、`compact_boundary`、
  `isCompactSummary`；sidechain 不算。切在收集到的第一条 prompt 前。`forkSession` 与 `forkBeforeUserMessage` 也改走
  `completeLines`。实测本机近 60 个 JSONL 1793 个轮次，未以收尾条目结束的 19 个全是轮中投递 / 本地命令 / compact，均被上述规则覆盖。
- **Codex**（`codexThreadFork.ts` `forkCodexCompletedTurns`）：实测 Codex 0.154，第二个 app-server 读运行中的线程时，进行中的 turn 显示为
  `interrupted`；整线程 fork 会把它带进去；`lastTurnId` 指向它会被拒（`identifies an in-progress turn`）；`lastTurnId` = 上一轮成功，
  原 turn 完整跑完（`vh-team-B-860/codex-probe*.log`）。所以：末轮 `inProgress|interrupted` → 用 `lastTurnId` 分叉到上一轮并逐轮校验；
  末轮 `completed`（这一轮还没落盘）→ 整线程 fork。
- **新 RPC**（`apiMachine.ts`）：`claude-fork-completed-turns`、`codex-fork-completed-turns`，返回
  `{ newClaudeSessionId | newCodexThreadId | startFresh: true, excludedPrompts: string[] }`。另起名字：旧 daemon 回 `Method not found`，
  Web 显示「CLI 太旧」，绝不会静默复制半截轮次。
- **Web**：`sessionRunningNow`/ChatHeader `running` 只决定走哪条 RPC 和提示，不再拦截；`forkPrefill` 把 `excludedPrompts`
  映射回 Web 自己的消息原文（转写可能带 wrapper 前缀），丢掉注入消息（task-notification / team / peer / automation）和 `<command-name>` 类条目。
- **CLI**：`spawn --fork` 用源会话 server 日志的 `analyzeLatestTurn`（与 `sessions read --wait` 同一判定）决定是否运行中；读不到按空闲处理。

## 兼容与发布顺序

| Web | daemon | 运行中分叉会话 | 从这里分叉 |
|---|---|---|---|
| 新 | 新 | 只含已完成轮次 + 预填 + 提示 | 放行 |
| 新 | 旧 | 提示升级 CLI（`Method not found` → outdated） | 放行（旧 RPC，切点在该消息前，半行在切点之后） |
| 旧 | 新 | 仍拦截（旧 Web 行为） | 仍拦截 |

server 不变。Web 与 CLI 可任意顺序发布；默认先 server/Web 后 CLI。

## 已知边界

- 「从这里分叉」点在运行中这一轮里 steer 进去的第二条消息上：Codex 拒绝（切点不在 turn 开头），Claude 会带上这一轮前半段。罕见，未处理。
- Codex：VH 认为在跑、但新 turn 还没写入 rollout，且上一轮恰好是被真实中断的 → 那一轮会被当作进行中切掉（窗口极短）。
- 判定运行中的时刻与 RPC 读取之间轮次结束：Claude/Codex 都退化为整份复制，无提示，结果正确。

## 验收（2026-11-02，隔离 daemon，证据 `~/code/github/skills/tmp/vh-team-B-860/`）

Claude 与 Codex 真实会话各一遍：分叉会话 / 早消息从这里分叉 / 正在跑的消息从这里分叉 / CLI `spawn --fork`，原会话这轮跑完并可续聊、新会话可续聊；
边界：首轮（Web noHistory、CLI 报错）、排队消息、权限请求挂起中、`/compact` 之后；手机 coarse 中英文截图。
