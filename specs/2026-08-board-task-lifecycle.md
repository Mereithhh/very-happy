# Task Board 生命周期视图（以任务完成为中心的管理翻转）

> 状态：Final
> 日期：2026-08-12 ｜ 关联 backlog：（Owner 直述需求，本次派工；与 B-002 的 task board 域相邻）
> 出处/前身：`specs/2026-08-task-board.md`（V1 状态列 + V2 泳道，Shipped）——本 spec 翻转其默认视图，不推翻其机制。

## 背景

Owner 定稿的管理哲学（原话提炼）：

> 不以 claude code 的状态做管理，以任务是否完成做管理。"空闲"本质不是空闲，
> 是我没有把它标记成完成、或者需要我看一下给新 input。任务完成了就记录一下，
> 有一个通知。

两条 Owner 认可的边界修正：

1. session 可以无任务存在，但**"标记完成"必须一次点击**（完成即从看板消失 + 留记录）；
2. **"claude 跑完" ≠ "任务完成"**——完成必须是用户显式动作（或 LLM 建议→一键确认）。
   系统只负责把"跑完了该收货"推进"等我看"并通知，绝不代替用户判定完成。

现有 board 的四态列（attention / working / idle / ended）是"进程状态"视角：
idle 列在语义上是中性的，但对 Owner 它其实是待办——跑完没收货的会话堆在
"空闲/已结束"里没有任何压力信号，也没有一个动作能把它"收掉"。

## 目标

1. **默认视图 = 任务生命周期三列**：`进行中`（agent 正在跑）/ `等我看`（合并：
   权限请求 + LLM review/blocked + agent 跑完未标完成 + 进程死了没归档 +
   终端 needs_input/idle + 机器离线）/ `已完成`（近期完成记录，可折叠）。
2. **一键完成**：卡片 hover 常驻 ✓ 主操作 + 右键菜单项 + 泳道任务头部 ✓。
   session 级 = 完成记录 + kill-first archive（复用既有语义），**单击无确认弹窗**；
   任务级 = boardTasks `status: 'done'`（已有）+ 旗下看板会话批量完成提示。
3. **完成通知**：标完成后经账号 webhook 通道发 `✅ 已完成 · <名>`（server 新增
   轻端点转发，见设计 §D；零新依赖）。
4. 现有四态**退役为卡片角标**：`buildBoardItems` 的派生逻辑原样保留（角标源 +
   等我看列内排序源），只是不再作为列结构。
5. 滴答清单（dida365）**只预留集成点**，不实现（§F）。

## 非目标

- 不做自动完成：任何 LLM/状态信号都只能把条目推进"等我看"，不能标完成。
- 不改 daemon/CLI：boardAnalyzer、`dispatchSessionEventPush` 事件面、终端四态
  推送协议全部不动。**CLI 包零改动。**
- 不做终端的完成记录：终端"完成"= 删除（kill tmux，复用 confirmDeleteTerminal
  确认流），删了即消失，不留记录——避免为终端造第二套记录系统。
- 不做完成记录的历史库：已完成列只看近 24h（与 ENDED_WINDOW_MS 同窗口）；
  更久的翻 Sidebar archived filter / boardTasks 数据。
- 不改 Sidebar 角标语义（仍= 紧急注意力：权限请求 + needs_input，见 §G 论证）。
- 不实现 dida365 适配器与导入。
- 不碰并行 agent 热区：`Sidebar.tsx` / `sidebarPins.ts` / `webTerminal.ts`。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| 四态派生纯函数 `buildBoardItems`（attention/working/idle/ended），archived（`!active`）永不上板，`ended` 仅指 `active===true` 但 presence 丢失且 24h 内 | `packages/happy-web-v2/src/screens/board/boardItems.ts:131-147` |
| 排序：status rank → attention 等最久最前，其余 lastActivityAt 降序，key tiebreak | `boardItems.ts:224-233` |
| 泳道分组 `groupBoardItems`：手动 sessionIds 优先，LLM taskId 兜底，done/deleted 任务的会话回落 ungrouped | `boardItems.ts:272-300` |
| kill-first archive 语义：乐观本地 flip → `sessionKill` → 失败才 `sessionArchive`（server 强制归档），失败回滚 | `packages/happy-web-v2/src/app/rowActions.ts:22-39` |
| 终端删除 = `machineKillTerminal`（杀 tmux）+ registry remove，带确认弹窗 | `rowActions.ts:79-96` |
| boardTasks KV 列表已有 `status: 'open'|'done'|'deleted'` + `updatedAt`，`setStatus(id,'done')` 已实现；done 任务不进泳道但留在 KV | `packages/happy-web-v2/src/sync/boardTaskOps.ts:27-44`、`boardTasks.ts:212-222` |
| MetadataSchema 已有可选字段先例（`board`、`tags`——注释明言 optional-only、无 `.default()`） | `packages/happy-web-v2/src/sync/storageTypes.ts:63-84` |
| web 解密 metadata 用 `MetadataSchema.safeParse`（**strict，会剥未知字段**）——老 web 端下一次改 metadata 会丢新字段 | `packages/happy-web-v2/src/sync/encryption/sessionEncryption.ts:166` |
| CLI 侧 Metadata 是纯 TS 类型（无 zod parse），`updateMetadata` 是 `{...metadata, …}` spread + version-mismatch 重取重放——**未知字段运行时保留** | `packages/happy-cli/src/api/types.ts:320`、`apiSession.ts:734-752` |
| web 写 metadata 的乐观并发/rebase 重试循环先例（version-mismatch 以 server 权威版本为底重放） | `packages/happy-web-v2/src/sync/ops.ts:790-880` |
| `dispatchSessionEventPush` 由 **daemon 发起**（POST `/v1/sessions/:id/push-event`），web 标完成走不进这条事件面 | `packages/happy-server/sources/app/api/routes/pushRoutes.ts:113-168` |
| 账号 webhook：一账号一 URL，存 AccountPushToken `webhook:` 前缀行；`sendWebhook` 有 SSRF 守卫（https-only、私网黑名单、拒 redirect、5s 超时、发送时复验） | `packages/happy-server/sources/app/push/webhookNotify.ts` |
| webhook 消息契约：末行 `session: <id>` 机器可解析（Tanka 引用回复靠它路由），`HAPPY_WEB_URL` 可选注入链接行 | `webhookNotify.ts:260-276`、`docs/channels.md` |
| server 内存限频先例（零依赖，进程内滑窗） | `packages/happy-server/sources/app/api/routes/accountAuthRoutes.ts:34-52`、`unlockRoutes.ts:25` |
| `boardLayout` 本地设置 enum `['status','tasks']`；**localSettings 整体 safeParse，单个 key 非法会导致全部本地设置回默认** | `packages/happy-web-v2/src/sync/localSettings.ts:34,48,91-97` |
| BoardCard 根元素是 `<button>`（放子按钮会成非法嵌套交互元素，需改造） | `packages/happy-web-v2/src/screens/board/BoardCard.tsx:104-110` |
| i18n 新 key 只加 `_default.ts` + `zh-Hans.ts`（其余 locale 自动 fallback） | `packages/happy-web-v2/src/text/` |
| 门禁基线（本 worktree 实测）：web 293 tests 全绿 + tsc 0 错误；server 102 tests + tsc 0 错误 | `pnpm exec vitest run` / `tsc --noEmit` |

## 设计

### A. 生命周期分类器（纯函数，退役四态为角标）

`boardItems.ts` 新增：

```ts
export type BoardLifecycle = 'running' | 'waiting';
export type WaitReason =
  | 'permission'      // 权限请求（session attention，最高优先）
  | 'review'          // LLM 建议看一眼
  | 'blocked'         // LLM 判定被卡住
  | 'needsInput'      // 终端 needs_input
  | 'idle'            // agent 跑完/待新 input，未标完成（原 idle）
  | 'ended'           // 进程死了没归档（原 ended，24h 窗口）
  | 'machineOffline'; // 终端所属机器离线（24h 窗口）

export function lifecycleOf(item: BoardItem): { lifecycle: BoardLifecycle; waitReason?: WaitReason };
```

**决策表**（`lifecycleOf` 的单测就是这张表，一行一个用例）：

| kind | 原四态 status | 附加条件 | lifecycle | waitReason |
|---|---|---|---|---|
| session | attention | 有 pending permission requests | waiting | permission |
| session | attention | 无 requests、llmAttention='review' | waiting | review |
| session | attention | 无 requests、llmAttention='blocked' | waiting | blocked |
| session | working | — | running | — |
| session | idle | — | waiting | idle |
| session | ended | —（24h 内才成为 item） | waiting | ended |
| terminal | attention | needs_input | waiting | needsInput |
| terminal | working | — | running | — |
| terminal | idle | idle/shell/undefined | waiting | idle |
| terminal | ended | machine offline（24h 内） | waiting | machineOffline |

核心翻转：**原 idle 和 ended 合流进"等我看"**——跑完没收货 = 等我看。
已标完成的 session 是 archived（`!active` 且非 ended 路径），`classifySession`
本来就返回 null，不需要新的排除逻辑。

**等我看列内排序免费获得**：`buildBoardItems` 的总排序是
attention(等最久最前) → working → idle(最近最前) → ended(最近最前)；
waiting 列 = 按原序 filter，天然得到「紧急段（permission/needsInput/review/blocked，
等最久最前）→ 收货段（idle/ended，最近最前）」，不引入第二套排序规则。
`buildLifecycleColumns(items)` 只做 filter，不 re-sort。

四态保留为**卡片角标**：StatusDot 配色照旧（attention 红脉冲 / working teal
脉冲 / idle 静态 / ended 灰）；waiting 列的收货段卡片加 reason 角标
（`跑完待收` / `已结束` / `机器离线`），紧急段沿用现有 tool 名 / review /
blocked 徽标。`buildBoardItems`、`useBoardAttentionCount`、泳道分组逻辑一律不删不改。

### B. 已完成列（轻量记录，不造系统)

```ts
export interface CompletedEntry {
  key: string;               // 'done:s:<sessionId>' / 'done:task:<taskId>'
  kind: 'session' | 'task';
  title: string;
  at: number;                // 完成时刻
  href?: string;             // session 记录可点开；task 记录不可点
}
export const DONE_WINDOW_MS = ENDED_WINDOW_MS; // 同一个 24h 口径
export function buildCompletedEntries(
  sessions: Session[], tasks: BoardTask[], now: number,
): CompletedEntry[];        // at 降序
```

- **session 级完成记录 = metadata 新可选字段 `completedAt: number`**。
  取舍：metadata 顺现有 sessions push 免费全端同步、随会话归档留存，零新存储、
  零 server 改动；对比过的方案——本地 MMKV 记录（换设备丢）、KV 新 blob（要建
  第三套 KV 合并语义）都更重。风格完全对齐 `tags`/`board` 先例：optional-only、
  **绝不加 `.default()`**（铁律 1）。
- **task 级完成记录 = 现成的** `status:'done'` + `updatedAt`，不加字段。
- 已完成列渲染 `buildCompletedEntries(useAllSessions(), visibleTasks(tasks), now)`
  ——archived session 本来就在 store 里（Sidebar archived filter 同源），无新数据流。
- 可折叠：列头点击折叠/展开，**组件内 state**（桌面默认展开、移动端默认折叠），
  不进 localSettings——纯视图临时态，不值得一个持久设置。
- 边缘：已完成的 session 被 resume 复活（重新 active）时照常按 A 分类回到
  进行中/等我看，同时 24h 内记录仍显示——接受（罕见且语义诚实：它确实完成过又复活了）。

### C. 一键完成动作

**session 级 `markSessionDone(session)`**（`rowActions.ts`，与 archive/delete 同居）：

1. 写完成记录：`sessionApplyMetadata(id, m => ({...m, completedAt: Date.now()}))`
   ——把 `sessionUpdateTitleTags` 的 rebase 重试循环抽成通用
   `sessionApplyMetadata(sessionId, apply, maxRetries)`（`ops.ts`），
   两者共用一套 version-mismatch 语义。**先写 metadata 再 kill**：CLI 退出时的
   archived stamp 走它自己的 mismatch-rebase（现状事实第 9 行），不会剥掉
   `completedAt`。metadata 写失败降级为 console.warn，不阻断完成动作
   （记录尽力而为，完成动作必须成功）。
2. kill-first archive：乐观 `setSessionActiveLocal(false)` → `sessionKill` →
   不成功再 `sessionArchive`，失败回滚——**逐字复用 confirmArchiveSession 的
   语义，但没有确认弹窗**（Owner 边界①：一次点击）。实现上把
   confirmArchiveSession 拆成 `archiveSessionNow(session)`（无确认）+ 原确认壳。
3. 完成通知（best-effort，见 §D）：`✅ 已完成 · <标题>`。通知失败不回滚不报错
   （webhook 本来就是 best-effort 契约）。

**终端 ✓** = `confirmDeleteTerminal`（保留确认弹窗）。论证：杀 tmux 会毁掉
scrollback 与运行中进程，破坏性高于归档 session（session 还能从 archived 找回），
Owner 的一次点击边界针对的是"收货"主流程（session/任务）；终端完成=销毁，留确认。

**任务级**（泳道头 ✓，menu 项同路）：

1. `setStatus(taskId, 'done')`（已有）→ 泳道消失、进已完成列。
2. 该泳道当前含 N 个 session 卡片（N>0）时弹一次 `Modal.confirm`：
   「同时把 N 个会话标记完成？」确认则逐个 `markSessionDone`（不逐个发通知）。
3. 通知一条：`✅ 已完成 · <任务名>`（N>0 时消息里带会话数）。

**入口**：卡片 hover 常驻 ✓ 按钮（触屏 always-visible）+ 右键菜单首项
「标记完成」+ 泳道头 ✓。BoardCard 根元素从 `<button>` 改为
`<div role="button" tabIndex={0}>`（Enter/Space 触发 open）——否则 ✓ 是
button 嵌 button 的非法 HTML。✓ 点击 `stopPropagation`，不触发卡片跳转。

### D. 完成通知链路（server 轻端点）

问题：完成是 **web 动作**，`dispatchSessionEventPush` 的事件面由 daemon 发起
（web 无从触发）；web 直接 POST 用户 webhook 也不行——webhook URL 是 server
侧凭据面（存在 AccountPushToken），且浏览器直连会撞 CORS 与 SSRF 校验旁路。

方案：server 新增 **POST `/v1/webhook/notify`**（`pushRoutes.ts`）：

- `preHandler: app.authenticate`（账号 bearer，只能发给**自己**配置的 webhook）。
- body：`{ title: string(1..200), message?: string(0..1000), sessionId?: string }`。
- 行为：读账号 `webhook:` 配置行 → 无配置返回 `{ ok:true, delivered:false }`
  （不是错误：没配 webhook 的用户点完成不该看到红字）→ 有配置则用新纯函数
  `buildManualWebhookPayload({title, message, sessionId})` 组包——复用
  `webhookWebUrlBase()` 链接行 + **保持 `session: <id>` 末行契约**
  （docs/channels.md 的稳定契约，Tanka 引用回复靠它）→ `sendWebhook`（现成
  SSRF 复验 + 5s 超时 + 不重试）→ 返回 `{ ok:true, delivered:boolean }`。
- **不做 events 类别过滤**：`completed/permission` 订阅开关管的是自动事件；
  这里是用户显式点击产生的通知，明确想要，直接发。
- **限频**：进程内滑窗，每账号 30 次/60s，超限 429（复用 accountAuthRoutes
  的零依赖限频手法，抽成可单测的 `createAccountRateLimiter`）。防的是脚本
  滥用把 server 变成打洞代理，不是防用户手点。
- **server 零新 npm 依赖**（bind-mount 部署约束，门禁硬项）。

web 侧 `apiWebhook.ts` 加 `notifyWebhook(credentials, {title, message, sessionId})`
→ boolean，任何异常吞掉返回 false。

事件面对比过的替代方案（否）：web 经 socket 让 daemon 代发 push-event——绕一整
圈 RPC 且 daemon 可能已死（ended 会话正是常见场景）；扩展 `/v1/sessions/:id/push-event`
的 kind——那是 daemon 契约面，混入 web 语义会污染 suppression 逻辑。

### E. 布局：lifecycle 替换 status，tasks 保留

- `boardLayout` enum 改 `['status', 'tasks', 'lifecycle']`，默认 `'lifecycle'`。
  **`'status'` 必须留在 enum 里**：localSettings 是整体 safeParse，剥掉旧值会把
  存过 `'status'` 的设备的**全部**本地设置（主题、zen mode…）打回默认（现状
  事实倒数第 4 行）。屏幕侧把 `'status'` 视同 `'lifecycle'` 渲染。
- **替换而非三选一**（论证）：进程四态视图的信息价值已被角标 + 等我看列内分段
  完全覆盖；留三个 toggle 是给单人产品加认知税。原 status 三列代码路径删除，
  纯函数派生保留（角标/排序仍在用）。
- toggle 变成 `生命周期 | 任务` 两档；tasks 泳道视图不动（卡片同样获得 ✓）。
- `homeView` 不动（本 spec 管 board 内布局，不管首页是不是 board）。

### F. 滴答清单（dida365）预留集成点（不实现）

对齐 `docs/channels.md` 的"适配器在核心之外"模式：

- **完成事件出站**：本 spec 落地后，任务/会话完成通知已经从
  `/v1/webhook/notify` 流向用户 webhook 网关——未来 dida365 适配器就是网关后面
  的一个消费者（收 `✅ 已完成` → 调 dida365 open API 勾掉对应待办），核心零改动。
  适配器需要的关联键：通知 message 里的 `session: <id>` 末行（已有契约）；任务级
  通知补 `task: <taskId>` 末行（本次顺手加进 `buildManualWebhookPayload`，
  纯文本行，零协议成本）。
- **任务导入入站**：未来「从 dida365 导入任务」= 适配器读 dida365 → 逐条写
  boardTasks（KV `vh.board-tasks.v1` 是非 e2e 的 base64 JSON，daemon/脚本可读写，
  boardAnalyzer 已是先例）。BoardTask 结构无需预改——外部来源标记留给未来
  `origin?: string` 可选字段（merge 语义对未知字段是 per-task 整记录胜出，天然兼容）。
- 不在本次实现任何 dida365 代码；此节只锁定「事件出站走 webhook 网关、任务入站
  写 KV」这两个集成面，防止未来实现时另起炉灶。

### G. Sidebar 角标维持"紧急注意力"语义

`useBoardAttentionCount`（权限请求 + needs_input，在线机器 gate）**不改**。
论证：等我看列包含全部 idle 会话，若角标改数等我看，它将长期非零、红点常亮，
信号退化成噪声；紧急（有东西被卡住等你批）与非紧急（跑完待收）的区分正是
角标该有的过滤。等我看的总量压力在 board 本身的列计数里体现。

## 兼容矩阵与发布顺序

| 改动 | 旧端行为 | 结论 |
|---|---|---|
| metadata `completedAt`（web schema 新可选字段） | CLI：纯 TS 类型 + spread，运行时透传，零改动零影响。老 web：strict safeParse 会剥掉该字段，其下一次 metadata 写（改名）会丢完成记录 | 接受——单人产品无老 web 共存窗口；与 `board` 字段上线时的既有取舍完全一致 |
| server `POST /v1/webhook/notify` | 老 web 不调用；新 web 打到老 server 得 404 → `notifyWebhook` 吞掉返回 false，完成动作不受影响 | 双向安全 |
| `boardLayout: 'lifecycle'` | 旧值 `'status'` 仍在 enum（防 localSettings 全量回默认），渲染时视同 lifecycle | 安全 |
| boardTasks KV | 无 schema 变化 | 无影响 |
| webhook 消息契约 | `session: <id>` 末行维持；新增可选 `task: <id>` 行在 session 行**之前**（末行契约不破） | 适配器无感 |

**发布顺序**：server → web（默认顺序；无 CLI 发版）。web 先发也只是完成通知
静默降级，不破功能。**回滚点**：server revert 即回（端点无状态、无迁移）；web
回滚后 `completedAt` 字段残留 metadata 中，旧代码忽略之，无害。

## 风险

1. **完成动作跳确认弹窗**（Owner 边界①要求）：误触 ✓ 会 kill 正在跑的 CLI。
   缓解：✓ 与卡片主体点击区隔离（独立按钮 + stopPropagation）；archived 会话
   可从 Sidebar archived filter 找回并 resume；接受剩余风险（Owner 拍板的交互）。
2. **等我看列拥挤**（合并了四态中的三态）：缓解——列内紧急段/收货段分段排序
   （§A 免费获得）+ reason 角标；终端 idle（纯 shell）会常驻该列，正是"没收货
   就别想眼不见为净"的哲学本体，接受；体感太吵再迭代（如 shell 折叠小节）。
3. **metadata 写与 CLI 退出 stamp 竞态**：双方都走 version-mismatch rebase
   （现状事实第 7/9 行），字段互不剥；顺序上 web 先写后 kill 进一步缩窗。接受。
4. **限频误伤批量完成**：任务级批量只发 1 条通知，session 级手点 30/60s 足够；
   429 时 web 静默降级（通知丢，完成不丢）。
5. **`/v1/webhook/notify` 滥用面**：仅本账号 webhook、URL 存量已过 SSRF 校验
   且发送时复验、限频、消息长度封顶——攻击者拿到 token 本就能改 webhook URL，
   端点未扩大既有信任面。
6. **`bd-card` 从 button 改 div**：键盘可达性回归（Enter/Space + tabIndex）
   写进验收；CSS 复核 hover/focus 态。

## 验收标准

- [ ] 默认进入 board 是生命周期三列：进行中 / 等我看 / 已完成；toggle 只有
      生命周期/任务两档；旧设备存的 `'status'` 值不炸、渲染为生命周期，其余
      localSettings 不回默认
- [ ] 决策表 10 行在 `boardItems.test.ts` 逐行有单测（lifecycleOf +
      buildLifecycleColumns 分段顺序 + buildCompletedEntries 窗口/排序）
- [ ] 权限请求会话在等我看紧急段最前（等最久优先）；跑完的 idle 会话进等我看
      收货段带「跑完待收」角标；ended/机器离线 24h 内在收货段、超窗掉出
- [ ] session 卡片 ✓ 单击（无弹窗）：卡片立刻从等我看消失 → 已完成列出现记录
      （标题 + 时间，可点开）→ 配了 webhook 时收到 `✅ 已完成 · <名>` 通知；
      没配 webhook 无报错
- [ ] 对 presence 丢失的 ended 会话点 ✓：kill 失败自动走 server archive，
      完成记录照常
- [ ] 终端卡片 ✓ = 现有删除确认流；确认后终端消失、无完成记录
- [ ] 任务泳道 ✓：任务进已完成列；泳道内有 N>0 会话时弹一次批量确认，确认后
      旗下会话逐个完成；通知只发一条任务级
- [ ] 通知 message 保持 `session: <id>` 末行契约；任务级通知带 `task: <id>` 行
- [ ] server `/v1/webhook/notify`：无 webhook 配置 `delivered:false`；限频 429；
      纯函数（payload 组包 + 限频器）有单测；**零新 npm 依赖**
- [ ] 四态角标仍在卡片上（StatusDot 配色不变）；`useBoardAttentionCount`、
      泳道分组、`buildBoardItems` 机制未删改（grep 确认导出仍在）
- [ ] 键盘可达性：卡片 Enter/Space 打开，✓ 可 tab 到
- [ ] i18n 只改 `_default.ts` + `zh-Hans.ts`
- [ ] 门禁：web vitest 全绿（≥293）+ vite build + tsc 0 错误；server tsc +
      vitest 全绿（≥102）；未触碰 `Sidebar.tsx`/`sidebarPins.ts`/`webTerminal.ts`

## 留真机验证项

- 触屏：卡片 ✓ always-visible 不误触（与长按菜单不冲突）；移动端已完成列默认
  折叠、展开顺滑
- 真实 webhook（Tanka 网关）收到完成通知的排版观感
- hover ✓ 出现/消失的视觉稳定性（不引起卡片布局跳动）
