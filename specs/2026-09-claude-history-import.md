# 导入 Claude Code 历史（claude CLI / 桌面版 / claude.ai 对话 → very-happy 会话）

> 状态：Shipped（commit `c0ee1a82`，PR #166；CLI v0.2.103）
> 日期：2026-09-03 ｜ 关联 backlog：B-290 ｜ 出处/前身：Owner 2026-09-03「claude code desktop 的 history 能不能迁移到 veryhappy 下」

## 背景

Claude Code 的三种入口——`claude` CLI、Claude Code 桌面版、claude.ai 远程会话（以及 SDK 驱动的运行）——都把对话写到同一处：
`<CLAUDE_CONFIG_DIR|~/.claude>/projects/<编码后的 cwd>/<sessionId>.jsonl`（本机实测 118 个项目目录、~560 个 transcript，首行
`entrypoint` 取值 `cli` / `sdk-cli` / `remote_mobile`；桌面版没有单独的存储目录，GitHub issue anthropics/claude-code#53474 亦确认）。
very-happy 已经会「继续一个 JSONL」：`claude-fork-session` 复制文件、`spawn-happy-session` 带 `resumeClaudeSessionId` 时
`claude --resume` 并由 `runClaude.ts` 的 fork backfill 把历史回填进新 Happy 会话。缺的只是「找到那些不是从 very-happy 发起的对话」。

## 目标

- Web 一键把机器上任意 Claude Code 对话导入为 very-happy 会话，历史完整可继续。
- 原件不动（复制语义），导入过的原件不再重复出现在列表里。
- 旧 daemon 零破坏：无能力标志时弹窗显示升级提示。

## 非目标

- 不做「搬走/删除原件」、不做双向同步（两份从导入点起各自发展）。
- 不解析整份 transcript（只读文件头）；不做消息数统计。
- 不导入子代理 transcript（`<id>/subagents/`）；不导入 Codex / Gemini 历史。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 项目目录编码 `resolve(cwd).replace(/[^a-zA-Z0-9-]/g,'-')`，有损，因此 cwd 以 JSONL 内 `cwd` 字段为准 | `packages/happy-cli/src/claude/utils/path.ts` |
| fork = `copyFile` 到新 UUID；rewind 列表已按行解析 `type:'user'` + string content | `packages/happy-cli/src/claude/utils/claudeSessionFork.ts` |
| spawn 带 `resumeClaudeSessionId` → `--resume` + `HAPPY_FORK_CLAUDE_SESSION_ID` → 回填 + `metadata.claudeSessionId` | `packages/happy-cli/src/daemon/run.ts:548,755`、`src/claude/runClaude.ts:361` |
| 能力标志纪律：connect 时 restamp `{rpcAvailable, detectedAt}`，web 以 `detectedAt >= startedAt` 信任 | `apiMachine.ts`（B-265 terminalRestore）、`web/src/sync/closedTerminals.ts` |
| web 已有 `claudeForkSession` / `machineSpawnNewSession`（此前无 UI 调用方） | `packages/happy-web-v2/src/sync/ops.ts` |
| Claude Code 2.1.258 `--model` 别名：`fable`→claude-fable-5-1、`opus`→claude-opus-5、`sonnet`→claude-sonnet-5；`fable[1m]`/`best` 可用；`fable5` → `unrecognized_model` | 2026-09-03 `claude -p --model … --output-format json` 实测 |

## 设计

0. **过滤自家 one-shot**：`titleGenerator` / `boardAnalyzer` 用 `claude -p` 跑真 CLI，每次调用都留一份短 transcript（本机最近 400 份里 84 份是这两类）。
   两处 prompt 前缀抽到 `claude/utils/oneShotPrompts.ts`，扫描时命中即跳过；`oneShotPrompts.test.ts` 钉住「prompt 由该常量拼出」，防止改 prompt 后过滤静默失效。
1. **daemon RPC `claude-list-history`**（`apiMachine.ts`）：参数 `{ directory?, limit?(≤200, 默认 60), exclude?: uuid[] }`。
   无 `directory` 时扫 `<config>/projects/*` 全部子目录。实现 `claude/utils/claudeSessionHistory.ts`：`stat` 全部 `*.jsonl`
   按 mtime 倒序，只读前 64 KiB 取 `cwd` / 首条用户提示（string 或 text block，剥 `<system-reminder>` 等 harness 标签）/
   `type:'summary'` 标题 / `entrypoint` / `gitBranch` / `version` / 首个 timestamp；无 cwd 或既无提示又无摘要的跳过；
   达到 `limit` 即停（`truncated:true`）。纯函数 + 临时目录测试。
2. **能力标志** `daemonState.claudeHistory = { rpcAvailable, detectedAt }`，connect 时与 `terminalRestore` 同处 restamp。
3. **daemon RPC `claude-import-session`（原子）**：参数 `{ directory, claudeSessionId, approvedNewDirectoryCreation?, permissionMode? }`
   = fork 副本 → `spawnSession({ agent:'claude', resumeClaudeSessionId: 副本, importedFromClaudeSessionId: 原件, … })`；
   **非成功路径（error / throw / `requestToApproveDirectoryCreation`）一律 `discardForkedSession` 删掉刚建的副本**。
   为什么不在 web 端 fork+spawn 两步：spawn 失败时副本无人引用、cwd 与 head 都合法，会作为「与原件同名的第二条」永久留在导入列表里，每重试一次多一份（review 实证）。
4. **Web** `ImportClaudeHistoryModal`（照 `AttachTmuxModal`）：机器选择（机器页入口传 `initialMachineId`，否则多机器时会默认到最新那台）→
   `machineListClaudeHistory(machineId, { limit:100, exclude: trackedClaudeSessionIds(sessions) })` → 两行式行（标题 / mono：`~/相对 cwd · 分支 · 来源 · 大小 · 时长`）
   → 点击 = `machineImportClaudeSession(...)`；返回 `requestToApproveDirectoryCreation`（transcript 里的 cwd 已不存在，`~/.claude/projects` 里大量 `/private/tmp`、`/var/folders` 记录属于此类）时
   走与新建会话相同的「创建目录？」确认再带 `approved` 重试 → 跳转。入口：侧栏 + 菜单、⌘K、机器页。纯逻辑在 `claudeHistoryImport.ts`（解析 / 去重 / 搜索 / 格式化）。
5. **去重**：web 把已知会话的 `metadata.claudeSessionId` 与 `metadata.importedFromClaudeSessionId` 都算「已接管」，既传给 daemon `exclude`
   也在客户端再过滤。`importedFromClaudeSessionId` 经 spawn RPC → `HAPPY_IMPORTED_FROM_CLAUDE_SESSION_ID` → `runClaude.ts` 初始 metadata 写入。
6. **模型选择器**（同批）：`getClaudeModelModes()` 镜像 2.1.258 别名；`sanitizeResumeModel` 放行 `[1m]` 后缀；CLI `pricing.ts` 补 Claude 5 / Fable 行并按家族+代次解析别名。

否掉的方案：直接 `--resume` 原件（不复制）——与桌面版共用一份 JSONL 会出现双写者，且 very-happy 的单写者锁只管自己的 wrapper。

## 兼容矩阵与发布顺序

| 端 | 新字段/RPC | 旧端行为 |
|---|---|---|
| daemon → web | `daemonState.claudeHistory` | 旧 web 忽略；新 web 见不到标志则只显示升级提示，不调用 RPC |
| web → daemon | `claude-list-history`、`claude-import-session`、`spawn-happy-session.importedFromClaudeSessionId` | 旧 daemon 忽略未知字段；新 web 因无标志不会调这两个 RPC |
| CLI → server/web | `metadata.importedFromClaudeSessionId` | 旧 web schema 会剥掉该字段（只影响去重展示，不影响功能） |

顺序：server/web（同镜像）→ CLI tag v0.2.103 → mac-office `vh-update`。回滚点：上一 live SHA / v0.2.102。

## 风险

1. 大量 transcript 扫描慢 —— 只 stat + 读头、按 mtime 截断；实测 560 文件在本机 < 1 s。接受。
2. 项目目录编码碰撞 —— 以文件内 `cwd` 为准，不用目录名反推。
3. 原件在导入后仍被桌面版继续写 —— 复制语义下互不影响；文档明确说明。
4. transcript 记的 cwd 已不存在 —— 导入走与新建会话相同的「创建目录？」确认；拒绝则副本已被 daemon 删除，不留残留。
5. 同一 conversation id 在两个 project 目录各有一份 —— 列表按 mtime 取新的那份，只出一行（React key 唯一、复制来源无歧义）。

## 验收标准

- [x] `listClaudeSessionHistory` 单测：排序、limit/truncated、exclude、无 cwd 跳过、summary 标题、只读头、同 id 跨目录只出一行。
- [x] `claude-import-session` 单测：成功路径、spawn 返回 error / throw / 目录待确认三条路径都删副本、approved 重试、参数校验与源文件缺失。
- [x] `discardForkedSession` 单测（删副本不动原件、文件已不在时幂等）。
- [x] web 纯函数测试；模型列表测试；pricing 测试（含 Mythos 同价）；`sanitizeResumeModel` 测试。
- [x] 门禁：cli build+test+smoke、web vitest+build+tsc、server tsc+vitest。
- [ ] 真机：mac-office 升级后在 veryhappy.dev 导入一条 CLI 对话并继续（V-121，Owner 清账）。

## 留真机验证项

V-121（手机窄屏观感）。
