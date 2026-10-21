# pi：轮中插话、扩展对话框保真、子代理卡片、轮外输出

- 状态：Implemented（PR 待合并）
- 日期：2026-10-21 ｜ 关联 backlog：B-632（B-629 遗留，`2026-10-acp-wrappers-orca-align.md`）
- 包：`happy-cli`（AcpBackend / AcpSessionManager / runAcp / startHappyServer / pi 扩展 `teams/resources.ts` / turnState）、`happy-wire`（`PI_STEER_CAPABILITY`）、`happy-web-v2`（steerSupport、piToolMapping）
- 参照：Orca `src/main/pi/rpc-turns.ts`（steer/followUp）、`rpc-extension-dialogs.ts`（答案必须是给定选项）、`src/main/acp/acp-subagents.ts`

## ① 轮中插话（Steer）

pi 1.x 扩展 API 有 `pi.sendUserMessage(text, { deliverAs: 'steer' })`；pi-acp 0.0.33 对轮中的 prompt 只排队。做法：

- wrapper 的本地 HTTP 服务器（startHappyServer）新增 `/runtime-steer/<uuid>`：GET 长轮询（25 s，204 = 无）、POST `/hello`、POST `/ack {id, delivered}`；拒绝带 `Origin` 的请求与错误路径。
- 注入的 Very Happy pi 扩展（`HAPPY_PI_STEER_URL`，同源校验）加载时 `hello`；`agent_start` 起轮询，取到即 `sendUserMessage(…, {deliverAs:'steer'})` 并 ack；`agent_end` 停。
- runAcp：`meta.delivery === 'steer'`、扩展已 hello、正在回合中、无附件 → `offer()`（5 s）；被取走 → 不入队；否则照旧入队成为下一轮。取走但未 ack 视为已投递（避免重复）。
- **能力**：扩展 hello 之后才把 `pi-steer-v1` 写进 metadata.capabilities（铁律 14：只宣告实际生效的能力）；web `wrapperSupportsSteer('acp', caps)` 认它。
- `sessions read --wait`（turnState）：`meta.delivery === 'steer'` 的消息并入运行中的回合，其后无 turn-start 的 turn-end 计为它的结束（对 Claude / Codex steer 同样成立）；回落为排队时，新回合的 turn-start 会重置判定。

## ② 扩展对话框

pi-acp 把扩展的 `select` / `confirm` 转成 ACP 权限请求（toolCallId `pi-ui-<id>`，选项 `choice-N` / `yes`/`no`）。之前都显示成「批准」卡，批准静默选第一项。

- `select` → `AskUserQuestion` 输入（单题、选项 = pi 给的标签），复用网页问题卡；回答（`updatedInput.answers[question]`）**精确匹配**某个标签才选对应 `choice-N`，自由输入/拒绝/无答案 → `cancelled`，绝不猜。
- `confirm` → 仍是批准卡，批准/拒绝明确映射 `yes` / `no`。
- `BasePermissionHandler` 透传网页发来的 `updatedInput`（之前丢弃）。
- `input` / `editor`：pi-acp 自己 cancel，不到达我们（留待 pi-acp 支持）。

## ③ 子代理卡片 + 轮外输出

- pi 的 `subagent` 工具（pi-subagents：`{agent, task}` / `{tasks}` / `{chain}`）：tool-call 带 `args.sessionSubagent`，并发 `start`（description = task 或「N parallel tasks」/「chain of N steps」，subagentType = agent）；call 结束发 `stop`（失败 → failed）；回合结束仍未结束的发 `stop: stopped`。web `piToolMapping` 把它映射为 `Agent` 卡（与 Claude 同一组件、同一生命周期 id）。
- 轮外输出：没有我们的 prompt 在跑时出现的内容（agent 自发的 follow-up、后台结果）开一个合成回合并持 lease（thinking），agent 报 idle 或 60 s 静默即结束（铁律 13：租约要有过期条件）；我们的 prompt 开始前先结束它。实测 pi-acp 会把 follow-up 归入在途 prompt，真 pi 下难以触发，作为防护以单测覆盖。

## 兼容矩阵

| | 旧 Web | 新 Web |
|---|---|---|
| 旧 CLI | 不变 | 不变（无 `pi-steer-v1` → 不显示 Steer；无 `sessionSubagent` → 普通行） |
| 新 CLI | 无 Steer 按钮（不认能力，忽略）；select 显示为问题卡（AskUserQuestion 旧 web 已支持）；subagent 调用为普通行、`sessionSubagent` 使旧 web 隐藏 start/stop 药丸 | 完整 |

- 发布顺序：建议 server/Web 先于 CLI（让子代理卡与 Steer 一上来就完整）；反序只在窗口期丢子代理药丸。
- wire 只新增常量；envelope 形状不变（`start`/`stop`/`subagent` 均为既有字段）。

## 验收

- [x] `piSteerChannel.test.ts`：offer/take/ack/超时/断开的轮询不吞消息；**端到端**：真 `startHappyServer` + 真注入扩展代码 + 假 pi 对象 → `sendUserMessage(text, {deliverAs:'steer'})`，跨源与错误路径 403。
- [x] `piExtensionDialogs.test.ts`：识别/映射/答案精确匹配/拒绝与自由输入 → cancelled；fake ACP agent 走线：select 答 Blue → `choice-1`，confirm 拒绝 → `no`。
- [x] `AcpSessionManager.test.ts`（子代理 start/stop、失败、并行/链、回合结束补 stop）、`acpOutOfTurn.test.ts`、`runAcp.test.ts`（合成回合 + lease）、`turnState.test.ts`（steer 三例）、web `steerSupport.test.ts`、`piToolMapping.test.ts`。
- [x] 隔离 `HAPPY_HOME_DIR` daemon + 真 pi 1.1.0 / pi-acp 0.0.33 / pi-subagents 0.77.0：select 选 Blue → 工具返回 `user picked: Blue`；`sleep 30` 期间 steer「secret word is MANGO」→ 同一回合回答 `MANGO`，`read --wait` exit 0；`subagent(delegate)` → start（标题为任务）/stop completed 信封。
