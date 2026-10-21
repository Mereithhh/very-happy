# pi 上下文占用：窗口来源、压缩生效与指示

> 状态：Final
> 日期：2026-10-22 ｜ 关联 backlog：B-727 ｜ 前身：B-688（`specs/2026-10-custom-models.md`）、pi 运行时上报（`teams/resources.ts` 扩展）

## 背景

Owner 10-21：「pi + 自定义模型时上下文指示不准，常显示 90% 多，用得特别慢；压缩 pi 以后还是 90% 多。」

## 根因（代码与会话文件取证）

1. **分母**：pi 给 models.json 里没写 `contextWindow` 的模型一律按 **128000**（pi 1.1.0 `core/provider-composer.js` `contextWindow: definition.contextWindow ?? 128000`）。B-688 的 pi 写回只写 `{ id }`（`modelConfig/harnesses/pi.ts`），所以经表单加的模型窗口都是 128k；pi 扩展上报的 `ctx.getContextUsage().contextWindow` 就是这个默认值，Web 原样当分母。1M 模型显示的百分比是实际的约 8 倍，pi 也按 128k − 16384 提前自动压缩。
2. **分子**：没有累加。pi `getContextUsage()` 取**最后一条有效 assistant 的 usage**（`input + output + cacheRead + cacheWrite`，`compaction.js` `calculateContextTokens`）加其后消息的估算；openai-completions 适配把 `cached_tokens` 从 `prompt_tokens` 里扣掉再记 cacheRead，不重复。Very Happy 原样转发，不做加总。压缩后 pi 返回 `tokens: null`，直到下一次回答。
3. **压缩没执行**：Web 的 `/compact` 经 runAcp 发给 pi-acp 前被加了内容——每个 wrapper 进程的第一条消息后面拼 `BUILTIN_TODO_DISCOVERY`，项目会话前面拼项目前缀/摘要。pi-acp 0.0.33 只在文本以 `/` 开头、且命令词截到第一个空格时才执行命令；`"/compact\n\nFor the user’s…"` 的命令词是 `compact\n\nFor`，于是整段当普通消息发给模型。实证：会话 `cmvhu15eh1pcko92kk6epcpix`（pi 文件 `2026-10-21T08-10-32-159Z_01a15d83….jsonl`）14:19:53 的 `/compact` 作为 user 文本进入上下文，模型回了一段「会话压缩摘要」，没有 compaction 条目，占用 949,671 / 1,000,000（95%）不变。
4. **慢**：同一会话缓存命中时，占用 0–100k 的回合中位 5.1 s，900k+ 中位 8.0 s；那次被当成聊天的 `/compact` 有 942,899 个未命中缓存的输入 token，耗时 39.7 s。慢的主因是上下文真实很大且压缩没生效，不是 provider 本身慢（`tmp/vh-team-B-727/latency-by-context.txt`）。

## 目标

- 分母优先级：**配置 > 已知表 > 未知**；未知时不显示百分比。
- 分子：pi 自报的最近一次占用，不累加（保持）。
- Web 的 `/compact` 在 pi 上真正触发 compaction；压缩后指示器显示「已压缩 · 下轮更新」，下一轮显示新值。
- B-688 表单可写每个 pi 模型的上下文窗口。
- Claude / Codex 的指示逻辑不变。

## 非目标

- 不改 pi 的自动压缩阈值或 reserveTokens（用户在 pi settings 里自己配）。
- Codex `model_context_window` 表单项（Codex 自己报窗口，不在本次问题里）。
- 不维护 Very Happy 自己的非 Claude 模型窗口表：错表比没有更糟，「已知表」= pi 内置注册表里同 id 的模型 + Web 现有 Claude id 规则。

## 设计

### 窗口来源（CLI `agent/acp/piContextUsage.ts`）

pi 扩展每次上报附带 `model`、`provider`、`event`（触发事件名）和 `peers`（注册表里其它 provider 下同 id 或同尾段 id 的模型窗口，最多 8 个）。wrapper 读 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/models.json` 判定：

| 情况 | windowSource | contextWindow |
|---|---|---|
| provider 不在 models.json，或模型不是 models.json 自定义条目（内置注册表） | configured | pi 的值 |
| 条目写了 `contextWindow`，或 `modelOverrides` 写了 | configured | pi 的值 |
| 条目没写（pi 用 128000），且 peers 中「本身不是默认值」的条目只有一个窗口值 | inferred | 该值 |
| 其余 | unknown | pi 的 128000（只给旧 Web 用） |

models.json 读不到或带注释（非严格 JSON）→ configured，即旧行为，不做新猜测。

Web：`unknown` 再查现有 `contextWindowFor(model)`（Claude id 规则），命中则当 inferred；仍无 → 分母为空，只显示 `≈N tokens`，tooltip 提示去「模型与 Provider」填写。

### 压缩

- runAcp 发送前用 `buildAcpPrompt`：以 `/命令词` 开头（命令词止于空白或结尾，路径 `/tmp/x` 不算）的消息**原样**发送，不加项目前缀、不拼 todo 说明，也不消耗「todo 说明只发一次」的名额。
- 扩展在 `session_compact` 上报 `tokens: null`；wrapper 记 `compactedAt`，在拿到新的 tokens 前一直保留。Web 看到 `tokens === null && compactedAt` 显示「已压缩 · 下轮更新」。

### 表单（B-688 扩展）

pi 的模型列表每行 `id` 或 `id 窗口`（`200k`、`1M`、`262144`；k=1000、M=1 000 000）。view 新增 `current.contextWindows`（选中 provider 下显式写了窗口的模型）；patch 新增 `contextWindows: { id: number | null }`，数字写入、null 删除，其余字段保留。校验：整数 1024–100 000 000，键必须是该 provider 的模型。

## 兼容矩阵与发布顺序

`ContextUsage` 新增可选 `windowSource`（字符串 + 读取白名单）、`model`、`compactedAt`；`contextWindow` 仍必填。

| Web \ CLI | 旧 CLI | 新 CLI |
|---|---|---|
| 旧 Web | 不变 | 新字段被 zod 剥掉；unknown 时 `contextWindow` 仍是 pi 的 128k，表现与现在相同；`/compact` 已修好（CLI 侧） |
| 新 Web | 无 `windowSource` → 当 configured，与现在相同；表单不显示窗口（view 无 `contextWindows`），写了窗口会提示升级 CLI，不发送 | 全功能 |

- model-config patch 的 `contextWindows`：旧 daemon 会忽略未知字段，所以 Web 只在 view 带 `contextWindows` 时发送。
- server 零改动。CLI 与 Web 互不依赖，按默认 server/Web → CLI。正在跑的 pi 会话用的是启动时安装的扩展，CLI 升级后要新建或重启会话才会带新字段与 `/compact` 修复。

## 风险

1. peers 推断来自 pi 注册表里不同 provider 的同 id 模型：只有本身不是 128k 默认值且取值唯一时才采用；有分歧 → unknown。
2. 用户写错窗口（比真实大）会让 pi 迟压缩、触发上游 overflow：pi 有 overflow 自动压缩兜底；表单限制范围并在 diff 预览里展示。
3. 以 `/` 开头的普通句子（如 `/etc 没权限`）不再带项目前缀：只影响这一条，接受。

## 验收标准

- [x] 单测：窗口来源优先级（配置 > 已知表 > 未知）、不累加、压缩标记的保留与清除、Claude/Codex 回归（`piContextUsage.test.ts`、`contextWindow.test.ts`）。
- [x] 单测：`/compact` 原样发送（首条消息、项目会话）（`acpSlashCommand.test.ts`）。
- [x] 单测：表单解析与 patch、旧 daemon 不发送（`modelConfigModel.test.ts`）；daemon 写入/删除 contextWindow（`service.test.ts`）。
- [x] 实测：隔离 HOME 的 pi + 自定义模型，指示器与 pi 自报一致（误差 < 5%），压缩后显示「已压缩」，下一轮下降（`tmp/vh-team-B-727/`）。

## 留真机验证项

无（指示器与表单均在桌面/手机尺寸浏览器中验证）。
