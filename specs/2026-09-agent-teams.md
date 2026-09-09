# Very Happy Agent Teams / Happy Bot

> 状态：Final（2026-09-09 Owner 已授权实现；尚未发布）
> 关联 backlog：B-398；基线：very-happy a1ff928e1，旧实践 vh-supervisor 96c5406

## 定位与范围

Agent Teams 是 Very Happy 官方能力。用户在已接入的 coding agent 中提出目标，agent 可以自己执行，也可以组织队员、继续委派、讨论和验收。Happy Bot 是面向用户的长期队友名称，meta 是 Bot 的协作角色，不是另一种专用执行器。共享 skill 说明工作方法；权限和执行能力来自实际工具与 wrapper，不由读取文档产生。

首批实现同账号、同机器的 Claude / Codex / pi-acp 托管路径。允许多个负责人、任务树及负责人继续委派；不建设通用插件市场或工作流 DSL。现有模型认证、会话权限、单写者锁继续生效，默认 worker permissionMode 为 default。直接运行宿主 CLI 的终端必须先具有 Very Happy 托管 session；安装 skill 本身不会把任意终端变成可唤醒的后台服务。

## 核心与依据

```text
用户 / Coding agent
  ├─ Web Teams
  └─ 共享 skill → team_* MCP / very-happy teams
          ↓ 同一业务协议
server：Team / Bot / Task / Attempt + request / operation / message / schedule
  └─ daemon 每 5 秒对账
       ├─ 操作回执 → 私有 worktree → wrapper → 初始消息 → 完成回执
       ├─ 持久协作消息 → 现有 session 消息队列
       └─ 会话 idle / blocked / exited → 状态记录和直接负责人通知
```

- `packages/happy-server/sources/app/teams/reducer.ts`：状态机、任务树、权限和版本校验。
- `packages/happy-server/sources/app/teams/store.ts`：Serializable 事务/CAS、opaque credential、幂等请求、分表持久消息/操作。
- `packages/happy-wire/src/teams.ts`：共同协议类型和输入 schema。
- `packages/happy-cli/src/daemon/teams/worker.ts`：执行、首次消息和回收的对账。
- `packages/happy-cli/src/teams/`：公共工具、scope、官方 skill、安装器与 pi bridge/gate。
- `packages/happy-web-v2/src/screens/teams/`：基于结构化状态的协作界面。

旧 Task Board 是 account KV 的人工列表与 updatedAt 合并，不具有事务调度语义，继续作为独立人工看板，不接收 Teams 双写。B-383 的全局 operation 协议仍是独立设计；本批实现其“结果未知不能盲重派”的必要子集，未宣称全局协议已经完成。

## 数据与状态契约

| 对象 | 语义 |
|---|---|
| Team | 同一账号、固定 machineId 的协作范围；version 是事务状态版本 |
| Bot | 稳定 id、当前 sessionId、generation、是否 root、是否由 Teams 创建；lastEvent 单独表示运行观察 |
| Task | 父任务、goal、acceptance、直接负责人 ownerBotId、唯一执行 Bot、goalVersion、currentAttemptId |
| Attempt | 一次执行/提交身份；固定 Bot/generation/goalVersion，保存结果 |
| Operation | spawn/stop 的持久执行要求；claimId 与本机回执一起约束 OS 副作用 |
| Message | 指定任务或定时来源、直接收件 Bot；deliveredAt 仅说明进入 session 消息队列 |
| Schedule | 指定 Bot 的单次/固定周期提醒；到期、离线合并、暂停取消见 [定时 spec](2026-09-team-schedules.md) |

状态：`queued → running → submitted → done`；任何未完成任务可以取消。退回 submitted 时创建新 attempt，上一结果保留；延迟的旧验收不能验收新提交。提交、验收、退回、取消、移交必须携带所见 attemptId/goalVersion，禁止服务端替调用者猜最新值。改目标首批通过取消后新建表达，不提供隐式覆盖 goal 的接口。

负责人验收直接子任务；子任务全部完成不代表父任务完成。父任务提交/移交前不能存在未结束的直接子任务。取消作用于整个未结束子树。同一 Bot 同时只接受一个未结束执行任务，但在执行该任务时可以委派后代。权限跟随任务树，队员不能通过指定其他 Bot id 扩大范围。

Bot 换 session 时递增 generation，旧 token 撤销、旧 attempt 失效；旧 session active 时拒绝改绑。同绑定重复 join 不递增代际。server 的 Session 没有可直接验证的明文 machineId，本机归属由托管 CLI 的已持久 session 记录及本机 settings 校验；Web 手工关联的跨机运行不在首批能力内。inactive 是服务端状态证明，不能取代资源执行器对旧进程退出的核验。

## 权限和存储

普通用户 API 使用账号认证，每个 Team、machine、session 检查账号归属。Agent 使用独立随机 `vh_team_…` token，只被 `/v1/teams/:id/agent` 接受，不能用于通用账号 API。凭据绑定 Team/Bot/generation，有效期 30 天，代际切换撤销；到期需重新接入，首批不做静默续期。

凭据验证使用 hash；为恢复相同 claim 而保留的 token 使用服务端主密钥加密。公开 GET/模型工具响应不含 token；本机 scope 为 0600 文件，通过 `VH_TEAM_SCOPE_FILE` 传路径。scope 缺失或校验失败不得回退账号权限。

任务目标、结果摘要、协作消息是服务端可信存储；原 session transcript 保持现有加密传输/存储形式。Team token 限制业务 API，不是 OS 沙箱：同一登录用户下的宿主 shell 仍有该用户文件权限，不应对互不信任租户宣称隔离。

## 可靠执行与恢复

- Team 变更、request 去重记录、操作及消息同事务提交。requestId + actor + payload 冲突被拒；相同请求可读取当前结果，不返回陈旧状态快照。
- daemon 串行执行短时启动/回收 IO；模型进程并行工作，不占对账循环槽位。默认 5 秒对账，未开启服务端功能时退避。
- 本机回执阶段为 prepared / spawning / spawned / delivered / completed；在调用 spawn **之前**持久化 spawning。恢复时以 metadata.teamOperationId 唯一匹配已有 session，找不到不意味着可以再起一次。
- 首条 prompt 发送使用稳定 localId。启动成功但发送失败重试发送；已发送仅完成 ACK 失败时重试完成操作。消息 localId 同时带 Bot generation，使用现有 session outbox 去重。
- unknown/本机回执缺失不会自动重派。用户先取消/移交任务，核验旧执行已停和成果已保留，再用 owner-only reconcile-operation 记录 claimId、说明与时间；此动作不执行 OS 操作，普通 agent 无权调用。之后可以接管或创建新委派；首批不提供“忽略未知状态强制再开”的按钮。
- 用户取消与 OS 启动不能组成跨系统原子事务。晚到的启动结果要对账并生成停止操作；不能宣称取消后绝不会短暂启动进程。
- idle/blocked/exited 只是活动观察；不会把 Task 变成 done。deliveredAt 不代表模型读过或完成了消息；重复语义仍需 agent 先读权威状态。

资源只能回收 Teams 自建 worktree/session。先请求停进程并确认退出，再 archive session。worktree 有未提交改动、分支未合并到源 checkout 时保留，cleanup 独立显示失败并可重试；不会因验收成功强删成果。用户关联的既有 Bot/session 不自动销毁。

界限：单 Team 最多 32 Bot、200 Task、2000 Message、1000 Operation、8 层任务树、2 MB 状态。这是首批可审计的硬上限，不是无限运行承诺；到限返回明确错误。账号最多 32 个未归档 Team；收尾后归档保留历史并释放团队名额。没有额外模型调度槽，因此等待子任务的 meta 不会占满另一套调度器；跨团队机器资源预算和无限历史分页仍是后续工作。

## API 与兼容

- `GET/POST /v1/teams`：用户列举/创建。
- `GET /v1/teams/:id`、`POST /v1/teams/:id/actions`：用户读取/操作。
- `GET/POST /v1/teams/:id/agent`：独立 scope 下读取/操作。
- `GET /v1/teams/operations?machineId=…`：daemon 对账。
- 公共工具：create / join / inspect / delegate / message / submit / accept / return / cancel / handoff，以及 schedule_create / schedule_pause / schedule_resume / schedule_cancel。

默认关闭：`VH_AGENT_TEAMS_ENABLED=true` 开启；可选 `VH_AGENT_TEAMS_ACCOUNT_IDS` 逗号分隔账号白名单。新 daemon 通过 machine metadata `teamsVersion:1` 声明执行协议能力；宿主可执行性继续使用 cliAvailability。声明工具/二进制可用不等于已经验证模型认证。

| 组合 | 行为 |
|---|---|
| 新 server + 旧客户端 | additive 表和可选字段；普通会话不变 |
| 新 Web + 旧 daemon | 未报告 Teams 执行能力，禁止派发，不回退 Claude |
| 新 CLI + 旧/关闭 Teams server | Teams 返回不可用并退避；普通会话继续 |
| 全新且已启用 | 按机器/宿主能力提供工具、执行和 Web 操作 |

发布顺序：additive migration + 完整 server/Web 镜像（gate 关闭）→ CLI → 核验 → 账号开启。回滚前停止新委派、核对运行操作和资源，不能只关 UI 把进程遗留；旧表不立即删。Owner 已授权按完整切换方案合并、发布和双 Mac 迁移；实际状态仍以生产与机器验收记录为准。

## 老架构处理

删除 Web 对 vh-tick 文本、decision JSON、vh-ledger Bash 的专用解析和卡片，以及无调用角色识别代码。旧历史消息仍按普通 Markdown/工具调用可读。pi 结构化工具展示与通用会话工具保留；官方 pi bridge/gate 移入 CLI，不依赖私有 supervisor 路径、模型配置或默认 yolo。

旧 supervisor 的生产调度和私有 ledger 不在此代码仓直接删除。`very-happy teams migration-preview --file <ledger.json>` 只做离线盘点：已结束留档，有 session 的必须先核验，不会重派；未启动任务提供待确认映射，旧 review 不导成 done。切换顺序是冻结旧派发、备份 ledger、核验存量进程/成果、逐项接入新系统，禁止新旧调度并写。自动导入旧活动状态暂不提供，避免凭 legacy status 制造虚假的新 attempt；历史原件是审计来源。

## 开发和验收状态

已实现：事务状态/权限、attempt fencing、scope 工具、递归委派、daemon 回执恢复、自建 worktree、消息投递、官方共享 skill、pi bridge/gate、结构化 Web 团队页、旧卡片清理。官方 skill 物化在 `~/.local/share/very-happy/skills/very-happy-teams`，不写任何宿主共享技能目录；全局 personal root 可指向此文件，读取本身不建立连接。验证明细由本轮开发报告记录，不以编译通过代替真实 runner 测试。

发布前必须：四包门禁、两主题/窄屏浏览器、跨账号/旧代际/丢 ACK/未合并成果回归、至少两个 runner 的真实协作验收。普通 transport probe 只证明工具链，不证明模型完成任务。

后续独立批次：跨机自动恢复、模型/进程资源预算、自动归档分页、自动消费 ACK、个人连续多批试用。个人试用通过后再对外宣称长期无人值守能力；首批不把这些未验能力包装成已完成。


## 本批实测（2026-09-09）

隔离 PGlite、全新本地账号、独立 HAPPY_HOME、临时 Git 仓库启动真实 server/daemon。Claude 与 Codex 两个 worker 均完成文件修改、commit、scoped team_submit；核对内容并合并源仓库后 owner accept。最终两任务 done/cleanup=done、四个操作 completed，数据库确认两个 session inactive 且已归档；worktree list 仅剩源仓库。权限请求逐项批准，没有改全局 permission mode。测试 server/daemon 均已关闭。

真实模型另验证 Claude HTTP 与 Codex stdio 调用 Teams 工具；pi 另在相同隔离条件下完成真实文件 commit、官方权限卡逐项批准、team_submit、合并验收与回收，最终 spawn/stop completed、task done/cleanup done；使用固定 pi-acp 0.0.33 和宿主原生模型认证，未加载私有 wrapper。Windows launcher 未做真机验收。另完成真实二层 pi 父级→Claude 子级委派、双向消息、子级提交/父级合并验收、父级提交/最终集成验收；两层全部 done/cleanup done。子级因尚未合入最终源仓库而暂时保留的资源，在最终合并后自动重试回收成功。任务树、旧代际、取消/消息 ACK 竞态和崩溃恢复另有机制测试；父级断线重接的完整模型路径仍需个人试用验收。

Web Chromium 使用真实组件和 fixture API 验证创建、委派、结果、验收、人工对账、归档；390px、两主题、coarse pointer 均无横向溢出或页面错误，按钮至少 48px。fixture UI 验证与上述真实执行链分别记录，不混作同一个全浏览器端到端用例。


## 首次生产切换（2026-09-09）

PR #285 合入官方能力，PR #288 修复 Prisma 迁移通过 transaction pool 遗留 advisory lock 的问题。完整 Server/Web 镜像部署到 `70eb18e9f5cb84f3a7b767a3bf96efb3569f7be7`，digest `sha256:0965b44d6406d14b4b6e653b3f5ec588abda86512ab010fbd90ccc8497dcdfe2`；发布运行 34275680799 attempt 2 成功，attempt 1 在拉取镜像时网络超时、未切流量。CLI `0.2.125` 的发布与六个平台/Node 组合 smoke 全绿，latest/next 已更新。功能通过账号 allowlist 启用，未全量开启。

迁移连接使用同一物理数据库的独立 session pool，业务连接保留 transaction pool。两次真实 Prisma migrate 均成功且未遗留 advisory lock。备份、切换前版本和完整镜像保留；回滚必须先处理 Teams 存量任务，不执行破坏性 down migration。迁移恢复机制以 PostgreSQL migration spec 和 operations 为准。

两台 Mac daemon 均已核验运行 `0.2.125`、Teams capability 和 daemon 上下文认证；不能拿遗留 machine metadata 版本代替实际 daemon 版本。官方 skill 安装到外部独立目录，办公室的旧调度器、两个私有 pi 扩展及旧启动覆盖停用，原生模型偏好、其他插件、历史账本与备份保留。个人 skills 已同步兼容版本，未复制认证或 machineId。

真实生产验收：主机 pi、Claude、Codex 和办公室 pi 均在隔离 Git 仓库完成文件修改、commit、submit、验证后合并、accept，最终 task done / cleanup done；测试团队已归档。临时滴答任务通过官方适配器派发，真实 worker 提交后由唯一集成者合并验收，再回写并确认 provider status=2；两条历史待验收/未排期待办保持原样。普通权限请求逐项批准，不等同于已支持无需审批的无人值守。

办公室官方 Happy Bot 会话已建立，10 分钟状态对账与 30 分钟滴答消化 schedules 首次触发并送达。送达 ACK 与模型完成分开验证。生产浏览器加载上述精确 SHA 的 entry，窄屏无溢出/页面错误；旧→新 SW 接管另以两个实际生产构建验证。

2026-09-09 Owner 明确取消 48 小时等待并要求立即退役。旧个人 scheduler、pi 私有扩展和 `/supervise` 已停用，个人 skills 的旧生产路由与滴答账本桥删除；官方 Teams 与唯一 mac-office 滴答适配继续运行。观察自动化已删除；历史原件保留为恢复备份。此次为 Owner 选择直接切换，不等于通过 48 小时稳定性验收。

免审批后续 PR #293 / #294 已上线：Server/Web `5106e8e9`、CLI `0.2.126`，两台 Mac 已安装；Happy Bot root 和团队偏好均为 `bypassPermissions`。新 worker 沿用团队偏好，消息摘要可展开。生产 pi/Claude 与办公室 pi 自动验收通过；Codex 在隔离源仓 main 提交而非分配分支，人工核验实际文件、单文件提交和干净工作区后验收，三种 agent 均完成回收。办公室 launchd 接管退出已恢复，并由新任务实际执行验证。跨机自动接管、工作树强隔离、Windows 真机与长期无人值守不包含在本次已验收范围。
