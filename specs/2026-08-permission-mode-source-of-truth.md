# Claude 会话权限模式唯一事实源（CLI 上报 + Web 只读显示）

> 状态：Shipped（`main@1def266e` #102；发布 `main@a0ce972c` + CLI v0.2.90，2026-08-31）
> 日期：2026-08-31 ｜ 关联 backlog：B-258 ｜ 出处：会话「Tanka 待办提取（shanda + apodex）」权限模式显示与实际不一致事故

## 背景

Owner 在 Web 选择器看到「Yolo 模式」，但 CLI 实际跑在 `plan`，批准计划后掉到
`default`，Bash 反复弹权限审批。日志（`cmtcqxdtu007vqh2a8m7ztix7`）证实：全程
没有任何 message meta 带 permissionMode，也没有 set-permission-mode RPC；
ExitPlanMode 批准时 `mode: undefined` → CLI 硬编码回退 `default`。

两层根因：
1. 创建竞态（#94 已修）导致该会话本地 permissionMode 为 null；
2. **显示与发送不同源**（仍在 main）：选择器显示 `session.permissionMode ??
   代码默认 bypassPermissions`，而 message meta / plan 批准只发本地值或用户
   override —— 本地为 null 的会话（另一台设备、清过 storage、外部 spawn、
   #94 之前创建）永远「显示 Yolo、实际按 CLI 启动参数跑」。CLI 从不上报
   自己的有效模式，Web 无从纠正。

## 目标

- Web 显示的权限模式 = CLI 进程此刻实际执行的模式，跨设备一致。
- 对话中途改模式立即生效（运行中与空闲都可），不必等下一条消息。
- 改模式同时更新该 agent 的 synced 默认，新会话继承（既有行为，保持）。
- 批准计划后默认进入 yolo（Owner 决策），显式选择更窄模式时尊重选择。

## 非目标

- Codex / Gemini / ACP 的同等上报（后续按同样模式补）。
- 旧 CLI（无本能力）的显示纠正 —— 回退到现状行为。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 显示取本地 ?? 代码默认 bypass | `packages/happy-web-v2/src/screens/session/AgentInput.tsx:164` + `sync/agentDefaults.ts:35` |
| meta 只发本地值或用户 override | `packages/happy-web-v2/src/sync/messageMeta.ts:19-23` |
| plan 批准带 `session?.permissionMode`，null → undefined | `packages/happy-web-v2/src/screens/session/PermissionCard.tsx:76` + `planApprovalMode.ts` |
| CLI plan 批准 mode 缺省回退 `default` | `packages/happy-cli/src/claude/utils/permissionHandler.ts`（handlePermissionResponse） |
| live RPC 仅运行中可用，空闲报 `No active Claude query` | `packages/happy-cli/src/claude/claudeRemoteLauncher.ts`（set-permission-mode handler） |
| abort 会把 currentPermissionMode 重置回启动值 | `packages/happy-cli/src/claude/runClaude.ts`（resetCurrentModeDefaults） |
| 本地模式为 device-local mmkv，不跨设备同步 | `packages/happy-web-v2/src/sync/storage.ts`（sessionPermissionModes） |
| 所有 session/metadata 更新都汇入 applySessions | `packages/happy-web-v2/src/sync/sync.ts:1129/2437/2517/2986` |

## 设计

**事实源 = CLI 进程内的有效模式，写入 `session.metadata.permissionMode`**
（SDK 词汇：default/acceptEdits/bypassPermissions/plan；server 持久化并广播）。

CLI（capability 新增 `claude-live-permission-v2`）：
- `runClaude.publishPermissionMode()` 单写者：启动（含 sandbox 强制 bypass 后
  的实际值）、message meta、live/空闲 RPC、plan 批准都经它写 metadata（去重）。
- `set-permission-mode` RPC 空闲也接受：无活跃 query 时只更新进程态 + metadata，
  下一轮 query 用它；pre-loop 与每轮 iteration 各有 handler。
- ExitPlanMode 批准：`response.mode` 缺省回退 **bypassPermissions**（Owner 决策）；
  显式 default/acceptEdits/bypassPermissions 照用。批准/approve-with-mode 引起的
  模式变化经 `setOnModeChanged` 回调统一 commit（队列 hash、本地 enforcer、
  metadata 三者一致）。
- abort 不再重置 permissionMode（用户选择是进程态，不是单轮覆盖）。

Web：
- `resolveSessionPermissionMode`（sessionModeSync.ts）：CLI 上报值存在且
  **发生变化**（或本地为 null）时覆盖本地；未变化时保留本地乐观值（RPC 往返
  窗口内不闪回）。接入 storage.applySessions 唯一汇聚点，并回写 mmkv。
- 选择器：v2 capability 且 presence online 时（运行中或空闲）都走 RPC；
  v1 沿用旧行为（仅运行中）。显示、message meta、plan 批准全部消费同一个
  `session.permissionMode`（已被 metadata 纠正）。
- `planApprovalMode`：`plan`/null/未知 → `bypassPermissions`。

## 兼容矩阵与发布顺序

| 场景 | 行为 |
|---|---|
| 新 Web + 旧 CLI（无 v2） | metadata 无该字段 → Web 回退现状（本地 ?? 代码默认）；RPC 仅运行中（v1） |
| 旧 Web + 新 CLI | 旧 Web 忽略 metadata 新字段；meta/plan 批准照旧发；CLI plan 缺省回退变为 bypass（Owner 接受） |
| 双新 | 完整闭环 |

发布顺序：server/web 先（同镜像，Web 判空安全），CLI 后（npm + mac-office
handover）；也可反序 —— 双向都只增字段。回滚点：任一端回旧版即回退到现状行为。

## 风险

1. plan 批准缺省回退 bypass 扩大了旧客户端的权限 —— Owner 明确决策（“默认进入
   yolo”），记录于本 spec 与 PR。
2. metadata 写入频率：publishPermissionMode 去重，只有变化才写。
3. 乐观值与上报值竞态：edge-trigger 规则 + busy 态覆盖，见 sessionModeSync 测试。

## 验收标准

- [x] CLI：plan 批准无 mode → bypassPermissions，回调触发（permissionHandler.test）
- [x] CLI：显式 acceptEdits 保留（permissionHandler.test）
- [x] Web：resolveSessionPermissionMode 四条规则（sessionModeSync.test）
- [x] Web：planApprovalMode plan/null/undefined → bypassPermissions（planApprovalMode.test）
- [x] Web：v2 空闲在线可走 RPC、离线不走（livePermissionMode.test）
- [x] 全量门禁（wire/cli/web/server）
- [ ] 真机：双设备打开同一会话，A 改模式 B 实时跟随；批准计划后 Bash 不再弹审批

## 留真机验证项

- 双设备模式同步、plan→yolo 批准链路、升级窗口（旧 CLI + 新 Web）显示回退 —— 登记 verify-queue。
