# 会话全文搜索（daemon 本地索引 Claude Code / Codex 历史）

> 状态：Final（主 agent 2026-10-12 定稿：review 两项已修）
> 日期：2026-10-12 ｜ 关联 backlog：B-549 ｜ 前身：`2026-09-claude-history-import.md`（B-290）、`2026-09-codex-history-import.md`（B-464）；参考 Orca `ai-vault-search`（只借鉴「增量游标 / 半行不提交 / 只索引对话正文」三条经验，不照搬其 SQLite FTS5 方案）

## 背景

导入对话框（B-290/B-464）只列「最近 100 条」并只按标题、首条提示、cwd、分支过滤：
找一段三周前讨论过的方案，只能凭记忆翻列表。Claude Code / Codex 的 transcript 都在 daemon 机器本地，
very-happy 已经能把它们导入或恢复，缺的是「按内容找到那一条」。

## 目标

1. daemon 对本机 Claude（`<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl`）与 Codex（`<CODEX_HOME>/sessions/**/rollout-*.jsonl`）历史建全文索引：
   增量（按文件身份 + size + mtime + 已处理字节偏移），索引放 `HAPPY_HOME` 下，有总量上限、可一键清除。
2. 新 machine RPC `history-search`：`query / limit / agent` → 会话标识、标题、匹配片段、时间、cwd；结果可直接走现有
   `claude-import-session` / `codex-import-session` 或打开已有 very-happy 会话。
3. 首次建索引不阻塞 RPC：立即返回当前（部分）结果 + 索引进度，Web 轮询直到 `ready`（约束 17：RPC ≤30 s）。
4. Web 在导入对话框加「全文搜索」模式与 ⌘K 入口；旧 daemon 显示「该机器 CLI 版本过旧，升级后可用」，不调 RPC、不报错。
5. 隐私：正文与索引只在 daemon 本地，不上传、server 不落库/不进日志与指标；片段经现有 machine RPC（机器密钥加密封包）返回。
   注意本 fork 是服务端可信模型、非 e2e（`packages/happy-cli/CLAUDE.md` Security boundary），这里不宣称对 relay 保密。

## 非目标

- 不索引工具输出（tool_result / function_call_output）、thinking/reasoning、子代理 transcript（`<id>/subagents/`、Codex sub-thread）。
  这些占 transcript 字节的绝大部分（本机 Claude 570 MB 原始 → 5 MB 对话正文），也最不像用户要找的东西。
- 不做分词/相关性模型/拼写纠错：大小写不敏感的子串 AND 匹配（天然支持中文）。
- 不做跨机器聚合搜索（一次搜一台机器，Web 选机器）；不做 CLI 子命令。
- 不改 server、不加 Prisma migration、不改 wire、不加 npm 依赖。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude 历史扫描：`listClaudeProjectDirs(getClaudeProjectsRoot())`，只读文件头；跳过 one-shot（titleGenerator/boardAnalyzer）transcript | `packages/happy-cli/src/claude/utils/claudeSessionHistory.ts`、`claude/utils/oneShotPrompts.ts` |
| Codex 历史扫描：`sessions/**/rollout-*.jsonl`，跳过 sub-thread（`isCodexSubThread`），harness 用户块（AGENTS.md、`<environment_context>`）按前缀识别 | `packages/happy-cli/src/codex/utils/codexSessionHistory.ts:160-221` |
| agent-home（B-478）：daemon 解析 settings > 登录 shell > daemon env > 默认，并把结果写回自身 `process.env`；`getClaudeProjectsRoot()`/`getCodexHomeDir()` 读 `process.env`，导入 RPC 也按它找文件 | `packages/happy-cli/src/agentHome/index.ts:119-148`、`claude/utils/path.ts`、`api/apiMachine.ts:479` |
| machine RPC 注册与加密：`rpcHandlerManager.registerHandler` 的 params/返回值用机器密钥加解密；handler 抛错 → ack 带 `{ error }` | `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts`、`api/apiMachine.ts:807-863` |
| 能力标志：connect 时 restamp `{ rpcAvailable, detectedAt }`，web 以 `detectedAt >= startedAt` 信任 | `api/apiMachine.ts:1303-1311`、`api/types.ts:351-369`、`happy-web-v2/src/sync/closedTerminals.ts:50-75` |
| 本机会话跟踪：`sessions.json` 里 `claudeSessionId` / `importedFromClaudeSessionId` / `codexThreadId` / `importedFromCodexThreadId` | `packages/happy-cli/src/persistence.ts:611-650` |
| server RPC：256 KB 载荷上限、30 s 超时、方法名指标白名单（未知归 `other`） | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:18,34,77-122` |
| Web 导入：`ImportHistoryModal`（来源单选 + 机器选择 + 多选导入 + 目录确认重试）；纯逻辑 `claudeHistoryImport.ts` | `packages/happy-web-v2/src/screens/sessions/ImportHistoryModal.tsx`、`claudeHistoryImport.ts` |
| CLI 引擎 `^20.19 || ^22.13 || >=24`；CI 矩阵 Node 20/24（约束 6）；依赖里没有任何 SQLite | `packages/happy-cli/package.json` engines/dependencies |

本机实测（2026-10-12，主力 Mac）：Claude 1012 份 transcript / 570 MB → 对话正文 5.1 MB；Codex 558 份 rollout / 3.5 GB →
对话正文约 30 MB（含 AGENTS.md 等 harness 块）。实现后同机实测（独立 HAPPY_HOME，只读真实历史）：1 557 个文件 → 959 个会话、
剥离 harness 后正文 717 万字符；冷建 7.3 s、期间事件循环最大延迟 29 ms；索引文件 13.8 MB；搜索 3–9 ms；20 条结果载荷约 16–18 KB；
重启后加载 + 增量刷新 88 ms。

## 设计

### 0. 索引引擎取舍：纯 JS 存储 + 线性扫描（不用 node:sqlite）

| 候选 | 结论 |
|---|---|
| `node:sqlite` + FTS5 | Node 20 没有；22.13+ 仍打 ExperimentalWarning；需要两套后端（Node 20 回退）且两套行为要对齐测试；FTS5 默认分词对中文无效（要 trigram 或自建 n-gram）。**否** |
| native（better-sqlite3 等） | 违反任务约束与铁律 2 的打包纪律。**否** |
| 纯 JS 倒排索引 | 中文需 n-gram，索引体积数倍于正文；增量更新与删除复杂。语料只有几十 MB，收益为零。**否** |
| **纯 JS 正文存储 + 线性扫描** | 单一实现覆盖 Node 20/22/24；子串匹配天然支持中英文混排；实测最坏 < 10 ms。**采用** |

「索引」= 从 transcript 抽取并截断后的对话正文 + 元数据 + 每文件游标，持久化在 `HAPPY_HOME`。搜索在内存里线性扫描。

### 1. 抽取规则（纯函数 `historySearch/extract.ts`）

- **Claude**：`type ∈ {user, assistant}` 且非 `isSidechain` 的行，取 `message.content` 的 string 或 `text` block（不取 tool_use/tool_result/thinking）；
  用户文本剥 harness 标签（同 `claudeSessionHistory.stripHarnessTags`）。元数据：首个 `cwd` / `gitBranch` / `entrypoint` / `timestamp`；
  `type:'summary'` 作标题。首条用户提示是 very-happy one-shot（`isVeryHappyOneShotPrompt`）→ 整个文件标记 `skip`（记录游标，不再读）。
- **Codex**：首行 `session_meta`（非 rollout → `skip`；sub-thread → `skip`）；正文取 `response_item.message` 的 `user`/`assistant`
  （`input_text`/`output_text`/`text`），这是各版本都有的形态；用户文本命中 `isHarnessUserText` 跳过，并剥 harness 块。标题 = `session_index.jsonl` 里的
  thread 名，否则首条用户提示。`originator: happy-codex`（very-happy 自己的 thread）**也索引**：搜索结果可直接打开对应会话。
- 每条消息截到 4 000 字符（头部），每会话正文上限 1 M 字符（超出不再追加，`full` 标记）；单行 > 2 MB 直接跳过不解析（大 tool 输出/图片 base64）。

### 2. 增量游标与持久化（`historySearch/store.ts`、`indexer.ts`）

每文件记录 `{ path, agent, id, ino, size, mtimeMs, offset, meta, msgs[] }`，`offset` = 最后一个**完整行**（`\n`）之后的字节偏移——
写了一半的末行不提交，下次从行首重读（Orca 教训：半行提交会永久丢消息）。刷新时：

| 观察 | 动作 |
|---|---|
| 新文件 | 从 0 读 |
| 同 ino，`size > offset` | 从 `offset` 追加读（transcript 只追加） |
| `size < offset` 或 ino 变化 | 丢弃旧记录，从 0 重读 |
| size、mtime 不变 | 跳过 |
| 文件消失 / 不再在当前 agent-home 根下 | 删除记录 |

根目录：每次刷新先 `refreshAgentHomes(now, { allowStale: true })`（B-478/B-512：不同步等登录 shell），然后取解析后的
`<claudeConfigDir>/projects` 与 `<codexHome>/sessions` + `session_index.jsonl`——与导入 RPC 找文件用的是同一个目录，搜索结果一定能导入。

持久化：`<HAPPY_HOME>/history-search/index.v1.jsonl`（目录 0700、文件 0600），首行头 `{ v:1, savedAt, roots }`，之后一行一个文件记录；
tmp + rename 原子写。刷新结束（有变化时）与冷建过程中每 20 s 落盘一次。版本号不符/解析失败 → 当作空索引重建。

上限：全部正文 `MAX_TEXT_CHARS = 32 M` 字符（内存约 32–64 MB）。超出时按 `updatedAt` 从旧到新**逐出正文**（保留元数据与游标，
标题/cwd 仍可匹配，`evicted` 计数进状态）；被逐出的文件只有变化时才会重读。内存索引空闲 10 分钟卸载（磁盘仍在），下次搜索再加载。

刷新不是常驻轮询：**只在收到搜索 RPC 时触发**（距上次刷新开始 ≥ 30 s 才触发，单飞），从不搜索的 daemon 不读任何 transcript。
刷新在后台运行，按块流式读文件并在文件间 `setImmediate` 让出事件循环。

### 3. RPC `history-search`（机器密钥加密，普通 `registerHandler`）

```ts
// params（全部可选，未知字段忽略）
{ op?: 'search' | 'status' | 'clear', query?: string, limit?: number /* 1..50, 默认 20 */, agent?: 'claude' | 'codex' }
// result
{
  type: 'success',
  status: { state: 'idle' | 'indexing' | 'ready' | 'error', filesTotal, filesDone, sessions, textChars, maxTextChars,
            evicted, lastIndexedAt?, error? },
  results: Array<{
    agent: 'claude' | 'codex', id: string /* claudeSessionId | codexThreadId */,
    title: string, firstPrompt: string, summary?: string, cwd: string,
    startedAt: number, updatedAt: number, sizeBytes: number,
    gitBranch?: string, entrypoint?: string, originator?: string,
    matchCount: number,
    snippets: Array<{ role: 'user' | 'assistant' | 'title', text: string, at?: number, ranges: Array<[number, number]> }>
  }>,
  truncated: boolean,
}
```

- `search`：确保索引已加载（首次从磁盘加载最多等 5 s，超时按 `indexing` 返回空结果）→ 需要时触发后台刷新 → **立即**在当前内存快照上搜索并返回。
  `status.state === 'indexing'` 时 Web 每 2 s 用同一 query 轮询，直到 `ready`。
- `query`：trim、≤ 200 字符；按空白拆为 ≤ 8 个词，**全部词**都要在该会话（标题 + cwd + 正文）中出现；大小写不敏感，正则转义。
  排序：整句命中的会话在前，其次 `updatedAt` 降序。片段：每会话最多 3 条（不同消息），以命中处为中心 ~160 字符，`ranges` 给出高亮区间。
- `clear`：取消进行中的刷新、删除 `history-search/` 目录、清空内存；返回 `idle` 状态。下次搜索重建。
- `status`：只返回状态，不触发刷新。
- 结果总量：50 × 3 片段 × ~200 字符，加密后远低于 256 KB。日志只记 query 长度与命中数，不记 query/片段内容。

能力标志：`daemonState.historySearch = { rpcAvailable: true, detectedAt }`，与 `claudeHistory` 同处 restamp，`api/types.ts` 加可选 schema。

### 4. Web

- `sync/ops.ts`：`machineHistorySearch(machineId, params)`，先查 `{ error }`（约束 17），失败返回 `{ ok:false }`，不抛。
- 纯模块 `screens/sessions/historySearch.ts`：`historySearchSupported(daemonState)`、宽松解析 RPC 载荷（未知 state 归 `idle`、坏行丢弃）、
  结果 → 现有 `HistoryEntry`（直接喂给导入流程）、`findTrackedSessionId(agent, id, sessions)`（会话自身 id 或 importedFrom 命中 → 打开该会话）、
  片段高亮切分、是否继续轮询。
- `ImportHistoryModal` 增加「最近 / 全文搜索」模式切换（`initialMode` 可选 prop），来源单选沿用为 agent 过滤；搜索模式渲染新组件
  `HistorySearchPanel`：防抖 300 ms 输入、结果行（标题、高亮片段、`~/cwd · 来源 · 时间`）、行内按钮「打开」（已有会话）/「导入」
  （复用模态内 `importOne`：目录确认、标题补写、单条成功跳转）。索引中显示进度（`已索引 x / y 个文件`），底部「清除索引」。
- 无标志：显示「该机器 CLI 版本过旧，升级后可用」（`historySearch.needsCli`），不发 RPC。
- ⌘K 增加「搜索历史对话内容…」，打开同一对话框的搜索模式。

## 兼容矩阵与发布顺序

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 新 | 新/旧 | 新 | 功能完整。server 只做 RPC 透传（方法名在指标里归 `other`），server 版本无关 |
| 旧 | 新/旧 | 新 | 无 `daemonState.historySearch` → 搜索模式显示「CLI 版本过旧，升级后可用」，不调 RPC；「最近」列表照旧 |
| 新 | 新/旧 | 旧 | 旧 web 不认识 `historySearch` 标志与 RPC，从不调用；daemon 从不被触发建索引，零开销 |
| 旧 | 新/旧 | 旧 | 无变化 |
| 新 daemon 降级回旧 | — | 新 | 旧 daemon connect 时把旧 `historySearch` 字段原样带过去，但 `detectedAt < startedAt` → 视为不支持（同 B-265 规则） |

wire、server、DB 无改动；wrapper 无改动（只有 daemon 进程注册 RPC）。发布顺序：server/web（同镜像）→ CLI tag → 机器升级 daemon；
任一顺序都安全（新 web 等旧 CLI 只显示升级提示）。回滚点：上一 live SHA / 上一 CLI 版本；`HAPPY_HOME/history-search/` 可直接删除。

## 风险

1. **冷建索引读全部 transcript（本机 4 GB / ~13 s）**：只在用户第一次搜索时触发、后台流式、文件间让出事件循环；`status` 给进度；之后只读增量。接受。
2. **daemon 内存**：正文上限 32 M 字符 + 空闲 10 分钟卸载。超上限逐出最旧会话正文（标题仍可搜）。
3. **索引含对话明文落盘**：与 transcript 本身同机同用户、权限 0600、可一键清除；不上传。接受。
4. **agent-home 切换**：根变化后旧根下的记录在下次刷新时删除；与导入用同一解析结果。
5. **同一 Claude 会话 id 在两个项目目录**：按文件分别索引，结果按 id 去重保留最近更新的那份（与列表 RPC 一致）。
6. **transcript 被改写而非追加**（Claude `/compact` 不改写原文件；手工编辑会）：size 变小或 ino 变化 → 整文件重读；同 size 改写且 mtime 变 → 也整文件重读（mtime 变但 size 未增长视为改写）。
7. **并发**：刷新单飞；搜索读当前快照（JS 单线程，单文件记录整体替换）。`clear` 置取消标志，刷新在下一个让出点退出且不落盘。

## 验收标准

- [x] `extract` 单测：Claude 正文/sidechain/tool_result/one-shot skip/summary 标题/harness 剥离；Codex 三种形态、harness 跳过、sub-thread skip、截断。
- [x] 增量单测：追加只读新字节、半行不提交、截断/ino 变化重读、删除文件移除、agent-home 根切换移除、上限逐出、持久化往返、版本不符重建、clear。
- [x] 查询单测：多词 AND、大小写、中文、正则特殊字符、片段与高亮区间、排序、limit/agent 过滤、同 id 去重。
- [x] RPC 单测：注册、参数校验、首次即返 indexing + 轮询后 ready、clear、能力标志 restamp。
- [x] Web 单测：能力判断、载荷宽松解析、tracked 映射、高亮切分、轮询判定；`connectMachine` 契约测试不回归。
- [x] 实跑：独立 `HAPPY_HOME_DIR` 对本机真实历史建索引（只读），记录冷建耗时、索引大小与搜索耗时。
- [x] 门禁：cli build + 相关 vitest + `--version`；web 相关 vitest + vite build + tsc。
- [x] 本地全链路（standalone server + vite + 独立 HAPPY_HOME daemon + fixture agent-home）：⌘K 进入搜索、首查 indexing→轮询出结果、中文/英文高亮、
  Codex 过滤、导入后跳转新会话、原件行变「打开」、清除索引删目录、「最近」模式不回归；1280 亮色与 390 coarse 暗色无横向溢出、按钮 44px、输入 16px。

已知限制：导入产生的副本 transcript 在其会话 `metadata.claudeSessionId` 写入前（wrapper 里 claude 尚未启动）会作为一条可「导入」的结果出现；
claude 正常启动后即映射为「打开」。

## 留真机验证项

- 窄屏（390px）搜索结果行与「打开/导入」按钮的布局观感；真实机器升级后首次建索引进度体验。
