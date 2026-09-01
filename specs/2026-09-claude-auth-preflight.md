# Claude 认证预检、诊断与修复（daemon 上下文即真理源）

> 状态：Shipped（commit `050e9e4c`，PR #136；Web `main@050e9e4c` + CLI v0.2.97，2026-09-02）。真机验证项已转 `docs/verify-queue.md` V-111 / V-112
> 日期：2026-09-02 ｜ 关联 backlog：B-275（放大器，已修）、B-276（本 spec）、B-277（web 端 relogin，后续）｜ 出处：2026-09-01 mac-office `OAuth session expired and could not be refreshed` 事故

## 背景

2026-09-01 mac-office 上所有 daemon 血统的 Claude Code 进程（SDK 会话、titleGenerator、board analyzer、jojo-agent）报 `Failed to authenticate: OAuth session expired and could not be refreshed`，ssh 与（部分）web 终端里的 `claude` 用同一份 `~/.claude/.credentials.json` 正常。

**受控复现（2026-09-02 00:00，mac-office）**：
- 用临时 LaunchAgent（gui/501，env 仅 PATH+HOME）跑 `claude -p --debug` → exit 1、`duration_api_ms:0`、debug log `[Bootstrap] Skipped: no usable OAuth`、`OAuth refresh token is no longer valid`；同上下文 `security find-generic-password -s 'Claude Code-credentials' -a jojo -w` 返回 248 字节：`{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…,"subscriptionType":"enterprise","rateLimitTier":"default_claude_zero"}}`（7/31 残留），`claude auth status` → `loggedIn:false`。
- 同一时刻在 web 终端（tmux）里同命令 exit 0；该 shell 下 `security … -w` exit 36（`errSecInteractionNotAllowed`）→ Claude Code 回落文件。
- 在 LaunchAgent 上下文备份并删除该项后：同上下文 `auth status` → `loggedIn:true, max`，one-shot ok；`very-happy spawn` 经真实 daemon 起的新会话回复 ok（删除前同一命令失败）。
- 结论：**Claude Code 在 darwin 上 keychain 优先于文件；两处存储可以分叉；哪一处被读到取决于进程上下文能否无交互访问 keychain**。reviewer 从 SDK 二进制反查证实（2.1.252，复合存储 `I(keychain, plaintext)`）：`read` = keychain 非 null 即用（含空 token 项）；`security` exit 0 空输出/36/44 → null → 回落文件；`update` = 先 `keychain.read()` 记 `s`，写 keychain 成功且 `s === null` 时**删除明文文件**。Claude Code 自己用 `security show-keychain-info` exit 36 判「本上下文无交互访问」。为什么某些 tmux 血统读不到 keychain（exit 36）**机制未定性**（reviewer 实测另一些 tmux server 是当前 daemon 直系、带 `XPC_SERVICE_NAME`），spec 不依赖这一机制，只依赖「daemon 自身进程里探测到什么」。

放大器：Claude Code 按进程缓存刷新失败判定，remote 路径把后续消息喂进同一长活 SDK Query → 一次失败 = 会话永久死（B-275，PR #130 已修；其 backlog 行与代码注释里「网络抖动/23:41 自愈」的早期叙事是错的，随本 spec 一并订正）。

## 目标

1. **不变量**：daemon 进程上下文里 SDK 会 spawn 的那个 `claude` 二进制 `auth status` 为登录态 ⇔ very-happy remote 会话能用；这个状态在 web 机器级可见，从 ok 翻坏后 ≤30s 可见（daemon 在线且 server 未限流时）。
2. 已知坏形态给出确定诊断；其中唯一无歧义的一种（keychain 项存在且 token 全空、文件里有 token、daemon 上下文判未登录）可从 web 经确认后一键修复。
3. daemon 血统可观测（不改变 handover 行为）。
4. 新/老 web × 新/老 CLI 四象限不出错、不误报；server 不改。
5. 给 Owner 一个**确定的存储选择**（D8）：让 very-happy 起的 Claude Code 与 Owner 登录用的终端读同一处存储，而不是靠进程血统碰运气。

## 非目标

- 不改 Claude Code 存储逻辑；不注入 `CLAUDE_CODE_OAUTH_TOKEN` / `apiKeyHelper` / 独立 `CLAUDE_CONFIG_DIR`。
- 不自动重试、不自动 relogin；除 D4 的确认式删除外不改用户凭据存储。
- 不做 web 端 `claude auth login`（B-277，另出 spec；本 spec 预留 RPC 命名空间 `claude-auth-login-*`）。
- 不改 handover 拓扑、不调用任何 `launchctl` 写操作（见 D5 与被否方案）。
- 不做 Codex/Gemini 同类预检；不改 server。

## 现状事实（代码已确认；行号以本分支 `8e13d717` 为准）

| 事实 | 位置 |
|---|---|
| machine metadata 在模块级常量构造，`getOrCreateMachine` 对已存在机器**不覆盖** metadata；周期探测先例 `cliAvailability`/`resumeSupport`（20s，变化才 `updateMachineMetadata`） | `packages/happy-cli/src/daemon/run.ts:61-71`；`packages/happy-server/sources/app/state/accountStateStore.ts:182-183`；`packages/happy-cli/src/api/apiMachine.ts:1066-1102` |
| **web 改机器名会整体重写 metadata**：`machineUpdateMetadata(id, {...machine.metadata, displayName})`，而 `machine.metadata` 来自 `safeParse` 已剥离未知字段 → 老/新 web 一次改名就抹掉任何 metadata 新字段 | `packages/happy-web-v2/src/screens/machine/MachineScreen.tsx:92`；`src/sync/encryption/machineEncryption.ts:47`；`src/sync/ops.ts:1044` |
| daemonState 由 daemon 独占写、web 只读且不 zod（`any`）；**跨 daemon 重启持久**：`POST /v1/machines` 对已存在机器返回 existing（含旧 daemonState），连接时 `...currentState` 合并重写，`initialDaemonState` 只在机器首次创建时生效 → 老 CLI 会把新 CLI 写过的字段原样带下去；已有动态字段先例 `cliUpdate`（`cliUpdatePushChain` 串行 CAS，连接时重发），`terminalPushChain` 并发写同一 state，handler 每次从最新 state 合并、字段不互抹 | `packages/happy-cli/src/api/types.ts:229-`；`packages/happy-cli/src/update/cliUpdate.ts:13-20`；`apiMachine.ts:167,274-280,788-806,844,929-940`；`api.ts:211-213`；`accountStateStore.ts:182-183`；`packages/happy-web-v2/src/sync/storageTypes.ts:256`、`src/sync/encryption/machineEncryption.ts:73-90` |
| `updateMachineMetadata`/`updateDaemonState` 只处理 success / version-mismatch，`result:'error'`（含 server 240 units/min 限额）被静默吞掉 | `apiMachine.ts:826-836,854-864`；`packages/happy-server/sources/app/api/socket/machineUpdateHandler.ts`（`isAccountResourceLimitError`）；`accountStateStore.ts:66-74` |
| server 把 metadata/daemonState 当加密不透明串，不解析 | `packages/happy-server/prisma/schema.prisma:313` |
| daemon 未知 RPC method 返回**正常加密响应** `{error:'Method not found'}`；多数 ops 封装把 `{error}` 当成功（B-003） | `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts:66-70`；`docs/backlog.md` B-003 |
| wrapper→daemon 已有本地 HTTP 控制面：`daemonPost` 读 `daemon.state.json` 的 `httpPort`+`controlToken`，非 2xx 返回 `{error}` 不抛；发射器 `notifyDaemonSessionEvent` 只在 `session.reportEventToDaemon` 里被调用且以 `HAPPY_SPAWNED_BY` 为门（普通会话从不 POST）；daemon 侧 `/session-event` `event` 是 `z.enum(['completed','needs_input'])`，直接进 `onSessionStateEvent → decideAssistantReport`（类型只有这两个值） | `packages/happy-cli/src/daemon/controlClient.ts:18-63,134-140`；`src/claude/session.ts:222-227`；`controlServer.ts:113-128`；`run.ts:1242-1291`；`src/daemon/assistantReport.ts:26,98-101`；`persistence.ts:123-128` |
| daemon 启动已用 `resolveClaudeCredentialReadiness` 写 `claudeCredentialSource`（识别 Bedrock/Vertex/Foundry/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/apiKeyHelper/本地文件；**故意不探 keychain**） | `packages/happy-cli/src/ui/doctorReadiness.ts:44-80`；`run.ts:1321-1331` |
| remote 路径 SDK 用 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`，经 `createRequire(import.meta.url).resolve` 解析，找不到直接 throw、**不回落 PATH**；happy-cli 未传 `pathToClaudeCodeExecutable`；SDK 默认 env `{...process.env}` 并注入 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`（happy 经 `resolveHappyEntrypoint` 覆盖，默认 `remote_mobile`，用户已设的值保留） | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`（`Native CLI binary for … not found`）；实测进程树 |
| `getClaudeCliPath()` 找不到时 **`process.exit(1)`**，try/catch 挡不住（titleGenerator 同有此隐患） | `packages/happy-cli/scripts/claude_version_utils.cjs:503-518`；`src/claude/utils/titleGenerator.ts:39-52` |
| wrapper env = daemon `...process.env` + extraEnv；handover 子 daemon 未传 env → 继承老 daemon 全部 env（含 `XPC_SERVICE_NAME`） | `run.ts:739-742,1505` |
| launchd 直系 daemon 带 `XPC_SERVICE_NAME=com.mereith.happy-daemon`，但 daemon 所有子进程（wrapper、tmux、handover 子 daemon、`ensureDaemonRunning` 拉起的 daemon）都继承它 → 该 env **不充分** | 实测；`src/daemon/ensureDaemonRunning.ts:33` |
| launchd job 顶层是 `node /opt/homebrew/bin/very-happy daemon start-sync`（bin wrapper `execFileSync` 再起子进程才是 daemon）；脚本自带「pid 活且版本相同则 exit 0」与「版本不一致接管」；「2026-08-24 `kickstart -k` 只杀顶层、daemon 变孤儿」记录在 mac-office 实际使用的 skills 仓库副本脚本注释里（repo 内 `ops/mac-office/happy-daemon-launch.sh` 没有这段，两份已漂移） | `ops/mac-office/happy-daemon-launch.sh:25-37`、`ops/mac-office/install-launch-agent.sh`；`/Users/jojo/code/github/skills/skills/personal-systems/references/happy/deploy/mac-office/`（plist 实际指向的副本）；`packages/happy-cli/src/daemon/mac/install.ts` 是上游死代码（`docs/operations.md:236-238`） |
| `security` 退出码：44 = `errSecItemNotFound`，36 = `errSecInteractionNotAllowed` | 实测 |
| `claude auth status`（2.1.252，无需 flag）输出：`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"…","email":"…","orgId":"…","orgName":"…","subscriptionType":"max"}`；未登录：`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty",…}`。API-key/Bedrock 模式输出形态**未实测** | 实测 |
| B-275 判定点在 `onReady` **之后**：`claudeRemote.ts:304` 先 `opts.onReady(result)` → launcher `applyClaudeResultLifecycle` 只看 `subtype`（认证失败帧是 `subtype:'success', is_error:true`）→ `closeCompleted + onCompleted` → `onTurnEnd` + `sendSessionNotification({kind:'done'})`；然后 310-317 才发 `onCompletionEvent(QUERY_RECYCLE_NOTICE)` → `sendSessionEvent({type:'message', message})`。web 的 session event schema 是 `agentEventSchema`（`message` 变体为普通 `z.object`，未知字段被剥离）；CLI 侧 `sendSessionEvent` 是联合类型 | `claudeRemote.ts:304-317`；`claudeRemoteLauncher.ts:515-547`；`src/claude/utils/remoteResultLifecycle.ts:12-19`；`packages/happy-web-v2/src/sync/typesRaw.ts:20-26`；`src/api/apiSession.ts:877-885` |
| 通知：`terminalNotify.ts` → `POST /v1/webhook/notify`，server `event: z.enum(['completed','permission'])`；账号级错误 feed 走 `session.onSessionError → notificationProducer.error` | `packages/happy-cli/src/…/terminalNotify.ts:179-202`；`packages/happy-server/…/pushRoutes.ts:316`；`claudeRemoteLauncher.ts:531,572`；`session.ts:231-233`；`notificationProducer.ts:128-134` |
| **keychain 身份规则（2.1.252 二进制）**：service = `` `Claude Code${OAUTH_FILE_SUFFIX}-credentials${suffix}` ``，`suffix = '-' + sha256(NFC(configDir)).hex.slice(0,8)`（仅当 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 或 `CLAUDE_CONFIG_DIR` 设置），`OAUTH_FILE_SUFFIX` 生产为空、设 `CLAUDE_CODE_OAUTH_CLIENT_ID` 时为 `-custom-oauth`；account = `process.env.USER \|\| os.userInfo().username`，不匹配 `/^[a-zA-Z0-9._-]+$/` 时为 `claude-code-user`；文件 = `(CLAUDE_SECURESTORAGE_CONFIG_DIR \|\| CLAUDE_CONFIG_DIR \|\| ~/.claude)/.credentials.json` | reviewer 反查 `claude-agent-sdk-darwin-arm64/claude` |
| **Claude Code 调 `security` 全是裸名走 PATH**（execFile/execa 无 shell，或 `shell:true` 的字符串命令），无 `/usr/bin/security` 绝对路径（唯一绝对路径出现在 eval 沙箱排除清单）；无原生 Security.framework 分支；无禁用 keychain 的官方 env（仅 `CLAUDE_SECURESTORAGE_CONFIG_DIR`、`KEYCHAIN_PREFETCH_FASTPATH_BUDGET_MS`、`CLAUDE_CODE_FORCE_WINDOWS_CREDMAN`）。读 `T()`：exit 0 有输出→解析；0/36/44→null→回落文件；其它→`READ_FAILED`（用缓存）。**常规写路径是 `security -i`，子命令 `add-generic-password -U -a … -s … -X <hex>` 从 stdin 喂入**（payload ≤4032B），超长才用 argv；写失败非瞬态→写明文且不删明文。启动预取 `PEn()` 不看退出码 | reviewer 反查二进制（偏移 @154936502、@154935601、@155308015、@155315587） |
| `sessionProtocolMapper` 已把 result `is_error:true` 映射为 turn-end `status:'failed'`（error = errors > pendingAssistantError > subtype），且 `onMessage` 早于 lifecycle；lifecycle 随后的 `closeClaudeSessionTurn('completed')` 因 `currentTurnId` 已空而 no-op → D6(a) 只改变推送种类与 `turn-ended` 事件参数 | `src/claude/utils/sessionProtocolMapper.ts:504-506,898-905`；`claudeRemote.ts:229`；`apiSession.ts:814`；web `reducer.ts:496-501` |
| 铁律 14：存量 wrapper 不随 daemon 升级 | `AGENTS.md` |

## 设计

### D1 机器级预检（daemon 进程内）

- 新增 `packages/happy-cli/src/daemon/claudeAuthProbe.ts`：纯函数 `classifyAuthStatus(stdout, exitCode, timedOut)` + `resolveSdkClaudeBinary()` + 一个可注入的 spawn 适配层。
- **二进制**：与 SDK 同一解析：`createRequire(sdkEntry).resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude')`（跟随 SDK 的 platform/arch 命名）。解析失败 → `status:'claude-missing', diagnosis:'sdk-binary-missing'`，**不回落 PATH、不调用 `getClaudeCliPath()`**（它会 `process.exit(1)`）。`detail` 可用不 exit 的 `findGlobalClaudeCliPath()` 补一句「PATH 里有 claude x.y.z 但 SDK 二进制缺失」。
- **命令**：`<bin> auth status`；env = daemon `process.env`（与 wrapper 一致；不设 `CLAUDE_CODE_ENTRYPOINT`；D8 `file` 模式下叠加 shim PATH，与 wrapper 同样处理）；cwd = `<happyHomeDir>/tmp/auth-probe/`（空目录，避免加载某个项目的 settings/hook）；`stdio:['ignore','pipe','pipe']`；超时 8s；输出上限 64KB。
- **前置**：daemon 启动时已算出的 `claudeCredentialSource`。若 source ∉ {`'Claude local credentials'`, undefined} → 记 `authMethod = source`，**永不跑 D2**，status 只看 `auth status` 是否解析出 `loggedIn:true`；解析不出或 `loggedIn:false` → `status:'unknown'`（不是 `not-logged-in`），避免对 Bedrock/API-key 模式误报。D2 只在 `status === 'not-logged-in'`（或 RPC 显式要求）时运行。
- **触发**：启动后 2s；每 10 min；RPC `claude-auth-probe`；D3 失败信号后去抖 1s。in-flight 合并。
- **判定**（先解析 stdout JSON，退出码只作兜底）：二进制缺失 → `claude-missing`；超时 → `status:'error', diagnosis:'probe-timeout'`；stdout 解析出 `loggedIn:true` → `ok`；解析出 `loggedIn:false`（无论退出码）→ `not-logged-in`；解析不出 JSON → `status:'error', diagnosis:'probe-crash'`（附退出码到 detail）。
- **落点：daemonState**（不是 metadata）。理由：web 改名会重写 metadata 并剥离未知字段（现状事实第 2 行）；daemonState 是 daemon 独占、web 不 zod、已有 `cliUpdate` 先例与串行 push chain。**daemonState 跨重启持久**（现状事实第 3 行）→ 回滚后旧 `claudeAuth` 会被老 CLI 原样带下去，所以字段带 `daemonPid`，web 只信任 `claudeAuth.daemonPid === daemonState.pid`（`pid` 每次 connect 重写；不用 `checkedAt >= startedAt`，reconnect 会 restamp `startedAt` 造成假灰显）。

```ts
// DaemonStateSchema 新增（optional）
claudeAuth?: {
  probeVersion: 1,
  daemonPid: number,             // = process.pid；web 信任门：=== daemonState.pid（每次 connect 重写）
  status: 'ok' | 'not-logged-in' | 'unknown' | 'error' | 'claude-missing',
  authMethod?: string,          // claude.ai / console / none / 或 claudeCredentialSource
  subscriptionType?: string,
  diagnosis?: 'keychain-empty-item' | 'store-divergence' | 'no-credentials'
            | 'sdk-binary-missing' | 'probe-timeout' | 'probe-crash',
  detail?: string,              // ≤200 字符，人话，不含 token/邮箱/路径
  repairable?: 'delete-empty-keychain-item',   // 仅当 D4 前置全部满足
  context: { platform: string, lineage: 'launchd' | 'inherited-env' | 'other',
             credentialStore: 'auto' | 'file' },   // D8 机器级设置的生效值
  checkedAt: number,
}
```

- **写入策略**：挂到 `cliUpdatePushChain` 串行；比较时**排除 `checkedAt`**，状态/诊断/repairable 变化时立即写，否则每 30 min 刷一次 `checkedAt`（web 用它判过期）。`updateDaemonState` 返回 `result:'error'` 时 `logger.warn` 并置 `dirty=true`，下一次探测无条件重发（修补现状事实第 4 行的静默吞错）。
- 不写日志、不写 state 任何 token 值；D2 比较只用长度与 sha256 尾 6 位。

### D2 诊断器（仅 darwin；仅 `status === 'not-logged-in'` 或 RPC 显式要求时运行）

0. D8 `credentialStore === 'file'` 时 **整体跳过 D2**（keychain 与 very-happy 无关，`diagnosis` 只可能是 `no-credentials`），不靠 shim 推导。
0'. `keychainIdentity(env)`：精确镜像现状事实表「keychain 身份规则」（service 后缀哈希、`OAUTH_FILE_SUFFIX`、account 规则、文件目录三选一），pin 2.1.252，单测锁定；D2/D4 共用同一次计算结果。
1. 先 `security show-keychain-info`（Claude Code 自己的探针；tmux 里实证 exit 36，ssh 未实证——实现时在 ssh 里核一次，若 ssh 下不是 36 则去掉这一步只用步骤 2）：exit 36 → `keychain: unreadable`，不再碰具体项。否则 `security find-generic-password -s <service> -a <account> -w`，超时 3s。exit 0 → 解析 JSON（空输出 = absent）；**44 → absent；36 → unreadable；ENOENT（非 darwin）→ 跳过；其它 → error**。
2. 文件：`<identity.configDir>/.credentials.json` 存在且可 parse → `file.hasTokens`（accessToken 与 refreshToken 都非空）+ refreshToken 尾哈希。
3. 形态：
   - keychain present ∧ 两 token 为空 ∧ file.hasTokens ∧ status=not-logged-in → `keychain-empty-item`，`repairable='delete-empty-keychain-item'`。
   - keychain present ∧ 有 token ∧ file.hasTokens ∧ 尾哈希不同 → `store-divergence`（只告警：「两处凭据已分叉，某一处会在下次刷新失效；以 daemon 上下文登录为准」）。
   - keychain absent/unreadable ∧ ¬file.hasTokens → `no-credentials`。
   - 其余（含 keychain unreadable 且文件有 token 却 not-logged-in）→ 无 diagnosis，`detail` 写「daemon 上下文读不到 keychain 且文件凭据未被接受，请在机器上 `claude auth status` 对照」。
4. 非 darwin：只可能 `no-credentials`。

### D3 失败信号（wrapper → daemon，复用控制面）

- `controlServer` `/session-event` 的 `event` enum 增加 `'auth_failed'`，**在 controlServer 层分流**：`auth_failed` → 新回调 `onClaudeAuthFailed(sessionId)`，不进 `onSessionStateEvent → decideAssistantReport`（其类型只有 completed/needs_input，混入会把认证失败当「等待输入」送进助手会话）。
- wrapper 侧新增 `notifyDaemonClaudeAuthFailed(sessionId)`，直接走 `daemonPost('/session-event', {sessionId, event:'auth_failed'})`，**绕过** `session.reportEventToDaemon` 的 `HAPPY_SPAWNED_BY` 门（普通会话也要发）。fire-and-forget；老 daemon 返回 400，`daemonPost` 对非 2xx 返回 `{error}` 不抛。daemon 收到 → 去抖 1s 触发 D1（+D2）。
- 不引入文件 watch（`startFileWatcher.ts:24-38` 有 ENOENT 空转先例）。
- 老 wrapper 不会发信号 → 10 min 周期兜底（铁律 14 既定代价）。

### D4 RPC

- `claude-auth-probe` `{}` → 强制 D1+D2，返回 `{ claudeAuth }`。
- `claude-auth-repair` `{ action:'delete-empty-keychain-item' }`：
  - 重新跑 D2；**前置**：diagnosis 仍为 `keychain-empty-item`（三条件：keychain 项 token 全空、文件有 token、daemon 上下文 not-logged-in），且删除前再 `-w` 读一次、内容与诊断时看到的一致，否则 `{error:'precondition-failed', claudeAuth}`。
  - 备份：写 `<happyHomeDir>/backups/claude-keychain-<ts>.json`（0600）。前置保证该项 token 为空，备份不含秘密；仍限 7 天清理。
  - `security delete-generic-password -s <identity.service> -a <identity.account>`（与 D2 同一次 `keychainIdentity` 结果；超时 3s）。
  - 立即重跑 D1，返回 `{ ok:true, claudeAuth }`。
  - **已确认的后果（必须写进确认弹窗）**：删除后 daemon 上下文回落到文件；GUI 上下文下一次 token 刷新会把新 token 写进 keychain 并**删除 `.credentials.json`**（二进制 `update` 逻辑），此后本机 ssh/tmux 里的 `claude` 读不到 keychain 也没有文件 → 需重新登录。这不是 bug，是 Claude Code 的单店迁移语义。若 Owner 不接受，用 D8 `credentialStore:'file'` 代替本修复。
- 新 web 的 RPC 封装**必须**检查返回体 `error` 字段（老 daemon 对未知 method 返回加密的 `{error:'Method not found'}`，见 B-003），显示为「此机器的 CLI 版本不支持」。
- 预留 `claude-auth-login-*`（B-277）。

### D5 血统可观测（不改行为）

- `context.lineage`：`'launchd'` = `XPC_SERVICE_NAME` 匹配 label **且** `launchctl print gui/<uid>/<label>` 解析出的 `pid =` 是本进程祖先（沿 `ps -o ppid=` 上溯，≤10 层）；`'inherited-env'` = env 匹配但祖先不含该 pid；`'other'` = 其它。非 darwin 固定 `'other'`。
- **不改 handover**：不调用 `launchctl kickstart`（2026-08-24 已证只杀 job 顶层、daemon 孤儿），不在 daemon 里做任何 launchd 写操作。血统稳定化（若要做）另出 spec，候选是 launch 脚本已有的「版本不一致接管」+ 顶层 wrapper 退出码透传，需先验证 `bin/very-happy.mjs` 是否透传非零退出码与 `ThrottleInterval` 空窗。
- `index.ts` 的 `start` 分支（非 `start-sync`）在 darwin 且 LaunchAgent 已安装时打印一行提示（不改变行为）。

### D6 B-275 turn 生命周期订正 + 事件结构化（改 PR #130 范围）

- 现状：认证失败帧 `subtype:'success', is_error:true` 被 `applyClaudeResultLifecycle` 当成 completed → `closeClaudeSessionTurn('completed')` + `done` 推送，再叠加 B-275 事件，语义打架。
- 改法（选 a）：`applyClaudeResultLifecycle` 把 `result.is_error === true` 也视为 failed，error 文本顺序与 `sessionProtocolMapper` 对齐：`errors > pendingAssistantError > result.result > subtype`（卡片与推送显示同一文本；mapper 已把该 turn 标 failed，lifecycle 的 completed 关闭本就 no-op，因此不会双 turn-end） → `closeFailed + onFailed → session.onSessionError`（账号级错误 feed 自然触发，**不**在 recycle 点再调 `onSessionError`）。影响面：所有 `is_error:true` 的 turn（rate limit、max turns、其它 API 错误）从「完成 + done 推送」变为「失败 + 错误推送」——这是对的语义；`turn-ended` 事件参数随之变 failed，实现 agent 要核 boardAnalyzer 的 turn-end tap 对 failed 的处理并补测试。
- 每条后续失败 turn 一条错误推送：用户主动发消息才触发，有界，**接受**（不做 1h 去重）。
- B-275 事件加结构化字段：`sendSessionEvent({type:'message', message, kind:'claude-auth-failed'})`。CLI 侧 `apiSession.ts:877-885` 联合类型加可选 `kind`；web `agentEventSchema` 的 `message` 变体加 `kind: z.string().optional()`（老 web 剥离该字段、只显示文本）。`kind` 与现有字段无冲突（`sendSessionNotification` 的 `kind` 是另一对象）。
- **不**走 `/v1/webhook/notify`（enum 只有 completed/permission，需改 server）。

### D7 Web（新 web）

- 数据源：`machine.daemonState.claudeAuth`（`any`，web 端新增 zod `safeParse`，失败视为缺失）；**信任门**：`claudeAuth.probeVersion >= 1 && claudeAuth.daemonPid === daemonState.pid`，否则视为缺失（覆盖 CLI 回滚残留）。
- 机器卡片徽章：`ok` → `Claude · <subscriptionType>`；`not-logged-in`/`error`/`claude-missing` → 红 chip + `detail`；`unknown`（Bedrock/API-key 等）→ 中性 `Claude · <authMethod>`，不是坏态；`checkedAt` 超 60 min（2× 刷新周期，避免边界闪烁）→ 灰显「状态可能过期」。
- MachineScreen「Claude 登录状态」区：诊断文案、「重新检测」（`claude-auth-probe`）、仅当 `repairable==='delete-empty-keychain-item'` 时显示「备份并删除空 keychain 项」→ 确认弹窗（说明将执行的 `security delete-generic-password` 与备份路径）→ `claude-auth-repair` → 用返回的 `claudeAuth` 刷新。
- 会话内：event `kind==='claude-auth-failed'` 时附「查看机器登录状态」链接（无 kind 的老 wrapper 事件不处理）。
- 全部 UI 以上述信任门为门；缺失 = 老 CLI/回滚 = 不渲染（不显示「未知」）。
- MachineScreen 新增 D8 的 `credentialStore` 选择（auto/file），附一行解释与当前生效值。
- `cliAvailability.claude`（PATH）与 `claudeAuth.status='claude-missing'`（SDK 二进制）冲突时，Claude 会话相关 UI 以 `claudeAuth` 为准。

### D8 存储钉死（机器级设置 `claudeCredentialStore: 'auto' | 'file'`，默认 `auto`）

- 动机：M1 证明「删空项」只是把分叉推迟到下一次刷新；同一台 Mac 上 GUI 血统（keychain）与 ssh/tmux 血统（文件）用旋转的 refresh token 注定互相打掉。真正稳定的只有「所有消费者读同一处」。Owner 在 mac-office 的登录方式是 ssh/web 终端（文件），所以要有办法让 very-happy 起的 Claude Code **也只用文件**。
- 机制（第 3 轮 review 已从二进制核实）：Claude Code 读写凭据全部经 PATH 调裸名 `security`；读到 exit 36/44 → 回落文件；写失败非瞬态 → 写明文且不删明文。`file` 模式下 daemon 在 **spawn wrapper 的 env**（`run.ts:502` `extraEnv`）与 **D1 探测 env** 里把 `PATH` 前置 `<happyLibDir>/scripts/shims/keychain-off/`（**必须在 `scripts/` 下**：`packages/happy-cli/package.json` 的 `files` 只发布 `dist`/`bin`/`scripts`/`tools/licenses`，放别处会在 monorepo 测试全绿、npm 包里缺失 → PATH 前置空目录 → `file` 模式静默无效）。daemon 启用 `file` 前 `statSync` 该脚本存在且可执行，缺失则生效值回落 `auto` 并写 `detail`；铁律 2 的发版冒烟加 `ls scripts/shims/keychain-off/security`。`#!/bin/bash`，不依赖 zsh，`chmod +x` 进 git。其中 `security` 脚本的语义**只针对 Claude Code 自己的 keychain 项**：
  - argv 形态：子命令 ∈ {`find-generic-password`,`add-generic-password`,`delete-generic-password`} 且 `-s` 的值以 `Claude Code` 开头（覆盖 `-credentials`、`-custom-oauth-credentials`、`-<hash>` 后缀）→ `exit 36`（stderr 文案无关，Claude 不解析）；`show-keychain-info` → `exit 36`；其余 → `exec /usr/bin/security "$@"`。
  - **`-i` 交互形态（Claude 的常规写路径）**：读完 stdin，若首条命令匹配 `^(add|find|delete)-generic-password\b` 且其 `-s` 值（stdin 命令行里带双引号，argv 形态不带；两种都要归一）以 `Claude Code` 开头 → `exit 36`；否则把 stdin 原样喂给 `exec /usr/bin/security -i`。**漏掉这一形态 = GUI 上下文写 keychain 成功 + 复合 update 看到 keychain 读为 null → 删除 `.credentials.json`**（M1 灾难路径在 `file` 模式下静默发生），所以验收必须覆盖 `-i` + stdin。
  - 退出码必须精确 36 或 44；其它退出码会被判 `READ_FAILED`（用缓存/瞬态）而不是回落文件。
  - 真实 `security` 路径可用 env `HAPPY_SECURITY_BIN` 覆盖（默认 `/usr/bin/security`），单测用它指向记录 argv/stdin 的假脚本，避免测试误写 CI/开发机的 login keychain。
- 效果：SDK Query / titleGenerator / boardAnalyzer（都在 wrapper 进程内，继承 wrapper env）与 D1 探测只用 `.credentials.json`，与 ssh 终端一致。用户在自己终端跑 `very-happy claude`（本地模式，不经 daemon）**不加 shim**，与该终端里的 `claude` 血统一致。daemon 自身 PATH、web 终端（tmux）、用户 shell 不动。
- 泄漏面：wrapper env 会被 Claude 的 Bash tool、hooks、`very-happy mcp` 子进程继承，所以 shim **必须**按 `-s` 值过滤，用户/agent 在会话里对自己服务的 `security find-generic-password -s <其它服务>` 原样透传；走 Security.framework 的工具（`git credential-osxkeychain` 等）不受影响。
- 启动预取 `PEn()` 在 shim 下得到 null，只影响启动提示，无功能影响。
- `auto` = 现状（不改 PATH）。设置存 `~/.happy/settings.json`（机器级，与 `boardLlm` 同类），RPC `claude-auth-set-store` 修改，改后立即重跑 D1；`claudeAuth.context.credentialStore` 回显生效值。
- 与 D4 的关系：`file` 模式下 D2 整体跳过、`repairable` 永不出现、D4 不可用（此时 keychain 与 very-happy 无关）。
- 非 darwin：设置不显示、无效。
- 若未来 Claude Code 改为绝对路径/原生 keychain/提供官方开关：shim 失效但无副作用（进程照常读 keychain），D1 会把结果显示出来；届时改用官方开关。

### 被否方案

- `CLAUDE_CODE_OAUTH_TOKEN` 注入（静态 8h、scope 降级 `user:inference`、无刷新）；`apiKeyHelper`（API-key 模式）；独立 `CLAUDE_CONFIG_DIR`（丢 projects/skills）。
- `claudeAuth` 放 machine metadata（web 改名即抹掉）。
- 文件信号 + `fs.watch`（已有控制面；ENOENT 空转先例）。
- daemon 内 `launchctl kickstart -k`（杀顶层留孤儿；`XPC_SERVICE_NAME` 假阳性会触发）。
- 自动删除 keychain 项（改用户凭据存储必须确认）。
- 回落 PATH `claude` 探测（SDK 二进制缺失时假阴性；`getClaudeCliPath` 会 exit）。

## 兼容矩阵与发布顺序

| | 老 web | 新 web |
|---|---|---|
| 老 CLI | 无变化 | daemonState 无 `claudeAuth` → 不渲染、不调 RPC；若调到（不会有按钮）→ 封装识别 `{error}` 显示「CLI 版本不支持」 |
| 新 CLI | daemonState 是 `any`，多一个字段无感；B-275 事件多出 `kind` 字段被老 web 的 `z.object` 剥离，文本照旧显示 | 完整功能 |

- 老 wrapper + 新 daemon：wrapper 不发 `auth_failed`、不带 `kind`；10 min 周期兜底。
- 新 wrapper + 老 daemon：`/session-event auth_failed` → 400，wrapper 忽略。
- server：不改。CLI 与 web 互不依赖，任意顺序；建议先 CLI。
- 回滚：daemonState 跨重启持久，老 CLI 会把 `claudeAuth` 原样带下去；新 web 靠 `claudeAuth.daemonPid !== daemonState.pid` 门自动不渲染。
- 非 darwin：D2 keychain 分支 no-op，`repairable` 永不出现，UI 无修复按钮；D8 设置不显示。
- D8 `file` 模式 + 老 wrapper：老 wrapper 是 daemon 升级前 spawn 的，env 里没有 shim，仍读 keychain（铁律 14）；新建/重开会话后生效。

## 风险

1. `claude auth status` 输出随版本变化 → 解析失败归 `error/probe-crash`，不影响会话；单测锁本 spec 给出的两份样例。API-key/Bedrock 模式输出未实测 → 以 `claudeCredentialSource` 前置分流到 `unknown`，不误报。
2. 每 10 min spawn 一次 claude（~1s CPU）→ 接受；in-flight 合并。
3. GUI 上下文 `security` 可能弹授权框 → 3s 超时；只在非 ok 时才碰 keychain。
4. `store-divergence` 靠 refreshToken 尾哈希，可能漏判 → 只告警，接受。
5. **已确认**：删除空项后 GUI 血统下一次刷新会写 keychain 并删除 `.credentials.json` → ssh/tmux 需重新登录（D4 弹窗写明；推荐 D8）。verify 项改为「观察 `.credentials.json` 是否被删、ssh `claude auth status` 是否变 false」。
6. server 限流丢更新 → `dirty` 重发；「≤30s 可见」以 server 未限流为前提，写明。
7. 备份文件：前置保证无 token；0600 + 7 天清理。
8. `lineage` 判定要跑 `launchctl print` + `ps` 上溯（每次探测 ≤ 数十 ms）→ 只在启动与 RPC 时算，周期探测复用。
9. 「tmux 血统读不到 keychain」机制未定性 → spec 不依赖它；D8 用 shim 把这件事变成确定的。
10. D8 shim 依赖 Claude Code 经 PATH 调用 `security`（已从二进制核实）；Claude Code 改为绝对路径或引入官方开关时，shim 失效但无副作用（进程照常读 keychain），D1 会把结果显示出来。
11. D6 把 `is_error:true` 改判 failed 会改变其它 API 错误 turn 的状态与推送 → 实现前盘点来源，补测试；这是语义修正不是回归。

## 验收标准

- [ ] 单测 `claudeAuthProbe`：两份 `auth status` 样例、非 JSON、超时、ENOENT、`claudeCredentialSource` 非本地文件 → `unknown` 五类分支；`resolveSdkClaudeBinary` 缺失 → `claude-missing`（不调用 `getClaudeCliPath`）。
- [ ] 单测 `keychainIdentity(env)`：默认 / `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CODE_OAUTH_CLIENT_ID` / `USER` 非法字符五组，与 2.1.252 规则一致。
- [ ] 单测诊断器：（条件项，若 ssh 实证保留该步）`show-keychain-info` 36 短路；security exit 0(空)/0(JSON)/36/44/其它 × 文件有无 token 的组合表，`keychain-empty-item` 仅在三条件同时满足时出现。
- [ ] 单测 `applyClaudeResultLifecycle`：`is_error:true` → failed，error 文本顺序 errors > pendingAssistantError > result.result > subtype（与 mapper 一致）；失败 turn 不再走 `onCompleted`（无 `reportEventToDaemon('completed')`、无 `inputNeeded`），确认失败路径也经过 `session.ts:148` 的 turn 起始重置（避免下一 turn 的 `replyDone` 带过期 snippet）；boardAnalyzer 的 `turn-ended` tap 对 `failed` 有测试。
- [ ] 单测 controlServer 分流：`auth_failed` 不进 `onSessionStateEvent`；wrapper 发射不受 `HAPPY_SPAWNED_BY` 门限制。
- [ ] 单测 D8 shim（真实执行脚本，`HAPPY_SECURITY_BIN` 指向记录 argv/stdin 的假脚本，绝不碰真 keychain）：argv 形态 `find/add/delete-generic-password -s 'Claude Code-credentials'`、`-s 'Claude Code-credentials-ab12cd34'`、`-s 'Claude Code-custom-oauth-credentials'` → exit 36；`-s 'other-service'` → 透传；`show-keychain-info` → 36；**`-i` + stdin `add-generic-password -U -a jojo -s "Claude Code-credentials" -X 00`** → 36 且假脚本未被调用；`-i` + stdin 其它服务 → 透传；`list-keychains` → 透传。注入点在 daemon→wrapper `extraEnv` 与探测 env，本地模式 `very-happy claude` 的 env 不含 shim。
- [ ] 单测 `claude-auth-repair`：前置不满足时拒绝且不调用 delete；满足时先备份再删除再重探。
- [ ] 单测 controlServer：`/session-event auth_failed` 触发去抖探测；老 enum 值不受影响。
- [ ] 单测 daemonState 写入：挂 `cliUpdatePushChain`、从 handler 入参 `current` 合并（不用闭包旧 state）；`checkedAt` 变化不触发写；status 变化触发；`result:'error'` 后下次强制重发且 dirty 优先于 30 min 节流；`daemonPid` 正确。
- [ ] 单测 D8 设置：持久化到 `~/.happy/settings.json`；RPC `claude-auth-set-store` 改后立即重探；`context.credentialStore` 回显生效值；shim 脚本缺失时回落 `auto` 并写 `detail`；`file` 模式下 D2 跳过。
- [ ] 单测 D5：`lineage` 三值（launchd / inherited-env / other）与 `launchctl print` 无 `pid =` 行时的处理。
- [ ] web 单测：`agentEventSchema` message 变体接受可选 `kind`，`kind==='claude-auth-failed'` 渲染链接、无 kind 不渲染；`checkedAt` 超 60 min 灰显。
- [ ] web 单测：`daemonPid !== daemonState.pid` 视为缺失。
- [ ] web 单测：`claudeAuth` 缺失/`probeVersion` 缺失不渲染；RPC 返回 `{error}` 显示不支持提示；`repairable` 缺失无修复按钮。
- [ ] 四象限手测（新/老 web × 新/老 CLI）无报错、老 CLI 不显示任何 Claude 登录 UI。
- [ ] backlog 登记 B-276（本 spec）、B-277（web relogin）、titleGenerator `getClaudeCliPath` exit 隐患（debt）；订正 B-275 行叙事。
- [ ] 门禁全绿（AGENTS.md）。

## 留真机验证项

- mac-office：本次已删空项，观察 `.credentials.json` 是否在下一次刷新后被删、ssh 下 `claude auth status` 是否变 false（预期会）；若 Owner 选 D8 `file`，验证 SDK 会话与 ssh 终端共用文件且互不打掉。
- mac-office：daemon 上下文 `lineage` 显示值与实际启动方式一致（launchd 拉起 vs ssh handover）。
