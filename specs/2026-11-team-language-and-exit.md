# 团队会话的语言约束与「退出团队模式」

> 状态：Final
> 日期：2026-11-03 ｜ 关联 backlog：B-877

## 背景

用户 Xu CHEN 反馈：11-01「团队模式中间 thinking 切换成英文的比例好像比较高」；11-03「team 模式下会改成英文回答的概率高。和负责人的会话还能从 team 模式恢复为普通模式吗？我想对比看看」。

## 目标

1. 用户用中文（或日文、韩文）提问时，团队里 Lead 和成员的回复英文比例降到与普通会话相当，并用对照实验量化。
2. Lead 会话可以「退出团队模式」：保留历史，继续作为普通会话使用，之后不再注入团队内容、不再收团队消息；团队本身按现有归档逻辑处理。Web 和 CLI 都有入口。

## 非目标

- 不翻译 TEAM_SKILL / Lead playbook 全文（协议文本只保留一份英文，避免两份漂移）。
- 成员会话不能单独退出团队；它们随团队归档按现有逻辑停止。
- Claude 的 thinking：Very Happy 不请求 thinking 展示（`streamRelay.ts`：API 默认只给空 thinking），界面上看不到 Claude 的 thinking。实验里用 `display: 'summarized'` 取到的摘要，在普通会话里也是约 97% 英文，所以不是团队模式造成的，这次不处理。

## 现状事实（代码已确认）

团队模式比普通会话多注入的内容如下。team_* 工具本身在所有会话里都会注册（`claude/utils/startHappyServer.ts` `registerTeamsTools`），不算差异。

| 注入 | 语言 | 位置 / 时机 |
|---|---|---|
| TEAM_SKILL + 角色说明 + Lead playbook（Lead）/ 成员规则（成员）+ 工作目录 + `## Assigned goal` | 英文约 7 KB（Lead）/ 4.5 KB（成员），只有目标是用户原话 | 首条 **user 消息**（`daemon/teams/initialPrompt.ts`，`worker.ts` 用 `sendUserMessage` 发出） |
| 项目首轮前缀：团队变体 TEAM_LEAD / TEAM_MEMBER | 英文 | 拼在首条 user 消息前面（`projects/prompt.ts` `buildFirstTurnPrefix`） |
| 团队消息信封 `[Very Happy team message …; from X]` + 结尾 footer | 英文 | 每条团队消息都作为一个 user 回合送达（`worker.ts` deliver） |
| server 写的消息正文：`Task X submitted:`、`Revision requested`、`New task`、空闲升级、排队提示、清理失败、容量告警 | 英文（容量告警附一句中文） | 包在信封里（`server/app/teams/reducer.ts`、`teamIdle.ts`、`compaction.ts`） |
| 简报板 digest `[Briefing board] …` 两行 | 英文 | Lead 每个回合 prompt 前面（`attention/leadBoard.ts` `decorate`） |
| schedule 提醒正文 | 用户自己写的 | 包在信封里（`server/app/teams/schedules.ts`） |
| `team_create` 接入说明（TEAM_SKILL + playbook） | 英文 | 作为 user 消息发给接入的会话（`teams/adopt.ts`） |
| 工具返回（team_inspect 等）的 JSON 与 hint | 英文 | tool_result |

根因：Lead 会话首轮「用户」消息约 96% 是英文，用户原话只占约 100 个字符；之后每个团队回合也都是英文信封，里面常常装着英文的系统通知或英文提交。模型据此把对话语言判断成英文。普通会话里没有这些内容。

Q2 现状：Web 建的团队，Lead bot 的 `managed=true`。归档时 root 任务被取消，`cleanup()` 给 Lead 发 stop op，daemon 停掉并归档 Lead 会话（`reducer.ts` archive，`worker.ts` stop 分支）。用户手动恢复后，B-730 的 relaunch 会按 `metadata.teamOperationId` 重建 team env（`relaunchScope.ts`），会话仍然绑在已归档的团队上，`team_create` 也会被拒。所以现状是不能退回普通模式。

## 设计

### 语言（方案 a，已发布）

- `teams/language.ts`：`detectTeamUserLanguage(text)` 从 Owner 原话判断中文、日文或韩文（汉字/假名/谚文数量 ≥4，且多于按 5 个字母折算的拉丁词数），其他语言返回 null。Owner 原话 = Owner 自己建的任务（`ownerBotId === null`）的 goal，取不到时用 op.prompt 或消息正文。
- 首条 prompt 在 `## Assigned goal` 之前插一段 `## Language`：点名用户语言；要求人能读到的内容（回复、工具调用间的说明、任务目标、消息、提交、报告）都用这种语言，思考也用；说明团队说明、工具文本和信封只是为了维护才写成英文，不要因此切换语言。检测不出语言时说「the language the user wrote the goal in」。
- 团队消息信封 footer 末尾追加一句 `Reply in Chinese (中文), the user's language.`，检测不出语言时用通用句。
- `team_create` 接入说明末尾追加通用规则。

### 本地化（方案 b，只做了实验，没有发布）

实验变体：把角色说明、标题和信封翻成中文，不加语言规则。结果见下文：效果弱于方案 a，单独用会漏，而且 Web 解析器依赖英文语法（`## Assigned goal`、footer），改动面更大。用户在 Web 上能看到的部分本来就已经本地化：信封和 skill 被剥掉，类型标签走 `t()`。

### 退出团队模式

- wire：`archive` action 加 `keepLeadSession?: true`。server 带上这个字段时，root bot 的任务不做 cleanup，所以不会给 Lead 发 stop；其余逻辑与普通归档一致（`reducer.ts`）。
- daemon：`exitTeamMode()`（`daemon/teams/exitTeamMode.ts`）：
  1. 由 session 找到 scope（managed 用 operationId，`team_create` 用 sessionId）。
  2. 校验这个 bot 是 root，且 sessionId 匹配；成员会被拒绝。
  3. 团队未归档时，用 Owner 身份发 archive `keepLeadSession`，requestId `team-exit-<sid>`，所以操作幂等。
  4. 写 `teams/exited/<sid>.json` 标记，删除 scope 文件。
  5. managed 且仍在运行的 Lead 原地 `restartSession`：保留 `--resume` 历史；relaunch 时看到标记就不带 team env（`relaunchScope.ts` `teamRelaunchEnv`），之后的恢复、自动重启、自动化唤醒也一样。`team_create` 接入的 Lead 每次调用都现读 scope，删掉 scope 文件即可，不需要重启。
- B-877b（QA49：退出后 Lead 不知道自己已退出，把 team_* 的「no team scope … call team_inspect again」当成临时故障，让用户「权限恢复后发一句继续」）：
  - 标记加 `teamName`、`language`（Owner 原话检测）、`reason`（`exit` / `archived`）、`noticeAt`（`teams/exitNotice.ts`）。
  - team_* 工具：没有 scope 且有标记时，所有走 scope 的工具（inspect、delegate、message、submit、schedule…）都返回 `teamExitedMessage`：团队 "<名字>" 已归档、本会话已退出团队模式、是普通会话；这是终态不是临时故障，不要重试、不要查询或派活、不要让用户恢复权限，直接自己完成。英文 + B-877 的语言提醒句。无标记时 `NO_TEAM_SCOPE_MESSAGE` 去掉「call team_inspect again」；env 指向的 scope 文件丢失另给 `MISSING_TEAM_SCOPE_MESSAGE`；活会话收到 409 `team_archived` 也给明确文案。`team_create` / `team_join` 不拦：用户明确要新团队时仍可建。
  - 一次性说明：`createProjectInjector().decorate` 末尾套 `createTeamExitNotice`，Claude（`finalizeRemotePrompt`）、Codex（`runCodex`）、Gemini/ACP 都走这里；有标记且没有 `noticeAt` 时在本回合最前面加 `[Very Happy: team mode ended] …`，先写 `noticeAt` 再发，所以重启、崩溃都不会重复。语言按本条用户消息检测，短消息退回标记里的 Owner 语言。`/compact`、`/clear` 不消耗。
  - B-730 路径：relaunch 时 daemon 用 spawn receipt 的 teamId 以 Owner 身份读团队（5 s 超时，失败按原逻辑带 team env）；团队已归档且本会话是 root → 写 `reason: archived` 标记，不带 team env，之后同上。成员不变。
- 入口：machine RPC `team-exit-session`（Web）、control `/team-exit-session`、CLI `very-happy teams exit --session-id <id>`。
- Web：会话 ⋯ 菜单（只对活团队的 Lead 显示）和团队页 ⋯ 菜单里加「退出团队模式 / Exit team mode」，确认框说明后果；toast 区分已重启、无需重启、旧 server 已停 Lead、离线、CLI 过旧几种结果（`screens/teams/teamExit.ts`）。

## 对照实验（2026-11-03，claude-fable-5-1）

条件：Agent SDK，Very Happy 真实 append 系统提示，team_* 工具用真实描述加 stub 客户端，cwd 放在 `/tmp`（证实不会读到 `~/.claude/CLAUDE.md`），全程中文提问，提问里不要求「用中文」。short = 首轮 + 1 条团队回合；long = 首轮 + 英文系统通知、英文提交、带简报板前缀的 Owner 追问，共 4–6 轮。指标 = 出现英文回复块的运行数 / 总运行数（括号里是英文块 / 总块数）。

| 条件 | 修前 | 修后（a：语言规则） | 只做 b（本地化，未发布） |
|---|---|---|---|
| 普通 N short / long | 0/10 / 0/10 | 不受影响 | — |
| Lead short | 5/10（22/43） | **0/10**（0/46） | 2/8（9/39） |
| Lead long | 7/10（57/104） | **0/10**（0/107） | 0/8（0/77） |
| 成员 short | 5/10（24/50） | **0/10**（0/53） | 3/8（16/45） |
| 成员 long | 5/10（43/90） | **0/10**（0/106） | 3/8（30/82） |

thinking 摘要（`display: 'summarized'`）：普通会话本来就有 97% 是英文块，修后 Lead long 从 93% 降到 76%。界面上看不到 Claude 的 thinking，所以这项不作为验收指标。Codex（gpt-5.6-sol）抽查：修前 N/L/M 各 5 次、修后 L/M 各 3 次，英文回复都是 0。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 Web + 旧 daemon | RPC 返回 `Method not found`，提示升级 CLI；不会归档 |
| 新 daemon + 旧 server | zod 剥掉 `keepLeadSession`，变成普通归档，Lead 被 stop。daemon 检测到 Lead 的 stop op，返回 `leadStopped`，Web/CLI 提示恢复；因为写了标记，恢复后是普通会话 |
| 新 daemon 发的信封 + 旧 Web | footer 多一句没被剥掉，会显示在卡片正文末尾；只影响外观 |
| 旧 daemon 发的信封 + 新 Web | 正则同时兼容旧 footer |
| 语言规则 | 只有新 daemon 新拉起或新送达的 prompt 才带；存量会话的历史不变 |

server 和 Web 在同一个镜像里，先发 server/Web，再发 CLI。

## 风险

1. 检测误判：英文 brief 里夹几个中文词不算中文（有测试）；判错时最坏情况是要求用中文回复。可以接受。
2. restart 走 RPC，有 30 s 上限：restart-session 已在同一路径上使用。超时的话，团队已归档、标记已写，再执行一次 exit 是幂等的。
3. 首轮里的英文注入仍留在 Lead 历史里，这是保留历史的代价。之后的回合没有新的团队注入，语言规则也在历史里。

## 验收标准

- [x] 团队注入清单（上表）
- [x] 对照实验修前修后英文比例（`~/code/github/skills/tmp/vh-team-B-877/exp`，数字见 PR）
- [x] reducer：`keepLeadSession` 不 stop Lead，普通归档仍 stop（`reducer.spec.ts`）
- [x] daemon：exit 写标记、删 scope、幂等、拒绝成员；之后 relaunch 不带 team env（`exitTeamMode.test.ts`）
- [x] 隔离 server + daemon e2e，修前和修后各跑一遍（`~/code/github/skills/tmp/vh-team-B-877/e2e`）
- [x] Web 两处入口，中英文案
- [x] B-877b：退出 / 归档后恢复的 Lead，team_* 明确说已退出团队模式；下一回合一次性说明（持久化、只一次，Claude/Codex）（`exitNotice.test.ts`、`exitTeamMode.test.ts`、`injector.test.ts`，e2e `~/code/github/skills/tmp/vh-team-B-877b/e2e`）
