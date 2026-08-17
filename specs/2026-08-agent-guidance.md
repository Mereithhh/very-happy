# Agent 工具面指引注入（happy 托管会话）

> 状态：Draft
> 日期：2026-08-17 ｜ 关联 backlog：B-130 ｜ 出处：Owner 2026-08-17 对话
> 沿革：原名 `2026-08-terminal-injection.md`，一并拆自 `2026-08-agent-tool-surface.md`。
> **2026-08-17 Owner 收范围为「只要 web 起的 session + 聊天会话」**，web 终端里
> 手打的裸 claude 移出范围——本 spec 因此从「三条路径 + hook 机制 + 三个覆盖缺口」
> 缩成「一个常量 + 描述同源」。被删掉的那套设计存档在 git 历史里（本文件上一版）。

## 背景

Owner 想让 claude 稳定地「该调工具时就调工具」：说复制就走 `copy_to_clipboard`
而不是 `cat` 到终端让人手选；产出文档就主动调 `open_preview`（B-131）。

范围内的两条路径（web 起的 session、聊天会话）**都是 happy 自己拉起的 claude**，
注入能力现成——所以这件事的成本几乎只有「写好文案」。

## 目标

1. happy 托管的会话（SDK / local CLI 两种模式）都拿到同一份工具面行为指引。
2. 工具描述文案同源：三处注册点引用同一常量，有断言测试钉死。

## 非目标

- **不覆盖 web 终端里手打的裸 claude**（Owner 2026-08-17 收范围）。happy 碰不到
  它的 argv，要覆盖就得走 SessionStart hook + `additionalContext`，还要处理三个
  `VH_TERMINAL_ID` 覆盖缺口（其中「attach 到已存在 session」无代码层解法）。
  代价与收益不成比例，删掉。
- **不覆盖 terminal-mirror 影子会话**：它在会话列表里长得像普通会话，但里面那个
  claude 是终端里手打的，同上出范围。（写在这里因为它最容易被误当成在范围内。）
- 不新增工具（`open_preview` → B-131；`report_progress` → B-132）。
- 不做「完全替换 system prompt」——local CLI 路径没有这个能力（只有 `--append-…`）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 全局 append system prompt 常量，**改这一个地方两条模式同时生效** | `packages/happy-cli/src/claude/utils/systemPrompt.ts:7`（`BASE_SYSTEM_PROMPT`） |
| SDK 模式：`appendSystemPrompt` 已通；本 fork 特意开了 `settingSources: ['user','project','local']`（否则 agent SDK 默认 isolated，会忽略用户 CLAUDE.md 与 skills） | `src/claude/claudeRemote.ts:130-131`、`src/claude/sdk/query.ts:55` |
| local CLI 模式：argv 唯一构造块，`--append-system-prompt` 现成 | `src/claude/claudeLocal.ts:233` |
| 两种模式由 `loop.ts` 的切换循环决定，用户可在 web 端切——所以**两者都必须覆盖**，不能只做一个 | `src/claude/loop.ts:75-110` |
| 每会话的 http MCP server 现有工具：`change_title` / `copy_to_clipboard` | `src/claude/utils/startHappyServer.ts:40, 73` |
| `allowedTools` 从 `toolNames` 自动派生 `mcp__happy__*`，加工具不用手动加白 | `src/claude/runClaude.ts:891` |
| 工具注册点共 3 处：http MCP（范围内）/ codex-gemini-acp 的 stdio bridge（范围内）/ 裸终端 stdio MCP（范围外，但共用同一常量以免文案漂移） | `startHappyServer.ts:40,73`、`src/codex/happyMcpStdioBridge.ts:68,96`、`src/commands/mcp.ts:34` |
| 已有先例：B-063 建立了「CLAUDE.md 写工具边界声明」的口径 | `docs/backlog.md` B-063 |
| 集中常量的先例（工具名/描述/上限放一处） | `src/clipboard/limits.ts` |

## 设计

### D1. 一个常量

新建 `packages/happy-cli/src/claude/utils/agentGuidance.ts` 导出指引文本，拼进
`BASE_SYSTEM_PROMPT`。SDK 与 local CLI 两种模式自动生效，无需分别接线。

**文案纪律**：只写「什么时候该主动调、什么时候别调」的边界，**不复述工具用法**
——用法归 tool description（D2）。目标 ≤1,200 字符，有长度上限单元测试。

理由：这段文字每个会话无条件进 context；工具用法写两遍等于花两份 token 说一件事，
而且两处会漂移。边界判断是 system prompt 该干的，用法是 description 该干的。

### D2. tool description 是主注入面

description 随 MCP 握手下发、按需加载，是行为触发语最该待的地方：

- `copy_to_clipboard`：「用户说复制/拷给我/copy 时用本工具，不要把内容打印到终端
  让用户手选」。
- `open_preview`（B-131 落地后）：「产出或想让用户看某个文件时调用」。

三处注册点必须引用同一常量（沿用 `clipboard/limits.ts` 先例）+ 一条断言
「三处注册的工具描述来自同一常量」的单元测试。

> ⚠️ 第三处（`commands/mcp.ts`，裸终端）虽然在本 spec 范围外，**仍然纳入同源约束**：
> 它是 Owner 手动注册的那个 MCP，文案漂移了照样是坑，而共用常量成本为零。

### 分期

不分期，一批做完：常量 + 拼接 + 三处 description 同源 + 两条测试。纯 `happy-cli`。

## 兼容矩阵与发布顺序

纯 CLI 单包改动，不动协议、不动 server、不动 web。

| 端 | 影响 |
|---|---|
| 旧 web | 无。system prompt 与 description 都在 CLI 侧生成 |
| 旧 server | 无 |
| 旧 CLI | 无（用户 CLI 落后就是拿不到新文案，不会出错） |

**发布**：随 CLI 正常发布。**已在运行的会话不会重新拼 system prompt**，要新起会话才生效。

## 风险

1. **文案随 CLI 版本漂移**：用户 CLI 落后时注入的是旧文案，可能提到还不存在的工具。
   缓解：指引只描述行为边界、不点名具体工具版本；真实工具清单由 MCP 握手决定，
   claude 看不到不存在的工具。
2. **三处 description 漂移**。缓解：集中常量 + 同源断言测试。
3. **指引挤占 context**：每会话无条件加载。缓解：≤1,200 字符上限 + 测试；用法归
   description 不在这里重复。
4. **过度指令化反而变差**：把「必须调 X」写得太硬，claude 可能在不合适的场合硬调
   （例如用户只是问「这文件里有什么」就弹预览）。缓解：文案写成判断边界而非命令式
   规则；B-131 上线后留一轮真机观察（见留验证项）。

## 验收标准

- [ ] 新起一个聊天会话，claude 能复述出 happy 工具面的行为边界。
- [ ] 在 web 端把会话切到 local CLI 模式后新起一轮，同样能复述（证明两种模式都覆盖）。
- [ ] 指引文本长度单元测试（≤1,200 字符）通过。
- [ ] 三处 description 同源断言测试通过。
- [ ] 门禁：`pnpm -C packages/happy-cli test` + `node packages/happy-cli/dist/index.mjs --version` 运行冒烟。

## 留真机验证项

- 「说复制」是否稳定走 `copy_to_clipboard` 而不再 `cat` 到终端（B-131 上线后连带
  观察 `open_preview` 有没有被滥调——对应风险 4）。
