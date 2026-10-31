# 会话运行意图：模型 / 思考强度跟着会话走（B-849b）

状态：Final（实现随 PR-B）。关联：B-849b、B-848 第 2 步、QA23b P2-1、QA26 P1（Claude configuredModel）。
设计来源：`tmp/vh-team-B-849-850/DESIGN.md` §4、§6 PR-B。

## 问题

会话里选的模型 / 思考强度只存在选它的那台设备的 localStorage（`session-model-modes`、
`session-effort-levels`）。另一台设备打开同一个会话，控件显示账号默认，**下一条消息也按账号默认发出**，
会话的模型被悄悄换掉。另外：

- Codex 在 abort / resume 后把 effort 重置为 medium，标签仍写 xhigh（QA23b P2-1）；
- Claude 不报实跑 effort，不报 settings.json 的模型（`configuredModel`），「本机配置」在会话中途只能禁用。

## 现状事实（代码已确认）

- 会话选择：`sync/storage.ts updateSessionModelMode/updateSessionEffortLevel` → localStorage；
  发送时 `sync/messageMeta.ts resolveMessageModeMeta` 用 `session.modelMode ?? 账号 override`。
- Claude wrapper：`claude/messageMode.ts` 把 meta.model/effort 变成粘性状态；abort 时
  `runClaude.ts resetCurrentModeDefaults` 把 model / effort 重置为默认。
- Codex wrapper：`codex/runCodex.ts` `resetCurrentModeDefaults` 把 effort 设回 `DEFAULT_CODEX_EFFORT`；
  重连新 wrapper 也从 medium 起步。
- SDK 0.3.306 实测（`tmp/vh-team-B-849b/probe`）：
  - `Query.getSettings()`（.d.ts 未声明，运行时存在）返回 `effective.model`（按 user/project/local
    合并后的 settings 模型）和 `applied.effort`（下一次请求实际发送的 effort）；init 帧在本传输下不带 effort；
  - `setModel(undefined)` 落到 Claude Code 内置默认（Fable 5.1），**不是** settings 模型；
  - 带 `resume` 重建的 Query 沿用 transcript 里上一轮的模型，也不是 settings 模型。

## 方案

### 数据

| 位置 | 字段 | 语义 |
|---|---|---|
| session metadata（wrapper 单写） | `modelIntent: string \| null` | `latest` / `default`（本机配置）/ 模型 id；null = wrapper 记录意图但还没人选；缺省 = 旧 wrapper |
| | `effortIntent: string \| null` | `default`（自动）/ 档位 |
| | `stickyModel`（Claude 新增上报） | wrapper 对不带 model 的回合继续使用的模型 |
| | `configuredModel`（Claude 新增上报） | settings.json 合并后的模型，null = 未指定 |
| | `currentThoughtLevelCode`（Claude 新增上报） | 实跑 effort（`applied.effort`） |
| message meta | `modelIntent` / `effortIntent` | Web 发送时附带选择本身（如 `latest`），wrapper 记为意图 |
| capability | `session-run-intent-v1` | 记录意图、应答 RPC、resume 恢复 |
| | `claude-config-model-v1` | Claude 收到 `model: null` 时切到 settings 模型 |
| session RPC | `session-run-intent` | `{modelIntent?, model?, effortIntent?, effort?}` → 立即改 wrapper 粘性状态并记录意图 |

字段全是 `z.string().nullable().optional()`，读取经白名单（`happy-wire/src/runIntent.ts`，铁律 14）。

### 规则

1. **以 wrapper 记录为准**。任何设备显示、发送都用 `metadata.modelIntent/effortIntent`；账号默认只用于新会话。
2. **选了即同步**：Web 选完立即调 `session-run-intent`，wrapper 改粘性状态并写 metadata，其他设备实时看到；
   不带 meta 的消息（CLI send、team wake）也按它跑。RPC 不可用（旧 CLI、离线）时，本地值作为待定值随下一条消息提交。
3. **并发改选：最后到达 wrapper 的选择生效**。本地选择记录选时看到的意图（base）；之后意图变成别的值
   （别的设备的选择后到）→ 本地值作废并清掉；wrapper 回显了本地值 → 本地值清掉。
4. **没有意图的旧会话**：本设备有本地值用本地值（旧 CLI 维持现状）；否则按会话实际在跑的
   （Claude `currentModelCode`；Codex 上报的 effort，模型仍按 B-844c「跟随本机配置时清掉 sticky」），不用账号默认；会话从没跑过才用新会话默认。
   新 Web 发出的第一条消息会把选择写成意图。
5. **resume / abort**：新 wrapper 从 metadata 恢复意图（Claude model + effort；Codex effort，旧 metadata 无意图时取上一 wrapper
   报的 `currentThoughtLevelCode`）；abort 不再重置 model / effort。
6. **Claude「本机配置」**：wrapper 收到 null 时 `getSettings().effective.model` → `setModel`；带 resume 重建 Query 时在第一条
   prompt 前切到 settings 模型。据此会话中途重新开放「本机配置」（按 `claude-config-model-v1` gate），显示 settings 模型名。

### 兼容矩阵

| Web \ CLI | 旧 CLI | 新 CLI |
|---|---|---|
| 旧 Web | 现状 | CLI 从 meta.model/effort 推断意图（`latest` 记为解析后的模型 id）；不调 RPC；不报错 |
| 新 Web | 无 capability → 本地值降级（规则 4）；不调 RPC；「本机配置」中途仍禁用 | 全功能 |

发布顺序：server/Web 与 CLI 无先后依赖（双向兼容）；功能完整需要发 CLI。

## 验收

- 单测：`happy-wire runIntent.test.ts`、`happy-cli utils/runIntent.test.ts`、`claude/claudeRunFacts.test.ts`、
  `claude/runIntentWiring.test.ts`、Web `sync/runPicks.test.ts`、`screens/session/runPicksWiring.test.ts`；源码断言均经 mutation-check。
- 隔离实测（两个浏览器 context）：A 选 Haiku → B 打开显示 Haiku，B 发消息实跑 Haiku；B 改 Opus → A 刷新跟随；
  Claude/Codex 的 effort 在 abort、resume 后显示与实跑一致；Claude「本机配置」显示并实跑 settings 模型。
