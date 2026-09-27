# 机器网页面板 + 请人介入（machine web panels）

> 状态：Draft
> 日期：2026-09-28 ｜ 关联 backlog：B-510 ｜ 出处：Owner 2026-09-27/28 dev-sg agent 浏览器实践（「能看到浏览器被操作、也可以干预」「不是通用方案……是不是可以 veryhappy 支持一个通用的插件能力」）

## 背景

Owner 的主力机 dev-sg 上，agent 通过 `agent-browser connect 9222` 驱动一个常驻桌面 Chrome（XFCE on VNC :1），
人经 noVNC（tailnet `:6080`）或 RustDesk 看和接手。实际痛点不是「看不到」，而是：

1. agent 卡在验证码 / 2FA / 扫码 / OAuth 同意页时，**没有东西叫人**，只能等人碰巧来看；
2. 人要看时得离开 very-happy，另开 noVNC / RustDesk，找到对应机器，**上下文切换重**；
3. agent-browser 只是 Owner 的选择，别的用户可能用 Playwright、browser-use、自建 dashboard、或只是一个 dev server——
   **绑定某个浏览器工具的方案不通用**。

通用单位应该是「这台机器上有一个人可能要看的本地网页服务」（noVNC、agent-browser dashboard、Grafana、dev server……），
再加一个与工具无关的「请人介入」信号。

## 目标

1. **声明**：机器本地配置可声明若干「网页面板」（id、标题、URL），daemon 把列表同步给 web；web 端**绝不能写**该配置。
2. **展示**：web 在该机器的工作区里把面板作为标签页显示（复用 `BrowserPreview` 的 iframe 外壳），不可嵌入时降级为「在新窗口打开」。
3. **请人介入**：会话里的 agent 可以调用一个工具，发出带原因、可选面板 id 的介入请求 → 推送通知 + web 内横幅，点击直达该面板。
   非会话场景（脚本、cron）有等价 CLI。
4. **零画面流量经过 very-happy**：面板内容由查看端浏览器直连面板 URL；server / relay 只传面板元数据和介入事件（各 ≤ 几 KB）。

## 非目标

- **不做端口转发 / 字节隧道 / 代理**（server socket.io 与 regional relay 都不承载面板流量，理由见「设计 · 被否方案」）。
  面板 URL 的可达性与 HTTPS 由用户自己解决（tailnet + 证书、Cloudflare Tunnel、Caddy 等）。
- 不做 VNC / 远程桌面客户端本身，不内置 agent-browser 或任何浏览器驱动。
- 不做面板鉴权代理：面板服务自己的认证（noVNC 密码等）照旧由面板处理。
- 不做 web 端编辑面板配置、不做插件市场 / 可执行插件（声明只含 URL，不含命令）。
- 不改 B-508 自动化 attention 的存储与生命周期（本批只复用其「需要我决策」语义，不写 `AutomationRun`）。

## 现状事实（代码已确认，`origin/main@47de1fd76`）

| 事实 | 位置 |
|---|---|
| Web 已有「网页」标签：用户手输 http(s) URL，放进 `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerPolicy="no-referrer">`，拒绝带凭据 URL 与本应用 origin，有「在新窗口打开」降级 | `packages/happy-web-v2/src/screens/workspace/BrowserPreview.tsx:7-27`；`browserAddress.ts:1-10`；挂载 `SessionWorkspacePanel.tsx:85`、`TerminalWorkspacePanel.tsx:28` |
| 该标签明确「不代理请求或自动建立端口转发」，空态提示「localhost 指的是当前设备」 | `specs/2026-09-workspace-rollout.md:183-189`；`BrowserPreview.tsx` 空态文案 |
| Web 与 server 均无 CSP / `frame-src` / `X-Frame-Options`；生产 Caddyfile 只改写客户端 IP 头 | `ops/production/Caddyfile.blue-green:5-36`（全仓 grep 未找到 CSP） |
| Web 以 https 提供（`veryhappy.dev` 经 CloudFront），iframe 指向 `http://<tailnet/LAN IP>` 会被浏览器按混合内容拦截 | `docs/operations.md:17` |
| 机器本地配置 `~/.happy/settings.json` 已有「web 绝不可写」先例：`todoProvider{command,args,...}`，注释「provider 命令 = 任意代码执行，web 端绝不可写」 | `packages/happy-cli/src/persistence.ts:47-127`；`packages/happy-cli/src/modules/todo/todoRpc.ts:1-60` |
| `DaemonState` 是账号密钥加密的机器状态（`webTerminals`、`closedTerminals`、`tmuxSessions`、`cliUpdate`、`claudeAuth`…），每次写 = CAS + DB 写 + 广播 | `packages/happy-cli/src/api/types.ts:287-392`；`packages/happy-server/sources/app/api/socket/terminalHandler.ts:133-139`；`docs/encryption.md:203-238` |
| machine RPC：单次载荷上限 `RPC_MAX_PAYLOAD_BYTES` 默认 256 KiB，每 socket 120 次/分；账号级 RPC 桶 2 MiB/s | `packages/happy-server/sources/app/api/socket/rpcHandler.ts:188-211,298-316`；`socket/terminalRateLimit.ts:33-54` |
| 终端流经 socket.io：B-484 实测 `terminal-output` 占 Redis stream 条目 11%、字节 56%；B-494 把 stream `maxLen` 从 20 万降到 2 万 | `docs/backlog.md:33,41`；`socket/boundedStreamsAdapter.ts` |
| regional relay 只有 socket.io `/v1/relay`（`maxHttpBufferSize` 1 MiB、无 HTTP 代理、**无通用字节隧道事件**），终端桶 2 MiB/s，超限断连 | `packages/happy-server/sources/relay.ts:85-103,129-285,168`；`terminalRateLimit.ts:26-31` |
| 会话推送：`POST /v1/sessions/:sid/push-event`，`kind ∈ done|permission|question`，title ≤200、body ≤500、`data` 可带 url | `packages/happy-server/sources/app/api/routes/pushRoutes.ts:156-208` |
| 非会话推送：`POST /v1/webhook/notify`，`event ∈ completed|permission`（`WEBHOOK_EVENTS`），`link` 以 `/` 开头 ≤300，账号 30 次/分；带 event 时同时发设备推送（`data.url = link`） | `pushRoutes.ts:300-373`；`sources/app/push/webhookNotify.ts:39` |
| 设备推送在账号有活跃非 machine 客户端时被抑制；webhook 不抑制 | `sources/app/push/pushDispatch.ts:1-24,162-240` |
| Service worker 点击通知打开 `data.url`（`/session/<id>`、`/terminal/<m>?tid=<id>`） | `packages/happy-web-v2/public/push-sw.js:11-13,26,37-54` |
| 推送 title/body 明文，server 可读 | `pushRoutes.ts:161-165`；`docs/security.md:5-13`（server-trusted） |
| 每会话 HTTP MCP 已有 `open_preview`、`report_progress(attention: none|review|blocked)`；后者只写 `metadata.board`，**不推送** | `packages/happy-cli/src/claude/utils/startHappyServer.ts:71,104-184,199-248` |
| daemon 本地 control server（`127.0.0.1:<随机端口>`）已有 `/session-event`、`/file-preview` 等 | `packages/happy-cli/src/daemon/controlServer.ts:125-563` |
| 架构文档预留了「WebRTC DataChannel 可占用同一 realtime seam」，未实现 | `docs/architecture.md:74-78`；`specs/2026-08-multi-region-relay-plane.md:18,22,66` |
| backlog/specs 中无 VNC / 远程桌面 / 端口转发条目 | 全仓 grep 未找到 |

## 设计

### 1. 声明（CLI，机器本地）

`~/.happy/settings.json` 新增可选字段：

```jsonc
"webPanels": [
  { "id": "desktop", "title": "桌面", "url": "https://dev-sg.example.ts.net:6443/vnc.html?autoconnect=1", "embed": true },
  { "id": "browser", "title": "Agent 浏览器", "url": "https://dev-sg.example.ts.net:4849/", "embed": true }
]
```

- `id`：`/^[a-z0-9][a-z0-9-]{0,31}$/`，机器内唯一；`title` ≤40；`url` 必须 `https:`，或 `http:` 且 host 为 `localhost`/`127.0.0.1`（仅对「查看端就是本机」有意义）；
  不允许 userinfo；上限 8 个。非法项跳过并在 daemon 日志报一次。
- `embed`（默认 true）：false 时 web 只给「在新窗口打开」。
- **只从本地文件读**；web、RPC、server 都没有写路径（与 `todoProvider` 同一规则）。
- CLI 命令 `very-happy panels list|check`：`check` 对每个 URL 在本机做一次 HEAD/GET，报告可达性、是否 https、响应头里的
  `X-Frame-Options` / CSP `frame-ancestors`（据此提示 `embed:false`）。

### 2. 同步（daemon → web）

- daemon 启动与配置文件变更（fs watch，防抖 2s）时把规范化后的列表写入 `DaemonState.webPanels`（加密字段，随既有
  daemonState 更新路径）。列表不变不写（避免 CAS + 广播，见现状事实）。
- 选 daemonState 而非新 RPC：面板列表低频、需要离线可见、web 已订阅 daemonState；体积 ≤ 8 × ~300B。

### 3. 展示（web）

- 机器工作区（会话 / 终端的 workspace 面板）在「网页」标签旁追加每个面板一个标签，外壳复用 `BrowserPreview`
  的 iframe + 加载超时 + 「在新窗口打开」，但 URL 固定、不可编辑。
- 新增深链路由 `/machine/<machineId>/panel/<panelId>`（全屏面板视图，给推送点击用）。
- 降级规则（按顺序）：`embed:false` → 只给按钮；查看端 origin 为 https 而面板 `http:` 非 loopback → 按钮 + 「混合内容，需要 HTTPS 地址」；
  iframe 12s 未 load → 沿用 `BrowserPreview` 的「加载较慢，可在新窗口打开」。
- 面板标签显示 URL 的 origin（防误认），iframe 保持现有 sandbox 与 `no-referrer`。

### 4. 请人介入

- **MCP 工具** `request_human({ reason: string ≤200, panel?: string })`（每会话 MCP，与 `open_preview` 同处）：
  1. 写 `metadata.board` 的 `attention: 'blocked'` + progress=reason（复用 `report_progress` 的写路径与节流）；
  2. `POST /v1/sessions/:sid/push-event`，**新 kind `attention`**，`data.url` = 面板深链（给了 panel 且该机器声明了它）否则 `/session/<sid>`；
  3. 返回文本告诉 agent：「已通知；请轮询你自己的完成条件（URL 变化 / 元素消失）而不是等回复」。
- **CLI** `very-happy attention "<reason>" [--panel <id>] [--session <sid>]`：有 `--session` 走同一 push-event；
  否则走 `/v1/webhook/notify`，**新 event `attention`**，`link` = 面板深链。脚本 / cron / 非 Claude agent 用这条。
- **web 内**：收到 `attention` 的 `session-event` 时，在对应会话头部显示横幅（原因 + 「打开面板」），复用 B-508 横幅样式；
  不写 `AutomationRun`。
- 推送抑制保持现有规则（有活跃客户端时不发设备推送，改为 web 内横幅），webhook 不抑制。

### 被否方案

| 方案 | 否决理由 |
|---|---|
| 画面经 server socket.io 流式传输（类比 web 终端） | 桌面/浏览器画面每秒数百 KB–数 MB，远超终端；B-484/B-494 已证明终端流就占 Redis stream 56% 字节；RPC 256 KiB 单包、账号 2 MiB/s 桶都会被打满；跨洋往返 ~200ms 交互不可用 |
| regional relay 新增字节隧道事件 | relay 是 socket.io、1 MiB 包上限、2 MiB/s 桶超限断连、无 HTTP 代理；做成通用隧道等于在公开产品里开一个任意端口转发面（安全审查面大），且仍给自有 relay 带来带宽成本 |
| WebRTC DataChannel P2P | 架构预留了 seam，但 ICE/STUN/TURN 均未实现，成本最高；可作为「面板 URL 不可达时」的后续方案单独立项 |
| 绑定 agent-browser（stream / dashboard） | 非通用；它只是面板 URL 的一种来源 |

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 CLI + 旧 server：push-event `kind:'attention'` | 旧 server zod 拒（400）→ CLI 退回 `kind:'question'`（同 title/body/data），功能降级为普通提问推送 |
| 新 CLI + 旧 server：webhook `event:'attention'` | 旧 server 400 → CLI 去掉 `event` 重发（仅 webhook、无设备推送），并在输出提示 |
| 新 CLI + 旧 web：`DaemonState.webPanels` | 旧 web 忽略未知字段；深链 `/machine/.../panel/...` 旧 web 无路由 → 落到默认页（推送仍能把人带回应用） |
| 旧 CLI + 新 web | 无 `webPanels` → 不显示面板标签；无 `attention` 事件 → 无横幅 |
| 新 web + 旧 server | web 不依赖 server 新能力（面板直连、事件由 server 透传） |

发布顺序：**server（接受新 kind/event）→ web（面板标签、深链、横幅）→ CLI（声明、同步、工具、命令）**。回滚点：CLI 回退即停发新事件与字段；server/web 回退后新 CLI 走上表降级路径。

## 风险

1. **面板 URL 指向任意站点**：只能来自机器本地文件（机器持有者即账号持有者），web 无写路径；标签显示 origin。接受。
2. **iframe 里的面板被点击劫持 / 读父页**：跨 origin iframe 无法读父页；沿用现有 sandbox。面板本身若允许被嵌入，是面板自身的选择。接受。
3. **推送原因明文过 server**：与现有推送一致（server-trusted）；工具描述要求 reason 不含秘密，≤200 字。接受。
4. **查看端不在 tailnet / 无证书**：面板加载失败 → 降级文案明确「此设备无法访问该地址」；`panels check` 在机器侧提前暴露 https / 头部问题。文档给出 tailnet + 证书、Cloudflare Tunnel 两种常见做法。
5. **介入请求刷屏**：`request_human` 复用 `report_progress` 节流 + push-event 既有限流；同一会话 60s 内重复请求只更新横幅不重复推送。
6. **移动端 iframe 操作 VNC 体验差**：不在本 spec 解决；深链全屏视图 + 「在新窗口打开」是最低保障，真机项记录。

## 验收标准

- [ ] `webPanels` 解析：合法项进 `DaemonState`，非法项（非 https 非 loopback、userinfo、超 8 个、id 非法）被跳过并日志一次；单测覆盖。
- [ ] 配置文件变更 2s 防抖后同步；内容不变不写 daemonState（单测断言无写）。
- [ ] web 面板标签：URL 不可编辑、显示 origin、`embed:false` / 混合内容 / 超时三种降级各有测试。
- [ ] 深链 `/machine/<m>/panel/<p>` 打开全屏面板；机器或面板不存在时有空态。
- [ ] `request_human` → board `blocked` + push-event `attention`（data.url 为面板深链）；未声明的 panel 退回会话链接；60s 去重。
- [ ] `very-happy attention` 有/无 `--session` 两条路径；旧 server 400 时按兼容矩阵降级（集成测试模拟）。
- [ ] server 接受新 kind/event，旧 kind/event 行为不变；限流不变。
- [ ] 全链路无面板内容经过 server/relay（抓包或日志断言：只有元数据与事件）。
- [ ] `very-happy panels check` 报告可达性、https、`X-Frame-Options`/`frame-ancestors`。

## 留真机验证项

- dev-sg：noVNC（HTTPS 化后）作为面板在桌面 Chrome 与手机 web 内嵌可操作；agent-browser dashboard 作为第二个面板。
- agent 在真实验证码页调用 `request_human` → 手机收到推送 → 点击直达面板 → 人处理后 agent 自行继续。
- 手机（不在 tailnet）打开面板时的降级文案。

## 待 Owner 拍板

1. 介入推送是否在「有活跃客户端」时也发设备推送（当前设计：不发，改 web 内横幅）。
2. 面板标签放在会话/终端工作区（本设计）还是机器详情页，或两处都放。
3. `request_human` 是否并入 `report_progress`（加 `notify: true` + `panel`）以减少工具数，而不是新工具。
