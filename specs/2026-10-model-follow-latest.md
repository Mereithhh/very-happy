# 默认模型「跟随同档最新」

> 状态：Final（随 B-844 PR 实现）
> 日期：2026-10-30 ｜ 关联 backlog：B-844 ｜ 前身：B-487（模型能力提示条）、B-492（spawn 与网页同默认）

## 背景

Owner 10-30：「我们默认的模型选择器，能始终保持最新吗」。默认模型写死在
`happy-wire/src/agentCodeDefaults.ts`：Claude `claude-opus-5-5`、Codex `gpt-5.5`、Gemini
`gemini-2.5-pro`，后两者已落后；无会话时的列表是 09-23 的硬编码；会话里选一次模型就写进账号
override，从此新会话永远停在那个 id。

## 目标

1. claude / codex / gemini 的代码默认改为 sentinel `latest`，发送时按「同档最新 + 机器能力」解析成具体 id。
2. 「最新」只在一处维护（`happy-wire/src/latestModels.json`），server 下发、运营可不发版替换。
3. 无会话的列表（新建会话页、设置 → 智能体）合并最近会话上报的实时 catalog。
4. 会话内选中当前最新 = 跟随最新，不钉 id；设置页区分「跟随最新（当前：X）」与「固定为 X」。
5. 防过时：bundled Claude SDK / npm latest Codex 出现更新的同档模型时报警。

## 非目标

- 不跨档自动升级（Opus 不会自动变 Fable/Haiku；sol 不会变 astra/terra）。
- 不改 pi / openclaw（它们的默认仍是 `default` = 机器默认）。
- Claude 提示条的文案仍是 Opus 5.5 专用（下一代 Opus 上线时需同步泛化，见风险 4）。

## 现状事实（代码已确认，main ba5db33d）

| 事实 | 位置 |
|---|---|
| 代码默认被 web 与 spawn 共用 | `packages/happy-wire/src/agentCodeDefaults.ts`、`packages/happy-cli/src/commands/spawnDefaults.ts` |
| 非 Claude 只发 override，web 侧代码默认从不发送 | `packages/happy-web-v2/src/sync/messageMeta.ts` |
| 但 Codex wrapper 自己写死 `DEFAULT_CODEX_MODEL = 'gpt-5.5'`（05-22 upstream 移植），没收到 model 时就发 gpt-5.5，**覆盖了 config.toml 的 model**（实测：config 钉 gpt-5.6-sol，rollout 跑 gpt-5.5） | `packages/happy-cli/src/codex/runCodex.ts:76` |
| 会话内选模型写 account override | `AgentInput.tsx` `setMode` → `setAgentDefaultOverride` |
| Codex wrapper 上报 `model/list` 为 `metadata.models` + `defaultModelCode` | `packages/happy-cli/src/codex/runCodex.ts:889` |
| Claude wrapper 上报 SDK `supportedModels()`（alias + `resolvedModel`） | `packages/happy-cli/src/claude/claudeRemote.ts:238` |
| Opus 5.5 需要 capability `claude-opus-5-5-v1`（CLI ≥ 0.2.149） | `agentCodeDefaults.ts`、`app/modelSupportPolicy.ts` |

## 「同档」规则与证据（2026-10-30 实测）

| agent | 档 | 规则（`pattern` 捕获版本号，取最大） | 今天解析结果 |
|---|---|---|---|
| Claude | opus | `^claude-opus-(\d+)(?:-(\d{1,2}))?$` | `claude-opus-5-5`（SDK 0.3.306 / CC 2.1.306 不认识更新的 Opus） |
| Codex | sol | `^gpt-(\d+)(?:\.(\d+))?-sol$` | Codex ≥ 0.160 → `gpt-6.1-sol`；0.157–0.159 → `gpt-6-sol`；更旧 → `gpt-5.6-sol` |
| Gemini | pro | `^gemini-(\d+)(?:\.(\d+))?-pro(?:-preview)?$` | 会话 catalog 里最新的 pro（今天 `gemini-3.1-pro-preview`） |

Codex 旗舰档 = sol：Codex 0.160+ `model/list` 的 `isDefault` 就是 `gpt-6.1-sol`。bundled catalog
二分（空 CODEX_HOME 探 `model/list`）：0.154–0.156 无 gpt-6-sol，0.157 起有 gpt-6-sol，0.160 起有
gpt-6.1-sol。`codex exec -m` 在 0.166.0 + llm-hub 上实跑 gpt-6.1-sol / gpt-6-sol / gpt-6-astra /
gpt-5.6-sol 均返回 OK。

## 设计

### 解析（`happy-wire/src/modelLatest.ts` `resolveLatestModel`）

候选 = 档内 catalog 条目（wrapper 自己列出的，即能跑）∪ 表里「被证明可跑」的条目，取版本最大者；
无候选 → `null` = 机器默认（Claude 发 `model: null`，Codex/Gemini 不发 model）。证明方式按上下文：

- `session`（有会话）：只认 capability 与会话 catalog（AGENTS 约束 14：能力不看版本）。
- `machine`（新建会话页，尚无会话）：机器 CLI / Codex 版本 + 该机器最近会话的 catalog；只决定标签，
  真正发送时会话已存在，按 `session` 再解析一次。
- `none`（尚无机器可解析）：表头 ∪ catalog；只用于新建会话页没有机器时的标签。设置页不用它（B-844b，见「显示」）。

sentinel 永不上线：web `resolveMessageModeMeta`、`resolveDefaultModelMode`、spawn
`resolveFirstMessageMeta` 都保证输出具体 id / null。

### 机器配置优先（Codex / Gemini，B-844 review）

跟随最新时，本机 agent 配置里**明确指定的模型优先**；只有在 Very Happy 里明确选了模型（会话内或设置里固定）才覆盖。

- wrapper 上报 `metadata.configuredModel`：字符串 = 本机配置钉的模型；`null` = 没钉；字段不存在 = 旧 wrapper，不知道。
  - Codex：app-server `config/read`（0.154 与 0.166 实测都有；返回的是生效配置，含 profile / CLI override），同时 `defaultModelCode` 改为该模型，让「默认」项如实显示。
  - Gemini：`GEMINI_MODEL` 环境变量 → 工作区 `.gemini/settings.json` → `~/.gemini/settings.json`（`model` 为字符串或 `{ name }`）。
- 解析（`MACHINE_CONFIG_AGENTS = codex, gemini`）：会话上报了钉的模型，或者没上报（旧 wrapper）→ 不发 model，由本机配置决定；上报 `null` → 发同档最新。
- **Claude 也遵守本机配置（B-883）**：`CONFIG_PIN_AGENTS = codex, gemini, claude`。Claude 上报了钉的模型 → 不发 model（`model: null`），Claude Code 按本机配置跑；上报 `null` 或没上报（旧 wrapper）→ 照旧发同档最新（Claude 的默认一直显式发送，没上报不等于钉了）。
  - 来源与优先级（Claude Code 2.1.306 `get_settings` 实测，tmp/vh-team-B-883/probe）：settings `env.ANTHROPIC_MODEL` > 进程 `ANTHROPIC_MODEL` > settings `model`；settings 按 user < project < local 合并。`get_settings` 的 `effective.model` 不含进程 env，所以 wrapper 另读 `ANTHROPIC_MODEL`。
  - wrapper 启动时就按上面的规则读文件写入 `configuredModel`（`claude/claudeConfiguredModel.ts`），新会话的第一条消息即可不发 model；每轮 system/init 后再用 `get_settings` 的答案覆盖。
  - **默认 1M**：表项可带 `longContext: true`（Opus 5.5 带）。wrapper 由 `requires`（capability / cliVersion）证明能跑该表项时，跟随最新解析为 `<model>[1m]`（无配置时 Claude Code 自己默认是不带 1M 的 `claude-opus-5-5`）；只靠 catalog 证明（旧 CLI）或表项没这个标志（旧 server 表）→ 不带 `[1m]`，不会出现 `unrecognized_model`。`[1m]` 自 CLI 0.2.103 起被 daemon 接受，capability `claude-opus-5-5-v1` 来自 0.2.149。
- **账号/供应商不支持 1M（B-883b）**：实测 Claude Code 2.1.304 + 本地 stub（tmp/vh-team-B-883b，对带 `context-1m-…` beta 的请求返回拒绝）：
  - 400 且错误提到该 beta（`long context beta` / beta 名 / `invalid beta flag`）→ Claude Code 自己去掉 beta 重发一次，会话正常；
  - 429「Extra usage is required for long context requests」（Anthropic 订阅档的形态）→ 立即失败，根回复 `error: rate_limit`、`api_error_status: 429`；403 → 重试 10 次（约 3 分钟）后同样失败。改前跟随最新的会话每条消息都这样失败，不会自愈。
  - wrapper（`claude/claudeLongContext.ts`）：正在跑 `[1m]` id、根回复为 400/403/429 且文本提到 long context / context-1m 时视为「1M 被拒」。一律把判断写进 `$HAPPY_HOME_DIR/claude-long-context.json`（键 = 生效的 `ANTHROPIC_BASE_URL` + `CLAUDE_CONFIG_DIR`，换供应商或登录不受影响）和 `metadata.longContextUnsupported = { reason, at }`。会话 intent 是 `latest` → 拒绝帧不转发，`set_model` 到不带 `[1m]` 的 id，把同一条 prompt 重发一次，`stickyModel` 改为 plain id，并发 kind `claude-long-context-fallback` 提示；显式选的 `[1m]` → 不降级，转发错误并发 kind `claude-long-context-refused` 提示。之后跟随最新的消息即使仍带 `[1m]`（旧 Web）也按 plain id 跑。
  - 这一轮模型已经回答过（可能跑过工具）才被拒 → 不重发（重发可能重复副作用），错误照常显示，后续轮切 plain id，发 kind `claude-long-context-interrupted` 提示。
  - 判断可撤销：`[1m]` 请求得到正常回答（用户显式打开 1M，账号已升级）→ 清掉文件和 metadata 里的判断，跟随最新恢复 1M。
  - 已知限制：只认文本提到 long context / context-1m / 1M context 的拒绝；供应商的笼统 400/403 无法归因（可能真是鉴权错），不自动回落，用户可手动关 1M。403 要等 Claude Code 自己重试完（实测约 4.3 分钟）才回落。
  - Web：`latestModelContext` 读 `longContextUnsupported`（会话 metadata，或新建对话框用该机最近会话的 metadata）→ 跟随最新解析为不带 `[1m]`，1M 开关显示关并说明原因；两种提示在聊天里本地化显示且不折叠进活动。显式打开 1M 仍按 1M 请求。
  - 兼容：新字段都可选；旧 Web 忽略 `longContextUnsupported`/event kind，看到 CLI 自带的中英提示文本；旧 CLI 不上报、不回落（行为同改前）。
- **复位粘住的模型（B-844c，QA22b P2-A）**：wrapper 会对不带 model 的 turn 继续沿用上一次收到的显式 model。所以「跟随」解析成不发 model 时，如果会话之前发过显式 model（例如账号默认曾固定为 gpt-6-luna，后来改回跟随），只是不发就会继续跑 luna，界面却显示「跟随本机配置（gpt-5.6-sol）」。为此 Codex wrapper 上报 `metadata.stickyModel`：字符串 = 正在沿用的显式 model；`null` = 没有；字段不存在 = 旧 wrapper，不知道。是字符串时 Web 发 `model: null`，wrapper 清掉这个 model 并上报 `null`，之后恢复成不发。`stickyModel` 来自 wrapper 状态，因此其它设备的选择、`spawn --model` 留下的 model 也能复位。旧 wrapper 不上报这个字段，行为和原来一样（不发 model）；即使收到 null 也不会报错，所有已发布版本都按 `meta.model || undefined` 复位，schema 是 nullable。
  - **只发 null 不够（实测）**：Codex app-server 会把 `turn/start` 带过的 model 记成该 thread 的模型，之后不带 model 的 turn 仍沿用它（rollout 序列：luna > 发 null 后仍是 luna > luna）。因此 wrapper 收到 `model: null` 时，这一轮显式传本机默认：`config/read` 钉的模型，没有就用 `model/list` 的 `isDefault`（`codex/turnModel.ts`）；两者都不知道才不传。
  - **只有显式复位才代发本机默认（B-844d，QA23）**：B-844c 一度在「turn 没有 model」时一律代发本机默认。wrapper 内存里的选择一丢（`send --resume` 重启 wrapper、abort 复位），不带 model 的 turn 就被改成 gpt-5.6-sol，违反 `send` 的「不带 --model 保持当前模型」。现在只有 `meta.model === null`（消息上的 `modelReset`）才代发；没有 model 字段就不传，thread 保持它记住的模型。abort 不再复位 model。
  - **`stickyModel` / `currentModelCode` 来自 thread 实际模型（B-844d）**：client 记录 thread 的模型。来源有三处：`thread/start|resume|fork` 响应里的 `model`（Codex 0.166 实测，resume 一个跑过 luna 的 thread 返回 `gpt-6-luna`），以及被接受的 `turn/start` 带的 model。后者也写回 resume 默认值，避免 idle-release 或强制重启后的 resume 把起始模型带回来。wrapper 上报 `currentModelCode` = thread 模型；`stickyModel` = thread 模型与本机默认不同时取该模型，否则为 `null`；还没有 thread 时取待发的显式选择。因此 resume 后 Web 仍知道有粘住的模型，跟随时照样发 null 复位。
  - **显示（B-844d）**：Codex 会话的模型选择解析出的模型与 `currentModelCode` 不一致时（比如 CLI 不带 model 续跑了 luna，而 Web 跟随 sol），选择器面板注明「这个会话当前在跑 X；从这里发下一条消息时会切过去」。只对上报 `stickyModel` 的新 wrapper 显示。
  - Claude 没有这个问题：跟随时要么显式发 model，要么（本机配置钉了模型，B-883）发 `null`，`null` 即切回本机配置模型（`claude-config-model-v1`）。
- **effort 显示（B-844c，QA22c P2-1）**：Codex wrapper 没收到 effort 时固定跑 `medium`，而 catalog 的 `defaultReasoningEffort` 是 `low`，选择器按 catalog 显示成 low。现在 wrapper 用 `currentThoughtLevelCode` 上报实际在跑的 effort，选择器原本就优先读这个字段；effort 被复位（null）时删掉该字段，选择器回到 catalog 默认，这也是 Codex 此时真正会跑的值。
- **说明文案（B-844c，QA22c P2-2/P2-3）**：设置页「本机默认」项改用和选择器相同的说明，也不再显示原始 key `default`。跟随项的说明按实际行为区分三种：旧 CLI「升级 CLI 后才会自动切换」；其余统一写「本机配置指定了模型时按本机配置」（B-883 起 Claude 也是，不再有 Claude 专用文案）。
  - Gemini 不在本修复范围（另立条目）：daemon 拉起的是 `gemini/runGemini.ts`，它不上报 `configuredModel`；显式选的模型会写进 `~/.gemini/config.json`，而且总用 `GEMINI_MODEL` 指定模型。发 null 只会退回上一次选的模型，起不到复位作用。
- Codex wrapper 去掉写死的 gpt-5.5 默认：不带 model 的 turn 交给 Codex 按本机配置或它自己的默认跑。
- 显示：选择器的跟随项、设置页该机器的值都写成「跟随本机配置（gpt-5.6-sol）」（见下节）。这时 B-487 的升级提示不出现。
- **B-487 提示只看会话实际会请求的模型（B-862，QA35）**：Codex/Gemini 跟随最新时，提示条用解析出的 `model`（catalog 能证明可跑的最新 id，也就是发送时真正带的那个），不用 `newest`（表里已知最新）。此前 config.toml 只设了 `model_provider`、没钉 model 的 Codex 0.154 会话（`configuredModel: null`）会被提示「gpt-6.1-sol 需要 Codex 0.160.0」，实际发的却是 gpt-5.6-sol。会话绑定 API 供应商账号（`agentProfile.kind = codex-provider`）时不按 OpenAI 目录的最低 Codex 版本提示，显式选的也不提示；ChatGPT 账号或本机登录显式选了更新的模型时照常提示。本机登录走自定义 provider 时 wrapper 不上报 provider，Web 区分不了，显式选新模型仍会提示。Claude 跟随最新的 Opus 5.5 提示不变。

### 显示（B-844b，QA22 P2-1～P2-4）

纯函数在 web `sync/followLatestDisplay.ts`。

- **选择器只有一个跟随项**（key `latest`，选中后会话与账号都不记具体模型）。它取代「X（默认）」和「X 当前最新」两项，名字按解析结果：
  「跟随最新（X）」/「跟随本机配置（X）」/「本机默认（升级 CLI 后跟随最新）」（会话 wrapper 证明不了更新的模型，例如旧 CLI 没上报 `configuredModel`：如实说跑的是机器默认，P2-1）/「跟随最新（取决于机器）」（没有会话也没有机器）。
  X 本身的条目只在被明确选中（固定）时保留。`default` 只给 Claude 保留，叫「本机默认」（意思是跟随 /model，跟随最新会覆盖它）；Codex/Gemini 的跟随已经尊重本机配置，`default` 只在当前就选着它时出现。B-883：Claude 跟随项已是「本机配置 · X」时也不再另列 `default`（同一个模型两行），除非当前就选着它。
  - **1M 开关（B-883）**：跟随项跑的是 `[1m]` id（无配置的默认，或本机配置如 `opus[1m]`）时开关为开；关掉 = 固定不带 1M 的 id（显式选择，会话与重启后都保持）；在这个固定上再打开 = 回到跟随最新。本机配置不带 1M（如 `sonnet`）时开关为关，打开即固定其 `[1m]` 孪生。原始 key「default model」不再展示（设置页同样改名为「本机默认」）。
  X 指跟随项实际要跑的模型（`followEntryModel`）：本机配置钉了模型时是钉的那个，不是同档最新。钉配置的机器上，这个模型也会作为机器的自定义模型（B-688，读自 config.toml）出现，同样按此规则只在被固定时列出（`customModelsBesideFollow`，B-844d / QA23 P2-3）。
- **设置页「当前」按机器解析**（P2-2/P2-3）：每台机器取该智能体**最新创建**的会话，用 `resolveLatestForAgent(table, agent, 会话 metadata)` 解析，与发送时 `resolveMessageModeMeta` 走的是同一个函数（capability + catalog + configuredModel），不读表头。机器按名称排序，账号级的值：各机一致时显示该值，不一致时显示「跟随最新（因机器而异）」，没有会话时显示「跟随最新（取决于机器）」；展开后的说明逐台列出。这样新建会话只会改变**那台**机器的值，账号级的值不再随「最新会话在哪台机器」来回跳。

### 单一来源

`latestModels.json`（wire 打包进 web/CLI/server 作兜底）→ server `GET /v1/models/latest`（匿名、
`cache-control: public, max-age=300`；`VH_LATEST_MODELS_FILE` 覆盖，mtime 变化即生效）→ web
`sync/latestModels.ts`（30 min 节流 + localStorage 缓存）/ CLI `api/latestModels.ts`（2 s 超时）。
没有采用「只从账号最近会话 catalog 推导」：Claude SDK catalog 只有 alias，新会话首条消息时还没
catalog，且无法表达「这台机器缺能力」；catalog 作为补充参与解析（catalog 里出现更新的同档模型会
直接被跟随，即使表还没更新）。

### spawn

`very-happy spawn` 拉 server 表；Codex/Gemini 跟随最新时最多等 8 s 让 wrapper 发布 catalog，
超时则首条不带 model（机器默认），后续网页消息再解析。

### 不再被动钉死与迁移

- 会话里选中 `latest` 当前解析出的那个模型 → 清掉 override（继续跟随）；选其它模型 → 照旧记为账号默认
  （设置页显示「固定为 X」，可一键改回「跟随最新」）。
- 设置 → 智能体：默认行「跟随最新（当前：X）」或按机器的汇总（见「显示」）；选具体模型 = 固定。
- 一次性迁移：`settings.modelFollowLatestMigratedAt` 为 null 时，把等于迁移时最新的 override
  （claude `claude-opus-5-5`、codex `gpt-6.1-sol`、gemini `gemini-3.1-pro-preview`）删掉，其它保留；
  写入时间戳后永不重跑（之后在设置里固定这些 id 不会被清）。

### 防过时

- PR 级：`happy-cli/src/commands/latestModelsFreshness.test.ts` 扫 bundled claude-agent-sdk 里的
  Opus id，比表头新就红。
- 周级：`.github/workflows/latest-models-check.yml` 每周一安装 npm latest Codex，探 `model/list`，
  出现比表头新的 sol 或 Codex 默认跑出 sol 档时失败（`scripts/dev/check-latest-models.mjs`）。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 web + 旧 server（无 endpoint） | 404 → 用 bundled 表 |
| 新 web + 旧 CLI wrapper | Claude：只按 capability/catalog 解析，无能力 → 机器默认（null）+ B-487 提示条；有 `claude-opus-5-5-v1` → `claude-opus-5-5[1m]`。≤0.2.202 的 wrapper 第一轮之后才上报 `configuredModel`，且不计 `ANTHROPIC_MODEL`：第一条消息仍发 1M 最新，此后按上报的 settings model 不发（B-883 需 CLI 更新）。Codex/Gemini：旧 wrapper 不上报 `configuredModel` → 不发 model；不上报 `stickyModel` → 不复位粘住的显式 model（B-844c 需 CLI 更新）（旧 Codex wrapper 仍会用它写死的 gpt-5.5，直到 CLI 更新）。从不发 `latest` |
| 旧 web（缓存 PWA） | 用旧代码默认 Opus 5.5 / 不发 Codex model；可能重新写入具体 id override（接受） |
| 旧 CLI `spawn` | 旧逻辑（Opus 5.5 或机器默认） |
| 新 CLI `spawn` + 旧 server | 404 → bundled 表 |

发布：server/Web 同镜像先发；CLI 随后。Codex 的「本机配置优先」和「跟随最新」都要等 CLI 更新才生效：新 wrapper 上报 `configuredModel`，并去掉写死的 gpt-5.5。CLI 没更新前，Codex 行为和现在一样，都是 gpt-5.5。
回滚：回滚镜像即可；迁移只删 override，回滚后旧 web 回到旧代码默认（Opus 5.5），不会报错。

## 风险

0. 自定义 provider 没有 catalog 里最新的模型：只要 config.toml 钉了模型就不会发最新。没钉模型、又用不认识新 id 的 provider 时，首条可能报错。缓解：设置里固定一个模型，或者在 config.toml 里写上 model。
1. Codex 会话 catalog 到达前的首条网页消息不带 model → 跑 Codex 配置默认。实测 0.154/0.166 首条均已带解析结果（pending 页面等会话 ready 后才发送）；接受。
2. 用 ChatGPT 登录的旧 Codex：catalog 不含新 sol → 解析到它列出的最新 sol，不会 400；提示条提示升级（`modelSupportPolicy` codex 分支改为读表的 `agentVersion`）。
3. 运营文件写错：schema/正则校验失败即回落 bundled 并告警。
4. 下一代 Opus：表加条目 + capability 即可被跟随；B-487 Claude 提示条文案需随之泛化（目前写死 Opus 5.5）。

## 验收标准

- [x] 代码默认 sentinel；Claude 今天 = claude-opus-5-5；Codex/Gemini 解析到 catalog 证明可跑的最新；旧 wrapper 回退；spawn 同样解析
- [x] 单一来源 + server 下发 + 代码兜底；无会话列表合并实时 catalog
- [x] 会话内选最新不钉死；设置页区分跟随/固定；迁移规则
- [x] 防过时检查；单测 + mutation；真实会话核对 model；桌面 + 手机截图
- [x] B-844c：会话发过显式 model 后改回跟随，wrapper 报 `stickyModel` → Web 发 null 复位，rollout = 界面显示
- [x] B-844d：`send --resume`、abort 之后不带 model 的 turn 保持 thread 模型；thread 模型经 resume 上报，跟随时仍能复位
- [x] B-844b：选择器单一跟随项、无内部 key；设置页按机器、与发送同源；旧 CLI 如实显示
