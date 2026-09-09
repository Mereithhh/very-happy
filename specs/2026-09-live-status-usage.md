# 会话实时状态与 token 语义

状态：Shipped · 2026-09-09 · B-431

## 现状事实

- `screens/session/liveStatus.ts` 把 outputTokens 或 thinkingTokens 都标作 ↑；`MessageMetaRow.tsx` 却用 ↑ 输入、↓ 输出。
- `claude/streamRelay.ts` 读取 message_delta 的 output_tokens，message_start 只读取 id，未转发 input/cache usage；Web progress 合并 token，新 API message 会残留上一条数字。
- `statusbar.css` 将状态和所有计量放在同一 nowrap/ellipsis 行；整个区域 aria-live，每秒时间更新也进入播报。

## 决定

- progress 新增可选非负整数 inputTokens、cacheTokens（cache creation + cache read）；输入不含缓存，与消息尾部一致。现有输出计量不改成字符估算，thinkingTokens 独立标为估算且不与 outputTokens 相加。
- Claude message_start 从 usage 读取输入、输出、缓存；新 API message 清空上一条已知计量（零表示清除，UI 省略零），沿用 250ms 合并窗口与完整 progress 快照，使丢帧后可恢复。缺 usage 不借用持久化历史 usage。
- 状态名称、耗时、各 token 指标分开；指标可换行。以 CSS transform/opacity 驱动轨迹与呼吸核心，减少动态效果时静止；只播报阶段变化，不播报每秒数字。
- 活性仍唯一遵循 agentLiveness/heartbeatLease；动效不构成心跳证据。工具、请求、压缩与普通工作都有明确状态。

## 兼容与发布顺序

| CLI | Web | 行为 |
|---|---|---|
| 旧 | 新 | 输出箭头修正，独立思考估算；无输入/缓存则省略 |
| 新 | 旧 | 忽略新字段；旧箭头呈现不变 |
| 新 | 新 | 分别展示当前 API message 已收到的计量 |

先 server/Web 完整镜像，再 CLI；服务端仅转发，不改持久化存储。ACP 未上报实时 usage 时只显示状态和耗时，不声称所有 runner 都有实时计量。

## 验收

回归覆盖字段转发、缓存口径、跨 message 清除、缺字段、非法值与方向；真实浏览器覆盖 390px/coarse 与桌面、明暗主题、状态切换、减少动态效果。UI 总览以现有 mobile-chat/sidebar 等 dev harness 的真实组件为依据，范围不扩展到全站重设计。

## 本地 SDK 样本

2026-09-09，隔离 cwd/HAPPY_HOME、无工具、单轮探针 n=1 成功：message_start usage 完整字段包含 input_tokens=172、output_tokens=1、cache creation/read=0；message_delta 为 input=172、output=4，result=success。说明输入可取、输出随 usage 上报；样本不证明所有 provider 都实时逐 token 上报。message_start 自带 output=1 也不能证明已进入正文阶段，因此普通状态统一“处理中”，不靠 token 值猜阶段。
原始 usage（不含凭据或正文）：`~/code/github/skills/tmp/vh-live-status/sdk-usage.json`。

## 实现验证（本地，待合并）

Web 2673、CLI 2079、wire 81、server 641 passed（server 1 skipped）；Web/server/CLI 类型检查与构建成功，CLI 产物可执行。输入接线和动画调用 2/2 变异被行为测试捕获。
真实组件检查工作/工具/请求/压缩、usage缺失与恢复、390/1280明暗；CSS probe另覆盖320px和coarse/reduced-motion，未发现横向溢出，reduce下全部动画停止。
对照了侧栏列表/状态视图、工具卡、OrbitLoader与更新弹层；未扩大为全站改版。审查记录与截图/测量目录：`~/code/github/skills/tmp/vh-live-status/`。

## 发布验收（2026-09-09）

PR #317/#318 合并后以 `a5b01fc90f60fb3bf4daeab39536e112559d54a6` 发布；main 门禁 run 34368549558、生产部署 34369293700 均成功。`check-shipped` 核对新增 UI 样式及两条 changelog 的稳定 ID/中文标题，Chrome `/changelog` 实际渲染同一 SHA。完整镜像 active green，回滚点 `47835715fa324fa0cd97295d339726451a60e342`。

CLI `v0.2.130` 与 Web 同 SHA，publish 34370172575 成功；同仓/tag/SHA、attempt 1 的 smoke 34370172621 六项全绿，npm latest/next 均为 0.2.130。mac-office 安装与运行版本均为 0.2.130，launchd running，真实 `list-terminals` RPC 成功（7 个终端）。既有会话 wrapper 未重启，新输入字段需新 wrapper；推荐版本仍可能受一小时 registry 缓存影响，自动更新 pin 未改。原生 IME/文件选择器验收保留 V-150。
