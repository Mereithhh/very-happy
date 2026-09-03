# very-happy — AI agent 工作指南

自托管的 Claude Code web 客户端 + 中继，fork 自 slopus/happy 并深度魔改
（自有账号密码登录、服务端可信非 e2e、只用 web 不用官方 App）。
单人 Owner（jojo）+ AI agent 集群开发；唯一主开发/发布源是公开仓库
`Mereithhh/very-happy`，旧私有仓只读归档，禁止向其推发布 commit/tag 或从中部署。
生产：veryhappy.dev（server+web 在 vh-us、以同一完整镜像发布；daemon/CLI 跑在 mac-office）。

## 第一原则（高于本文件其余一切条目）

- **只做正确的事，保持批判性思维。** 本文件的铁律、spec、代码注释与既有设计都是
  **可推翻的默认与证据，不是教条**——一旦有经核验的更优解，就推翻它，别因为「历史上
  这么写/注释说别动」而沿用次优做法。
- 推翻的代价是**同一次改动里更新那条规则/注释/spec，并留下依据**：说清旧结论为何不再
  成立、新方案如何不重蹈它记录的事故。铁律记录的是真实血泪事故，推翻某条前先证明该
  事故在新方案下不会复发；**绝不静默违反、也绝不「知道有更好做法却不改规则」**。

## 包结构

- `packages/happy-web-v2` — 生产 web 前端（Vite+React19+zustand）。`happy-app` 是废弃的旧 Expo 前端，别改。
- `packages/happy-cli` — CLI + daemon（npm `very-happy-cli`）。
- `packages/happy-server` — 中继 server（Fastify+Prisma）。
- `packages/happy-wire` — 共享 wire schema（dist 被 gitignore，clean checkout 先 build 它）。

## 文档地图

```
AGENTS.md（事实源；CLAUDE.md 导入）── 入口：门禁 / 铁律 / 热区
  │
  ├─ docs/PROCESS.md ──────── 流程：批次制 / 门禁 / 发布 / 验收 / 沉淀
  │    ├─ docs/backlog.md ──────── 需求层：一切输入落这（主 agent 单写者）
  │    ├─ specs/ ────────────────── 设计层：大改动前置 spec（规范见 specs/README.md）
  │    └─ docs/verify-queue.md ── 验收层：留真机验证项登记 / 清账
  ├─ docs/channels.md ─────── 对外契约：webhook 出站 + spawn/send/MCP 入站
  ├─ docs/development.md ──── 本地：Web V2 + standalone server + CLI
  ├─ docs/operations.md ───── 生产：vh-us/mac-office 发布、恢复与回滚
  ├─ .agents/skills/ ──────── Codex/Claude 共用的 repo-local dev/release 操作入口
  ├─ docs/*.md ────────────── 架构事实（protocol / backend / cli，多为上游遗留，以代码为准）
  └─ docs/plans/ ──────────── 上游遗留 plan 档案（只读；新设计一律进 specs/）
```

## 开发流程（细则见 docs/PROCESS.md）

- 以**批**为单位：triage → 并行实现（每事项一个 worktree+分支）→ review+merge
  → 门禁 → 发布 → 验收 → 沉淀。
- 需求/bug 当场记 `docs/backlog.md`，不靠记忆；动协议/状态模型/存储语义/跨包的
  改动先出 spec（`specs/`）定稿再实现。
- 事故修复必附覆盖该机制的回归测试，否则不许合并；源码断言型测试（本仓大量使用）
  用 `node scripts/dev/mutation-check.mjs` 验一遍它真的钉得住（理由见 docs/PROCESS.md）。
- 新逻辑尽量抽纯函数模块（`termWriteHold`/`termStreamSync`/`boardTaskOps` 先例）——
  AI 并行开发下测试稳定性的支柱。
- 常规发布只认 canonical `origin/main` 已合入且必需 quality gates 全绿的精确 SHA；旧
  worktree、detached HEAD 或 rebase/squash 后的改动必须先移植/合入最新 main，再重新锁定 SHA。
- **每次发布必须带 changelog**：`scripts/changelog/check-release.mjs` 在 deploy/publish 工作流里硬拦
  「有 feat/fix/perf 却没新增 `CHANGELOG_RELEASES` 条目」的发布；tag 失败要烧版本号，所以打 tag /
  触发 deploy 前先本地跑同一脚本（命令见 `.agents/skills/release/SKILL.md`）。跳过必须留理由。
- 每次任务或发布收尾都主动判断是否产生了值得跨会话保留的经验：只有能防止后续 agent
  重踩、可在多个任务复用、且不能仅靠邻近代码明显推导的稳定事实或方法论，才更新根
  `AGENTS.md`，并优先修订既有条目而非追加重复规则。一次性版本/SHA/run id、临时排障过程、
  单点实现细节、琐碎偏好和未经验证的猜测不进；机制细节仍放最贴近的 spec、代码注释或
  owner doc，`AGENTS.md` 只保留入口与硬门禁。

## 质量门禁（任何 merge 前，硬性）

```sh
# happy-wire：clean checkout 先构建 gitignored dist，再跑测试
pnpm -C packages/happy-wire build
pnpm -C packages/happy-wire exec vitest run

# happy-web-v2：测试 + 构建 + tsc **零错误**（2026-08-18 实测已是 0，不再有存量债）
# shell 里若导出了 HAPPY_SERVER_URL/HAPPY_WEBAPP_URL（只设其一），installScript.test 会随 process.env 继承而挂：
# 门禁统一用 env -u HAPPY_SERVER_URL -u HAPPY_WEBAPP_URL 前缀跑（2026-09-02 实踩）。
env -u HAPPY_SERVER_URL -u HAPPY_WEBAPP_URL pnpm -C packages/happy-web-v2 exec vitest run
pnpm -C packages/happy-web-v2 exec vite build
pnpm -C packages/happy-web-v2 exec tsc --noEmit
# 直接以 tsc 退出码为准；不要接 grep/wc，零错误时 grep 无匹配会返回 1，污染门禁退出码。
# 「存量 ~490 债只减不增」是过期口径（债已还完），照它判会把新引入的错误当成在预算内。

# happy-cli：build + unit + 运行冒烟（build 绿 ≠ 运行不崩，有 CJS 事故先例）
pnpm -C packages/happy-cli test        # = build + vitest unit
node packages/happy-cli/dist/index.mjs --version
# 已知环境例外：daemon.integration "second daemon" 用例
# 在 web 终端（tmux 内）跑 happy-cli 测试前先 `unset TMUX`；任何触碰 tmux 的测试只能走
# src/testing/isolatedTmux.ts（私有 -S socket），禁止裸 `tmux kill-server`（2026-08-31 两次杀光生产终端）
# 这套真 tmux 测试**不能两份 vitest 并发跑**：并发会让 webTerminal.userTmuxConf 假红（2026-09-03 实踩，
# 单独重跑全绿）。同机同时只跑一份 happy-cli 测试，看到它单独失败先排除并发再当回归。

# happy-server：类型 + 测试
pnpm -C packages/happy-server exec tsc --noEmit
pnpm -C packages/happy-server exec vitest run
```

## 验收

- 自动化能验的当批验掉（E2E 冒烟有先例脚本手法）。**验不了的先用浏览器自己验**——Owner 明确说过
  没有时间清 verify queue，「用户没反馈就是修好了」，所以把项目堆进 `docs/verify-queue.md`
  等人来验等于没验（2026-09-03 已积到 140+ 项）。只有真正只有真人能判的（真机 IME、触屏手感、
  多设备时序）才登记，而且要写清为什么浏览器验不了。
- 窄屏、主题或第三方嵌入组件的视觉改动，除测试/build/tsc 外，还要在受影响的真实浏览器
  视口验证交互、溢出与布局；本地浏览器能验的当批验，只有真机专属项才留 verify queue。
  **窄屏量尺寸必须按 `pointer: coarse` 的真实控件尺寸量**（`.sb-icon-btn` 38px、`.vh-back` 40px、
  `.ch-icon` 36px，而不是桌面的 30/32px）：桌面浏览器默认是 fine pointer，直接量会显著低估溢出
  （B-293 第一遍就少算了约 40%，把「常态就有按钮点不到」误判成「只有连接期才溢出」）。
  复制真实 CSS 到一次性 harness 量 `scrollWidth - clientWidth` 与每个按钮的越界量，修前修后各留一份。
- 浏览器判断「发布没生效」前先保留现场：在原标签页记录实际加载的 entry/CSS URL、
  目标元素 computed style 与关键 CSS variable，并对比服务器当前 entry；再用普通 reload
  验证版本迁移。只有证据留存后才 hard refresh / unregister 做恢复；强刷后正常不能单独
  作为发布成功证据。
- 发布成功必须闭环核对线上版本身份与行为：运行镜像/静态资源对应目标 SHA、`/health`
  正常，并验证本次改动的关键真实路径；包含 CLI/daemon handover 时再确认 daemon 版本与
  RPC 重注册。workflow 绿或普通页面能打开都不能单独作为发布成功证据。
- server 与 web 是同一完整镜像；默认发布顺序为 server/web → CLI，涉及协议字段按 spec
  兼容矩阵定顺序。

## UI 设计约束（Console 设计语言）

视觉设计的唯一契约见 `docs/design-language.md`，改 Landing、登录、App、弹窗或
全局组件前必须先读。very-happy 是「穿在浏览器里的终端」：所有表面坐在 bg token 台阶上
（`--bg-0..3`/`--line`/text 三阶），组件里**禁止裸色值**；唯一强调色
phosphor teal（`--accent`）严格只表示 live（focus/活跃/已连接/agent 在跑），
绝不当普通 CTA 或装饰；主 CTA 使用 ink/canvas 高反差关系；等宽体是机器层身份
（会话 id、机器名、chip、时间戳、终端全 mono）；
**终端 pane 在两个主题里都保持深色**。着色纪律全文与豁免清单见
`packages/happy-web-v2/src/styles/tokens.css` 头部注释（token 事实源；
详细纪律同样以该文件为准，避免依赖仓库外知识）。

## 冲突热区（改前先确认有无并行工作在碰）

- `packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx`
- `packages/happy-web-v2/src/screens/settings/SettingsRoutes.tsx`
- `packages/happy-cli/src/terminal/webTerminal.ts`
- `packages/happy-web-v2/src/sync/storage.ts`、`src/sync/sync.ts`（applySessions / applyMessages / 权限执法与回前台链路都在这里，改前 `git log -5 -- <file>`）

派工时高冲突事项显式声明「别碰」；同文件冲突由主 agent 合并时解决。

## 铁律（血泪精选；机制细节以邻近代码、spec 与 backlog 为准）

1. **synced settings 字段绝不加 zod `.default()`**——`loadPendingSettings` 会把
   注入的默认值当幽灵 pending，每次加载 POST 空值覆盖服务器（预设丢失事故真因）。
2. **daemon 加纯 JS 的 CJS 依赖必须进 `devDependencies`** 让 pkgroll inline，
   否则 external ESM 具名 import 运行时崩（build 全绿只在运行时炸）；发版前实跑
   `HAPPY_HOME_DIR=$(mktemp -d) node dist/index.mjs --version`。
3. **仓库依赖里的构建/测试/生成工具一律 `pnpm exec`，不用裸 `npx`**
   （npx 曾绕过 workspace/lockfile 解析到错误版本）。仓库外的一次性只读工具可用
   版本化 plugin/skill runtime，或 `pnpm dlx <package>@<精确版本>`；禁止 `@latest`、
   未固定版本的临时下载，以及因此改动 `package.json` / `pnpm-lock.yaml`。
4. **双向兼容（旧端忽略新字段）是设计要求**不是可选项；协议改动写兼容矩阵。
5. **server/Web 只能随同一完整、不可变镜像发布**，source、migration、Prisma Client 与
   Web 不得在主机上分别覆盖；蓝绿是否已激活及 rollout phase 以 `docs/operations.md` 当前状态
   为准，禁止因仓库已有实现就假定生产已启用。正常蓝绿切换不需要 `vh-update`；只有 CLI
   改动影响 handover/daemon，或初次 groundwork 明确要求时才更新 mac-office。
6. **CLI 的 npm 包与 tag 是不可变外部发布**：平台包先于主包；任一步失败都不移动或复用
   已推 tag，修复后递增版本；**npm 上可见 ≠ 该版本被推荐**——主包发布落在 `next`，
   `latest` 只由 publish workflow 的 `promote` job 在**同一 commit 的三系统 smoke 全绿后**
   移动（B-348），而 relay 的 `recommendedVersion` 跟着 `latest` 走（1h 缓存），B-327 的空闲
   自动升级装的就是它。所以**发版不再需要手动 pin**，而 `next` 领先 `latest` 就是「smoke 没过
   / promote 没跑」的信号：去读那个 job，别手动 `npm dist-tag add` 绕过去。要按住或回滚机队用
   `CLI_RECOMMENDED_VERSION`（pin 永远赢过 lookup），机制与两个变量的分工见 `docs/configuration.md`。
7. **面向用户的 CLI 更新命令必须固定目标版本并窄放行安装脚本**：使用
   `npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<version> && very-happy daemon start`。
   `daemon start` 是幂等的 version/endpoint-aware handover：不在线则启动，不匹配则优雅接管；
   当前没有 `daemon restart` 子命令，禁止凭名字臆造或改成可能把机器留离线的 `stop && start`。
   handover 只替换 daemon；已经运行的 agent session wrapper / SDK Query 仍是旧进程，CLI 新能力必须用
   升级后新建或明确续接重启的会话验收，不得把 daemon 版本等同于存量会话已热升级。
   **`npm i -g` 自己会失败，且两种形态都出过**（2026-09-03/04 一天内各踩两次）：①它拒绝覆盖
   **自己建的** bin 符号链（`EEXIST … /opt/homebrew/bin/very-happy`），通常前面还跟着
   `ENOTEMPTY rmdir .../tools`——包自己的 postinstall 写进去的文件 npm 不记账，旧树删不掉；
   ②半写坏的树，重试永远同样失败。`scripts/update-daemon.sh` 两种都已处理（装前 unlink **只**指向
   自己树的那两个链；失败后删掉那一个包目录重装一次）。**`update/autoUpdate.ts` 与 `update/cliUpdate.ts`
   还没有这层防御**（B-346），而自动升级对同一版本只试一次——一台机器可能就此静默地永远不升级。
8. **Claude SDK 会话的 Queue / Steer / Stop / permission callback 是不同控制通道**：Queue
   等当前 turn 结束，Steer 注入当前 turn，只有 Stop 才终止；`ExitPlanMode` 的权限回调只完成
   当前审批，不得在响应前嵌套发第二条 SDK control request；内部中断/diagnostic frame 不得
   渲染成普通 assistant 回复。**mode 字段同理分三条通道**（model/permissionMode 活切、其余重启
   query），改 `claudeRemote*` / `claudeModeHash` 前先读
   `specs/2026-09-claude-mode-live-vs-relaunch.md`——别因为「SDK 提供了这个 setter」就换过去，
   先证明它能回报当前真正生效的值（`applyFlagSettings` 对乱填的 effort 也照样 resolve）。
   **消息形状另有三条硬事实**（2026-09-03 实跑 SDK 0.3.232 取证，机制见
   `specs/2026-09-sdk-chat-streaming-ux.md`）：① SDK **把一条 API 消息按 content block 炸成 N 条
   `assistant` 帧、每帧 `content` 长度恒为 1**（本机 transcript 10264/10264；块索引只用于派生
   uuid，不进 message 对象）——凡是拿 `message.content` 的数组下标当「API 块序号」的代码都是错的，
   要跨帧维护游标，且 sidechain 帧会插在主链两帧之间；② **thinking 正文被 API redact**，
   `thinking_delta.thinking` 与最终消息里的 thinking block **都是空串**，只有 `estimated_tokens`
   有值——B-253 记的「SDK 未暴露思考正文」观察对、归因错，别再试图把正文接出来；终端里像「看得见
   思考」的东西 = 流式正文 + token 计数；③ 前两条**读 `sdk.d.ts` 和读我们自己的代码都会得出相反
   结论**，只有跑一次真实 query 才拿得到——碰 SDK 行为前先写一个 20 行的 probe（隔离 home 直接
   `query({options:{includePartialMessages:true}})`，把帧类型/字段打出来；数据表在上述 spec 的
   「实测校正」节）。
9. **终端字形渲染三条硬事实**（机制全文见
   `specs/2026-09-terminal-font-and-seamless-rendering.md`，2026-09 连踩 6 个 PR 换来）：
   ①「严丝合缝」=（字体方块字形填满整格）×（`lineHeight` 1.0），**缺一不可**——「字体有该
   码位」≠ 能无缝拼接（IBM Plex Mono 实测有缝），改字体或改行高前**并排实测截图**；
   ② **canvas/WebGL 渲染器已评估并否决**：它把文字画进 canvas、DOM 内无文字节点，会**废掉
   移动端原生长按复制**（`terminal.css` 专门放行 `.xterm-rows` 的 user-select），
   不先解决移动端复制就别再提；③ **终端历史不可重排**（Ink 折行写字面量 `\n`，ink#883；
   `-J`/emulator 只接自己的软折行），**只能预防不能回溯,别向用户承诺**。
   另：xterm+FitAddon 的 padding / floor 余量坑反复重现，改终端布局前搜历史
   （`bf07e4aa`/`fe5172b6`/`4849fb5e`）。
10. push 后 ≥20s 再触发 CI，`gh run view --json headSha` 核对构建 sha（踩过构建到
   旧 commit、push 静默失败两种事故）。**PR 号一律取 `gh pr create` 的真实返回值，绝不顺推**
   （踩过 land 到别人的 Dependabot PR）；判 workflow 成败**必须读 `conclusion`，不能只看
   `status: completed`**（completed+failure 曾被当成功报给 Owner）。
11. 明文密钥永不进 repo；推公开 remote 前跑 secret 扫描。
12. PostgreSQL `SERIALIZABLE` 冲突经 Prisma model API 常表现为 `P2034`，经 raw query
    会表现为 `P2010` + SQLSTATE `40001`；事务层必须同时重试。CLI 对 session
    metadata/agent-state 的 server `result:error` 也不得静默吞掉，否则权限请求会永久丢失。
14. **CLI wrapper 进程不随 daemon 升级热替换（铁律 7 的推论）**：任何依赖 CLI 行为的 Web 功能必须按
    `session.metadata.capabilities` 分版本（不是 machine `happyCliVersion`），并假设更新前开着的会话永远跑旧代码；
    Web 侧要有版本无关的兜底。权限模式的唯一执法入口是 `src/sync/yoloEnforcement.ts`（storage 收集决策、
    sync 注入 enforcer；只对明确选过的 yolo 执法，绝不对代码默认执法），出站模式唯一清洗点是
    `normalizeClaudeOutboundMode`。**CLI 的 `MessageMetaSchema` 有两种静默失败，方向相反，都出过事故**：
    枚举不认识的值 → 整条消息被丢弃（`dontAsk`）；**schema 里干脆没有那个字段 → zod 直接剥掉，
    读取侧永远读不到**（`effort` 因此在所有已发布版本上从未生效过，B-292）。加 mode 字段一律用
    `z.string().nullable().optional()` + 读取侧白名单，不要用 enum。普通工具 approve **不得带 `mode`**
    （0.2.79–0.2.90 会在 canUseTool 内嵌套 control request，失败即 deny）。
    **推论——Web 选择器显示的是意图，不是事实**：选完立刻变、不等确认，所以只要 CLI 不发布「当前真正
    生效的值」，任何没生效都是静默的（permissionMode 有 `metadata.permissionMode`，model 有
    `metadata.currentModelCode`；新增可选 mode 字段时一并补上对应的回报字段）。规则全文见
    `specs/2026-08-permission-mode-source-of-truth.md`「Web 代批与执法边界」，各 mode 字段「活切 vs 重启
    query」的通道契约见 `specs/2026-09-claude-mode-live-vs-relaunch.md`（含「重启 hash 同时是合批键」
    与「park 必须和 adopt 同一个动作」两个坑）。
15. **reducer 输入契约：一批消息按 seq 升序**（`sortIncomingBySeq` 在 `storage.applyMessages` 与 `reducer()`
    入口各调一次；乐观消息混批保持到达顺序）。历史回填页是 DESC，绕过它会让 sidechain 子行永久平铺、
    子工具永久 running、plan-mode 误进（B-261）。
16. **「终端里 claude 能用」≠「very-happy 会话能用」**：darwin 上 Claude Code 凭据是 keychain/文件双店，keychain 有项即赢（含空 token 项）、`security` exit 36/44 才回落文件、写路径可能删明文——哪个被读到取决于进程血统。认证类故障先看机器页「Claude 登录状态」（`daemonState.claudeAuth`，daemon 上下文实测），机制、诊断与 `credentialStore=file` 钉死方案见 `specs/2026-09-claude-auth-preflight.md`；不要注入 `CLAUDE_CODE_OAUTH_TOKEN`/`apiKeyHelper`/独立 `CLAUDE_CONFIG_DIR` 绕。
    **根因永远是「谁在旋转同一个 refresh token」**（Claude Code 每次刷新都轮换它，旧的立刻作废）：同机两处存储是一种，**同一份 `~/.claude/.credentials.json` 被复制到第二台机器**是另一种——后者表现为「只认最新登录的那台」。
    用户报「link 了第二台机器，第一台就失效了」时**不要去 server 找踢人逻辑**：CLI token 是 `HANDY_MASTER_SECRET` 签的无状态持久串，不入库、无吊销路径（`app/auth/auth.ts:93,304-305`），machine 上限 20 且各自独立 presence 房间，server 从来不会因为新机器上线而作废旧机器。真正的耦合点是 `~/.happy` 被复制：`machineId` 是 `randomUUID()` 存在里面（`ui/auth.ts:242`），两台主机因此抢同一条 machine 行，而 `getOrCreateMachine` 对已存在机器不覆盖 metadata，web 永远显示先注册那台的 host（daemon 侧已有 `machineIdentityConflict.ts` 检测并 warn，B-297）。
13. **Web「回前台 / socket 是否还活着」只有一个入口**：`src/sync/resumeSync.ts`（可见性边沿，
    不看 `hasFocus`）→ `sync.onWebResume` → `apiSocket.checkLiveness()`（`ping`/`relay-ping`
    探活、再校验后才 `disconnect();connect()`）。不要再给 screen 加平行的 visibility/focus
    监听去重拉或重连，也不要用「最近收到包」判活、不要 `io.open()`（退避中是 no-op 或永久卡死）；
    socket.io 语义由 `socketIoResume.integration.test.ts` 锁住，改法见 `specs/2026-08-web-resume-sync.md`。
    **同族推论——活性只能从 wrapper 此刻仍在重发的信号推导，且必须校验新鲜度**（唯一入口
    `src/sync/agentLiveness.ts`）。transcript 里的 `tool.state === 'running'` **只写一次、永不重发**，
    因此永远没有活性投票权——收尾的 `tool_result` 恰恰是被杀/重启的 wrapper 不会再发的东西。唯一合格
    的信号是每 2s 的 keepAlive（`session.thinking`，五个 runner 都在**整个 turn** 内按住它，`false` 也
    重发）。**但心跳中断不等于死亡**：过期阈值必须大于本端已知最坏正常重连间隔，且**本端 socket 断开
    或标签页不可见期间必须停表**（冻结的标签页收不到 `disconnect`，`socketStatus` 会一直停在
    `connected`，只看它会在唯一该管用的场景失灵）——租约实现与那四个数见
    `specs/2026-09-agent-liveness-lease.md`（B-322）。少了新鲜度校验，wrapper 被硬杀后 UI 连续说谎约
    11 分钟：停止按钮悬在无事可停的会话上、输入被永久扣在本地队列里。后台子代理（`async_launched`）
    是唯一没有心跳却合法活着的投票者，代价是自带替代过期条件（在线 + 属于当前 turn）。
    **新增任何活性投票者或「此刻状态」，先回答：它的心跳是什么？没有心跳就说明它的过期条件是什么。**
    别再在 screen/sync 里各自 `messages.some(state === 'running')`：B-295 是三处各算各的，B-322 又在
    `AgentInput` 找到漏掉的第四处（一个幽灵 tool 单独就把输入永久扣住，且只有开新标签页能解）。
20. **一个 happy session 至多一个活 wrapper，执法点在 wrapper 自己**：启动时、连 server 之前持
    `~/.happy/session-locks/<id>.json`（`utils/sessionLock.ts`）；`HAPPY_RECONNECT_*` 即 takeover（杀旧→等退出→
    持锁→reactivate，顺序不可反：旧 wrapper 的 deactivate 会让 server 广播 archive 连坐 successor），杀不掉就让位。
    daemon 认领/停旧/幂等判活以锁为准，`hostPid`/命令行匹配只是存量兜底；新增任何 spawn/resume 路径都不得绕过
    `claimSessionOrExit`。多写者状态下不要手杀其中一个（会归档整个会话），走「重启会话」。见
    `specs/2026-09-session-single-writer-lock.md`（B-272）。
17. **会话 RPC handler 抛错不等于 RPC reject**：`RpcHandlerManager.handleRequest` 把 handler 的异常包成 `{ error }` 用
    **正常 ack** 回给 web，`apiSocket.sessionRPC` 照样 resolve。任何新的 web RPC wrapper 都必须先检查 `error` 字段再信载荷
    （先例 `ops.ts` 的 `throwIfRpcError` / `parseClaudeAuthRpc`），否则 store 会把错误当成功、渲染层拿到 undefined 直接白屏
    （web 没有 ErrorBoundary）。另：server 与 relay 的 RPC 都是 30s 上限，超过它的工作走「即返 id + 轮询」（B-283 `btw-ask/poll` 先例）。
18. **给 remote 会话加「旁路 SDK 查询」（fork 主会话另开 claude 进程）必须三件套**：上下文只认 live `Session.sessionId` 且经
    `claudeCheckSession` 确认 transcript 已落盘（server metadata 的 `claudeSessionId` 在 `/clear` 后是旧的）；显式带上
    `options.claudeEnvVars`（`--claude-env` 在 local 模式只进主 Claude 的 spawn env）；用 `--settings {"disableAllHooks":true}`
    否则每次旁路查询都放一遍用户的 SessionStart/Stop/SessionEnd hook。`persistSession:false` + `resume` + `forkSession` 已实证
    不落 JSONL、能拿全上下文。见 `specs/2026-09-btw-side-question.md`（B-283）。
19. **tmux 格式输出会被按版本/locale munge，探针分隔符只准可打印 ASCII**：`list-sessions -F`/`display-message`
    输出里的控制字符在 ≤3.2a 被换成 `_`（不可逆）、3.4/3.5 转义成 `\037`，C locale 下多字节字符也塌成 `_`
    ——0x1f 分隔符曾让 tmux ≤3.5 机器的终端列表静默全空（B-273 附带修复，哨兵 `<~|~>`）。定位用户会话用
    `$id`（`#{session_id}`）不用名字（≥3.2 名字可含 `:`/`.`，`=name:` 会被 target 解析拆开）。CI 的 vitest
    unit 项目在 ubuntu-latest 上**真跑 tmux**（当前 3.4：`window-size manual` 下建会话即崩 server，须版本 gate），
    integration-* 项目则不在 CI 跑——别把「本地绿」当「CI 会绿」。
