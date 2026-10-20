# Claude Code wrapper 对齐 Orca（续）：进程树回收、投递确认、下线模型自愈

- 状态：Implemented（PR 待合并）
- 日期：2026-10-21 ｜ 关联 backlog：B-634（B-631 的「非目标」三项，见 `2026-10-claude-wrapper-orca-align.md`）
- 包：仅 `packages/happy-cli`
- 参照：stablyai/orca `src/main/claude/`（MIT；只借做法，不拷代码）：`claude-agent-sdk-exit-proof.ts`、
  `claude-agent-sdk-process-spawn.ts`、`claude-agent-sdk-user-message-queue.ts`、`claude-structured-retired-model.ts`

## 背景

B-631 对齐了轮结束、退出原因、重试可见、控制截止、Stop 回收插话，留下三项：

1. **进程树**：SDK 只停它 spawn 的根（stdin EOF → 2 s → SIGTERM → 5 s → SIGKILL，`sdk.mjs ProcessTransport.close`）。
   Claude Code 下面的 MCP server、Bash 工具命令、后台任务在根死后被 init 收养继续跑；daemon 停会话时
   `terminateProcess` 只杀 wrapper pid，wrapper 被 SIGKILL 时整棵树变孤儿。
2. **投递确认**：Query 中途死掉（进程退出、传输故障）时，已推入但 Claude Code 从未 `started` 的用户消息静默丢失——
   网页上看起来已发送，其实没人读。B-631 只处理了 Stop 扫掉的那部分。
3. **下线模型**：网页每条消息都带所选模型，wrapper 原样交给 Claude Code；模型下线后每轮都失败，CLI 自己用根 assistant
   回复的 `error: 'model_not_found'` 说明了原因，我们没读。

## 现状事实（代码已确认）

| # | 事实 | 位置 |
|---|---|---|
| ① | SDK 0.3.296 的 `SpawnedProcess` 没有 pid；但它自己的 `spawnLocalProcess` 在 spawn 后调用 `this.options.onProcessSpawned(i.pid)`（未写进 sdk.d.ts） | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` |
| ② | 自定义 `spawnClaudeCodeProcess` 时 SDK 不再收集 stderr 尾，B-631 的退出原因（`exited with code N. stderr: …`）会丢 | 同上 `spawnLocalProcess` 的 `stderrTail` |
| ③ | SDK 在宿主进程 `exit` 时 SIGTERM 它跟踪的子进程（`f_` tracker），不管孙进程 | 同上 |
| ④ | daemon `stopSessionAndWait` / `stopSession` 用 `terminateProcess(wrapperPid)`：SIGTERM → 2 s → SIGKILL | `daemon/run.ts`、`daemon/processTermination.ts` |
| ⑤ | Claude Code 2.1.296 对带 uuid 的命令发 `command_lifecycle`（queued → started → …，能力 `msg_lifecycle_v1`） | B-631 spec 现状事实 ⑤ |
| ⑥ | launcher 有跨 launch 的单槽「停放」：`modeGate.park({message, mode, uuid})`，下一次 launch 的 `nextMessage` 先取它 | `claudeRemoteLauncher.ts`、`launchModeGate.ts` |
| ⑦ | SDK 类型 `SDKAssistantMessageError` 含 `'model_not_found'` | `sdk.d.ts` |

## 设计

### ① 进程树回收

- **纯函数模块** `utils/processTreeSnapshot.ts`：`ps -A -o pid=,ppid=,lstart=`（`LC_ALL=C`）读进程表；
  `descendantsOf`、`snapshotTree`、`survivorsOf`（身份 = pid + 启动时间，pid 复用不误杀）、`killSurvivors`（SIGKILL）、
  `terminateSurvivors`（SIGTERM → 最多 1 s → SIGKILL）。Windows 全部 no-op（无廉价快照；`taskkill /T` 已在 ACP 路径使用）。
- **Query 硬中止**（`sdk/query.ts`）：经 `onProcessSpawned` 拿到 Claude Code pid；launcher 的 abort 信号到达时，
  **先**快照整棵树（根还活着，才找得到子孙），再把 abort 交给 SDK；8 s（SDK 关停窗口 + 余量）后 SIGKILL 快照里仍是原进程的成员。
  不用自定义 spawn，保住 SDK 的 stderr 尾（事实 ②）。`claudeProcessTree.test.ts` 断言 sdk.mjs 仍调用
  `onProcessSpawned`，SDK 升级去掉它时测试会红。
- **wrapper 退出**（`runClaude` cleanup，SIGTERM/SIGINT/kill RPC/休眠）：开始时快照 wrapper 自己的子孙，
  `process.exit` 前 `terminateSurvivors`。
- **daemon 停会话**：`terminateProcessTree` = 快照 wrapper 子孙 → `terminateProcess` → settle 后 SIGKILL 幸存者。
  wrapper 正常退出时自己已回收，这里只在它被 SIGKILL 或卡死时生效。
- 不回收的：快照时已不在树里的进程（`setsid`/双 fork 的守护进程、shell 已退出的 `nohup … &`）——那是有意脱离的，不是遗留。
- **不加 metadata `claudePid`**：backlog 原文提议用它让 takeover/kill 一并回收；daemon 侧快照 wrapper 子孙已覆盖
  Claude Code 及其整棵树，无需新字段，因此**没有协议/schema 变更**。

### ② 投递确认

- `createClaudeCommandTracker` 记录每条带 uuid 消息的内容与 mode；`takeUnconfirmed()` 在 Query 结束时取出
  「从未 `started`、也未被报告过」的消息。
- 只在 CLI 声明 `msg_lifecycle_v1` 时启用——没有 lifecycle 帧的 CLI 无法确认任何东西。
- 处理（纯函数 `planUnconfirmedCommands`）：
  - launcher 的 abort（Stop / 退出 / 切本地）结束的 → 全部打 B-332 `aborted` 墓碑；
  - 故障结束的 → 第一条（未重投过、且停放槽空）停放到下一次 launch 重投**一次**，其余与二次失败打墓碑。
    「一次」防止一条每次都把进程打死的消息无限循环。
- 已 `started` 的消息不动（模型可能已读，Orca：any end is doubt）。

### ③ 下线模型自愈

- 纯函数 `retiredModelFrom(message, runningModel)`：根 assistant（`parent_tool_use_id == null`）且 `error === 'model_not_found'`
  且当前有显式模型 → 返回该 id。
- 命中：会话级 `retiredModels` 记下 id；live Query `setModel(undefined)`（30 s 有界，超时则下一边界重发）；
  发一条 session event 说明「模型 X 已不可用，已切回默认」。
- 之后带这个 id 的消息（网页每条都重发所选模型）一律按默认模型跑，直到用户选别的模型；新 Query 也不会以它启动。
- 归一化在 `claudeRemote` 取消息的两处回调内就地做，而不是包一层 promise：多一个 microtask 会让
  `pullingNext` 的复位晚于下一条 result（现有测试「does not read a queued follow-up…」可复现），属于既有时序约束。

## 兼容与发布

- 仅 CLI；无 wire/schema/metadata 变更。旧 daemon + 新 wrapper：wrapper 自己回收；新 daemon + 旧 wrapper：daemon 回收。
- 需要 CLI 发版；daemon 侧回收随 daemon 升级生效。

## 验收

- [x] 纯函数单测：`processTreeSnapshot.test.ts`（含本机真实 `ps` 找到自己的子进程）、`claudeProcessTree.test.ts`、
  `claudeRetiredModel.test.ts`、`claudeCommandLifecycle.test.ts`（takeUnconfirmed / plan）、`processTermination.test.ts`。
- [x] `claudeRemote.test.ts`：model_not_found → `setModel(undefined)` + notice、第二条不再切回已下线模型；子代理的 model_not_found 不触发；
  进程死时未 started 的消息带内容上报（aborted:false）；无 lifecycle 能力不上报。
- [x] 接线源码断言 `claudeOrcaAlignWiring.test.ts`（B-634 段），逐条 mutation-check。
- [x] 隔离 `HAPPY_HOME_DIR` daemon 实跑：见 PR 正文（硬中止后 MCP/Bash 子进程被回收；`--model` 不存在的模型自愈）。

## 未做 / 留待

- Windows 的树快照（无廉价 `ps`）；Windows 上维持现状（根进程 + SDK 行为）。
- Orca 的「写入回执」队列（区分「确定没写进 stdin」与「写没写不确定」）：我们以 lifecycle `started` 为确认点，
  对「已写入但未 started」一律视为未确认，粒度足够，不再引入新队列。
