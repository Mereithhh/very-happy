# very-happy — AI agent 工作指南

自托管的 Claude Code web 客户端 + 中继，fork 自 slopus/happy 并深度魔改
（自有账号密码登录、服务端可信非 e2e、只用 web 不用官方 App）。
单人 Owner（jojo）+ AI agent 集群开发；唯一主开发/发布源是公开仓库
`Mereithhh/very-happy`，旧私有仓只读归档，禁止向其推发布 commit/tag 或从中部署。
生产：veryhappy.dev（server+web 在 vh-us、以同一完整镜像发布；daemon/CLI 跑在 mac-office）。

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
- 事故修复必附覆盖该机制的回归测试，否则不许合并。
- 新逻辑尽量抽纯函数模块（`termWriteHold`/`termStreamSync`/`boardTaskOps` 先例）——
  AI 并行开发下测试稳定性的支柱。
- 常规发布只认 canonical `origin/main` 已合入且必需 quality gates 全绿的精确 SHA；旧
  worktree、detached HEAD 或 rebase/squash 后的改动必须先移植/合入最新 main，再重新锁定 SHA。
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
pnpm -C packages/happy-web-v2 exec vitest run
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

# happy-server：类型 + 测试
pnpm -C packages/happy-server exec tsc --noEmit
pnpm -C packages/happy-server exec vitest run
```

## 验收

- 自动化能验的当批验掉（E2E 冒烟有先例脚本手法）；验不了的（真机 IME/触屏/
  视觉观感）登记 `docs/verify-queue.md`，下一批开始前 Owner 清账。
- 窄屏、主题或第三方嵌入组件的视觉改动，除测试/build/tsc 外，还要在受影响的真实浏览器
  视口验证交互、溢出与布局；本地浏览器能验的当批验，只有真机专属项才留 verify queue。
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
   已推 tag，修复后递增版本；npm 已可见不等于跨平台 smoke 已通过。
7. **面向用户的 CLI 更新命令必须固定目标版本并窄放行安装脚本**：使用
   `npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<version> && very-happy daemon start`。
   `daemon start` 是幂等的 version/endpoint-aware handover：不在线则启动，不匹配则优雅接管；
   当前没有 `daemon restart` 子命令，禁止凭名字臆造或改成可能把机器留离线的 `stop && start`。
   handover 只替换 daemon；已经运行的 agent session wrapper / SDK Query 仍是旧进程，CLI 新能力必须用
   升级后新建或明确续接重启的会话验收，不得把 daemon 版本等同于存量会话已热升级。
8. **Claude SDK 会话的 Queue / Steer / Stop / permission callback 是不同控制通道**：Queue
   等当前 turn 结束，Steer 注入当前 turn，只有 Stop 才终止；`ExitPlanMode` 的权限回调只完成
   当前审批，不得在响应前嵌套发第二条 SDK control request；内部中断/diagnostic frame 不得
   渲染成普通 assistant 回复。
9. xterm+FitAddon 的 padding / floor 余量坑反复重现：改终端布局前搜历史
   （`bf07e4aa`/`fe5172b6`/`4849fb5e`）。
10. push 后 ≥20s 再触发 CI，`gh run view --json headSha` 核对构建 sha（踩过构建到
   旧 commit、push 静默失败两种事故）。
11. 明文密钥永不进 repo；推公开 remote 前跑 secret 扫描。
12. PostgreSQL `SERIALIZABLE` 冲突经 Prisma model API 常表现为 `P2034`，经 raw query
    会表现为 `P2010` + SQLSTATE `40001`；事务层必须同时重试。CLI 对 session
    metadata/agent-state 的 server `result:error` 也不得静默吞掉，否则权限请求会永久丢失。
14. **CLI wrapper 进程不随 daemon 升级热替换（铁律 7 的推论）**：任何依赖 CLI 行为的 Web 功能必须按
    `session.metadata.capabilities` 分版本（不是 machine `happyCliVersion`），并假设更新前开着的会话永远跑旧代码；
    Web 侧要有版本无关的兜底。权限模式的唯一执法入口是 `src/sync/yoloEnforcement.ts`（storage 收集决策、
    sync 注入 enforcer；只对明确选过的 yolo 执法，绝不对代码默认执法），出站模式唯一清洗点是
    `normalizeClaudeOutboundMode`——**选择器/设置里出现 CLI zod 枚举不认识的值会让整条消息被静默丢弃**
    （`dontAsk` 事故）。普通工具 approve **不得带 `mode`**（0.2.79–0.2.90 会在 canUseTool 内嵌套 control
    request，失败即 deny）。规则全文见 `specs/2026-08-permission-mode-source-of-truth.md`「Web 代批与执法边界」。
15. **reducer 输入契约：一批消息按 seq 升序**（`sortIncomingBySeq` 在 `storage.applyMessages` 与 `reducer()`
    入口各调一次；乐观消息混批保持到达顺序）。历史回填页是 DESC，绕过它会让 sidechain 子行永久平铺、
    子工具永久 running、plan-mode 误进（B-261）。
13. **Web「回前台 / socket 是否还活着」只有一个入口**：`src/sync/resumeSync.ts`（可见性边沿，
    不看 `hasFocus`）→ `sync.onWebResume` → `apiSocket.checkLiveness()`（`ping`/`relay-ping`
    探活、再校验后才 `disconnect();connect()`）。不要再给 screen 加平行的 visibility/focus
    监听去重拉或重连，也不要用「最近收到包」判活、不要 `io.open()`（退避中是 no-op 或永久卡死）；
    socket.io 语义由 `socketIoResume.integration.test.ts` 锁住，改法见 `specs/2026-08-web-resume-sync.md`。
16. **一个 happy session 至多一个活 wrapper，执法点在 wrapper 自己**：启动时、连 server 之前持
    `~/.happy/session-locks/<id>.json`（`utils/sessionLock.ts`）；`HAPPY_RECONNECT_*` 即 takeover（杀旧→等退出→
    持锁→reactivate，顺序不可反：旧 wrapper 的 deactivate 会让 server 广播 archive 连坐 successor），杀不掉就让位。
    daemon 认领/停旧/幂等判活以锁为准，`hostPid`/命令行匹配只是存量兜底；新增任何 spawn/resume 路径都不得绕过
    `claimSessionOrExit`。多写者状态下不要手杀其中一个（会归档整个会话），走「重启会话」。见
    `specs/2026-09-session-single-writer-lock.md`（B-272）。
