# 会话级账号（CLI 侧，B-850a）

> 状态：Final（B-850a）；B-850b（Codex）、B-850d（项目/团队/自动化/fork）见文末各节
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
5. ~~`very-happy sessions read` 不认 `queue-cancel`，被拒消息之后显示 turn running~~ —— B-850d 已修（见文末）。

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

---

# B-850b：Codex 账号（并入 B-847）

> 日期：2026-11-01 ｜ 分支 team/B-850b-codex-accounts（base team/B-850a-accounts）｜ Codex 0.154.0

## 目标

1. **API 供应商账号**（`codex-provider`）：基于 `~/.codex/config.toml` 的 `[model_providers.X]` 或自填 URL；key 来源 file / env / stored，只到达绑定它的会话，Codex 的 shell / MCP / hooks 读不到。取代 B-847「daemon 整体继承 `LLMHUB_API_KEY`」。
2. **ChatGPT 多账号**（`codex-chatgpt`）：每账号一个 CODEX_HOME 覆盖层，远程登录走 app-server device code。
3. 切换 = 原地重启、历史保留、清 sticky model（B-844c/d）；跨类型可切（实测见下）。
   换到模型窗口更小或不同的账号时，Codex 会在第一轮自动 compaction，历史以摘要形式延续（A2 实测：切换后暗号仍答得出）；重启计数与失败回滚同 B-850a（不计入 3 次熔断，失败且旧 wrapper 在跑则回滚绑定）。

## 设计

| | ChatGPT 账号 | API 供应商账号 |
|---|---|---|
| app-server env | `CODEX_HOME=$HAPPY_HOME_DIR/accounts/<id>/codex-home` | 不变（不放任何 key） |
| thread/start\|resume\|fork | `modelProvider:'openai'` | `modelProvider:'vh-<id>'` + `config.model_providers.vh-<id>` = 基础供应商表去掉 `env_key/requires_openai_auth/…` + `auth:{command:<node>, args:['-e', 读文件, <keyPath>]}` |
| key 位置 | 覆盖层里 Codex 自己写的 `auth.json` | file：用户路径；stored：`accounts/<id>/secret`；env：复制到 `tmp/accounts/key-<pid>-<id>`（0600，退出清理）并从 wrapper env 删除 |
| 默认模型 | 绑定的 model > config 的 model（仅当该账号 model/list 有它）> 目录默认 | 绑定的 model > 账号 models[0] > config 的 model |
| 选择器 | Codex `model/list`（该账号的） | 账号 models（目录里有同名的保留其 effort） |

- **覆盖层**（`agentProfiles/codexHome.ts`）：每次 wrapper 启动/登录/检查前重建链接；`auth.json`、`*.sqlite*`、log/tmp/cache、`models_cache.json`、`app-server-daemon` 留在本地，其余（config.toml、sessions、archived_sessions、skills、AGENTS.md、thread-writer-locks…）软链到 wrapper 的 CODEX_HOME。Codex 原子改写过的链接文件改名为 `<name>.overlay-<ts>` 保留后重链。删除账号只删链接，不删共享历史（单测实测）。**从不复制 `~/.codex/auth.json`**（AGENTS #16）。
- **绑定会话的 env**：剥掉 config.toml 所有 `env_key` + `CODEX_API_KEY` + `OPENAI_API_KEY`；未绑定会话不变。
- **不可用**（缺账号/缺 secret/被拒/agent 不符）：同 Claude，拒跑每轮（`queue-cancel failed` + `agent-profile-unavailable` 事件），**跳过 thread/resume**（线程可能记录在只有该账号定义的 `vh-<id>` 上，resume 会报 provider not found 让 wrapper 退出）。
- **切换检测**：上一个 wrapper 写在 server 的 `metadata.agentProfile`（id 或 model）与本次不同 → resume 时显式带新模型，`stickyModel/modelIntent` 置 null。从账号切回本机登录时显式带 config 的 `model_provider`（Codex resume 默认沿用线程记录的 provider）。
- **运行中被拒**：401/refresh token 失效 → 账号记 `expired`（ChatGPT）/`invalid`（API），发 `agent-profile-auth-failed`；切换后若错误像「encrypted content 无法验证」→ 发 `agent-profile-history-rejected`，提示新开会话。
- **daemon**：`spawn` 对 codex 也解析 `agentProfileId`；`bind` 校验账号 agent 与会话 flavor 一致；`state()` 始终带 `kinds`（= `AGENT_PROFILE_KINDS`，含 `codex-chatgpt`/`codex-provider`），有供应商时带 `codexProviders`。Web 以 `kinds` 判断 daemon 能否建 Codex 账号：缺省（B-850a daemon）当作只有 `claude-subscription`/`claude-api`；不能用 `codexProviders` 是否存在判断（config.toml 没配供应商时也缺省）。
- **远程登录**（`codexLogin.ts`）：app-server（CODEX_HOME=覆盖层，剥 OpenAI key）`account/login/start {type:'chatgptDeviceCode'}` → `waiting-code` + `flow:'device-code'` + url + userCode，15 分钟过期；`account/login/completed` → `account/read` 取 email/planType → 建账号（label 默认 email）。新账号失败/取消时删半成品覆盖层；Codex 与 Claude 登录各自互斥。

## wire 增补（v3，已发 Lead 转 A2）

kind `codex-chatgpt` / `codex-provider`；Summary `provider? email? planType?`；State `kinds?`、`codexProviders?`；add 变体 `{agent:'codex', kind:'codex-provider', label, provider?, baseUrl?, wireApi?, models?, key}`；login-start `{agent:'codex', kind:'codex-chatgpt', label?, accountId?}`；LoginStatus `flow?`、`userCode?`；`defaults.codex`；事件 `agent-profile-history-rejected`。只加不改。

## 实测（dev-sg，隔离 HAPPY_HOME_DIR + CODEX_HOME + server :5960 + 假 Responses 端点 :5969；证据 `~/code/github/skills/tmp/vh-team-B-850b/`）

| # | 内容 | 结果 |
|---|---|---|
| X1 | app-server env 带 `env_key`（B-847 现状），假端点让模型跑 `env` | **`exec_command` 输出里有 key** |
| X2 | 同上改为线程级 `model_providers.<id>.auth.command` 读 0600 文件 | 请求带 key；`env` 输出无 key；rollout/sqlite 里没有 key 或路径 |
| X3 | 跨组织 resume：线程在 llm-hub（gpt-5.4-mini，含 encrypted reasoning）→ 直连 OpenAI API → 再回 llm-hub | 三轮都答出暗号；Codex 会把旧 reasoning 一并发给新端点 |
| E1 | VH 双会话：A 绑假账号、B 绑 Hub；daemon env 带 `LLMHUB_API_KEY=<标记>` | 假端点只见 A 的 key；A 的 shell `env` 无标记也无 A 的 key；B 的 `env` 只有 `CODEX_HOME`；app-server 与 codex 二进制的 `/proc/<pid>/environ` 均无两者 |
| E2 | RPC bind：B Hub → 假账号 → Hub（换模型）→ 本机登录 → Hub | 每次 `restart:'done'`（约 4 s）；假端点收到 38 条历史（含 Hub 的 reasoning），模型 fake-model、sticky null；回 Hub 后真实模型答出 CODEWORD-PLUM8；切本机登录 wrapper 正常存活 |
| E3 | A 的 key 文件移走后 bind | metadata `unavailable/missing-secret`；wrapper 存活；消息 `queue-cancel failed` + 事件，端点 0 请求；放回后重绑恢复并答出历史暗号 |
| E4 | ChatGPT 账号（伪造 auth.json）绑定 A | app-server `CODEX_HOME`=覆盖层；基础 home 建的线程在覆盖层里 resume 成功；401 → 账号 `expired` + 事件；基础 home 未生成 auth.json |
| L1 | RPC login-start（codex） | `waiting-code`、`flow:'device-code'`、url `https://auth.openai.com/codex/device`、userCode、expiresAt；submit → invalid-params；第二个 start → login-busy；cancel → canceled 且半成品覆盖层被删；`~/.codex/auth.json` mtime 不变 |
| F1 | `thread/fork` 一个记录在覆盖层专属 provider 上的线程（modelProvider null） | 成功（落到 config 默认 provider），fork 路径无需改 |

**未测**：真实 ChatGPT 后端（dev-sg `~/.codex` 的 ChatGPT 登录 09-25 起失效）——ChatGPT ↔ API 互切是否被 ChatGPT 后端拒绝历史，只能由 X3（跨 OpenAI 组织可用）推断。据此**允许**跨类型切换，被拒时走 `agent-profile-history-rejected` 兜底；Owner 授权一次后按下方步骤复验，若被拒再改为禁止跨类型切换。

## 已知限制

1. 同 uid：agent 可以读 key 文件，也可以读 wrapper 进程的 `/proc/<pid>/environ`（进程**启动时**的 env，删除 `process.env` 不影响它）。所以 `--key-env` 来源与 daemon 级 drop-in 的变量仍可被刻意读取；**推荐 `--key-file`**，并按下节撤掉 daemon 级 drop-in。
2. 每个 ChatGPT 覆盖层有自己的 sqlite（goals、memories、thread 索引）：在 A 账号里设的 thread goal 切到 B 账号后看不到；会话历史本身共享。
3. 覆盖层链接到「本次 wrapper 的 CODEX_HOME」；同一 ChatGPT 账号被两个不同 CODEX_HOME 的会话同时使用会互相改链（罕见）。
4. 用户 `config.toml` 若设 `cli_auth_credentials_store = "keyring"`，auth 不落 `auth.json`，状态会误判为 missing-secret。

## 兼容与发布

- 只发 CLI（wire 增补随 CLI/Web 一起构建）；无 server / 迁移改动。
- 旧 Web：看不到 Codex 账号；Codex 会话 metadata 多出 `agentProfile`，旧 Web 忽略。新 Web（B-850c）对旧 CLI：daemonState 无 Codex 账号 → 只显示本机登录。
- 回滚到旧 CLI：Codex 绑定被忽略，会话回到本机登录（config.toml + daemon env）；**如果此时 drop-in 已撤，Codex 会话会因缺 `LLMHUB_API_KEY` 失败** —— 所以先发版并验收，再撤 drop-in（下节）。

## 撤掉 dev-sg / mac-office 临时注入（PR-D 上线并验收后做，本 PR 不动）

现状：dev-sg `~/.config/systemd/user/very-happy-daemon.service.d/llmhub-env.conf`（EnvironmentFile 指向 `~/.secrets/env/llm-hub.env`）；mac-office `~/.config/very-happy/daemon.env` 里追加了 `LLMHUB_API_KEY`。两台的 `~/.codex/config.toml` 默认 `model_provider = "llmhub"`。

每台机器：
1. 装上含 B-850b 的 CLI 并确认 daemon 版本（按 release skill；dev-sg 用 `systemctl --user restart very-happy-daemon`，mac-office 用 launchd 接管）。
2. 建账号（key 用文件，不用 env）：
   `very-happy account add --agent codex --label "LLM Hub" --provider llmhub --key-file ~/.config/llm-hub/key --model gpt-5.6-sol`（mac-office 没有该文件时先 `install -m600` 一个 key 文件）；`very-happy account test <id>` 应为 ok。
3. 设为 Codex 默认：`very-happy account default <id> --agent codex`（新 Codex 会话从此走账号）。
4. 迁移存量 Codex 会话（没有绑定的那些，撤 drop-in 后会缺 key；已绑别的账号的不动）：
   ```sh
   bound=$(jq -r 'keys[]' ~/.happy/session-accounts.json 2>/dev/null)
   very-happy sessions list --json | jq -r '.sessions[] | select(.flavor=="codex") | .id' | grep -vxF "$bound" \
     | while read s; do very-happy account bind "$s" <id> --no-restart; done
   ```
   （`--no-restart`：下次启动生效，不打断在跑的 turn；要立即生效去掉它。）
5. 验证：新开一个 Codex 会话跑 `env | grep -c LLMHUB`（应为 0）且能正常回复；存量会话之一 `account bind <s> <id>` 后能继续对话。
6. 撤注入：dev-sg 删 `llmhub-env.conf` → `systemctl --user daemon-reload` → `systemctl --user restart very-happy-daemon`（B-505：不杀 wrapper）；mac-office 删 daemon.env 里那一行 → 按 operations Re-adopt launchd。
7. 复验：`tr '\0' '\n' < /proc/$(pgrep -f 'very-happy.*daemon' | head -1)/environ | grep -c LLMHUB_API_KEY` 为 0（mac-office 用 `ps eww`）；第 5 步再跑一遍。
回滚：恢复 drop-in / daemon.env 行并重启 daemon；账号与绑定可留着（无副作用）。

## Owner 配合（真实 ChatGPT 授权一次）

在装了本 PR CLI 的机器（或隔离 HAPPY_HOME_DIR）：
1. `very-happy account login --agent codex --label "ChatGPT B"`，打开打印的链接，登录要用的 ChatGPT 账号，输入打印的 code。终端显示 `Signed in: <id> (…)`；`very-happy account list` 显示 email 和 plan。
2. `very-happy spawn --dir <目录> --agent codex --account <id> --prompt "记住暗号 CODEWORD-MANGO3，只回 ok"` → 正常回复。
3. **跨类型复验**：`very-happy account bind <sessionId> <llm-hub 账号>`，再 `very-happy send --session <sessionId> --prompt "暗号是什么？只回暗号"`；再 `account bind` 回 ChatGPT 账号问一次。两次都答出暗号 = 跨类型可用；出现「无法在新账号上继续」事件 = 被拒，告诉 K2 改为禁止跨类型切换。
4. Web 版（B-850c 上线后）同样流程：添加账号 → ChatGPT → 打开链接输入 code。


---

# B-850d：项目 / 团队 / 自动化 / fork 的账号

> 日期：2026-11-01 ｜ 分支 team/B-850d-account-binding（base team/B-850b-codex-accounts）｜ Owner Q3：自动化和团队拒跑、不回落、进「需要我决策」

## 目标

1. 项目默认账号（每个 agent 一个）、团队成员账号、自动化账号都存 **profileId**（id + label，无 secret）；fork 继承父会话账号（含 B-851 Web fork）。
2. 解析优先级：**显式指定 > 项目默认 > 机器默认 > 本机登录**。
3. 自动化 / 团队这一轮遇到账号缺失、过期、无效 → 拒跑，**不回落本机登录**，「需要我决策」里一条（原因 + 重新登录 / 换账号）。
4. `very-happy sessions read` 认 `queue-cancel`（被拒/未执行的提示词），`--wait` 不再卡到超时。

## 存在哪（server 可见，只有 id + label）

| 位置 | 字段 | 语义 |
|---|---|---|
| 项目 `Project.defaults` | `agentProfiles?: [{ agent, machineId, id: string\|null, label? }]` | 每个 agent 一条；只在该 machineId 生效（账号属于机器）；`id: null` = 本机登录 |
| 自动化 `action`（spawn） | `agentProfile?: { id, label? } \| null` | 缺省 = 未指定 |
| 团队 | `TeamLaunch / TeamDefaults / delegate / TeamBot / TeamOperation .agentProfile?`；action `set-bot-account { botId, agentProfile? }` | 新成员 = delegate 指定 > 团队默认（同 agent 才继承）；`set-bot-account` 只影响该成员**下次** spawn |
| fork | 不存；daemon 读父会话的 `session-accounts.json` 绑定 | |

三态：缺省 = 交给下一级；`null` = 显式本机登录；ref = 该账号。机器默认在 daemon（`accounts.json` defaults），server 不知道。
Ref 不带 agent：自动化 / 团队换了 agent 后旧 Ref 对不上，daemon 报 `agent-profile-unavailable:agent-mismatch`（照常拒跑 + 「需要我决策」）；Web 在表单换 agent 时清空 Ref。
`label` 是选择时的快照，只作兜底展示（账号可能已改名或删除），Web 以该机器 `daemonState.agentProfiles` 里的实时 label 为准。

## 解析（`happy-wire` `resolveLaunchAgentProfile`，daemon / CLI / Web 共用）

`explicit !== undefined` → explicit；否则项目里 `agent` + `machineId` 都匹配的那条；否则 `undefined`（daemon `resolveSpawnAccount`：机器默认，没有则本机登录）。
返回 `{ agentProfileId, source, effective }`：`source` ∈ `explicit | project | machine | machine-login`，`effective` = 实际会用的账号（null = 本机登录）。传入该机器的 `machineDefaults`（daemonState defaults）时才能区分 `machine`（机器默认 · X）与 `machine-login`；不传时一律 `machine`、`effective: undefined`。Web 的「项目默认 · X」「机器默认 · X」和创建前的 Q3 拦截都按它判断。

| 入口 | explicit | 项目默认从哪来 |
|---|---|---|
| Web 新建会话（B-850c，A2） | 会话里选的 | 项目 defaults（Web 自己算，再给 spawn RPC 的 `agentProfileId`） |
| `very-happy spawn` | `--account <id\|machine>` | 仅显式 `--project`（GET 项目 defaults）；拿不到时提示并按机器默认 |
| 自动化 | `action.agentProfile` | server claim 时附 `projectAgentProfiles`（该项目里本机的条目） |
| 团队 | 成员 / delegate / 团队默认 | 团队挂到项目时，项目里**同机器、同 agent** 的账号复制进团队默认（只在团队没设时，同 agent/model 快照语义） |
| fork（CLI `spawn --fork`、Web fork、RPC `parentSessionId`） | spawn 带的 `agentProfileId` | —— 没带则继承父会话绑定；父会话没绑定 = 本机登录（不是机器默认，transcript 和组织保持一致） |

## 拒跑（Q3）

- **daemon 检查点**：`AccountService.resolveSpawnAccount`（缺记录 / agent 不符 / missing-secret / expired / invalid → `agent-profile-unavailable:<reason>: …`），不起任何进程。
- **自动化**：spawn 失败 → run `failed` + `needsAttention` + `attentionReason: 'account_unavailable'`，`error` = `Account unavailable (<reason>): … Not run on the machine login. Fix: sign in again (…) or choose another account for this automation.`。**sticky**：先按同一检查校验本轮账号（action 未指定 = 会话自己的绑定）；不可用 → 同上拒跑、不发、不改绑；账号变了 → `bind` 原地重启切过去（历史保留）再发，重启 `failed` 则 `send_failed` 不发。`send` 动作沿用目标会话自己的绑定；wrapper 拒掉的轮次（`queue-cancel failed` + `agent-profile-unavailable` 事件）由 turn 分析识别，同样记 `account_unavailable`。
  - **Codex sticky 跨类型切换被拒历史**（B-850b `agent-profile-history-rejected` 事件 + 该轮 failed）：本轮记 `account_history_rejected`（error = 事件文案 + 原错误），**不自动重跑**（这一轮可能已有副作用），同时清掉该 sticky 绑定 → 下一轮在新账号上新开会话。选它而不是「当场新开会话重跑」：不悄悄丢上下文、不重复执行，Owner 在「需要我决策」里看到原因。
- **团队**：worker 在**准备 worktree 之前**检查；不可用 → `fail-operation`（确定失败，非 unknown），`error` 以 `agent-profile-unavailable:<reason>:` 开头 + 处理方式；receipt 回 `prepared` 且不安排自动重试（必然再被拒），等 Owner「重试启动」。server `applyTeamTransitionsTx` 对这类失败在 **lead 会话**写一条 attention：source `team`、kind `blocked`、key `team-account:<operationId>`、标题「成员 X 的账号「Org A」登录已过期，这一轮没有启动 · 团队名」、正文写重新登录 / 换账号 / 重试启动；Owner 重试（`retryRequestedAt` 变化）或启动成功 → resolved；重试后再被拒（新 `failedAt`）→ 同 key 重开。lead 会话不存在时不写（团队页仍显示 op 错误）。
- 均需 `VH_OWNER_BOARD_ENABLED`（attention 条目）；自动化的 `needsAttention` 不依赖它。

## sessions read（`sessions/turnState.ts`）

`LogEntry` 带 `localId`（v3 messages 本来就返回）。锚点提示词之后出现 `queue-cancel` 且 `targetLocalKeys` 含它的 localId → `ended: true`，`status` = reason 为 `failed` 时 `failed`，其他（cleared/aborted/restarted/网页取消）`cancelled`；`error` = `Not executed[: <agent-profile-unavailable 事件文案>]`；`turn.discarded = <reason>`、`turn.refusal = 'agent-profile-unavailable'`（只加不改）。之后又出现 `turn-start`（B-679 replay）则重新算 running；被丢弃提示词之后到达的上一轮 `turn-end` 不算它的。

## wire 增补（v4，已发 Lead 转 A2；只加不改）

`AgentProfileRef(Schema)`、`AgentProfileChoiceSchema`、`ProjectAgentProfile(Schema)`、`resolveLaunchAgentProfile`、`projectAgentProfilesFor`、`agentProfileUnavailableReason`、`AGENT_PROFILE_FEATURE_LAUNCH = 'launch-accounts'`；`AgentProfilesState.features?`；`ProjectDefaults.agentProfiles?`；`AutomationAction(spawn).agentProfile?`；`AutomationClaimedRun.projectAgentProfiles?`；团队如上 + `TeamOperation.failedAt?`；`TurnState.discarded? / refusal?`（`'agent-profile-unavailable' | 'agent-profile-history-rejected'`，CLI 内部）；`LaunchAgentProfile.effective`、source `'machine-login'`；attentionReason `account_unavailable` / `account_history_rejected`。无新 RPC。MCP `team_delegate` 多一个可选 `agentProfile`；`very-happy auto create/edit --account <id|machine>`。

## 兼容矩阵与发布顺序

| | 旧 server（无本 PR） | 新 server |
|---|---|---|
| 旧 daemon（B-850a/b 或更老） | 不变 | 字段存着但 daemon 忽略（zod 剥掉）：自动化/团队按**机器默认，再无则本机登录**跑（现状）；fork 按机器默认。daemonState 无 `features: ['launch-accounts']` → **Web 在账号选择旁提示「这台电脑的 CLI 需升级，账号选择不会生效」** |
| 新 daemon | server 剥掉 action/team 字段 → 同上现状；claim 无 `projectAgentProfiles`；`set-bot-account` 回 invalid action | 全功能 |

- 旧 Web：忽略新字段；拒跑的自动化 run 显示 `account_unavailable` 原始 reason + error 文本；团队 attention 条目照常显示（标题/正文是中文成品）。
- 发布：server/Web 与 CLI 各自独立可发、顺序任意；建议先 server/Web（B-850c 表单一起）再发 CLI。无迁移（全部是 Json 列内字段）。
- 回滚 CLI：回到「忽略字段」行为（上表第一行）。回滚 server：字段被剥掉，已存的 Json 留在库里，重新部署后恢复。

## 实测（dev-sg，隔离 HAPPY_HOME_DIR + standalone server :5960 + 假 Anthropic 端点 :5969；两个 API 账号 Org A / Org B，key 分别 `…AAAAAA` / `…BBBBBB`；证据 `~/code/github/skills/tmp/vh-team-B-850d/`）

| # | 内容 | 结果 |
|---|---|---|
| D1 | 项目 defaults.agentProfiles = claude→Org A（本机），`spawn --project <id>`（无 --account） | metadata.agentProfile = Org A；端点只见 key A；回复 `done AAAAAA` |
| D2 | 团队：lead 加入后 delegate MemberA(Org A)、MemberB(Org B) | 两个 op 带各自 agentProfile；成员 metadata 分别 Org A / Org B，回复分别 `done AAAAAA` / `done BBBBBB` |
| D3 | 自动化一次性（`--at`，Org A）；sticky（Org B）跑两次 → `auto edit --account org-a` 再跑 | 一次性 done/AAAAAA；sticky 前两轮同一会话 BBBBBB，第三轮同一会话原地切到 Org A（hostPid 变，历史 3 轮都在），AAAAAA |
| D4 | fork：Org B 会话 `spawn --fork`；RPC `spawn-happy-session {parentSessionId}`（Web fork 路径）；同 + `agentProfileId: null` | 前两者 Org B；第三个 `agentProfile: null`（显式覆盖） |
| D5 | Org B 的 key 文件移走：自动化（新 spawn）、sticky 改回 Org B、团队 delegate MemberC(Org B) | 自动化两条 `failed ! account_unavailable`，error 写明原因与处理；端点 **0 请求**；sticky 会话绑定仍是 Org A（未改绑、未发）；团队 op `failed`（非 unknown），lead 会话出现 `team-account:<op>` blocked/open/needsOwner 条目，正文含重新登录 / 换账号 / 重试启动 |
| D6 | key 放回 → Owner retry-operation | MemberC 启动且为 Org B；条目 `resolved` |
| D7 | 会话绑到缺 key 的 Org B 后 `send` 一条，`sessions read --wait --timeout 120` | **1 s** 返回 `latest turn: ended (failed) — Not executed: Account "Org B" is unavailable…`；`--json` 含 `discarded:'failed'`、`refusal:'agent-profile-unavailable'`（修前：一直 running 到超时，单测 mutation 证明） |

## 已知限制

1. 团队成员在线时改账号（`set-bot-account`）只影响下次 spawn；要立即生效 Web 另调 `agent-profile-bind`（原地重启）。
2. CLI `spawn` 只对显式 `--project` 用项目默认；继承自调用会话的项目（lineage）不算「指定项目」。
3. 项目默认按 machineId 精确匹配：项目在另一台机器上新建会话 = 无项目默认（Web 在创建前显示「本机登录（<机器> 没有『组织 A』）」，DESIGN F7）。
4. 已在运行的团队成员 / send 目标会话，账号中途失效时由 wrapper 逐轮拒跑（B-850a），团队侧不另发「需要我决策」（只有 spawn 被拒才发）。
