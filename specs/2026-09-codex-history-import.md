# 导入 Codex 对话（codex TUI / `codex exec` / Codex 桌面版 thread → very-happy 会话）

> 状态：Shipped（PR #368 → `main@90ab515a`，web/server 2026-09-14 blue 槽 generation 139；CLI v0.2.139 npm latest 已 promote、六平台 smoke 全绿）
> 日期：2026-09-14 ｜ 关联 backlog：B-464 ｜ 出处：Owner 2026-09-14「需要支持 codex 对话导入功能」｜ 前身：`2026-09-claude-history-import.md`（B-290）

## 背景

Codex 的所有入口——`codex` TUI、`codex exec`、Codex 桌面版 / IDE 扩展、以及 very-happy 自己起的 app-server 会话——都把 thread 写到同一处：
`<CODEX_HOME|~/.codex>/sessions/<yyyy>/<mm>/<dd>/rollout-<时间戳>-<threadId>.jsonl`（本机实测 30 份，0.137 → 0.154 四个版本；另有 `session_index.jsonl`
记录 Codex 给 thread 起的名字，`state_*.sqlite` 里有同样的元数据但**打开它就会碰 thread 锁**——B-461 的教训，扫描绝不能开 sqlite）。
very-happy 已经会「接着一条 thread 聊」：`thread/fork` + `thread/resume`（会话 fork、消息回退都在用）。缺的只是「找到那些不是 very-happy 起的 thread」，
以及一个不留孤儿的导入路径。

## 目标

- Web 一键把机器上任意 Codex thread 导入为 very-happy 会话，历史完整可继续；与 Claude 导入同一个对话框、同一套多选/进度。
- 原件不动（fork 语义），导入过的原件不再出现在列表里。
- 旧 daemon 零破坏：无能力标志时对话框显示升级提示。

## 非目标

- 不做「搬走/删除原件」、不做双向同步。
- 不解析整份 rollout（只读文件头）；不读 sqlite。
- 不导入 very-happy 自己起的 thread（`originator: happy-codex`）。

## 现状事实（代码与本机数据已确认）

| 事实 | 位置 / 证据 |
|---|---|
| rollout 首行 `session_meta.payload` 含 `id / cwd / originator / source / cli_version / git.branch / timestamp`；`base_instructions` 全文内嵌，首行 22–35 KiB | 本机 30 份全部如此 |
| 「人打的那句」三种形态：`event_msg.user_message.message`（≤0.140）、`event_msg.item_completed.item(UserMessage).content[].text`（0.154）、`response_item.message(role user).content[].input_text`（各版本都有，但**第一条**是 AGENTS.md + `<environment_context>` 拼装，真提示是 `turn_context` 之后那条） | 09-13 / 08-31 / 06-10 三份样本逐行核对 |
| very-happy 起的 app-server 在 initialize 里自报 `clientInfo.name = 'happy-codex'`，Codex 把它写成 `originator` | `codexAppServerClient.ts:543`；本机 22/30 份为 `happy-codex` |
| `thread/fork` 返回带 `turns` 的 thread 并把 fork 设为 client 当前 thread；`mapCodexThreadToSessionEnvelopes` 已能把 thread 回放成会话消息 | `codexAppServerClient.forkThread`、`runCodex.ts` 的 FORK BACKFILL |
| daemon 侧已有 `withCodexAppServerClient`（临时起一个 app-server） | `apiMachine.ts:157` |
| Claude 导入的原子性靠「daemon 先 copy 再 spawn、失败即删副本」 | B-290 spec 设计 3 |

## 设计

1. **daemon RPC `codex-list-history`**（`apiMachine.ts`）：参数 `{ directory?, limit?(≤200, 默认 60), exclude?: uuid[] }`。
   实现 `codex/utils/codexSessionHistory.ts`：递归 `stat` `sessions/**/rollout-*.jsonl`，按 mtime 倒序，只读前 **256 KiB**（比 Claude 的 64 KiB 大：真提示前面有
   session_meta + developer message + AGENTS.md 块）取 `cwd` / 首条用户提示（三种形态按新→旧优先，剥 `<environment_context>` 等 harness 块）/
   `source` / `originator` / `git.branch` / `cli_version` / 首个 timestamp；`session_index.jsonl` 整份读入作 thread 名字 → `summary`；
   `originator === 'happy-codex'` 直接跳过；同一 thread id 多份文件只留最新；达到 `limit` 即停（`truncated:true`）。纯函数 + 临时目录测试 ×8。
2. **能力标志** `daemonState.codexHistory = { rpcAvailable, detectedAt }`，与 `claudeHistory` 同处 restamp。
3. **daemon RPC `codex-import-session`**：参数 `{ directory, codexThreadId, approvedNewDirectoryCreation?, permissionMode?, title? }` =
   `spawnSession({ agent:'codex', importCodexThreadId, importTitle, … })`，**不带 `--resume`**，spawn 的三种结果原样透传。
   **fork 在 wrapper 里做，不在 daemon 做**——与 Claude 相反，理由：fork 需要活的 app-server；daemon 先 fork 再 spawn 的话，spawn 被拒（目录不存在待确认、机器掉线）
   时 fork 没人回收，而 Codex 删了 rollout 文件 sqlite 行还在，没有干净的「discard」。放进 wrapper 后：spawn 被拒 = 什么都没创建；fork 失败 = 会话失败，
   与 `--resume` 失败同形。
4. **wrapper**：`daemon/run.ts` 把 `importCodexThreadId`（只认 UUID）导出为 `HAPPY_IMPORT_CODEX_THREAD_ID`；`runCodex.ts` 建 metadata 时就写
   `importedFromCodexThreadId`（fork 失败也能被列表排除）和 `summary`（`HAPPY_IMPORT_TITLE`，同 B-294）；connect 后、FORK BACKFILL 前调
   `codex/importCodexThread.ts`：`client.forkThread({ threadId, cwd, mcpServers })` → 校验拿到的是新 id → metadata `codexThreadId = fork` →
   回放 fork 的 turns（fork 响应没带 turns 才 `readThread(fork)`，**永不读原件**）→ 状态消息。reconnect（daemon 重启接管）不走这段：metadata 里已是 fork，
   daemon 用 `--resume <fork>` 恢复。
5. **Web** `ImportHistoryModal`（原 `ImportClaudeHistoryModal` 改名，三处入口 + `connectMachine` 契约测试同步）：顶部「来源」单选 Claude Code / Codex，
   切换即重新拉列表、清选择；行的来源标签按 `originator`（`codex-tui`→codex CLI、`codex_exec`→codex exec、`Codex Desktop`）回退到 `source`；
   机器上没装 Codex 时列表照常显示但导入按钮禁用并提示。纯逻辑在 `claudeHistoryImport.ts`：条目统一成 `{ id, agent, … }`，多选/进度/汇总不分 agent。
   入口：侧栏「+」菜单、⌘K、机器页（按 `codexHistorySupported` 出现）。
6. **去重**：daemon 合并 `readTrackedCodexThreadIds()`（`sessions.json` 里每个会话的 `codexThreadId` + `importedFromCodexThreadId`，不套 14 天剪枝）与 web 传来的
   `exclude`（`trackedCodexThreadIds` 读 raw `storage.sessions`）；加上 `happy-codex` originator 过滤，very-happy 自己 fork 出来的副本天然不进列表。

否掉的方案：`--resume` 原件不 fork——与 Codex 桌面版共用一条 thread 会双写者；daemon 侧 `withCodexAppServerClient` fork——见设计 3。

## 兼容矩阵与发布顺序

| 端 | 新字段/RPC | 旧端行为 |
|---|---|---|
| daemon → web | `daemonState.codexHistory` | 旧 web 忽略；新 web 见不到标志只显示升级提示，不调 RPC |
| web → daemon | `codex-list-history`、`codex-import-session`、`spawn-happy-session.importCodexThreadId` | 旧 daemon 无标志故不会被调；即使被调也忽略未知字段 |
| CLI → server/web | `metadata.importedFromCodexThreadId` | 旧 web schema 剥掉该字段（只影响去重展示） |

顺序：server/web（同镜像）→ CLI tag v0.2.139 → 机器升级 daemon。回滚点：上一 live SHA / v0.2.138。

## 风险

1. 大量 rollout 扫描——只 stat + 读头、按 mtime 截断；256 KiB × 60 份 = 15 MB 读，本机 30 份 < 100 ms。接受。
2. 老版本 Codex 的 rollout 没有 `user_message` 事件——回退到第二条 `response_item` user 消息，harness 前缀按开头特征识别；识别不出只是标题难看，不影响导入。
3. `thread/fork` 在旧 Codex 版本行为不同——wrapper 校验 fork id ≠ 原 id，否则报错不接着聊（避免悄悄双写原件）。
4. 机器上没装 Codex——列表能出（只读文件），导入按钮禁用并提示。
5. cwd 已不存在——走与新建会话相同的「创建目录？」确认；拒绝时机器上什么都没创建。

## 验收标准

- [x] `codexSessionHistory` 单测 ×8：三种提示形态、harness 剥离、截断、非 rollout/无 cwd/无提示拒绝、index 名字、排序/limit/exclude/directory、同 id 去重。
- [x] `codex-list-history` / `codex-import-session` RPC 单测 ×6（含 sessions.json 排除、参数校验、spawn 三种结果透传、`run.ts` env 源码断言）。
- [x] `importCodexThread` 单测 ×4（fork+metadata+回放、无 turns 时只读 fork、同 id/后端错误、`runCodex` 接线源码断言）。
- [x] web 纯函数测试（Codex 解析、tracked、来源标签、通用选择/汇总）；changelog 条目测试；`connectMachine` 契约测试。
- [x] 门禁：PR #368 全绿；本地 wire/web/cli/server 门禁通过（web 4 个文件在未改动 main 上同样失败：Node 26.7 无 `localStorage`，CI 绿）。
- [x] 线上：`check-shipped` 命中 `2026-09-14-codex-history-import` / `codex-list-history`；health ok。
- [ ] 真机：机器升级后在 veryhappy.dev 导入一条 codex CLI thread 并继续（V-153，Owner 清账）。
