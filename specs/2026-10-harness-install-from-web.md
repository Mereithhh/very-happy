# 从 Web 安装或更新缺失的 coding-agent CLI（B-719）

状态：Final · 关联 backlog：B-719

## 现状事实（10-21 核实）

| # | 事实 | 证据 |
|---|---|---|
| ① | 结构化 Claude 会话不需要单独安装：Agent SDK 自带 Claude Code 二进制，实测子进程就是 `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` | B-717 实测；`utils/agentAvailability.ts` 把 claude 标为 bundled |
| ② | 各 harness 需要的命令：codex 要 `codex`（@openai/codex）；gemini 要 `gemini`（@google/gemini-cli）；pi 要 `pi` 和 `pi-acp` 两个（@earendil-works/pi-coding-agent，加上 pi-acp@0.0.33）；原生终端 Claude 要 `claude`（@anthropic-ai/claude-code） | `utils/detectCLI.ts`、`agentAvailability.ts` |
| ③ | 改动前的体验：缺失的 agent 在选择器里置灰并标「not installed」，点开只给出一条复制命令，要到机器上手动执行，最多等 5 分钟才会被识别 | 截图 `b719-e2e/evidence/00-before-main-pi-missing.png` |
| ④ | 机器页的「Coding agent versions」只列出已安装的 agent，缺失的不显示，也没有任何操作入口 | `AgentVersionsGroup.tsx` 过滤掉了 `not-installed` |
| ⑤ | pi 的版本源还是 `@mariozechner/pi-coding-agent`，这个包在 0.73.1 已经 deprecated，所以任何新版 pi 都被判成「暂无更新」（主力mac 0.84.4、dev-sg 1.1.0 都是这样） | `npm view`；wire `AGENT_VERSION_SOURCES` |

## 设计

**检测**：沿用现有的 `cliAvailability`（metadata，每 5 分钟检测一次）和 `agentVersions`（daemonState，每 6 小时一次）。
- 修正 pi 的版本源。
- 安装成功后**立即**重新检测，并刷新版本，Web 不用刷新就会把 agent 变成可用。

**入口**（只在 daemon 声明了 `harnessInstallVersion: 1` 并且在线时显示）：
- 离线的机器上，按钮置灰并说明「机器离线，上线后才能安装」。
- 新建会话选择器：点置灰的 agent，出现「在这台机器上安装 X」主按钮，下面保留手动命令。outdated 的 agent 在 chip 上标「可更新」。
- 机器页 Coding agent versions：缺失的可安装 agent 显示「未安装」加「安装」；有新版的显示「更新」。进度和失败原因都写在这一行里，不只弹 toast。

**安装**（daemon 端，`harness/installCatalog.ts` 和 `harness/harnessInstaller.ts`）：
- RPC `harness-install {harness}`。harness 必须属于 `HARNESS_INSTALL_IDS = claude | codex | gemini | pi`（wire 枚举），其他值一律拒绝（`unknown_harness`）。包名、版本、参数、命令**都不经过网络传输**。
- 白名单写死在 CLI 里：codex / gemini / claude-code 装 `@latest`；pi 装 `@earendil-works/pi-coding-agent@latest` 和 `pi-acp@0.0.33`（runner 验证过的版本）。
- `npm i -g --prefix=<CLI 自身的 prefix> --no-fund --no-audit <pkgs>`，经 `runNpmProcess` 执行，不经过 shell，每个参数都要再过一遍 `NPM_SAFE_ARG`。prefix 规则和 B-489 的 CLI 自更新一样：取正在运行的包所在的全局 prefix，并且要求当前用户可写。不可写时返回 `install_location_not_writable`，不认识的布局返回 `install_location_unverified`，**不用 sudo，也不换别的目录**。
- 同一时间只装一个；CLI 自更新或交接 preflight 进行中时拒绝（`cli_update_in_progress`）。反过来，CLI 自更新和交接的两道闸门也会等这次安装结束（两者都写同一个 npm 树）。
  - 安装占位（`running`）在第一个 await **之前**就占上，检查和执行之间不会被自更新插进来。
  - npm 超时且无法确认已被杀掉（`terminationConfirmed === false`）时，沿用 updateController 的 blocked 语义：一直占用，直到 daemon 重启；之后的安装返回 `installer_blocked`，CLI 自更新也会一直等。
- 安装前先检查 daemon 的 Node 版本是否满足各包 `engines`：pi ≥22.19，claude-code ≥22，gemini 和 pi-acp ≥20，codex ≥16。不满足时返回 `node_too_old {required,current}`，不会装成「已安装但跑不起来」。
- codex、gemini、pi、pi-acp 用 `--ignore-scripts` 安装（实测四个都能正常运行），安装过程中不执行任何来自 registry 的脚本。claude-code 依赖 postinstall 放置原生二进制，所以不加这个参数。
- 子进程环境**不**裁剪：npm 需要用户自己的 npmrc、代理和私有 registry 配置，这一点和 CLI 自更新相同。参数、命令和包名都由 CLI 决定，环境变量里没有来自 Web 的内容。
- RPC 立即返回（relay RPC 上限 30 秒）；进度写到 `daemonState.harnessInstall {harness,state,detail,startedAt,at}`。npm 报错只保留最后几行，并去掉 token 和 home 路径。安装后要确认这些命令在 daemon 的 PATH 上，否则报 `not_on_path`，不会假装成功。
- 每次请求、拒绝和结果都写 daemon 日志（`[HARNESS]`）。

**不静默安装**：只有 Web 上的点击会触发。没有自动安装，也不会在新建会话时顺手安装。

## 兼容矩阵

| Web \ daemon | 旧 daemon（没有 `harnessInstallVersion`） | 新 daemon |
|---|---|---|
| 旧 Web | 不变 | 不变（新字段被忽略） |
| 新 Web | 不显示「安装」，保留复制命令 | 显示「安装 / 更新」 |

server 只做 RPC 中继，不需要改。发布顺序随意；这个功能要等 CLI 发版后才可用。

## 验收
- 单测：catalog（固定 argv、拒绝能夹带参数的 prefix）；installer（成功路径、拒绝包名 / 命令 / 枚举外的值、不可写或无法确认的 prefix、并发与自更新互斥、npm 失败脱敏、`not_on_path`、超时）；wire 枚举；Web `harnessInstall`（只发 id、错误映射、进度和过期）。
- 实测（临时 HOME 加隔离 PATH，不碰真实机器上已装的 harness）：缺 pi → 选择器点「Install pi on this machine」→ 41 秒装好 → pi 自动变为可用 → 新建 pi 会话回复 `PI-OK`。另外把 prefix/bin 设成只读后点 Codex 的「安装」，被拒并在行内说明原因。证据在 `~/code/github/skills/tmp/vh-team-B-717-719/b719-e2e/`。
