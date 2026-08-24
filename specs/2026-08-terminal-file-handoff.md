# 浏览器终端文件投递：分块上传、原子落盘与路径回填

> 状态：Final
> 日期：2026-08-24 ｜ 关联 backlog：B-170

## 背景

Very Happy 已支持把浏览器拖入或剪贴板粘贴的文件传到目标机器，并把绝对路径粘到
Web terminal 光标处。该能力最初在 `25c23b28` / `6d82f0bf`（旧 Web）实现，
`529bd807` 接入生产 Web V2；通用 daemon 落盘来自 `b4f187e2`。

公开候选审计发现现实现会把整份文件转成 base64 后塞进一次 RPC，而 relay 默认把
每个 RPC envelope 限制为 256 KiB。加密与再次 base64 后，常见截图即会失败；Web
既无进度也无错误提示。不能在官网宣传一个在普通输入上静默失效的能力。

## 目标

- Web terminal 的拖放与 clipboard file/image 两个入口共用一条可靠上传路径。
- 单文件上限 8 MiB；96 KiB 原始字节一块，使双层 base64 + 加密 envelope 留有余量。
- daemon 强制校验 upload id、文件名、subdir、声明总长、chunk 大小和严格 offset。
- 完成前只存在隐藏 `.part`；大小核对通过后 rename 到最终路径。
- 成功后只用现有 bracketed-paste 路径按 daemon 默认 shell 风格引用绝对路径，绝不发送 Enter；
  无法可靠判断旧版 native Windows daemon 的 shell 时拒绝自动插入。
- Web 显示进度、成功和失败；匿名官网用同一生产 class contract 做本地交互证明，
  不读取访客文件内容，也不连接机器。
- 旧 daemon 对小文件保留 legacy `uploadFile`；较大文件明确要求升级，不静默失败。

## 非目标

- 不把上传文件放进项目 cwd，也不自动移动、解压、打开或执行。
- 不增加 relay 持久化对象；内容只随 machine-scoped RPC 转发。
- 不宣称 E2E / zero-knowledge。Server 仍在产品信任边界内。
- 不在本批重构 structured session 的附件上传路径。
- 不提供无限文件传输或大文件同步；8 MiB 是交互式 handoff，不是对象存储替代品。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 生产 Web 已在 terminal host capture `paste`，并监听 `dragover/drop` | `packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx` |
| 旧路径一次性调用 machine RPC `uploadFile`，落到 `~/.happy/uploads/terminal/` | `packages/happy-web-v2/src/sync/ops.ts`、`packages/happy-cli/src/modules/common/registerCommonHandlers.ts` |
| machine RPC 以机器 key 加密 params，并由认证 machine scope 限定方法 room | `packages/happy-web-v2/src/sync/apiSocket.ts`、`packages/happy-server/sources/app/api/socket/rpcHandler.ts` |
| relay 默认 `RPC_MAX_PAYLOAD_BYTES=256 KiB`、每 socket 每分钟 120 calls | `packages/happy-server/sources/app/api/socket/rpcHandler.ts` |
| lines-mode 安全 paste 走 daemon 的 tmux paste-buffer；attach mode 用 xterm bracketed paste | `packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx`、`packages/happy-cli/src/terminal/webTerminal.ts` |
| 产品整体是 server-trusted，RPC envelope 加密不等于 relay operator 不可访问 | `docs/security.md`、`docs/architecture.md` |

## 设计

### D1. 新增 machine/session handler：`uploadFileChunk`

请求是带 `uploadId` 的四态协议：

```text
start  { name, subdir, totalSize }
append { offset, content(base64) }  × N
finish {}
abort  {}
```

`start` 只允许 0..8 MiB，总活跃上传最多 8 个。`append` 的解码后 chunk 不得超过
96 KiB，且 `offset` 必须等于 daemon 已接收长度。`finish` 同时核对声明长度和临时文件
stat，再以 rename 暴露最终路径。非法 base64、乱序、超量、重复 id、过期 id 全部失败。

活跃 upload 10 分钟未触碰会被清理；每次 start 也扫描当前 staging 目录，清除 daemon
重启前遗留且 mtime 已过期的 `.part`。`abort` 是幂等 best-effort 清理入口。

### D2. Web 分块与失败语义

Web 在读文件前先拒绝大于 8 MiB。每轮只 `Blob.slice()` 当前 96 KiB，不把整份 8 MiB
复制进 JS 字符串。任一 append/finish 失败都会 best-effort abort；UI 显示文件名、进度和
可操作错误。

daemon 随最终路径返回默认 shell 的 quote style：POSIX 单引号会安全拆接 apostrophe，
PowerShell 单引号会双写 apostrophe，cmd 使用双引号且拒绝含 `%` / `!` 的歧义路径。
Web 复用现有 lines/attach 两种 bracketed paste chokepoint。路径不拼 `\r`，所以文件到达
不等于命令执行。旧 daemon 没有 quote style 时，POSIX 沿用兼容行为；native Windows
拒绝自动插入并提示升级，避免把单引号误当成 cmd quoting。

### D3. 命名与目录

浏览器给拖放和粘贴都加时间戳前缀，daemon 再剥离路径组件并把字符收敛到
`[\w.-]`。subdir 同样收敛并固定拼在 `happyHomeDir/uploads` 之下。当前 terminal
入口固定使用 `terminal`，最终目录为 `~/.happy/uploads/terminal/`。

### D4. 公开产品证据

Landing 的第三个 Core Capability 复用 `ProductWorkspacePreview`、生产 `term-*` class
和真实 `term-upload-status`。访客可点击、拖放或粘贴触发本地-only 动画；demo 只读取
`File.name`，不读 bytes、不发网络。Copy 同时展示 8 MB、trusted relay、目标目录和
no-auto-run。README、Quick Start、架构与安全文档保持同一边界。

## 兼容矩阵与发布顺序

| Web | daemon | 行为 |
|---|---|---|
| 新 | 新 | 8 MiB 内分块上传 + 进度/错误 + 原子完成 |
| 新 | 旧 | ≤128 KiB 回落旧 `uploadFile`；更大明确提示升级 daemon |
| 旧 | 新 | 旧 Web 继续调用仍保留的 `uploadFile`；行为不变 |
| 旧 | 旧 | 原行为；受 relay 单 RPC 上限约束 |

发布优先 **CLI/tag → Owner/production daemon(s) → Web**，这样生产机器先具备新 handler，
再公开新 UI。公共用户的旧 daemon 由兼容分支保护。Web 回滚后新 daemon 多一个闲置 handler
无害；CLI 回滚后新 Web 会按上表降级。

## 安全与滥用边界

- 机器作用域与认证由既有 RPC registration room 保证；不得接受事件体自报 machine id。
- 每个 machine socket 最多注册 256 个唯一 RPC method room；重复注册不重复 join，
  unregister 释放名额，越界会被拒绝并断开，避免公开账号制造无界 adapter room。
- 8 MiB、96 KiB chunk、8 active、10 分钟 TTL 同时约束内存、磁盘与 relay call 数。
- 8 MiB 最坏 86 个 chunk + start/finish，低于默认 per-socket 120 calls/min；另有独立的
  per-account/per-process RPC 字节与事件 token bucket，默认 burst 可容纳一份完整 8 MiB
  handoff 的编码流量。多文件仍可能触发 rate limit，Web 必须显示失败而非无限重试。
- 文件内容经过现有加密 envelope，但产品仍按 server-trusted 描述；不新增安全承诺。
- 目标目录不在 cwd，文件不会被自动执行；使用方仍应把传入文件视为不可信输入。

## 验收标准

- [ ] daemon 单测覆盖路径净化、非法/超量 base64、乱序、未完成 finish、abort、TTL、
      restart 遗留 staging 清理、原子最终路径。
- [ ] Web 单测覆盖分块 offset、进度、8 MiB 拒绝、旧 daemon small fallback、失败 abort。
- [ ] wiring 回归钉住 drop + capture paste → chunk helper → quoted path，且无 `\r`。
- [ ] 1440px 与 390px 真浏览器可见真实上传 UI；交互完成后显示目标路径；零横向溢出、
      console error 为 0，reduced-motion 保持可理解。
- [ ] CLI 全门禁 + built artifact isolated HOME 冒烟；Web vitest/build/tsc 全绿。
- [ ] 发布后用新 daemon 实传小图和 >256 KiB 图，核对 hash/路径/不自动执行。
- [ ] README 和正式 docs 与 Landing 同时出现 8 MB、trusted relay、target dir、no-auto-run。

## 留真机验证项

- iOS/Android 浏览器能否把各自系统剪贴板的 screenshot 暴露为 `ClipboardEvent.files` 由
  OS/browser 决定；无 file item 时必须保持普通文本 paste，不做虚假兜底承诺。
