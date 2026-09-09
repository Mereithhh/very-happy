# very-happy — 项目指南

自托管 Web 客户端与中继，fork 自 slopus/happy；自有登录、服务端可信存储，非端到端加密。
唯一开发/发布源是公开仓 `Mereithhh/very-happy`；旧私有仓只读，不推发布 commit/tag、不从中部署。
生产 `veryhappy.dev` 的 server/Web 在 **vh-sg（AWS 新加坡）**；拓扑与恢复以 [operations](docs/operations.md) 为准。

## 工作方式

- 在自己的 worktree/分支工作，只提交本任务路径。开工 `git fetch origin`、`git status -sb`、`git worktree list`，确认基线与并行改动。
  `ahead/behind` 不足以证明历史分叉，不据此 `reset --hard`；旧历史迁移见 [runbook](docs/history-publication-runbook.md)。
- 需求记 [backlog](docs/backlog.md)，主 agent 单写；协议、状态模型、存储语义或跨包改动先定 [spec](specs/README.md)。
- 按 [PROCESS](docs/PROCESS.md) 实现、review、门禁、PR 合并、发布与验收。优先抽纯函数；事故修复必须有机制回归测试，源码断言用 `scripts/dev/mutation-check.mjs` 验证。
- main 受保护，文档也走 PR。编号用 `scripts/dev/check-ids.mjs`，rebase 后与开 PR 前 `--claim`；合并用 `scripts/land-pr.sh <pr>`。
- 临时产物放 `~/code/github/skills/tmp/<task-slug>/`；CLI 实验在该目录创建独立 `HAPPY_HOME_DIR`，不动生产 `~/.happy`。
- 规则、spec 与既有设计可被证据推翻；同次修改更新对应说明，证明不会重现原事故。稳定知识优先修订唯一 owner 文档；本文件只留入口与关键约束，不堆版本快照、运行记录或重复案例。

## 包与入口

| 范围 | 入口 |
| --- | --- |
| 生产 Web | `packages/happy-web-v2`；废弃 Expo `happy-app` 不改 |
| CLI / daemon | `packages/happy-cli`，npm `very-happy-cli` |
| Server / wire | `packages/happy-server` / `packages/happy-wire`；wire dist 被 gitignore，先 build |
| 本地开发 | [development](docs/development.md)、[dev skill](.agents/skills/dev/SKILL.md) |
| 发布 / 回滚 | [operations](docs/operations.md)、[release skill](.agents/skills/release/SKILL.md) |
| 指标 / 托管看板 | [monitoring](docs/monitoring/README.md)、[metrics skill](.agents/skills/metrics-graphana/SKILL.md) |
| 外部接口 | [channels](docs/channels.md) |
| 设计 / 验收 | [design-language](docs/design-language.md)、[verify-queue](docs/verify-queue.md) |

旧 `docs/plans/` 只读；新设计进 `specs/`。历史架构描述与代码冲突时先核实现况。

## 合并门禁

任何 merge 前必需检查全绿；tsc 必须零错误，直接看退出码，不接 grep/wc。
仓库工具用 `pnpm exec`，不用裸 `npx`；仓库外临时工具固定版本，不用 `@latest`。

```sh
pnpm -C packages/happy-wire build
pnpm -C packages/happy-wire exec vitest run

env -u HAPPY_SERVER_URL -u HAPPY_WEBAPP_URL pnpm -C packages/happy-web-v2 exec vitest run
pnpm -C packages/happy-web-v2 exec vite build
pnpm -C packages/happy-web-v2 exec tsc --noEmit

# tmux 中运行前 unset TMUX；同机只跑一份 CLI 测试。
pnpm -C packages/happy-cli test
node packages/happy-cli/dist/index.mjs --version

pnpm -C packages/happy-server exec tsc --noEmit
pnpm -C packages/happy-server exec vitest run
```

触碰 tmux 的测试必须用 `src/testing/isolatedTmux.ts` 私有 socket，禁止裸 `tmux kill-server`。
CLI 改动也会影响 Web `src/screens/public` 的契约测试，不能只跑 CLI 门禁。

## 验收与 UI

- 自动化和浏览器能验的当批验完。仅真机专属项（IME、触屏、多设备时序）留 verify queue，并写明浏览器为何验不了。
- 窄屏/主题/嵌入组件改动要真浏览器验证交互、溢出与布局；用 `scripts/dev/css-probe.mjs` 修前修后取证，移动尺寸按 `pointer: coarse`。渐变、遮挡、层叠效果要采像素，不能只断言类名存在。
- 刷新前保留当前 entry/CSS、computed style 与关键变量。SW 更新必须核对 `controllerchange`、实际 controller 与加载 entry；reload 或 `registration.update()` 返回都不能证明已换版本。
  更新链路用两个真实构建 + 本地静态 server + Chromium 验证，保留旧 hashed assets 模拟部署；机制见 `src/app/swTakeover.ts`。
- 发布必须核对目标 SHA、完整镜像/静态资源、health 和本次真实路径；用 `scripts/dev/check-shipped.mjs` 查已发布代码。daemon 更新另验版本、RPC 重注册与 mac-office launchd 守护。
- 所有 UI 工作先读 [design skill](.agents/skills/design/SKILL.md) 和 [设计契约](docs/design-language.md)：已确认的紧凑工作台风格是统一基线，保留 Very Happy 品牌；Landing/docs/login 保留鲜明品牌展示。重构按真实功能矩阵验收，不能照原型删能力；截图、README 与用户更新说明随正式实现同步。
- UI 改前读设计契约；颜色只用 `tokens.css` 定义的 token，`--accent` 仅表示 live，主 CTA 用 ink/canvas 高反差；终端 pane 两种主题都保持深色。

## 冲突热区

改前查近期提交与并行工作；派工声明文件归属，同文件冲突由主 agent 整合：

- Web `screens/terminal/WebTerminalScreen.tsx`、`screens/settings/SettingsRoutes.tsx`
- CLI `terminal/webTerminal.ts`
- Web `sync/storage.ts`、`sync/sync.ts`（改前 `git log -5 -- <file>`）

## 关键约束（保留原编号，避免已有引用失效）

1. **synced settings 不加 zod `.default()`**：默认值会被 `loadPendingSettings` 当 pending 上传覆盖服务器。
2. **daemon 的纯 JS CJS 依赖放 `devDependencies`**，让 pkgroll inline；build 通过仍须跑生成产物的 `--version`，防止 external ESM 具名 import 运行时崩溃。
3. **工具按锁定依赖解析**：见上方门禁；不要为一次性工具改 package.json/lockfile。
4. **协议必须双向兼容**，旧端忽略新字段；spec 写兼容矩阵与发布顺序。
5. **server/Web 随同一个完整不可变镜像发布**，不得分别覆盖 source、migration、Prisma Client 或 Web。当前 rollout phase 以 operations 为准；正常 server/Web 切换不更新 daemon，默认先 server/Web 后 CLI，协议变更按兼容矩阵。
6. **CLI tag/npm 包不可变，平台包先于主包**；失败后递增版本，不移动旧 tag。主包发 `next`，CI 核对同仓库/tag/SHA/push run 当前 attempt 的 Linux/macOS/Windows × Node 20/24 六个 job 全部成功，才 promote `latest`；缺格或 skipped 不算通过。
   推荐默认随 registry（1h 缓存），`CLI_RECOMMENDED_VERSION` 仅作显式 pin；**自动安装只认独立 `CLI_AUTO_UPDATE_VERSION`**，不从 registry 推导、不设就不自动装。见 [configuration](docs/configuration.md) 与 release skill。
7. **用户更新固定版本并窄放行脚本**：`npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@<version> && very-happy daemon start`。`start` 幂等接管，没有 `daemon restart`，不换成 `stop && start`。
   mac-office 按 operations 的 Re-adopt 恢复 launchd 并验 running/版本/RPC。handover 不热替换存量 wrapper，新 CLI 能力用新建或明确重启的会话验。
   安装修复只动经核验的包/bin，网络失败不删包；保留失败状态，安装与接管预检互斥。见 [更新恢复 spec](specs/2026-09-cli-update-recovery.md)。
8. **Claude Queue / Steer / Stop / 权限回调分通道**；审批响应前不嵌套 SDK control request，内部帧不作普通回复。mode 活切与重启见 [mode spec](specs/2026-09-claude-mode-live-vs-relaunch.md)。
   SDK 帧不等于 API 消息：content block 会拆帧，不能用单帧下标当全局块序号；thinking 正文可能被 redact。改 SDK 行为先隔离 home 实跑 probe，见 [流式消息 spec](specs/2026-09-sdk-chat-streaming-ux.md)。
9. **终端无缝渲染同时依赖字形填格与 lineHeight 1.0**，改前并排截图。canvas/WebGL 会破坏移动端原生长按复制，未解决前不引入；Ink 硬换行历史不可回溯重排。
   软键盘只改行数，不能改列数；字体尺寸/行高固定，否则 Claude 重打头图。见 [字体与渲染 spec](specs/2026-09-terminal-font-and-seamless-rendering.md)，FitAddon 余量问题先查历史。
10. **手动触发 CI 前等待 push ≥20s，核对 headSha 与 conclusion**；completed 不等于成功。PR 号取创建命令真实返回，不猜。发布只认已合入 canonical main 且门禁全绿的精确 SHA，触发前跑 changelog gate，跳过须留理由。
11. **密钥不进 repo**，推公开 remote 前跑 secret scan。
12. **事务冲突同时重试 Prisma `P2034` 和 raw query `P2010` + SQLSTATE `40001`**。CLI 不得吞掉 metadata/agent-state 的 server `result:error`。
13. **Web 恢复只走 `resumeSync` → `sync.onWebResume` → `apiSocket.checkLiveness()`**；不用平行 focus/visibility 监听、最近收包判活或 `io.open()`。见 [恢复 spec](specs/2026-08-web-resume-sync.md)。
   agent 活性只由 `agentLiveness.ts` 计算：一次写入的 running tool 不是心跳；信号必须有新鲜度或替代过期条件，断网/隐藏期间暂停租约时钟。见 [租约 spec](specs/2026-09-agent-liveness-lease.md)。
14. **Web 按 session capabilities 判断 wrapper 能力，不按机器 CLI 版本**。权限执法唯一入口 `yoloEnforcement.ts`，只执法用户明确选择；出站清洗用 `normalizeClaudeOutboundMode`。
   新 mode 字段用 `z.string().nullable().optional()` + 读取白名单，并补实际生效值回报；未知 enum 会丢消息，漏 schema 字段会被剥除。普通 approve 不带 mode。见 [权限 spec](specs/2026-08-permission-mode-source-of-truth.md) 与 mode spec。
15. **reducer 输入按 seq 升序**；storage 与 reducer 入口保留 `sortIncomingBySeq`，乐观消息混批保持到达顺序。历史 DESC 回填不可绕过排序。
16. **Claude 认证先看 daemon 上下文的 `daemonState.claudeAuth`**，终端能用不代表 wrapper 能用；不注入独立 token/config 绕过凭据策略。复制 credentials 可能争用 refresh token，复制 `~/.happy` 可能争用 machineId；先分别核验，别把新机器上线推断成服务端踢旧机器。见 [认证 spec](specs/2026-09-claude-auth-preflight.md)。
17. **RPC resolve 仍可能是 `{ error }`**：Web wrapper 先检查 error 再读载荷。server/relay RPC 上限 30s，长任务用即返 id + 轮询。
18. **旁路 SDK query**：使用已确认 transcript 落盘的 live `Session.sessionId`，透传 `claudeEnvVars`，禁用 hooks；不要信 `/clear` 后旧 metadata id。见 [btw spec](specs/2026-09-btw-side-question.md)。
19. **tmux 探针分隔符仅用可打印 ASCII**，会话用 `$id` 而非名字定位。控制字符/locale 会改变输出；不同 tmux 版本行为需 gate，本地通过不代表 CI 通过。
20. **每个 session 至多一个活 wrapper**：所有 spawn/resume 都经 `claimSessionOrExit` 持锁；takeover 顺序为停旧→等退出→持锁→reactivate，停不掉则让位。多写者事故走「重启会话」，不手杀其中之一。见 [单写者 spec](specs/2026-09-session-single-writer-lock.md)。
21. **pi-acp 不透传 MCP，也不提供权限模式选择器**；MCP 走 `HAPPY_MCP_URL`（优先于终端上下文），权限走 `HAPPY_PERMISSION_MODE`/session-modes 文件，由 pi permission-gate 执法。不要把 thinking/model selector 当权限 mode。
22. **非 Claude runner 的 assistant 变体需显式传 `startHappyServer(session, { assistant })`**；新增 runner 支持时核对调用点，不能假定已透传。
