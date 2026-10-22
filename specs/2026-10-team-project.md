# 团队与项目：团队默认带同名项目，团队上下文就是项目上下文

> 状态：Final（Lead 2026-10-21 定心智模型；实现 B-726）
> 日期：2026-10-22 ｜ 关联 backlog：B-726（承接 B-644～B-651，`specs/2026-10-projects.md`）
> 关系：本 spec 只改「团队 ↔ 项目」的关系与入口；项目本身（说明、记录、注入、侧栏分组）以 `specs/2026-10-projects.md` 为准，两者冲突时以本 spec 的 §2 心智模型为准。

## 背景

Owner 原话（10-21）：「团队和项目的关系感觉还是不太清楚。我创建团队是团队，但是好像没有项目。然后我创建项目和团队好像又没有关系……创建一个团队默认就创建一个同名的项目了……团队的 context 更新能力就是依存于项目上的。团队也可以绑定一个项目，然后普通的 session 也可以绑定到一个项目里。我觉得这些灵活的操作都要有入口。」

## 1. 心智模型

| 名词 | 是什么 | 存什么 |
|---|---|---|
| **项目** | 做什么 | 目标、说明（人写）、记录（决定 / 发现 / 交接）、成员会话、挂在下面的团队 |
| **团队** | 谁来做、怎么做 | 负责人 + 成员、默认 harness 与模型、并行上限、任务树与验收 |
| **团队上下文** | = 所属项目的上下文 | 团队本身不存上下文 |

- 一个团队属于至多一个项目（`AgentTeam.projectId`，多对一）；一个项目可以有多个团队，UI 按「通常一个」优化。
- 普通会话也可以直接属于项目（显式成员）。团队的负责人和成员会话**经团队**成为项目成员（读时派生，`via: team`，不双写）。显式成员优先于团队派生。
- 项目里的所有会话都能读项目上下文（首轮前缀 + `mcp__happy__project_context`），也都能用 `mcp__happy__project_note` 追加记录。说明只由人在 Web 上改。
- 新建团队**默认**新建同名项目并关联；也可选已有项目或「不放进项目」。老团队不自动迁移，团队页提示一键关联（§6）。

## 2. 现状审计（2026-10-21，origin/main 6b997df7）

### 2.1 团队 ↔ 项目

| 问题 | 结论 | 证据 |
|---|---|---|
| 新建团队会不会建项目 / 挂项目 | **不会**。`POST /v1/teams` 只收 `name/machineId/requestId/launch` | `happy-wire/src/teams.ts` `TeamCreateSchema`；`happy-server/sources/app/teams/store.ts` `createTeam` |
| CLI `team_create` | 同上，只建团队 | `happy-cli/src/teams/client.ts` `initialize` |
| 团队设置能否看到 / 改所属项目 | **不能**。设置页只有执行模式与 `TeamOptions`（harness / 模型 / 并行） | `TeamsScreen.tsx` settings 视图、`TeamOptions.tsx` |
| 团队页头 | 只有团队名、电脑在线状态，无项目 | `TeamsScreen.tsx` header |
| Web 怎么知道团队属于哪个项目 | 只能从 `ProjectView.teamIds` 反查；`TeamState` 没有项目字段 | `happy-wire/src/projects.ts` `ProjectView.teamIds` |
| 项目页能否看到团队 | 概览有「团队」段，但只在已挂团队时出现；没有「在此项目中新建团队」 | `ProjectScreen.tsx` `ProjectOverview` |
| 项目页能否关联已有团队 | 只在 ⋯ 设置里，且只列「电脑已是项目目录」的团队；服务端也拒绝 `team_machine_not_in_project` | `ProjectScreen.tsx` `ProjectSettings`；`projects/store.ts` `attachTeam` |
| 团队成员会话能否拿到项目上下文 | **能**——只要团队已挂项目：成员经 `via: team` 派生为项目成员，wrapper 首轮注入 team-member 变体 | `projects/store.ts` `membershipOf` / `teamDerivedMembers`；`happy-cli/src/projects/prompt.ts` |
| 负责人收到什么 | 与成员相同的 team-member 变体，其中写着 "Leave project notes to the lead"——发给负责人本人很别扭（B-725 顺带发现） | `prompt.ts` `chooseVariant` |

### 2.2 会话 ↔ 项目入口

| 入口 | 移入 | 移出 | 证据 |
|---|---|---|---|
| 侧栏会话行菜单（右键 / 长按 / ⋯）「移到项目…」 | ✅ | ✅（弹窗里选「无项目」，仅显式成员） | `Sidebar.tsx` `onMoveToProject`、`MoveToProjectModal.tsx` |
| 新建会话弹窗「项目」 | ✅ | —（选「无项目」即不入） | `NewSessionModal.tsx` |
| 会话页头 ⋯ 菜单 | ❌ | ❌ | `ChatHeader.tsx` |
| 项目页成员行 | ❌（只读链接） | ❌ | `ProjectScreen.tsx` |
| 会话页目录建议横幅 | ✅（加入） | ❌ | `ProjectSuggestionBanner.tsx` |
| ⌘K | ❌ | ❌ | `CommandPalette.tsx` |

另：三处项目选择（新建会话、移到项目、项目设置的电脑）都是原生 `<select>`，与设计契约不符。

### 2.3 侧栏「按项目分组」术语冲突

- **分组本身按的是 B-644 项目实体**，不是目录：`groupRowsByProject` 先按显式成员、再按 `ProjectView.teamIds` 把会话和团队放进项目组；剩下的才进「未归属」，并在其下**按目录**再分子组（`sidebarProjectGroups.ts`、`sidebarWorkspaceGroups.ts`）。
- **困惑的来源**：
  1. 用户还没有任何项目时，「按项目分组」下只剩目录子组；而「未归属」小标题只在**至少有一个项目组**时才出现（`Sidebar.tsx` `kicker: i === 0 && projectGrouping.projects.length > 0`）。于是菜单写着「按项目分组」，屏幕上却只有一排目录组。
  2. 组头 CSS 全大写（`.sb-section-head { text-transform: uppercase }`）。截图里的 `NO WORKING DIRECTORY`、`DATA /fsx/data`、`PROJECT /home/dev…` 分别是「未指定工作目录」、名为 `data` 的目录、名为 `project` 的目录——最后一个恰好叫 project，看起来就像「项目」。
  3. 新建团队表单把工作目录叫「项目文件夹 / Project folder」，配置摘要叫「电脑、项目与 Agent」（`firstUseCopy.ts`）。
- **结论**：分组语义正确，不需要另加「按项目」模式；改文案：
  - 未归属区第一组**始终**带小标题「未归属项目 · 按目录 / Not in a project · by folder」，无论有没有项目组；
  - 新建团队表单：「项目文件夹」→「工作目录」，「电脑、项目与 Agent」→「电脑、目录与 Agent」；文档同步。
  - 团队在侧栏的位置：按项目分组时，挂了项目的团队就在该项目组里（`teamIds`，B-647 已实现）；B-726 让新团队默认有项目，所以团队默认出现在同名项目组下。团队不该挂在成员 worktree 的 UUID 目录组下是 B-723 O1 的范围。

## 3. 设计

### 3.1 协议（只加可选字段，旧端忽略）

| 位置 | 改动 | 旧端行为 |
|---|---|---|
| `TeamCreateSchema.project?` | `{ projectId? , inheritFromSessionId? , create? , directory? }`；优先级 `projectId` > `inheritFromSessionId` 所在项目 > `create`（建同名项目） | 旧 server 剥掉该字段 → 团队照旧创建、无项目；旧 Web/CLI 不发 → 无项目 |
| `POST /v1/teams/:id/project`（新） | `{ projectId: string \| null }` 关联 / 解绑；`{ create: true, requestId }` 建同名项目并关联（按 requestId 幂等） | 旧 server 404 → Web 提示「服务器版本过旧」 |
| `TeamState.projectId?` | 视图字段，来自 `AgentTeam.projectId` 列；**不写进 state JSON** | 旧 Web 忽略；Web 以 `ProjectView.teamIds` 为准（绑定后刷新即时） |
| `ProjectSessionContext.team.lead?` | 会话是团队根 bot 时为 true | 旧 CLI 忽略；新 CLI 遇旧 server（无该字段）回落成员变体 |

服务端规则（`happy-server/sources/app/projects/store.ts`）：
- 建团队时在**同一事务**里建 / 挂项目：重试同一 `requestId` 返回已绑定的团队，不会多建项目；同名项目的 `requestId` 由团队 id 派生。
- 同名项目的目录 = 团队启动目录（`launch.directory`），无启动目录时依次用负责人首个 spawn 的目录、负责人目录、请求带的 `directory`（CLI：创建会话的 cwd）。
- **B-755：团队 worktree（`…/teams/worktrees/<spawn op id>`）永远不是项目目录。** 上面任一候选落在团队 worktree 里，就沿 id 同名的 spawn 操作（同账号、同电脑）找到它的源目录，源目录本身还是 worktree 就继续追（≤8 跳），子目录保留相对位置；追不到就跳过这个候选，全都追不到时项目不写目录（项目页提示去设置里加）。CLI `team_create` 先用 `git rev-parse --git-common-dir` 的上一级换成主 checkout，失败再交给服务端追。规则在 happy-wire `teamWorktree.ts`，server / Web（`teamHomeDirectory`、目录建议、最近目录、新对话落点）/ CLI 共用。
  - 事故（10-22）：Owner 在一个团队的负责人会话（cwd = 它的 worktree）页面上按「+」，快捷新对话用了「当前查看会话的目录」→ 新会话落进 worktree，成功后又被记进 `recentMachinePaths` 顶部；之后的快捷新对话与新建团队表单（默认取最近目录、配置区折叠）都落到这个 worktree，于是团队的 `creationLaunch.directory` 和同名项目目录都是它，worktree 里另外 4 个无关会话都收到「加入项目」。修法：worktree 不进最近目录（写入时丢弃、读取时过滤）、从 worktree 上下文开的新对话改落到仓库、目录建议忽略 worktree 目录和身处 worktree 的会话、存量项目页一键改成仓库路径（`scripts/ops/worktree-project-folders.mjs` 只读列清单）。
- 关联已有项目时，若团队电脑不在项目目录里，**自动把团队的工作目录加进项目目录**（团队带着自己的工作地点加入）；只有团队没有已知目录或目录已满 20 个才拒绝 `team_machine_not_in_project`。这放宽了 B-644 的「团队机器 ∈ 项目目录」校验。
- 项目数达上限（`project_count_quota_exceeded`）时，新团队照常创建、只是不带项目；`VH_PROJECTS_ENABLED=false` 时同样跳过。指定的 `projectId` 不存在则整个创建失败（用户明确选的）。
- 解绑 = `AgentTeam.projectId = NULL`；成员随即不再派生为项目成员，显式成员不受影响。

### 3.2 CLI

- `team_create`（以及 Web「用这个对话组建团队」走的 adopt 流程）默认带 `project: { inheritFromSessionId: <本会话>, directory: <本会话 cwd> }`：本会话已在项目里 → 团队进这个项目；否则建同名项目。工具新增可选参数 `projectId`、`noProject`。旧 server 剥字段，行为同前。
- 注入变体（原文与 `specs/2026-10-projects.md` §4 ③ / ③b 逐字一致，测试钉住）：
  - **team-lead**（`team.lead === true`）：项目说明与决定是团队共享上下文；作为负责人用 `project_note` 记录决定、改变他人工作的分派和交接；成员下一轮或经 `project_context` 读到。
  - **team-member**：项目说明与决定是团队共享上下文，团队任务是你的任务；接后续任务时用 `project_context` 读变化；经负责人用团队工具协调；团队会重复做的发现用 `project_note`（kind finding）记，停下时写交接。
  - 工具名是 `mcp__happy__project_context` / `mcp__happy__project_note`（TASK 里的 project_read / project_log 为笔误）。

### 3.3 入口清单（实现后）

| 场景 | 入口 | 组件 |
|---|---|---|
| 新建团队 | 「所属项目」选择器，默认「新建同名项目「<名>」」，可选已有项目或「不放进项目」 | `TeamStartForm` + `ProjectPicker`（设计系统 `ActionDropdownMenu` 带勾选列，非原生 select；B-714 的 SelectMenu 合入后替换实现，接口不变） |
| 项目页 → 团队 | 概览「团队」段常驻：列出团队、「在此项目中新建团队」（打开新建团队并预选本项目）、「关联已有团队」（菜单） | `ProjectScreen` |
| 项目页 ⋯ 设置 | 关联 / 解除关联团队（任意未归档团队；服务端补目录） | `ProjectSettings` |
| 团队页头 | 「所属项目 · <项目名>」链接到项目页 | `TeamProjectLine` |
| 团队设置 | 「所属项目」选择器：换项目、建同名项目、「不放进项目」（解绑前确认） | `TeamProjectSettings` |
| 老团队 | 概览顶部一行提示「把团队放进项目，让成员共享上下文」+「创建同名项目并关联」+「选择已有项目」 | `TeamProjectNudge` |
| 会话页头 ⋯ | 「移到项目…」/「换项目…」、「从「X」移出」（显式成员） | `ChatHeader` + `MoveToProjectModal` |
| 侧栏会话行菜单 | 「移到项目…」（弹窗可选「无项目（移出项目）」；团队成员提示去团队设置改） | 既有，选择器换成 `ProjectPicker` |
| 新建会话弹窗 | 「项目」选择器 | 既有，换成 `ProjectPicker` |
| 项目页成员行 | 显式成员行尾「从项目移出」；团队成员标「团队成员」 | `ProjectScreen` |
| 侧栏分组 | 团队在所属项目组；未归属区标「未归属项目 · 按目录」 | `Sidebar` |

未做：⌘K 里的项目动作（快速跳转面板不承担编辑动作，保持现状）；侧栏团队行菜单（团队行没有菜单，改项目走团队设置）。

### 3.4 UI-P0-01（新建团队表单，随本条修）

- 只有电脑**和**目录都已确定时才折叠配置区（B-438「未知配置展开选择」）；
- 主按钮禁用时在按钮上方写明原因（「先写目标」/「先选工作目录」），点击原因把焦点送到缺的字段（目录在折叠区里会先展开）；
- 折叠区从受控 `<details open>` + `onToggle` 改成按钮 + `CollapsePanel`，不再和原生 toggle 事件互相打架，同时去掉原生三角。

## 4. 迁移策略

- **无数据库迁移**：`AgentTeam.projectId` 列与索引在 B-644 迁移 `20261021120000_projects` 中已存在（可空、`ON DELETE SET NULL`）。本条只读写已有列，无需回滚 SQL；回滚到旧镜像时旧代码照常忽略该列（B-644 已实测）。
- **不自动批量迁移老团队**（沿用 `specs/2026-10-projects.md` 归属规则 4）：老团队在团队页看到一键关联提示；用户点了才建同名项目（目录 = 团队启动目录，否则负责人目录）。
- 老团队成员会话在关联后的**下一轮**拿到项目上下文（拉取式注入，B-645）；不唤醒空闲成员。
- 回滚：Web 回滚后入口消失、已建立的关联保留（项目页仍显示团队）；CLI 回滚后 `team_create` 不再带项目、负责人收到成员变体。

## 5. 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 server/Web + 旧 CLI（`team_create`） | 团队无项目；团队页显示一键关联提示 |
| 新 server/Web + 旧 wrapper（存量会话） | 关联后成员经 `via: team` 进项目；旧 wrapper 无 `project-v1` → 项目页标「未注入 · 重启会话以启用」 |
| 新 CLI + 旧 server | `project` 字段被剥掉，团队无项目；context 无 `team.lead` → 负责人收到成员变体 |
| 旧 Web + 新 server | 新建团队不带项目（旧 Web 不发）；项目页 ⋯ 仍可挂载 |
| `VH_PROJECTS_ENABLED=false` | 新团队不带项目，绑定接口 404 `projects_disabled` |

发布：server/Web（同一镜像，无迁移）→ CLI（`team_create` 默认带项目、负责人变体）→ 新建或重启的会话生效。

## 6. 验收

- [x] 新建团队默认建同名项目并关联，目录 = 启动目录；可选已有项目 / 不放进项目；重试不重复建项目（pglite 集成测试）。
- [x] 团队可换项目、解绑；老团队一键建同名项目（幂等）；关联时自动补目录（pglite）。
- [x] 负责人 / 成员读到不同变体，负责人的决定成员可见（pglite + CLI 单测）。
- [x] Web：新建团队选择器、项目页团队区、团队设置、会话页头、移到项目弹窗、项目页成员行（单测 + 浏览器截图）。
- [x] 本地真实跑通：建团队 → 项目页见团队 → 负责人 `project_note` 写决定 → 新派成员 `project_context` 读到 → Web 项目页可见（截图 `~/code/github/skills/tmp/vh-team-B-726/`）。
- [x] 旧 CLI / 旧数据兼容（字段可选，§5）。

## 7. 后续项

- 「提议修改说明」：会话追加 `kind=proposal` 记录、项目页一键采纳。需要扩 `PROJECT_LOG_KINDS`（旧 Web 的 enum 会拒绝未知 kind，需先让读取端放宽），本条不做。
- B-714 SelectMenu 合入后，`ProjectPicker` 换用它（调用方不变）。
- 侧栏团队行菜单（换项目 / 解绑）——等团队行有菜单后再加。

## B-755 追加：新建项目必须有目录（选择已有 / 新建工作目录）

Owner 10-22：「创建项目的时候，需要指定目录，或者让用户新建一个工作目录吧。」

**入口与规则**

| 入口 | 目录来源 |
| --- | --- |
| Web「新建项目」（侧栏） | 弹窗必须填：名称 + 电脑 + 目录，另有醒目的选填「项目说明（context）」，存为 instructions v1。目录二选一：**选择已有目录**（路径输入 + 最近/收藏候选 + 文件夹浏览，候选排除团队 worktree）或 **新建工作目录**（默认 `~/projects/<名称 slug>`，可改，可勾「初始化 git 仓库」）。没有目录不能提交。 |
| 新建团队（默认同名项目） | 同名项目目录 = 团队工作目录（必填，预填最近的仓库路径）；工作目录可勾「新建工作目录」，先建好再启动团队。同名项目的 context 默认 = 团队目标（服务端写入 instructions v1，超 8KB 按字符截断）。 |
| CLI `team_create` | 目录 = 创建会话的 cwd（worktree 换成主 checkout）；解析不出来的极少数情况项目暂无目录，项目页提示补上。 |
| 标签/目录分组「转成项目」 | 用这些会话的目录；一个目录都没有时打开新建项目弹窗（名称预填）。 |
| 老项目没有目录 | 项目页顶部提示「这个项目还没有目录」+「添加目录」（打开设置并聚焦路径）。 |

**daemon RPC `fs-mkdir`**（新增，旧字段不动）

- 请求 `{ path: string; gitInit?: boolean }`，`path` 可用 `~`。
- 校验：原始输入任何一段是 `..` → `invalid-path`；展开后必须是绝对路径且**严格位于 daemon 用户 home 之下**（不能就是 home 本身）→ 否则 `outside-home`；最近的已存在祖先 `realpath` 后也必须在 home 之下（挡住指向 home 外的符号链接）→ `outside-home`；目标已存在 → `exists`（Web 提示改为直接选用）；权限不足 → `permission-denied`。不提权、不 sudo，`mkdir -p` 以 daemon 用户身份执行。
- `gitInit: true` 时在新目录里 `git init`；git 失败不回滚目录，返回 `git: false` 由 Web 提示。
- 应答 `{ path, created: true, git: boolean }`。
- 能力位：机器 metadata 新增 `fsMkdirVersion: 1`（daemon 启动时发布）。Web 只在 **机器在线且 `fsMkdirVersion ≥ 1`** 时可选「新建工作目录」，否则该选项禁用并写明原因（离线 / 需要升级 CLI）。

**兼容矩阵**

| Web \ daemon | 旧 daemon（无 fs-mkdir） | 新 daemon |
| --- | --- | --- |
| 旧 Web | 不变 | 不变（不调用新 RPC） |
| 新 Web | 「新建」禁用 + 说明，只能选已有 | 两种都可用 |

服务端 `POST /v1/projects` 不收紧校验（旧客户端的无目录请求仍接受），「必须有目录」由新 Web 表单与团队路径保证；发布顺序：server/Web 与 CLI 互不依赖。
