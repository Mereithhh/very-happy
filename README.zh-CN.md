<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<div align="center">
  <a href="https://veryhappy.dev/welcome">
    <img src=".github/readme-hero.svg" width="100%" alt="Very Happy——连接每台机器与每个 Agent 的统一指挥面板">
  </a>
</div>

<p align="center">
  <strong>一个面板。每台机器。每个 Agent。让你真正 Very Happy。</strong>
</p>

<p align="center">
  <img alt="开源候选版本" src="https://img.shields.io/badge/open_source-candidate-111820?style=flat-square&labelColor=070a0e&color=2d3b42">
  <img alt="Web 与可安装 PWA" src="https://img.shields.io/badge/client-Web_%2F_PWA-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="Node 20、22 与 24" src="https://img.shields.io/badge/Node-20_%7C_22_%7C_24-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-34e2c4?style=flat-square&labelColor=070a0e&color=238b7b">
  <img alt="Cloud 或自托管部署" src="https://img.shields.io/badge/deploy-Cloud_%2F_self--hosted-788784?style=flat-square&labelColor=070a0e&color=38464d">
</p>

<p align="center">
  <a href="https://veryhappy.dev/welcome"><strong>体验在线工作区</strong></a>
  &nbsp;·&nbsp;
  <a href="#一条命令连接第一台机器">连接机器</a>
  &nbsp;·&nbsp;
  <a href="docs/README.md">阅读文档</a>
  &nbsp;·&nbsp;
  <a href="docs/deployment.md">自托管</a>
</p>

Very Happy 是一个面向你所掌控的计算机与 Agent 的开放式指挥面板。响应式 Web
界面汇集所有已连接机器上的会话，显示哪些任务正在运行、哪些正在等待；你可以为新任务
选择机器和 Agent，并从电脑、手机、平板或已安装的 PWA 打开对应的结构化对话、真实终端、
文件、任务、笔记与通知。

它不是某一家 CLI 的浏览器换皮，也不只是远程 Shell。Very Happy 会保留任务周围的完整
上下文：什么正在运行、Agent 改了什么、工作属于哪台机器、哪些事项需要你决策，以及中断后
如何继续。

```text
构建服务器 ─┐
工作站     ─┼─>  统一 Web / PWA 面板  ─> 选择机器 + Agent
外出笔记本 ─┘      会话 · 状态 · 任务 · 文件 · 终端
```

目前调度是显式的：每次创建会话时，由你选择目标机器和 Agent。与提供商无关的自动路由仍在
路线图中，并非已经交付的功能。

> [!TIP]
> **把 Web/PWA 当作日常工作区。** CLI 只需安装一次，用来配对机器并启动后台 daemon。
> 之后仅在诊断、自动化、恢复或明确需要本地启动时回到 CLI，而不是被迫维护第二套界面。
> daemon 仍然是必需的：Web-first 是交互选择，并不代表纯浏览器架构。

> [!NOTE]
> **选择适合你的部署方式。** Very Happy Cloud 提供最快的多设备接入；自托管则让你掌控
> 运营方、访问策略、存储与备份。敏感环境请先阅读[隐私与安全模型](docs/security.md)。

## 一个工作区，三个职责不同的层次

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>结构化交互</h3>
      无需一直盯着终端界面，也能查看消息、工具调用、Diff、权限、用量与恢复状态。目前
      Claude Code 的结构化集成最深入。
    </td>
    <td width="33%" valign="top">
      <h3>通用 TTY</h3>
      在 tmux 托管的 TTY 中运行普通的 xterm-256color 文本程序。重新连接同一进程、保留并
      搜索回滚记录、浏览文件，并使用针对触屏优化的终端控制；编码 Agent 并非必需。
    </td>
    <td width="33%" valign="top">
      <h3>Web-first</h3>
      默认使用响应式 Web/PWA：在桌面开始工作，用手机查看进展，回来时无需重新拼凑上下文。
      可选的 Claude 专属镜像还能在手动启动的 TUI 与结构化对话之间切换。
    </td>
  </tr>
</table>

```text
Claude Agent SDK ─────────────────> 结构化对话

shell / vim / lazygit / ssh / 文本 TUI ─> tmux TTY ──> Web / PWA
Agent CLI ─────────────────────────────> tmux TTY ──> Web / PWA
                                                   ╰─> 可选 Claude 镜像
```

终端是兼容层。它转发真实 TTY，并不关心另一端是什么品牌、甚至是什么类别的程序。某个工具能在
终端运行，并不意味着它会自动暴露 Claude 风格的结构化事件。持久终端需要 `tmux`；可选的
Claude 镜像需要 tmux 3.2 或更新版本。没有 tmux 时，Web 终端会退回到不持久的直接 Shell。

浏览器终端声明 `TERM=xterm-256color` 并通过 xterm.js 渲染。普通文本 TUI 是兼容目标；
sixel/Kitty 图形及其他终端专属扩展不保证可用。

<a href="https://veryhappy.dev/welcome">
  <img src="docs/screenshots/workspace.png" width="100%" alt="使用脱敏数据展示的 Very Happy 生产界面：会话侧栏、真实运行终端与文件预览">
</a>

<p align="center"><sub>真实产品 UI 契约 · 脱敏数据 · 侧栏 + 终端 + 文件预览</sub></p>

### 从剪贴板直达目标机器

将截图粘贴或把文件直接拖入 Very Happy 浏览器终端。daemon 会在所选机器的
`~/.happy/uploads/terminal/` 下接收文件，随后在光标处插入按该 daemon 默认 Shell
正确引用的路径。你选择的 Cloud 或自托管服务器是这次受限传输所信任的中继；系统不会替你
按下回车。Windows 原生路径插入需要使用当前版本 daemon，以便 Web 客户端区分 cmd 与
PowerShell。

```text
手机 / 电脑剪贴板  ── 所选部署 ──> 目标机器
拖入的文件或截图                   ~/.happy/uploads/terminal/…
                                             │
                                             ╰─> 在光标处插入 Shell 安全引用的路径
```

<a href="https://veryhappy.dev/welcome#proofs">
  <img src="docs/screenshots/file-handoff.png" width="100%" alt="使用真实终端 UI 契约和脱敏本地演示数据展示的 Very Happy 文件交接">
</a>

<p align="center"><sub>粘贴或拖放 · 有边界的机器 RPC · 原子写入目标文件 · 不自动执行</sub></p>

终端文件交接上限为 8 MB，采用有界分块传输，并显示进度或错误。旧 daemon 仍使用此前的小文件
路径；如需传输较大文件，请升级 CLI 并重启 daemon。文件会经所选部署中转到目标机器，请按
环境要求选择 Cloud 或自托管。

## 为什么选择 Very Happy？

| 现实阻力 | Very Happy 如何替你承担 |
|---|---|
| “我的 Agent 和终端散落在好几台机器上。” | 一个账号侧栏与任务看板聚合所有会话和注意力状态；新任务由你指定机器与 Agent。 |
| “结构化对话很好用，但有时我必须操作真实工具。” | 保留 SDK 驱动的 Claude，同时在需要时进入持久、未经改造的 Agent TTY/TUI。 |
| “离开桌面后，工作状态就看不清了。” | 响应式 Web/PWA 让对话、终端、文件、任务、通知与决策始终可达。 |
| “远程控制必须符合我的运维方式。” | 用 Very Happy Cloud 快速开始，或在自己掌控的环境部署同一套开源栈。 |

理念很直接：高层操作更快时就停留在高层，必须接触真实机器时就下潜，并让界面尽可能承担
运行上下文。普通文本 TUI 继续兼容，命令面板保留键盘速度，有边界的文件交接把本地文件送到
指定机器，同时不会自动运行命令。

## 一条命令连接第一台机器

在 macOS 或 Linux 上，Cloud 托管路径可以用一条命令安装 CLI、执行诊断、打开一次性的浏览器
授权流程并启动分离运行的 daemon：

```bash
(
  set -eu
  vh_installer=$(mktemp)
  trap 'rm -f "$vh_installer"' \
    EXIT HUP INT TERM
  curl -fsSL \
    https://veryhappy.dev/install.sh \
    -o "$vh_installer"
  sh "$vh_installer"
)
```

在涉及信任的地方，引导脚本刻意保持朴素。它会：

1. 检查是否存在受支持的 Node.js 运行时；
2. 只解析一次 npm `latest` 标签，验证后安装该精确版本的 `very-happy-cli`；
3. 运行 `very-happy doctor`，且不会有意读取提供商凭据的值（分享前仍应检查全部诊断输出）；
4. 打开正常的短时 Web 授权流程；
5. 运行 `very-happy daemon start`，让机器真正上线。

命令会先把完整脚本下载到随机临时文件，执行后删除。它不会调用 `sudo`、安装 tmux、写入
提供商凭据、启用 Claude hooks，或隐藏“可信中继”警告。线上脚本可能随 Web 发布变化；如需
可审计路径，请下载[纳入版本控制的脚本](packages/happy-web-v2/public/install.sh)，比对后再运行
本地文件。离线、无写入的预览方式是：

```bash
sh ./install.sh --dry-run
```

连接终端型 Agent 不需要 Claude 凭据。若要使用结构化 Claude，请在 daemon 的启动环境中配置
受支持的提供商凭据。如果引导脚本启动 daemon 后才添加凭据，请重新加载环境：

```bash
very-happy daemon stop && very-happy daemon start
```

<details>
<summary><strong>更喜欢完全手动安装？</strong></summary>

```bash
npm install --global very-happy-cli
very-happy doctor
very-happy auth login
very-happy daemon start
```

只批准由你刚刚发起的机器请求。随后打开 [veryhappy.dev](https://veryhappy.dev)，选择已连接
机器并创建第一个会话。

</details>

### 机器要求

| 要求 | 状态 | 原因 |
|---|---:|---|
| Node.js 20.x 中的 20.19+、22.x 中的 22.13+，或 24+，并带 npm | 必需 | 运行 CLI 与 daemon |
| Agent 提供商/运行时 | 取决于 Agent | 结构化 Claude 使用内置 Agent SDK 与提供商凭据；原生终端及其他适配器需要本地命令或网关 |
| `tmux` | 推荐 | 浏览器断开后保持真实 Web 终端继续运行 |
| `tmux` 3.2+ | 可选 Claude 镜像需要 | 提供“终端 → 结构化交接”所需的创建时环境标记 |

第一次使用结构化 Claude 时，请为运行 daemon 的同一操作系统用户与启动环境配置
`ANTHROPIC_API_KEY`，或受支持的 Bedrock、Vertex AI、Foundry 环境。`very-happy doctor`
只报告凭据来源类别。详见[配置说明](docs/configuration.md#claude-credentials-for-structured-sessions)。

默认情况下，提供商凭据留在本机。`very-happy connect` 是单独的显式流程：它会把你选择的
OpenAI、Anthropic 或 Gemini OAuth 凭据保存到所选部署，以供从 Web 启动的集成使用；目前主要
用于 Gemini 路径。

### 自托管的首次连接

先部署中继并启用 HTTPS，然后在启动 daemon 的环境中保留以下三个端点变量：

```bash
export HAPPY_HOME_DIR="$HOME/.very-happy-relay.example.com"
export HAPPY_SERVER_URL=https://relay.example.com
export HAPPY_WEBAPP_URL=https://relay.example.com

npm install --global very-happy-cli
very-happy doctor
very-happy auth login
very-happy daemon start
```

每个中继使用独立的 `HAPPY_HOME_DIR`。Token 与机器 ID 属于签发它们的中继。受支持的公开
自托管路径是仓库中固定版本的 Docker 构建，而不是上游维护的 `happy-server-self-host` npm
包。详见[自托管](docs/deployment.md)。

## 像思考一样快

<p>
  <kbd>⌘ K</kbd> / <kbd>Ctrl K</kbd>
  &nbsp; 命令面板 &nbsp;·&nbsp;
  <kbd>⌘ 1–9</kbd> / <kbd>Ctrl 1–9</kbd>
  &nbsp; 切换可见工作 &nbsp;·&nbsp;
  <kbd>⌘ J</kbd> / <kbd>Ctrl J</kbd>
  &nbsp; 笔记
</p>

生产命令面板可搜索操作、对话与终端。已保存 Prompt 使用 `Command/Ctrl+.`；移动端用户可从
侧栏的“搜索”按钮打开同一命令界面。

Very Happy 保留终端肌肉记忆：在 macOS 上，`Ctrl+K/J/N/R` 仍交给 readline 与真实 TUI。
浏览器保留的新建/关闭快捷键只有在平台把它们交给已安装 PWA 时才有效；普通标签页使用明确的
`Alt+N` 与 `Alt+W` 作为后备。详见[键盘与触控参考](docs/keyboard-shortcuts.md)。

## Agent 支持

| 适配器 | 状态 | 体验 |
|---|---|---|
| Claude Code | 已交付 · 集成最深入 | 内置 Agent SDK 结构化会话；原生 Claude TUI；可选 Claude 专属终端镜像 |
| Codex | 已交付 | 独立 Codex 会话路径与原生终端访问 |
| Gemini | Beta · 已实现 | Agent Client Protocol 后端与预设 |
| OpenCode | Beta · 已实现 | 基于本地 stdio 的 ACP 兼容预设 |
| 自定义 ACP 命令 | Beta · 已实现 | 面向兼容 Agent Client Protocol stdio 端点的通用运行器 |
| OpenClaw | 已交付 | 使用自己的本地网关适配器，而非 ACP |
| Pi / 提供商感知路由 | 路线图 | 候选适配器与跨提供商子任务协作，并非已交付功能 |

Agent Client Protocol 与同样缩写为 ACP 的旧 Agent Communication Protocol 并不相同。
某个 Agent 能在终端中运行，不代表它拥有与 Claude 对等的结构化体验。

## 今天已经交付的能力

- 结构化 Claude 对话：工具调用、Diff、权限、用量、附件与恢复。
- 真实 tmux 浏览器终端：重连、回滚记录、搜索、移动端输入、归档会话、文件访问与自动恢复。
- 机器文件浏览器：丰富预览文本、Markdown、图片与 PDF，并可打开 Agent 输出中的文件链接。
- 剪贴板及拖放文件交接：8 MB 上限、有界分块、上传反馈、插入引用后的路径且不自动执行。
- 任务看板、todo provider 命令、笔记、通知、Web Push 与 HTTPS webhook。
- Claude 驱动的协调器：文本输入、会话感知、在所选机器上调度；配置兼容语音服务后可使用语音输入。
- 免密码邮箱验证码与 Google 登录、可选密码兼容、可配置注册/容量控制、托管公共中继与生产级自托管。
- 移动端友好、可主动安装的 PWA，无需应用商店。

可选的 Claude 终端镜像是显式且可撤销的：

```bash
very-happy install-terminal-hooks
# 之后只移除 Very Happy 写入的条目：
very-happy install-terminal-hooks --remove
```

它会修改 `~/.claude/settings.json`（或 `$CLAUDE_CONFIG_DIR/settings.json`），但不会删除其他
hooks。普通 SDK 驱动的 Claude 会话不需要它。

### MCP 交接：让本地成果出现在你面前

Very Happy 会向托管会话注入一个小型 MCP 能力面，让 Agent 不只是在终端多打印一行：它可以
把文字送到浏览器剪贴板、在 Web 预览中打开生成文件、维护有用的会话标题并上报进度。具体工具
会随运行路径而变化：

| 运行路径 | 今天已交付的 MCP 工具 |
|---|---|
| 基础托管 Claude 会话 | `change_title`、`copy_to_clipboard`、`open_preview`、`report_progress` |
| 托管 Codex / Gemini / ACP 桥接 | `change_title`、`copy_to_clipboard`、`open_preview` |
| Assistant/meta-agent 变体额外能力 | `sessions_list`、`session_read`、`session_send`、`session_spawn`、`session_kill`、`session_archive`、`terminals_list`、`terminal_read`、`terminal_send`、`memory_update`、`journal_append` |
| 用户级普通 `claude`（主动启用后） | 仅 `copy_to_clipboard` |

用以下命令启用范围较窄的普通终端桥接：

```bash
claude mcp add --scope user very-happy-clipboard -- very-happy mcp
```

该注册会作用于同一操作系统用户的所有 Claude 会话，而不只限于 Very Happy 终端中的进程，并且
需要本地 daemon。Assistant 专属能力可以读取和修改会话、终端、记忆与日志；应把这一变体及其
Prompt/工具权限视为高权限机器控制面。这不代表通用 MCP 或提供商路由能力。详见精确的
[集成契约](docs/channels.md)。

## 组合进更大的 Agent 系统

Very Happy 是执行界面，不是封闭的自动化平台。通用 webhook 加上
[`very-happy spawn` 与 `very-happy send`](docs/channels.md)，可以让边界清晰的适配器连接
Issue Tracker、调度器、聊天系统或未来的提供商感知协调器。

适配器必须负责发送者授权、固定工作区策略、去重、限流与最小权限执行。传入消息只是输入，
永远不能自行构成授权。

```text
浏览器 / PWA  ⇄  Cloud 或自托管中继  ⇄  机器 daemon
                                         │
                       ┌─────────────────┼─────────────┐
                       ▼                 ▼             ▼
                  结构化 Agent         真实 TTY      文件 / 任务
```

中继同步工作区状态，并转发 RPC/socket 流量。继承自 Happy 的加密信封仍然提供纵深防御，但
Very Happy 服务器可以恢复账号密钥。传输/存储加密并不代表中继是零知识系统。请阅读
[架构](docs/architecture.md)与[安全说明](docs/security.md)。

## 方向，而不是营销幻觉

路线图将继续加入更多 Agent 适配器、提供商感知的子任务路由、持久项目/任务记忆，以及把“决策”
而非“活动噪音”带给用户的 meta-agent。长期视觉概念是一个多 Agent 虚拟办公室——可能采用
像素艺术——让工作、交接与注意力请求在空间上清晰可见。

这些是路线图概念，并非已经交付的功能。已经交付的是背后的理念：**随处工作、保留上下文，并
减少人脑必须记住的运行状态。**详见[路线图](docs/roadmap.md)。

## 运行、理解、改进

- [文档索引](docs/README.md)
- [快速开始](docs/getting-started.md)
- [自托管](docs/deployment.md)
- [配置](docs/configuration.md)
- [升级与回滚](docs/upgrading.md)
- [故障排查](docs/troubleshooting.md)
- [开发指南](docs/development.md)
- [贡献指南](docs/CONTRIBUTING.md)
- [安全策略](SECURITY.md)

生产前端是 `packages/happy-web-v2`。上游 Expo/Tauri `packages/happy-app` 作为未来可能的桌面
客户端实验种子保留；它目前不在 pnpm workspace、生产环境及受支持的 Very Happy 客户端/安全
范围内。

## 来源与许可证

Very Happy 是 [slopus/happy](https://github.com/slopus/happy) 的友好型深度修改分支，并保留
上游版权与 MIT 条款。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。Claude Code、Codex、
Gemini、OpenCode、OpenClaw 及其他具名 Agent 均是各自所有者的产品或项目；Very Happy 与
它们相互独立，不存在关联关系。
