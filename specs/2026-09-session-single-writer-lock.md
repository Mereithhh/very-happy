# 会话单写者锁（session single-writer lock）——一个 happy session 只允许一个 wrapper

> 状态：Final ｜ 日期：2026-09-02 ｜ 关联 backlog：B-272（B-264 respawn 的加固） ｜ 代码：`packages/happy-cli/src/utils/sessionLock.ts`、`daemon/sessionProcessRecovery.ts`、`daemon/run.ts`

## 事故

会话「Tanka 待办提取（shanda + apodex）」同时被两个 wrapper 驱动（25691@22:19 与 17092@00:15，同一 `--resume 31c510f1…`）：每条用户消息前端显示 3 条、thinking 轨迹展开/收起闪动、yolo 权限模式来回翻。

链路：
1. `resume`/`restart-session` 成功后用 **spawn 前**（server/磁盘）的 metadata 重写 `sessions.json`，把 webhook 刚写入的新 `hostPid` 冲回上一个 wrapper 的死 pid（记录里是 8 月 28 日的 94251）。
2. daemon handover（CLI 升级）后只按 `hostPid` 认领 → 活 wrapper 25691 变孤儿。
3. 用户点「重启会话」→ `stopSessionAndWait` 在 daemon 的 pid 表里找不到它 → 直接 spawn 17092 → 两个 SDK 各跑一遍每条消息：Claude JSONL 写两条同文本 user 行（每个 wrapper 的 scanner 只按内容去重一条，各转发一条 + web 自己那条 = 3）、两路 thinking、两个进程各自 publish `permissionMode`（acceptEdits / bypassPermissions）互相覆盖。
4. 附带发现：杀掉其中一个 wrapper，它的 `deactivateSession` 让 server 广播 archive，**另一个也跟着退出**——多写者状态下任何单点处置都会归档整个会话。

## 不变式与执法点

**不变式**：同一台机器上，一个 happy session 任何时刻至多一个活 wrapper。

daemon 内存里的 pid 表做不到（handover 后靠持久化 `hostPid` 重建，可能过期）。执法点放在唯一确切知道自己身份的一方——**wrapper 本身，启动时、连 server 之前**：

```
~/.happy/session-locks/<happySessionId>.json   { pid, startedAt, version, flavor }
```

| 场景 | 行为 |
|---|---|
| 新会话（id 刚 mint） | 直接持锁 |
| reconnect（`HAPPY_RECONNECT_*`，即 resume / restart / assistant 重附着） | **takeover**：SIGTERM 持有者 → 2s 宽限 → SIGKILL → 确认其退出 → 再持锁 → 再 `reactivateSession`。顺序是要害：持有者退出时的 deactivate 会让 server 广播 archive，successor 若已连上就会被一起带走 |
| 持有者杀不掉 | 新进程 **让位**：不连 server、不报 webhook，`exit(0)`；daemon 侧表现为 webhook 超时错误 |
| 记录过期（pid 已死：SIGKILL、崩溃、codex 无 SIGTERM handler） | 直接覆盖；活性判据 `kill(pid,0)`，与 daemon 一致 |
| 退出 | `process.on('exit')` 只删自己的记录；漏删无害 |

daemon 以锁为**事实源**读取「谁在跑 session X」：启动认领、`restart-session` 停旧、`resume-happy-session` 幂等判活。仅对**早于锁的存量 wrapper** 退回 `hostPid` → `--started-by daemon --resume <id>` 命令行匹配（排除 SDK 子进程与用户终端的 `--resume`，见 `sessionProcessRecovery.ts`）。

## daemon 侧配套（同 PR）

- `persistRestoreRecord`：spawn 后的 restore 记录 = server 会话真相（claudeSessionId 等）+ **新 wrapper 的 `processIdentityFields`**（hostPid/version/…）与 webhook 上报的 seq/版本；不再用 spawn 前的副本冲掉。
- 启动认领：锁 → hostPid → 命令行；多余的活 wrapper 按同 session 记为 duplicate 并 `warn`，**不在此处杀**（见事故第 4 条）；`restart-session` 是唯一的收敛路径，它先停掉该 session 的**所有**活 wrapper（含未跟踪）再 relaunch。
- `resume-happy-session` 发现未跟踪的活 wrapper → 认领 + 幂等成功，不再并排 spawn。
- webhook 发现同 session 出现第二个活 wrapper → `warn`。

## 兼容矩阵

- 新 CLI × 旧 wrapper（升级前已在跑、无锁）：daemon 靠 hostPid/命令行认领；restart 时新 wrapper 的 takeover 只看锁，旧 wrapper 由 daemon 的 `stopSessionAndWait` 停掉——两层各覆盖一半，合起来完整。
- 无 daemon（用户终端直接 `happy claude`）：新会话 id 唯一，锁只做记账。
- 不涉及 server/Web/协议。

## 验收

- [x] `sessionLock.test.ts`：free / yield / stale overwrite / takeover 等待退出后才持锁 / SIGKILL 仍活则让位 / 自锁幂等 / release 只删自己 / 垃圾记录视为无锁。
- [x] `sessionProcessRecovery.test.ts`：锁 pid 优先、hostPid 过期按命令行认领、重复 wrapper 列出、SDK 子进程与终端 `--resume` 不匹配、codex 线程 id。
- [x] happy-cli build + vitest 全绿、tsc 0、`--version` 冒烟。
- [ ] 真机：发 CLI tag 后 mac-office 升级 daemon；对一个存量会话点「重启会话」，`session-locks/<id>.json` 出现且 pid = 唯一 wrapper；再做一次 daemon handover 后 `/list` 仍含该会话。
