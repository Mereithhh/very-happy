# jojo-agent × happy 联动（Tanka 通道：spawn / send / webhook 回报）

> 状态：Shipped（P0 spawn `1984b3f3`，webhook 通知 `f7986880` + 会话链接 `6aeb7d70`，
> send 子命令 `7d1ac8c1`；对外契约沉淀为 `docs/channels.md` + 设置页 `9252fc53`）
> 日期：2026-08-12 ｜ 关联 backlog：（早于 backlog.md 建立）
> 出处/前身：skills repo `happy/references/jojo-agent-happy-design.md`（v1 草案），
> 2026-08 迁入本目录并按模板重排。P3（board 来源标注）未做。

## 背景

jojo-agent（Tanka 个人账号自动化）的任务执行原是 headless `claude -p`，
不可观看、不可介入。目标是升级为「起一个 happy session」：任务全程可在
happy web 观看、随时人工介入；并支持在 Tanka 用 `[happy]` 指令直接下发。

## 目标

- Tanka 消息 `[happy] <任务>` → 在 mac-office 上 spawn 一个 happy remote 会话，
  ack 带可点开的 session URL。
- 任务完成 / 需要介入 → 经账号 webhook 自动回报进 Tanka 群。
- 对通知的 quote-reply → 消息直接送回该 session（人工介入闭环）。

## 非目标

- 不放宽「仅限自己发的消息触发」的约束（公司 IM 里远程触发
  `--dangerously-skip-permissions` 会话，安全红线）。
- jojo-agent 的 kill 面板不接管 happy session；杀会话用 happy 自身
  abort/archive。v1 接受两套控制面。

## 现状事实（代码已确认，设计时快照）

| 事实 | 位置 |
|---|---|
| jojo-agent：mac-office launchd 常驻 `jojo-agent-gw.mjs`（消费 go-sg 网关 SSE），sigil `[agent]/[agent-r]/[agent-a]` | skills repo `tanka/scripts/` |
| happy daemon 本地 control server：`POST /spawn-session {directory, sessionId?, ...}` | `packages/happy-cli/src/daemon/controlServer.ts` |
| 现成客户端 `spawnDaemonSession(directory, sessionId?)` | `packages/happy-cli/src/daemon/controlClient.ts` |
| web 端 spawn 走 server→machineRPC `spawn-happy-session`，支持 spawn 后发首条消息 | `packages/happy-web-v2/src/sync/ops.ts`（2026-07 `388019d4`） |
| happy→Tanka 通知：账号 webhook → apodex-bot `happy-notify` endpoint → 群 | server webhook 路由 + apodex-bot（endpoint id 25） |

## 设计

### A. `[happy]` 指令（tanka → happy）

`jojo-agent-gw.mjs` dispatcher 加第四个 sigil `[happy]`（判定顺序：`[happy]`
全字匹配优先于 `[agent*]` 家族；首字符 h/a 不同，无前缀冲突）：

1. 收到 `[happy] <任务描述>`（可带 `cwd=<path>`，默认 `~/code/github/skills`）。
2. **实现选型（已定）**：给 CLI 加 `very-happy spawn --cwd <dir> --prompt <text>`
   子命令（内部 = controlClient spawn + 经 server API 发首条消息，复用 web 的
   spawn+首条消息路径）。jojo-agent 只 exec 这一条命令，边界干净、可独立测试。
   备选（dispatcher 直接 import controlClient）被否：耦合 very-happy 内部包。
3. 回 Tanka ack：`已开 happy 会话：https://happy.mereith.com/session/<id>`。
4. 完成通知不新做，依赖账号 webhook → apodex-bot → 群。

### B. 双向介入语义

- happy web 里对该 session 发消息 = 人工介入（原生支持，零开发）。
- 通知消息尾行带可解析的 `session: <id>`，适配器对 quote-reply 解析后
  `very-happy send` 回注（P2，已实现，契约见 `docs/channels.md`）。

### C. 渐进路线与实现状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `very-happy spawn` 子命令（spawn + 首条消息 + 输出 session URL） | ✅ `1984b3f3` |
| P1 | jojo-agent 加 `[happy]` sigil → exec spawn → ack 带 URL | ✅（skills repo 侧） |
| P2 | 完成回报回原 Tanka 会话（`session: <id>` 尾行 + `very-happy send`） | ✅ `6aeb7d70` |
| P3 | 与 task board 打通：`[happy]` 下发的任务在 board 标注来源 | ⏸ 未做 |

## 兼容矩阵与发布顺序

- `spawn`/`send` 是 CLI 新增子命令，纯增量；webhook payload 加尾行为
  纯文本追加，旧接收端不受影响。server（webhook 事件）先发，CLI 随后。

## 风险

1. `[happy]` = 公司 IM 远程触发本机 skip-permissions 会话：**仅限 self userId
   触发**（jojo-agent 既有约束），不放宽。
2. happy session 经个人 server 中继（既有取舍，心里有数）。
3. daemon control server 是本地端口无鉴权（同机信任）：jojo-agent 与 daemon
   同机成立；若 dispatcher 挪机器，必须改走 server 侧带凭据的 machineRPC。

## 验收标准

- [x] Tanka 发 `[happy] <任务>` → 群里收到 ack 带 session URL，点开可看
- [x] 会话完成/需权限 → 群里收到通知
- [x] quote-reply 通知 → 内容回注进原 session
- [x] 非 self userId 的 `[happy]` 消息不触发

## 留真机验证项

（无——链路已在 Tanka 群实测。）
