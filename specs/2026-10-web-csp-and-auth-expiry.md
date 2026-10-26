# Web 安全加固：鉴权失效清理本机数据 + CSP

> 状态：Final（实现随 PR 一起交付，合并后回标 Shipped）
> 日期：2026-10-26 ｜ 关联 backlog：B-825 ｜ 出处：B-816 顺带发现

## 背景

1. 只有主动「退出登录」才删除本机主密钥（`localStorage.auth_credentials`）与 `vh-sync-*` 缓存；token 被吊销/过期时（B-490 auth latch）两者一直留在磁盘上，关掉标签页也不清。
2. server 把登录会话表查询失败也回成 401（`verifyToken` 吞掉所有异常），所以「401 = 已失效」不成立——直接按 401 清数据会在 DB 抖动时把用户踢下线。
3. 全站没有 CSP 与其他安全头（`curl -sI https://veryhappy.dev/` 2026-10-26 实测）。

## 目标

- 确认鉴权失效（我方 server 对当前 token 回 401）时一律清掉主密钥和 `vh-sync-*` 并回到登录页；网络错误、5xx、503 不清。
- 清理前把 outbox 里未确认的输入给用户看并可复制，不静默丢。
- Web 文档带 CSP（内联脚本用 hash，不用 `unsafe-inline`），并补 X-Frame-Options / frame-ancestors、Referrer-Policy、Permissions-Policy、nosniff。

## 非目标

- 不收紧 img/media/frame/connect 到白名单强制（用户运行时选择的 server、relay、机器面板、声音包、Markdown 图片来源无法枚举，先 Report-Only 观察）。
- 不加 HSTS（TLS 终止在 CloudFront/Caddy，`includeSubDomains` 影响其他子域，另议）。
- 不给 vite dev / `/dev/*` harness 加 CSP：harness 只在 `import.meta.env.DEV` 构建里存在（`AppRoot.tsx` 187–288 行），生产包不含。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| latch 只在「我方 server + 当前 token + 401」时触发；403 不触发 | `packages/happy-web-v2/src/auth/authLatch.ts` `wrapFetchWithAuthGuard` / `installAxiosAuthGuard` |
| latch 后 outbox 全部标失败，记录（含明文 `raw`）留在 `outboxRecords` | `src/sync/sync.ts` `failAllOutbox` / `failOutboxItems` |
| logout 在 latched 时跳过 server 调用，清 persistence、`vh-sync-*`、通知状态、凭据 | `src/auth/AuthContext.tsx` `logout` |
| `verifyToken` 原先 try 包住 `isLoginSessionValid`，DB 异常 → null → 401 | `packages/happy-server/sources/app/auth/auth.ts` |
| index.html 有两段内联脚本：startupSplash 主题脚本、server 注入的 `window.__HAPPY_CONFIG__` | `build/startupSplash.ts`、`sources/app/api/htmlConfigInjection.ts` |
| `srcdoc` / `blob:` 文档继承父页 CSP；HTML 文件预览原用 `srcDoc` | `src/screens/files/FsFileViewer.tsx` |
| Zod v4 构造对象 schema 时用 `new Function("")` 探测 JIT（catch 掉但仍触发 violation） | `node_modules/zod/v4/core/util.js` `allowsEval` |

## 设计

### 鉴权失效（与 B-824 spec `specs/2026-10-session-list-snapshot-and-slim.md` §6.1–6.2 对齐）

- server：`verifyToken` 只把「验签失败 / 登录会话不存在、吊销、过期、hash 不符」当无效；登录会话表读取失败向上抛。HTTP `authenticate` 捕获后回 `503 {error:'auth_unavailable'}` + `Retry-After: 5`；socket 中间件回 `Authentication unavailable`。
- 触发（latch，`authLatch.ts`）：当前 token 的 REST/axios 401；socket 握手 `connect_error` 为 `Invalid authentication token` 且握手用的是当前 token（`apiSocket.ts`，`path: 'socket'`）；另一标签页删除凭据（`storage` 事件）。403 不触发。
- **确认一次再清**：latch 后绕过守卫发 `GET /v1/account/profile`（当前 token，5s 超时，`authGuards.confirmCurrentTokenExpired`）：401 → 清；2xx → 误判，不清（记日志，提示刷新）；网络错误/超时/5xx/403 → 不清，等下一次 `online` 或 30s 后再确认。凭据已不在（别的标签页登出）直接视为已失效。
- 确认失效后，`AuthExpiredNotice` 取 `sync.unsentOutboxMessages()`（本页 `outboxRecords` + 持久化 outbox 中尚未被接管的行）：为空 → 立即清理并回登录页；非空 → 列出并可复制，用户点「清除本机数据并重新登录」才清（Lead 10-26 要求保留此提示；B-824 §6.4 的「立即清空」以此为准）。
- **唯一清理入口** `purgeLocalAccountData(reason)`（`src/auth/purgeLocalAccountData.ts`）：关闭并删除全部 `vh-sync-*` → `clearPersistence()` → 通知状态 → 最后删 `auth_credentials`。logout 的本地部分也调它。B-824 往里加快照游标等自己的项。
- **删库被挡住**（另一标签页持有连接）：库名写入 `localStorage['vh.sync.purgePending']`；`SyncCache` 打开任何库之前先删待删列表，没删成本页无缓存运行（消息缓存与 outbox 都不读）。被挡住的删除请求会一直排队，同名后续请求排在它后面既不触发 `blocked` 也不结束，所以每次删除另设总超时。

### CSP（`sources/app/api/securityHeaders.ts`，挂在 `webDocumentOnSend`）

- 对**实际发送的 HTML**计算每段无 `src` 内联脚本的 SHA-256 放入 `script-src`，主题脚本与 runtime config 都覆盖，品牌/配置变化自动跟随。
- 强制策略：`default-src 'self'`；`script-src 'self' <hashes> 'wasm-unsafe-eval' https://accounts.google.com/gsi/client`；`style-src 'self' 'unsafe-inline' <字体 CDN> <GSI style>`（React/xterm/mermaid 内联样式需要）；`font-src`、`img-src … https:`、`media-src … https:`、`connect-src 'self' https: wss: blob: data:`（http API 或 http relay 时加该 origin 与 ws）、`frame-src 'self' https: http: blob:`、`worker-src 'self' blob:`、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`、`frame-ancestors 'self'`、`report-uri /v1/csp-report`。
- 第二阶段（Report-Only 同时下发）：`connect-src` 收窄到 runtime `serverUrl`、请求 origin、`HAPPY_RELAYS_JSON` 里的 relay（均含 ws/wss；生产即 relay-sg / relay-us，从配置取、不写死官方域名）、Google GSI、ElevenLabs；去掉 Report-Only 不支持的 `frame-ancestors`。
- HTML 文件预览改为 `<iframe src="/html-preview.html" sandbox="allow-scripts …">`（无 allow-same-origin），postMessage 传 HTML；该文档单独下发 `sandbox allow-scripts allow-popups allow-forms allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'`，直接打开也是不透明源。SW `navigateFallbackDenylist` 排除此路径。
- 其他头：所有响应 `X-Content-Type-Options: nosniff`；HTML 加 `X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: strict-origin-when-cross-origin`（分享页保留 `no-referrer`）、`Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), microphone=(self)`。
- `/v1/csp-report`：接受 `application/csp-report` 与 `application/reports+json`，内存每 IP 30 次/分钟，不落库；计数 `csp_violations_total{directive,disposition,blocked,scheme,host,port,source}`；日志只记指令、分类字段与页面路径（长 id 折成 `:id`），不记 URL/query/sample（logSafety 本来也会把 URL 脱敏成 `[url-redacted]`）。
  - 分类（不含 URL，均为有界枚举）：`scheme`（http/https/ws/wss/data/blob/…，`inline`/`eval` 为 none）；`host` = loopback（localhost、127/8、::1）/ private（RFC1918、169.254、100.64/10 含 Tailscale、fc00::/7、fe80::/10、.local/.lan/.internal、单标签主机名）/ public / none；`port` = default/custom/none；`source` 来自 `source-file`：self（与文档同 origin 的 bundle）/ extension（Chrome 只报裸 `chrome-extension`，另有 moz-/safari-web-extension）/ inline（等于文档 URL：内联、eval 或注入的脚本文本）/ other / none。
- Web 入口最先 `z.config({ jitless: true })`，去掉 Zod 的 eval 探测（CSP 下 JIT 本就不可用，行为不变）。
- `CSP_MODE=enforce|report-only|off`（默认 enforce）作为不改代码的回退开关。

### 分阶段理由

脚本类指令（script-src / object-src / base-uri / frame-ancestors）是 CSP 防 XSS 的核心，且全部来源都在本仓库内、可完整枚举，已在生产形态构建上逐路径实测零违规，所以直接强制。资源类指令依赖用户运行时配置，测试无法穷举，先给宽松强制 + 严格 Report-Only，靠 `/v1/csp-report` 观察一周左右零报告后再把 Report-Only 的 connect-src 升为强制。

### 上线后两次 enforce connect-src 拦截（10-26，第十四版）的排查结论

生产 `csp_violations_total{directive=connect-src,disposition=enforce,blocked=origin}=2`（/session/:id、/terminal/:id 各一次），日志 URL 已脱敏，来源不可直接得知。

- 被拦的只能是明文 `http:`/`ws:`。其中**非 loopback** 的明文请求在 https 页面上本来就被 Mixed Content 拦截（本地 Chromium 实测：CSP 先报告，请求本就发不出），所以 CSP 对它们不造成新的功能损失；**唯一新被拦的是 loopback**（`http://localhost`、`127.0.0.1`、`ws://localhost`，浏览器视为可信源，不算 mixed content）。
- 应用代码里会发起 loopback/明文连接的路径，逐一核对：语音 asr/tts 固定 `wss://api.elevenlabs.io`；relay 只接受 https 配置（生产 relay-sg/us 均 https）；附件 local 模式的 URL 由 X-Forwarded-Proto 拼出，生产 Report-Only 头里 self 为 `https://veryhappy.dev`，证明代理传的是 https；机器面板 / 浏览器预览只是 iframe（frame-src 放行 http:，没有 fetch 探活）；PWA/SW 的请求受 SW 自己的策略约束，与文档无关；Google 登录走 https；终端链接只是导航；自定义 server URL / 远程日志 URL 只能手动写 localStorage，Web 没有入口。只有「用户手动点下载 http 图片」这类显式操作会触发，且这类图片在 img-src 下本来就不显示。
- 本地复现（`~/code/github/skills/tmp/vh-team-csp-connect/`，https 页面 + 生产同款头 + MV3 扩展）：扩展 **main-world** 注入脚本的 `ws://localhost:35729`、`http://127.0.0.1` 被拦，报告的 `source-file` 为 `chrome-extension`；扩展 isolated-world 的 fetch **不受**页面 CSP 约束（请求到达）；页面自身脚本的明文请求被拦，`source-file` 为 bundle URL。
- 结论（可能性排序）：①浏览器扩展 / userscript 的 main-world 注入（LiveReload、本地 companion 探活之类）；②开发者在 Owner 自己的浏览器里手动覆盖了 server/log URL；③用户显式下载 http 图片。没有发现应用默认路径的真实功能受损。新加的分类字段下次可直接区分 `source=extension` 与 `source=self`、`host=loopback` 与 private。

## 兼容矩阵与发布顺序

- server/Web 同一镜像发布（铁律 5）。旧 Web + 新 server：旧 Web 无 HTML 预览页依赖，CSP 中 hash 按实际 HTML 计算，旧 index.html 同样生效；旧 Web 的 HTML 预览（srcdoc）会被 CSP 拦内联脚本——只存在于切换窗口内已打开的旧标签页，刷新即新版本。
- 新 Web + 旧 server（回滚）：无 CSP，`/html-preview.html` 是普通静态文件，预览照常（无 sandbox CSP 但 iframe 自身 sandbox 仍在）；503 `auth_unavailable` 不出现，旧行为。
- CLI 不受影响（daemon 不读 HTML；socket 错误文本变化只影响 DB 故障时的提示）。

## 风险

1. 未覆盖到的运行时路径被强制策略拦截（Google 登录按钮、语音、机器面板）→ 这些来源已在策略内；`/v1/csp-report` 可见；`CSP_MODE=report-only` 一键停拦。
2. 弹窗未确认时主密钥仍在本机 → 接受：为了不丢用户输入（Lead 要求）；token 已死，主密钥离开 token 也无法访问 server；下次打开即再次提示。
3. server 在 DB 故障期间持续 503 → 客户端按可重试错误退避，不清数据（e2e C 场景）。
4. 确认请求被同一服务端故障也回 401（例如 master secret 配错）→ 仍会清；这是 B-824 §6.2 接受的边界，概率由「两次独立请求都 401」限制。

## 验收标准

- [x] 401（当前 token）且确认 401、无待发 → 自动清主密钥与 `vh-sync-*`、回登录页（单测 + e2e B）
- [x] 有待发 → 弹窗列出并可复制，确认前不清（单测 + e2e A）
- [x] 503/500/网络错误不清（单测 + e2e C）；伪造 401 但 token 有效 → 不清（e2e C2）；确认无应答 → 不清，恢复在线后再确认（单测 + e2e C3）
- [x] socket 握手拒绝 token → latch(socket) → 确认 → 清（e2e E）；另一标签页登出联动（e2e D）
- [x] 删库被挡 → 记 purgePending，下次打开先删、删完前不读缓存（单测）
- [x] server：登录会话表故障 → 503 不是 401（单测）
- [x] 生产构建下 landing/login/signup/home/settings/会话（Shiki+Mermaid）/分享页/CLI 配对页/xterm 终端/HTML 预览/PDF 预览零 CSP violation（`e2e/csp.mjs`）

## 留真机验证项

- iOS Safari / Android Chrome PWA 下的 CSP 行为（浏览器差异：`'self'` 对 ws 的匹配、Permissions-Policy 未识别特性告警）——上线后看 `/v1/csp-report` 与 `csp_violations_total`。
