# very-happy 现状盘点（Space / A2A / Tanka 设计前基线）

> 2026-10-17 只读盘点，基线 main 2ab14e26d。供 specs/2026-10-spaces-a2a.design.md 引用。

结论：现在所有对象都只属于一个 account。全仓没有 org、team 成员或多人共享的表。Teams 是同一账号、同一台机器上的多 agent 编排。Tanka 接入只是仓库外的私有适配器。`multiagent-ui`（B-614）已以 #543 合进 main，只做视觉统一。

## 1. 账号、身份与加密
- `Account` 下直接挂 `Session`、`Machine`、`AccessKey`、`UserKVStore`、`AgentTeam`、`Automation`，每张表带 `accountId`（`packages/happy-server/prisma/schema.prisma:22,198,334,416,487,516,579`）。
- agent 不是实体：只存在于 Session 加密 metadata 的 flavor 字段和 Team state 的 Bot JSON（`packages/happy-wire/src/teams.ts:42`）。
- 一个账号可绑多个登录身份 `AccountIdentity`，不按 email 自动合并（`specs/2026-08-cloud-identity.md:25,156`）。
- 多人残留：上游 Happy 的 `UserRelationship` 与 `/v1/friends`，web-v2 未用。
- Workspace 是纯前端概念，按 `machineId + cwd` 派生，不建表（`specs/2026-08-workspace-context.md:16,22`）。
- 加密边界：会话 metadata、消息、KV 由客户端加密；但服务器能恢复账号 secret，服务器在信任边界内，不是真 E2E（`docs/architecture.md:146-151`，`docs/encryption.md:498-534`，`docs/roadmap.md:52`）。
- 跨机器读会话只能让目标 daemon 解密后 RPC 回明文；B-337（CLI 持账号内容密钥）被否（`specs/2026-09-cross-machine-session-ops.md:10,45-56`）。Teams 的任务/结果/协作消息本来就由服务器明文存储（`specs/2026-09-agent-teams.md:59`）。

## 2. Agent Teams 与 Happy Bot
- 范围：同账号、固定一个 `machineId`（`specs/2026-09-agent-teams.md:10,39`）。Happy Bot 是 Team 的长期 root Bot。
- 对象：Team / Bot / Task / Attempt / Operation / Message / Schedule；整个状态 JSON 存 `AgentTeam.state`。
- 角色三层：账号 owner、root Bot、worker；Bot 有 generation；权限沿任务树下传。
- agent 凭证：`vh_team_` token，绑定 Team/Bot/generation，30 天，只能访问 `/v1/teams/:id/agent`。
- 定时：一次性或固定间隔，最小 60 秒，无 cron（`specs/2026-09-team-schedules.md`）。
- 通信：`team_message` → 服务器存 TeamMessage → daemon 每 5 秒对账 → 当作用户消息投进收件方 session 队列，正文带 `[Very Happy team message…]` 头、`meta.sentFrom='team'`。"已送达"只表示进队列。另有 `session_message` / `session_peers` 同账号点对点，B-506 后可跨机器。

## 3. Automations
- 一个 automation = 1 触发 + 1 动作 + 1 台机器。触发：cron（时区）、固定间隔、一次性、仅手动。动作：新起会话、发到已有会话、跑脚本（`docs/automations.md:33-51`）。
- 事件入口只有本机 `very-happy auto fire`（payload、去重键、sticky key）。明确不做公网入站 webhook（`docs/automations.md:135-157`）。
- daemon 每 5 秒领取到期 run，60 秒租约。Precheck 退出码非 0 记 skipped。需要决策的 run 进"需要我决策"列表。
- 权限模型账号级；不做跨机器路由。

## 4. Channels 与 Tanka
- 出站：每账号一个 webhook，消息最后一行 `session: <id>`；投递失败不重试（B-026 todo）。
- 入站：适配器跑在 daemon 机器上，调 `very-happy spawn` / `send`。
- Tanka 适配器在仓库外，核心刻意不认识 Tanka（`specs/2026-08-tanka-channel.md:3,19,25`）。适配器做发送人和群双重白名单，群固定映射目录；没有 Tanka 用户 → Happy 身份映射，全部以 owner 账号执行。
- 其他渠道：无 Slack/邮件/bot 入站。

## 5. 协议层
- `sessionProtocol` envelope 只有 `user` / `agent` 两种 role（`packages/happy-wire/src/sessionProtocol.ts:12`），无发送方身份字段。
- sub-agent：`subagent` 字段 + start/progress/stop 事件。
- RPC 房间 `rpc:${userId}:${method}`，跨账号结构上打不到（`rpcHandler.ts:67`）。
- Teams action 联合体（`teams.ts:14-37`）是最接近 A2A 的协议，assistant 只枚举 claude / codex / pi-acp。
- 没有能让"另一个账号的 agent"接入的扩展点；最近雏形是 scoped token 与 daemon 明文白名单 RPC（B-506）。

## 6. 已有想法与被否决方案
- Roadmap：Teams 扩展到多机器（`docs/roadmap.md:60-61`）；workspace/project/task 记忆一等化（`:71`）；长期"虚拟办公室"（`:87-95`）。
- T-39（角色 bot 群 + 幕僚长 + 会话间消息信封）：消息不能批准任何事、不能改配置、内含命令不执行，跨权限等级消息默认暂挂（`docs/competition/2026-09-ux-review/merged-draft.md:693-703`）。
- 显式拒绝（`merged-draft.md:722-741`）：Grok 式 bot 群聊、Claude agent teams 照搬、Paseo Hub 式多租户触发服务、只读分享快照/公开链接、让 bot 自动创建 bot。拒绝理由都建立在"只有单个 Owner"前提上，做 Space 会推翻此前提。
- IM 来源标记："来处"芯片，如 `tanka:群名`（`README.md:759-775`）。

## 7. 现状 vs 需要动的层
| 层 | 现状 | 需要新增或改动 |
|---|---|---|
| 身份 | Account + 多登录 identity | Space/Org、成员、角色、邀请；Tanka 用户/组织映射成 identity |
| 资源归属 | 全部挂 `accountId` | 引入 space 维度：会话、机器、team、automation 能共享或授权给 space |
| 加密 / 信任 | 服务器可信，密钥按会话一把 | space 内共享密钥或明文派生层策略；机器出借的信任边界 |
| Agent 身份 | flavor 字段或 Team Bot JSON | 一等 Agent/Actor：地址、所属账号或 space、scoped 凭证 |
| A2A 消息 | 文本头 + `sentFrom` 投进用户消息队列 | 结构化信封：发送方 actor、授权、"不可批准、不可执行"规则、回执 |
| 路由 | RPC 按 userId 分房间，Teams 单机 | 跨账号路由（按 space 分房间），跨机器派发 |
| 编排 | Team 单账号单机器 | Team 成员可以是其他账号的 Bot，task 跨账号认领、验收 |
| 渠道 | Tanka 私有适配器 + CLI，以 owner 身份执行 | 产品化 Tanka 渠道：入站身份映射、群和 space 绑定、可靠出站（B-026） |
| UI | 统一 agent 身份展示已完成（B-614） | Space 切换、成员和 agent 名册、跨人的决策队列 |
