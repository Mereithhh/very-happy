# Pi terminal tools and session tool history

> 状态：Shipped
> 日期：2026-09-18 ｜ 关联 backlog：B-475

## 目标与现状

原生 pi 在 Very Happy tmux 终端中可加载 `change_title`、`copy_to_clipboard`、`open_preview`；普通会话与终端都能重看复制/预览记录。

| 已核实现状 | owner |
|---|---|
| tmux 新建时注入 VH_TERMINAL_ID，已有 daemon terminal-title 与 MCP change_title | `packages/happy-cli/src/terminal/webTerminal.ts:2338`、`commands/mcp.ts:72` |
| pi 官方扩展只在 HAPPY_MCP_URL 存在时加载；托管权限 gate 与桥接共处 | `packages/happy-cli/src/teams/resources.ts:29` |
| preview 检查路径后只推加密路径，Web 经现有 fs-read 取内容 | `packages/happy-cli/src/claude/utils/startHappyServer.ts:195` |
| 剪贴板历史只存本浏览器收到的事件；preview 从已加载 transcript 重建 | `packages/happy-web-v2/src/sync/clipboardHistoryStore.ts:1`、`screens/session/SessionPreviews.tsx:8` |
| relay 以认证连接确定 machine/session，KV 已有账号隔离、配额、CAS、实时广播 | `packages/happy-server/sources/app/api/socket/clipboardHandler.ts:52`、`app/kv/kvMutate.ts:74` |

## 设计

1. 原生 Pi 支持一次 `very-happy install-pi-tools` 后直接运行 `pi`，或 `pi -e <extension>` 显式加载；保留 `very-happy pi --terminal` 临时入口。安装命令只管理 Pi discovery 目录内自己的扩展文件，不改 settings、认证或其他扩展；支持 `PI_CODING_AGENT_DIR` 与 `--remove`，拒绝覆盖用户修改。自动扩展仅在合法 VH_TERMINAL_ID 且没有 HAPPY_MCP_URL/HAPPY_TERMINAL_MCP_URL 时启用，托管/临时 launcher 继续独占现有桥接。扩展从 session_start 启动 CLI stdio MCP 子进程，session_shutdown 关闭，工厂不启动后台资源；复用同一工具定义与 authenticated daemon IPC，按终端 VH_HAPPY_HOME_DIR 找 daemon。原生终端不套托管权限 gate。改名继续写 tmux @vh_title，并由 daemonState 更新 Web 列表。
2. 终端 clipboard/preview push 附 optional terminalId；server 仅在 machine-scoped 连接接受合法 id。session-scoped 始终使用认证 sessionId。preview 复用 checkPreviewPath，不新增文件读取权限。
3. server 保存有效 push（不代表用户看过或系统剪贴板已写入）。KV key 为 `tool-history.v1/session/<encoded sid>` 或 `tool-history.v1/terminal/<encoded mid>/<encoded tid>`，value 是 base64 UTF-8 JSON `{version:1,entries:[...]}`。每条 `{id,kind,createdAt,payload,enc,truncated?,totalBytes?,mode?}`，server UUID/时间，最新在前，重复调用不去重。
4. 每个 scope 最多 50 条，整个 JSON 上限 240 KiB，超过时删除完整最旧条目。剪贴板实时正文仍上限 256 KiB；新增 historyPayload 为最多 32 KiB UTF-8 正文独立加密，historyTruncated 明示截断。旧客户端大 payload 无法安全截密文，存不可用标志而不伪造正文。单 history payload 上限 48 KiB。存储失败不阻断原实时推送；不打印正文。待存储调用按 scope 串行，每个 scope 最多 50 个、每个 server 进程合计最多 200 个（均含正在写入）；积压超限只略过历史存储并记录无正文 warning，实时推送继续。
5. Web 经现有 KV GET 读取，onKvChanges 即时更新，重连重新拉取；复用已有 source key 解密。历史加载不自动复制/弹预览。保留旧 transcript preview，旧 clipboard 可从 transcript 补充；历史中的复制只在点击时触发，截断内容明确标注。账号、终端身份变化丢弃旧异步结果。
6. 会话底部维持紧凑折叠入口；终端同样有随时可用的记录入口。复用 CopyButton/FsPreviewOverlay 与现有主题 token。

## 兼容与发布

| 组合 | 行为 |
|---|---|
| 旧 CLI + 新 server/Web | session 有限恢复原推送历史；无 terminalId 的 machine push 仅沿用原全局历史 |
| 新 CLI + 旧 server/Web | optional 字段被忽略，原复制与预览推送继续；无新终端历史 |
| 新 server + 旧 Web | 原事件字段兼容；KV 广播被无订阅者忽略 |
| 新 Web + 旧 server | KV 404 视为空；旧 transcript preview 保留 |

先完整 server/Web 镜像，再 CLI。旧 wrapper 保留原进程及已载入代码；原生 Pi 可用 `/reload` 载入扩展。Owner 后续已授权合并发布；按 operations 核对精确 SHA、回滚镜像与 CLI 版本。

## 验收

- pi 原生扩展真实注册三个工具；HAPPY_MCP_URL 优先；daemon 失败不报成功。
- clipboard/preview daemon 路由、路径拒绝、terminalId 透传和 source 防伪通过行为测试。
- history CAS 并发、上限、账号/终端隔离、离线 Web 重取及解密失败有覆盖。
- 明暗桌面与 320/390px coarse 浏览器验证展开、重复制、重开预览、长正文溢出。
- 包门禁与全量 diff review；不以收到调用记录推断用户已查看或系统复制成功。


## 实现验收（2026-09-18）

- 原生推荐入口为 `very-happy install-pi-tools` 后直接 `pi` 或已有会话 `/reload`；保留 `very-happy pi --terminal [pi arguments]` 临时入口。独立 `HAPPY_TERMINAL_MCP_URL` 与托管 endpoint 分开，HAPPY_MCP_URL 优先。
- CLI 全量 255 文件 / 2240 tests；wire 10 文件 / 82 tests；server 100 文件 / 666 tests、1 skipped；Web 全量 341 文件 / 2967 tests，含真实组件加载/实时更新/重连/账号切换测试。Web/server/CLI tsc、Web/CLI/wire build 与 CLI 产物 `--version` 均退出 0。
- 官方 pi 0.84.4、实际编译 CLI、隔离 HAPPY_HOME_DIR/PI_CODING_AGENT_DIR 实跑 RPC：直接 pi 自动发现、显式 -e、已安装扩展叠加临时 launcher 三条路径及各自 /reload 均仅有三工具 active，零模型消息、stderr 空、退出 0。未改个人配置。
- 新增真实编译 stdio bridge 行为测试：终端专属 home、三工具真实 authenticated daemon IPC、daemon 状态丢失/恢复、/reload 旧进程退出及新进程建立。MCP isError 在两个 Pi 桥中均抛异常，让 Pi 正确标记失败；离线、路径拒绝、改名失败均有回归覆盖。安装幂等与卸载保留其他配置，拒绝自定义修改与 symlink。
- 实际 MCP HTTP → authenticated daemon HTTP 调用三工具通过；加密历史分别覆盖 legacy/dataKey，JSON 转义后仍符合密文上限。超长文本与旧 transcript 一对一匹配、失败调用不被成功 push 吞掉、旧 relative preview 保留会话 cwd。
- 真实浏览器验证展开正文、再次复制后粘贴字节匹配、preview 重开事件；390px 交互无横向溢出。css-probe 修前/修后：1280/390/320、明暗主题，coarse 实测为 true，触屏按钮 44px，页面和历史正文横向溢出均 0。
- 本批全量 diff 与直接 pi 补充改动均独立 review；问题已修并补机制测试，复查无剩余 actionable findings；公开文档源码断言 mutation-check 1/1 caught。
- 临时日志/截图/真实 pi RPC 证据：`~/code/github/skills/tmp/pi-terminal-session-tools/`；server 最终日志：`~/code/github/skills/tmp/pi-terminal-tools/`。

## 发布验收（2026-09-18）

- PR [#384](https://github.com/Mereithhh/very-happy/pull/384) 合并为 `4f4d82ec9788216c3a38e8c3367b6ad93cf8f5a3`；合入 main 的 Quality `35304440040` 与 CLI smoke `35304440056` 成功。
- 完整 server/Web deploy [35304745474](https://github.com/Mereithhh/very-happy/actions/runs/35304745474) attempt 2 成功：blue / generation 149，镜像 `sha256:f815fb6662fc4f66d91885df8e500ce2405ce2082e23187b6d3932036a4ebe55`；公网 health 正常，`check-shipped` 读取 56 份资源并命中历史存储 key 与 Pi 安装入口。回滚保留 green / `83fe23982c5c34030690419d0ad4517ad5b3a4f3`，镜像 `sha256:cc9dd30edc17767a104a3877e946cb949920fe3d43d0a005053d0b5b77ff94b9`。
- 首次部署在切流前因宿主机磁盘满失败；仅清理超过 72h 的未引用 Docker 镜像，active/rollback 镜像与用户数据保留，恢复约 39 GiB 空间后重试。
- CLI `v0.2.142` 指向同一 main SHA；[publish 35305958952](https://github.com/Mereithhh/very-happy/actions/runs/35305958952) 与 [tag smoke 35305958973](https://github.com/Mereithhh/very-happy/actions/runs/35305958973) attempt 1 全部成功，六个 Linux/macOS/Windows × Node 20/24 job 均 success。平台包先于主包，npm latest 与线上 recommendedVersion 均为 `0.2.142`；自动安装 pin 仍为 `0.2.141`。
- 切流后 mac-office 旧 daemon 的 control RPC ACK 超时；同版本重新接管后恢复，两次端到端复测成功。原 3 个 wrapper PID、6 个终端 ID 保留，两个原活跃对话心跳新鲜；另一个 Pi wrapper 在发布前已长期 inactive。根因未定，按 B-476 跟进，不把进程存活等同于响应链正常。
- mac-office 使用已发布 CLI 0.2.142 与原生 Pi 0.85.1，在独立 HAPPY_HOME_DIR / PI_CODING_AGENT_DIR 中实跑安装、直接 Pi 自动发现和 `/reload`：三个工具均 active，退出 0、stderr 空、模型消息数 0；未写入个人 Pi 配置或向真实会话发送测试消息。
- mac-office 经 `cli-update-request` 空闲检查安装 0.2.142，完成 daemon handover 后按 operations 重新纳入 launchd。最终 installed/running 均 0.2.142，launchd running 且监督进程为 daemon 的父进程；只读 RPC 成功，原 3 个 wrapper PID、6 个终端 ID 与发布前完全一致，两个原活跃对话仍有新鲜心跳。没有停止或恢复业务会话，旧 wrapper 不声称热载入新版。
