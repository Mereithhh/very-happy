# 终端自动恢复（auto-restore）

> 状态：Shipped（commit `89b8cfb0` + shutdown 守卫，发布 v0.2.53/v0.2.54，2026-08-24 真机验收通过）
> 日期：2026-08-24 ｜ 关联 backlog：B-150 ｜ 前身：`2026-08-terminal-tombstones.md`（B-149）

## 背景

B-149 让机器重启后的终端**留下痕迹**（归档行带 cwd + claude 会话 id，可一键 ↻ 接回）。
Owner 审阅后提出的真实诉求比这更前一步：

> 「重启后我打开 happy，5 个终端都在，claude 都在原来对话里，我不用点任何东西。」

差距只在最后一步：素材（快照、cwd、`terminalId → claudeSessionId` 精确映射）B-149 已经全部具备，
缺的是把「人在 web 里点 ↻」换成「daemon 启动时自己做」。

## 目标

1. daemon 启动（登录后 launchd 拉起）时，自动把**最近的工作集**重建：原 id、原目录、原标题，
   并注入 `claude --resume <原会话>`，用户打开 happy 即见终端在跑。
2. 自动恢复必须**不会变成资源事故**：实测单个 idle claude ≈ 400MB，2026-08-23 的工作集 22 个 = 9.1GB / 24GB。
3. 跳过的每一条都要**说出来**（日志 + 账号通知）：静默截断会被读成「全恢复了」。

## 非目标

- 不恢复进程与 scrollback（tmux 不持久化，`snapshotStore` 是内存态 TTL 90s；物理不可行，cmux 同理）。
- 不做「无人登录也能恢复」：FileVault 解锁前磁盘未挂载，任何自启都不存在。**必须有人登录一次**。
- 不恢复裸 shell 终端（无 claude 会话）——手工开一个很便宜，不值得占预算。
- 不做 web 端开关 UI（见下：CLI 读不到同步设置，这是刻意的机器级配置）。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 重启后的快照对账与 `daemon-gap` 记账已就绪，记录带 `claudeSessionId` | `terminal/webTerminal.ts` `reconcileRestoredSnapshot`（B-149） |
| `terminalId → claudeSessionId` 只认精确匹配（`pickMirrorForTerminal`） | `terminal/liveTerminals.ts` |
| 启动命令注入是纯 argv（`send-keys -l --` + `Enter`），tmux 不解析内容 | `terminal/webTerminal.ts:startupInjectionArgs` |
| `VH_TERMINAL_ID` 是 **create-only** env 标记，手敲 claude 靠它绑回 mirror | `terminal/webTerminal.ts`（B-105）、`mirror/mirrorProtocol.ts` |
| **CLI 读不到 web 的同步设置**（客户端加密 blob），已有先例把开关放本机 | `persistence.ts` `boardLlm` 注释 |
| 账号通知有现成出口（`/v1/webhook/notify`） | `terminal/terminalNotify.ts` + `api/apiMachine.ts` |
| 单个 claude ≈ 400MB / 22 个 = 9.1GB（24GB 机器，可用 91%→36%） | 2026-08-23 mac-office 实测 |

## 设计

**配置（机器级，本机 `~/.happy/settings.json`）**
`terminalAutoRestore`（默认 **true**）、`terminalAutoRestoreMax`（默认 **6**，硬上限 20，`0` = 关）、
`terminalAutoRestoreWindowHours`（默认 **24**）。放本机而非同步设置有两个理由：CLI 物理上读不到同步 blob；
且内存预算是**这台机器**的属性——同步过去反而是错的。容错读取：字段畸形回落默认值，不静默关闭功能。

**筛选（纯函数 `terminal/autoRestore.ts`，`selectAutoRestore`）**，顺序即优先级：
1. 活着的绝不碰（`still-live`）——这也是重复重启幂等的第一道保证；
2. 超出 recency 窗口的丢弃（`stale`）——重启本身**也是一次清理**，自动恢复不该把上周忘关的僵尸请回来
   （8-23 那 22 个里约一半是泄漏的）；
3. cwd 不存在则跳过（`missing-cwd`）——**绝不**替换成别的目录；
4. 无 claude 会话则跳过（`no-conversation`）；
5. 按最后活着时间倒序，**cap 在所有过滤之后**应用（`over-limit`）——坏条目不能占掉好条目的名额。

**执行（`webTerminal.autoRestore` / `restoreOneTerminal`）**
- 串行，每个间隔 `AUTO_RESTORE_STAGGER_MS = 2000`；六个 claude 同时起会互相抢 CPU/IO。
- 冷建：`tmux new-session -d` + 与交互路径**同一套 create-only env**（renderer / `VH_TERMINAL_ID` /
  `VH_HAPPY_HOME_DIR`）→ 写回 `@vh_title`（**不**打 manual 标记，让自动跟随随后接管）→
  `startupInjectionArgs` 注入 `claude --resume <uuid>`。不挂 pty：会话保持 cold，等 web 打开再 attach。
- `VH_TERMINAL_ID` 是关键而非装饰：少了它，恢复出来的 claude 绑不回 mirror，**下一次重启就再也找不到对话**。
- 幂等三道：只跑一次（`autoRestoreDone`）、活着的不选、创建前 `has-session` 复查。
- 命令由 `autoResumeCommand` 唯一构造，非 uuid 直接 throw（这个字符串会被执行）。

**汇报**
`autoRestoreSummary` 生成一行（`Restored 1 terminal, skipped 3 (2 over limit, 1 directory gone)`），
进 `logger.info` 并经 apiMachine 走账号通知；`still-live`/`disabled` 不算损失、不汇报；全无事发生时返回
null，普通重启保持安静。

**UI（web）**
被自动恢复的终端在列表里带一枚安静的「已恢复」标记（tooltip 说明：目录相同、对话已接回、进程是新的、
屏幕历史从头开始）。标记是 daemon 内存态、**打开该终端即清除**（`clearRestoredMark`），
不写进标题——标题会被 `pane_title → @vh_title` 自动跟随覆盖，写进去只会打架。

## 兼容矩阵与发布顺序

| 组合 | 行为 |
|---|---|
| 新 daemon + 旧 web | 恢复照常发生；`restoredAt` 未知字段被旧 web 忽略，只是没有 badge |
| 旧 daemon + 新 web | 无 `restoredAt` → 无 badge；其余不变 |
| 关闭 | `terminalAutoRestore: false` 或 `terminalAutoRestoreMax: 0`（B-149 的归档 + ↻ 保持可用） |
| 回滚 | 删除 `live-terminals.json` 即无素材可恢复；无迁移、无 schema 变更 |

发布顺序：CLI 先（daemon 是执行者），web 后（只影响 badge）。server 不涉及。

## 风险

1. **恢复风暴** → cap 6（硬上限 20）+ 24h 窗口 + 串行 2s；`0` 可完全关闭。
2. **重复恢复** → 三道幂等（见设计）；真机测试断言同名会话恰好一个。
3. **接错对话** → 只认 `metadata.terminalId` 精确匹配，绝不 cwd+时间猜测。
4. **把僵尸请回来** → recency 窗口；重启的清理效果不被抵消。
5. **写脏原始 transcript** → 接受（这正是「接着聊」的定义）；`--fork-session` 留作后续开关，本次不做。
6. **无人确认执行命令** → 命令只由 uuid 拼装（`autoResumeCommand` 会 throw），素材只来自**本机 daemon 自己写的**
   快照，不接受任何外部输入；注入走 `send-keys -l --`，tmux 不解析内容。
7. **测试污染真实环境**：unit 项目不隔离 `HAPPY_HOME_DIR`（集成项目隔离）→ 本次两个新测试各自 mkdtemp 并在
   afterAll 还原 env。遗留面仍记为债。

## 验收标准

- [x] 纯函数单测 14 条（默认值/畸形值/硬上限、窗口、cwd、无对话、cap 在过滤之后、禁用、uuid 拒绝、汇报口径）
- [x] 真机 tmux 集成测试 `webTerminal.autorestore.test.ts`：空 `TMUX_TMPDIR` 复现重启现场 →
      断言只恢复该恢复的那个、cwd 正确（realpath 比较）、`@vh_title` 带过来、`VH_TERMINAL_ID` 就位、
      pane 里真的敲了 `claude --resume <uuid>`、badge 已标、同名会话恰好一个
- [x] B-149 的归档测试显式关掉自动恢复，两个行为互不遮蔽
- [x] cli 门禁：`pnpm build` 0 + unit 1140 全绿 + `--version` 冒烟
- [x] web 门禁：1372+1 测试 + `tsc --noEmit` 0 + `vite build`
- [x] **真机验收 2026-08-24**（mac-office，v0.2.53）：daemon stop → kill `vh-c75d6592d623` → 起 daemon →
      终端**自动回来**：cwd `~/code/github/skills` 正确、`@vh_title`「阅读交接指引文档」带过来、
      `VH_TERMINAL_ID` 就位、pane 里确实是 `claude --resume 88520a9e-…`、claude 带着 **859715 tokens**
      的历史起来；日志 `auto-restored … / auto-restore: Restored 1 terminal`；账号通知已投递。
      第二次启动 `auto-restored` 计数为 0 → 幂等成立。

## 真机验收暴露的两件事（已修）

1. **恢复发生在正在关闭的 daemon 里**：那次验收的 daemon 已收到 SIGTERM（升级期的版本接管），
   仍跑完了恢复，随后 `Startup malfunctioned, forcing exit with code 1`（launchd 自动拉起下一个，
   且第二次没重复恢复）。tmux 会话不受影响，但恢复不该在 teardown 之后还推列表/发通知
   → 加 `shuttingDown` 守卫（`stopListTracking` 翻转），并补回归测试。
2. **LaunchAgent 的升级路径是坏的**（属 skills repo 侧，非本 repo）：`launchctl kickstart -k`
   只杀 job 顶层进程，**真正的 daemon 变成孤儿继续跑旧版本**，而包装脚本按「已有 daemon 就不抢」
   礼让退出 → launchd 永久失去托管、版本也换不掉。已改成「已装版本 ≠ 在跑版本 → 接管」，
   并用伪造版本号实测通过。
