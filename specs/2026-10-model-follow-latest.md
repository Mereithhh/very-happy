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
| 非 Claude 只发 override，代码默认从不发送（UI 显示 gpt-5.5，实际跑 Codex 配置/内置默认） | `packages/happy-web-v2/src/sync/messageMeta.ts` |
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
- `none`（设置页）：表头 ∪ 所有机器最近 catalog。

sentinel 永不上线：web `resolveMessageModeMeta`、`resolveDefaultModelMode`、spawn
`resolveFirstMessageMeta` 都保证输出具体 id / null。

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
- 设置 → 智能体：默认行「跟随最新（当前：X）」；选具体模型 = 固定。
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
| 新 web + 旧 CLI wrapper | 只按 capability/catalog 解析；无能力 → 机器默认（Claude null）+ B-487 提示条；从不发 `latest` |
| 旧 web（缓存 PWA） | 用旧代码默认 Opus 5.5 / 不发 Codex model；可能重新写入具体 id override（接受） |
| 旧 CLI `spawn` | 旧逻辑（Opus 5.5 或机器默认） |
| 新 CLI `spawn` + 旧 server | 404 → bundled 表 |

发布：server/Web 同镜像先发；CLI 随后（spawn 解析与新鲜度测试在 CLI 包，但不发 CLI 也不影响网页路径）。
回滚：回滚镜像即可；迁移只删 override，回滚后旧 web 回到旧代码默认（Opus 5.5），不会报错。

## 风险

1. Codex 会话 catalog 到达前的首条网页消息不带 model → 跑 Codex 配置默认。实测 0.154/0.166 首条均已带解析结果（pending 页面等会话 ready 后才发送）；接受。
2. 用 ChatGPT 登录的旧 Codex：catalog 不含新 sol → 解析到它列出的最新 sol，不会 400；提示条提示升级（`modelSupportPolicy` codex 分支改为读表的 `agentVersion`）。
3. 运营文件写错：schema/正则校验失败即回落 bundled 并告警。
4. 下一代 Opus：表加条目 + capability 即可被跟随；B-487 Claude 提示条文案需随之泛化（目前写死 Opus 5.5）。

## 验收标准

- [x] 代码默认 sentinel；Claude 今天 = claude-opus-5-5；Codex/Gemini 解析到 catalog 证明可跑的最新；旧 wrapper 回退；spawn 同样解析
- [x] 单一来源 + server 下发 + 代码兜底；无会话列表合并实时 catalog
- [x] 会话内选最新不钉死；设置页区分跟随/固定；迁移规则
- [x] 防过时检查；单测 + mutation；真实会话核对 model；桌面 + 手机截图
