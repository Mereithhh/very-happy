# 终端 Claude 结构化镜像视图（terminal mirror）

> 状态：Draft（可行性调研完成，待 Owner 拍板是否立项）
> 日期：2026-08-15 ｜ 关联 backlog：B-105 ｜ 出处：Owner 想法 + 调研 agent 报告（本文即报告压缩版）

## 背景

web 终端里跑的 claude TUI 只有 xterm 像素流：可读性受终端渲染约束、复制困难、
长输出回看费劲。Owner 提议经 hooks/log 读取内容，在终端 session 提供可切换的
自渲染视图。

## 调研结论：强可行，是「组装」而非「发明」

所需管线在 repo 里全部存在且生产运行中：

1. **数据源**：本地交互模式已在做同样的事——transcript JSONL tail →
   `sessionScanner`（fs.watch+3s 轮询、uuid 去重、多文件续接）→
   `sessionProtocolMapper`（~680 行，turn/thinking/tool/sidechain 全处理）→
   `ApiSessionClient` → server → web。
2. **渲染复用度 ≈ 100%**：web reducer 吃 SessionEnvelope，其生产者 mapper 的
   输入**就是 transcript JSONL 行**（SDK 路径反而要先经 sdkToLogConverter 转成
   JSONL 行格式）。transcript 是现有渲染管线的母语；工具特化/复制/thinking
   折叠全部白拿。唯一差异：无 permission 占位（设计内可缺省）。
3. **resume/fork/compact 换 session id 的坑**已被 scanner 三招覆盖（hook 再触发
   接管新文件 + 老文件保活 + uuid 去重跳历史前缀）。

## 推荐架构

- **绑定 = 全局 SessionStart hook（主）+ tmux `-e VH_TERMINAL_ID` 注入（身份）**，
  cwd 推断（`claudeFindLastSession` 现成）作无 hook 降级。hook 报
  session_id+transcript_path（权威），env 报终端归属；hook 脚本见 env 未设即退。
  转发复用 `session_hook_forwarder.cjs`+`startHookServer` 先例。
- **通路 = 影子会话（shadow session）**：daemon 为绑定成立的终端建一个
  metadata 标记 `flavor:'terminal-mirror'`+`terminalId` 的普通 session，
  scanner→ApiSessionClient 原样跑。**server 零改动**；历史/断线重连/多设备白拿。
  否决方案：ephemeral relay 通道（web 侧要重造订阅/快照/重放，改造量大一个量级
  且失去历史）。
- **产品形态**：终端页 toggle（xterm ↔ 结构化）或宽屏双栏（FsBrowser 抽屉是
  交互先例）；**只读镜像，明确不做可交互**（镜像会话藏输入框和 permission UI，
  否则消息落库无人消费=体验陷阱）；侧栏 mirror 会话与普通会话分组显示；
  UI 标注镜像比 TUI 慢半拍（transcript 写入滞后，秒级）。

## 社区对照

- claude-code-viewer（1.3k★）最接近（watch JSONL 实时 + spawn CLI 双路径同构）；
  claude-code-log（1.2k★）有最全 JSONL 类型映射可对照；claude-trace/claude-tap
  是 API 拦截流派（侵入大，不采纳）；disler observability 验证 hook→HTTP→面板
  路径但内容仍要回读 transcript——印证「hook 做绑定、JSONL 做内容」分工。
- **「JSONL 镜像 + 中继 + 多机」组合位没有活跃开源项目占坑。**

## 改动面与风险（立项时展开）

- cli 中等（terminalMirror 编排 + hook 端点 + `-e` 注入 + install-terminal-hooks
  命令 + 服务器侧去重补齐，~500-800 行）；web 小-中（toggle/只读变体/分组，
  热区 WebTerminalScreen）；server 零。
- 风险：①scanner 整文件重读 CPU（一期接受，二期 offset tail）②写用户
  settings.json 的侵入（显式命令+幂等+可卸载；**Owner 机器 ~/.claude 归 chezmoi
  管，hook 必须进 chezmoi 源**）③transcript 格式无契约（宽松 zod+passthrough
  防御已是惯例）④cwd 降级路径的同目录多 claude 歧义（标注「推断绑定」）
  ⑤只读边界必须执行死 ⑥tmux -e 是 create-only 且需 ≥3.2（存量终端
  set-environment 补注或降级）。

## 验收标准 / 留真机验证项

立项定稿时填写。
