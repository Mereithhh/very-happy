# Orca（onorca.dev）产品调研

> 2026-10-17 子代理调研；事实与【推断】分开。供 specs/2026-10-spaces-a2a.design.md 引用。

## 1. 定位 / 用户 / 开源 / 定价 / 公司
- 一句话：面向跑 10–100 个并行 coding agent 的工程师的桌面 "ADE"（Agent Development Environment）：每个任务一个 git worktree + 一个 agent 终端 + 一个浏览器 tab，BYO 订阅。（https://www.onorca.dev/docs ；https://www.ycombinator.com/companies/stably-ai-orca）
- 用户：已付费 Claude Code/Codex/Cursor CLI 的专业开发者，"读 diff、在意 commit"，明确不做 no-code。
- 开源：MIT，TypeScript，2026-03-17 首次提交，94.2k star / 6.0k fork / 8.4k open issues（GitHub API，10-17）。
- 定价：免费；/pricing、/blog 404；Enterprise 页只有 "Talk to us"。
- 公司：Stably AI（YC），Orca 是内部工具开源；LICENSE 署名 Lovecast Inc.

## 2. 核心概念模型（/docs/model/worktrees、/docs/cli/orchestration）
- Project（repo 或 project group）→ Worktree/Workspace（一等公民：branch、目录、tab 布局、链接 PR/Issue）→ Agent session（一个 CLI 进程在一个终端在一个 worktree）。
- Host（Local / SSH / Remote Orca Server / Cloud VM recipe）决定 worktree 在哪跑。
- 编排层：Run（命名空间+协调者收件箱）→ Task（spec、依赖、状态 pending/ready/dispatched/completed/failed/blocked）→ Dispatch（一次尝试，绑定终端）→ Message（status/worker_done/escalation/question/heartbeat）→ Decision gate。
- 旁支：Automation、Skill、Artifact、Account（多 Claude/Codex 账号）、Quick Command。
- 【推断】worktree 是脊柱；没有独立 "agent 定义" 对象，agent 只是"命令+参数+hooks"的启动配置。

## 3. 多智能体编排
- agent 定义：Settings→Agents 里每个 CLI 的 command/args/env；默认全部加 yolo flag，理由"worktree 即沙箱"。
- 编排不是 UI，是 CLI+skill：协调者 agent 装 `orchestration` skill 后用 `orca orchestration run-create / task-create / worker-start --agent codex --worktree new-child` 派发子 worker；worker 收到 preamble 合约：必须发一次 `worker_done --outcome`、长任务发 heartbeat、阻塞问题用 `orca orchestration ask` 而非本地 TUI 提示。消息总线支持群发地址 `@all/@idle/@claude/@codex`。
- orchestrator：任意 agent 都可当 coordinator（Run 不调度，只是收件箱）；可跨主机 federated worker（`--on windows`）。
- 人类介入：worker 的 `ask` 回到 coordinator；coordinator 建 decision gate 阻塞 task 直到 `gate-resolve`；UI 侧 "Needs You" 状态 + Agent Dashboard kanban（Needs You/Working/Done/Idle）+ 手机端回复 permission。
- 另支持 Claude Agent Teams（每个 teammate 原生 pane）。

## 4. "Automate everything" 实指（/docs/cli/automations）
- 触发器：仅定时——preset hourly/daily/weekdays/weekly、cron、RRULE、timezone、missed-run grace；无 webhook/GitHub event/Slack/文件变更触发。
- 定义：CLI `orca automations create --trigger --prompt --provider --repo|--workspace` 或桌面表单；`--precheck` shell 探针跳过；`--reuse-session`；`--extra-agent-args` 指定模型/effort。
- 观测：Automations 表（Host/last run/Failed/Succeeded/Never ran）、runs 历史、Rerun；完成走通用 agent-finished 通知。无重试策略、无告警路由配置（未披露）。

## 5. 团队/协作
- 无账号体系、无 org/成员/权限（telemetry 页明说"Orca has no account system"；Orca account 仅用于 Relay 配对与 artifact 分享）。
- 共享方式：Remote Orca Server——一台机器拥有 projects/worktrees/终端/agent，多个客户端配对；每客户端一个可撤销 token；可"隐藏其他客户端创建的 workspace"。
- 多人协作同一 agent = 都连到同一 server 看同一终端；Skills 可用 unlisted 链接分享。Enterprise 卖点是审计走 git/PR。

## 6. 接入面
- agent：~40 个 CLI 预配置（Claude Code、Codex、Gemini、Cursor、Copilot、OpenCode、Pi、Grok、Kimi、Qwen、CodeBuddy…）。
- 任务源：GitHub（PR/Issue/Actions/Projects/stack/auto-merge）、GitLab、Bitbucket、Azure DevOps、Gitea、Linear、Jira。无 Slack/Discord/IDE 插件。
- MCP：Settings→Integrations 注册给 agent 用；Orca 自身对 agent 的接口是 CLI + skills。无公开 HTTP API/SDK（未披露）。
- 其他：内嵌 Chromium 浏览器自动化、iOS/Android 模拟器、computer-use、artifact 发布、plugin marketplace。

## 7. UI 信息架构
- 左侧栏：Tasks（GitHub Projects/Linear/Jira）、Automations、Agents feed（Slack 式事件流）、Agent Dashboard（kanban）、Artifacts、Skills；下方按 Project 分组的 worktree 卡片，卡上内联 agent 状态点 + 当前动作摘要 + PR/Issue 链接。
- 主视图：每个 worktree 独立 pane tree（终端/Chat UI/diff/浏览器/编辑器任意分屏）。
- 状态栏：各账号用量/限流条、SSH/端口/资源、后台任务。
- 手机：host 列表 → worktree 列表 → 会话，回复/切账号/建 workspace。

## 8. 借鉴与争议
值得借鉴：
1. 统一状态机 + 三处投影：Working/Needs You/Done/Idle 同时出现在卡片、kanban、feed、手机 push；"Needs You" 作为一等队列。
2. Run/Task/Dispatch/Message 编排契约（worker_done 幂等、heartbeat、ask、decision gate），以 CLI+skill 暴露给 agent 而非只给人。
3. Host 作为显式维度：多机 worktree 混用；server 持有状态、客户端只是视图。
4. 自动化先 `--disabled` 创建 + 手动 run + precheck 探针 + 每自动化模型/effort 覆盖。
5. Agents feed（时间线）与 Dashboard（看板）并存：一个用于"离开后追赶"，一个用于"现在谁卡住"。

弱点/争议：
1. 默认 yolo 权限，shell 访问并不受 worktree 隔离。
2. 没有 org/成员/权限，"团队"只靠共享 server + 每设备 token。
3. 触发器仅 cron，无事件驱动；重试、告警路由、日志保留未披露。
