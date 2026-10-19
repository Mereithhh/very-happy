# Orca（stablyai/orca）

对照时间 2026-10-11 ～ 2026-10-19；checkout 与 commit 见 [sources.md](sources.md)。

## 它是什么、为什么是我们的参照

- MIT 的桌面 IDE（Electron，package.json 自述 "Next-gen IDE for parallel agentic development"），在本机包一层 wrapper
  跑十几种 agent：`src/main/` 下有 `codex`、`claude`、`acp`（pi、Gemini 等走 ACP）、`pi`、`gemini`、`amp`、`cursor`、
  `copilot`、`opencode`、`droid`、`kimi`、`kiro`、`codebuddy`、`antigravity`。
- 它和 very-happy 的 CLI wrapper 处在同一层：agent 进程 ↔ 一份结构化对话。所以它是 **wrapper 行为** 的参照——一轮何时结束、
  失败怎么浮现、进程生命周期、轮中插话、子 agent 归属——而不是协议或产品形态的参照。产品 / UX 层的对比另见
  [`../2026-09-ux-review/vendors/orca/`](../2026-09-ux-review/vendors/orca/)（2026-09-03，基于文档与 release notes）。
- 它的每个对照点都有同名测试文件（`*-structured-*.ts`、`*-turn-*.ts`、`*-exit-*.ts`、`*-process-tree-*.ts`），
  看文件名就能定位到做法。

## 借鉴规则（各批实现 agent 的统一约束）

- 只借做法，不拷大段代码；小段纯函数（<50 行）可以改写引入，文件头注明来源
  （已有例子：`packages/happy-cli/src/claude/claudeTurnEnd.ts`、`claudeSystemNotices.ts` 的头注释 "approach from Orca, src/main/claude/…"）。
- checkout 放 repo 外（见 sources.md），repo 里只留结论。
- 每批先写 spec，「现状事实」段必须用我方代码与真实 SDK 探针核实（SDK 版本、宣告的 capability），不照抄 Orca 对 SDK 的假设；
  实现后两路独立 review 修 should-fix，再合一个 PR、发一个 CLI 版本。

## 已借鉴的做法（wrapper 层，按 agent）

| agent | 修前缺陷 | Orca 做法 → 我方落点 | backlog / spec / 版本 |
| --- | --- | --- | --- |
| Codex | 一轮结束判据乱：子 thread 的 `turn/completed` 结束主轮、陈旧 `idle` 立刻结束、轮中 `final_answer` 当结束；app-server 死掉静默 resolve 成 aborted | thread 作用域 + `turn/completed` 唯一判据；退出原因带 code + stderr 尾 | B-622 → B-625；[spec](../../../specs/2026-10-codex-turn-end-model.md)；CLI 0.2.175 |
| Codex | 轮中消息只能排到下一轮；`spawn_agent` 子 thread 的 item 扁平进主对话、tokenUsage 盖掉主会话；停 app-server 只杀根进程 | `turn/steer`（等轮打开 ≤5 s，echo 追踪，未送达打 `queue-cancel` 墓碑）；子 thread item 归子代理卡；进程树杀（POSIX `pkill -P` + SIGKILL / Windows `taskkill /T /F`） | B-628；[spec](../../../specs/2026-10-codex-steer-subagents-process-tree.md)；CLI 0.2.176，web 按 `codex-steer-v1` 开「调整方向」 |
| pi、Gemini（共享 ACP backend） | agent 进程死亡无人知（ACP SDK 关流不 reject pending `prompt()`，网页永远「工作中」）；一次 prompt 失败归档整个会话；一轮靠文本静默 500 ms / 120 s 超时结束；pi 的重试 / 压缩 / notify 文案混进答案；dispose 只杀根进程；单帧无上限 | 一轮 = `prompt()` 应答（读 `stopReason`：`cancelled` → 停止，`error` → 失败）；进程退出 race 掉 prompt → 一行 `Process exited unexpectedly: …` + 下一条消息惰性重启（pi 说明失忆，Gemini 回灌对话）；失败只一行、会话保留；pi 通告降为服务行；dispose 杀进程树；16 MiB 单帧上限 | B-629 / B-630；[spec](../../../specs/2026-10-acp-wrappers-orca-align.md)；CLI 0.2.177 |
| Claude Code | 没 `result` 的轮永远在跑、下一条排队消息不派发；退出原因被吞成固定文案；`api_retry` 退避几分钟像卡死；interrupt / setModel / setPermissionMode 无截止；Stop 不回收已排队插话 | `system/session_state_changed idle` 为权威结束（子进程 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`，只结束 CLI 已宣告的轮）；退出行带 code + stderr 尾；`Claude is retrying after HTTP 529 …` 行（节流）；控制请求截止（interrupt 8 s → 硬中止，setModel 30 s，权限模式 15 s 并回写旧模式）；`interrupt({cancelQueued:true})`（CLI 宣告 `interrupt_cancel_queued_v1` 时）+ 未开始的插话打墓碑 | B-631；[spec](../../../specs/2026-10-claude-wrapper-orca-align.md)；CLI 0.2.177 |

跨 agent 的共同点：一轮的结束只认 agent 自己的协议信号，不用文本静默或超时猜；失败是一行服务事件，会话不归档；
所有新信号都复用既有 wire 信封（会话 `message` 事件、turn-end `failed`/`error`、`queue-cancel`），旧 web 只是少了样式。

## 看过但没借，或留后续

- 后续立项（todo，见 [backlog](../../backlog.md)）：B-632 pi 轮中插话（pi-acp 不传 `deliverAs`，要经注入扩展）、对话框保真、子代理卡片；
  B-633 pi `session/load` 恢复（现在重启后新开 session 并提示失忆）；B-634 Claude 进程树回收、投递确认、下线模型自愈。
- 判定不做：Orca 的 supervisor 进程组梯（宿主死则 agent 死）——我方只回收直接子进程，app-server 自己收孙进程；
  孙 thread 层级（wire 只有一级 `subagent`）；Gemini resume（Gemini CLI 0.17.1 宣告 `loadSession:false`）；
  `priority:'now'` 插话在 Claude Code 2.1.296 上的抢占语义是既有行为。
- Orca 的 Electron 侧（journal 持久化、视图状态、trust presets、`agent-launch` 等）与我方 server/web 架构无关，没有对照。

## 更早的产品 / UX 批次

B-547～B-551、B-552～B-560、B-563～B-588（2026-10-12～14：看板、⌘K、diff 批注、通知、终端、worktree 等）是对照 Orca 产品面做的
三批，B-593 是给用户讲清这些功能的帮助页；各批给实现 agent 的统一约束在本机 `skills/tmp/vh-orca-lessons/COMMON*.md`（不进 repo）。
状态以 backlog 为准。

## 下次再对照时

1. 更新 repo 外的 checkout，把 commit 和日期记进 sources.md。
2. 对照点在 `src/main/<agent>/` 的 `*-structured-*`、`*-turn-*`、`*-exit-*`、`*-process-tree-*` 文件；上表列的是 2026-10 已看过的。
3. 我方 SDK 事实必须探针核实后写进 spec（Claude Agent SDK / pi-acp / Gemini CLI 各自版本与宣告的 capability），
   新能力按 AGENTS 铁律 14 由 session capability 开关，旧端有回退。
