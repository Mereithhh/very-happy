# 全局 Task Board（V1 聚合看板 + V2 LLM 分析/任务下发）

> 状态：Shipped（V1 commit `b57cbb8a`，V2 commit `8c6b01f1`；后续泳道拖排 `075d0116`）
> 日期：2026-08-12 ｜ 关联 backlog：（早于 backlog.md 建立）
> 出处/前身：由 Plan agent 产出于 skills repo `happy/references/task-board-v2-plan.md`，
> 2026-08 迁入本目录并按模板重排，技术内容未改。

## 背景

单人 Owner 同时开多个 agent 会话 + 多台机器的终端，缺一个「哪里需要我」的
全局视图。cmux 的 workspace 侧栏（attention 高亮 + 每卡片富状态行 + 任务驱动
派生工作区）是参考对象。

## 目标

- V1：一个 `/board` 看板路由，把 chat session 与终端统一成
  attention / working / idle / ended 四列，权限请求等待最久的排最前。
- V2：daemon 侧 LLM 旁路分析会话进展写 `metadata.board`；老板任务列表
  （KV）+ 泳道分组 + Dispatch 下发派生会话。

## 非目标

- V1 **不引入任何新数据源、不加任何轮询**——看板是现有两条状态流
  （session socket push + 终端 `list-terminals` 10s/30s 轮询）的纯派生视图。
- 看板不是历史库：只呈现运营中的东西，第三列只收 24h 内结束的会话；
  更老的归档入口仍是 Sidebar 的 archived filter。
- V1 卡片菜单只有 Open，不复制 kill/archive 逻辑。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 终端 agentState 四态 `working/needs_input/idle/shell`，daemon `list-terminals` 每项带 `id/title/cwd/createdAt/agentState` | `packages/happy-cli/src/terminal/webTerminal.ts:596`，RPC 注册 `packages/happy-cli/src/api/apiMachine.ts:246` |
| web 侧类型 `MachineTerminal`（已含 `cwd`，当时无人消费） | `packages/happy-web-v2/src/sync/ops.ts:370-393` |
| 唯一轮询循环：Sidebar reconcile effect，10s 前台 / 30s 隐藏页 | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:61-101` |
| `terminalAgentState` store，明确注释「不许出现第二个竞争轮询」 | `packages/happy-web-v2/src/sync/terminalAgentState.ts` |
| chat session 状态全部由 socket push 同步，无需轮询 | `packages/happy-web-v2/src/sync/storageTypes.ts:100-135` |
| 现成 selector：`useAttentionSessions()/useAllSessions()/useAllMachines()` | `packages/happy-web-v2/src/sync/storage.ts:1513/1619/1602` |
| 路由集中一处，detail 屏全部 lazy code-split | `packages/happy-web-v2/src/app/AppRoot.tsx:57-96` |
| collapsed 时 Sidebar 整个 unmount → 轮询也停（现存 quirk） | `packages/happy-web-v2/src/screens/AppLayout.tsx` |
| 设备本地偏好先例 `localSettings`；KV 先例 `vh.terminal-sessions`（version-aware LWW） | `sync/localSettings.ts`、`sync/terminalSessions.ts` + `apiKv.ts` |
| LLM 旁路先例：`claude -p --model haiku` 一次性子进程，30s 超时，fire-and-forget | `packages/happy-cli/src/claude/utils/titleGenerator.ts` |
| i18n 新 key 只需加 `src/text/_default.ts`，其余 locale 自动 fallback | `packages/happy-web-v2/src/text/_default.ts:969` 附近 |

## 设计

### V1：聚合看板

**信息架构与路由**：新路由 `/board` 渲染在 detail 面板（desktop 左侧 Sidebar 保留）；
`/` index 改 `HomeGate` 读 `localSettings.homeView`（`'board'|'normal'`，默认
`'normal'` 安全上线，Settings → Appearance 加开关）。Sidebar header 加
LayoutGrid 按钮带 attention 角标；mobile 走 filter 行第三入口，三列退化单列分组。

**统一状态模型**（纯函数 `boardItems.ts`）：

```ts
type BoardStatus = 'attention' | 'working' | 'idle' | 'ended';
interface BoardItem {
  key: string;                    // session id 或 t:<terminalId>
  kind: 'session' | 'terminal';
  status: BoardStatus;
  title: string; machineName: string; cwd: string;
  lastActivityAt: number;
  attentionSince?: number;        // waiting 徽标
  href: string;
  detail?: string;
}
```

映射规则：

| 来源 | attention | working | idle | ended |
|---|---|---|---|---|
| chat session | `presence==='online' && agentState.requests` 非空 | `active && thinking` | `active && online` 且不 thinking | `!active` 或掉线，且 `updatedAt > now-24h` |
| 终端 | `needs_input` | `working` | `idle/shell/undefined` | 所属 machine 离线（标 "machine offline"） |

- attention 列等待最久排最前，红描边 + StatusDot 脉冲；working 按 lastActivityAt 降序。
- chat 用 `useAllSessions()`（**不要用 `useSessions()`**——混着 string 分组头）。
- 终端 cwd：Entry 扩为 `{machineId, state, cwd?, since?}`，`ingest()` 填充，零协议改动。

**轮询单例化重构**（V1 唯一结构性改动）：把 Sidebar 的 reconcile effect 原样搬进
`src/sync/terminalReconcileLoop.ts`（模块级引用计数），`AppLayout` 调用一次、
Sidebar 删原 effect。轮询总量不变，顺手修 collapsed 侧栏不轮询的 quirk。

### V2：LLM hook + 老板下发任务

- **跑在哪**：daemon 侧 `claude -p --model haiku`，`boardAnalyzer.ts` 复刻
  titleGenerator 契约（fire-and-forget、30s 超时、失败吞掉）。
- **时机**：session 首条用户消息后 + 每 turn 结束；节流：单 session ≥5min
  且内容 hash 变了才跑。
- **输入/输出**：最近用户消息 + assistant 输出尾部(截1000字) + todos + KV 任务
  标题列表 → 严格 JSON `{taskId, attention:'none'|'review'|'blocked', progress}`，
  解析失败丢弃。
- **存哪**：session metadata 新字段 `board`（MetadataSchema optional）顺现有
  sessions push 免费同步；任务列表 KV `vh.board-tasks.v1`（version-aware 乐观写）。
  server 零改动。
- **下发任务→派生 session**：看板 New task → KV 任务 → Dispatch 复用
  `machineSpawnNewSession`（初始消息预填 description）；spawn 后 web 把
  sessionId 写进任务映射（手动映射优先，LLM 只兜底）。
- **成本**：haiku <$0.001/次；20 活跃 session 满负荷 ~240 次/天 ≈ 几美分；
  synced 开关 `boardLlmEnabled`。

## 兼容矩阵与发布顺序

- V1 纯 web 改动（终端 `activityAt` 为可选字段，旧 daemon fallback createdAt）。
- V2 `metadata.board` 为 optional 字段，旧端忽略；daemon（CLI 发版）与 web
  可独立发布，无强顺序。

## 风险

1. **轮询放大**：唯一红线。review 时 grep `machineListTerminals` 确认调用点只剩 terminalReconcileLoop.ts。
2. **reconcile 副作用上提**：行为等价于今天「desktop 展开侧栏」；KV steady state 不写（已有防抖）。
3. **离线机器陈旧状态**：boardItems 必须以 isMachineOnline gate，绝不让离线机器的旧 needs_input 霸占 attention 列。
4. **classifyPane 误报**：接受；点进去即真相。
5. **列间跳动**：V1 接受，tiebreak 用 id 保稳定；体感差再加 5s 滞回。
6. **useSessions 陷阱**：用 useAllSessions。

## 验收标准

- [x] /board 可达；Sidebar 按钮、mobile 入口都能进
- [x] 权限请求卡住的 chat 会话 → attention 列最前带 waiting 时长；长任务 → working；结束 → 24h 内 ended
- [x] 终端 needs_input 进 attention；纯 shell 进 idle；旧 daemon 终端 unknown 不进 attention
- [x] 卡片点击跳转 + 选中态正确
- [x] 网络面板：双视图时 list-terminals 仍每机 10s 一次；hidden 30s
- [x] collapsed 侧栏时终端状态仍更新（quirk 回归项）
- [x] 机器离线 → 其终端落 ended + "machine offline"
- [x] homeView='board' 刷新 / 直出看板；默认 normal 无感知
- [x] (!) 标题前缀、Notification、Sidebar 角点与重构前一致

## 留真机验证项

（已随 2026-08 各批验收清账。）
