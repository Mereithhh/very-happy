# 终端路径可点、复制去缩进与 ⌘P 模糊打开文件

> 状态：Draft（实现 agent 起草，待主 agent 定稿）
> 日期：2026-10-13 ｜ 关联 backlog：B-574、B-576 ｜ 参考：Orca `mobile/src/terminal/terminal-path-tap.ts`、`src/shared/terminal-selection-gutter.ts`、`src/renderer/src/components/QuickOpen.tsx`、`quick-open-history-ranking.ts`（MIT，只借鉴做法）

## 背景

- 终端里 agent 输出大量文件路径（`src/a.ts:12:3`、`Update(src/x.ts)`、`README.md`），web 终端只认 URL（WebLinksAddon），想看文件要手动去文件面板翻目录。
- 复制 Claude Code/Codex 的回答时，TUI 固定的左侧槽（2 个空格）一起进剪贴板，粘贴出来整体缩进。
- 会话页没有「按名字打开文件」的入口；项目文件列表（git ls-files）已经在 FilesPanel 里拿到了，只是没有快速查找。

## 目标

1. **B-574①** 终端里的文件路径可点：绝对、`~/`、`./`/`../`、相对 `a/b.ts`、仅文件名 `README.md`，可带 `:line[:col]`。
   - 桌面：⌘+点击（非 Mac Ctrl+点击）打开；按住修饰键悬停时下划线 + 手形，平时不出下划线。
   - 触屏：单击正好落在路径上才打开，其余单击行为不变（唤起键盘）；长按选择、选择模式、原生复制不受影响。
   - 打开 = 复用聊天 FilePathLink 的同一入口 `openFsPreview`（终端页停靠到终端工作区文件面板）。
   - 相对路径按终端 cwd（`meta.cwd`，daemon 上报的 `pane_current_path`）解析；存在性以 daemon `fs-read` 结果判定：不存在 / 是目录 → 轻提示（info toast），不打开。
   - 有行号且是代码预览时滚到该行并短暂高亮（尽力而为）。
2. **B-574②** 终端复制去公共左缩进：只去掉所有非空行共有的前导空格，保留相对缩进；覆盖 copy-on-select、⌘C/Ctrl+Shift+C（xterm 选区）、手机原生长按复制（DOM 选区在终端行内）。
3. **B-576** 会话页 ⌘P（非 Mac Ctrl+P）打开 QuickOpen：模糊匹配项目文件（文件名权重高于目录、连续匹配加分）+ 最近打开优先；回车在右侧工作区打开文件预览。手机从 ⌘K 的「打开文件…」进入。无项目文件列表时说明原因并提供「浏览文件」回退。

## 非目标

- 不改协议、不改 CLI/daemon/server，不加 Prisma migration，不改 package.json/lockfile。
- 不识别含空格的路径（Orca 有 spaced-path 规则，误判面大，首版不做）；不处理 git diff 的 `a/`、`b/` 前缀；不识别 Windows 盘符路径。
- 不改 xterm 渲染器、字体、lineHeight（铁律 9）；不引入 canvas/WebGL。
- 不改 FsFileViewer / FilesPanel（归 r3-review）：行号定位从外部对已渲染的 Shiki `.line` 节点 `scrollIntoView`，不加 viewer 参数。
- QuickOpen 不做内容搜索（只按路径），不在终端页提供 ⌘P（终端没有项目文件列表；终端页的 ⌘P 不拦截）。
- 不支持 QuickOpen 里输入 `file:line`（首版）。

## 现状事实（代码已确认，基线 origin/main `d912dcbf9`）

| 事实 | 位置 |
|---|---|
| xterm 5.5.0 DOM renderer，只加载 WebLinksAddon（URL 普通点击打开）+ Clipboard + Fit + Unicode11 | `screens/terminal/renderer/xtermRenderer.ts:46` |
| `ILink.decorations` 提供后修改会被 xterm 跟踪（可按修饰键开关下划线） | `node_modules/@xterm/xterm/typings/xterm.d.ts:1376-1381` |
| copy-on-select 直接写 `term.getSelection()` | `screens/terminal/WebTerminalScreen.tsx:2276` |
| ⌘C 走 xterm 自己在 `term.element` 上的 `copy` 监听（copyHandler 写 selectionText）；手机复制靠原生长按选中 DOM 行文字（`.xterm-rows` 强制 `user-select: text`），DOM 行里空格是 NBSP | `termInputRoute.ts:143-152` 注释、`specs/2026-09-terminal-font-and-seamless-rendering.md` L2 |
| 触屏单击由 `onTouchEnd` 判定（位移 ≤12px）后经焦点策略唤起键盘，own-input 路径会 `preventDefault` 吞掉兼容鼠标事件 → xterm 的 link 激活在触屏上不会触发 | `WebTerminalScreen.tsx:1966-1997` |
| 终端主 effect 依赖 `[machineId, tid, inputOwnership, streamRemount]`，每次重建 xterm | `WebTerminalScreen.tsx:545-2441` |
| 终端 cwd = `meta.cwd`（daemon `list-sessions` 的 `#{pane_current_path}`，跟踪周期级新鲜度） | `WebTerminalScreen.tsx:356`、`happy-cli/src/terminal/sessionListFormat.ts:91` |
| `openFsPreview` 窗口事件；FsPreviewOverlay 按 `previewDockTarget` 停靠：`/terminal/:machineId?tid=` 与 `/session/:id`（同机）都改写 `?panel=browse&pinFile=` 进右侧面板，否则弹 overlay | `sync/filePreviewOpen.ts`、`screens/files/previewPinTarget.ts:3-19`、`FsPreviewOverlay.tsx:132-157` |
| FilePathLink：`resolveAgainstCwd(path, metadata.path)` → `openFsPreview({sessionId, machineId, path, mode:'file'})` | `screens/session/FilePathLink.tsx:36-47` |
| daemon `fs-read`：`~` 展开，**相对路径按 HOME 解析**（不是终端 cwd），`resolve()` 规范化；目录 → `not-a-file`，ENOENT → `not-found`；`maxBytes` 可取 1 | `happy-cli/src/modules/fs/fsBrowse.ts:39-56`、`fsRpc.ts:122-128` |
| web `machineFsRead` 把 daemon 错误映射成 `not-found / not-a-file / unsupported / timeout …`，不抛异常 | `sync/fsOps.ts:105-142` |
| 代码预览用 CodeView + Shiki，输出 `<span class="line">` 每行一个 | `screens/files/FsFileViewer.tsx:263-266`、`screens/session/CodeView.tsx:73-76` |
| 项目文件：`getProjectFiles(sessionId)` 经 `sessionBash` 跑 `git ls-files --cached --others --exclude-standard`，失败（非 git / wrapper 不在线 / 旧 CLI 无 bash RPC）返回 null；缓存在 `pathProjectFiles[machineId:path]`，`useSessionProjectFiles` 读取 | `sync/projectFiles.ts:24-54`、`sync/storage.ts:1956`、`screens/session/useFiles.ts:17-50` |
| ⌘K 用 `isAppChord`（mac=⌘、其它=Ctrl）window capture；命令项是 `CommandItem` 数组，`currentSessionId` 从路由取 | `screens/command/CommandPalette.tsx:109-121, 172-175` |
| 会话页右侧面板由 `?panel=` 驱动，`browse` = 文件浏览 | `screens/session/SessionDetailScreen.tsx:62`、`sessionPanelState.ts:29` |

## 设计

### D1 复制去公共左缩进 `screens/terminal/termSelectionGutter.ts`

改写自 Orca `terminal-selection-gutter.ts`（文件头注明来源）：

- 按 `\n` 切行，CR 随行保留；只统计前导 **空格**（DOM 选区先把 NBSP 归一为空格）；空行/纯空白行不参与计算；
  共同缩进 = 非空行前导空格数的最小值；为 0 原样返回。tab 不算空格：tab 开头的行共同缩进为 0（不动）。
- 挂钩点（最小改动）：
  1. copy-on-select：`WebTerminalScreen.tsx` 那一行改成 `stripTerminalSelectionGutter(term.getSelection())`。
  2. ⌘C 与手机原生复制：`useTermPathLinks` 里在 `document` capture 阶段监听 `copy`：
     xterm 有选区且事件来自终端内 → `setData(去缩进后的 selectionText)` + `preventDefault` + `stopPropagation`（先于 xterm 自己的 copyHandler）；
     否则若 DOM 选区完全落在本终端 `.xterm-rows` 内 → 取 `selection.toString()` 归一 NBSP、去缩进后写入。
     其余情况不干预（不影响页面其它地方的复制）。去缩进后与原文相同也不干预。

### D2 路径识别纯函数 `screens/terminal/termPathLinks.ts`

- `findPathCandidates(text)`：在一条逻辑行（软折行拼接）里找候选 `{start, end, pathText, line, col}`：
  - token 字符集 `[\p{L}\p{N}_.~\-/+@%]`，可带 `:line[:col]`；先找出 `scheme://…` URL 区间并跳过与之重叠的 token（URL 归 WebLinksAddon）；`file://` URL 转成路径。
  - 去掉尾随 `.`；含 `/` 的：拒绝以 `/` 结尾（目录）、含 `//`、不含任何字母（`1/2`、`12:30`）；
  - 不含 `/` 的仅文件名：需要扩展名以字母开头（`name.ext`，ext ≤10 位）或是点文件（`.env`），拒绝 `e.g`/`i.e` 等停用词。
  - 误判兜底由存在性检查负责（不存在只给轻提示）。
- `candidateAt(candidates, index)`；`resolveTerminalPath(pathText, cwd)`：绝对/`~` 原样；相对按 cwd 拼接并规范 `.`/`..`；cwd 缺失返回 null（不能交给 daemon——它会按 HOME 解析，打开错文件）。
- 行与单元格映射复用 `termSearch.ts` 的逻辑行拼接与 cell map（导出 `rowText`/`buildCellMap`），宽字符按 2 格；
  `linkRangesFor(map, start, end)` 给出 xterm `IBufferRange`（1-based、end 含）。

### D3 接线 `screens/terminal/useTermPathLinks.ts`（新模块，WebTerminalScreen 只加 3 行挂钩）

- `term.registerLinkProvider`：`provideLinks(y)` 取 y 所在逻辑行的候选，返回与 y 相交的 link。
  `decorations` 初值按「最近一次鼠标事件是否按着修饰键」，hover 期间监听 keydown/keyup 动态开关（xterm 跟踪该对象）。
  `activate(e)`：仅 `isMac ? e.metaKey : e.ctrlKey` 时打开；普通单击维持现状（聚焦/选择）。
- 触屏：`onTouchEnd` 开头一行 `if (pathTap.consume(e, distanceSquared)) return;`。`consume` 在以下条件全满足时打开文件并 `preventDefault`（不唤起键盘、不产生兼容鼠标事件）：
  非选择模式、位移 ≤12px、按下时长 <500ms（长按不算）、当前无非折叠 DOM 选区、xterm 无选区、触点所在单元格正好落在一个候选上。
  否则返回 false，原 tap 流程不变。
- 打开流程 `openTerminalPath`：`resolveTerminalPath` → `machineFsRead(machineId, abs, {maxBytes: 1})`：
  `not-found` → info toast「没有找到文件」；`not-a-file` → info toast「这是目录」；
  其它（成功 / unsupported / timeout / unknown）→ `openFsPreview({machineId, path: abs, mode:'file'})`（失败态由 viewer 自己展示）；
  有行号 → `revealPreviewLine(abs, line)`：≤4s 内轮询面板里 path 匹配的 `.fsb-viewer` 下的第 N 个 Shiki `.line`，`scrollIntoView({block:'center'})` 并加 1.6s 的 `vh-line-flash` 类。
- 生命周期：hook 在主 effect 之后声明、同样以 `[machineId, tid, inputOwnership, streamRemount]` 为依赖，随 xterm 重建重新注册，dispose 全部 listener。

### D4 QuickOpen `screens/quickopen/`

- `quickOpenScore.ts`（纯函数）：
  - `scoreQuickOpen(query, fullPath)`：query 去空白、小写；全部字符需按序出现（子序列），否则 null。
    先尝试只在文件名内匹配（基础分高 + 连续命中加分 + 词首/分隔符后命中加分 + 文件名前缀加分），失败再在全路径匹配（基础分低）；
    路径越短略加分（同分时浅层优先）。`/` 结尾或含 `/` 的 query 走全路径匹配。
  - `rankQuickOpen(query, files, history, limit=50)`：空 query → 最近打开（仍在列表中的）在前，其余按路径字典序；
    非空 → 按分数排序，最近打开的命中加一档 recency bonus（越近越高），返回匹配下标用于高亮。
- `quickOpenHistory.ts`：`localStorage['vh.quickOpen.history.v1']` = `{ [machineId:path]: string[] }`，每项目最多 20 条，最新在前；读写全部 try/catch，失败当空。
- `QuickOpen.tsx`：会话页内挂载（`SessionDetailScreen` 加 1 行），监听：
  - window capture keydown：`isAppChord(e) && e.code==='KeyP' && !shift && !alt` → `preventDefault`（拦掉浏览器打印）并打开。只在会话页挂载，所以只在会话页生效；
  - `vh:quick-open` 窗口事件（⌘K 命令项触发）。
  - 打开时用缓存列表并后台刷新（同 `useSessionFiles` 的 SWR）；输入框 16px（触屏）/ IME 守卫；↑↓ 选择、Enter 打开、Esc 关闭；
    打开 = `openFsPreview({sessionId, machineId, path: resolveAgainstCwd(fullPath, metadata.path), mode:'file'})` → 停靠右侧面板；写历史。
  - 无列表（null 且不在加载）：说明「这个目录不是 git 仓库，或这台机器的 CLI/会话暂不支持列文件」+「浏览文件」按钮（`?panel=browse`）。会话没有 machineId/path 时同样走说明。
- ⌘K：`CommandPalette.tsx` 在 `currentSessionId` 存在时追加一项 `action:quick-open`「打开文件…」（hint `⌘P`），run = `openQuickOpen()`。

## 兼容矩阵与发布顺序

纯 Web 改动，不新增/修改任何 wire 字段、RPC 或 server 行为；只使用已有 RPC：`fs-read`（daemon ≥0.2.33）、session `bash`（git ls-files，已有 FilesPanel 在用）。

| CLI(daemon+wrapper) | server | web | 行为 |
|---|---|---|---|
| 新/旧（≥0.2.33） | 新/旧 | 新 | 全功能。 |
| 旧（<0.2.33，无 fs-read） | 任意 | 新 | 路径点击：`fs-read` → `unsupported`，照常 `openFsPreview`，viewer 显示既有「需升级」提示；不报错不卡死。 |
| 旧（wrapper 无 bash RPC / 会话离线） | 任意 | 新 | QuickOpen：`getProjectFiles` 返回 null → 显示说明 + 「浏览文件」回退。 |
| 任意 | 任意 | 旧 | 无新功能，行为与今天一致。 |

- 终端 `meta.cwd` 缺失（极旧 daemon / 刚创建尚未跟踪）：相对路径 → 轻提示「无法确定终端目录」，绝对/`~` 路径照常。
- 发布顺序：无约束（只发 server/Web 镜像即可，不需要 CLI 发版）。回滚：回滚 Web 镜像。
- 不改任何消息/状态 schema，铁律 4/14 不涉及新字段。

## 风险

1. **仅文件名误判**（`node.js`、`example.com`）：桌面需修饰键，不会误触；触屏单击会尝试打开 → 不存在只给轻提示、且这次单击不弹键盘。接受；停用词表兜常见缩写。
2. **触屏单击与键盘焦点竞争**：路径单击 `preventDefault` 且跳过 tap 分发，键盘不会被唤起；非路径单击完全走原流程。长按（≥500ms）/选择模式/已有选区一律不拦。
3. **⌘C 覆盖 xterm copyHandler**：仅在 xterm 有选区时接管，写入的就是 xterm 的 selectionText 去缩进；去缩进结果与原文相同则不接管。
4. **原生复制被改写**：只在 DOM 选区完全落在本终端 `.xterm-rows` 内时改写，NBSP 归一为普通空格（原来粘贴出的 NBSP 本身就是坑）。
5. **行号定位依赖 viewer DOM**（`.fsb-viewer-path` title、Shiki `.line`）：结构变了只是不滚动，不报错；markdown 渲染态/图片没有行概念，不定位。
6. **⌘P 拦截浏览器打印**：只在会话页挂载期间拦截；终端页与其它页面不变。Ctrl+P 在非 Mac 的会话页输入框里本来就是打印（无 readline 语义），拦截无损。
7. **大仓库（10 万文件）打分开销**：每次输入 O(N·|q|)，用 `useDeferredValue`，结果截断 50 条；打分为线性子序列扫描，无回溯。

## 验收标准

- [ ] `termSelectionGutter` 单测：代码块、YAML、全空行、tab、CRLF、NBSP、起点在行中（共同缩进 0）原样返回。
- [ ] `termPathLinks` 单测：绝对 / `~/` / `./` / `../` / 相对 / 仅文件名 / `:line:col` / 括号包裹 / 尾句号 / URL 内部不识别 / `file://` / 版本号与时间不识别 / cwd 解析与 `..` 规范化 / 宽字符行的 cell 映射。
- [ ] `quickOpenScore` 单测：文件名优先于目录、连续匹配加分、非子序列不命中、最近打开排序、空 query 行为。
- [ ] `quickOpenHistory` 单测：localStorage 抛错时不崩、去重、上限。
- [ ] 真浏览器（隔离 daemon + 私有 tmux socket）：1280 桌面 ⌘+点击打开文件、普通单击不打开、相对路径按 cwd、不存在提示、行号滚动；390 coarse 单击路径打开且不弹键盘、单击空白照常；复制去缩进；会话页 ⌘P / ⌘K「打开文件…」/ 无 git 回退；亮暗两主题无横向溢出。
- [ ] web tsc 0 错、相关 vitest、vite build 通过。

## 留真机验证项

- iOS Safari：单击路径打开文件不弹键盘；长按选择 + 系统「拷贝」去缩进后的结果；选择模式下单击不打开。
- Android Chrome：同上（兼容鼠标事件被 preventDefault 后无二次聚焦）。
