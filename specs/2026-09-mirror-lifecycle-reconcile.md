# 终端 mirror 生命周期对账（mirror lifecycle reconcile）

> 状态：Final
> 日期：2026-09-01 ｜ 关联 backlog：B-271（接 B-105 终端镜像、B-107 输入门）｜ 出处：3 轮对抗式 review（草稿 `skills/tmp/mirror-lifecycle/design-v1..v3.md`）

## 背景
Owner 实报：mac-office 上手敲 `claude` 的终端，Web 里「xterm ↔ 结构化视图」切换按钮（toggle）会消失，且再次「恢复」出来的会话也不出现该按钮。根因是 mirror 绑定被单向丢弃后无反向重建路径。

## 根因（代码已确认）
终端 mirror（B-105）：daemon 把手敲的 `claude`（tmux pane `vh-<terminalId>`）镜像进一个 shadow `ApiSessionClient`；Web 在该终端有 `mirrorSessionId` 时才显示 toggle。

- `SessionEnd` hook → `endBinding`：`status='ended'`、`lifecycleState='archived'`、`deactivateSession`，**但绑定留在 map**。
- daemon 重启 `restore()` **只**恢复 `lifecycleState==='running'` 的持久化记录 → archived 记录被丢 → 该终端无绑定 → 无 `mirrorSessionId` → toggle 消失，而 pane 里 `claude` 其实还在跑。
- 没有任何「pane 观测到 claude 活着 → 反向重建绑定」的路径，`observeTerminalList` 只会在 `agentState==='shell'` 时 **end** 绑定，从不 adopt。
- 单向可观测：一旦 end/丢，只能等下一次 `SessionStart` hook（用户不会主动重开），期间 toggle 永久缺失。

## 目标
- pane 里 claude 可观测在跑、但绑定丢了/被 end 了的终端，自动重建/重激活绑定，toggle ~10s 内自愈。
- 覆盖两条丢失路径：①`SessionEnd` 误 end（claude 未真退）；②daemon 重启 restore 跳过 archived。
- Owner 当前那 2 个卡住终端无需手动重开 claude 即自愈。

## 非目标 / 不变式
- **`SessionEnd` 仍权威地 end**（不弱化）——B-107 输入门 `isMirrorInputAllowed = status==='active'` 依赖「claude 确在跑」这条强不变式；pane 是共享地址，误 active 会把 Web 输入粘进 pane 里实际的进程。
- 不放宽 `restore()` 的 running 闸（启动期无 agentState，会把 pane=shell 的也短暂重激活 → thrash）。
- 不做 restore-spawn 直绑（`claude --resume` 自会触发 `SessionStart`）。

## 方案：一个声明式 reconciler，跑在 signature-无关的每 tick 上
`observeTerminalList` 今天只经受 signature 短路的 `pushTerminalList` 调用 → 稳态终端不触发，无法用于自愈。故：

1. **新增无条件 per-tick observer**（`webTerminal.ts listTrackTick`，在 signature 短路**之前**调 `mirrorTickObserver?.(list)`）→ 经 `apiMachine.setMirrorIntegration` + `run.ts` 路由到 `mirrorManager.reconcile(list)`。
2. **三值 liveness gate**：pane 的 `agentState`（`working|needs_input|idle|shell|undefined`）不足以判定「是 claude」——裸 `node` 也算 `idle`。新增 `isClaudeConfident(tail)`：只在 claude 专属 TUI 证据（`Do you want`/`Would you like to proceed`/`❯ 1.` 选择框/`esc to interrupt`/`? for shortcuts`/`bypass permissions on`/`⏵⏵`）为真时才允许 adopt/reactivate。**排除** `(y/n)`、命令名等任何工具都可能有的串。stamped 进 `TerminalListItem.claudeConfident`（daemon 内部字段，不推给 Web、不进 signature）。
3. **`reconcile(list)`**（`mirrorManager.ts`，每 tick）：
   - `agentState==='shell'` + active 绑定 → `endBinding`（pane 观测兜底）。
   - `claudeConfident` 且 **map 有 ended 绑定** → **就地重激活**（复用同一 open client，endBinding 从不关 client，只 teardownBinding 关；`backfill-tail` 重挂 scanner）——**绝不**新建第二个 client（会孤立 live 的那个）。
   - `claudeConfident` 且 **map 无绑定**（重启后 restore 跳过 archived）→ `adoptPersisted`：从该终端 flavor=terminal-mirror、machineId 匹配、`savedAt` **最新**的持久化记录经持久化 key 重连（B-051：不重 mint tag）。
   - 非 `claudeConfident`（含 `undefined`：vim/htop/probe timeout）→ **不动**。
   - 每个决策在 chain 闭包内 re-check `bindings.get(id)?.status`（在途 hook 可能已改状态）。
4. **`reactivateSession`（F4）**：每一处 ended→active 都 `await deps.api.reactivateSession` 清 server archive tombstone，否则本地 running / server archived、Web 仍隐藏 toggle。失败 → 打 `needsReactivate`，reconciler 后续 tick 对 active+needsReactivate 重发直至成功。
5. **hysteresis（防闪烁）**：claude 退出后 pane tail 残留 footer 一两个 tick → 短暂读 idle/working → 会重激活刚 end 的会话。加 per-terminal `lastEndedAt`，end 后 `RECONCILE_HYSTERESIS_MS`(20s) 内不重激活。稳态卡住终端（真 bug）无 flip，不受影响。

## 3 轮对抗 review 收敛点
- v1「把权威反转给 pane、`SessionEnd` 不再 end」被 Round-1 否决：agentState 太弱、破 B-107 不变式。改为保留 `SessionEnd` 权威 + 新增 reconciler。
- Round-2 补 4 处正确性坑：ended-in-map 就地重激活（防双 client）、`reactivateSession` 失败重试、chain 内 re-check、claude→shell 闪烁 hysteresis。
- Round-3 补 claude-confident gate（裸 node 排除）、`adoptPersisted` 取**最新** record（同终端多条累积）、`backfill-tail`（非 from-eof，覆盖 gap 窗口）。

## 会自愈 Owner 那 2 个卡住终端吗——会
持久化记录在（<14d、从不清）、pane claude 正向、map 无绑定 → reconciler `adoptPersisted`+`reactivateSession` → toggle ~10s 回来，无需手动重开 claude。

## 测试
- `isClaudeConfident`（`webTerminal.test.ts` +8 例）：permission/select/footer 正向；裸 shell、`(y/n)`、vim/htop 负向；只读最近 15 行（scrollback 陈旧 prompt 不算）。
- `mirrorManager.reconcile.test.ts`（新建，6 例）：claude 正向+map 无 → adopt+reactivate 且取最新 record；claude 正向+ended-in-map → 就地重激活断言**不新建第二 client**；hysteresis 窗内不 re-adopt；非 confident（含 undefined）→ 完全不动（B-107）；`reactivateSession` 返 false → 下一 tick 重试；pane=shell → end。
- 门禁：CLI tsc 0 / vitest 1412 全绿 / build / `--version` smoke 绿。

## 改动文件
`webTerminal.ts`（`isClaudeConfident` + probe 返回 claudeConfident + `mirrorTickObserver`）、`apiMachine.ts`（`onTerminalListTick` 布线）、`run.ts`（路由到 `reconcile`）、`mirrorManager.ts`（`reconcile`/`adoptPersisted`/`reactivateInPlace`/`reactivate` 重试/hysteresis）。纯 CLI/daemon 改动，无 web/server 部署。

---

## 补记（B-304，2026-09-03）：reconciler 救不了「从来没绑上过」的终端

上面那句「会自愈 Owner 那 2 个卡住终端」有一个未写出的前提：**持久化记录在**。
`adoptPersisted` 复活的是一条**成功创建过**的记录；创建本身失败时，磁盘上什么都没有，
reconciler 每 10 秒看见一个 claude 正向的面板，却永远无从下手。

现场取证（mac-office，2026-09-03）：12 个 vh-* 面板全部在跑 claude，其中 2 个从来没有过
绑定，`~/.happy/sessions.json` 里零条记录；日志给出确凿原因——

```
[02:19:06] [MIRROR] hook handling failed for terminal e26c22d1d079: status code 429
[10:51:26] [MIRROR] hook handling failed for terminal af794aaa7981: status code 429
```

近四天 33 次。`createBinding` 的 `getOrCreateSession` 抛错，被 `handleHookPayload` 的
catch 吞成一行 debug 日志。而 hook 是**一次性事件**：claude 启动那一瞬间发一次，
不会再来。于是那台终端接下来几个小时都没有 toggle，用户唯一的出路是重开 claude。

429 有两种含义，而当时的日志分不出来——`limit-reached`（账号 500 会话上限，得清理才好）
与 `session_state_rate_quota_exceeded`（账号级 `session_state` 写速率桶，600 units/min，
一分钟内自愈）。同一天前后的创建都成功，所以实际是后者：**会话创建与所有会话的 metadata
抖动共用同一个预算**，终端一多就会互相挤掉。`api.describeSessionCreateError` 现在把服务端
的 `error` 码带进异常消息，下次一眼可辨。

### 修法
失败的 hook 事件 park 在内存里，由**同一个** reconcile tick 重试——它本来就每 10s 跑一次、
本来就按 `claudeConfident` 把门，等于免费拿到「只在那个面板确实还在跑 claude 时才重试」。
策略是纯函数（`mirror/mirrorPendingCreate.ts`）：退避 10s→30s→60s→120s→300s，30 分钟封顶。

三条不变式：
- **park 优先于 `adoptPersisted`**。park 指的是**此刻**在跑的那个 claude；持久化记录按定义
  是更早的对话。反过来会把上一轮对话镜像成这一轮。
- **面板回到 shell、终端关闭、同终端来了新 hook** 都清掉 park。其中 `SessionEnd` 只有在
  claude session id 与 park 的一致时才算数——`/clear` 的顺序是 SessionEnd(旧) → SessionStart(新)，
  一条迟到的旧 end 不能把新对话的 park 扔掉。
- **两种失败形状都要 park**：4xx 抛异常，5xx/404 返回 `null`。后者原本只打一行
  「server unreachable — dropping mirror bind」，同样是永久丢失。

### 刻意不做：把 park 落盘
观测到的失败都是秒级抖动，第一或第二个 tick 就修好。重试窗口内 daemon 重启会丢掉 park
（那个 claude 直到重启才恢复），但为这种罕见叠加换一个可能自己变陈旧的磁盘状态文件不划算。
有反例再说。

**存量终端不会自愈**：它们连 park 都没有（daemon 早已重启过），只能等下次在里面启动 claude。
