# Claude 会话的 mode 字段：哪些活切，哪些必须重启 query

> 状态：Shipped（commit `d0785bd9`）
> 日期：2026-09-03 ｜ 关联 backlog：B-292 ｜ 出处：「切换 model 不生效」实报

## 背景

一个 Claude SDK 会话的 mode（model / permissionMode / effort / 系统提示 / 工具表）
分散在三条完全不同的生效通道上，而这件事**过去没有任何单一文档说清**：
`permissionMode` 有活 setter，`model` 有（但没人用），其余只能杀掉 Claude Code
进程重开。结果是同一个「用户在下拉框里选了个东西」的动作，不同字段的成败路径完全
不同，而 UI 对三者一视同仁——于是 model 被静默吞掉一年没人发现，effort 更是**从未
在任何已发布版本上生效过**。

本 spec 是这条链路的契约面。**改 `claudeRemote.ts` / `claudeRemoteLauncher.ts` /
`claudeModeHash.ts` 之前先读它。**

## 目标

- 定义每个 mode 字段的生效通道，以及「凭什么相信它生效了」。
- 记录两个反直觉的坑，它们各自吃掉过一次真实事故。

## 非目标

- 不覆盖 permissionMode 的执法边界与 Web 代批——那是
  `specs/2026-08-permission-mode-source-of-truth.md` 的地盘。
- 不覆盖 codex / gemini / acp 的 mode 语义。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Query 一次性固定 cwd/prompt/tools/effort，此后只能靠控制请求改 | `packages/happy-cli/src/claude/claudeRemote.ts` |
| 重启判定 = mode hash 变了就 park + 重开 query，重放被 park 的消息 | `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` |
| **同一个 hash 也是 MessageQueue2 的合批键** | `packages/happy-cli/src/utils/MessageQueue2.ts` `collectBatch` |
| 每一轮开始 SDK 都重发 `system/init`，`init.model` 永远是当前真实生效的模型 | 实测，见下 |
| Web 的选择器值是纯客户端意图，选完立刻变，不等任何确认 | `packages/happy-web-v2/src/screens/session/AgentInput.tsx` |

## 设计：三条通道

| 字段 | 通道 | 可证伪吗 |
|---|---|---|
| `model` | **活切** `Query.setModel()`，在 turn 边界调用 | ✅ 无效别名 reject；下一轮 `result.modelUsage` 记的是新模型；`system/init` 重发新 model |
| `permissionMode` | **活切** `Query.setPermissionMode()` | ✅ `system/init.permissionMode` 回报 SDK 的实际裁决（settings 可能否决我们） |
| `effort` | **重启**（进 hash） | — 见下面的取舍 |
| `fallbackModel` / `customSystemPrompt` / `appendSystemPrompt` / `allowedTools` / `disallowedTools` / plan↔非 plan | **重启**（进 hash） | 只在 `query()` 创建时读 |

### 为什么 effort 明明有活 setter 却仍然走重启

`Query.applyFlagSettings({ effortLevel })` 确实存在且 resolve。但 2026-09-03 实测
pinned SDK：**它对 `effortLevel: 'nonsense'` 一样 resolve**，而 `system/init` 不带
任何 effort 字段——「已生效」和「被静默忽略」从外部完全无法区分。

取舍：一次 ~700ms 的重启，换一个可证伪的结果。**别因为「SDK 有这个 API」就换过去**；
要换，先证明 SDK 能回报当前真正生效的 effort。

### 坑 1：重启 hash 同时是合批键

把一个字段移出 hash，等于同时声明「这两条消息可以合成同一轮」。`model` 移出去之后，
两条只差 model 的消息会被合批——而 `collectBatch` 原本保留**第一条**的 mode，于是
「带着切换意图的那条消息」所在的那一轮，跑的是用户刚刚离开的模型。

规则：**合批保留最新意图**（`collectBatch` 里每 shift 一条就 `mode = item.mode`）。
同批消息 hash 相同，能差的只有 hash 故意忽略的字段，所以「后来者覆盖」是安全且正确的；
这也和 `rewriteQueuedPermissionMode` 对已排队消息的处理规则一致。

### 坑 2：park 与 adopt 必须是同一个动作

park-and-replay 曾经是「一个 `pending` 变量 + 一个 `modeHash` 变量」，重放路径取走
消息却忘了 adopt 它的 mode → 守卫因 hash 为 null 而失效 → **下一次 mode 变更被吞进
仍绑着旧配置的 query**；同一个 null 还让 Steer 在整个 launch 里恒返回 false，静默降级
成普通排队。两个变量之间没有任何结构性约束，也没有任何单测能碰到那行 wiring。

现在 `LaunchModeGate` 同时持有二者，`takeParked()` 是取回被 park 消息的唯一入口且
**取的同时 adopt**，遗漏不可表达。park 时还必须把附件 stage 进 prompt——重放路径原样
返回 park 时的值，而队列项是那些字节的唯一引用。

## 兼容矩阵与发布顺序

纯 CLI 侧行为，wire 无改动。

| | 旧 CLI | 新 CLI (≥0.2.105) |
|---|---|---|
| 旧 Web | 原样（model 每隔一次被吞、effort 无效） | 修好；`currentModelCode` 被旧 Web 忽略 |
| 新 Web | 副标题不显示（字段缺失即静默） | 副标题显示真实运行模型 |

**wrapper 不随 daemon 热升级（铁律 7/14）**：升级前就开着的会话永远跑旧代码，验收必须
用升级后新开的会话。发布顺序 web → CLI，两侧都不依赖对方。

## 风险

1. `setModel` 被 reject（旧客户端发了已下线的别名）→ 已 catch，转成 completion event
   并保留当前模型，绝不让这一轮挂掉。
2. 带新 model 的 Steer 现在能通过门（model 不在 hash 里了）→ `claudeRemote.steer`
   刻意保留正在跑的模型，让切换落到下一个 turn 边界；否则下一轮会拿新值和新值比，
   `setModel` 永远不被调用。**这行是承重的**，已被单测钉住。

## 验收标准

- [x] 换模型下一条消息必生效，且**连续换两次**都生效（旧版本必吞第二次）
- [x] 换模型不重启 Claude Code 进程（query 只创建一次）
- [x] 无效别名不杀会话，转成用户可见提示
- [x] effort 生效（`meta.effort` 不再被 zod 剥掉）
- [x] 四条承重代码逐条变异测试：改一行必挂一个测试
- [ ] 真机：V-125（**必须用 daemon 升级后新开的会话**）
