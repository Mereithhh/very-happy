# 团队会话重拉不丢作用域；一个会话只属于一个活团队

> 状态：Final（实现 B-730）
> 日期：2026-10-22 ｜ 关联 backlog：B-730（展示侧兜底是 B-729）

## 背景（负责人重拉丢作用域事故）

一个团队的托管负责人（pi 会话）。10-21 22:19 收到 restart-session，daemon 用服务端 metadata `pi --resume` 重拉 wrapper，
但 env 里**没有** `VH_TEAM_SCOPE_FILE` / `VH_TEAM_OPERATION_ID`（`teams/scopes/<op>.json` 还在）。00:24 `team_delegate` 返回
「Join or create a team first」，模型于是 `team_create` 另建了一个团队并以 root join。两处缺口：

1. 团队作用域只活在**首次 spawn 的 env**（`daemon/teams/worker.ts`），`resumeSessionImpl` / `restartSessionImpl` 重建 env 时不带。
2. CLI 只在 env 有 scope 时拦「已分配成员 create/join」（`teams/adopt.ts`）；服务端 join 只查同团队 `session_already_bound`。

## 1. 重拉带回作用域（CLI daemon）

- 所有重拉都经 `resumeSessionImpl`（RPC resume、`/resume`、自动化唤醒 `wakeHibernated`、休眠恢复）或 `restartSessionImpl`（restart-session）。
  两处在 spawn env 末尾展开 `teamRelaunchEnv()`（`daemon/teams/relaunchScope.ts`），与 runner 无关：Claude/Codex/pi wrapper 都在进程内读
  这两个 env（`startHappyServer`、`teams/client.ts`、pi extension 继承 env）。daemon 启动时的「恢复」只认领活进程、不重拉，不涉及。
- operation id 来源：服务端 metadata 的 `teamOperationId`（重连时 `mergeReconnectMetadata` 以服务端为准，所以 env 丢过一次也还在）；
  缺失时退回本机 spawn 收据（`teams/effects/*.json` 里 `sessionId` 匹配、带 `scopeFile` 的最新一条）。
- scope 文件缺失：daemon 用自己的 owner 凭据**重放同一个 claim 请求**（`claim-<op>`，服务端按 requestId 幂等，返回该 bot 当前 generation 的凭据），
  只在「团队未归档、op 属本机、bot 仍绑定本会话且 generation 未变」时写回 0600 文件。重建失败时 env **仍指向**该路径：wrapper 的
  team 工具报「scope is missing; ask the owner to restore it」，`team_create/join` 被 `adopt.ts`/`client.ts` 拒绝——绝不静默变成无团队。
- 同时恢复 `HAPPY_SPAWNED_BY=teams`（与首次 spawn 一致：会话事件上报、休眠豁免）。

## 2. 一个会话至多属于一个活团队（server）

- `POST /v1/teams` 带 `sessionId`（新 CLI）或 `project.inheritFromSessionId`（B-726 起的 CLI 都带）时，若该会话在**另一个未归档团队**
  是任一 bot（负责人或成员）的 `sessionId`，返回 `409 { error: 'session_in_other_team', teamId, teamName, message }`，不建团队。
- owner `join` 同样检查（目标团队之外）；被拒的请求不写 `TeamRequest`，可重试。已归档团队不拦。
- `transfer: true`（join action 与 create body 的新可选字段）= owner 已在 Web 确认：同一事务里对旧团队执行 `transferSessionOut`——
  `releaseBotSession`（进 B-729 的 `previousSessionIds`）、`generation++`（旧 scope 凭据立即 `stale_agent`）、记录
  `bot.transferredTo = { teamId, sessionId, at }`。旧团队里该 bot 的任务不动，由 owner 处理。
- 文案（服务端与 CLI 各自生成同一句，CLI 不回显服务端 body）：「This session is already the lead or a member of team "X" (id). Call
  team_inspect and use team_delegate …; do not create or join another team. 你已经是团队「X」的成员或负责人，请先 team_inspect，再用
  team_delegate 在本团队内派活，不要新建或加入其他团队。」

## 3. 模型侧

- 无 scope 时的报错从「Join or create a team first」改为「This session has no team scope. Do not create a team to get one …」。
- 负责人工作法第 8 条：team 工具报无团队/无 scope 时不要 team_create/team_join，先 team_inspect 或告诉用户。

## 4. Web

`AdoptTeamForm`（团队页 `?fromSession=`）收到 `code: 'session_in_other_team'`（附 `safeToChange`，未发生任何写）时显示行内确认
（团队名 + 后果），确认后用**新 requestId** 带 `transfer: true` 重发；取消不发请求。ChatHeader 对已在团队里的会话仍不显示入口。

## 5. 兼容矩阵与发布顺序

| | 旧 server | 新 server |
|---|---|---|
| 旧 CLI | 不变 | create（带 `inheritFromSessionId`）/join 被拒时只看到 `Teams request failed (HTTP 409)`：普通错误，不建第二个团队 |
| 新 CLI | `sessionId`/`transfer` 被 zod 剥离，行为同旧；scope 重拉与重建照常（只用既有 claim/list API） | 全部生效 |
| 旧 Web | — | adopt 遇拒显示通用「暂未完成」，无法转移（不影响安全） |

`TeamAdoptSchema` 是 strict：旧 CLI 收到 `transfer` 会拒绝，但只有新 CLI 会返回 `code: session_in_other_team`，Web 只在拿到该 code 后才发 `transfer`。
发布：server/Web 同镜像先发，CLI 随后；任意顺序都安全。

## 6. 验证

- server：`reducer.spec.ts`（`otherTeamBinding` / `transferSessionOut`）、`store.pglite.integration.spec.ts`（跨团队 create/join 拒绝且不落库、
  旧 CLI 形状也拒、transfer 后旧 bot 释放 + 凭据作废 + 标记、已归档不拦）。
- CLI：`relaunchScope.test.ts`（Claude/Codex/pi 三种 metadata 都带回 env、收据兜底、重建、重建失败仍钉团队、两条重拉路径接线——mutation-check 4/4）、
  `worker.test.ts`（claim 重放重建 0600 scope；换会话/换代/归档拒绝）、`adopt.test.ts`（拒绝文案原样、不泄露 body、确认后 transfer）。
- Web：`AdoptTeamForm.test.tsx`。本地 e2e 日志：`~/code/github/skills/tmp/vh-team-B-730/`。
