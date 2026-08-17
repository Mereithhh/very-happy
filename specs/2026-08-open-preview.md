# `open_preview` —— claude 主动把 web 端切到某个文件的预览

> 状态：Draft
> 日期：2026-08-17 ｜ 关联 backlog：B-131 ｜ 前置：B-130（`2026-08-agent-guidance.md`）
> 拆分自：原 `2026-08-agent-tool-surface.md`
> **2026-08-17 Owner 收范围为「只要 web 起的 session + 聊天会话」**：终端里手打的裸
> claude 出范围，于是 daemon 那一段（`POST /preview` + `apiMachine.pushFilePreview`）
> 整个不需要——推送链路从五跳变四跳，只留 session 侧。

## 背景

claude 写完一个文档/报告/图，用户要看得自己去文件浏览器里翻。B-047/B-087 已经把
文件浏览与预览做齐了（md 渲染 / 图片 / PDF / shiki 高亮），缺的只是「让 claude 主动把
web 端指过去」这一下。

## 目标

- claude 调 `open_preview(path)` 后，用户已打开的 web 客户端弹出该文件的预览。
- 复用既有 `FsFileViewer`，不改 `FsBrowser`（冲突热区邻域，且没必要）。
- 不引入新的文件访问能力，也不引入新的明文信息面。

## 非目标

- 不做 URL 深链 / 可分享（选中路径不进 URL，见风险 5）。
- 不做 diff 模式的实现（只留参数位，实现依赖 B-036）。
- 不改 `FsBrowser`、不改现有两个宿主（终端抽屉 / 会话 FilesPanel）。
- **不覆盖 web 终端里手打的裸 claude**（B-130 同步收的范围）：那条要走用户手动注册的
  stdio MCP + daemon control server，是本 spec 删掉的那一半。terminal-mirror 影子
  会话同理出范围（里面的 claude 是终端里手打的）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| `FsFileViewer` **已自包含**：props 就是 `{ machineId, path, onClose, fullscreen, onToggleFullscreen }`，不依赖 `FsBrowser` | `packages/happy-web-v2/src/screens/files/FsFileViewer.tsx:55-61` |
| 已支持 markdown 渲染 / 图片 Blob / PDF iframe / shiki 文本，按扩展名判别 | `packages/happy-web-v2/src/screens/files/fsPreviewModel.ts:17` |
| 内容走机器级 RPC `fs-read`（512KB/次，大文件按 offset 串行拼） | `packages/happy-web-v2/src/sync/fsOps.ts`、`fsPreviewModel.ts:90` |
| **`fs-read` 无 cwd 沙箱，是有意设计**（注释原文 "No cwd sandbox by design (single-user daemon that already exposes `bash`)"） | `packages/happy-cli/src/modules/fs/fsRpc.ts:10` |
| 选中文件只活在 `FsBrowser` 局部 state，无 store、无路由 | `FsBrowser.tsx:59`、`src/app/AppRoot.tsx:115-127` |
| singleton overlay 挂载点 + window-event 开法先例 | `src/screens/AppLayout.tsx:146`、`src/screens/clipboard/ClipboardHistoryPanel.tsx:44-47` |
| clipboard relay 的载荷是**加密**的：`encodeBase64(encrypt(key, variant, text))` + `enc: true`。**范围内要照抄的是 session 侧那条**（machine 侧是 daemon 路径，已出范围） | session 侧 `packages/happy-cli/src/api/apiSession.ts:666`；machine 侧 `apiMachine.ts:212`（仅作参照） |
| 工具挂在每会话的 http MCP 上，与 `change_title`/`copy_to_clipboard` 同处；`allowedTools` 自动派生 | `src/claude/utils/startHappyServer.ts:40,73,170-174`、`runClaude.ts:891` |
| 聊天会话的 machineId 在 session metadata 里 | `packages/happy-web-v2/src/sync/storage.ts` 的 `session.metadata.machineId` |
| server 纯 relay 不解密；来源身份只从**已认证连接**盖章；每字段显式转发；1MB 字符硬顶 | `packages/happy-server/sources/app/api/socket/clipboardHandler.ts:28, 39-46, 50-60` |
| server 无 catch-all，每个事件名显式注册 | `packages/happy-server/sources/app/api/socket.ts:209-218` |
| web 侧 `apiSocket.onMessage` 是 **Map 语义，一个事件名只能有一个 handler** | `packages/happy-web-v2/src/sync/apiSocket.ts:138-141`；注册点 `sync.ts:2208` |
| 解密要处理 key 未就绪竞态（push 与首次同步赛跑，12s 轮询等待） | `packages/happy-web-v2/src/sync/clipboardPush.ts:36-70` |
| 通用 ephemeral 广播通道存在，但承载的是**明文状态**（`activity` / `machine-activity` / `usage` / `machine-status` / `session-event`） | `packages/happy-server/sources/app/events/eventRouter.ts:166-195, 266-278` |

## 设计

### D1. 新 relay 事件 `file-preview-push`，载荷=**加密后的路径**

照 clipboard 的 session 侧链路，**四跳**：http MCP 工具 → `apiSession.pushFilePreview`
→ server relay → web。**只推路径、不推内容**：web 收到后用既有 `machineFsRead` 自己拉。

（终端路径出范围后，daemon 的 `POST /preview` + `controlClient` + `apiMachine` 这三段
全部不需要——这是本次收范围省下的主要工作量。）

这样 (a) 不引入任何新的文件访问权限——`fs-read` 本就暴露；(b) 绕开 1MB relay 上限，
大文件/图片/PDF 全部走既有分段读取。

**路径必须加密**，用与 clipboard 完全相同的原语
（`encodeBase64(encrypt(key, variant, path))` + `enc: true`）。

> ⚠️ 这是本 spec 第一版写错的地方：当时把「server 只转发一个字符串路径」当成安全**优点**
> （"攻击面最小"）。实际上这条通道上的兄弟载荷（clipboard、fs RPC）**全部是 E2E 加密的**，
> 明文路径会成为唯一的例外。而文件路径本身就泄露项目名/客户名/目录结构
> （`/Users/jojo/code/github/<公司项目>/…`），对 Owner「公司/个人/副业严格隔离」的纪律
> 是实质回退。加密的成本几乎为零（原语现成），没有任何理由不加。

**为什么用独立 relay 事件而不是通用 ephemeral 通道**（`specs/README.md` 要求写清取舍）：
ephemeral 是**明文状态**广播通道（现有 5 种 payload 全是 activity/usage/status 这类
无敏感内容的状态），把加密载荷塞进去会破坏它的语义；而 clipboard 已经确立了
「加密载荷 + server 盖章来源 + 纯 relay 不落库」这一模式，`file-preview-push` 与它同构，
复用其全部教训（来源不信事件体、逐字段显式转发、key-wait 竞态处理）。

### D2. machineId 的来源

只有 session 一种来源：server 从已认证连接盖章 `sessionId`（沿用 clipboardHandler
「来源只信认证连接、绝不信事件体」的做法），web 侧再用
`session.metadata.machineId` 映射出机器。

⚠️ 映射失败（metadata 里没有 machineId）要显式降级提示，不能静默什么都不发生。

### D3. 展示：singleton overlay

新建 `FsPreviewOverlay`，挂在 `AppLayout.tsx:146` 的 `<ClipboardHistoryPanel />` 旁边，
内部直接渲染 `<FsFileViewer machineId path … />`。投递策略与 clipboard 一致
「所有 web client 都收」，受一个 localSetting 开关控制（默认开，手机端可关）。
overlay 不抢焦点，Esc / 点遮罩关闭。

`mode: 'file' | 'diff'` 只留参数位；B-036 未做时 diff 降级为普通预览并在顶部提示。

### D4. 敏感路径 denylist（新增的安全要求）

`open_preview` 引入了一个**新的读文件主体**：原来读任意文件需要**用户主动导航**，
现在是**模型**指定路径、web 自动拉取并渲染。能力面没变（`fs-read` 本来就无沙箱），
但被 prompt injection 的模型可以 `open_preview('~/.secrets/env/tanka.env')`
把凭据直接渲染到屏幕上。

因此在 **http MCP 的工具 handler 入口**（`startHappyServer.ts`）做 denylist——
即 CLI 侧、模型请求刚落地的那一刻，**不是**在 web 侧（web 可以被绕过）：

- 命中 `~/.secrets/**`、`~/.ssh/**`、`~/.claude.json`、`**/.env`、`**/.git/config`、
  `**/*.pem`、`**/*.key` 的路径 → 拒绝，返回明确错误让 claude 知道被拒。
- denylist 是纯函数模块 + 单元测试（符合 CLAUDE.md「新逻辑尽量抽纯函数模块」）。
- ⚠️ 这只挡 `open_preview` 这一条新入口，**不改变 `fs-read` 本身无沙箱的既有事实**
  （用户手动导航仍可看这些文件——那是用户的自主行为，不是模型的）。

## 兼容矩阵与发布顺序

| 端 | 新 CLI 发 `file-preview-push` | 旧 CLI（不发） |
|---|---|---|
| **新 server + 新 web** | 正常工作 | 无事发生（工具不存在，claude 收到 tool-not-found） |
| **新 server + 旧 web** | 旧 web 无该事件 handler → `apiSocket.onMessage` 未注册的事件名被忽略，不报错不白屏；claude 以为成功 | 无事发生 |
| **旧 server + 新 web** | **旧 server 未注册该事件名 → 事件被静默丢弃**，claude 报告已预览、用户端毫无反应 | 无事发生 |
| **旧 server + 旧 web** | 同上，静默丢弃 | 无事发生 |

**发布顺序必须严格 server → web → CLI**：server 先注册事件名，web 先具备接收能力，
最后才让 CLI 有能力发出。否则会撞上上表右下角那种最难排查的静默失败。

**回滚点**：server 改动是纯新增 handler，回滚 = 摘掉注册；CLI 回滚到不注册新工具即可；
web 侧多余的 handler 空转无害。

⚠️ **SW 缓存混版**（CLAUDE.md 点名反复重现的坑）：用户同时开着新旧两个 web tab 是常态，
旧 tab 收到事件会静默忽略。验收时先硬刷新 / unregister 再判断「没生效」。

## 风险

1. **旧 server 静默丢事件**——见兼容矩阵。缓解：严格发布顺序 + 工具返回值明说
   「已请求预览，不保证用户已看到」（见风险 8）。
2. **daemon 离线但 session 存活**：web 拿到路径后要用 `machineFsRead` 拉内容，
   该 RPC 要求目标机器 daemon 在线。终端路径下 daemon 必然在线，但 **SDK session 是
   独立进程**——daemon 挂了、session 还活着时，push 成功、web 拉取失败，正是「claude 说
   已预览、用户端空白」。缓解：overlay 对 `fs-read` 的 `unsupported`/超时要显示明确的
   「机器不在线，无法读取」而不是空白或转圈。
3. **prompt injection 导致敏感文件被渲染**——见 D4 denylist。
4. **手机端被动弹预览的打扰**。缓解：localSetting 开关 + overlay 不抢焦点。
5. **无 URL 深链**：overlay 关掉找不回来，也不能分享到另一台设备。接受——clipboard
   的 history 面板是同样取舍。后续要深链再加 `machine/:id/file/*` 路由。
6. **key 未就绪竞态**：push 与首次 machines/sessions 同步赛跑。缓解：照抄
   `clipboardPush.ts:36-70` 的 12s 轮询等待。
7. **`onMessage` 是 Map 语义**，一个事件名只能一个 handler——注册时别覆盖既有的。
8. **成功语义空洞**：事件已转发 ≠ 用户看到了。缓解：工具 description 与返回值都明说
   「已请求在你的 web 端打开预览，无法确认你是否已查看」，避免 claude 基于「已预览」
   做后续推断。

## 验收标准

- [ ] 在**聊天会话**里让 claude 调 `open_preview`，所有已打开的 web 客户端弹出 overlay
      并正确渲染 md / 图片 / PDF / 代码四类文件。
- [ ] 把会话切到 **local CLI 模式**后再调一次，同样生效（两种模式都走同一个 http MCP，
      但要实测确认——`loop.ts` 的模式切换会重起 claude 进程）。
- [ ] 抓包/日志确认 relay 上传的是**密文**路径（`enc: true`），server 侧看不到明文路径。
- [ ] 关掉 localSetting 开关后不再弹出。
- [ ] denylist 纯函数单元测试：`~/.secrets/env/x.env`、`~/.ssh/id_ed25519`、
      `~/.claude.json`、`a/.env`、`.git/config` 全部被拒；普通路径全部放行。
      且**验证过它在未加 denylist 的代码上真的红**。
- [ ] daemon 停掉、聊天会话仍存活时调 `open_preview`（这是范围内最现实的失败路径，
      见风险 2），overlay 显示「机器不在线」而不是空白/转圈。
- [ ] session metadata 缺 machineId 时有显式提示，不是静默无反应。
- [ ] 旧 web 端（硬刷新前的旧 SW 版本）收到该事件不报错、不白屏。
- [ ] 门禁：web 三件套（vitest / vite build / tsc 零新增）、cli（test + 运行冒烟）、
      server（tsc + vitest）全绿。

## 留真机验证项

- 手机端 overlay 的观感与打扰程度（弹出时机、是否遮挡终端输入区、Esc/返回手势）。
- 图片/PDF 在 iOS Safari PWA 里的 Blob URL 行为（`FsFileViewer` 有 >3MB data URI 会挂的
  历史教训，overlay 路径要复验）。
