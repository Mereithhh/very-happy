# 文件下载交付：`open_preview(download: true)` + 工具卡下载

> 状态：Draft
> 日期：2026-10-13 ｜ 关联 backlog：B-562 ｜ 前身：B-131（`2026-08-open-preview.md`）、B-447（`2026-09-file-preview-actions.md`）、B-526（推送跟随会话）、B-539（预览停靠侧栏）、B-499（内置工具卡）

## 背景

Owner 原话：「有的时候 AI 生成的文件，我希望能够直接在网页端下载……给 preview 这个工具加一个类似的下载功能……
或者 preview 一个非文本类型的文件，这样我也能直接下载。不然某些时候它产生的文件类型不太适合 preview，我又想下载，
只能先推到一个中间位置才能下下来」。

现状：查看器头部已有下载图标（B-447），但 ① agent 没有「用户要拿到这个文件」的表达方式，zip/docx 推过来只显示
「二进制文件 · 大小」，下载入口是一个 14px 的小图标；② 推送关掉后只能去文件浏览器里重新找；③ 聊天里的
`open_preview` 工具卡只有一个路径链接。

## 目标

1. agent 能明确表达「交付文件」：`open_preview` 加可选 `download: boolean`，推送载荷加可选 `intent: 'download'`。
2. web 收到 `intent=download` 的推送：照 B-526/B-539 打开预览，并在查看器顶部给出醒目的「下载 文件名 · 大小」主按钮；
   桌面端尝试自动开始下载，失败无害、有按钮兜底。
3. 聊天里的 `open_preview` 工具卡（所有 runner 的名字形状）有「打开」「下载」按钮，翻历史也能用，对旧 CLI
   产生的调用同样有效（纯 web）。终端会话的「复制与预览记录」同样提供下载。
4. 不可预览态改为「此类型无法预览」+ 大号下载按钮 + 大小；超过 50 MiB 说明上限并建议让 agent 压缩/分卷。
5. 机器离线 / 文件不存在 / 超限都有明确错误，不出现空白或转圈。

## 非目标

- 不提高 50 MiB 下载上限，不做流式/断点下载（仍是 `fs-read` 512 KB 分块拼装到内存）。
- 不新增文件访问能力：仍只走既有 `fs-read` RPC；server 不碰文件内容。
- 不做目录下载（CLI 拒绝目录并让 agent 先打包 zip）。
- 不改 `FilesPanel` / `WebTerminalScreen`（B-554/B-557 热区）：意图经独立的内存 store 传给查看器。
- 不加 Prisma migration、不改 wire 包、不加 synced setting。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| http MCP 注册 `open_preview`，入参只有 `path`/`mode`；handler 先过凭据路径闸再 `client.pushFilePreview` | `packages/happy-cli/src/claude/utils/startHappyServer.ts:136`、handler 同文件 `openPreview` |
| session 侧推送载荷：`{ payload: 加密路径, enc: true, mode }` | `packages/happy-cli/src/api/apiSession.ts:1240` |
| Codex/Gemini/ACP 经 stdio bridge 转发，bridge 自己声明了 zod inputSchema（不声明的参数会被 MCP SDK 剥掉） | `packages/happy-cli/src/codex/happyMcpStdioBridge.ts`（`PREVIEW_TOOL_NAME` 段） |
| 托管 pi 经 `HAPPY_MCP_URL` 直连 http MCP，按 `tools/list` 的 inputSchema 动态注册，**无需改动**即得新参数 | `packages/happy-cli/src/agent/acp/runAcp.ts:659`；终端 pi 同理 `packages/happy-cli/src/piExtension.ts:87-90` |
| web 终端里的裸 agent 走 `very-happy mcp` → daemon `POST /file-preview`（fastify zod body，`z.object` 默认剥掉未知键）→ `apiMachine.pushFilePreview` | `packages/happy-cli/src/commands/mcp.ts:91`、`daemon/controlServer.ts:484`、`api/apiMachine.ts:319` |
| **server 逐字段显式转发**，未知字段（含新 `intent`）会被丢弃；`mode` 未知值归一为 `file` | `packages/happy-server/sources/app/api/socket/filePreviewHandler.ts:48,85-91` |
| web 接收：解密路径 → `openFsPreview({…, fromPush: true})`；未知字段无人读取 | `packages/happy-web-v2/src/sync/filePreviewPush.ts:131` |
| 推送先停靠到来源会话侧栏（`?panel=browse&pinFile=`，由 FilesPanel 消费），否则 B-526 跟随会话 + overlay | `screens/files/FsPreviewOverlay.tsx`（`onFsPreviewOpen` 回调）、`screens/files/previewPinTarget.ts` |
| 查看器头部已有下载（512 KB 分块、50 MiB 上限），blob 固定 `application/octet-stream`；binary 态只显示「二进制文件 · 大小」 | `screens/files/FsFileViewer.tsx:194,288`、`screens/files/fileDownload.ts:3,8` |
| `open_preview` 工具卡：`previewToolPath` 只认 `mcp__happy__`/裸名/Codex/pi 四种形状，渲染成单个路径链接；Gemini `happy__open_preview` 与终端 `mcp__very-happy__open_preview` 落到通用 BuiltinToolView | `screens/session/ToolView.tsx:371-377`、`screens/session/previewTools.ts` |
| 被路径闸拒绝的调用返回 `isError: true`，**但 Claude 会话的 transcript 里该调用仍是 `state: 'completed'`、result 为 null**（2026-10-13 本地真会话实测：目录被拒的那次调用即如此），web 不能靠 state 判断是否被拒 | `startHappyServer.ts`（`Could not open preview`）；实测见「验收记录」 |
| daemon `fs-read` 会展开 `~`；相对路径由 web 按会话 cwd 拼接 | `packages/happy-cli/src/modules/fs/fsRpc.ts:122`、`screens/session/toolFilePath.ts:66` |

## 设计

### D1. CLI：`download` 参数与 `intent` 字段

- `open_preview` 三个注册点（http MCP、stdio bridge、`very-happy mcp` 终端版）都加
  `download: z.boolean().optional()`；描述：用户要**拿到**文件（zip、docx、xlsx、安装包、二进制……）时设 true。
- `download: true` 时 CLI 额外做一次 `stat`（在路径闸之后）：
  - 不存在 → 返回错误，不推送；
  - 是目录 → 返回错误「先 `zip -r` 打包再推 zip」，不推送；
  - 超过 50 MiB → 照常推送（用户仍能看到大小与说明），返回文本里提醒 agent 压缩/分卷。
  纯函数 `downloadTargetVerdict(stat)` 承担判定，有单测。普通预览（不带 download）行为不变。
- 推送载荷：仅在 download 时追加 `intent: 'download'`（不带就不发这个键，旧形状逐字节不变）。
  session 侧 `apiSession.pushFilePreview(path, mode, intent?)`，终端侧经 daemon `/file-preview` body 的可选
  `intent` → `apiMachine.pushFilePreview(…, intent?)`。
- `AGENT_GUIDANCE`（≤1200 字符上限不变）补一句：用户要拿到文件时用 `open_preview` 且 `download: true`，
  目录先 zip。工具描述同步写用法。路径闸（`checkPreviewPath`）不变，下载同样受它约束。
- `intent` 是明文元数据（只表达「要下载」，不含路径/内容），与 `mode` 同级；路径仍加密。

### D2. server：显式转发 `intent`

`filePreviewHandler` 增加 `normalizeIntent`：只有 `'download'` 原样转发，其余一律**省略该键**（不是转成别的值），
与 `mode` 的「未知值不透传」同一纪律。tool history 不记录 intent（无消费者，避免扩大 KV 形状）。

### D3. web：推送意图 → 查看器顶部下载主按钮

- `filePreviewPush` 读 `event.intent === 'download'`（宽松读取，未知值忽略）放进 `FsPreviewRequest.intent`。
- `FsPreviewOverlay` 收到带 intent 的请求时，在停靠/跟随/overlay 之前写入 `downloadIntent` 内存 store
  （单槽，最新覆盖，2 分钟 TTL，键 = machineId + path）。查看器无论挂在 FilesPanel 侧栏还是 overlay，
  挂载时按 (machineId, path) 取走（consume）意图——不用改 FilesPanel 与 URL。
- 查看器有意图时在头部下方显示**下载条**：主按钮「下载 文件名 · 大小」（ink/canvas 主 CTA，触屏 ≥44px），
  大小在首个读取窗口返回后补上；可关闭。
- **自动下载**：仅当推送到达时页面可见、`pointer: fine`、非 iOS/iPadOS 时，查看器挂载后自动执行一次下载。
  失败只在下载条里显示错误，不弹 toast；按钮始终可用。纯函数 `shouldAutoDownload(env)` 有单测。
- 下载字节复用：若查看器已为预览拼装了整文件（image/pdf/spreadsheet 的 `bytes` 态），直接用，不再读第二遍。

### D4. 下载机制与移动端

- `useFileDownload(machineId, path)`：读前先看机器（未知 / 离线 → 立即给明确错误，不发 RPC）；
  读取有进度；失败按码映射（not-found、离线/旧 daemon、超时、超限、权限）。
- 得到字节后生成 blob URL，立刻 `a.click()`（带 `download` 文件名），**同时保留一个真实的 `<a href download>`
  「保存 文件名」链接**直到组件卸载——这是 iOS Safari / PWA 的手势兜底：异步 RPC 之后用户激活已过期，
  程序化点击可能无效或被转成新页打开，用户再点一次真实链接一定是手势内导航。
- blob MIME 按扩展名给常见类型（zip、docx/xlsx/pptx、pdf、png/jpg/gif/webp、csv、txt、json、md），
  让 iOS 的 Quick Look/「存储到文件」识别类型与图标；**HTML/SVG/XML/JS 等可执行内容一律 `application/octet-stream`**：
  blob URL 继承本站 origin，若浏览器回退为「新页打开」，绝不能让 agent 写的 HTML/SVG 在本站 origin 执行。
- 文件名取路径 basename，去掉控制字符与路径分隔符，空则 `download`。

| 平台 | 预期行为 | 验证 |
|---|---|---|
| 桌面 Chrome/Edge/Firefox | 点击即下载到默认目录，文件名=basename；推送自动下载一次（Chrome 同页第二次无手势下载可能出「下载多个文件」询问，按钮兜底） | 本批 Playwright Chromium |
| 桌面 Safari | `download` 属性生效，进下载列表 | 留真机 |
| iOS Safari 15+ | `a[download]` 弹「下载/查看」确认，存「文件」App；异步后的程序化点击可能无反应 → 用「保存 文件名」链接；PDF/图片可能直接 Quick Look 预览，分享→存储 | 留真机 |
| iOS 主屏 PWA（standalone） | 可能以内嵌 Quick Look 打开 blob，无地址栏；需验证能否返回、文件名是否保留 | 留真机 |
| Android Chrome | `a[download]` 直接下载到 Downloads，通知栏可打开 | 留真机 |

### D5. 工具卡与记录

- 新纯函数 `previewToolCall(tool)`：用 `resolveBuiltinTool` 覆盖全部 runner 形状（Claude/Gemini/Codex/pi/终端），
  返回 `{ path, download }`；ToolView 的 open_preview 分支改用它，渲染 `PreviewToolCard`：路径 + 「打开」「下载」按钮。
  - 机器 = 当前会话 `metadata.machineId`；路径按会话 cwd 解析（`resolveAgainstCwd`）。
  - 沿用既有规则：只有 `completed` 的调用渲染成预览行（error/running 仍是普通工具行）。但被 CLI 拒绝的调用也可能显示为
    completed（见现状事实），所以**凭据类路径一律不给一键打开/下载**：web 侧 `isCredentialLikePath` 镜像 CLI 路径闸
    （不知道远端 home，故目录在路径任意位置出现即命中——只会更严）。路径链接本身维持 B-145 现状。
  - 行内显示文件名（basename），完整路径在链接 tooltip。
  - 没有 machineId 时按钮禁用并说明原因。
  - 带 `download: true` 的调用在行标题显示为「发送文件」，其余仍「预览」。
- 「复制与预览记录」的预览条目加「下载」按钮（终端会话没有聊天工具卡，这里是唯一的回看入口）。

### D6. 不可预览态

`binary` 态与「预览超 10 MB」态：标题「此类型无法预览」/「文件过大无法预览」+ 大小 + 大号下载按钮；
大小 > 50 MiB 时不给按钮，改为说明「网页下载上限 50 MiB，可让 agent 压缩或分卷（如 `zip -s 45m`）」。
有推送意图时下载条已在顶部，主体只留说明，不重复按钮。

被否方案：
- 把 intent 塞进加密 payload（如 `path\0download`）：旧 web 会把它当路径，直接坏掉，违反铁律 4。
- 用 `mode: 'download'`：server 把未知 mode 归一为 `file`，新 web 也拿不到；且语义上 mode 是渲染方式。
- 用 URL 参数（`pinFile=…&download=1`）传给侧栏：要改 FilesPanel 与 WebTerminalScreen（热区）。

## 兼容矩阵与发布顺序

CLI 指 session wrapper + daemon（`very-happy mcp` 跟随全局安装版本，daemon 可能更旧，单列）。

| CLI | server | web | 行为 |
|---|---|---|---|
| 新 | 新 | 新 | 完整：下载条、桌面自动下载、工具卡按钮 |
| 新 | 新 | 旧 | 旧 web 不读 `intent`，照常预览；头部小下载图标可用。不报错 |
| 新 | 旧 | 新 | 旧 server 逐字段转发 → `intent` 被丢弃，web 按普通预览；工具卡按钮（读 transcript 里的 `download` 参数）仍可用。agent 收到「已请求」文本，不会报错 |
| 新 | 旧 | 旧 | 普通预览，同 B-447 |
| 旧 | 新 | 新 | 旧 CLI 没有 download 参数；模型若传了未声明参数会被 MCP SDK 剥掉，照常预览。工具卡「打开/下载」照样可用（纯 web） |
| 旧 | 旧/新 | 旧 | 现状不变 |
| 新 `very-happy mcp` | — | — | 连旧 daemon：`/file-preview` body 的 `intent` 被 zod 剥掉，普通预览；新 daemon 才带 intent |

- 新字段全部可选；web 宽松读取（只认 `'download'`，其余忽略），未知值不会丢消息（铁律 4/14）。
- 不需要 session capability：web 不依赖 CLI 是否支持 download，工具卡与不可预览态是纯 web 能力。
- **发布顺序**：server/web（同一镜像）→ CLI。反序也安全（见矩阵第 3 行，降级为普通预览）。
- **回滚点**：server/web 回滚到上一镜像即恢复旧行为（intent 被丢弃）；CLI 回滚到上一版即不再发送 intent。

## 风险

1. **大文件内存**：50 MiB 全部拼进内存 + blob。沿用 B-447 上限，接受；超限给明确说明。
2. **iOS 异步下载失效**：异步取数后程序化点击可能无效 → 常驻「保存 文件名」真实链接兜底；真机项。
3. **blob 同源执行**：活动内容强制 octet-stream（D4），有单测钉住 html/svg。
4. **桌面自动下载打扰**：只在可见 + 精确指针 + 非 iOS 时触发一次；Chrome 多次无手势下载的询问由浏览器给出，按钮兜底。
5. **凭据路径**：工具卡只对未失败的调用给按钮；CLI 路径闸不变。用户自己点下载等同于在文件浏览器里手动导航（B-131 D4 口径）。
6. **工具卡路径解析**：`~` 交给 daemon 展开，相对路径按会话 cwd；会话 cwd 后来变化（极少）可能指错，报 not-found 而不是下错文件。
7. **intent 明文**：仅一个枚举值，不泄露路径；接受。

## 验收记录（2026-10-13，本地隔离栈）

隔离 standalone server（PGlite，端口 3562）+ vite（8562）+ 隔离 `HAPPY_HOME_DIR` daemon，真 Claude 会话按提示调用
4 次 `open_preview`（zip+download、docx 无 download、目录+download、12 MB+download），再用 MCP client 直连该会话的
http MCP 补推 zip/docx/png/12 MB/60 MB。Playwright 自启 Chromium（独立 profile），1280 fine 与 390 coarse × 亮/暗：

- 下载均经 Playwright `download` 事件落盘后比对 sha256，与源文件逐字节一致：工具卡（含无 download 参数的旧形状调用）、
  桌面自动下载（zip/docx/png/12 MB）、手机点按下载条、不可预览态大按钮、头部图标。
- 手机不自动下载；下载条/行内按钮命中区 ≥44px（下载条主按钮 48px）；两种宽度均无横向滚动。
- 60 MB：CLI 返回提示，下载条只显示上限说明与压缩/分卷建议，无按钮；目录被 CLI 拒绝并给 `zip -r` 建议。
- 文件被移走后点工具卡下载：「The file no longer exists…」。机器离线由组件测试覆盖。
- 从 /settings 推送：B-526 跟随回会话并停靠侧栏，下载条与自动下载照常。

## 回归 e2e（2026-10-27，Owner 反馈「点下载没反应」排查）

`packages/happy-web-v2/e2e/file-download.mjs`（手动跑，搭法同 `e2e/csp.mjs`：built web + standalone + 真 daemon）：
desktop 与 phone（iPhone 13 coarse）× md/png/pdf/zip × 2 KB/3 MB/24 MB，覆盖侧栏预览头部 ⬇、「点这里保存」
链接、对话工具卡 inline「下载」与其保存链接、「Previews」抽屉、带 sessionId 的推送（停靠侧栏）和无会话推送
（overlay 下载条），每次都要求 Playwright `download` 事件，且文件名、大小、sha256 与源文件一致。

那次排查的结论：生产 756b26d1 + relay + 真 daemon 在 Chromium 与真 Google Chrome 153（新 profile，浏览器
自己的手势与多次下载限制生效）上都能下载，v13→v16 没有回归。唯一复现出「点了没反应」的是一个开着
「下载前询问保存位置」的 Chrome profile：一个没人处理的 GTK「Save File」对话框挂了几天，之后的下载都排在它
后面。应用侧显示「已开始下载」，浏览器只写了临时文件。遇到同样症状，先看浏览器有没有挂着的保存对话框或
下载提示。

## 验收标准

- [ ] CLI：三处注册点有 `download`；目录/不存在拒绝、>50 MiB 提示；载荷仅 download 时带 `intent`；单测。
- [ ] guidance 仍 ≤1200 字符（既有测试）。
- [ ] server：`intent: 'download'` 转发，其余值/缺省时键不存在；单测。
- [ ] web 纯函数单测：`shouldAutoDownload`、`downloadMimeOf`（含 html/svg → octet-stream）、`downloadFileName`、
      `downloadFailureText`、`previewToolCall`（五种 runner 形状 + download 标志）、downloadIntent store（TTL/consume/键匹配）。
- [ ] 真浏览器 1280 与 390 coarse × 亮/暗：推送 zip/docx/png/大文件（>50 MiB）；下载条、不可预览态、工具卡下载；
      下载文件 sha256 与源文件一致。
- [ ] 机器离线、文件已删除时工具卡下载给明确错误。
- [ ] web vitest / tsc / vite build；server tsc + 相关 vitest；cli build + `--version` + 相关 vitest。

## 留真机验证项

- iOS Safari（浏览器 + 主屏 PWA）：点「下载」后是否弹下载确认、文件名与类型（zip/docx/pdf）是否保留、
  程序化点击失效时「保存 文件名」链接是否可用、Quick Look 打开后能否返回。
- Android Chrome：下载进 Downloads、文件名正确、通知可打开。
- 手机上推送下载意图时的打扰程度（不自动下载，只显示下载条）。
