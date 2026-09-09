# 可选团队的首次使用与统一导航

> 状态：Shipped（首次发布：`abb5484f61cd029b9f6c7db2729922a4bef0374e`，CLI `0.2.127`）
> 日期：2026-09-09 ｜ 关联 backlog：B-420 ｜ 前身：[Agent Teams](2026-09-agent-teams.md)、[团队工作区](2026-09-happy-bot-workspace.md)

## 背景

团队页面仍要求用户理解 Link lead、Worker、session ID 和安装路径。用户确认团队应像一种最近工作：打开团队看进展，打开成员看会话；同时不使用团队的人保持原有普通聊天和终端体验。本批将创建、连接、展示连成完整产品路径。

## 目标

- 普通会话无需安装 skill、创建团队或阅读引导即可照常使用。
- 主历史列表同时容纳普通会话和团队；仅属于当前可见团队的成员会话收进团队，不重复展示。
- 创建团队填写目标、项目及运行机器，采用可用的 agent，自动启动已连接的负责人。
- 默认展示目标、分工、执行状态、提交结果；ID、协议字段进入调试详情。
- App 内自动提供官方协作说明及工具；终端外部接入仍有明确的一次配置指南。

## 非目标

- 不创建第二套调度器、账本或常驻 meta-agent 进程。
- 不通过聊天文本推断完成/验收状态。
- 不自动转换任何普通会话、不更改用户全局 agent 权限、不把隐藏入口解释为停止任务。
- 不在缺少真实 runner 支持时提供装饰性的模型或并发设置。

## 改造前事实（设计基线）

| 事实 | 位置 |
|---|---|
| 创建请求只有 name/machineId/requestId；返回空团队 | `packages/happy-wire/src/teams.ts:31`；`packages/happy-server/sources/app/teams/store.ts:76` |
| create 使用 account + requestId 推导 teamId；重试目前只比较 name/machineId | `packages/happy-server/sources/app/teams/store.ts:80` |
| join 是 owner 操作并签发 scoped credential；Web 绑定不等于进程拿到凭据 | `packages/happy-server/sources/app/teams/reducer.ts:85`；`packages/happy-cli/src/teams/client.ts:18` |
| delegate 创建任务、attempt、managed bot 和持久 spawn operation | `packages/happy-server/sources/app/teams/reducer.ts:112` |
| spawn 始终创建 worktree，写私有 scope 文件，通过环境传递 operation ID；消息初始 localId 固定 | `packages/happy-cli/src/daemon/teams/worker.ts:63` |
| local receipt 在 OS spawn 之前写 spawning；不确定结果不能重新 spawn | `packages/happy-cli/src/daemon/teams/worker.ts:81` |
| 目前官方 TEAM_SKILL 只被安装器使用；worker 初始发送 op.prompt，没有自动注入 | `packages/happy-cli/src/teams/resources.ts:2`；`packages/happy-cli/src/teams/install.ts:4`；`packages/happy-cli/src/daemon/teams/worker.ts:116` |
| managed bot 任务结束会触发停止/清理，不区分 root | `packages/happy-server/sources/app/teams/reducer.ts:49` |
| wire 的成员可选 agent 类型已有，模型和并发配置尚不存在 | `packages/happy-wire/src/teams.ts:16`、`:33`、`:40` |
| daemon 发布 teamsVersion=1；需区别 online 与实际能力 | `packages/happy-cli/src/daemon/run.ts:87`、`:1842` |

## 设计

### 普通工作与团队并存

普通“新建会话”、终端、历史搜索和快捷键保持现有行为。新建团队是独立动作，团队引导仅在主动使用时出现。默认不折叠普通历史为一个新的根目录。

侧栏 team item 的名称打开团队工作区，独立展开控件显示成员；成员 item 直接打开原有 session 路由。当前团队成员应自动展开，使上下文可见。桌面保留侧栏，手机会话标题显示返回团队入口。深度委派在任务详情表现父子关系，侧栏不无限递归。

分组依据服务器 TeamState.bots[].sessionId 或已完成 spawn operation.sessionId 精确关联；已归档或不可访问的团队不使其会话消失。团队列表读取失败时回退原始会话列表，不能将缓存的 membership 当作永久过滤条件。同一 session 异常关联多个团队时采用稳定归属且可到原会话，不能重复或丢失。团队排序采用可核验活动时间，普通会话相对排序不变。

隐藏 Happy Bot 入口只改变导航偏好，不暂停/删除团队。偏好缺省沿用原有默认；若使用 synced settings，新增字段保持 optional，禁止 zod default。未使用团队的账号不能因为 teams API 404/禁用而出现错误横幅或阻塞普通操作。

### 原子创建与启动

建议复用现有 endpoint，增加可选 launch 字段，旧调用继续创建空团队：

```ts
POST /v1/teams
{
  name, machineId, requestId,
  launch?: {
    goal: string,
    directory: string,
    assistant: 'claude' | 'codex' | 'pi-acp',
    model?: string
  }
}
```

一次服务器事务创建团队、root managed bot、代表用户目标的初始任务/attempt、现有 type=spawn operation。不用 Web 串联 create→spawn→join；响应仍是 `{team}`，UI 根据持久 operation 和绑定状态显示“正在启动负责人”、失败原因或“打开负责人”。负责人初始任务 ownerBotId=null，因此由用户验收；负责人分派的子任务由负责人验收，不能自行验收自己的初始目标。

launch 使用新的可选字段，持久保存规范化输入摘要（或等价不可变原始字段）以检验 requestId。相同 key 同参数返回当前团队；相同 key 改目标、目录、agent 也必须冲突，不能静默复用。相同 key 的并发创建由事务重试处理唯一冲突，不能生成两个团队。不得把含可变运行态的整个 state 当创建摘要。

UI 在未知失败后保留 requestId 和表单数据，刷新后可发现已创建团队。不能用新的 key 自动重试。取消/归档只调用已有状态机；“关闭创建对话框”不代表撤销已提交创建。

worker 沿用 claim、receipt、scope file、exact operation correlation 和稳定初始消息 localId。自动把 bundled TEAM_SKILL 的说明与目标组合发送给托管会话；内容来自版本化官方常量，token 永不进入 prompt。若引用文件，必须在实际 host 创建后验证可读；不能让 App 用户手动装共享 skill 才能成功启动。

### 负责人生命周期

负责人执行一个团队目标，生命周期随目标：使用隔离 worktree，负责整合子结果并提交，等待用户验收，验收/取消后经现有停止与安全回收机制关闭。后续新目标另开团队。UI 明确“目标已完成”，不承诺这一负责人接受无限后续工作。不通过把负责人改为非 managed 绕过回收；结束前处理活动计划。

既有空团队使用 owner action `{type:'start', launch: TeamLaunchSchema}`，调用与 create 相同的纯启动 transition，一次创建 root/目标 task/operation；已有启动记录不得再创建第二负责人。create 的 launch 原始快照保存为 `TeamState.creationLaunch?`，后续 defaults 修改不影响创建幂等检查。

### 从已有会话组队

Web 调用支持 `teams-adopt-v1` 的 session-local `teams-adopt` RPC，返回 pending 后轮询同一 requestId。wrapper 复用 createTeamsClient.initialize 完成 create/join，并将凭据写入实际使用的私有 scope；再由后台任务通过普通 sendUserMessage 下发官方说明，使用固定 localId。只有 scope 与说明投递落账后才返回 connected；不依赖模型自行调用创建工具，也不由 Web 二次投递说明。

RPC 检查当前 scope、session 所属机器和私有 scope 路径；托管成员不得通过此入口提升为 root。持久 receipt 允许重启后恢复 create/join/scope/说明投递的中间态。能力来自 session wrapper，不按机器 CLI 版本推断。

创建和接入表单按服务地址、账号及入口隔离保存待定请求，关闭或刷新仍重试同一 requestId、同一输入。保存失败不发送；不确定结果保留输入并锁定，明确未执行的错误才允许修改。账号切换及卸载后返回的响应不能跳转当前页面。关闭窗口不取消后台工作。

### 配置与外部 skill

本批成员默认值存于 `TeamState.defaults?: {assistant?,model?,maxParallel?}`，owner action `set-defaults` 更新。名称/职责、项目、agent 与模型可以在分派时覆盖；缺省继承团队值。模型经 Bot/Operation 的可选 model 透传到实际 spawn 和 runner；只能显示当前runner实际可选择且支持的模型。已有运行成员不热改模型，UI 说明新分派生效。

maxParallel 由 server claim-operation 限制同时推进的非 root 叶子任务，不统计 OS 进程数。已领取/不确定启动占位；父任务有未完成子任务时让出执行位，完成或取消的任务不因保留待整合 worktree 而占位。root 不占配额，纯 pending 操作不计。官方说明要求委派后等待子结果，避免父子继续并行编辑；这不是 CPU/进程数硬隔离。

配额不足时不写入永久拒绝的幂等响应。降低配额不停止当前任务，只延迟后续领取。多层委派在配额 1 下仍可逐层推进；实际工作目录由完成 spawn 回报写入 bot，operation 原始目录保留供资源回收，快速委派缺省使用 wrapper 的实际 cwd。

新增 `teamLaunchVersion:1` 能力位，保留 `teamsVersion:1`。launch/model/default约束使用前检查真实运行daemon能力；新CLI在团队初始prompt注入TEAM_SKILL及root角色，普通session不变。server对操作领取继续门控，旧daemon不能绕过Web直接执行新语义。

终端指南按 Claude Code/Codex/pi 显示 `very-happy teams install --host <host> --apply`，说明 skill 提供协作方法，Very Happy 托管会话提供工具连接；安装完成后让 agent 读取命令返回的 skill 路径并在托管会话开始。裸 pi 只安装 skill 不等于工具可用，不能承诺自动发现。App 内创建不依赖该指南。

### 专用展示

成员一律用用户可理解的名字和“负责人/成员”；后台字段保留兼容。分工卡展示目标、负责人、agent、当前状态，操作跳转真实任务/会话；进展显示 running/submitted/done 的区别；结果显示当前 attempt 的 result、验收状态和可点击产物。链接按既有安全渲染策略处理。

没有结构化证据时只展示现有真实摘要，不从消息文本猜改动数、测试通过或百分比。旧消息继续正常渲染；协议原文可置于调试详情。空团队提供“启动负责人”的明确下一步而非 Link lead/裸 ID 表单。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 旧 Web/CLI → 新 server | 缺 launch，维持原空团队创建与 team_create/join |
| 新 Web → 旧 server | 必须能力检查/检测 launch 未执行并显示暂不可用；不能把空团队当启动成功 |
| 新 server → 旧 daemon v1 | 继续执行原任务；launch/model操作因缺 teamLaunchVersion:1 不创建或不下发，不承诺已注入skill |
| 新 daemon → 旧 server | 保持原操作协议；新增可选能力字段被忽略 |
| 旧 Web 读取新 team | root/task/operation 都是既有结构，未知可选字段忽略；仍能查看和操作 |

本批采用 teamLaunchVersion:1，并在 server operations 列表/claim 端防止旧 daemon 执行 launch/model；单靠 Web 按钮禁用不够。

顺序：wire 构建→完整 server/Web 镜像→CLI 固定版本发布与平台矩阵→daemon 更新和 RPC 能力复核→真实创建验收。新 Web 在 daemon 更新前显示准备状态，不静默退回空团队。回滚 server/Web 到前一不可变镜像；新字段必须能被旧代码忽略，已创建操作必须维持原状态可恢复。CLI 回滚前暂停所有新执行语义操作，不能让旧 worker 接管未知语义。

## 风险

1. 负责人资源/回收语义混淆会误删用户目录或留下进程：本批沿用现有隔离资源与accept后的回收，增加机制测试和能力门禁。
2. 创建超时产生“看似失败、实际启动”：稳定 requestId、事务创建、同参数重读，不重造 ID。
3. 隐藏成员导致历史丢失：仅在团队读取成功且可见时分组，失败回退普通列表；归档后会话仍可到达。
4. 暗示 idle=完成、delivered=模型已处理：状态必须对应服务端任务/attempt，无上述推断。
5. 混合旧端忽略新字段：涉及副作用约束的字段必须有消费能力门禁，不能依靠 JSON 可解析性。

## 验收标准

- [ ] 无团队账号：新建普通会话、历史、搜索、终端、快捷键行为不变；不出现安装阻断。
- [ ] 创建一次直接获得可工作的负责人；agent 能 team_inspect 并发起两个独立子任务，无手动安装/填 ID。
- [ ] 相同 requestId 重试/并发只创建一个 team/root/task/op；不同 launch 参数冲突。
- [ ] spawn 前失败、spawn 后响应丢失、初始消息发送后 daemon 重启均不重复启动或重复下发初始目标。
- [ ] 凭据只落私有 scope，UI/prompt/log 不包含 token；普通会话不获得 team scope。
- [ ] 旧 API 请求、旧团队、新旧 daemon 兼容路径通过；不可支持语义不静默执行。
- [ ] 成员配置 UI 与实际 runner/约束一致；root 的目标完成与资源回收按定稿语义验收，成员并发上限在重试/取消/降低限额时仍有效。
- [ ] 团队和普通会话混排、成员跳转、当前成员展开、归档/接口失败回退可用。
- [ ] 390px coarse 与桌面、明暗主题：真实浏览器交互、焦点、溢出、任务/结果卡截图和 css-probe 验证。
- [ ] wire/server/CLI/Web 必需门禁全绿；发布实际 entry/SHA/health 及新创建路径验证。

## 留真机验证项

当前无预先豁免项；浏览器可验证的布局与操作当批完成。发现只能在真机重现的触屏或 IME 问题时，明确原因后登记 verify queue。

## 实现定稿补充

- Machine.metadata 是 opaque 数据，server 不读取它判能力。Web 用解密后的 teamLaunchVersion:1 预检；新 operation 冻结 teamLaunchVersion:1，daemon poll/claim 显式声明 teamLaunchVersion:1，server 对旧 poll 隐藏新 operation 并在 claim 复核。
- model 冻结在 operation，通过首条消息 meta.model 进入各 runner 的既有模型选择路径，不虚构 pi spawn 参数。
- 主 agent 2026-09-09 定稿，按上述接口实施；普通会话仅在用户主动组队时通过 session-local RPC 建立 scope。

## 本地验收记录（2026-09-09）

- 新建、目录选择、503 后关闭再重试、已有会话接入失败后重开、历史结果卡均经真实 Chromium 在 390px coarse / 1280px、明暗主题验证。账号隔离与不确定请求保留有机制测试。
- 导航保留普通列表排序与入口；已回收成员通过持久 spawn receipt 打开历史，不触发重启；隐藏 Happy Bot 仅隐藏入口。CSS probe 窄屏无横向溢出。
- 隔离 PGlite server、独立 HAPPY_HOME、临时 git repo 实跑：pi 负责人自动委派 Codex；子任务提交、负责人验收、根目标提交；停止及 worktree 回收完成，无手工安装 skill。该探针明确选择了 bypass 权限，不代表默认权限自动免审批。
- 生产 server/Web `abb5484f61cd029b9f6c7db2729922a4bef0374e` 已发布（run `34319208007`），完整镜像 digest `sha256:3a412413851be3966b0cc65f05a998acf214883d26fa2bc6c60c1cc7e62d8efb`。真实页面普通 reload 后 entry 已切换、新 controllerchange 已记录、无横向溢出。
- CLI `0.2.127` 六组 smoke 全成功（`34319673194`）后 promote（`34319673066`）；两台 Mac 实际 daemon 版本均已核对，办公 Mac launchd running，两机真实 `fs-list` RPC 与 `teamLaunchVersion:1` 通过。推荐版本允许 registry 缓存；未修改全局自动升级目标。
- 生产临时团队已由 pi 提交只读目标，经验收达到 done、cleanup done，再归档。期间仅批准了该探针已经挂起的 `team_submit` 请求，不能把验收说成默认免审批。
- 临时证据位于 skills/tmp/teams-first-use；探针团队与 worktree 已回收，未修改现有业务团队。

## B-421：启动关联恢复补丁

生产验收确认 Codex/ACP 调用方虽把 teamOperationId 传入 createSessionMetadata，factory 未声明或拷贝该字段，对象 spread 又避开了多余属性检查。正常启动能完成，但 daemon 在 spawning receipt 中断恢复时无法凭会话 metadata 找到原操作。

补丁将可选关联字段显式透传；普通会话不增加字段，不改变协议或权限。回归将各 flavor 的 factory 结果真实写入独立 sessions.json，再读回并按操作 ID 唯一匹配。该补丁计划随 CLI 0.2.128 发布，新 wrapper 才携带字段；旧会话不能被宣称已经补齐。旧 receipt 的不确定结果仍遵守保守恢复原则，不能通过无证据重新 spawn 补救。
