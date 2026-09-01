# 会话可恢复性（offline session recoverable）+ 恢复 loading

> 状态：Final
> 日期：2026-09-01 ｜ 关联 backlog：B-268 ｜ 出处：4 轮对抗 review（草稿 `skills/tmp/session-recoverability/`）

## 背景
同事实报：本地机器上的两个 chat，机器离线后从「列表」消失、「归档」视图里也没有恢复标志，只能先手动归档才恢复得了。另：点恢复后 web 反应慢、无 loading 反馈。

## 目标
- 离线-非归档-可恢复的会话（机器重启后 wrapper 已死、**不会**自愈）在归档视图里直接有恢复入口，无需先手动归档。
- 机器离线时恢复入口显示但**禁用 + 原因**（等机器上线），不再「点了才报错」。
- 恢复进行中有明确 loading（chat + terminal）。

## 非目标
- 不做统一 `reviveSession`（web 拿不到 wrapper 存活/jsonl，daemon-only；会抹掉 `processFailed` 判别）。
- 不把离线会话留在「列表」（churn sidebarOrder prune、违背「列表=活跃集」）。
- 不重命名「归档」视图。
- `processFailed → restart`（B-264）不动。

## 现状事实（代码已确认）
| 事实 | 位置 |
|---|---|
| 侧栏「列表/状态」只显示 active，「归档」显示所有 `!active` | `sidebarRows.ts:22` |
| 恢复入口三处都门在 `isRestorable`（archivedAt-gated）；`isRestorable` 又驱动 `composerGate` | `Sidebar.tsx`、`CommandPalette.tsx`、`SessionDetailScreen.tsx`；`sessionRestoreRules.ts` |
| `restoreEligibility` 原 gate `archivedAt`，只被 `restoreSession()` 内部用 | `sessionRestoreRules.ts`、`sessionRestore.ts` |
| `machineResumeSession` = unarchive→resume→失败 re-archive；normalize+try/catch 必要，archive dance 不必要 | `ops.ts`、`sessionResumeFlow.ts` |
| 机器重启后 wrapper 已死的会话永不自动重生 | `daemon sessionProcessRecovery.ts` |
| 行菜单/命令面板 restore 与 archive 互斥（`if(restore) else archive`）| `Sidebar.tsx rowMenuItems`、`CommandPalette.tsx` |
| ChatHeader **无** restore；banner 是详情页（尤其移动端）唯一恢复入口 | `ChatHeader.tsx` |

## 设计
1. **`sessionRestoreRules.ts`**：`restoreEligibility` 去掉 archivedAt gate；新增 `canOfferRestore(session, machine)`（`!active ∧ backend-id ∧ machine-known`，archivedAt 无关、不要求 machine online）；`isRestorable`+`composerGate` 不动（离线会话 composer 仍直发）。
2. **三处按钮可见性** `isRestorable→canOfferRestore`（`Sidebar`/`CommandPalette`/`SessionDetailScreen`），传入会话自身的 machine。机器离线时**显示但禁用**，reason=machine-offline。
3. **解耦 restore/archive**：`rowMenuItems` 与 `CommandPalette` 把 restore（canOfferRestore）与 archive（`archivedAt==null`）改为独立项——离线-非归档会话两者并存；已归档只有 restore。
4. **绕开归档补偿**：`machineResumeSession` 加 `skipArchiveDance`（no-op unarchive `supported:false` + no-op rearchive，保留 normalize+try/catch）；`restoreSession` 对 `archivedAt==null` 走该路径，**失败不误归档**。
5. **banner 文案分叉**：`archivedAt==null` 显示「离线·可恢复」（新增 `restore.offlineNotice`）+ `Unplug` 图标；已归档「已归档」+ `Archive`。**保留 banner 按钮**（详情页唯一恢复入口，移动端无侧栏）——见「取舍」。
6. **loading（§7）**：chat 无新代码（行内联 spinner 一直可见 + banner 叙述，靠 `:1298` 一个 const 同门控菜单项与 spinner，flip 时一并生效）；terminal 新增 `restoringTerminals` pending set，reopen 按钮在 `restoreSupported` 分支 RPC 期间 spinner + disabled。

## 取舍（Owner item 1）
Owner 提「归档 banner 的大恢复按钮和下拉菜单冗余，去掉」。核查发现 **ChatHeader 无 restore**，banner 是详情页（尤其移动端侧栏隐藏时）**唯一**恢复入口——直接删会在移动端丢失恢复能力。故本次**保留 banner 按钮**，只按 archivedAt 分叉文案/图标。若仍要去掉，应先把 restore 移进 ChatHeader 菜单，另议。

## 兼容 / 发布
纯 web（无 server/CLI/协议）→ 只需 web deploy（随 server 镜像）。旧 daemon：resume 幂等 live-check 防双 spawn。codex：`canOfferRestore`/`restoreEligibility`/RPC 均 flavor-agnostic。

## 风险
1. 误归档：`skipArchiveDance` 绕开补偿（`sessionResumeFlow.test.ts` 覆盖）。
2. composer 回归：`isRestorable`/`composerGate` 保持 archivedAt-gated（单测守卫）。
3. 离线机器按钮：显示但禁用+原因，不报错、不自动重试。

## 验收
- [ ] 归档视图里离线-非归档-有 backend id 的会话，行菜单/命令面板出「恢复」；机器在线可点、离线禁用+原因。
- [ ] 该会话仍可从菜单/命令面板「归档」。
- [ ] 恢复失败不把会话误归档。
- [ ] 离线会话 composer 仍直发。
- [ ] banner 非归档显「离线·可恢复」、已归档显「已归档」。
- [ ] 恢复中：chat 行 spinner、terminal reopen spinner。
- [ ] 门禁：web tsc 0 / vitest（含改写+新增）/ build。

## 留真机验证项（转 verify-queue）
- 真实 root 机器重启后一个离线 chat 从归档视图一键恢复；移动端 banner 观感。
- 终端 reopen 期间 loading；恢复成功跳转、失败 alert。
