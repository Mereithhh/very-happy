# 改动面板 diff 行内批注（Annotate diff → 发送给 agent）

> 状态：Draft
> 日期：2026-10-12 ｜ 关联 backlog：B-554 ｜ 出处/前身：Orca「Annotate AI Diff」（`docs/site/content/docs/review/annotate-ai-diff.mdx`，只读参考）

## 背景

审阅 agent 的改动时，用户要把「第 N 行这里不对」转述给 agent，目前只能手抄路径、行号和代码。
Orca 的做法是在 diff 上逐行留批注，攒成一批后一次性发回 agent：一轮思考、一次修改，命中率更高。

## 目标

1. 会话改动面板（Changes 标签）里点改动文件打开该文件的 git diff（相对 HEAD），diff 行可批注：
   桌面 hover 行号出「+」，手机点行出底部 sheet；支持行范围（桌面 Shift+点「+」，手机 sheet 里上/下扩展）。
2. 批注可编辑/删除；按会话保存在本机（刷新不丢），不进 synced settings。
3. 面板顶部显示「N 条批注 · 发送给 agent」，点击合成一条消息（按文件分组，含路径、行号/行范围、
   代码片段、批注内容）放进该会话输入框，然后清空批注草稿。
4. diff 刷新导致行漂移时按「内容 hash + 邻近行」重新锚定；找不到时标「已过期」，仍可发送。
5. 纯函数（unified diff 解析、重新锚定、消息合成、存储清洗）带单测；真浏览器验收 1280 与 390 coarse × 亮/暗。

## 非目标

- 不做批注回复/resolve 线程、不做多人共享（批注是本机草稿）。
- 不改 CLI、server、wire；不加 RPC、不加 Prisma migration。
- 不改聊天里 Edit/Write 工具卡片的 `DiffView`（那是工具调用快照，没有稳定的「当前文件」可锚定）。
- markdown 预览里选中文字加批注：**不做**（理由见「设计 · 被否方案」）。
- 不做 side-by-side diff、不做 diff 内搜索。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 改动列表点文件只打开文件全文（`setSelected(f.fullPath)`），面板里没有 git diff 视图 | `packages/happy-web-v2/src/screens/session/FilesPanel.tsx:240`、`:266-268` |
| 文件 tab 渲染 `FsFileViewer`（有 machineId）或 `FileView` | `FilesPanel.tsx:268` |
| `DiffView` 只服务工具卡片：入参 old/new 全文，内部 LCS（`lineDiff`），无批注能力 | `screens/session/DiffView.tsx:26-37`、`screens/session/diff.ts` |
| 改动列表来自 `sessionBash` 在会话 cwd 跑 `git status --porcelain=v2`；**路径相对该 cwd**（子目录会话里是 `sub/x.ts`、`../y.ts`，2026-10-12 本机 git 实测），文件 tab 也按 cwd 解析 | `sync/gitStatusFiles.ts:44`、`FilesPanel.tsx:268`（`resolveAgainstCwd`） |
| `bash` RPC 是 CLI 既有通用 handler（cwd 校验在工作目录内，默认 shell，非 0 退出码 → `success:false` 但带 stdout） | `packages/happy-cli/src/modules/common/registerCommonHandlers.ts:213` |
| 把文本交给已挂载输入框的既有通道：`restoreToComposer`（无输入框时返回 false）/`useHasComposer` | `screens/session/composerRestore.ts:39`、`:51` |
| 输入框接收后按 `mergeRestoredDraft` 前置合并并聚焦；输入框草稿本身已持久化（`session-drafts`） | `screens/session/AgentInput.tsx:397`、`sync/persistence.ts:138` |
| 文件面板打开时输入框仍挂载（窄屏 aside 是覆盖层） | `screens/session/SessionDetailScreen.tsx:283`、`:309` |
| 本机持久化惯例：独立 `MMKV({ id })`（localStorage 前缀隔离）+ `useSyncExternalStore` 快照缓存 | `sync/clipboardHistoryStore.ts:28` |

## 设计

### 1. Diff 来源（纯 web，复用既有 `bash` RPC）

- 改动列表行的点击改为打开 **diff tab**（tab id `diff:<repo 相对路径>`，与文件 tab 共存）；
  diff 头部提供「打开文件」回到原有文件视图，原能力不丢。
- 已跟踪文件：`git -c core.quotepath=false diff --no-color --no-ext-diff HEAD -- ":(literal)<path>"`，
  cwd = `session.metadata.path`，`<path>` 原样用 status 给的 cwd 相对路径（含 `../`）；
  `:(literal)` 防止以 `:` 开头或含通配符的文件名被当成 pathspec 语法。
  路径只含安全字符时双引号包裹（sh 与 cmd 都成立）；含 `"$\`` 等时用 POSIX 单引号转义。
- untracked 文件：不跑 git，用既有 `sessionReadFile` 读全文，渲染为全部新增。
- 解析：新纯函数 `parseGitUnifiedDiff(text) → rows[]`（hunk 头、add/del/ctx，带 old/new 行号；
  `\ No newline` 等元信息跳过；二进制 → 提示）。
- 刷新：面板刷新按钮 / 重新打开 tab 时重新拉取；拉取后对该文件批注做一次重新锚定并写回。

### 2. 批注模型（`diffComments.ts`，纯）

```ts
type DiffComment = {
  id: string; filePath: string;           // 与 git status 一致：相对会话 cwd
  side: 'new' | 'old';                     // add/ctx 行用 new 号，del 行用 old 号
  startLine: number; endLine: number;      // 该侧行号，单行时相等
  lines: string[];                         // 锚定行原文（片段；每行截 400 字、最多 40 行）
  before: string | null; after: string | null; // 同侧紧邻上一行/下一行原文
  hash: string;                            // lines 的 FNV-1a
  body: string; stale: boolean; createdAt: number; updatedAt: number;
};
```

范围只能落在同一侧连续可编号的行（new 侧 = add/ctx，old 侧 = del/ctx）。

### 3. 重新锚定（`reanchorComment(comment, rows)`，纯）

1. 取该侧行序列；原位置窗口 hash 相同 → 原位（未过期）。
2. 否则找所有 hash 相同的窗口：
   - 打分 = 前邻行相同 +1、后邻行相同 +1；同分取离原行号最近者；
   - 有候选 → 移到该处，`stale=false`。
3. 无候选 → 保留原行号，`stale=true`（仍显示在原处附近的行上作提示、仍可发送）。
4. 每次 diff 加载后对该文件全部批注计算，结果有变化才写回存储。

### 4. 消息合成（`composeDiffCommentsMessage(comments, lang)`，纯）

按文件分组（文件按路径排序、组内按行号），每条：位置（`L12` / `L12-15`，old 侧注明「删除的行，HEAD 中」）、
已过期标记、代码片段（围栏长度按片段内最长反引号串 +1）、批注正文。中英按 UI 语言。

### 5. 存储（`diffCommentsStore.ts`）

- `new MMKV({ id: 'diff-comments' })`，**每会话一个 key**（`s.<sessionId>`），JSON 数组；
  读取逐条校验（坏数据丢弃），上限 200 条/会话、正文 4000 字。
- 与 synced settings / localSettings 无关（铁律 1 不涉及）；不跨设备同步（草稿语义）。

### 6. 发送链路（二选一：放进输入框）

点「发送给 agent」→ `restoreToComposer(sessionId, message)`：

- 选输入框而不是直接 `sync.sendMessage`：发送/排队/steer/附件/`/btw` 路由/pending session/
  server queue（B-509）的全部判断都在 `AgentInput.doSend` 里，旁路直发要复制这些分支，
  且用户无法在发出前补一句总括或删改。放进输入框后走的就是现有发送链路，零新分支。
- 成功交给输入框后立即清空该会话批注草稿（文本已在输入框，输入框草稿本身持久化，刷新不丢）；
  窄屏（面板为整屏覆盖层）同时关闭面板让输入框可见。
- 无输入框（终端镜像会话等）→ 按钮不显示（`useHasComposer`）。

### 7. 交互

- 桌面（fine pointer）：hover 行时行号槽出「+」按钮；点开行下方内联编辑卡（textarea，⌘/Ctrl+Enter 保存，Esc 取消）；
  Shift+点另一行「+」把正在编辑的范围扩到该行（同侧）。
- 触屏（coarse）：点行 → 底部 sheet（显示位置与片段、16px textarea、「↑ 扩展 / ↓ 扩展」、保存/删除/取消，按钮 ≥44px）。
- 已有批注：在其末行下方显示批注卡（位置、正文、过期标记、编辑/删除）。
- 面板顶部（tab 栏下）在本会话有批注时显示一条：「N 条批注 · 发送给 agent」，以及清空。

### 被否方案

- **直接发送（走 `sync.sendMessage`）**：见第 6 节。
- **扩展 `DiffView` 承载批注**：工具卡片 diff 无稳定路径/当前文件，批注语义不成立；新组件复用 `diff.css` 视觉。
- **markdown 预览选中文字批注**：渲染后的 markdown 没有源码行号映射（`Markdown` 管线不产出 source position），
  选区无法转成行号/范围，也就无法按 hash+邻近行重新锚定；手机上还要和系统选区菜单抢交互。不是低成本复用，不做。

## 兼容矩阵与发布顺序

本特性只改 web，不改协议、不加字段、不加 RPC。

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 旧 | 旧/新 | 旧 | 不变 |
| 旧 | 旧/新 | 新 | diff 经既有 `bash` RPC（所有版本都有）/`readFile` 获取；批注本机存储；发送 = 普通用户消息。完全可用 |
| 新 | 旧/新 | 新 | 同上（CLI 无改动，新旧 CLI 等价） |
| 任意 | 任意 | 新，会话机器离线 | diff 拉取失败显示错误与重试；已有批注仍可查看/发送（发送仍走输入框，离线时由既有链路排队） |

- 消息是普通文本，旧 CLI/agent 无需理解任何新格式；server 不感知。
- 发布顺序：无约束，随下一次 server/Web 镜像发布即可。回滚：回滚 Web 镜像；本机 `mmkv:diff-comments:*` 残留无害。

## 风险

1. **大 diff**：`bash` RPC 走 `exec` 默认 1MB stdout 上限 → 失败时显示「diff 过大/获取失败」；渲染行数 >5000 时截断并提示。接受。
2. **Windows cmd 引号**：普通路径双引号在 cmd 有效；含特殊字符的路径走 POSIX 单引号，在 cmd 下可能失败 → 显示错误。接受（罕见）。
3. **重复行误锚定**：相同内容多处出现时靠邻近行 + 距离打分；仍可能落错，消息里附代码片段让 agent 自行定位。接受。
4. **localStorage 配额**：每会话 200 条×4000 字上限；写失败被 MMKV 吞掉并 warn。接受。
5. **del 侧行号来自 HEAD**：agent 提交后 HEAD 变化，旧批注按内容重锚或标过期。符合预期。

## 验收标准

- [x] Changes 标签点改动文件打开 diff tab，显示行号与 +/−；diff 头可打开原文件视图。
- [x] 桌面 hover 出「+」，点击添加、编辑、删除；Shift+点扩范围。
- [x] 390 coarse：点行出底部 sheet，16px 输入、44px 按钮、无横向溢出。
- [x] 刷新页面后批注仍在；diff 内容上移若干行后批注跟随；删掉对应行后标「已过期」。
- [x] 顶部「N 条批注 · 发送给 agent」→ 输入框出现按文件分组的消息，批注清空；窄屏关闭面板。
- [x] 纯函数单测、web tsc 0 错误、相关 vitest、vite build 通过。
- [x] 亮/暗 × 1280/390 截图取证。

## 留真机验证项

- iOS Safari 真机：点行 sheet 与软键盘的遮挡关系（sheet 内 textarea 聚焦时是否被键盘盖住）。
