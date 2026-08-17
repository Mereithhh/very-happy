# 终端注入 + tool description 同源

> 状态：Draft
> 日期：2026-08-17 ｜ 关联 backlog：B-130 ｜ 出处：Owner 2026-08-17 对话
> 拆分自：原 `2026-08-agent-tool-surface.md`（一份 spec 塞了 4 个特性，按
> `specs/README.md`「一个特性一个文件」拆开；`open_preview` → `2026-08-open-preview.md`）

## 背景

Owner 想让 claude 稳定地「该调工具时就调工具」——用户说复制就走 `copy_to_clipboard`
而不是 `cat` 到终端让人手选，产出文档就主动让 web 端切到预览。但这件事有个前置问题：
**三条 claude 启动路径的注入能力完全不同**，其中「web 终端里手打的裸 claude」是注入
真空区——而它正是 Owner 日常主力用法。

本 spec 只解决「怎么把行为指引送到三条路径」和「指引放在哪」，不新增任何工具。
新工具各自单独立项（B-131 / B-132 / B-133）。

## 目标

1. 三条路径（SDK / local CLI / web 终端裸 claude）拿到同一份 happy 工具面行为指引。
2. tool description 成为主注入面：三处工具注册点的描述文案同源，有测试钉死。
3. 不改任何用户已有的 CLAUDE.md 文件内容。
4. 注入是否生效对用户**可见**，不靠猜。

## 非目标

- 不新增工具（`open_preview` / `report_progress` / `ask_user` 各自立项）。
- 不做「完全替换 system prompt」（local CLI 路径本来就没有这个能力）。
- 不解决覆盖缺口②（见下，无解，只能新开终端）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| SDK 路径：`appendSystemPrompt` 已通；本 fork 特意开了 `settingSources: ['user','project','local']`（否则 agent SDK 默认 isolated，会忽略用户 CLAUDE.md 与 skills） | `packages/happy-cli/src/claude/claudeRemote.ts:130-131`、`src/claude/sdk/query.ts:55` |
| local CLI 路径：argv 唯一构造块，`--append-system-prompt` / `--mcp-config` / `--allowedTools` / `--settings` 齐备 | `packages/happy-cli/src/claude/claudeLocal.ts:233 / :236 / :240 / :250` |
| 全局 system prompt 常量（改这里前两条路径同时生效） | `packages/happy-cli/src/claude/utils/systemPrompt.ts:7` |
| web 终端只起 tmux shell，claude 由用户手打 → happy **无法注入任何 argv** | `packages/happy-cli/src/terminal/webTerminal.ts` |
| daemon 建终端时用 `tmux new-session -e` 注入 `VH_TERMINAL_ID` / `VH_HAPPY_HOME_DIR` | `packages/happy-cli/src/terminal/webTerminal.ts:1648-1652` |
| `ptyEnv()` 是全仓库唯一改 PATH / 加 env 的地方，同时用于 tmux 探测、`new-session`、control client、以及无 tmux 时的 `pty.spawn` | `webTerminal.ts:859-879`（PATH 在 `:864-867`），无 tmux 分支 `:1621-1623` |
| tmux 基础 env **只在 tmux server 首次拉起那次定死**（注释原文 "env doesn't re-stick"） | `webTerminal.ts:1662-1670` |
| SessionStart/SessionEnd hook 已全局装在 `~/.claude/settings.json`，守卫恰好就是「vh web 终端里手打的 claude」：`HAPPY_MANAGED` 未设 且 `VH_TERMINAL_ID` 已设 | `packages/happy-cli/scripts/terminal_mirror_forwarder.cjs:29-31` |
| forwarder 目前**不往 stdout 写任何东西**，纯副作用 POST，全部失败静默 | 同上 `:45-69` |
| hook 安装幂等、按脚本文件名识别自家条目、保留用户其他 hook；但用 `JSON.stringify(...,2)` **整文件重写** | `packages/happy-cli/src/mirror/hookSettings.ts:21-25, 32-52`；`src/commands/installTerminalHooks.ts:64-66` |
| **`install-terminal-hooks` 写的是裸 `node "<abs path>"`，没有存在性守卫、没有 timeout** | `src/commands/installTerminalHooks.ts:24-27` |
| 工具注册点共 **3 处**（http MCP / 裸终端 stdio MCP / codex-gemini-acp 的 stdio bridge） | `src/claude/utils/startHappyServer.ts:40,73`、`src/commands/mcp.ts:34`、`src/codex/happyMcpStdioBridge.ts:68,96` |

外部事实（Claude Code hooks 文档）：SessionStart hook 的 JSON 输出支持
`additionalContext`，在处理 prompt 前注入 session 上下文；hook 输出字符串共享
**10,000 字符**上限；SessionStart **不能阻断** session，超时（默认 600s）只丢弃输出。
⚠️ 字段究竟是顶层 `additionalContext` 还是 `hookSpecificOutput.additionalContext`，
文档两种写法都出现过 —— 实现时**两处都写**（多余键无害）并以真机验证为准（V-069）。

## 设计

### D1. 一份文案，两种机制

唯一事实源：新建 `packages/happy-cli/src/claude/utils/agentGuidance.ts` 导出指引文本。

| 路径 | 机制 |
|---|---|
| SDK / local CLI | 拼进 `BASE_SYSTEM_PROMPT`（`systemPrompt.ts:7`），两条路径自动生效 |
| web 终端裸 claude | 扩展**已装好的** SessionStart hook：`terminal_mirror_forwarder.cjs` 在现有守卫通过后，向 stdout 输出 `{"additionalContext": "<同一份文案>"}` |

**被否方案（`specs/README.md` 要求写清）**

- ❌ **写 `~/.claude/CLAUDE.md` 受管块**：Owner 这台机器的 `~/.claude/CLAUDE.md` 由
  chezmoi 管理且源文件 `dot_claude/CLAUDE.md` **没有** `create_` 前缀，happy 直接写会被
  下次 `chezmoi apply` 冲掉。反观 `~/.claude/settings.json` 在源里是
  `create_settings.json`（只创建、永不覆盖）——这正是现有 hook 能稳定存活的原因。
- ❌ **PATH shim（放一个 `claude` wrapper 追加 flag）**：要为
  `mcp`/`plugin`/`config`/`update`/`doctor` 等无会话子命令做例外分支，漏一个就是
  「用户在 web 终端里跑 `claude mcp add` 莫名报错」。且 shim 出错的表现是 **claude 起不来**；
  hook 出错的表现是**静默降级**（SessionStart 不能阻断 session）。安全边界差一个量级。
- ❌ **环境变量注入**：Claude Code 没有「用 env var 指定额外 system prompt / 额外
  CLAUDE.md / 额外 settings 路径」的口子。`--add-dir` +
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 需要传 flag，回到 shim 问题。

### D2. 覆盖缺口：诚实版

`VH_TERMINAL_ID` 有三个缺口。**关键事实是 tmux 基础 env 只在 server 首次拉起时定死
（`webTerminal.ts:1662-1670`）**，据此逐条判定：

| 缺口 | `ptyEnv()` 里加进程级 `VH_TERMINAL_HOST` 能否覆盖 | 结论 |
|---|---|---|
| ① tmux <3.2（`new-session -e` 不可用） | **部分**——`spawnSync('tmux', ['new-session'…], { env: ptyEnv() })` 带的就是它，**若这次调用恰好引导 tmux server 则生效**，否则不生效 | 尽力覆盖 |
| ② attach 到已存在 session（create-only，"no retro-injection"） | **不能**。该 pane 的 shell 进程环境早已固定，tmux server 也早已启动 | **无解** |
| ③ 无 tmux 回退（`pty.spawn`） | **能**——`pty.spawn(file, args, { env: ptyEnv() })` 直接吃 ptyEnv | 完全覆盖 |

> ⚠️ 这张表是本 spec 第一版写反过的地方：当时把 `VH_TERMINAL_HOST` 说成是缓解「最常见的
> 缺口②」，实际它恰恰覆盖不了②，覆盖的是被判「接受」的①③。缺口②**没有代码层解法**，
> 只能 `tmux kill-server` 或新开终端——这条进风险段，不伪装成已缓解。

`VH_TERMINAL_HOST` 只用于**放宽注入守卫**；mirror 绑定主键仍然只认 `terminalId`
（`mirrorManager.ts` 的 `bindings: Map<terminalId, …>`）——没有 terminalId 的 payload
绝不能进 mirror 流程。

### D3. tool description 是主注入面

description 随 MCP 握手下发，**与谁启动 claude 无关**，是三条路径唯一都吃的注入面，
且天然按需加载。所以行为触发语写在 description 里，`additionalContext` 只写
「什么时候该主动调、什么时候别调」的边界（B-063 已建立的口径），**不复述工具用法**。

三处注册点（见事实表）的描述必须来自同一常量文件（沿用 `src/clipboard/limits.ts` 的
先例），并有一条断言「三处注册的工具描述来自同一常量」的单元测试。

### D4. 顺手修掉 hook 的两个隐患

现状 `install-terminal-hooks` 写的是裸 `node "<abs path>"`。两个问题，本批一并修：

1. **没有存在性守卫**：very-happy-cli 卸载/换安装方式后，每次 SessionStart/SessionEnd
   都报 hook 失败。chezmoi 源里那份手写配置反而是对的
   （`[ -f "…" ] && node "…" || true` + `timeout: 10`）——说明本机是被
   `install-terminal-hooks` 覆盖退化的。
2. **没有 timeout**：SessionStart 默认 600s，一个卡住的 hook 会拖住会话启动。

本 spec 让 hook 承担注入职责后，这两条从「烦人」升级成「会让注入静默失效」，必须修。

### D5. 注入状态要可见

缺口②无解意味着「时灵时不灵」是常态。必须让用户当场看到，而不是靠猜：
web 终端 header（或帮助弹窗 `TmuxHelpModal`）显示本终端是否具备注入能力
——daemon 已经知道每个终端建立时有没有注入 env，直接随 `daemonState.webTerminals[]` 上报。

⚠️ **这一条是 web 改动**，所以本 spec 不是纯 cli（分期表已反映）。

### 分期

| 期 | 内容 | 涉及包 |
|---|---|---|
| P1a | agentGuidance 常量 + 三处 description 同源 + 同源断言测试 | cli |
| P1b | forwarder 输出 `additionalContext`；`VH_TERMINAL_HOST`；hook 守卫+timeout | cli |
| P1c | 终端注入状态指示 | cli（上报）+ web（显示） |

## 兼容矩阵与发布顺序

| 变更 | 旧 web | 旧 CLI/daemon | 旧 server |
|---|---|---|---|
| description 同源（P1a） | 无影响 | 无影响（描述由新 CLI 注册） | 无影响 |
| hook 输出 additionalContext（P1b） | 无影响 | 旧 daemon 不受影响（hook 脚本随 npm 包更新，与 daemon 版本解耦） | 无影响 |
| 注入状态字段（P1c） | 旧 web 忽略 `daemonState.webTerminals[].*` 的新字段（铁律 4：旧端忽略新字段） | 旧 daemon 不上报该字段 → 新 web 必须按「未知」渲染，不能当成「没注入」 | 无影响 |

**发布顺序**：P1a/P1b 纯 CLI，随 CLI 发布即可。P1c 按默认序 web 先于 CLI
（web 先具备「未知」态渲染能力，再让 CLI 上报）。

⚠️ **`--settings` 临时文件路径的限定**：「CLI 升级后不需要重装 hook」只在
**全局 npm 安装**下成立——`terminalMirrorHookCommand()` 写的是
`resolve(projectPath(), …)` 的绝对路径，dev checkout 或换安装方式会指向陈旧路径，
必须重跑 `happy install-terminal-hooks`。

⚠️ **已开着的终端不会重新触发 SessionStart**，升级后要新开终端才生效（发布说明写明）。

## 风险

1. **`additionalContext` 字段位置不确定**（顶层 vs `hookSpecificOutput`）。缓解：两处
   都写 + V-069 真机验证；失败模式是注入不生效，不影响 claude 运行。
2. **hook 新增了「必须成功输出」的职责**。原来纯 fire-and-forget，失败全静默。缓解：
   输出用同步 write 且整体 try/catch，任何异常退化为「不注入」而非崩溃，保持文件头
   "a hook must never break claude" 的纪律。**必须回归测试「POST 失败时仍正确输出
   JSON」「daemon 不在时仍正确输出 JSON」两种组合。**
3. **缺口②无解**：升级前已启动的 tmux server / 已存在的 session 拿不到注入，
   只能 `tmux kill-server` 或新开终端。缓解只有 D5 的可见性 + 发布说明，**不假装修好了**。
4. **放宽守卫会误伤**：`VH_TERMINAL_HOST` 走 tmux 基础 env，用户自己 `tmux attach` 到
   同一 tmux server 下手工建的 session 里跑 claude 也会被注入。**判定为可接受**——那些
   终端确实连得上同一个 daemon、工具也确实可用。若要收紧，用 tmux session 名 `vh-` 前缀
   二次校验。（验收标准已按此口径写，不再要求「非 vh 终端一律无注入」。）
5. **注入文案随 CLI 版本漂移**：用户 CLI 落后时注入的是旧文案。缓解：指引只描述行为
   边界、不点名具体工具；真实工具清单由 MCP 握手决定，claude 看不到不存在的工具。
6. **三处 description 漂移**。缓解：集中常量 + 同源断言测试。
7. **`install-terminal-hooks` 整文件重写 settings.json**，丢用户注释/格式。既有行为，
   本批不改（改了要引入 JSON-with-comments 依赖），但 D4 修守卫时要确保不再退化。

## 验收标准

- [ ] 新开一个 web 终端、手打 `claude`，claude 能复述出 happy 工具面的行为边界。
- [ ] 在**完全独立的 tmux server 或非 tmux 终端**里起 claude，拿不到注入
      （同一 tmux server 下的手工 session 会拿到，见风险 4，不算失败）。
- [ ] 指引文本长度单元测试（≤1,200 字符）通过。
- [ ] 三处 description 同源断言测试通过。
- [ ] 守卫矩阵单元测试：`HAPPY_MANAGED` 设置时不注入；`VH_TERMINAL_ID` 与
      `VH_TERMINAL_HOST` 各自单独存在时都注入；两者皆无时不注入；且**只有**
      `VH_TERMINAL_ID` 存在时才走 mirror 绑定。
- [ ] hook 回归：daemon 不在 / POST 失败两种情况下 stdout 仍输出合法 JSON。
- [ ] hook 命令带存在性守卫与 `timeout`，且 `install-terminal-hooks` 重跑后守卫仍在
      （回归测试断言生成的命令字符串包含守卫）。
- [ ] 新 web + 旧 daemon（不上报注入状态）时，终端 header 显示「未知」而不是「未注入」。
- [ ] 门禁：cli（test + `node dist/index.mjs --version` 运行冒烟）、
      web 三件套（vitest / vite build / tsc 零新增）全绿。

## 留真机验证项

- **V-069**：`additionalContext` 字段位置实测（顶层 vs `hookSpecificOutput`）。
- 升级后「已存在终端无注入 / 新开终端有注入」的实际观感，以及状态指示是否一眼可辨。
