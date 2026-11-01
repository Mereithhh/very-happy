# 会话级账号（CLI 侧，B-850a）

> 状态：Final
> 日期：2026-11-01 ｜ 关联 backlog：B-850（本文 = PR-C / B-850a；Web = B-850c，Codex = B-850b，团队/自动化 = B-850d）｜ 前身：B-794 provider 绑定（本文取代其注入方式）
> 设计依据：`~/code/github/skills/tmp/vh-team-B-849-850/DESIGN.md`（A2）、`FEASIBILITY.md`（K2）；Owner 拍板 Q1–Q4 按推荐（project decision #22）

## 背景

同一台机器上，不同会话要用不同的 Claude 凭据：另一个组织的订阅、Console API key、LLM Hub 等兼容端点。B-794 只做了「API URL + key」一种，而且把 key 放进 `ANTHROPIC_AUTH_TOKEN`，会话里的 Bash 工具、hooks、stdio MCP 全都能读到（本文 §实测 S1）。

## 目标

1. 机器本地账号存储，兼容读取 B-794 的 `providers.json` / `session-providers.json`。
2. 两类 Claude 账号：订阅（`claude setup-token`，`CLAUDE_CODE_OAUTH_TOKEN`）、API（`apiKeyHelper`）。修掉 B-794 的 key 泄漏。
3. `very-happy account add/list/login/test/rename/rm/default/bind`，`very-happy spawn --account`。
4. 上报 `daemonState.agentProfiles`、`metadata.agentProfile`；Web 用的机器 RPC（含远程登录）。
5. 账号不可用时不回落到本机登录（Q3）。

## 非目标

- Codex / pi / Gemini 账号（B-850b、PR-G）；每账号一个 `CLAUDE_CONFIG_DIR`（Q4 不做）。
- Web UI（B-850c）；项目 / 团队 / 自动化 / fork 存 profileId 与「需要我决策」（B-850d）。
- 撤掉 dev-sg daemon 级 `LLMHUB_API_KEY` drop-in（等 B-850b 上线后）。
- 防同 uid 恶意 agent 读账号文件（需 sandbox deny-read，后续）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| Claude SDK 子进程 env = 拷贝 wrapper 的 `process.env` | `happy-cli/src/claude/sdk/query.ts` `env` 组装段 |
| wrapper 已为每个 Claude 进程生成 `--settings` 文件（SDK、本地终端、prewarm） | `claude/utils/generateHookSettings.ts`；`claudeLocal.ts` `--settings` |
| /btw 旁路 fork 用自己的 settings 文件 | `claude/registerSideQuestionHandler.ts` `writeSideQuestionSettingsFile` |
| 标题生成、看板分析走 `claude -p` one-shot，settings 写死 `{"disableAllHooks":true}` | `claude/utils/titleGenerator.ts` `runClaudeOneShot` |
| daemon 用自身 env + 本次 spawn 的 extraEnv 起 wrapper，会话之间不共享 env | `daemon/run.ts` spawnSession |
| 原地重启 = stop → resume 同一 transcript | `daemon/run.ts` `restartSessionImpl` |
| 失效 tombstone：`queue-cancel` + reason，Web 显示「未执行」可放回 | `api/apiSession.ts` `sendQueueCancelReason`；B-854 |

## 设计

### 存储（`agentProfiles/store.ts`）

```
$HAPPY_HOME_DIR/accounts.json          { version: 2, accounts: { <id>: AccountRecord }, defaults: { claude?: id } }  0600，无 secret
$HAPPY_HOME_DIR/accounts/<id>/secret   粘贴的 key / setup-token  0600，目录 0700
$HAPPY_HOME_DIR/session-accounts.json  { <sessionId>: { account: id | null, model? } }  0600
```

- `AccountRecord`：`label / agent:'claude' / kind:'claude-subscription'|'claude-api' / createdAt / baseUrl? / models? / contextWindows? / key?: {source:'file',path}|{source:'env',name}|{source:'stored'} / expiresAt? / check?: {status, at, detail?}`。
- v1 兼容（只读，不改写 v1 文件）：`providers.json` 每个 profile 列为 `legacy: true` 的 `claude-api` 账号（同 id 时 v2 优先）；`session-providers.json` 的绑定只对 v2 文件里没出现的会话生效；v2 的 `{account: null}` 表示显式回到本机登录（遮住 v1 绑定）。
- 状态：缺 secret > 已过期（`expiresAt`）> 上次检查结果 > `unverified`。检查 = 一次 1-token 真实请求（API：HTTP；订阅：`claude -p`，hooks 关、无 MCP、不落 transcript）。401/403 是确定结论（订阅 → expired，API → invalid），其他失败只记 `unverified` + 原因。

### 注入（`agentProfiles/claudeAccountEnv.ts`、`wrapperAccount.ts`）

wrapper 拿到 session id 后、起任何 Claude 子进程前解析一次绑定，改**自己**的 env：

| kind | env | settings（并入 wrapper 写的每个 `--settings`） |
|---|---|---|
| 订阅 | 剥掉全部继承凭据/路由变量，设 `CLAUDE_CODE_OAUTH_TOKEN` | — |
| API | 剥掉同上；`ANTHROPIC_BASE_URL`、各模型槽固定到绑定模型（B-794b 语义）、`CLAUDE_CODE_OAUTH_TOKEN=vh-account-unavailable` 占位 | `apiKeyHelper = "<node>" -e "…readFileSync(argv[1])…" "<keyPath>"` |
| 不可用（缺账号/缺 secret/过期/被拒） | 剥掉同上，`CLAUDE_CODE_OAUTH_TOKEN=vh-account-unavailable` | — |

- `--key-env` 的值复制到 `$HAPPY_HOME_DIR/tmp/accounts/key-<pid>-<id>`（0600，退出清理），并从会话 env 删除该变量。
- API 账号的占位 token：`apiKeyHelper` 优先级高于 `CLAUDE_CODE_OAUTH_TOKEN`（实测 S3），主会话不受影响；任何没带 helper 的 `claude` 只会发占位符拿 401，**不会回落到本机登录把本机 token 发给账号端点**（实测 S2 抓到过这个问题，见下）。
- 「每个 `--settings`」= SDK/本地终端（hook settings）、prewarm（tag hook settings）、/btw fork、one-shot（标题生成、看板分析，`oneShotArgs(accountClaudeSettings())`）。
- 不可用时：启动即发事件行（`kind: 'agent-profile-unavailable'`）；每条消息 `queue-cancel reason=failed` + 事件行，不启动 Claude；不 prewarm。会话不崩溃、不归档。
- 运行中 401（`onAuthFailure`）：有账号时记到该账号 `check`（订阅 expired / API invalid），daemon 文件监听重发布；发 `kind: 'agent-profile-auth-failed'` 事件，不触发本机 claudeAuth 重探测。
- 用户 `~/.claude/settings.json` 里的 `apiKeyHelper`（订阅时）或 `env.ANTHROPIC_*` 会盖过账号：启动时发一条 `agent-profile-warning` 事件。

### daemon（`agentProfiles/accountService.ts`、`agentProfileRpc.ts`、`daemonAccounts.ts`）

- spawn：Claude 会话按 `agentProfileId`（undefined → 机器默认；null → 本机登录）解析；账号不存在/不可用 → spawn 失败 `agent-profile-unavailable:<reason>`。合法结果经 `VH_AGENT_PROFILE_ID` 交给新 wrapper，wrapper 只在该会话尚无绑定时记录（重连不改绑），随即从 env 删除。`--env` 不能伪造这个变量。
- 绑定账号的会话不再收到 `HAPPY_CLAUDE_AUTH_STATUS`（本机登录的结论与它无关）。
- 发布：connect 快照带 `agentProfiles`（存在 + `daemonPid === pid` 即能力）；RPC 写入后、`accounts.json` / `providers.json` 文件变更（5 s 轮询）、每小时（过期推进）重发布。
- 远程登录：daemon 用 node-pty（1000 列，防 URL 折行）跑 `claude setup-token`，env 剥凭据、`BROWSER=true`；解析授权 URL → 等 code（10 分钟）→ 写入 code → 输出里匹配 `sk-ant-oat01-…` 存为账号 secret（有效期记 1 年）。一台机器同时只允许一个登录。token 不进任何状态/日志。

### wire（`happy-wire/src/agentProfiles.ts`）

- 会话能力 `agent-profile-v1`；机器能力 = `daemonState.agentProfiles`（受信条件 `daemonPid === pid`）。
- `daemonState.agentProfiles = { daemonPid, updatedAt, accounts: Summary[], defaults }`；Summary 只含 id/label/agent/kind/status/statusDetail/checkedAt/createdAt/expiresAt/baseUrl/models/keySource/keyRef/legacy。
- `metadata.agentProfile`：缺 = 旧 wrapper；`null` = 本机登录；`{id,label,kind,status:'active'|'unavailable',reason?,model?}`。
- RPC：`agent-profile-list/add/login-start/login-submit/login-status/login-cancel/test/rename/remove/set-default/bind`；失败一律 resolve `{error, code}`。`bind` 结果 `restart: 'done'|'skipped'|'pending'|'failed'`（`pending` = 22 s 内未完成，仍在进行；Web 显示「重启中」，等 `metadata.agentProfile` 变成新账号即完成——A2 已按此实现）。
- 切换账号触发的原地重启（RPC `bind` / `remove --force`、本地 `account bind` / `session provider` 走的 `/restart-session`）**不计入**防崩溃循环的「每会话 3 次」熔断，单独计数、上限 50（`DEFAULT_MAX_ACCOUNT_RESTARTS`，daemon 生命周期内）；A2 实测第 4 次 bind 撞 `restart-limit` 即此问题。重启失败时：旧 wrapper 仍在跑（如撞上限）→ **回滚绑定**，结果 `{bound:false, rolledBack:true, restart:'failed', error}`（只加：`bound` 由字面量 `true` 放宽为 boolean）；旧 wrapper 已停、新的没起来 → 保留新绑定（没有进程在用旧凭据，下次启动即新账号）。不会出现「绑定已写入、实际还跑旧账号」。
- `remove` 带 `force` 且有绑定会话时：删记录与 secret 后**立即原地重启**这些会话（并行，单个 22 s 预算），它们回来即 `unavailable` 拒跑，不会继续用已删的凭据跑到下次启动；结果多一个 `restarts: {sessionId: 'done'|'skipped'|'pending'|'failed'}`（只加不改）。
- `very-happy account list` 读**运行中 daemon** 的状态（控制端口 `/agent-profiles`，即 daemonState 同一份），`--key-env` 的变量按 daemon 环境判定；daemon 没跑时退回本地计算，并提示 env 型 key 是按当前 shell 判定的。
- spawn RPC 新参数 `agentProfileId?: string|null`。
- 所有枚举字段是开放字符串，读端白名单（`readAgentProfileStatus`、`readSessionAgentProfile`）。

## 实测（Claude Code 2.1.304 / SDK 2.1.306，dev-sg，隔离 HAPPY_HOME_DIR + 本地 server :5960 + 假 Anthropic 端点 :5969）

| # | 内容 | 结果 |
|---|---|---|
| S1 | 同一 fake 端点下，凭据放 `CLAUDE_CODE_OAUTH_TOKEN` / apiKeyHelper / `ANTHROPIC_AUTH_TOKEN`，看 SessionStart/UserPromptSubmit/Stop hook、stdio MCP、Bash 工具的 env | 前两者三处都读不到；`ANTHROPIC_AUTH_TOKEN`（B-794 现状）三处都读得到 |
| S2 | VH 会话绑 API 账号（fake 端点），项目级 hooks + stdio MCP + Bash 探针 | 修前：标题生成 one-shot 继承了 `ANTHROPIC_BASE_URL` 却没带 helper，用**本机 OAuth 登录**向账号端点发了请求（本机真实 token 外泄到账号端点）。修后：15 次请求全部只带账号 key；hooks/MCP/Bash 均读不到账号 key |
| S3 | helper + 占位 `CLAUDE_CODE_OAUTH_TOKEN` 同时存在；只有占位、无 helper | 前者发 helper 的 key；后者只发占位符，401 |
| E1 | 两个会话同时在线：A 绑 LLM Hub（v2，真实 deepseek），B 绑 fake 账号 | fake 端点只见 B 的 key；A 的 Bash/hooks/MCP 读不到 hub key，B 的读不到 B 的 key |
| E2 | v1 `providers.json` 的 llmhub（kimi-k3）建会话说暗号 → RPC `agent-profile-bind` 切到 v2「Hub DeepSeek」 | 3.6 s 返回 `restart:'done'`；新 wrapper metadata.agentProfile 为新账号；问暗号答出 ZEBRA-42（历史保留） |
| E3 | 会话切到已过期订阅账号后发消息 | metadata `unavailable/expired`；启动事件 + 该消息 `queue-cancel failed` + 事件，Claude 未启动 |
| E4 | `spawn --account <过期账号>` | 失败：`agent-profile-unavailable:expired` |
| E5 | 设机器默认账号后 spawn 不带 `--account`；`--account machine` | 前者绑默认账号；后者 `agentProfile: null` |
| L1 | RPC 远程登录：start → submit 假 code → 轮询 status | `waiting-code`（拿到 claude.com/cai/oauth/authorize URL）→ `exchanging` → `failed: OAuth error: Request failed with status code 400`；第二个 start 得 `login-busy`；pty 已回收 |
| L2 | CLI 改账号后看 daemonState | 文件监听 5 s 内重发布，无 secret 字段 |

未测：真实 setup-token 换出 token 的那一步（需 Owner 浏览器授权，见下「Owner 配合」）；订阅账号真实对话（同上）。

## 兼容矩阵与发布顺序

| | 旧 Web | 新 Web（B-850c） |
|---|---|---|
| 旧 CLI | 不变 | 无 `daemonState.agentProfiles` → 只显示本机登录 + 升级提示；`agent-profile-*` 回 Method not found |
| 新 CLI | 忽略新字段；绑定只能用 CLI 改 | 全功能 |

- B-794 现有绑定在升级后继续生效（v1 文件只读兼容），注入方式自动换成 apiKeyHelper。
- 只发 CLI；无 server / 迁移改动。发布顺序任意。回滚到旧 CLI：v2 绑定被忽略，这些会话回到本机登录或 v1 绑定（旧 CLI 行为）。

## 风险

1. 同 uid 的 agent 仍能 `cat` 账号文件 —— 文案不过度承诺，后续 sandbox deny-read。
2. Claude Code 未来改变对 `CLAUDE_CODE_OAUTH_TOKEN` 的子进程清理 —— S1 的探针脚本可复跑；升级 Claude 版本时复验。
3. setup-token 的 Ink 输出格式变化导致 URL/token 解析失败 —— 失败会明确回 `failed`；兜底是 `very-happy account login --token-stdin`。
4. 一次误判的 401 会把账号标成 expired/invalid、让绑定会话拒跑 —— 由用户 `account test` / 重新登录恢复；拒跑优于串号（Q3）。
5. `very-happy sessions read` 不认 `queue-cancel`，被拒消息之后显示 turn running —— 自动化场景由 B-850d 处理。

## 验收标准

- [x] wire 契约先行（team_message 给 Lead）
- [x] v2 存储 + v1 只读兼容，单测覆盖
- [x] 订阅 / API 注入；B-794 泄漏修复，hooks/MCP/Bash 实测
- [x] 双会话不串号、切换保留历史、不可用拒跑（实测）
- [x] `very-happy account …`、`spawn --account`、`session provider` 别名
- [x] RPC + daemonState 上报 + metadata 上报（实测）
- [x] 远程登录走到「起流程 → 拿到 URL → 提交 code」
- [ ] Owner 真实授权一次（下）

## Owner 配合（真实登录一次）

在 dev-sg 装上含本 PR 的 CLI 后（或任意隔离 HAPPY_HOME_DIR）：

1. 终端执行 `very-happy account login --label "组织 B"`，复制打印出的链接。
2. 浏览器打开，选要用的组织，点 Authorize；页面显示一段 code。
3. 把 code 粘回终端，回车 → 看到 `Signed in: <id> (组织 B)`。
4. `very-happy account test <id>` 应为 `ok`；`very-happy spawn --dir <目录> --account <id> --prompt "say hi"` 能正常回复。

Web 版同样流程在 B-850c 上线后验收。

## 留真机验证项

- 订阅账号真实授权 + 一轮真实对话（Owner 浏览器）。
- mac-office（launchd）上 node-pty 跑 setup-token 的输出解析。
