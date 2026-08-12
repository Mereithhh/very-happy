# very-happy — AI agent 工作指南

自托管的 Claude Code web 客户端 + 中继，fork 自 slopus/happy 并深度魔改
（自有账号密码登录、服务端可信非 e2e、只用 web 不用官方 App）。
单人 Owner（jojo）+ AI agent 集群开发；repo 私有。生产：happy.mereith.com
（server+web 在 hw-sg，daemon/CLI 跑在 mac-office）。

## 包结构

- `packages/happy-web-v2` — 生产 web 前端（Vite+React19+zustand）。`happy-app` 是废弃的旧 Expo 前端，别改。
- `packages/happy-cli` — CLI + daemon（npm `very-happy-cli`）。
- `packages/happy-server` — 中继 server（Fastify+Prisma）。
- `packages/happy-wire` — 共享 wire schema（dist 被 gitignore，clean checkout 先 build 它）。

## 文档地图

```
CLAUDE.md（本文件）── 入口：门禁 / 铁律 / 热区
  │
  ├─ docs/PROCESS.md ──────── 流程：批次制 / 门禁 / 发布 / 验收 / 沉淀
  │    ├─ docs/backlog.md ──────── 需求层：一切输入落这（主 agent 单写者）
  │    ├─ specs/ ────────────────── 设计层：大改动前置 spec（规范见 specs/README.md）
  │    └─ docs/verify-queue.md ── 验收层：留真机验证项登记 / 清账
  ├─ docs/channels.md ─────── 对外契约：webhook 出站 + spawn/send/MCP 入站
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

## 质量门禁（任何 merge 前，硬性）

```sh
# happy-web-v2：测试 + 构建 + tsc 零新增（存量 ~490 债只减不增，与 main 基线对照）
pnpm -C packages/happy-web-v2 exec vitest run
pnpm -C packages/happy-web-v2 exec vite build
pnpm -C packages/happy-web-v2 exec tsc --noEmit 2>&1 | wc -l   # 与 main 上同命令的输出比较

# happy-cli：build + unit + 运行冒烟（build 绿 ≠ 运行不崩，有 CJS 事故先例）
pnpm -C packages/happy-cli test        # = build + vitest unit
node packages/happy-cli/dist/index.mjs --version
# 已知环境例外：daemon.integration "second daemon" 用例

# happy-server：类型 + 测试（零新 npm 依赖——bind-mount 部署约束）
pnpm -C packages/happy-server exec tsc --noEmit
pnpm -C packages/happy-server exec vitest run
```

## 验收

- 自动化能验的当批验掉（E2E 冒烟有先例脚本手法）；验不了的（真机 IME/触屏/
  视觉观感）登记 `docs/verify-queue.md`，下一批开始前 Owner 清账。
- 浏览器验证注意 SW 缓存混版：硬刷新 / unregister 后再判断「没生效」。
- 发布顺序默认 server → web → CLI；涉及协议字段按 spec 兼容矩阵定顺序。

## UI 设计约束（Console 设计语言）

very-happy 是「穿在浏览器里的终端」：所有表面坐在 bg token 台阶上
（`--bg-0..3`/`--line`/text 三阶），组件里**禁止裸色值**；唯一强调色
phosphor teal（`--accent`）严格只表示 live（focus/活跃/已连接/agent 在跑），
绝不当装饰；等宽体是机器层身份（会话 id、机器名、chip、时间戳、终端全 mono）；
**终端 pane 在两个主题里都保持深色**。着色纪律全文与豁免清单见
`packages/happy-web-v2/src/styles/tokens.css` 头部注释（token 事实源；
定稿规范在 Owner skills repo 的 design-tokens.md）。

## 冲突热区（改前先确认有无并行工作在碰）

- `packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx`
- `packages/happy-web-v2/src/screens/settings/SettingsRoutes.tsx`
- `packages/happy-cli/src/terminal/webTerminal.ts`

派工时高冲突事项显式声明「别碰」；同文件冲突由主 agent 合并时解决。

## 铁律（血泪精选，全史在 Owner skills repo build-state）

1. **synced settings 字段绝不加 zod `.default()`**——`loadPendingSettings` 会把
   注入的默认值当幽灵 pending，每次加载 POST 空值覆盖服务器（预设丢失事故真因）。
2. **daemon 加纯 JS 的 CJS 依赖必须进 `devDependencies`** 让 pkgroll inline，
   否则 external ESM 具名 import 运行时崩（build 全绿只在运行时炸）；发版前实跑
   `node dist/index.mjs --version`。
3. **工具一律 `pnpm exec`，不用 npx**（npx 会解析到错误版本）。
4. **双向兼容（旧端忽略新字段）是设计要求**不是可选项；协议改动写兼容矩阵。
5. **server 部署后必须 `vh-update`** 重启 daemon（RPC 重注册 bug，backlog B-001）。
6. xterm+FitAddon 的 padding / floor 余量坑反复重现：改终端布局前搜历史
   （`bf07e4aa`/`fe5172b6`/`4849fb5e`）。
7. push 后 ≥20s 再触发 CI，`gh run view --json headSha` 核对构建 sha（踩过构建到
   旧 commit、push 静默失败两种事故）。
8. 明文密钥永不进 repo；推公开 remote 前跑 secret 扫描。
