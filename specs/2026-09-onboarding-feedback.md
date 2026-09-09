# 新手引导与异步反馈

状态：Shipped · 2026-09-10 · B-436

## 范围与依据

帮助页原先把连接新机器降到页尾，缺少账号内置待办 skill 的发现路径。第一台机器仍应优先显示安装、登录、daemon 命令；常驻帮助把连接机器放到主操作。能力说明只覆盖当前路径：多机器接入、按已安装能力选择 Agent、对话/终端/tmux/导入、文件与改动、笔记、待办及单账号单执行电脑的团队。

官方团队安装器只写共享 skill，不改宿主发现目录、不接管裸终端；网页团队自动注入。内置待办通过现有复制入口或 `very-happy todo skill` 获取完整指引，外部 provider 单独链接官方文档，不把阅读 skill 当成授权或已连接。

## 行为

- Sidebar 使用静止、透明、随主题变色的 CyberMark；不更换 PWA 图标。运行行右侧用已有 Spinner，状态来自现有 board lifecycle；等待输入/未读保持不同信号，关闭左侧重复脉冲。没有新增轮询或活性推断。
- quick chat 的现有单飞锁同时发布可订阅 pending 状态，侧栏与帮助共享反馈；失败/成功均释放，仍复用原有错误与配置回退。自定义新建弹窗已有 loading，保持不变。
- 发送请求尚未结束时，优先展示发送中，不因 agent 提前进入 running 改成停止图标。队列、调整方向、停止仍走原来的通道；失败草稿恢复机制不变。
- desktop shell 除已有视口阈值，还要求屏幕宽至少 600 CSS px。412px 屏幕 + 980px 虚拟视口从双栏改为单栏；850×920 展开设备仍为双栏。通知/剪贴板/文件浮层使用同一逆条件。此为浏览器可复现场景，不宣称已在用户 Fold8 真机确认。

## 验收

- Chromium 桌面/390/320/412 屏幕配 980 视口/850 展开尺寸 × 明暗主题：布局选择正确、Logo 透明、运行转圈、hover 不改行宽。CSS probe 前后采样：浅色图标角落从黑色资产变为相邻画布色。
- 实际登录的本地帮助页：连接跳转、安装宿主切换、明暗/320/390 无横向溢出，触屏选择控件 17px。
- 实际 AppShell 850→412 屏幕/980 视口→850：同一个选择控件与值保留，单栏/双栏切换正确。
- quick create 延迟与失败用真实入口和明确的本地 RPC 替身验证，无模型会话创建；发送延迟/提前 running/失败草稿恢复用真实 AgentInput 验证。新增 quick create 并发回归测试，发送源码契约经 mutation-check 验证会捕获守卫变异。
- 真机浏览器是否启用桌面站点及其 screen.width 行为仍需用户设备验证，见 verify queue。此批无 CLI、server、wire 或持久化协议变化，只发布完整 server/Web 镜像。

## 回退

保留上一完整生产镜像 `0839dfd5a`，按 operations 蓝绿状态机回切。无迁移，无需更新 daemon，已有 CLI 0.2.131 继续兼容。

完整本地门禁：wire 82、Web 2,741、CLI 2,082、server 644 项通过（server 原有条件跳过 1 项）；各包要求的构建/类型检查及 CLI 生成产物 --version 成功。

## 发布验收

PR #324 合并为 `82c12b9d54b65fcb18cd67e7a4494c848f603cfe`，PR 与 main 精确 SHA 的门禁成功。部署 run `34403204482` 成功，active blue 镜像 `sha256:a72ef4980e879290604723e6b877abc8415d216ce21845017d114e7448315815`；保留 green `0839dfd5a` 镜像供回退。

`check-shipped` 读取 52 个资源，入口 SHA 与 `cap-skills-title`、`.sb-row-running`、屏幕宽度条件、更新条目均命中；生产 health 正常。Chromium 18 项公开页面明暗/尺寸检查通过，无横向溢出，更新日志显示本批。加载 entry/CSS/controller 已记录；此次没有改 SW 机制，不把刷新本身当成旧客户端 takeover 证明。

本次连接验收出现 **1 次事件**（B-437）：中央 `fs-list` 连续两次 15s 探针超时，服务端随后记录 30s RPC 超时与多个 RPC sockets；机器日志显示已收到并发送加密响应，且附近有网络恢复记录。按网页真实区域 relay 路径请求成功。mac-office 按 operations 的 `daemon stop` → launchd `kickstart` 重新注册后，中央与区域两条请求均成功，launchd running，daemon/已安装 CLI 仍为 0.2.131。未定位重复连接根因或证明与本批 UI 代码存在因果，恢复不等于永久修复。

临时浏览器、像素与 RPC 证据在 `~/code/github/skills/tmp/vh-onboarding-feedback/`；探针只输出成功状态与条目数，不提交账号凭据。
