# 文件浏览器（机器级 fs-list / fs-read）

> 状态：Shipped（分支 `feat/file-browser`）
> 日期：2026-08-13 ｜ 关联 backlog：—（Owner 直接派工） ｜ 出处：终端会话痛点

## 背景

终端里 claude 说「已写入某文件」，web 上没有任何办法直接看到它——FilesPanel 只列
git 改动文件、且走 session 级 RPC（终端会话根本没有 session）。需要一个两类会话
（web 终端 + 聊天会话）都能用的文件浏览器：浏览 cwd 下的目录、看文件内容。

## 目标

- 终端页与聊天会话页都能浏览机器上的目录（起始 = 各自 cwd）并查看文件内容。
- 旧 daemon 不支持新 RPC 时给出友好提示（不白屏、不裸报错）。
- happy-server 零改动。

## 非目标

- 不做写操作（新建/改名/删除/编辑），只读。
- 不做全盘搜索（ripgrep 已有 session 级通道）。
- 不做越权沙箱：单用户自有机器，daemon 本就暴露 `bash`；只做防呆。
- 大文件全量查看 / 下载（读取硬上限 512KB，截断提示）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 机器级 RPC 注册模式（open-terminal / list-terminals 等） | `packages/happy-cli/src/api/apiMachine.ts` |
| RpcHandlerManager 把 handler 抛错编码成 `{error}` 正常响应（B-003） | `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts:89-95` |
| 旧 daemon 未注册方法 → server 回 `RPC method not available`（与离线不可区分） | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:188-191` |
| 终端 cwd 已在 daemon push 里（`daemonState.webTerminals[].cwd`） | `packages/happy-cli/src/terminal/webTerminal.ts`（parseSessionListLine） |
| 聊天会话 cwd = `session.metadata.path`，机器 = `metadata.machineId` | `packages/happy-web-v2/src/sync/storage.ts:1208-1211` |
| session 级 readFile/listDirectory 被 cwd 沙箱限制，终端会话不可用 | `packages/happy-cli/src/modules/common/registerCommonHandlers.ts` |

## 设计

### 为什么是机器级 RPC，而不是 sessionBash `ls`

- **终端会话也能用**：web 终端没有 session，session 级 RPC 天然够不着；机器级
  RPC 只要 daemon 在线就可用，两个入口共用一条通道。
- **结构化**：`ls` 输出要解析（locale、文件名带空格/换行、平台差异全是坑）；
  RPC 直接返回 `{name,type,size,mtimeMs}`。
- **无 shell 注入面**：路径作为数据走 RPC 参数，不进 shell 拼接。
- 被否方案：session `listDirectory`/`readFile` 复用——被 cwd 沙箱限制且依赖
  session 存在；扩 session 沙箱反而破坏其设计意图。

### daemon（happy-cli）

新模块 `src/modules/fs/`：

- `fsBrowse.ts` — 纯函数（全部单测）：`normalizeFsPath`（`~` 展开、相对路径落
  home、拒 NUL、resolve 规范化）、`isBinaryContent`（前 8KB 含 NUL）、
  `compareFsEntries`（dir 优先 + 名称序，截断前先排序保证确定性）、
  `clampReadLimit`（默认且硬上限 512KB）、`entryTypeOf`。
- `fsRpc.ts` — I/O 与注册：`fsList` / `fsRead` + `registerFsHandlers`，在
  `ApiMachineClient` 构造时随 `registerCommonHandlers` 一起注册。

**RPC 形状**：

```
fs-list  { path }
  → { path,            // 规范化后的绝对路径（~ 已展开）
      entries: [{ name, type: 'file'|'dir'|'symlink', size?, mtimeMs? }],
      truncated }      // 条目 > 2000 时为 true（已按 dir 优先排序后截断）

fs-read  { path, maxBytes?, allowBinary? }
  → { path, size,      // size = 磁盘完整大小
      binary,          // 前 8KB 含 NUL
      truncated,       // content 携带字节 < size
      content? }       // base64；binary 且未 allowBinary 时不返回
```

细节决定：

- 条目 metadata 用 **lstat**（不 follow）：坏 symlink / 无权限子项不炸整个列表，
  只丢 size/mtime；`fs-list`/`fs-read` 对**路径本身**用 stat（follow），所以
  symlink 目录可进入、symlink 文件可读。
- `fs-read` 只读 regular file：目录/fifo/socket/设备一律 `not-a-file`——fifo
  永远不能挂住 daemon。
- `allowBinary`（web 图片预览用）：binary 文件默认不回 content；调用方声明
  allowBinary 才回（仍受 512KB cap，截断的图不预览）。
- 错误以稳定 code 字符串抛出：`not-found` / `permission-denied` /
  `not-a-directory` / `not-a-file` / `invalid-path`，web 侧翻译成文案。

### web（happy-web-v2）

- `sync/fsOps.ts` — `machineFsList` / `machineFsRead` 封装：**显式检查响应里的
  `error` 字段（B-003）**；`RPC method not available` / `Method not found` 归一为
  code `'unsupported'`。
- `screens/files/` — 共用浏览组件（两个入口一份代码）：
  - `FsBrowser.tsx`：面包屑 + dir 优先列表（大小/修改时间、隐藏文件切换，默认
    隐藏 dotfile）+ 加载/错误/重试态；请求带单调 seq，慢响应不覆盖新导航；
    点击 symlink 先试 list，`not-a-directory` 回退为打开文件。
  - `FsFileViewer.tsx`：复用 CodeView（shiki + CopyButton）；头部完整路径 +
    复制路径按钮；truncated 提示完整大小；binary 显示大小占位；图片扩展名 +
    完整读取（≤512KB）时 data-URI 内联预览。
  - `fsBrowseModel.ts`：排序/过滤/路径运算/格式化纯函数（单测）。
- **终端页**：header 加 FolderOpen 按钮 → 右侧抽屉（860px 以下全屏 + scrim，
  与 sd-files 同形态）。抽屉是 overlay 而非内联 sidebar——不改变终端宿主尺寸，
  避免 refit → resize RPC → tmux reflow 连锁。起始路径 = push 里的终端 cwd
  （`TerminalSession` 新增透传 `cwd` 字段），无 cwd 时 `~`。
- **聊天会话页**：FilesPanel 加第三个「浏览」tab，起始 =
  `metadata.machineId` + `metadata.path`；metadata 未同步/缺失时显示空态。
- i18n：新增 `fsBrowser.*`，只加 `_default.ts` + `zh-Hans.ts`。

## 兼容矩阵与发布顺序

| 场景 | 行为 |
|---|---|
| 新 web + 旧 daemon（< 本版本） | 方法未注册 → server 回 `RPC method not available` → UI 显示「机器离线或 daemon 需升级到 ≥ 0.2.33」提示（与离线同文案，二者在协议上不可区分） |
| 旧 web + 新 daemon | 新 RPC 无人调用；`TerminalSession.cwd` 为 web 内部派生字段，不涉及协议 |
| server | 零改动，机器 RPC 走既有 relay |

发布顺序：CLI 与 web 任意先后（互不阻塞，功能在两端都新时点亮）。回滚点：撤 web
即可（daemon 多两个无人调用的只读 RPC 无害）。

## 风险

1. **fs-read 与文件写入并发**：读到半写的文件——接受（只读预览，刷新即新）。
2. **大目录**：2000 条上限 + truncated 提示；entries lstat 并发一次性发出，
   node_modules 级目录（数万条）readdir + lstat 仍在百 ms 量级——接受。
3. **binary 误判**：前 8KB 无 NUL 的二进制（如 UTF-16 无 BOM 特例）会按文本渲
   染出乱码——接受（与 git 同一启发式）。
4. **`unsupported` 与离线不可区分**：文案同时说明两种原因——接受（协议层无法
   区分，见 rpcHandler.ts:188）。

## 验收标准

- [x] daemon 注册 `fs-list` / `fs-read`，形状如上；纯函数 + I/O 均有单测
      （`fsBrowse.test.ts`，19 例）。
- [x] 终端页 header 文件夹按钮 → 抽屉，起始 = 终端 cwd；移动端全屏 + scrim。
- [x] 会话 FilesPanel「浏览」tab，起始 = session `metadata.path`；组件共用。
- [x] 查看器：shiki 高亮 + 复制内容 + 复制路径；truncated / binary / 图片预览。
- [x] 旧 daemon → 友好升级提示；加载态 / 错误态 / 重试均有。
- [x] 门禁：三包 tsc 0 错误；cli unit 702 绿；web 411 绿；vite build 成功；
      `HAPPY_HOME_DIR=$(mktemp -d) node dist/index.mjs --version` 冒烟通过。

## 留真机验证项

- 终端抽屉在 iOS 全屏形态下的安全区/滚动观感；触屏点按目标尺寸。
- 真实大目录（node_modules）加载体感与 truncated 提示。
- 图片预览在暗色主题下的边框观感。
