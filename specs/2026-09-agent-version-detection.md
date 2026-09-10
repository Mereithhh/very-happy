# Coding agent 版本检测与 SDK 升级

状态：已实现并本地验证，发布目标 CLI 0.2.135。

## 行为

- Claude SDK 固定精确版本，由依赖机器人每日检查并提 PR；必须通过项目门禁后随 CLI 发布，不自动跳过 review 合并，不热换正在运行的 wrapper。
- daemon 启动及每 6 小时检测已安装 coding agent 的 `--version`，只执行固定白名单命令，单进程 5s 超时/输出上限。不自动安装、不执行 registry 返回的命令。
- 官方 npm 包 latest 作为新版本提示来源，固定 registry URL、无认证、5s 超时。仅比较稳定三段 semver；preview、自定义输出与网络失败均 unknown，不错误标为最新。
- `daemonState.agentVersions` 可选 snapshot 包含 checkedAt、daemonPid、各 agent 的 installed/latest/status。旧 Web 忽略；新 Web 对旧 daemon 显示未检测。snapshot 必须匹配当前 daemon pid 且 checkedAt 不早于稳定的 agentVersionEpoch，超过 12h 标过期。重连会刷新 startedAt，但不会刷新 agentVersionEpoch。
- 机器详情显示结果和官方升级文档，机器列表显示可升级数量。提示区别内置 SDK 与独立 CLI；保留用户现有安装方式。
- 此检查仅发送公开包名到 registry，不发送本机路径、账号、会话或认证信息。

## 兼容与验证

无数据库变更；先 Web/Server 后 CLI。SDK 0.3.232 → 0.3.267 独立验证消息流、子代理、background Bash、权限/stop/queue/steer；测试通过不代表交互 TUI 所有能力等价。

## 0.3.267 控制交互走查（2026-09-11）

| 能力 | 本轮证据 | 仍有边界 |
| --- | --- | --- |
| 权限回调 | 真 SDK canUseTool 触发并允许限定命令，n=1 | 未复演全部认证/弹窗类型 |
| Steer / Queue | priority now 的 STEER_OK；result 后队列收到 QUEUE_OK，n=1 | 这是 SDK 控制探针，非生产 Web→RPC 全链路 |
| Live mode | setPermissionMode acceptEdits ack，n=1 | 不改变既有 mode 约束 |
| Stop | 运行中 30s Python 等待在1.5s interrupt；现有 EDE 取消形式，n=1 | sleep 被策略拦截的样本未算通过 |
| 子代理 | Haiku 实际模型、正文、关联ID与生命周期，n=1 | thinking 块正文此次为0，不保证思考文本可见 |
| 后台 Bash | run_in_background、task/tool ID、TaskOutput，n=1 | 新 background_tasks_changed 可忽略；仍靠既有 task_started/notification |
| 独立后台任务控制 | SDK 有 stopTask/backgroundTasks | 已补会话运行控制入口；真实 handler 探针验证转后台/停止，见下文 |
| 重载/恢复控制 | SDK 有 reloadSkills/reloadPlugins、rewindFiles、MCP reconnect/toggle | 已补运行控制入口及文件回退双阶段确认，见下文 |
| 用户对话 | 已有 onUserDialog | 目前只声明 refusal_fallback_prompt，未覆盖所有官方类型 |

升级后完整 CLI 238文件/2140测试与独立 tsc/产物启动通过（版本检测加入前）；版本检测加入后另跑回归。真实探针只在隔离临时目录运行；未升级生产 daemon，不声明与官方交互 TUI 全等价。

本机版本检测实跑：Claude/Codex 当前版本一致，Gemini 与 OpenCode 检出更新；Pi 已安装版本高于 registry latest，不提示降级；OpenClaw 未安装。Web 320/390px coarse 与1200px、明暗主题验证结果/未知状态/官方链接，无横向溢出。SDK 检测使用精确依赖版本，依赖 PR 保留 lockfile 及门禁。

审查修复：稳定 agentVersionEpoch 由 ApiMachine 实例持有，重连不让检测失效，新实例使旧检查过期；原始 checkedAt 不因重连伪造为新检查。Windows 先 where.exe 判未安装，再通过 cmd shim 执行固定 --version；本机仅 macOS 实跑，Windows 路径用注入命令测试，未冒充 Windows 真机验证。


## Claude 运行控制补齐

`claude-runtime-controls-v1` 由实际 wrapper 发布；Web 只按会话 capability 显示右上角菜单入口，不能以机器 CLI 版本判断旧 wrapper 已升级。旧 Web 忽略 capability，新 Web 对旧 CLI 隐藏入口。无存储迁移；发布先 Server/Web 后 CLI，新能力需新建或明确重启会话。

`claude-runtime-control` RPC 的 status/operation 只读进程内状态；reload-skills、reload-plugins、mcp-status、mcp-reconnect、mcp-toggle、stop-task、background-tasks、rewind-preview、rewind-apply 即返 operationId，由客户端轮询运行结果，避免 relay 30s 上限。操作、已观察任务和真实 SDK replay-user UUID 检查点均属当前 Query。Query 换代清理任务/检查点/回退令牌；操作记录有上限，不是持久历史。

SDK 权限与对话回调在途时不嵌套 control request；callback depth 延后到响应发送时机再释放。Web 显示忙碌并禁用操作，后端再次执法。文件回退仅空闲时可用，先 dryRun 返回影响文件及五分钟确认令牌；apply 再核验 Query 世代、活动版本、空闲状态和预检指纹。新对话活动使旧确认无效。只恢复 SDK 跟踪文件，不回退聊天历史。

MCP status 与 reloadPlugins 结果剥离 config/env 等配置，仅暴露名称、状态、工具名称等展示字段。backgroundTasks 返回 false 时提示无可转后台任务；任务生命周期只接真实 task_* 帧，完成后晚到 progress 不复活任务。未知 dialog kind 不猜 payload；当前仅验证 SDK 已知 refusal_fallback_prompt，未知交互显式取消。

本地验收：隔离 cwd/HAPPY_HOME、现有认证源，真实 handler+SDK 各一轮验证 skills/plugins reload、stdio MCP connected→disabled→connected/reconnect、全体前台任务转后台→stopTask→stopped。文件回退实写 probe.txt→dryRun→token apply→文件消失，最终 replay UUID 实现重复验证成功。指定 toolUseId 的 backgroundTasks 两次返回 false，如实保留，不宣称成功。Web 六组合（320/390 coarse、1200 × 明暗）以模拟 RPC 验证操作、状态、MCP刷新和回退确认；与真实 handler 探针分开计证，不冒充生产全链路。

Review 补强：status 包含实例隔离的 queryGeneration；换代后旧 running 操作失败，晚到结果不覆盖新 Query。Web 在会话切换/关闭/Query 换代时清理缓存并使在途响应失效，确认 ack 到状态可见期间保持忙碌。回退 Promise completed 后仍读取 canRewind/error/skippedLinks，区分失败与部分跳过。组件机制测试覆盖旧会话晚到失败、同会话换 Query 清 MCP；纯函数测试覆盖未后台化及回退拒绝/部分跳过。

本批最终核验：Web 全量 2806 项，review 后新增/修订专项 5 项；CLI 全量 2155 项，review 后 runtimeControls 9 项与 claudeRemote 17 项专项；wire 82 项；Server 649 项通过、1 项原有跳过。Web/CLI/Server 类型检查和构建通过，生成 CLI --version 可执行。浏览器侧栏手机/桌面明暗主题品牌与导航中心同为 x=25，分组只保留新建加号。尚未发布，不将本地依赖升级描述成用户 CLI 已更新。

发布候选最终门禁（2026-09-11）：Web 2817、CLI 2162、wire 82、Server 649 项通过（Server 1 项既有跳过）；Web/CLI/Server 类型检查退出 0，构建及 CLI 产物启动成功。Server 首轮与其他包并发时四个 PGlite 初始化超过 10 秒，空闲重跑完整套件通过，未放宽超时。最终浏览器复验 320/390/900 coarse、1400 × 明暗主题通过；嵌套导航与运行活性补齐回归。
