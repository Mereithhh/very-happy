# Session 分享第三档：可操作（operator / Can operate）

> 状态：Draft，待 Lead 审阅（B-867）
> 关联：[2026-10-session-sharing](2026-10-session-sharing.md)（B-619 联系人分享）、[2026-10-session-sharing-tiers](2026-10-session-sharing-tiers.md)（B-701 链接分享与有效期）、[permission-mode-source-of-truth](2026-08-permission-mode-source-of-truth.md)、[terminal-channel-v2](2026-08-terminal-channel-v2.md)
> 基线：main 21206d4a

## 背景

Chris 11-02：「有没有什么自己的 session 给别人临时接手的功能？」「terminal 好像不行？」。现有两档（viewer 只读、driver「可发消息」）都**拿不到任何 RPC**，这是 B-619 有意的安全设计。本 spec 加第三档 **operator**：在 driver 之上开放该会话的终端、文件面板、`/btw`、审批与打断。

它等价于「把分享者机器上的 shell 交给对方」。本 spec 的重点是：边界怎么划、谁能拿到什么密钥、撤销怎么做到立即断开。

## 0. 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| RPC 房间 `rpc:${callerUserId}:${method}`，房间名由**调用者**的 userId 拼出，跨账号打不到；CLI 收到的 `rpc-request` 只有 `{method, params}`，不知道调用者是谁 | `happy-server/sources/app/api/socket/rpcHandler.ts:68,365,409`；`happy-cli/src/api/rpc/types.ts:22` |
| session RPC 参数/结果用**会话 DEK** 加密（AES-256-GCM）；grantee 已经持有 DEK（服务器重包，`granteeDataEncryptionKey`） | Web `apiSocket.ts:275`、`sessionEncryption.ts:123`；CLI `apiSession.ts:204`；`sessionShares.ts:263` |
| Web 侧 `sessionRPC` 对 shared session 直接抛错 | `apiSocket.ts:280-282` |
| **终端全部是 machine RPC**（`open-terminal`、`terminal-history/scroll/paste`、`kill-terminal`、`list-terminals` 等），参数与 `encStream` 字节流都用**机器 key** 加密 | `happy-cli/src/api/apiMachine.ts:241-261,730-893` |
| 终端字节流走 socket.io：daemon→`user:${owner}:user-scoped`（该账号所有 web 都收到所有终端的字节）；web→daemon 走 `user:${owner}:machine:${machineId}`，只校验机器属于本账号 | `terminalHandler.ts:104-200` |
| daemon 中央 socket 连着时一定往中央发终端输出（relay 是额外的一份） | `apiMachine.ts:276-277` |
| relay 进程无 DB，token 只在握手校验，**没有撤销路径**；relay token 只发给 owner | `relay.ts:114-121`；`relayRoutes.ts:9-14` |
| 文件面板「浏览」用 machine RPC `fs-list/fs-read`，**无目录限制**；session RPC `readFile/writeFile/listDirectory/getDirectoryTree/ripgrep/bash` 走 `validatePath(path, metadata.path)`，限制在会话 cwd 内 | `fsRpc.ts:1-17`；`registerCommonHandlers.ts:218-583`；`apiSession.ts:210` |
| `/btw` = session RPC `btw-ask/poll/cancel` | `registerSideQuestionHandler.ts:159,226,242` |
| Claude `permission` RPC 可带 `mode`/`allowTools`/`updatedInput`；`set-permission-mode` 带 `mode` | `permissionHandler.ts:33-42,261-284`；`claudeRemoteLauncher.ts:270` |
| 服务器持有账号主 secret，能解出会话 DEK；机器 DEK 同样是 box 给账号 content 公钥的（`[0]+box`），服务器同法可解 | `sessionCrypto.ts:53-91`；`happy-cli/src/api/api.ts:180-190` |
| `SessionGrant.role` 是 PG enum `viewer|driver`；服务器/Web 的 zod 都是 `z.enum(['viewer','driver'])` | `schema.prisma:300-331`；`sessionShareRoutes.ts:27`；`sessionShareTypes.ts:8` |
| **旧 Web 收到未知 role 会坏**：share REST 用 `schema.parse`，`operator` 会让分享面板/待接受列表/已分享设置页全部报错 | `apiSessionShares.ts:40` |
| 现有撤销不断开任何 socket，只发 `session-share-revoked`；跨 slot 的 grantee 缓存窗口 ≤5 s | `sessionShares.ts:54,305-313` |
| 生产 blue/green 两个 slot 共用 Redis streams adapter，`io.to(room).emit` 与 `serverSideEmit` 都跨 slot | `operations.md:16`；`releaseCoordinator.ts:134` |
| B-850 账号凭据只在 daemon 主机文件里（`$HAPPY_HOME_DIR/accounts/<id>/secret`），只经 machine RPC `agent-profile-*` 管理，没有 RPC 返回 secret | `agentProfiles/store.ts`；`agentProfileRpc.ts:26-39` |

## 1. 威胁模型

### 1.1 参与方与信任

- **Owner**：会话与机器的主人，显式授权。
- **Operator（grantee）**：同服务器上一个**被 owner 点名并二次确认**的账号。按「可信但会犯错，账号可能被盗」对待。
- **Server**：仍在信任边界内（非端到端加密，现状不变）。本设计让服务器在 operator 链路上**看到明文**（它本来就能解），并把它变成唯一的执法点。
- **Owner 的 daemon / CLI**：执行者，**不知道调用者是谁**；本设计不依赖 CLI 改动做安全判断。

### 1.2 要防的

| # | 威胁 | 本设计的控制 |
|---|---|---|
| T1 | operator 越出这个会话：调别的会话的 RPC、别的机器、spawn 新会话、读 `agent-profile-*`、改账号设置 | operator **不拿机器 key、不拿 relay token、不进 owner 的 RPC 房间**；所有调用经服务器 broker，按 `sessionId` + 方法白名单逐条放行（§3） |
| T2 | 拿到机器 key 后解密 owner 所有终端/机器 RPC | 机器 key **永不下发**给 operator；服务器在 broker 里用机器 key 重加密/解密，对 operator 只用该会话 DEK（§2） |
| T3 | 把权限模式提到 bypass/yolo，让 agent 不经审批乱跑 | mode 只能**不高于 owner 当前生效 mode**（§4） |
| T4 | 撤销/过期后仍在敲终端或收输出 | 每帧查 grant；撤销时服务器主动 kill operator 开的终端、广播跨 slot 失效、通知 Web 关面板（§5） |
| T5 | 看不到 operator 干了什么 | 审计表 + owner 端实时「谁在操作」+ operator 终端在 owner 终端列表可见、可旁观、可关（§6） |
| T6 | 链接泄露带来远程执行 | 链接分享**没有**这一档，接口层就拒绝（§7） |
| T7 | 误授权 | 默认仍是 Can send；选 operator 必须二次确认，**必须设有效期**（无「永久」），服务器要求 `confirmOperator: true` |
| T8 | 旧客户端把 operator 当未知值报错/放宽 | wire 上 role 仍是 `driver`，另加 `operate: true`（§8） |

### 1.3 不能防的（必须写进警告）

- **shell 本身没有沙箱**。终端从会话 cwd 起步，但 operator 可以 `cd /`、读 owner 家目录下的任何文件，包括 `~/.happy`（含 B-850 accounts 的 secret 文件、daemon 凭据）、`~/.claude`、`~/.ssh`、云凭据；可以起后台进程、改 crontab、`nohup` 常驻。「不能碰其他会话和账号凭据」只在 **Very Happy 的 API 层**成立；在 OS 层，operator 拥有 owner 的 Unix 用户权限。
- 撤销会 kill operator 开的终端（tmux session 内的进程一起结束），但**脱离终端的进程**（`nohup`、`setsid`、`disown`、systemd --user、cron）撤销后仍会存活。
- 被盗的 operator 账号 = 被盗的 owner 机器 shell。

所以警告文案必须如实说：「对方将能以你的身份在这台机器上运行任意命令，可以读取这台机器上你能读的所有文件（包括凭据）。撤销会关掉对方开的终端，但对方启动的后台进程不会自动停止。」

**建议不做的缓解**：不在 shell 层做 chroot/容器/受限用户（跨平台成本大、与「接手我的会话」场景冲突），首版只做诚实警告 + 有效期 + 审计 + 撤销。Lead 若认为必须隔离，这一档应改为「只读终端旁观」，需要重开需求。

## 2. 加密与链路：服务器 broker

### 2.1 选择

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 把机器 key 重包给 operator | operator 直接 machineRPC + 收 user-scoped 终端流 | **拒绝**：机器 key 解开该机器上 owner 的全部终端与机器 RPC，违背 T1/T2；且终端流本来就广播到 owner 的 user-scoped 房间，要另造房间 |
| B. CLI 新增 session 级终端 RPC 并识别调用者 | wrapper 注册 `terminal-*`，服务器把 caller 带进 `rpc-request` | 需要 CLI/协议改动、执法分散在 daemon，旧 CLI 不能用；daemon 仍信不过 caller 字段（是服务器填的） |
| **C. 服务器 broker（推荐）** | operator 只用会话 DEK 和服务器说话；服务器校验、改写、用 owner 的密钥转发给 owner daemon；终端输出在服务器按 terminalId 挑出来、换成 DEK 加密后单播给 operator | 执法集中在服务器一处；**CLI 零改动**；operator 只多拿到「这个会话的 DEK」——B-619 起就已经有 |

服务器能解 DEK 与机器 key 是现状（B-619 起已有主动解 DEK 的代码路径）；本设计新增「服务器主动解机器 key」，同样只在 owner 授予 operator 后、由 operator 的具体调用触发，并写审计。

### 2.2 链路

```
operator Web ──(user socket, 中央 server，不走 relay)──▶ server broker
   operator-rpc {sessionId, op, params: DEK密文}
   operator-terminal-input|resize|close {sessionId, terminalId, data: DEK密文}
                    │ 1. resolveOperatorGrant(caller, sessionId)：active、未过期、operate=true、会话未归档未删除
                    │ 2. 白名单 + 参数改写（§3、§4）
                    │ 3. 用 DEK 解 → 用 DEK（session 方法）或机器 key（终端方法）重加密
                    │ 4. 写审计
                    ▼
   rpc:${ownerId}:${sessionId|machineId}:${method}  →  owner daemon（与 owner 自己调用完全同形）
   user:${ownerId}:machine:${machineId} terminal-input …

owner daemon ──terminal-output {terminalId, seq, data: 机器key密文}──▶ server terminalHandler
                    │ 照旧发给 owner 的 user-scoped（owner 能旁观）
                    │ terminalId ∈ operator 登记表 且 grant 仍有效 → 机器key解 → DEK加密
                    ▼
   user:${granteeId}:user-scoped  operator-terminal-output|exit {sessionId, terminalId, seq, data}
```

- operator 流量**只走中央 server**：relay 没有 DB、没有撤销路径，不给 operator relay token。终端延迟比 owner 走 relay 略高，可接受。
- 服务器强制 `encStream: true` 打开 operator 终端；daemon 回包没有 `encStream: true`（极旧 CLI）→ 服务器立即 `kill-terminal` 并返回 `cli_upgrade_required`。
- 机器无 `dataEncryptionKey`（legacy 机器 key）→ 服务器解不出 → 返回 `machine_unsupported`，Web 提示「对方机器的 CLI 需要升级」。
- 明文只在服务器内存里过一遍，**不进日志**；审计只记元数据（§6）。
- 性能：每帧一次 AES-GCM 解 + 一次加密；终端输出已受 `terminalRateLimit` 约束。登记表命中判断 O(1)（进程内 Map，见 §5.3）。

## 3. operator 能做什么（白名单）

服务器 broker 只认下面的 `op`，其它一律 `403 operator_method_denied`。session 方法只能打到 `${sessionId}:` 前缀，`sessionId` 必须是 grant 的那一个。

### 3.1 session RPC（转发到 `rpc:${owner}:${sessionId}:<method>`，DEK 加解密）

| 方法 | 放行 | 改写/限制 |
|---|---|---|
| `permission` | ✅ 审批/拒绝 | `mode` 走 §4 上限；`allowTools` **剥除**（「总是允许」会永久放宽 owner 会话的规则，不给）；`updatedInput` 保留（AskUserQuestion 答案） |
| `abort` | ✅ 打断任意一轮 | — |
| `steer` | ✅ | 文本加署名头（同 shared message 格式 `[Very Happy shared session message from "<name>" <id>]`） |
| `set-permission-mode` | ✅ | §4 上限 |
| `session-run-intent`（model/effort） | ✅ | 只允许改 model/effort，不允许改 provider/账号绑定字段（若有则剥除） |
| `btw-ask` / `btw-poll` / `btw-cancel` | ✅ | — |
| `readFile` `listDirectory` `getDirectoryTree` `ripgrep` `difftastic` `writeFile` `uploadFile` `uploadFileChunk` `bash` | ✅（文件面板、git 状态） | daemon 侧已 `validatePath` 限制在会话 cwd；服务器另拒绝 `..`/绝对路径越出 `metadata.path` 的请求（双保险） |
| `codex-child-read` | ✅（只读） | — |
| `killSession` `conversation-rewind` `claude-runtime-control` `switch` `teams-adopt` `openclaw-retry-pairing` | ❌ | 归档/回滚/切本地/开团队仍是 owner 的事 |

### 3.2 终端（转发到 owner 的 machine RPC，机器 key 加解密）

| op | 映射 | 限制 |
|---|---|---|
| `terminal.open` | `open-terminal` | **强制** `cwd = metadata.path`（会话 cwd，服务器从 owner 未脱敏 metadata 取）、`encStream:true`；**禁止** `startupCommand`、`attachTmux`、自带 `terminalId`（新开时由服务器生成）；每 grant 最多 4 个活终端 |
| `terminal.attach` | `open-terminal {terminalId, attachOnly}` | 只允许接入 (a) 本 grant 开的终端，(b) **该会话自己的终端** `metadata.terminalId`（terminal-mirror / 从终端起的会话）。后者登记为 `attached`，撤销时只断开、不 kill |
| `terminal.history` `terminal.scroll` `terminal.paste` | 同名 RPC | terminalId 必须在本 grant 登记表内 |
| `terminal.kill` | `kill-terminal` | 只能 kill 自己开的（`opened`），不能 kill `attached` 的 |
| `terminal.list` | 不转发 `list-terminals` | 服务器从登记表返回，**不暴露** owner 其他终端 |
| input / resize / close 事件 | `terminal-input/resize/close` 到 `user:${owner}:machine:${machineId}` | 同上登记表校验；data 用机器 key 重加密 |

**不提供**：machine `fs-list/fs-read/fs-mkdir`（无目录限制）、`spawn-*`、`agent-profile-*`、`model-config-*`、`cli-update-*`、`claude-auth-*`、history fork/import、`sessions.*`、`list-tmux-sessions`、`set-terminal-title/tags`（服务器自己代 owner 打 tag，见 §6）。

Web 侧 operator 的文件面板改用 session RPC（`listDirectory`/`readFile`）的适配器，根目录固定为会话 cwd；这一档在面板里明示「仅限项目目录」。（终端不受此限，警告里已写。）

## 4. 权限模式与模型：允许改，但不能提升

- **结论**：operator 可以切 mode / model，但 mode **不高于 owner 当前生效的 mode**（grant 授予时不快照；每次按会话 metadata 里 CLI 回报的实际生效值判断，见 permission-mode-cli-truth）。
- 档位（低→高）：
  - Claude：`plan` < `default` < `acceptEdits` < `bypassPermissions`
  - Codex：`read-only` < `default`/`auto` < `full-access`/`yolo`
  - 其它 runner（gemini/acp/pi/openclaw）：只允许切到与当前相同或白名单里明确更低的值；未知 mode → 拒绝。
- owner 当前 mode 未知（metadata 没回报）→ 视为 `default`。
- 好处：operator 可以把 owner 的 bypass 会话「降到 default 自己逐条审批」，但不能把 owner 的 default 会话提到 bypass。owner 之后再提升，operator 也能跟着用——这是 owner 的显式动作。
- `permission` 里的 `mode`（「批准并切换到 acceptEdits」）同规则；`allowTools` 一律剥除。
- model/effort：放开（影响的是 owner 的额度/费用，警告中提及「会使用你的 agent 账号与额度」）；不能改服务商/账号绑定（B-794/B-850）。
- Web `yoloEnforcement` 的 auto-approve 只对 owner 生效，operator 侧不自动审批（`storage.ts:536` 现状保留）。

## 5. 撤销、降级、过期：立即断开

### 5.1 触发

- owner 撤销、owner 把 operator 降为 driver/viewer、grantee 自己退出、会话删除/归档、grant 过期。

### 5.2 动作（服务器，按顺序）

1. DB 置 `revoked`（或改 `operate=false`），本进程缓存失效。
2. `io.serverSideEmit('vh-operator-revoked', {grantId})`：另一个 slot 立即清它的 operator 缓存与登记表（不再等 5 s TTL）。
3. 对该 grant 登记表里的终端：
   - `opened` → 服务器以 owner 身份对 owner daemon 发 `kill-terminal`（tmux session 及其中进程结束）；
   - `attached` → 只从登记表删除，停止转发。
   登记行写 `closedAt` 与原因。
4. 给 grantee 发 `operator-revoked {sessionId, reason}`；Web 立即关闭终端/文件面板/btw，清空终端缓冲，然后走原有 `session-share-revoked`/降级流程。
5. 写审计 `session.share.operator.revoked`（含被 kill 的终端数）。

即使 2/3/4 某一步失败（daemon 离线、socket 断），**每帧检查**兜底：broker 的每一次 RPC、每一帧 input 与 output 都查 `resolveOperatorGrant`（进程内缓存 TTL 1 s + 跨 slot 失效广播），失效即丢弃。所以撤销后 operator 最迟 ≤1 s（通常是同一 tick）收不到任何字节、发不出任何按键。daemon 离线时 kill 失败 → 登记表标记 `pendingKill`，daemon 重连（machine socket 连接事件）时补发 kill。

### 5.3 过期

- 读路径已按 `expiresAt` 判（B-701）。另外：服务器在登记 operator 终端时，为该 grant 在本进程挂一个 `setTimeout(expiresAt)`，到点执行 §5.2 全流程；进程重启/slot 切换后在 machine/user socket 连接时重建计时器；每帧检查兜底。
- operator 档**不允许「永久」**：1 / 7 / 30 天，默认 1 天。

### 5.4 登记表

新表 `SessionOperatorTerminal(id, grantId, sessionId, machineId, terminalId, kind: opened|attached, openedAt, closedAt?, closeReason?)`，唯一 `(machineId, terminalId, grantId)`。进程内按 `machineId:terminalId` 缓存（TTL 1 s，revoke 广播即时清）。output 路径只在 `terminalId` 命中时做额外工作，对 owner 自己的终端零开销（Map miss）。

## 6. 审计与可见

### 6.1 审计表

`SessionOperatorEvent(id, sessionId, grantId, actorAccountId, kind, detail jsonb, at)`，保留 90 天（与链接打开记录同一个清理任务）。

| kind | detail |
|---|---|
| `grant.operator` / `grant.operator.removed` | 有效期、谁授予 |
| `terminal.open` / `terminal.attach` / `terminal.close` / `terminal.kill` | terminalId、cwd、关闭原因（自己关 / 撤销 / 过期 / 进程退出） |
| `terminal.input` | **按会话分钟聚合**：输入字节数、回车次数；**不存按键内容**（可能含密码），owner 要看内容就看终端本身（owner 本来就收到全部输出，tmux 回滚也在） |
| `permission` | 工具名、批准/拒绝、是否带 mode |
| `abort` / `steer` / `mode` / `model` / `btw` | 新旧值（btw 不存问题正文） |
| `file.write` / `file.upload` / `bash` | 路径；`bash` 存命令前 200 字符（文件面板的 git 命令） |

同时 `audit()` 写 business audit（与 B-619 同）。

### 6.2 owner 看得到

- 分享面板该行显示「可操作」徽标、到期时间，可展开「操作记录」（最近 100 条）。设置 →「已分享」同样可见。
- 会话头部：operator 在线且打开了终端/文件面板时，owner 看到「Bob 正在操作 · 终端 1」芯片（服务器给 owner 发 ephemeral `operator-activity`），点开即操作记录。
- operator 开的终端：服务器代 owner 发 `set-terminal-tags` 打上 `shared:<handle>` 标签，标题前缀「Bob ·」，**出现在 owner 的终端列表**，owner 可以实时旁观（输出本来就发给 owner）、可以直接关掉。
- 会话 transcript 里**不插系统行**：会话消息流会进 agent 队列/上下文，插入非用户消息有被 agent 读到的风险；审计放在独立表与 UI。

### 6.3 operator 看得到

- 终端顶部常驻一条提示：「你正在 <owner> 的机器上操作 · <到期时间> 到期 · 所有操作会被记录」。

## 7. 链接分享

- 链接分享模型里没有 role，只读投影；本档不进链接 tab。服务器的 share-link 路由不接受任何 role/operate 字段（zod 严格模式拒绝多余字段），operator broker 只认 `SessionGrant`。测试覆盖「持有链接 secret 调 broker → 404」。

## 8. 数据、接口与兼容

### 8.1 数据（纯 expand）

```sql
ALTER TABLE "SessionGrant" ADD COLUMN "operate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionGrant" ADD COLUMN "operateConfirmedAt" TIMESTAMP(3);
CREATE TABLE "SessionOperatorTerminal" (...);   -- §5.4
CREATE TABLE "SessionOperatorEvent" (...);      -- §6.1，INDEX(sessionId, at)、INDEX(at)
```

**不改 `SessionGrantRole` enum**：operator = `role=driver AND operate=true`。理由：
- 旧 Web（`z.enum(['viewer','driver'])` + `schema.parse`）看到的仍是 `driver`，按「可发消息」处理，不报错；满足「旧 Web 按 driver 处理」。
- 回滚到旧 server：旧代码不认识 `operate` 列，operator 自动降级成 driver——**失败方向是收权**，不需要回滚前 SQL。
- 不用 `ALTER TYPE ... ADD VALUE`（不能在事务里回滚，且旧 server 读到未知 enum 值时 Prisma 会抛错）。

约束：`operate=true` 要求 `role='driver'` 且 `expiresAt IS NOT NULL`（服务器校验）；把 role 改成 viewer 自动清 `operate`；旧 Web 上 owner PATCH `role:'driver'` 不改 `operate`。

### 8.2 接口

| 接口 | 变化 |
|---|---|
| `POST /v1/sessions/:id/shares` | 增 `operate?: boolean`、`confirmOperator?: true`；`operate:true` 时必须 `confirmOperator:true`、`role:'driver'`、`expiresInDays ∈ {1,7,30}`，否则 400 |
| `PATCH /v1/sessions/:id/shares/:accountId` | 同上；`operate:false` 即降级（§5） |
| grant 视图 / 会话列表 `share` / pending invite / outgoing | 增 `operate: boolean` |
| `GET /v1/sessions/:id/shares/:accountId/operator-events` | owner；操作记录 |
| socket（user 连接，中央）`operator-rpc`、`operator-terminal-input/resize/close` | §2.2，ack 形状同 `rpc-call` |
| socket 下行 `operator-terminal-output/exit`、`operator-revoked`、`operator-activity`（给 owner） | §2.2/§5/§6 |
| 限频 | broker 用 **grantee 与 owner 两份** account limiter（owner 的终端/RPC 预算不被他人绕开）；终端输入沿用 `terminalRateLimit` |

### 8.3 兼容矩阵

| 组合 | 结果 |
|---|---|
| 新 server + 新 Web + 任意版本 CLI（支持 `encStream`、有机器 DEK） | 全功能；**CLI 零改动** |
| 新 server + 新 Web + 极旧 CLI / legacy 机器 key | 终端入口提示「对方机器的 CLI 需要升级」（`cli_upgrade_required`/`machine_unsupported`）；session RPC 类（审批/打断/文件）照常 |
| 新 server + 旧 Web（grantee） | 看到 `driver`，只能发消息；新增事件被 `safeParse` 丢弃，不报错 |
| 新 server + 旧 Web（owner） | 分享面板显示「可发消息」，看不到 operate；能撤销（撤销清 operate）。只在发布窗口出现 |
| 旧 server + 新 Web | `operate` 被旧 zod 剥除 → 分享成 driver；broker 事件无 ack → Web 超时显示「服务器版本过旧」。回滚窗口才会有 |
| 回滚 | 直接切回旧镜像；operator 全部变 driver（收权）；新表对旧代码不可见；不跑 down migration。再前滚后未过期的 operator 恢复（owner 授予过的），发布说明写明 |

### 8.4 发布顺序

一个 PR：migration + server + Web（同镜像，约束 5）；**CLI 不发版**。发布前设 `VH_RELEASE_MIGRATIONS_REVIEWED=<commit>`。

## 9. UI

- **分享面板（联系人 tab）**：角色从两项变三项：只看 / 可发消息 / **可操作**。默认值不变（现有代码默认是「只看」，`ShareDialog.tsx:57`；任务书说的「默认仍是 Can send」按「不默认 operator」理解，不改现有默认），「可操作」永远不是默认。选「可操作」时：
  1. 显示红色警告块（§1.3 文案）；
  2. 有效期只剩 1 / 7 / 30 天，默认 1 天；
  3. 勾选「我了解对方能以我的身份在这台机器上运行任意命令」后，主按钮才变为「授予可操作权限」；
  4. 点击后再弹一次确认对话框（列出对方账号、机器名、到期时间），确认才提交。
  已有行把 driver 升到「可操作」走同样两步。
- **grantee（operator）会话页**：显示 PermissionCard、打断、mode/model 选择器（选项按 §4 上限置灰）、`/btw`、文件面板（cwd 内）、「终端」按钮（会话头部）。终端用现有 `WebTerminalScreen`，传输层换成 operator 适配器（`sync` 层新增 `operatorTransport`，不改 `WebTerminalScreen` 的主体逻辑）。
- **不给 operator**：归档、改名、再分享、rewind/fork、编辑删除消息、新建会话、机器页。
- 文案（en/zh）：`share.roleOperator` = "Can operate" / 「可操作」；警告、确认、到期、操作记录、CLI 需升级、已撤销断开。

## 10. 测试与验收

- server（pglite 集成 + Fastify inject + 真 socket.io）：
  - broker 越权：viewer/driver/过期/撤销/他人会话/链接 secret 调 broker → 拒绝；白名单外方法拒绝；`terminal.open` 自带 cwd/startupCommand/attachTmux 被改写或拒绝；他人 terminalId input 丢弃；`terminal.list` 不含 owner 其他终端。
  - mode 上限：owner=default 时 operator 切 bypass 拒绝、切 plan 允许；`permission` 带 `mode:'bypassPermissions'` 被剥/拒；`allowTools` 被剥。
  - 撤销：登记的 `opened` 终端收到 `kill-terminal`、`attached` 不 kill；撤销后 output 不再转发、input 丢弃；双 server 实例 + Redis adapter 验跨 slot 广播；过期计时器触发同流程。
  - 加密：operator 收到的终端帧只能用 DEK 解，用机器 key 解失败；审计不含按键内容。
  - 兼容：旧 Web schema 解析新 grant 视图（role=driver）通过。
- Web：operator 适配器单测；`sessionAccess` 新增 `canOperate`；面板三档与二次确认。
- e2e（本地 standalone + 真 CLI daemon 隔离 `HAPPY_HOME_DIR`，两个真实账号，两个 Playwright context）：A 分享给 B「可操作」1 天 → B 开终端执行 `pwd; echo hi` → B 审批一张权限卡 → B 打断一轮 → B 切 mode 到 bypass 被拒 → A 终端列表看到 B 的终端并旁观 → A 撤销 → B 终端 **≤1 s** 断开、A 侧该 tmux 被 kill → 回归 Can send 与只读行为不变；链接 tab 无此档。

## 11. 待 Lead 决策

1. **采用服务器 broker（方案 C）**：operator 不拿机器 key/relay token，CLI 零改动。
2. **shell 不做隔离**，只做诚实警告 + 有效期 + 审计 + 撤销 kill（§1.3）。
3. **mode 不能高于 owner 当前生效值**；`allowTools`（总是允许）不给；model/effort 放开。
4. **operator 必须有有效期**，1/7/30 天，默认 1 天，无永久。
5. **数据模型 `role=driver + operate=true`**，不扩 enum（旧 Web 天然按 driver、回滚自动收权）。
6. **撤销 kill operator 新开的终端**；接入的会话自有终端只断开不 kill。
7. **审计不存终端按键内容**（只存聚合与元数据）；transcript 不插系统行，改用头部芯片 + 操作记录 + 终端标签。
8. operator 的文件面板只到会话 cwd（session RPC），不开放机器级 `fs-*`。

## 12. 实现契约（Lead 11-03 批准后补，Web/server 共用）

Lead 审批补充：明文（params、终端字节、文件内容）不进日志 / metrics / 错误上报，错误只回固定错误码；broker 只在 grant 有效且调用来自 operator 时才解机器 key（测试 + 源码断言）；确认弹窗中英文写全三件事（能读本机所有文件含 Very Happy 账号凭据 / 能以你的身份执行任意命令 / 撤销后对方已启动的后台进程不会自动停）；owner 头部「X 正在操作」芯片醒目，带一键「结束对方的操作」（= `PATCH operate:false`：撤销这一档、断开、kill 对方新开的终端）。

### 12.1 REST

- grant 视图（`SessionGrantView`）、invite（`SharedSessionInvite`）、`/v1/sessions` 行的 `share`、outgoing grant：新增 `operate: boolean`（role 仍是 `viewer|driver`）。
- `POST /v1/sessions/:id/shares`、`PATCH /v1/sessions/:id/shares/:accountId`：body 新增 `operate?: boolean`、`confirmOperator?: true`。错误码：`operator_requires_confirm`、`operator_requires_driver`、`operator_requires_expiry`（400）。
- `GET /v1/sessions/:id/shares/:accountId/operator-events?limit=100` → `{ events: [{ id, kind, actorAccountId, detail, at }] }`（owner）。
- `GET /v1/sessions/:id/operator-activity` → `{ operators: [{ granteeAccountId, displayName, openTerminals, lastActivityAt }] }`（owner；`lastActivityAt` 两分钟内或 `openTerminals>0` 视为「正在操作」）。

### 12.2 socket（grantee 的 user-scoped 连接，中央 server）

- `emitWithAck('operator-rpc', { sessionId, op, params })` → `{ ok: true, result } | { ok: false, error: <code> }`。`params`/`result` 都是 **会话 DEK 加密的 base64**（与 `sessionRPC` 的 `encryptRaw/decryptRaw` 同格式）。
  - `op` 为 session 方法名：`permission`、`abort`、`steer`、`set-permission-mode`、`session-run-intent`、`btw-ask`、`btw-poll`、`btw-cancel`、`readFile`、`writeFile`、`listDirectory`、`getDirectoryTree`、`ripgrep`、`difftastic`、`bash`、`uploadFile`、`uploadFileChunk`、`codex-child-read`；结果与 owner 调该 session RPC 时解密后的对象一致。
  - 终端 `op`：
    - `terminal.open` `{ cols, rows }` → `{ type:'success', terminalId, ...open-terminal 结果 }`（新开，cwd = 会话目录）。
    - `terminal.attach` `{ terminalId, cols, rows, fromSeq?, resub? }` → 同上（只能接入自己开的或会话自有终端）。
    - `terminal.history` `{ terminalId, page }`、`terminal.scroll` `{ terminalId, ... }`、`terminal.paste` `{ terminalId, text }`、`terminal.kill` `{ terminalId }`、`terminal.list` `{}` → `{ terminals: [{ terminalId, kind:'opened'|'attached', openedAt }] }`。
    - 结果里的 `data`/`chunks[].data` 是 **明文 base64 终端字节**（整个 result 已经被 DEK 加密），等价于 owner 侧 `encStream` 解密后的值。
  - 错误码：`not_operator`、`operator_method_denied`、`operator_mode_escalation`、`operator_path_denied`、`operator_terminal_denied`、`operator_terminal_limit`、`cli_upgrade_required`、`machine_unsupported`、`machine_offline`、`rpc_failed`、`rate_limited`、`bad_params`。
- `emit('operator-terminal-input', { sessionId, terminalId, data })`（data = DEK 加密的 base64 字节串）、`emit('operator-terminal-resize', { sessionId, terminalId, cols, rows })`、`emit('operator-terminal-close', { sessionId, terminalId })`（只退订，不 kill）。
- 下行（grantee）：`operator-terminal-output { sessionId, terminalId, seq, data }`（data 同 input 格式）、`operator-terminal-exit { sessionId, terminalId, exitCode }`、`operator-revoked { sessionId, reason: 'revoked'|'downgraded'|'expired'|'deleted'|'archived'|'ended_by_owner' }`。
- 下行（owner）：`operator-activity { sessionId, granteeAccountId, displayName, openTerminals, lastActivityAt }`（独立事件名，旧 Web 的 onAny 自然忽略）。
