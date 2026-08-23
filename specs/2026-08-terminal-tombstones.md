# 终端墓碑与会话续跑（restorable terminals）

> 状态：Final（实现完成，门禁全绿；待真机验收后转 Shipped）
> 日期：2026-08-23 ｜ 关联 backlog：B-149 ｜ 出处：Owner 2026-08-23 机器重启后 22 个终端全丢的实战

## 背景

2026-08-23 mac-office 重启（10:58）。tmux server 随之消失，22 个 `vh-*` 终端连**痕迹**都没留下：
既不在活终端列表，也不在「已结束终端」归档里——因为 close 记录是 daemon **观察到**终端结束时才写的，
而重启这一刻 daemon 自己也死了，没人记账。Owner 只能靠 52MB daemon 日志 + `sessions.json` 手工反推出
终端 id 与对应的 claude 会话，再手搓 tmux 恢复。

痛点是「重启后不知道自己刚才在干什么」，而不是「pty 没了」：终端里跑的 claude 对话本身在磁盘上
（`~/.claude/projects/<cwd>/<uuid>.jsonl`），`claude --resume` 能接回来。缺的是**记账**与**一键续跑**。

## 目标

1. daemon 重启 / 机器重启后，之前活着的终端出现在「已结束终端」归档里（带 title + cwd），不再凭空消失。
2. 归档行能一键**续跑**：新建终端到原 cwd，并自动 `claude --resume <原会话>`，对话接着。
3. 全部新逻辑是纯函数 + 单测（PROCESS §3 纪律）；不新增定时器、不新增 npm 依赖。

## 非目标

- **不恢复屏幕内容/scrollback**：`snapshotStore` 是内存态（TTL 90s，无落盘），要做得另立一项（原 L3）。
- 不恢复正在跑的进程（tmux 不持久化，物理不可能）。
- 不做「一键恢复全部」：22 个 claude 实测 9.1GB RSS / 24GB 机器，批量拉起是资源事故；逐个点是特性不是缺陷。
- 不动 codex/其它 flavor 的 resume（只做 claude）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 活终端列表**由 tmux 成员关系重建**（`list-sessions` + `@vh_title`），tmux 没了列表就空 | `packages/happy-cli/src/terminal/webTerminal.ts:38,2258` |
| close 记录只在 daemon 观察到结束时追加，落盘 `closed-terminals.json`，纯函数 + 上限 20 | `terminal/closedTerminals.ts`，路径 `webTerminal.ts:143` |
| 记录经 `daemonState.closedTerminals` 推给 web，zod 白名单 | `api/types.ts:179,234` |
| web 归档视图已渲染「已结束终端」，动作=同目录新终端 | `happy-web-v2/src/sync/closedTerminals.ts`、`screens/sessions/Sidebar.tsx:926` |
| `open-terminal` 已支持 `cwd` + `startupCommand`（仅在真正新建时注入） | `webTerminal.ts:179,1719`、`api/apiMachine.ts:300,311` |
| **terminalId → claudeSessionId 映射已经在持久化里**：mirror 会话 metadata 带 `terminalId`/`claudeSessionId`，14 天保留 | `persistence.ts:423,439`（实测 `sessions.json` 内 `flavor:"terminal-mirror"`） |
| 终端内手敲的 claude 靠 create-only 的 `VH_TERMINAL_ID` 绑回 mirror（B-105） | `webTerminal.ts:1650`、`mirror/mirrorProtocol.ts:7` |
| 外部创建的 `vh-<id>` tmux 会被列表 re-adopt（手工恢复可行的依据） | `webTerminal.ts:1591` |

## 设计

> 实现说明：关键洞察是**不需要新的对账算法**。关闭检测本来就是「拿 tmux 实况 diff 一份
> `{title,cwd}` 缓存」（`trackClosures` 的 `lastSeenInfo`），缺的只是这份缓存活不过进程。
> 所以 L1 = 把它落盘 + 启动时用同一套 diff 跑一次。

**L1 记账（daemon）**
1. 新纯函数模块 `terminal/liveTerminals.ts`：`LiveTerminalInfo {title?,cwd?,seenAt}`、
   `sanitizeLiveSnapshot`（容错 + TTL 14 天 + 上限 100）、`serializeLiveSnapshot`、
   `liveSnapshotChanged`（变更判据，让无变化的 tick 不写盘）、`pickMirrorForTerminal`、`isClaudeSessionId`。
2. 落盘 `~/.happy/live-terminals.json`，写入复用现有 list 刷新 tick（`persistLiveSnapshot`），
   仅在 id 集合 / title / cwd 变化时写；`seenAt` 漂移**不**触发写。
3. `reconcileRestoredSnapshot(liveIds)` 在 `trackClosures` 开头调用，**只跑一次**（跑完把
   `restoredSnapshot` 置 null）：快照里有、tmux 里没有、且 closed 记录里还没有 → 记一条
   `reason:'daemon-gap'`，`closedAt` 用**最后一次见它活着**的时间（不是 daemon 启动时间）。
4. `ClosedTerminalRecord` 加两个可选字段 `claudeSessionId?` / `reason?`，cap 20→40。
   `claudeSessionId` 来源**只有** `readPersistedSessions()` 里 `metadata.terminalId` 精确匹配的最新
   mirror 会话（`pickMirrorForTerminal`）——**不做 cwd+时间猜测**（同目录多开必错配；2026-08-23
   手工恢复时正是靠 terminalId 才精确）。普通关闭路径同样填这两个字段，所以不止「重启」能续跑。

**L2 续跑（web）**
5. `sync/closedTerminals.ts` 解析新字段并导出 `isClaudeSessionId` / `resumeStartupCommand`
   （构造 `claude --resume <uuid>` 的**唯一**地方）；行模型增 `claudeSessionId?` + `fromDaemonGap`。
6. 归档行动作：有 `claudeSessionId` → 「在原目录继续这个会话」（↻ 图标），
   `createTerminalAt(nav, machineId, cwd, claudeSessionId)`；没有 → 保持「在同目录开新终端」（+ 图标）。
   `reason:'daemon-gap'` 的行在副标题追加「重启时结束」。
7. **URL 只带 id，不带命令**：`/terminal/<m>?tid=..&fresh=1&cwd=..&resume=<uuid>`，
   `WebTerminalScreen` 再校验 uuid 并重建命令；`resume` 与 `fresh`/`cwd` 一起被 strip。
   这样构造出来的链接无法在别人 shell 里跑任意命令（`startupCommand` 本质=任意命令执行）。
   resume 请求**覆盖**全局「终端启动命令」设置：用户要的是这个会话，不是常规启动脚本。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 daemon + 旧 web | web 逐字段白名单解析，未知字段被忽略 → 归档行仍是「同目录新终端」 |
| 旧 daemon + 新 web | 无新字段 → `resumeSessionId` 缺失 → 退回原动作；`reason` 缺失按 `"closed"` 渲染 |
| 回滚 | 删 `live-terminals.json` 即回到旧行为，无迁移、无副作用；closed 记录多出的两个可选字段旧代码忽略 |

发布顺序：CLI 先（先开始记账，历史才攒得下来），web 后。server 不涉及。

## 风险

1. **假墓碑**：tmux 瞬时故障被当成终端全没 → 只在启动对账一次；且现有 `pruneClosedAgainstLive` 会在下一 tick 自愈。
2. **上限**：一次重启 22 个终端会挤掉旧记录 → cap 已由 20 提到 40（`CLOSED_TERMINALS_MAX`）。
   仍是有限的，接受：更旧的记录价值随时间衰减。
3. **claudeSessionId 陈旧**：会话 14 天后被 `readPersistedSessions` 过滤 → 续跑退化为「同目录新终端」，不报错。
4. **resume 拉起资源**：单个 claude ≈ 400MB（实测 22 个 9.1GB）→ 只逐个点，不提供批量。
5. **注入命令的信任面**：见设计 7，uuid 白名单校验两道（web 出、web 入）；`startupCommand` 走
   send-keys（tmux 不解析内容），与现有路径一致。
6. **unit 项目不隔离 `HAPPY_HOME_DIR`**（集成项目隔离，见 `installIntegrationEnvironment`）：
   构造 `WebTerminalManager` 的单测会读写真实 `~/.happy`，现在多了一个 `live-terminals.json`。
   本 spec 的新测试自己 mkdtemp 并在 afterAll 还原 env；遗留面记为技术债，不在本次范围。

## 验收标准

- [x] 自动化回归覆盖「重启后补记账」：`webTerminal.gap.test.ts` 用空的 `TMUX_TMPDIR`
      复现「tmux server 不存在」，断言 title/cwd/mirror/claudeSessionId/closedAt 与只跑一次
- [x] 无 `claudeSessionId` 的记录仍只显示「同目录新终端」，不报错（web 行测试）
- [x] `live-terminals.json` 只在集合/标题/cwd 变化时被重写（`liveSnapshotChanged` 单测）
- [x] cli 门禁：`pnpm build` 0 + unit 1121 全绿 + tmux 集成 19 全绿 + `--version` 冒烟
- [x] web 门禁：1372 测试 + `tsc --noEmit` 0 + `vite build` 成功
- [x] 新纯函数模块单测 12 条（TTL、上限、容错读盘、变更判据、uuid 校验、terminalId 精确匹配）
- [ ] **真机验收**（发版后）：重启 daemon → 归档视图出现「重启时结束」的行 → 点↻ → 新终端在原 cwd
      且 claude 带着历史起来（token 数非零）
