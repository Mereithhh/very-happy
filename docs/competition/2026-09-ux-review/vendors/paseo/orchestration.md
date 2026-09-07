# Paseo（paseo.sh）— 工作流抽象与编排视角的竞品研究

- 研究日期：2026-09-03；研究者视角：资深产品设计/研究
- 对象版本快照：Paseo v0.7.2（2026-09-02 发布），GitHub 15.8k stars / 1.7k forks / 578 open issues，0.7.0 起改为 Apache-2.0；单人维护者 Mo Boudra（HN 自述 "team of one"）+ 活跃社区贡献者
- 为谁而研究：very-happy（veryhappy.dev，Happy Coder fork，web/PWA only，单 Owner + AI agent 集群）
- 证据分级：**OBSERVED** = 官方文档 / changelog / 发布说明 / 截图中直接看到；**INFERRED** = 由多处证据推断，未见明文
- 未读到的部分：paseo.sh/changelog 页面经 reader 只返回 0.1.91–0.1.110（2026-06/07）段落，0.2–0.7 的条目改用 GitHub Releases 逐版本核对；`docs/plugins/reference`、`docs/hub/security`、`docs/supported-providers` 只读了按问题抽取的片段

---

## 0. 结论先行

1. **Paseo 卖的心智模型是 "control plane for coding agents"**：一个 daemon 拥有 agent 生命周期 + worktree + dev server，所有客户端（desktop/mobile/web/CLI/SDK/MCP/Hub）都只是驱动这个 daemon 的客户端。它明确把自己和 Happy Coder 的差异定义为 "Daemon owns agent lifecycle" vs "Wraps the agent CLI"（OBSERVED，alternatives/happy-coder）。
2. **单聊天之上的"工作"抽象是 Project → Workspace → Session（tab）**："Paseo is organized around workspaces, not chats"。Workspace 是稳定容器（目录 + 隔离模式 local/worktree），agent、terminal、browser、diff 都是它里面的 tab（OBSERVED，docs/workspaces）。侧栏按状态分组（Ready to review / Working / Done）+ Pinned + History + Schedules（OBSERVED 于首页 mockup 截图；是否与 app 内实际分组一字不差为 INFERRED）。
3. **编排不是一个独立的"调度员"界面，而是"任何 agent + Paseo tools"**：打开 Enable Paseo tools 后，任何 agent 都能 create_workspace / create_agent / send_agent_prompt / create_heartbeat；官方话术是让用户对主 agent 说 "Stay as the orchestrator"（OBSERVED，docs/orchestration）。Paseo 子代理可跨 provider（Claude 计划 → Codex 实现 → 另一模型 review），并以完整会话出现在 composer 上方的 **Subagents track**；provider 原生子代理则只读展示（OBSERVED）。
4. **定时/常驻做了一个很干净的二分**：Schedule = 每次起新 agent 的 cron 任务（可 pause/resume/run-once/logs）；Heartbeat = 把 prompt 按 cron 打回**同一个** agent（MCP 只给 create/delete）。两者都能在聊天里自然语言创建（OBSERVED，docs/schedules*）。
5. **外部触发被拆成独立服务 Hub**：GitHub/Slack/Discord/manual 事件 → 仓库内 `.paseo/hub.yml` + `.paseo/workflows/*.yml` → 有序 steps → daemon 起 agent。有强制 `from_users` 白名单、classifier 用 enum 结构化输出做有界路由、step 级 GitHub 短期 token、max_runtime/idle_timeout、Activity 账本（含 4 种"未路由原因"）。**不排队、不重试**：daemon 离线就直接失败（OBSERVED，docs/hub/*）。托管版 €15/seat/月。
6. **自动化面完整且"agent-aware"**：CLI = app 的镜像；`PASEO_AGENT_ID` 让 agent 在 shell 里跑 `paseo run` 时自动成为其子代理；`--output-schema` 返回 JSON；`paseo wait`；SDK `labels` 作为应用自有元数据实现"跨重启的常驻角色"（OBSERVED，docs/cli、docs/sdk/recipes）。
7. **第一性原理评判**：Paseo 显著减少了"每个 agent 现在在干嘛"这一层的上下文负担（状态分组侧栏、tasks/subagents/diff pills、finish 通知含子代理结果、PR checks 内嵌）；但**没有减少"跨 workspace 的决策负担"**——没有统一的 needs-you 收件箱、没有并行方案的 compare/merge、编排者没有持久身份和记忆、agent 之间只有父子通道、Hub 失败不重试。人类仍要逐个 workspace 巡视、逐个 PR 审。
8. **对 very-happy 最值得借鉴的不是 Hub，而是三件小事**：(a) 以状态分组的工作列表 + 行内 PR/checks；(b) composer 上方的 tasks/subagents/diff pills 与 Subagents track；(c) Heartbeat/Schedule 二分与 "agent profiles 带人类写的 notes 供技能选角"。这些都直接服务于 Owner 想要的"幕僚长 + 角色机器人"方向，且不依赖 Paseo 的 daemon 架构。

---

## 1. 心智模型：control plane，不是"会话即标签页"

- 首页 hero："The control plane for coding agents / Run any coding agent from anywhere / Self-hosted, multi-provider, open source"（OBSERVED）。docs/why 的自我定位："Not a hosted agent, not an IDE, not a model provider. Paseo runs the CLIs you already use and stays out of the way."
- 架构：daemon（Node/TypeScript）在任意机器；客户端走 WebSocket 直连、SSH（0.7.0 新增）、Tailscale 或 E2EE relay（默认关闭、配对时询问；NaCl box；官方 relay 是 Elixir 开源项目 paseo-relay；HN 早期帖子说 relay 建在 Cloudflare Durable Objects 上）。daemon 还能自己 serve web UI，"UI 版本永远与 daemon 一致，没有 UI-vs-daemon skew"（OBSERVED，docs/web-ui）。
- 起源（HN Show HN，约 2026-03/04）："It started last September as a push-to-talk voice interface for Claude Code… Then review diffs, run multiple agents, and manage work across machines." 作者自述最兴奋的方向是 CLI "turning into a primitive for more advanced orchestration, loops, and agent teams"（OBSERVED）。
- 对本研究最重要的判断：Paseo 的"control plane"是**机器/进程层的控制面**（谁在哪台机器的哪个目录跑），不是**工作层的控制面**（哪些事项处于什么阶段、谁该拍板）。后者只做到了侧栏分组这一层。

## 2. 单聊天之上的"工作"抽象

### 2.1 Project → Workspace → Session
- "A workspace is the place where a task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab."（OBSERVED，docs/workspaces）
- 隔离模式：**Local**（共享现有目录）/ **Worktree**（托管 git worktree，最后一个 workspace 归档后自动 teardown 并删除）。0.1.97 "Simplify workspace model — run multiple workspaces on the same code without a worktree"（OBSERVED）。
- 创建 workspace 与创建 agent 是两个动作；可以先建 workspace 开 terminal/跑 service，再起 agent。
- worktree 的 `paseo.json`：setup/teardown、scripts、`type: service` 的脚本由 daemon 监管并分配端口、通过 `http://<script>--<branch>--<project>.localhost:<port>` 反代；服务之间通过 `PASEO_SERVICE_<NAME>_URL` 互相发现（OBSERVED，docs/worktrees）。这是 Paseo 对"并行 agent 不打架"的基础设施回答。

### 2.2 侧栏：状态分组、Pinned、History、Schedules
- 首页 mockup（截图 OBSERVED）：左栏顺序为 New workspace / History / Schedules / (Release Radar) / **Pinned** / **Workspaces**，Workspaces 下分 **Ready to review**（行内显示 PR #3981 · passed）、**Working**（Fix commit safe area… 4m）、**Done**（Release v0.7.0-beta.2 2h；Design semantic permission sy… my-server · 3981 · passed）。每行左侧图标是 provider（Codex/Claude），右侧是相对时间。
- 支撑这些分组的 changelog 证据：0.3.0 "Redesigned sidebar with clearer status colours… Choose what a sidebar workspace row shows: host, pull request, checks, and scripts"、"Name each host and give it a colour"；0.1.97 "Terminals show when their agent is working, idle, or waiting for input"；0.5.0 "workspace labels for sidebar organization and filtering"、"project filtering"、"optional branch and project names on workspace rows"、"drag-and-drop reordering for pinned workspaces"；0.1.108 "Pin workspaces"；0.1.97 "Reopen archived workspaces from History"；0.3.0 "Search your history by workspace, agent, and branch"；0.1.104 "Schedules screen"（均 OBSERVED）。
- INFERRED："Ready to review / Working / Done" 的状态机很可能是 agent 空闲且有变更或 PR 已开 = Ready to review、agent 在跑 = Working、已归档/合并 = Done；文档没有写明触发条件。"Release Radar" 未在任何文档出现，结合插件系统"可加 sidebar item"，推断它是插件贡献的侧栏项。

### 2.3 Agent thread 视图：pills、turn footer、Files/Changes/Commits
- 截图 OBSERVED：composer 上方三枚 pill：**6/6 tasks**、**3 subagents**、**+1.9k −684**；每个 turn 底部 "Worked for 31m 46s"；助手末句 "Ready for review."；右栏 Files / Changes / 3981（PR）tab，Changes 是带 +/− 计数的文件树，底部还有 Commits。
- 对应 changelog：0.4.0 "live task progress above the composer and in the timeline"；0.5.0 "Moved subagent and task trackers into pills above the composer"、"live workspace change counts above active agent composers"；0.6.0 恢复 Explorer 侧栏（Files + Changes 默认），"per-action settings for opening files, changes, subagents, and pull requests in the main panel or on the side"；0.2.0 "Browse workspace commit history and open individual commit diffs"；0.1.105 "changed files as a collapsible folder tree or flat list"；0.7.2 修复"completed turns without a visible prompt showing no completion time"（均 OBSERVED）。
- 降噪相关：0.1.108 "Summarize tool calls in a single collapsed item with a new appearance setting"；0.1.102 "Claude subagent narration stays out of chat"；0.1.107 "Oversized tool output no longer slows or floods chat timelines"；0.7.2 单条超长消息截断到 32,000 字符（OBSERVED）。

### 2.4 "Create a PR" 流
- 截图 OBSERVED：turn 末尾出现 **Create a PR** 按钮；下一 turn 是 "PR opened: Rebuild the homepage around live Paseo workflows. https://github.com/getpaseo/paseo/pull/3981" + 三条要点 + "Ready for review." + "Worked for 1m 18s"。
- 机制（OBSERVED）：PR title/body、commit message、workspace title、branch name 由 **metadata generation** 用便宜模型生成，候选顺序 haiku → gpt-5.4-mini → minimax-m3 → nemotron-3-super → 当前会话模型，失败逐个回落；可在 repo 的 `paseo.json` 用 `metadataGeneration.*.instructions` 覆盖措辞（docs/metadata-generation）。PR 面板：checks/reviews/comments 内嵌，"Attach pull request comments, reviews, threads, and failed check logs to chat"（0.1.94）；合并方式 squash/merge/rebase（0.1.98）；"Git controls now default ready branches to pull requests"（0.1.91）；PR 合并后自动归档 workspace（0.1.91/0.5.0 相关修复）；支持 GitLab/Gitea/Forgejo/Codeberg（0.2.0）；粘贴 PR 链接到 composer 变成 checkout 选项（0.2.0）。

## 3. 并行、fan-out、子代理可见性

- **Paseo subagent vs native subagent**（OBSERVED，docs/orchestration 表格）：
  - Provider：任意已配置 provider vs 与父相同
  - 目录：当前或显式指定的 workspace vs 父 provider 管
  - 生命周期：Paseo 管、可接 follow-up vs 父 provider 拥有
  - 检视：Subagents track 里的完整会话（可直接对话、改设置、归档）vs 只读 timeline
- 父子规则："when an agent creates another agent without a workspace ID, the new agent is its subagent in the same workspace. Passing a workspace ID changes where the subagent works, not who its parent is." 跨 workspace 的子代理仍挂在父的 Subagents track，同时 Paseo 会打开它的 workspace "so the work is not hidden"（OBSERVED）。
- **Detach** 是显式的人类动作（app 或 `paseo agent detach`），MCP 故意不暴露 detach 工具（OBSERVED，docs/mcp）。0.4.0 修复过 "open delegated agents being archived with their parent"（OBSERVED）——说明父子生命周期耦合曾造成事故。
- 官方 fan-out 范式（OBSERVED，docs/orchestration-workflows）：只读研究可共享一个 workspace（"Create three Paseo subagents in this workspace… Do not edit files"）；会改文件的各自 worktree；"Implement, then review" 用不同模型且 reviewer 不共享对话上下文；"Summarize what the subagents are doing and flag anything blocked" / "Tell the parser worker to…" / "Cancel the UI worker's current turn, but keep the agent"。
- 首页自动化示例（OBSERVED）："Take the open GitHub issues labeled ready and fan them out to separate worktree agents." → agent 回复 "I found two ready issues… create_agent #412 claude/opus-4.6 worktree… create_agent #417 codex/gpt-5.6-sol worktree… I will let you know when they finish."
- 子代理可见性是一条**反复返工**的线（OBSERVED，changelog）：0.1.107 "Inspect provider-created subagents and their live conversations from the Subagents track"；0.1.108 子代理显示真实名字 + 归档已完成子代理；0.3.0 "See the full conversation from a native Claude subagent"、OpenCode 子代理显示 task/type/model/token；0.4.0 修 "completed Codex subagents remaining marked active"；0.7.0 修 OpenCode 子会话 prompt 缺失。第三方 fork 作者（dev.to，2026-04-29）的原话："subagents… could look like generic long-running tool calls. From the phone, that read as 'is this thing stuck?'"。
- **没有** compare/merge：文档里没有"同一任务跑 N 个 agent 然后对比择优"的界面；只有通过 orchestrator 让它 "Summarize both diffs when done"（INFERRED：缺失，非明文否认）。

## 4. 跨会话通信与"管理其他 agent 的 agent"

- 通道（OBSERVED）：父 → 子：`send_agent_prompt` / `paseo send`；子 → 父：finish 通知（"You will get notified when the target agent finishes, errors, or needs permission"，skills/paseo/SKILL.md），0.1.97 "Finish notifications include subagent results"，0.1.108 "Background-agent updates now appear after the main reply"；agent-scoped `create_agent` 默认 `notifyOnFinish: true`。
- **没有同级 agent 互发消息**的原生通道；跨 daemon 通信是社区 MCP 项目 "Paseo Cross-Daemon Comms"（OBSERVED，docs/community）。
- **没有独立的 dispatcher/chief-of-staff 界面**。编排者就是普通会话 + Paseo tools；技能里明确要求 "Stay as the orchestrator"、"Don't poll list_agents or get_agent_status… The notification will tell you."（OBSERVED）。
- 角色的最接近实现是 **Agent profiles**（0.4.0 "host-wide agent profiles for reusable provider, model, mode, thinking, and feature settings"；0.5.0 一键从模型选择器创建 profile）+ 技能约定：`list_profiles` 返回人类写的 `notes`，技能"pick the profile whose notes best match the work"，选不到就走 provider discovery 并告诉用户（OBSERVED，skills/paseo/SKILL.md、paseo-handoff、paseo-committee）。历史上技能用 `~/.paseo/orchestration-preferences.json` 把角色（impl/research）映射到模型，第三方技能镜像站仍能看到旧版（INFERRED 为已被 profiles 取代）。
- 打包的编排技能（OBSERVED）：`/paseo-handoff`（零上下文接手者的 briefing 模板：Task/Context/Relevant files/Current state/What was tried/Decisions/Acceptance criteria/Constraints；标题 `[Handoff] <task>`；留在父的 subagent track 直到人手动 detach）、`/paseo-committee`（两个不同 provider 家族的高推理模型并行分析、互相传递论点直到收敛、硬规则 no-edits、"Trust the finish notification… Models can reason for 15–30 minutes"）、`/paseo-advisor`（单个只给判断不做事的第二意见）、`/paseo-help`、`/paseo-plugin`。0.4.0 **移除**了 `paseo chat` 和 `paseo loop`（Breaking，OBSERVED）——"loop" 被 heartbeat/schedule 与 shell 循环取代。
- SDK recipe "Keep a resident role across process restarts"：用 `labels: { "my-app-role": "planner" }` 在 `agents.list` 里找回同一个 planner，找不到才新建（OBSERVED，docs/sdk/recipes）。这说明"常驻角色"被当成**集成方自己的责任**，不是产品内概念。
- 语音模式其实是一个隐藏的 meta-agent："Voice LLM orchestration: hidden agent session using your configured provider… Tooling path: MCP stdio bridge for voice tools and agent control"、"Voice mode can launch and control agents"（OBSERVED，docs/voice）。STT/TTS 默认本地 ONNX（parakeet / kokoro）。

## 5. 定时与常驻：Schedules vs Heartbeats

- Schedule："starts a new agent for you on a cron cadence: at this time, run this prompt, in this repo, with these agent settings"；可 inspect/pause/resume/run-once/update/delete/logs；`--every 30m` 只是编译成 cron 的预设；`--max-runs`、`--expires-in`、`--timezone`、`--run-now`；0.1.104 "Scheduled and loop runs each get their own workspace in the sidebar"（OBSERVED）。
- Heartbeat："sends a recurring prompt back into one existing agent so it can reassess and continue the same conversation"；MCP 只有 create/delete（改就删了重建，"prevents a heartbeat from silently becoming a different job or agent"）；CLI 只能改 cron；需要 `PASEO_AGENT_ID`（OBSERVED）。用例：babysit CI、看部署、分步迁移。
- 从聊天创建："Every weekday at 9am, triage new GitHub issues and PRs…"、"Keep working on this refactor — wake yourself every 20 minutes"（OBSERVED，docs/schedules-chat）。
- 判断：这是 Paseo 里最"减负"的设计之一——把"我得记得回来看"变成"agent 自己回来看"，且把两种语义分开避免误用。但 heartbeat 只是把 prompt 打回同一会话，会话上下文会持续膨胀（0.5.0 修过 "repeated copy and fork footers after heartbeat runs"），文档没有讨论压缩/清理。

## 6. 外部触发：Hub

- 定位（OBSERVED，docs/hub、paseo.sh/hub）："the layer above your daemons"；给 daemon 加它自己没有的能力：从 GitHub/Slack/Discord 自启动 agent、配置随仓库 push 部署、"A record of everything that arrived, what it matched, and what ran"、团队共享视图。为什么独立服务："The daemon stays one lean executable on one machine… The Hub is meant to be exposed to the internet, shared with a team, and run multi-tenant." 任何人都能用同一套 RPC 造自己的 hub。
- 模型（OBSERVED，docs/hub/concepts）：connection / daemon / project / environment（daemon + cwd + 可选 worktree）/ trigger / workflow / step。事件 `github.issue_created|pull_request_created|issue_comment_created|…|issue_label_added`、`slack.mention`、`discord.mention`、`manual.run`。**`filters.from_users` 必填非空**，否则激活失败（Slack/Discord 用 user id 不是显示名）。两个 trigger 都匹配就都跑，无优先级。
- workflow 能力（OBSERVED，docs/hub/workflows）：steps 按文件顺序；`if` 可读 inputs/values/前序 step 输出；step 可声明 `output.schema`，后续 step 用 `enum`/`const` 有界地选 environment/agent（"classifier → worker"，动态内联 `provider: ${{ … }}` 会被拒绝）；prompt 由 `text`/`include: partials/*.md` 有序拼装，`${{ paseo.prompt }}` 是规范化请求文本，`${{ paseo.context }}` 才会注入 provider 上下文 JSON；`allow_outputs: slack.reply|discord.reply` 带 `max`/`required`；GitHub 没有 reply 能力，靠 step 级 `github` 块（Hub 起步时 mint installation token、结束时撤销，`repositories`/`permissions`/`duration ≤ 1h`）；`max_runtime` + `idle_timeout` 三层截止。
- 配置（OBSERVED）：`.paseo/hub.yml`（命名 environments + agents，agent 可携带 provider 原生策略如 Claude `disallowedTools`/`sandbox`、OpenCode `permission` map）+ `.paseo/workflows/*.yml`；GitHub 源随默认分支 push 同步为不可变 revision，失败保留旧 revision；`paseo hub deploy --dry-run`；`paseo hub init` 引导式生成 starter。
- 可观测性（OBSERVED，docs/hub/activity）：Project → Activity；Connections → Known unrouted events 记录 `no_project_route` / `no_trigger_for_source` / `trigger_filters_rejected` / `configuration_unavailable`；8 步排障清单。
- 硬限制（OBSERVED）："Hub does not queue events. A dispatch that fails because the daemon was offline stays failed"；"An agent that is not told to call hub.reply and hub.finish_execution can answer in its own transcript and never report back"。
- 商业化：自托管免费开源（`npx @getpaseo/hub`，嵌入式数据库起步）；托管 €15/seat/月，只触发不计席位；规划中 "Provisioning daemons for your team / Sharing settings and skills across a team / More integrations"（OBSERVED）。

## 7. 自动化面：CLI / MCP / SDK

- CLI（OBSERVED，docs/cli）：`run/ls/attach/send/logs/stop/wait`、`--background`、`--output-schema`（返回匹配 JSON，不能与 background 同用）、`--new-workspace local|worktree --worktree-mode branch-off|checkout-branch|checkout-pr`、`--host` 支持 `host:port`、unix socket、SSH URI、甚至 relay 的 pairing offer URL；`permit ls/allow/deny`；`agent mode <id> plan|bypass`；`schedule`/`heartbeat`；`plugin`；`hub`。**agent-aware**："When an existing Paseo agent runs the same command, Paseo recognizes it through PASEO_AGENT_ID… the new agent becomes its subagent in the same workspace."
- 文档给的 implement+verify 循环是一段 bash while 循环，用第二个 agent + `--output-schema '{criteria_met: boolean}'` 当裁判（OBSERVED）。
- MCP 工具目录（OBSERVED，docs/mcp）：Agents（create/send/get_status/list/cancel/archive/kill/update(labels, settings)/get_agent_activity/set_agent_mode）、Workspaces、Workspace scripts、Terminals（create/kill/capture/send_keys）、Schedules & heartbeats、Providers（list_providers/list_models/inspect_provider；技能里还有 `list_profiles`）、**Permissions（list_pending_permissions / respond_to_permission）**、Browser（opt-in）、Voice（speak）。0.7.0 "readable prompts, details, and results for Paseo tool calls"。
- SDK `@getpaseo/client`（0.4.0 起正式支持；OBSERVED）：`agents.create({config, cwd, prompt, title, labels})`、`waitForFinish`、`run(prompt, {timeoutMs})`、`workspaces.open(path)`、`agents.ref()` 恢复句柄；recipes：issue → 可见工作（labels `issue-provider`/`issue-id`）、并行三 reviewer、常驻 planner、临时 agent 清理。

## 8. 权限系统

- OBSERVED：permission 请求以卡片出现在 timeline（0.7.0 修 "canceled Claude permission requests leaving stale permission cards"）；模式切换 Shift+Tab 循环（0.1.100）、模式图标（0.1.108）、Command Center 改 mode（0.3.0）；0.2.0 "New Claude and Codex agents default to safer automatic approval modes when supported"、"Permission and thinking changes made during a turn now show when they take effect"；0.1.106 Codex MCP 权限请求；0.3.0 "Approve all ACP tool calls with one setting"；0.5.0 修 "composer steers remaining unread while Claude or Codex waited on a permission"。CLI `paseo permit`、MCP `list_pending_permissions`/`respond_to_permission`——即**一个 agent 可以替另一个 agent 批权限**。子代理"needs permission"会通知父 agent（skills/paseo）。
- Hub 侧的"语义权限"是 provider 原生策略透传（`disallowedTools`、`sandbox`、OpenCode `permission` map）+ step 级 GitHub 授权 + `allow_outputs`，文档明说 "Hub defines no common sandbox abstraction"（OBSERVED，docs/hub/security 片段）。
- 关于 "Design semantic permission system"：它只是首页 mockup 里 Done 分组下的一个 workspace 标题（OBSERVED），没有任何文档描述这样一个功能；GitHub issue #960（2026-05）讨论 Codex "Auto-review" 模式（guardian 分类器）尚未见于发布说明（INFERRED：未落地或未记录）。

## 9. 语音 / 移动端 parity / relay（只讲与编排相关）

- 首页声明 "The native mobile app has full feature parity with desktop"（OBSERVED）；但 docs/browser 写 "Desktop only, for now… The daemon itself doesn't run a browser"（OBSERVED）——parity 声明至少在浏览器自动化上不成立。
- 移动端已有：Command Center（0.1.91）、附件（0.1.97）、subagent/task pills（0.5.0）、插件客户端贡献 "including mobile"、语音；反复出现的移动端修复（sidebar 卡住、键盘遮挡、JS stall）说明 parity 是持续追赶而非一次达成。
- relay 默认关、E2EE、"Treat the QR code like a password"；daemon 可自 serve web UI、密码 bcrypt、Host 头白名单防 DNS rebinding（OBSERVED，docs/security）。对 very-happy 的启示是它把"自托管 web UI"当一等路径而非附属。

## 10. 插件如何给所有客户端加 UI

- OBSERVED（docs/plugins、reference 片段）：插件 = 安装到某个 daemon 的 TypeScript 工程，`index.client.tsx`（跑在所有客户端，React Native，含手机）+ `index.server.ts`（daemon 子进程）+ `shared/`（RPC 契约）。可贡献：surface + sidebar item、workspace/agent panel（作为 tab）、Command Center item、slash command（客户端执行、不发给 agent）、composer pill、**timeline transformer + renderer（把 tool_call 行替换成自定义卡片，含流式更新）**、theme、attachment source（composer 里可搜索的外部资源，示例是 issues）、schema 校验的 daemon RPC；`useWorkspace`/`useAgent` 读缓存状态；`client.paseo.agents.subscribe` 订阅。信任模型："trusted, unsandboxed code"。0.7.0 起可从 git 仓库安装。
- 意义：Paseo 把"给 agent 加一个 issue 附件源 / 给时间线加一个 review 卡片"的扩展点开放给了第三方，而不是自己做 Linear/Jira 集成。

## 11. Paseo 对 Happy Coder 的判词（OBSERVED，alternatives/happy-coder）

对比表逐项（Paseo / Happy Coder）：License Apache-2.0 / MIT；Desktop app macOS+Linux+Windows / macOS；Native mobile 两者都有；Architecture "Daemon owns agent lifecycle" / "Wraps the agent CLI"；Providers 4 native + 30+ ACP + custom / Claude Code, Codex；Split workspace 都有；In-app terminal 都有；In-app browser/preview 都有；**GitHub workflow in app：Commit, push, PR, checks, reviews, merge / —**；**Managed Git worktrees：Yes / Existing worktree paths**；**Per-worktree dev server URLs：Yes / —**；**CLI：Run, --host, ls, send, schedule, loop / Launch and control sessions**（正文："It does not document schedules or loops"）；**Application plugins：Server code and native client components / No**；Voice：Local or configured cloud speech / Yes。

对 very-happy 的核对：very-happy 是 web-only（无 macOS app），已有 spawn/send/MCP 入站与 webhook 出站（docs/channels.md）、task board、durable tmux 终端——这些 Paseo 页面没有覆盖，但"工作流层"的空白（PR 流、托管 worktree、schedule/heartbeat、插件）在 very-happy 同样存在。

## 12. 第一性原理评判

**减少了什么上下文负担（做得好）**
- 状态分组侧栏 + 行内 PR/checks/host 让"哪些事等我"一眼可见（比按时间排序的会话列表强一档）。
- pills（tasks/subagents/diff）把"进展到哪"压缩成三个数字；turn footer 的 "Worked for Xm" 给出时间感。
- finish 通知带子代理结果、`notifyOnFinish` 默认开，编排者不用轮询。
- Schedule/Heartbeat 把"记得回来看"外包给 agent。
- Hub Activity 的 4 种未路由原因，让"为什么没跑"可自助排查。
- metadata generation 用便宜模型自动起名/写 PR，去掉一类微决策。

**人类仍要 babysit 的地方（缺口）**
- 没有跨 workspace/跨 host 的"需要你决策"收件箱：权限、失败、PR review 分散在各行的状态色里；`list_pending_permissions` 只有 API 没有文档化的聚合 UI（INFERRED）。
- 并行方案没有 compare/merge：fan-out 之后"选哪个"完全靠人读两个 diff 或让 orchestrator 总结。
- 编排者无持久身份：换一个 workspace 就没有"幕僚长"了；常驻角色靠 SDK labels 自己维护；heartbeat 只能续同一会话、上下文不断膨胀。
- 只有父子通道，子代理之间、兄弟 workspace 之间不能互相通知；detach 只能人做。
- Hub 不排队不重试，daemon 掉线的事件要人重新触发；agent 不叫 `hub.finish_execution` 就"自说自话"。
- 成本/用量只有会话级（HN 2026-06 维护者："no per-project summary though"），角色/项目级预算不存在。
- UI 结构本身在震荡（0.5.0 引入 user-directed Side panel，0.6.0 因为"empty"回退到 Explorer），说明工作层抽象仍在摸索。

## 13. "角色机器人虚拟办公室 + 幕僚长"需要什么：Paseo 已有 / 明显缺

| 需要的能力 | Paseo 已有 | 明显缺 |
| --- | --- | --- |
| 角色定义（provider/model/mode/权限/职责说明） | Agent profiles + `notes`；Hub named agents 带 provider 原生策略 | 角色没有记忆、没有专属工作队列、没有预算 |
| 幕僚长（持续接收事项、派工、汇总） | 任意 agent + Paseo tools；`/paseo-handoff`、`/paseo-committee`；voice 隐藏 meta-agent | 无常驻、无跨 workspace 视野、无"待办→派工→验收"的状态机 |
| 派工与回报通道 | create_agent/send_agent_prompt；finish 通知含结果与 needs-permission | 无同级消息、无广播、无跨 daemon（社区 MCP） |
| 常驻/定时 | Heartbeat（同会话）/ Schedule（新 agent） | heartbeat 上下文治理 |
| 入站触发 | Hub：GitHub/Slack/Discord/manual，白名单、classifier 路由、step 级授权 | 不排队不重试；Linear/Jira 等靠插件 attachment source |
| 出站回报 | hub.reply（Slack/Discord）、GitHub 用 gh；push 通知 | 无统一"日报/周报"或状态摘要面 |
| 事项/任务对象 | workspace（有目录、有 PR、有状态）；labels（app 自有） | 没有独立于 workspace 的 task/issue 对象；task board 缺席 |
| 审计 | Hub Activity（触发级）；`get_agent_activity` | 没有"谁批了什么权限 / 谁改了什么"的跨 agent 账本 |
| 择优/合并 | — | 并行方案 compare/merge 缺席 |

## 14. 可借鉴（按 UX 影响排序）与反模式

**可借鉴**
1. 以状态分组的工作列表（Ready to review / Working / Done）+ Pinned + History，行内显示 PR 号、checks、host 名——直接替换"按时间排的会话列表"的心智模型。
2. composer 上方的 tasks / subagents / diff pills + Subagents track（点开看子代理完整会话；native 子代理只读；Archive finished）。
3. Heartbeat / Schedule 二分，且都能在聊天里自然语言创建；每次 schedule run 自成一个 workspace。
4. Agent profiles 带人类 `notes`，技能通过 `list_profiles` 选角——这是"角色机器人"最便宜的落地方式。
5. agent-aware CLI/MCP：调用方是 agent 就自动挂为其子代理；`--output-schema` + `wait` 让 agent 写 bash 级编排。
6. finish 通知带子代理结果、"needs permission" 也回给父 agent，`notifyOnFinish` 默认开。
7. 权限即工具（`list_pending_permissions` / `respond_to_permission` / `paseo permit`），让 assistant 屏能代批或聚合。
8. Hub 的 workflow 语法要点：`from_users` 必填、classifier 用 enum 有界路由、step 级短期凭证、max_runtime/idle_timeout、Activity 的未路由原因——可直接用于 very-happy 的 webhook/spawn 入站。
9. metadata generation：便宜模型链式回落 + 仓库级措辞覆盖，自动 workspace title / branch / commit / PR body。
10. Fork chat 到新 tab 或新 worktree、从失败 turn fork、运行中 fork。
11. "Attach PR comments / reviews / failed check logs to chat" 与粘贴 PR 链接即 checkout。
12. 插件式 timeline transformer（把工具调用行替换成语义卡片）与 "Summarize tool calls in a single collapsed item" 设置——对应 very-happy 的对话降噪。

**反模式**
1. 编排者 = 普通聊天 + "Stay as the orchestrator" 口令：无持久身份、无跨 workspace 视野，靠技能文本约束行为（"don't poll"）。
2. 两套子代理（native 只读 / Paseo 完整）导致可见性长期返工；"看不见就以为卡了"是移动端的真实体验。
3. Hub 不排队不重试、agent 忘记调 `hub.finish_execution` 就石沉大海——把可靠性责任推回给人和 prompt。
4. "full feature parity" 的营销声明与 "Desktop only, for now" 的文档自相矛盾。
5. UI 结构震荡（0.5.0 Side panel → 0.6.0 回退 Explorer）与超宽 provider 面（39 个）带来的回归；单人维护下 changelog 里同一区域反复修复。

## 15. 未解问题

- app 内侧栏分组是否确为 "Ready to review / Working / Done"，触发条件是什么（PR 已开？agent idle 且有 diff？）——只在 mockup 中观察到。
- 跨 workspace/host 的待批权限是否有聚合 UI；通知点击是否落到具体权限卡。
- "Release Radar" 是否为插件；plugin-examples 目录里有哪些官方示例。
- heartbeat 长期运行的上下文治理（压缩/清理）如何处理。
- 是否有并行方案 compare/择优 的路线图；是否有项目级用量/成本视图（HN 6 月尚无）。
- Hub 托管版的实际采用与"collaboration features planned"的具体内容。
- 0.1.x → 0.2.0（2026-07-24）的版本跳变原因与 0.2–0.7 changelog 未在 paseo.sh/changelog reader 输出中出现的原因（页面存在锚点 #release-0.7.2，可能是渲染/抓取差异）。

---

## Sources（全部于 2026-09-03 读取）

- https://paseo.sh — 首页：hero 文案、Build/Review/Ship/Extend mockup（侧栏分组、pills、Create a PR、Files/Changes/Commits）、"fan them out to separate worktree agents" 示例、FAQ、作者签名；截图另存于 raw/homepage.jpg
- https://paseo.sh/docs — 安装路径、PASEO_HOME、Prerequisites（gh CLI 用于 PR-aware worktrees）
- https://paseo.sh/docs/why — 架构/提供商/并行/自动化/“What it isn't”
- https://paseo.sh/docs/workspaces — Project→Workspace→Session、Local/Worktree 隔离、agent-aware `paseo run`
- https://paseo.sh/docs/worktrees — `paseo.json` setup/teardown/scripts/services、端口分配、反代 URL、服务互发现
- https://paseo.sh/docs/orchestration — Paseo vs native subagents 表、Enable Paseo tools、Subagents track、detach、heartbeat
- https://paseo.sh/docs/orchestration-workflows — fan-out/并行/implement-then-review/redirect 提示词
- https://paseo.sh/docs/schedules 、 https://paseo.sh/docs/schedules-chat 、 https://paseo.sh/docs/schedules-cli — Schedule vs Heartbeat 语义、CLI 参数、时区/预设
- https://paseo.sh/docs/mcp — 完整工具目录（含 Permissions 工具）、父子/workspace 规则、无 detach 工具
- https://paseo.sh/docs/skills — /paseo、/paseo-handoff、/paseo-committee、/paseo-advisor
- https://raw.githubusercontent.com/getpaseo/paseo/main/skills/paseo/SKILL.md — `list_profiles`+`notes`、notifyOnFinish 默认、"Don't poll"
- https://raw.githubusercontent.com/getpaseo/paseo/main/skills/paseo-handoff/SKILL.md — briefing 模板、detach 为人类手势
- https://raw.githubusercontent.com/getpaseo/paseo/main/skills/paseo-committee/SKILL.md — 两成员对照、no-edits、trust the finish notification
- https://github.com/getpaseo/paseo/tree/main/skills — 当前技能目录（advisor/committee/handoff/help/plugin/paseo）
- https://skillselion.com/skills/getpaseo/paseo/paseo-orchestrate — 第三方镜像，旧版技能中的 `~/.paseo/orchestration-preferences.json` 与 detached/current 创建模式（仅作历史佐证）
- https://paseo.sh/docs/cli — 命令面、`--output-schema`、`PASEO_AGENT_ID`、permit、agent mode/detach、hub 子命令、bash 编排循环
- https://paseo.sh/docs/sdk 、 https://paseo.sh/docs/sdk/recipes — SDK API、issue→work、并行 reviewer、resident role via labels
- https://paseo.sh/docs/hub 、 https://paseo.sh/hub — Hub 定位、独立服务的理由、托管定价、规划项
- https://paseo.sh/docs/hub/concepts 、 /hub/triggers 、 /hub/workflows 、 /hub/github 、 /hub/activity 、 /hub/configuration 、 /hub/daemons 、 /hub/quickstart 、 /hub/faq 、 /hub/security（片段）— 事件模型、from_users 必填、classifier 路由、step 级授权、deadline、Activity 未路由原因、不排队不重试、provider 原生策略
- https://paseo.sh/docs/plugins 、 https://paseo.sh/docs/plugins/reference（片段）— 插件工程结构、贡献类型（timeline transformer/renderer、attachment source、composer pill 等）、信任模型
- https://paseo.sh/docs/metadata-generation — 便宜模型候选链、仓库级 instructions 覆盖
- https://paseo.sh/docs/voice — 本地 STT/TTS 模型、隐藏 agent 会话做语音编排
- https://paseo.sh/docs/security 、 https://paseo.sh/docs/connectivity 、 https://paseo.sh/docs/web-ui 、 https://paseo.sh/docs/configuration — relay E2EE、SSH/Tailscale、daemon 自 serve web UI、密码/Host 白名单
- https://paseo.sh/docs/browser — 浏览器自动化 "Desktop only, for now"
- https://paseo.sh/docs/providers 、 https://paseo.sh/docs/supported-providers（片段）、 https://paseo.sh/docs/claude-code — 两层 provider 模型、Claude 认证不随会话热更新
- https://paseo.sh/docs/community — 社区项目（Cross-Daemon Comms、Paseo Icon 等）
- https://paseo.sh/alternatives/happy-coder — 对 Happy Coder 的逐项判词
- https://paseo.sh/alternatives/claude-desktop 、 https://paseo.sh/alternatives/codex-app 、 https://paseo.sh/alternatives/superset — 同类对比页，CLI/自动化/插件的定位一致
- https://paseo.sh/changelog — reader 仅返回 0.1.91–0.1.110（2026-06-08 至 07-16）：Schedules screen、Subagents track、pin、fork、tool-call 折叠等
- https://github.com/getpaseo/paseo/releases — 版本序列（0.1.x → 0.2.0 于 2026-07-24 → 0.7.2 于 2026-09-02）
- https://github.com/getpaseo/paseo/releases/tag/v0.2.0 、 /v0.3.0 、 /v0.4.0 、 /v0.5.0 、 /v0.6.0 、 /v0.7.0 、 /v0.7.1 、 /v0.7.2 — 0.2–0.7 的 Added/Improved/Fixed（sidebar 重设计、profiles、pills、plugins、Side panel 引入与回退、SSH、Apache-2.0、移除 chat/loop 等）
- https://github.com/getpaseo/paseo — README（CLI/SDK/Skills 摘要、包结构）
- https://paseo.sh/blog 、 https://paseo.sh/blog/hello-world 、 https://paseo.sh/blog/i-was-wrong-about-electron — 博客仅两篇；Electron 迁移文说明通知点击落点是产品要求
- https://news.ycombinator.com/item?id=47575827 — Show HN（约 2026-03/04）：起源、架构、"CLI as primitive for orchestration, loops, agent teams"
- https://news.ycombinator.com/item?id=48377250 — Show HN（2026-06-03）：team of one、商业计划在 team/enterprise 层、用量仅会话级、Claude 订阅计费变化
- https://dev.to/thisisryanswift/forking-paseo-mobile-vibe-coding-for-me-48pa — 2026-04-29 用户 fork 记录：子代理"像卡住"、会话接手痛点
