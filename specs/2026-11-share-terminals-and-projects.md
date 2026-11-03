# 网页终端分享（只看 / 可操作）与项目分享

> 状态：Approved（Lead 11-03：1–4、6–12 按推荐；5 改为终端「只看」也不允许永久，1/7/30 天默认 7 天，并加非红色提示）；A 部分实现见文末「实现记录（PR-A）」，B 部分待实现
> 关联：[2026-10-session-sharing](2026-10-session-sharing.md)（B-619）、[2026-10-session-sharing-tiers](2026-10-session-sharing-tiers.md)（B-701）、[2026-11-session-sharing-operator](2026-11-session-sharing-operator.md)（B-867 broker）、[2026-10-projects](2026-10-projects.md)（项目、B-868 终端归属）、[terminal-geometry-latest-viewer](2026-09-terminal-geometry-latest-viewer.md)
> 基线：main a7c0d5619

## 背景

- Owner 11-03：「网页终端怎么看不到分享页面」→ 做终端分享，两档：只看、可操作。
- Chris 11-03 14:50（截图：终端页顶栏没有分享按钮）「好像没有看到按钮可以分享」；14:58「能不能直接分享项目？」。Owner：一起做。

今天只能分享单个会话（viewer / driver / operator）。终端不是 server 上的 Session 对象，没有任何分享入口（`specs/2026-10-projects.md` §6.1「终端行没有分享」）。

## 0. 现状事实（代码已确认，main a7c0d5619）

| 事实 | 位置 |
|---|---|
| 终端不是 Session：身份是 `(machineId, terminalId)`，列表只在 daemon 上报的 `daemonState.webTerminals`（机器 key 加密）里；每项带 `title/cwd/tags/projectId/cols/rows` | `happy-cli/src/terminal/webTerminal.ts:631,635`；`terminalHandler.ts:140` |
| 终端 RPC（`open-terminal`、`terminal-history/scroll/paste`、`kill-terminal`）是 machine RPC，参数与 `encStream` 字节用机器 key 加密 | `happy-cli/src/api/apiMachine.ts:730-893` |
| 终端输出广播到 owner 的 `user:${owner}:user-scoped`；B-867 在这里挂了 `operatorTerminalTap` | `terminalHandler.ts:104-130` |
| **attach 会改主终端尺寸**：`open-terminal` 命中已有终端时无条件 `applyResize(existing, cols, rows)`；tmux 是 `window-size latest`，谁最后报尺寸谁赢 | `webTerminal.ts:2290,3024` |
| B-867 broker：operator 只持会话 DEK，服务器校验 → 改写 → 换钥（DEK↔机器 key）→ 以 owner 身份投递；每帧查 grant（缓存 1 s + 跨 slot 失效广播）；登记表 `SessionOperatorTerminal`；撤销 kill `opened`、只断 `attached`；机器 key 只经 `openOperatorMachineKey(VerifiedOperatorGrant)` 打开（源码断言钉住） | `operatorBroker.ts:1-140,613-661` |
| 服务器已能解 `daemonState.webTerminals`（B-867c 用它检测 operator 终端被 owner 关掉） | `operatorBroker.ts:601,613` |
| 会话访问判断 `resolveSessionAccess` = owner ∪ active 未过期 `SessionGrant`；列表 `listSharedSessionRows` 用 grant 里存的 `granteeDataEncryptionKey`；扇出 `activeGranteeIds` 缓存 5 s，**跨 slot 无失效广播**（`operatorGrantsChanged` 只清 operator 缓存） | `sessionShares.ts:81-99,424-449,507-525` |
| 项目成员 = 显式 `ProjectMember`（`sessionId @unique`）∪ 挂在项目上的 Team 的 bot 会话（读时派生，不双写）；写入点只有 `store.ts` 的 upsert/deleteMany/presence | `projects/store.ts:22,123-140,177,327,565` |
| 终端的项目归属存在 owner 机器上（tmux `@vh_project`），随 `daemonState.webTerminals[].projectId` 上报；server 无表（B-868） | `2026-10-projects.md`「B-868」 |
| 项目所有读写路由都按 `accountId` 过滤，只有 owner 能读 | `projectRoutes.ts:47-101`、`store.ts:190-680` |

## 1. 范围与非目标

做：
- **A. 终端分享**：单个网页终端分享给一个联系人，「只看」或「可操作」。
- **B. 项目分享**：整个项目分享给一个联系人，「只读」或「可发消息」；被分享者看到项目下所有会话与终端，含之后加入的。

不做：链接分享终端/项目（只走联系人，理由同 B-867 §7：终端输出与项目全貌都不适合匿名链接）；分享给团队/Space；被分享者在 owner 机器上新建会话或终端；被分享者改项目设置、说明、记录。

## 2. 总体设计：一个 broker，三种授权来源

```
                     ┌ SessionGrant（已有：viewer/driver/operator）
grantee 的访问来自 ──┼ TerminalGrant（新：终端 viewer / operator）
                     └ ProjectGrant（新：项目 viewer / driver）→ 读时派生到项目内会话与终端
```

- **会话**：effective role = max(直接 SessionGrant, 项目派生)。派生只到 viewer/driver，operator 只能来自直接 SessionGrant。
- **终端**：effective = max(直接 TerminalGrant, 项目派生)。项目派生的终端一律「只看」。
- 所有终端流量都经 B-867 broker（中央 server，不走 relay）。broker 的「授权」一步从「只认 operator SessionGrant」扩成「认 `VerifiedShareGrant`」，其余（改写、换钥、投递、审计、每帧检查、撤销）复用。

### 2.1 派生不落库（推荐）

项目派生的访问**读时计算**，不往 `SessionGrant` 里物化行：

| | 读时派生（推荐） | 物化成 SessionGrant 行 |
|---|---|---|
| 「之后加入的也能看」 | 天然成立，复用 `membersOf`（显式 ∪ 团队派生） | 每个入项目路径（显式、血缘、团队 bot 换代、自动化）都要同步写，漏一处就看不到 |
| 「移出即收回」 | 天然成立 | 每个出项目路径都要删，漏一处就泄露 |
| 与直接分享冲突 | 无：`@@unique(sessionId, grantee)` 不受影响 | 撞唯一键，要加来源列并改所有读路径 |
| 代价 | 访问判断多一次查询（会话→项目→ProjectGrant），加 1 s 缓存；DEK 按需重包（已有 10 min DEK 缓存） | 读路径零改动 |

团队派生成员本来就是读时派生（`store.ts:22`），派生分享沿用同一方式，单一事实源。

## 3. A. 终端分享

### 3.1 能力

| | 只看（viewer） | 可操作（operator） |
|---|---|---|
| 实时输出 + 回滚（`terminal-history`/`terminal-scroll`） | ✅ | ✅ |
| 键盘输入、粘贴（`terminal-input`、`terminal-paste`） | ❌ 服务器丢弃 | ✅ |
| resize 主终端 | ❌ 服务器丢弃；Web 本地按宽度缩放 | ✅（同 owner 的其他设备，tmux latest 规则） |
| kill / 关闭 owner 的终端 | ❌ | ❌（只能自己断开；在 shell 里 `exit` 属于 shell 能力，警告里写） |
| 新开终端、看机器上其他终端、文件面板、会话 | ❌ | ❌ |
| 有效期 | 1 / 7 / 30 天，默认 7 天，**无永久**（Lead 11-03：终端输出常回显 env / token / 密钥） | 1 / 7 / 30 天，默认 1 天，无永久（同 B-867） |
| 确认 | 普通，但显示一条非红色提示：「对方能看到这个终端的全部输出，包括可能出现的密钥、令牌和环境变量」 | 红色警告 + 勾选 + 二次确认 + `confirmOperator:true`（同 B-867 §9，警告去掉「从会话目录起步」一条） |

### 3.2 只看档不改主终端尺寸

`open-terminal` 命中已有终端必 resize（`webTerminal.ts:2290`）。~~只靠 server 填上报几何~~（实现时推翻：`daemonState.webTerminals` 的 `paneCols/paneRows` **不进列表签名**，单纯 resize 不触发推送，可能滞后 ≤60 s；用滞后值 attach 会把 owner 窗格拉回旧尺寸；不传 cols/rows 时 CLI 回落 80×24。）改为：
- **CLI 新增 `open-terminal.viewOnly`**：已在内存的终端按它自己的 `cols/rows` 重入（`applyResize` 比较后 no-op），冷 attach 读 tmux 当前 `#{window_width} #{window_height}`；隐含 `attachOnly`，丢弃 `startupCommand/attachTmux/projectId`；回包带 `viewOnly:true, paneCols, paneRows`。能力位 `daemonState.terminalViewOnly {rpcAvailable, detectedAt}`（`detectedAt >= startedAt` 才算）。
- broker 对 viewer 的 attach 一律带 `viewOnly:true`，并**忽略 grantee 的 cols/rows**（填上报几何只是给旧字段一个值）；机器没有该能力位 → `cli_upgrade_required`，**在任何东西发到 daemon 之前**拒绝。
- `terminal-resize` / `terminal-scroll`（会把 owner 窗格切进 copy-mode）对 viewer 一律丢弃 / 拒绝。
- owner 自己的 open 不带 `viewOnly`，行为不变（CLI 测试钉住：owner 再 attach 仍按自己的尺寸生效）。
- Web 端只看视图：固定列数 = 上报的 `cols`，按容器宽度等比缩放字号（不改 lineHeight 1.0、不改字形填格，铁律 9），窄屏可横向平移；输入法、键盘栏不渲染。

**CLI 改动**：仅上面一处（只看档需要；可操作档兼容旧 CLI）。

### 3.3 绑定与生命周期

- `TerminalGrant` 绑定 `(ownerAccountId, machineId, terminalId)`。终端被 owner 关掉 → grantee 看到「终端已关闭」，grant 保留到期或撤销；owner 用「恢复」（同 id 的 `restore-terminal`）后自动恢复访问。tombstone 被清除后，扫尾把 grant 标为 `ended`（原因 `terminal_deleted`）。
- 终端里跑的镜像会话（B-105 terminal-mirror）**不随终端分享**；会话分享另做。分享面板提示「这个终端里的会话没有一起分享」。
- 分享是定向的：先 pending，对方接受后 active（同 B-619）。

### 3.4 链路与加密

```
grantee Web ──(user socket，中央)──▶ broker
   share-terminal-rpc {grantId, op: attach|history|scroll|paste, params: K_grant 密文}
   share-terminal-input|resize|close {grantId, data: K_grant 密文}
            │ resolveTerminalShare(caller, grantId)：active、未过期、owner 仍拥有该机器
            │ 档位白名单（viewer 无 input/paste/resize）
            │ K_grant 解 → 机器 key 加密 → user:${owner}:machine:${machineId}
owner daemon ── terminal-output（机器 key）──▶ terminalHandler → tap：命中登记 → 机器 key 解 → K_grant 加密
            ▼  user:${grantee}:user-scoped  share-terminal-output|exit {grantId, seq, data}
```

- **K_grant**：每条 TerminalGrant（与每条 ProjectGrant）建立时服务器生成 32 字节随机 key，`box` 给 grantee 的 content 公钥存 `granteeKey`（与 `granteeDataEncryptionKey` 同格式）；服务器需要时用 grantee 的账号 secret 解开（同 `openSessionDataKey` 的现有能力）。AES-256-GCM，格式与会话 DEK 一致，Web 复用 `encryptRaw/decryptRaw`。
  - 不用会话 DEK（终端没有会话）；不下发机器 key（解开 owner 全部终端，B-867 T2）。
  - 加密的意义：跨 slot 的 Redis adapter 帧里不出现明文；grantee 撤销后手里的 key 只对这条 grant 的流有效。
- 机器 key 打开点仍只有一个：`openShareMachineKey(VerifiedShareGrant, machineId)`，`VerifiedShareGrant` 只能由 `resolveOperatorGrant`、`resolveTerminalShare`、`resolveProjectTerminalShare` 三个解析函数（和登记行的 teardown）铸造；扩展现有源码断言。
- 登记表复用 `SessionOperatorTerminal` 的思路，新表 `ShareTerminalAttachment`（见 §6），kind 恒为 `attached`：撤销只断开（发 `terminal-close` 减订阅），**从不 kill**——终端是 owner 的。
- 明文只在服务器内存，不进日志 / metrics / 错误串（B-867 契约原样适用）。

### 3.5 撤销 ≤1 s

- 触发：owner 撤销、改档（operator→viewer）、grantee 退出、过期、终端删除、owner 失去该机器。
- 动作复用 B-867 两段式 teardown：DB 置位 → 跨 slot 广播 → 给 grantee 发 `share-terminal-revoked` → 对该 grant 的 attachment 发 `terminal-close` → 写审计。
- 每帧兜底：input、output、RPC 每次都过 `resolveTerminalShare`（缓存 1 s，跨 slot 广播即清）。到期由 1 s 扫尾推通知，数据面在到期瞬间停。

## 4. B. 项目分享

### 4.1 语义

- 被分享者看到项目的：成员会话（显式 ∪ 团队派生，**含之后加入的**）、项目内终端（`webTerminals[].projectId` = 该项目，含之后移入的）、项目名称/目标/目录（脱敏，见 4.4）、**说明与记录（只读）**。
- 看不到：离线留言（`ProjectMessage`，点对点私信性质）、团队的任务树与消息、自动化、项目设置、ux/度量数据、项目外的任何东西。
- **移出即收回**：会话移出/换项目、团队解绑、团队 bot 换代后旧会话不再是成员、终端移出项目 → 下一次读路径即 404，并推 `project-share-item-removed` 让 Web 关闭已打开的页面（≤1 s，见 4.5）。
- **撤销项目分享**只收回派生访问；同一会话/终端的直接分享不受影响（effective 回落到直接 grant）。
- 归档项目：分享保留但只读冻结（被分享者仍能看历史，看不到新加入，因为归档项目不再接新成员）。删除项目：ProjectGrant 级联删除，派生全部收回。

### 4.2 档位

| 档 | 会话 | 终端 | 说明/记录 |
|---|---|---|---|
| 只读（viewer） | 同会话 viewer | 只看 | 只读 |
| 可发消息（driver） | 同会话 driver（服务器加密署名消息，B-619） | **只看** | 只读 |
| ~~可操作~~ | **不开放**（推荐） | — | — |

理由（项目级不开放可操作）：可操作 = owner 机器 shell；项目级授予会把「之后才加入项目的会话/终端」也自动变成远程 shell，owner 在加入那一刻没有做授权动作，违背 B-867 「每次点名 + 二次确认 + 有效期」的前提；且团队 bot 会话会自动加入项目，等于持续扩张授权面。需要时对单个会话/终端授予。

### 4.3 有效期与接受

- 1 / 7 / 30 天 / 永久，默认永久（同会话联系人分享）。先 pending，对方接受后生效。
- 每个项目最多 20 条有效 ProjectGrant；限频沿用分享路由 30/min。

### 4.4 可见数据与脱敏

- 会话：与直接分享完全相同的脱敏 metadata（`redactMetadataObject`）与 DEK 重包（按需 `box` 给 grantee，复用 10 min DEK 缓存）。
- 终端：服务器解出 `webTerminals`，只投影 `{terminalId, machineName, title, cwd 的目录名, projectId, alive, activityAt}`；不给 tags 外的 tmux 名、完整路径、`attachTmux`、pid。
- 项目：name、goal、说明当前版本（不含历史）、记录（作者会话显示标题，不显示 sessionId 之外的机器信息）、目录列表只给 `{machineName, basename}`。
- presence「在做：…」：随会话行给。

### 4.5 访问判断与扇出

- `resolveSessionAccess(user, session)`：owner → 直接 grant → `projectOf(session)`（显式行，或团队派生）→ active 未过期 ProjectGrant(project, user)。结果 kind 新增 `{ kind: 'project', ownerId, role, projectGrantId, projectId }`；`requireSessionAccess` 的 viewer/driver 判断不变。
- `listSharedSessionRows`：直接 grant 行 ∪ 每条 active ProjectGrant 的 `membersOf`；同一会话两者都有时合并为一行，role 取高，`share.via = 'direct' | 'project' | 'both'`。
- `activeGranteeIds(session)`：∪ 该会话所在项目的 ProjectGrant grantee。缓存仍 5 s，但**所有**分享/成员变化都发跨 slot 失效（把现有 `vh-operator-changed` 扩成 `vh-share-changed`，同时清 grantee、operator、项目三类缓存），所以撤销/移出在两个 slot 都是即时的；TTL 只是兜底。
- 成员变化钩子：`store.ts` 的 addMembers/removeMember/attachTeam/detachTeam/团队成员换代/删除、归档项目，统一调 `projectMembershipChanged(projectId, removedSessionIds)` → 失效缓存 → 给该项目所有 grantee 推增删事件。
- 终端：`machine-update-state` 写入时，若 owner 有 active ProjectGrant 或 TerminalGrant（内存 Set 判断，无则零开销），解出 `webTerminals` 与上一版比对 `projectId`，移出的终端立即断开 grantee 的 attachment 并推事件；其他 slot 读 DB 中的 `Machine.daemonState`（按 `daemonStateVersion` 缓存）判断，不依赖进程内状态。

### 4.6 被分享者的入口

- 侧栏「分享给我的」下新增「项目」组：每个分享项目一行，展开是其会话与终端（与自己的项目分组同样式，标 owner 名）。
- `/shared/projects/:id`：结构同自己的项目页（概览 / 上下文两段），全部只读：没有输入框（driver 也不在项目页起新会话，只能进具体会话发消息）、没有「新建会话/终端」、没有设置齿轮与 ⋯ 编辑项。
- 进入会话 = 现有共享会话页；进入终端 = 只看终端视图（§3.2）。

## 5. 审计

新表 `ShareAuditEvent(id, ownerAccountId, actorAccountId, grantKind: 'session'|'terminal'|'project', grantId, resourceKind: 'session'|'terminal'|'project', resourceId, kind, detail jsonb, at)`，无外键，保留 90 天（复用 B-867 的每小时清理）。只存元数据。

| kind | 何时 | detail |
|---|---|---|
| `grant.create/accept/decline/update/revoke/expire` | 终端、项目 grant 生命周期 | 档位、有效期 |
| `project.derive.open` | grantee 经项目**首次**拿到某会话 DEK / 首次 attach 某终端；之后同 (grantee, resource) 10 分钟去重 | 会话或终端 id、项目 id |
| `project.item.removed` | 成员移出导致派生收回 | 原因（moved/removed/team_detached/terminal_moved） |
| `terminal.attach/detach` | 每次 attach / 断开 | grantKind、viewer/operator |
| `terminal.input` | operator，按分钟聚合 | 字节数、回车数，**不存按键内容**（同 B-867） |
| `ended` | 撤销/过期/删除 teardown | 原因、断开数 |

business audit 只外发元数据（同 B-867c `operatorAuditPayload`）。owner 在分享面板与设置「已分享」里看到「最近访问」（项目分享按会话/终端列出最近打开时间）。会话 operator 继续用 `SessionOperatorEvent`，不迁移。

## 6. 数据（纯 expand）

```sql
CREATE TABLE "TerminalGrant" (
  id TEXT PK, "ownerAccountId" TEXT FK→Account CASCADE, "granteeAccountId" TEXT FK→Account CASCADE,
  "machineId" TEXT, "terminalId" TEXT, role TEXT ('viewer'|'operator'),
  status "SessionGrantStatus" DEFAULT 'pending', "granteeKey" BYTEA,
  "titleSnapshot" TEXT,                 -- 邀请里显示，避免对方在接受前解机器状态
  "expiresAt" TIMESTAMP NULL, "operateConfirmedAt" TIMESTAMP NULL, "endedReason" TEXT NULL,
  "createdAt", "updatedAt", "acceptedAt", "revokedAt",
  UNIQUE("machineId","terminalId","granteeAccountId"), INDEX("granteeAccountId", status), INDEX("ownerAccountId"));
CREATE TABLE "ProjectGrant" (
  id TEXT PK, "projectId" TEXT FK→Project CASCADE, "ownerAccountId" TEXT, "granteeAccountId" TEXT FK→Account CASCADE,
  role "SessionGrantRole" ('viewer'|'driver'), status "SessionGrantStatus" DEFAULT 'pending', "granteeKey" BYTEA,
  "expiresAt" TIMESTAMP NULL, "createdAt", "updatedAt", "acceptedAt", "revokedAt",
  UNIQUE("projectId","granteeAccountId"), INDEX("granteeAccountId", status));
CREATE TABLE "ShareTerminalAttachment" (id, "grantKind", "grantId", "ownerAccountId", "granteeAccountId",
  "machineId", "terminalId", "openedAt", "closedAt" NULL, "closeReason" NULL);  -- 无 FK，同 SessionOperatorTerminal
CREATE TABLE "ShareAuditEvent" (...);   -- §5，INDEX(ownerAccountId, at)、INDEX(at)
```

- 不改 enum、不改已有表列；`SessionGrant` 零改动。`TerminalGrant.role` 用 TEXT + 服务器白名单（新增档不必 `ALTER TYPE`）。
- 迁移时间戳在开 PR 前按 BRIEF 规则核对在途 PR，晚于所有在途迁移。发布前设 `VH_RELEASE_MIGRATIONS_REVIEWED`。
- 回滚：旧 server 不认识新表 → 终端/项目分享全部失效（收权方向），直接分享不受影响；不跑 down migration。回滚前无需 SQL（新表对旧代码不可见，无「过期复活」问题）。

## 7. 接口

| 接口 | 说明 |
|---|---|
| `POST /v1/terminal-shares` `{machineId, terminalId, target|granteeAccountId, role, expiresInDays, confirmOperator?}` | owner；校验机器属于 owner、终端存在于其 `webTerminals`；operator 需 `confirmOperator:true` 且有期限 |
| `GET /v1/terminal-shares?machineId&terminalId` / `PATCH …/:grantId` / `DELETE …/:grantId` | owner 管理 |
| `GET /v1/terminal-shares/incoming`、`POST /v1/terminal-shares/:grantId/respond {accept}` | grantee；pending 与 active 列表（含 owner、机器名、标题、是否在线、档位、到期） |
| `POST /v1/projects/:id/shares` `{target|granteeAccountId, role: viewer|driver, expiresInDays}`；`GET/PATCH/DELETE /v1/projects/:id/shares[/:accountId]` | owner；`role` 只接受 viewer/driver（zod 严格，带 operate → 400 `project_operator_denied`） |
| `GET /v1/project-shares/incoming`、`POST /v1/project-shares/:grantId/respond` | grantee |
| `GET /v1/shared/projects/:id` | grantee：项目投影 + 会话行 + 终端行 + 说明 + 记录 |
| `GET /v1/sessions` | 新增 `?projectShares=1`：带上项目派生的会话行（`share.via`）。**不带参数时不返回派生行**（旧 Web 不会出现无法退出的行） |
| `GET /v1/shares/outgoing` | 增加 `terminals[]`、`projects[]` 两组 |
| socket（grantee user 连接）`share-terminal-rpc`（ack）、`share-terminal-input/resize/close` | §3.4；项目派生终端的 grantId 用 ProjectGrant id + `terminalRef {machineId, terminalId}` |
| socket 下行 `share-terminal-output/exit/revoked`、`project-share-updated`、`project-share-item-added/removed` | 新事件名，旧 Web `onAny` 自然忽略 |
| 错误码 | `not_shared`、`share_method_denied`、`terminal_geometry_unknown`、`terminal_gone`、`cli_upgrade_required`、`machine_unsupported`、`machine_offline`、`rate_limited`、`bad_params` |

## 8. 兼容矩阵

| 组合 | 结果 |
|---|---|
| 新 server + 新 Web + 新 CLI（`terminalViewOnly`） | 全功能 |
| 新 server + 新 Web + 支持 `encStream`、有机器 DEK、无 `terminalViewOnly` 的 CLI | 「可操作」可用；「只看」提示「对方机器上的 CLI 需要升级」（未发任何东西到 daemon，不会改尺寸） |
| 新 server + 新 Web + 极旧 CLI（无 `encStream` / legacy 机器 key） | 终端分享入口可点，grantee 打开提示「对方机器的 CLI 需要升级」（`cli_upgrade_required`/`machine_unsupported`）；owner 分享时就提前提示 |
| 新 server + 新 Web + 无 `terminalProjects` 能力的 CLI（B-868 前） | 该机器终端无项目归属 → 不出现在项目分享里（owner 侧本来就显示「需升级 CLI」）；项目会话不受影响 |
| 新 server + 旧 Web（grantee） | 不请求 `projectShares=1`，看不到派生会话、终端分享；新事件被忽略；直接分享照常 |
| 新 server + 旧 Web（owner） | 没有终端/项目分享入口；已建分享照常生效，在旧 Web 上不能管理（只在发布窗口出现） |
| 旧 server + 新 Web | 新路由 404 → 面板显示「服务器版本过旧」（复用 `http_404` 文案）；回滚窗口才会有 |

## 9. 发布顺序与 PR 拆分

- **PR-A 终端分享**：migration（TerminalGrant、ShareTerminalAttachment、ShareAuditEvent）+ server broker 扩展 + Web（终端顶栏/行菜单「分享…」、只看终端视图、「分享给我的 · 终端」）。
- **PR-B 项目分享**：migration（ProjectGrant）+ server 访问派生与扇出 + Web（项目 ⋯「分享项目…」、`/shared/projects/:id`）。依赖 A 的 broker 抽象与审计表，B 基于 A 分支。
- server/Web 同镜像。**PR-A 含 CLI 改动**（`viewOnly`，Lead 11-03 知会）：先发 server/Web，再发 CLI；CLI 先发也无害（旧 server 不发 `viewOnly`，旧 Web 不认能力位）。PR-B 不改 CLI。先 A 后 B 合入，可同一个 Release 发。

## 10. UI 与文案

- 终端：顶栏（`WebTerminalScreen` 顶栏右侧，与标签/项目按钮同组）与侧栏终端行 ⋯ 加「分享…」→ 复用 `ShareDialog` 的联系人 tab（无链接 tab），档位两项「只看 / 可操作」。只在 owner 自己的、在线机器的终端上出现。
- 项目：项目页 ⋯、`/projects` 行菜单、项目设置新区块「分享」`#sharing`，档位「只读 / 可发消息」，列表显示每个对象、到期、最近访问。
- 会话分享面板：若会话也经项目分享，列出只读行「通过项目 X · bob · 只读」，提示「要收回请移出项目或撤销项目分享」。
- grantee：只看终端顶部常驻条「只看 · <owner> 的终端 · <到期>」；可操作沿用 B-867 提示条。
- 文案中英：`share.terminal.viewOnly` "View only" / 「只看」；`share.terminal.operate` "Can operate" / 「可操作」；`share.project.title` "Share project" / 「分享项目」；`share.project.viaProject` "Via project {name}" / 「通过项目 {name}」；终端关闭、等待就绪、CLI 需升级、已撤销、已移出项目。
- 设计：按 design skill 与 `docs/design-language.md`；终端 pane 两种主题都保持深色。

## 11. 测试与验收

- server（pglite + Fastify inject + 真 socket.io + 双实例 Redis adapter）：
  - viewer 的 input/paste/resize 被丢弃；attach 的 cols/rows 被替换为上报几何、几何未知拒绝；他人终端、同机其他终端、`open-terminal` 新建全部拒绝；operator 不能 kill。
  - 项目派生：之后加入的会话/团队 bot 会话/移入的终端可见；移出、换项目、团队解绑后 404 + 推送；撤销项目分享不影响直接 grant；项目分享传 operate → 400。
  - 撤销 ≤1 s：跨 slot 广播后另一实例的扇出与终端 tap 立即停止。
  - 加密：grantee 收到的帧只能用 K_grant 解；日志无明文；机器 key 打开点源码断言 + mutation-check。
  - 兼容：不带 `projectShares=1` 的 `/v1/sessions` 与 main 版响应 schema 一致。
- e2e（本地 standalone + 隔离 `HAPPY_HOME_DIR` 真 daemon，两个真实账号，两个 Playwright context，B 用 390×844 coarse）：
  - A：终端 → 分享给 B 只看 → B 看到实时输出与回滚、键入无效、A 的 pane 宽度不变（修前/修后比较 `tmux display -p '#{window_width}'`）→ 升为可操作 → B 输入 `echo hi` 生效 → A 撤销 → B ≤1 s 断开，A 终端仍在。
  - A：项目分享给 B 只读 → B 看到会话与终端 → A 新建会话加入项目 → B 侧出现 → A 移出一个会话 → B ≤1 s 关闭页面 → 升为可发消息 → B 在会话里发消息署名正确、终端仍只看 → A 撤销 → B 全部消失，A 另一条直接会话分享仍在。

## 12. 待 Lead 拍板（每点附推荐）

1. **项目级不开放「可操作」**：推荐不开放（§4.2 理由）；可操作只对单个会话/终端授予。
2. **项目「可发消息」档下终端仍是只看**：推荐是（driver 不等于 shell）。
3. **项目说明与记录对被分享者可见（只读）**；离线留言、团队任务、自动化不可见：推荐如此。备选：分享时勾选「包含说明与记录」，默认勾上。
4. **派生访问读时计算、不物化**（§2.1）：推荐读时计算。
5. **终端「只看」默认有效期 7 天**（可选永久）；可操作 1/7/30 天默认 1 天无永久：推荐如此。备选：只看默认永久与会话分享一致。
6. **终端「可操作」允许 resize 主终端**（tmux latest，同 owner 其他设备），只看绝不 resize：推荐如此。
7. **终端分享不连带终端里的镜像会话**，任何档都不能 kill owner 的终端；撤销只断开不 kill：推荐如此。
8. **每条 grant 一把独立 K_grant（box 给 grantee）加密终端流**，不下发机器 key、不复用会话 DEK：推荐如此。
9. **旧 Web 兼容**：`/v1/sessions` 只在 `?projectShares=1` 时返回派生行：推荐如此（旧 Web 看不到项目分享，不会出现无法退出的行）。
10. **项目分享不能按会话排除**（v1）；要排除就移出项目：推荐如此，降低模型复杂度。
11. **跨 slot 失效统一**：把 `activeGranteeIds` 的 5 s 跨 slot 窗口一并修成即时（`vh-share-changed`），顺带收紧既有会话分享：推荐如此。
12. **PR 拆分**：A（终端）先、B（项目）基于 A；CLI 不发版：推荐如此。

## 实现记录（PR-A 终端分享，B-878）

- **server**：`app/share/terminalSharePolicy.ts`（纯函数：档位白名单、viewer attach 改写、有效期、daemonState 解析）、`terminalShareBroker.ts`（授权 → 改写 → 换钥 → 转发 → 审计；输出 tap；撤销 teardown；1 s 扫尾；machine-state 钩子推「终端已关闭」与新几何）、`terminalShares.ts`（grant 增删改查、接受/退出）、`api/routes/terminalShareRoutes.ts`。迁移 `20261103170000_terminal_shares`：`TerminalGrant`、`ShareTerminalAttachment`（含 `subscribers`：attach +1、关闭 −1，teardown 按数释放 daemon 订阅，**从不 kill**）、`ShareAuditEvent`。
- **机器 key**：`openTerminalShareMachineKey(VerifiedTerminalShare)` 是本模块唯一打开点，只开 grant 自己那台 owner 机器；`VerifiedTerminalShare` 只由 `resolveTerminalShare`（active + 未过期 + 本人）与 attachment 行铸造。源码断言 + mutation-check（server 18/18 被抓，见 PR）。
- **流 key**：每次（重新）分享生成新的 32 字节 key，box 给 grantee content 公钥存 `granteeKey`；Web 用 `decryptEncryptionKey` 解开后按会话 DEK 同格式 AES-GCM。
- **跨 slot**：本 broker 自己的 `vh-terminal-share-changed`；会话分享的 grantee 缓存统一（决策 11）留给 PR-B。
- **Web**：终端页头「分享终端」（手机进 ⋯）、侧栏终端行 ⋯「分享…」→ `TerminalShareDialog`；owner 页头「X 正在看」芯片；`/shared/terminal/:grantId`（`SharedTerminalScreen`，只看=owner 列数 + 等比缩小、`disableStdin` + `inputmode=none`；可操作=正常 fit + 输入 + resize）；侧栏顶部邀请与「分享给我的终端」；设置「已分享」加终端组。所有新 socket 事件独立命名，旧 Web 忽略。
- **CLI**：`open-terminal.viewOnly` + 能力位 `terminalViewOnly`（见 §3.2）。
- **已知限制**：owner 的「正在看」芯片只靠实时事件，owner 晚于对方打开终端页时不显示已在看的人（分享面板里有完整名单与活动记录）；只看页在 owner 改尺寸后随 daemonState 推送重排，推送最长可滞后约 60 s，页上有「重新同步」。
