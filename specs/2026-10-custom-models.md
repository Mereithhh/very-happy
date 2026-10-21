# 按 harness 自定义模型 / Provider（写回 harness 自己的配置文件）

> 状态：Draft
> 日期：2026-10-21 ｜ 关联 backlog：B-688 ｜ 出处：Owner 10-21「veryhappy 应该支持让用户给不同的 harness 设置自定义的 model（baseurl 啥的），并且写回到对应的 harness 配置文件……入口包括 setting 页面，以及模型选择器最下面可以有一个自定义。」

## 背景

用户要接第三方网关（GLM、DeepSeek、公司 llm-hub、自建 OpenAI 兼容端点）时，现在只能 SSH 到机器上手改 `~/.claude/settings.json`、`~/.codex/config.toml`、`~/.pi/agent/models.json`。每种 harness 格式不同、键名易错，改完也不知道是否生效。Very Happy 的 daemon 本来就以用户身份跑在这台机器上，可以替用户读、改这些文件。

要求是**写回 harness 自己的文件**，而不是另建一套 Very Happy 自己的存储：这样在终端直接跑 `claude` / `codex` / `pi` 时也是同一份配置（竞品对照见下，Orca/Claude Desktop 走自有存储的代价是两边不一致）。

## 目标

1. daemon 新增三个机器 RPC：`model-config-read`、`model-config-apply`（`dryRun` 默认为真，即预览）、`model-config-restore`，并通过 machine metadata `modelConfigVersion: 1` 声明能力。
2. 支持 Claude Code、Codex、pi 的自定义 base URL / API key（明文或环境变量引用）/ 默认模型 / 选择器模型；Gemini CLI 支持 gateway base URL、API key 和默认模型（不支持 env 引用，原因见下）。
3. 写文件安全：先读后改、只改我们负责的键、保留用户其他配置（TOML 注释与布局逐字节保留）、写前备份、原子写入、写前 diff 预览、用户确认后才写、可以回滚到备份。
4. 密钥不落服务端、不进日志；Web 只显示脱敏值；审计只记键名。
5. Web：设置页新增「模型与 Provider」（按机器 × harness），模型选择器最下方新增「自定义…」，打开同一个编辑器并预选当前会话的机器和 harness；保存后新模型立刻出现在选择器里。
6. 旧 CLI 没有这组 RPC 时，Web 明确提示「需要升级 CLI」。

## 非目标

- 不做 Very Happy 自己的 provider 存储、不在 spawn 时注入 env（那等于绕过 harness 自己的凭据策略，也和终端里跑的 harness 不一致）。
- 不改项目级配置（`.claude/settings.json`、`.codex/config.toml`）：Codex 会忽略项目级 provider 设置；项目文件常进 git，不应写密钥。
- 不做「测试连接」按钮（后续条目；做法应是 daemon 侧发一个最小请求，key 不离开机器）。
- 不跨机器同步配置；每台机器单独设置、单独填 key。
- 不管理 Claude 的 `availableModels` 白名单本身（只在它存在时把我们加的模型 id 追加进去）、Codex 的 `profiles`/`model_catalog_json`、pi 的 `modelOverrides`/`compat`/`headers`。
- 不热替换正在运行的会话（见 §5）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 机器 RPC 注册在 daemon 的 RpcHandlerManager；未知方法回 `{error:'Method not found'}` | `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts:96-101` |
| RPC params 用机器密钥加密后经 server 转发；daemon 只记录方法名，不记录 params | `packages/happy-web-v2/src/sync/apiSocket.ts:414-454`；`RpcHandlerManager.ts:104-110` |
| server 的 `rpc-call` 只转发，失败日志明确「Never log the raw method or params」 | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:310-330,409` |
| 能力位先例：`worktreeVersion` 写进 machine metadata，Web `machineSupportsWorktrees` 按它显示功能 | `packages/happy-cli/src/daemon/run.ts:2141-2145`；`packages/happy-web-v2/src/utils/worktree.ts:9-16` |
| Web 的 machine metadata schema 是 zod 对象（未声明字段会被剥掉），新字段必须加进去 | `packages/happy-web-v2/src/sync/storageTypes.ts:303-310` |
| 结构化 Claude 会话用 Agent SDK，`settingSources: ['user','project','local']`，即读 `~/.claude/settings.json` | `packages/happy-cli/src/claude/sdk/query.ts:58` |
| Claude 认证预检跑 SDK 自带的 `claude auth status`；本机 2.1.304 实测 settings.json `env.ANTHROPIC_AUTH_TOKEN` 会让它报 `loggedIn:true` | `packages/happy-cli/src/daemon/claudeAuth/claudeAuthProbe.ts:55-77`；实测见验收证据 |
| 预检可按需重跑：`claudeAuthService.probe(reason, withDiagnosis)` | `packages/happy-cli/src/daemon/claudeAuth/claudeAuthService.ts:92` |
| 选择器列表 = 会话 metadata 发布的模型 + 目录补充项（`getCatalogExtras`），没有 metadata 时退回硬编码 | `packages/happy-web-v2/src/components/modelModeOptions.ts:255-271` |
| pi-acp 发布的模型 key 是 `<provider>/<id>`；ACP runner 按 modelId 或 name 匹配所选模型 | `modelModeOptions.ts:222-229`（注释）；`packages/happy-cli/src/agent/acp/runAcp.ts:425-437` |
| CLI 无 TOML 依赖；`dotenv` 已是 devDependency（被 pkgroll inline） | `packages/happy-cli/package.json` |

### §1 各 harness 的真实配置格式（源码 / 官方文档核验）

完整引用（URL、文件行号）在调研记录 `~/code/github/skills/tmp/vh-team-B-688/research-harness-config.md`；这里只列实现依赖的结论。本机版本：Claude Code 2.1.304、codex-cli 0.154.0、pi 1.1.0；gemini 未安装（按 v0.65.0 源码）。

**Claude Code**（只说 Anthropic Messages 协议）
- 文件：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`，用户层；**严格 JSON**（注释/尾逗号报错）。优先级 managed > `--settings` > local > project > user。
- `env` 块的值会注入进程环境并覆盖 shell 同名变量；`ANTHROPIC_*` 不在被忽略之列。
- 凭据：`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`；`ANTHROPIC_API_KEY` → `x-api-key`；顶层 `apiKeyHelper`（shell 命令）的 stdout 同时进两个头，默认缓存 5 分钟。
- 模型：顶层 `model`（新会话默认，`/model` 也写它）；`ANTHROPIC_MODEL` 优先级高于 `model`；`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` 决定别名解析；`ANTHROPIC_SMALL_FAST_MODEL` 已弃用。
- 选择器：`modelPicker.options[]`（v2.1.242+，只认 user/managed 层）可加任意多条；`availableModels` 是白名单，存在时自定义 id 必须列入。
- 生效：交互会话会热加载 `env`，但 **`-p` 模式与 Agent SDK 只在启动时读**（Very Happy 的 wrapper 属于后者）。

**Codex**（当前只说 OpenAI Responses 协议）
- 文件：`${CODEX_HOME:-~/.codex}/config.toml`；项目级 `.codex/config.toml` 会**忽略** `model_provider`/`model_providers`。
- 顶层 `model`、`model_provider = "<id>"`；`[model_providers.<id>]`：`name`（必填）、`base_url`、`env_key`（**环境变量名**）、`experimental_bearer_token`（明文 key，官方不推荐但可用）、`auth = {command,…}`、`http_headers`、`query_params`、`requires_openai_auth`。
- `wire_api` 只接受 `"responses"`，`"chat"` 在 0.154/0.163 直接报错。保留 id：`openai`、`ollama`、`lmstudio`、`amazon-bedrock(-runtime)`。
- 用 `env_key` 的自定义 provider 不拉 `/models`；`model = "<任意 id>"` 照样能跑（实测会提示 fallback metadata）。

**Gemini CLI**（只说 Gemini generateContent 协议，OpenAI/Anthropic 兼容端点不可用）
- 文件：`${GEMINI_CLI_HOME:-~}/.gemini/settings.json`（允许注释，字符串支持 `$VAR`），`model.name` 是默认模型。
- settings.json **没有** apiKey 字段：key 只能来自 `GEMINI_API_KEY` 环境变量或 .env；网关用 `GOOGLE_GEMINI_BASE_URL`（https，localhost 例外），设置后自动选 `gateway` 认证类型。
- .env 查找：从 cwd 向上逐级找 `.gemini/.env`、`.env`，最后才回退 `~/.gemini/.env`，**只取第一个**。所以写 `~/.gemini/.env` 会被项目里的 .env 遮住。.env 不做 `${VAR}` 展开，因此不提供 env 引用模式。

**pi**
- 文件：`${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` 与 `settings.json`，仅用户级；models.json 允许注释。
- `providers.<id>`：`baseUrl`、`api`（`openai-completions` | `openai-responses` | `anthropic-messages` | …）、`apiKey`、`headers`、`models[]`（`id` 必填，另有 `name`/`contextWindow`/`maxTokens`/…）；`settings.json` 的 `defaultProvider`/`defaultModel`/`enabledModels`。
- `apiKey`：`$NAME`/`${NAME}` 读环境变量，`!cmd` 执行命令，其余按字面量（0.77 起裸名不再当变量名）。key 解析不出来的 provider 的模型不会出现在 `/model` 里；`/model` 每次打开都会重读 models.json。
- `models[].contextWindow` 不写时 pi 按 **128000**（`provider-composer.js`），并据此算上下文占用与自动压缩阈值。B-727 起表单每行可写 `id 窗口`（`glm-5.3 200k`），patch 字段 `contextWindows`，view 字段 `current.contextWindows`；见 `specs/2026-10-pi-context-usage.md`。

### 竞品对照

| 产品 | 入口 | 存在哪 | 写 harness 原文件？ | key 处理 |
|---|---|---|---|---|
| Codex（App/IDE/CLI） | 设置面板只管常用项；provider 要「Open config.toml」手改 | `~/.codex/config.toml` | 是（三端共用一份） | 只写 `env_key` 变量名 |
| Claude Desktop 3P | Developer → Configure Third-Party Inference（校验 + Test connection，Save & Restart） | 本机 `configLibrary/*.json`，MDM 时只读 | 否（自有存储；Code tab 还会覆盖 `ANTHROPIC_BASE_URL`） | 明文或 credential helper |
| Orca | 每个 agent 的启动命令/参数/env，在 workspace 所在主机上编辑 | Orca 自有设置 | 否（启动时注入，推断） | 只留本机；预设「不含 secrets」 |
| Cursor | Settings → Models：粘贴 key、全局 Override OpenAI Base URL | 本地，但每次请求经 Cursor 云端 | 不适用 | 输入框只写不读，显示「Secret saved」；不支持 per-model base URL |
| opencode / Zed / Crush | 配置文件；opencode `/connect` | 配置与 `auth.json`/keychain 分离 | 是（自身就是 harness） | `{env:VAR}` / `$VAR` 引用 |

据此的取舍：**写原文件**（同 Codex，终端与 Web 一致）；**key 只回脱敏值**（同 Cursor 的 write-only）；**优先 env 引用**（同 Codex `env_key`/opencode）；**生效时机说清楚**（Claude Desktop 的 Save & Restart）；**per-harness/per-provider 隔离**（避开 Cursor 全局 override 弄坏内置模型的坑）。

## 设计

### §2 作用范围：每台机器 × 每种 harness

- 配置文件在机器上，作用域就是「这台机器上 daemon 用户的 home × harness」。路径解析与 harness 一致：尊重 daemon 环境里的 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`PI_CODING_AGENT_DIR`。
- 设置页：顶部机器选择器（只列在线机器；离线机器显示但不可编辑）；默认选「最近使用会话的机器」，否则第一台在线机器。每台机器下按 harness 分组卡片，显示当前生效值（脱敏）与文件路径。
- 模型选择器「自定义…」：预选**当前会话所在机器**与**当前会话的 harness**（claude/codex/gemini/pi）。
- 机器不支持（metadata 无 `modelConfigVersion`）→ 卡片显示「此机器的 CLI 版本不支持，需要升级 CLI」并给出升级命令入口（复用机器页的升级按钮）。

### §3 安全

1. **传输**：key 只在 `model-config-apply` 的 params 里出现一次。params 用机器密钥加密（`machineEncryption.encryptRaw`），server 只按 room 转发、不解析、不记录 params（`rpcHandler.ts`）。server 不新增任何存储；不落盘的证据：本次改动 server 包零 diff，e2e 后在 standalone 的 DB/日志里 grep key 为 0 命中。
   > 信任边界照实写：Very Happy 是「服务端可信」而非端到端加密，relay 运营方理论上能恢复账户密钥（`packages/happy-cli/CLAUDE.md` Security boundary）。本设计保证的是**服务端不持久化、不记录**，不声称 relay 看不到。
2. **daemon**：RpcHandlerManager 只记方法名；错误信息从不插值配置值；`model-config-read` 只返回 `SecretView`（`mode` + `masked`/`envName`/`envPresent`），**任何路径都不回传明文**。
3. **脱敏规则**（`secrets.ts`）：按键名结构化判断（`api_key|apikey|token|secret|password|authorization|bearer|credential|cookie|private_key`，不区分大小写），任意深度的值都脱敏，所以用户自己写在 `env` 里的 `OPENAI_API_KEY`、Codex `http_headers.Authorization` 也会被遮住。≥16 字符显示前 4 后 4（`sk-a…9f3c`），否则 `••••`。diff 预览用旧文件、新文件、patch 里的全部 secret 做替换后再返回。
4. **环境变量引用**（推荐路径）：
   - Codex → `env_key = "NAME"`（原生）。
   - pi → `apiKey = "${NAME}"`（原生）。
   - Claude → `apiKeyHelper = "printf %s \"$NAME\""`（官方机制，stdout 进两种认证头）；NAME 校验为 `^[A-Za-z_][A-Za-z0-9_]*$`，不可能注入 shell。读取时按同一模式识别为「env 引用」，别的 helper 显示为「自定义命令（已隐藏）」并原样保留。
   - Gemini → 不支持（.env 不展开变量）；UI 提示「改在 daemon 环境里设置 GEMINI_API_KEY」。
   - 读取时报告 `envPresent`：daemon 进程环境里是否有这个变量（会话继承 daemon 环境）。没有就警告「会话拿不到 key」。只报存在与否，不报值。
5. **审计**：`$HAPPY_HOME_DIR/model-config-audit.jsonl`（0600）每次写一行 `{at, action, harness, files, keys, apiKeyMode, backupId}`——只有键名与 key 的模式，单测断言不含密钥。
6. **拒绝会变成命令执行的输入**：pi 的明文 key 以 `$`/`!` 开头会被 pi 当作变量/命令，直接拒绝；模型 id、provider id、URL（http/https、禁止内嵌账号密码）、key（单行、无空白）全部白名单校验。

### §4 安全写文件

- **先读后改，只改我们负责的键**（各适配器文件头写明清单）：
  - Claude：`env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY`、`env.ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、`model`、`modelPicker.options`、我们自己格式的 `apiKeyHelper`、向已存在的 `availableModels` 追加。
  - Codex：顶层 `model`、`model_provider`；`[model_providers.<id>]` 内的 `name`/`base_url`/`wire_api`/`env_key`/`experimental_bearer_token`。
  - Gemini：`settings.json` 的 `model.name`；`.env` 的 `GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY`。
  - pi：`providers.<id>.{baseUrl, api, apiKey, models}`（已存在模型对象的其他字段保留）、`settings.json` 的 `defaultProvider`/`defaultModel`。
- **TOML**：没有能保留注释的 JS TOML 库，所以按行编辑（跟踪多行字符串与括号深度，避免把数组里的 `[x]` 当表头），然后用 smol-toml 证明结果：新文档必须能解析、目标键取到目标值、**除我们的键外与旧文档语义完全相等**。证明失败（例如用户用 dotted key `model_providers.x.name = …` 定义了同一张表）就拒绝写，绝不半写。替换标量时保留行尾注释，CRLF 保留。
- **JSON**：Claude/pi 是严格 JSON，parse → 改 → stringify，键顺序保留，缩进/行尾/末尾换行按原文件；单行压缩文件保持单行。**带注释的文件（pi、Gemini 允许）拒绝改写**并提示手改，因为改写必然丢注释。
- **.env**：按行改，保留注释与其他变量，结果用 dotenv 重新解析验证。
- **备份**：每次真正写之前，把将被改动的每个文件（含「原本不存在」这一事实）存到 `$HAPPY_HOME_DIR/model-config-backups/<harness>/<id>/`（目录 0700、文件 0600），每个 harness 保留最近 20 份。备份不放在 `~/.claude` 旁边，避免被 harness 或 dotfile 管理器读到。
- **原子写**：同目录临时文件（O_EXCL，权限沿用原文件，新文件 0600）→ fsync → rename → fsync 目录。目标是符号链接时写穿到链接目标、保留链接（chezmoi/dotfiles 用户）。失败时删除临时文件，原文件不动。
- **并发与预览一致性**：预览返回 `baseHash`（所有相关文件内容的 sha256）。真正 apply 时 daemon 重新读文件、重新计算计划；hash 不一致（用户在终端里改过）就回 `conflict`，要求重新预览。写操作在 daemon 内串行。
- **预览 → 确认 → 写**：`model-config-apply` 默认 `dryRun`，只有显式 `dryRun:false` 且带 `baseHash` 才写。Web 编辑器流程固定为「预览改动」→ 展示脱敏 diff → 「确认写入」。
- **回滚**：`model-config-restore` 同样先预览（diff）再写；回滚前也会给当前文件做一份备份（`before-restore`），所以回滚本身可撤销。备份里「原本不存在」的文件，回滚时删除。备份只能恢复到该 harness 当前解析出的配置路径。

### §5 生效方式

- **只对新建会话生效**：Agent SDK 与 `-p` 模式只在启动时读 settings `env`；Codex 在线程启动时确定 provider；pi-acp 在会话启动时加载模型注册表。编辑器保存后提示「已写入。新会话会使用新配置；正在运行的会话需要重启才会切换」。从会话里打开时附「重启此会话」按钮（复用已有的 restart-session 能力），不自动重启。
- **与 Claude 认证预检（关键约束 16）**：写的是用户自己的 `~/.claude/settings.json`，与在终端里手改完全等价，Claude Code 自己的凭据解析照常生效——不是「绕过凭据策略注入 token」。Claude 配置写入后 daemon 立即重跑一次预检（`probe('model-config')`），`daemonState.claudeAuth` 随之更新；实测 settings `env.ANTHROPIC_AUTH_TOKEN` 下 `claude auth status` 报 `loggedIn:true, authMethod:oauth_token`，因此预检结论与实际会话一致。只设 base URL 不设 key 时 Claude Code 会继续用 claude.ai 登录计费，编辑器对此给出提示。
- **与模型选择器**：`model-config-read` 的每个 harness 带 `pickerModels`：
  - Claude：`model` + 三个别名映射 + `modelPicker.options[].model`；
  - Codex：`model`；
  - Gemini：`model.name`；
  - pi：所有 provider 的 `<provider>/<id>`（与 pi-acp 发布的 key 同形）。
  Web 按机器缓存读取结果（内存 store），选择器在会话 metadata 列表之外追加这些 key（去重）。会话发布了自己的 metadata 模型列表时，自定义项追加在末尾；选中后作为 `modelMode` 发给 wrapper（Claude `--model`、Codex `model`、ACP `setSessionModel`），对已在跑的会话立即生效，因为这只是选模型、不涉及 provider 变化。保存成功后 store 用返回的新视图更新，选择器立即出现新模型。

### Web 交互

- 设置 → 「模型与 Provider」（`/settings/models`，新文件 `ModelProviderSettings.tsx`；SettingsRoutes 只加一行路由与一项入口，遵守热区约定）。
- 编辑器 `ModelConfigEditor`（对话框）：机器选择 → harness 分段（Claude Code / Codex / Gemini / pi）→ 表单 → 「预览改动」→ diff + 警告 → 「确认写入」；底部「备份」列表，每条「预览回滚」→「确认回滚」。
  - API key：三选一「保持不变 / 直接填写 / 引用环境变量」+「清除」；已有值只显示脱敏串；输入框 `type=password`、`autocomplete=off`，提交后立即清空本地 state。
  - Codex/pi：provider 下拉（已有 provider + 新建），「设为当前 provider」开关。
- 选择器：`ModelEffortMenu` 底部「自定义…」按钮（仅当会话机器支持 `modelConfigVersion` 时显示；不支持时显示但点开提示升级）。

## 兼容矩阵与发布顺序

| Web \ CLI | 旧 CLI（无 RPC、无 `modelConfigVersion`） | 新 CLI |
|---|---|---|
| 旧 Web | 无变化 | daemon 多发一个 metadata 字段，旧 Web 的 zod schema 剥掉它；无 RPC 调用 |
| 新 Web | 设置页卡片与选择器「自定义…」显示「需要升级 CLI」；若 metadata 判断失误，RPC 回 `Method not found` 也映射成同一提示 | 全功能 |

- server：**零改动**（RPC 是 opaque 转发，metadata 是加密 blob），不涉及 migration。
- 发布顺序：server/Web 与 CLI 互不依赖，按默认「server/Web → CLI」。CLI 需发一个新 patch 版本（包含 `smol-toml` devDependency，pkgroll inline）；发布后各机器按 B-503 自动升级到 promote 后的 `latest`。回滚：Web 回滚只是隐藏入口；CLI 回滚到旧版后 Web 自动退回「需要升级」提示，已写入的 harness 配置不受影响（它们是用户文件），可用备份目录手工恢复。

## 风险

1. **改坏用户配置**：只改白名单键 + 语义等价证明 + 带注释文件拒写 + 备份 + 原子写 + 冲突检测；最坏情况可回滚。
2. **Claude 只设 base URL 不设 key 时仍走 claude.ai 计费**：编辑器警告。
3. **`ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 同时存在**（daemon 环境 + settings）：读取时警告 `daemon-env-credential`。
4. **Gemini 的 `~/.gemini/.env` 被项目 .env 遮住**：始终显示警告；Gemini 本机未安装，未实测（见留验证项）。
5. **Codex 自定义模型无 metadata**：Codex 会提示 fallback metadata，能跑但上下文窗口按默认值；接受，后续可写 `model_catalog_json`（整表替换，风险大，非目标）。
6. **relay 理论可见 params**：按服务端可信模型接受，并在文档中照实说明；推荐 env 引用让 key 根本不经过网络。

## 验收标准

- [ ] spec 回答 6 个问题（本文 §1–§5 + 兼容矩阵）。
- [ ] CLI 单测：合并保留、备份、原子写（含写失败无残留、符号链接写穿）、冲突、非法输入、审计无密钥、预览无密钥。
- [ ] 临时 HOME 端到端：standalone server + 隔离 `HAPPY_HOME_DIR` daemon，经 Web/RPC 写配置后新建会话，mock 端点收到请求（Claude Code、Codex；pi 尽量）。
- [ ] 设置页与选择器「自定义…」桌面 + 手机截图。
- [ ] 密钥不落服务端证据：standalone DB/日志 grep 无命中；server 包零 diff。

## 留真机验证项

- Gemini CLI 的 gateway 实际连通（本机未安装 gemini，且其协议无法用 OpenAI/Anthropic mock 验证）。
- mac-office（launchd）上 `CLAUDE_CONFIG_DIR` 未设时的路径解析与 Keychain 凭据并存时的预检表现。
