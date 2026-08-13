# 无删除、只归档（archive-only）

> 状态：Shipped（主 agent 定稿并随批合并；「已结束终端记录」另立 B-084 未做）
> 日期：2026-08-14 ｜ 关联 backlog：B-083

## 背景

Owner 原话：「session 的开启和关闭都是有记录的吧？即便我们删除了。然后我们的系统能不能
没有『删除』这个概念，只有归档。包括终端会话，『这会销毁机器上的 tmux 会话，且不可恢复。』
这种提示也可以不用——我可以用 --resume 继续 claude code session 的。」

**事实审计结论（直接回答 Owner 的问题）：现状与 Owner 的假设相反。**

1. **聊天会话删除是硬删除，什么记录都不留。** `DELETE /v1/sessions/:id` 在一个事务里
   删掉 SessionMessage 全部消息、UsageReport、AccessKey、Session 行本身，事务提交后再删
   附件 blob（本地目录或 S3 前缀）。没有软删标记、没有审计表；唯一痕迹是服务器 pino 日志
   （滚动丢弃，不算记录）。Web 端同时 purge 本地副本并写 tombstone。**删除后「什么时候开
   启/关闭过这个会话」无从查起。**
2. **归档则什么都留。** archive 只是 `active:false` + 刷新 `lastActiveAt`；消息、用量、
   metadata（createdAt/updatedAt 即开启/最后活动记录）全部原样保留，`GET /v1/sessions`
   不过滤 active，归档会话照常回传（最近 150 条内），侧栏「归档」视图可看可回访。
3. **终端 kill 后在产品内凭空消失。** kill-terminal → daemon `tmux kill-session`，下一次
   daemonState.webTerminals push 里该终端**以缺席表达删除**——侧栏/board/palette 同一份列表，
   没有任何「已结束终端」的持久记录（board 的 terminal `ended` 只表示「机器离线」，不表示
   「被关闭」）。终端的开启/关闭时间同样无处可查。
4. **但终端里跑的 claude 对话本体幸存。** Claude Code CLI 把对话写在机器上的
   `~/.claude/projects/<cwd>/<uuid>.jsonl`，与 tmux 生命周期无关；`tmux kill-session` 只杀
   进程不删文件，所以 Owner 说的「新终端里 `claude --resume` 继续」成立。注意：产品侧不追踪
   终端内 claude 的 session id（agentState 只有 working/needs_input/idle/shell 粗粒度），
   所以 resume 是靠 claude 自己的 --resume 选择器，不能从 web 深链到具体对话。

所以「能不能没有删除只有归档」——归档语义现成、记录完备；要做的是把「删除」从 UI 概念里
拿掉，并把终端「删除」重述为「关闭」。

## 目标

- 聊天会话：web UI 不再有任何「删除」入口；**归档是唯一收尾动作**，归档会话在侧栏
  「归档」视图可查（现状已支持，核实即可）。
- 终端：概念从「删除」改为「关闭」。文案不再恐吓（去掉「销毁 / 不可恢复」），如实说明
  「tmux 会话结束；其中的 claude 对话保存在机器上，可在新终端用 `claude --resume` 继续」。
  确认按钮中性语气。**行为不变：tmux 仍真正 kill——资源必须释放。**
- server `DELETE /v1/sessions/:id` 端点保留（兼容旧客户端 / 给 B-025 数据保留策略留钩子），
  web 不再调用。

## 非目标

- 不做服务端软删/审计表/数据保留策略——那是 B-025 的事，本次只保证 web 不再触发硬删。
- 不做终端「已结束记录」的持久化（见「设计 · 终端已结束记录」的代价分析，另立事项）。
- 不动 tombstone 机制（web 的 session tombstone 防复活、daemon 的 terminal tombstone
  防 legacy 重建，都保留）。
- 不删 server 端点、不动 wire 协议。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| DELETE 硬删消息/用量/AccessKey/Session 行 + 附件 blob | `packages/happy-server/sources/app/session/sessionDelete.ts:22-116` |
| DELETE 路由 | `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:390` |
| archive = `active:false` + `lastActiveAt`，其余全留 | `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:358-386` |
| `GET /v1/sessions` 不过滤 active（take 150） | `packages/happy-server/sources/app/api/routes/sessionRoutes.ts:14-47` |
| web 聊天删除唯一入口 = 侧栏行菜单 `delete` 项 | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:895-903`（rowMenuItems） |
| 删除流程（confirm → kill → DELETE → 本地 purge+tombstone） | `packages/happy-web-v2/src/app/rowActions.ts:90-109`、`src/sync/ops.ts:1170`、`src/sync/sync.ts:1068` |
| board 卡片对 session 只有归档/完成，没有删除 | `packages/happy-web-v2/src/screens/board/BoardCard.tsx:105-118` |
| 侧栏「归档」视图（`view==='archived'` 过滤 `!s.active`） | `packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:45,147` |
| kill-terminal RPC → `webTerminal.killSession` → `tmux kill-session` + daemon tombstone + push 缺席传播 | `packages/happy-cli/src/api/apiMachine.ts:329-333`、`src/terminal/webTerminal.ts:1458-1474` |
| 终端列表单一真相 = daemonState.webTerminals push，删除以缺席表达，无 ended 记录 | `packages/happy-web-v2/src/sync/terminalSessions.ts:1-17,132-145` |
| board 的 terminal `ended` 仅= 机器离线 | `packages/happy-web-v2/src/screens/board/boardItems.ts:195-199` |
| 终端删除入口：侧栏行菜单 + board 卡片菜单 + board 终端「✓」 | `Sidebar.tsx:974`、`BoardCard.tsx:71,126` |
| agentState 粗粒度，无 claude session id | `packages/happy-cli/src/terminal/webTerminal.ts:1486-1535` |

## 设计

### 聊天会话：archive-only

- 侧栏行菜单删掉「Delete」项（`rowMenuItems` 的 `onDeleteSession` 分支整个移除），
  归档成为唯一收尾。`confirmDeleteSession` 从 `rowActions.ts` 删除（无调用方即死码）。
- `ops.sessionDelete` **保留导出**：它是 B-025 数据保留策略（到期清理）将来复用的调用面，
  且 404 幂等 + 本地 purge 的语义已打磨过；头注注明「UI 已无入口（B-083），仅保留给
  保留策略/兼容」。
- tombstone 链路全保留：`sync.onSessionDeleted` 还要处理**其他客户端**发来的
  `delete-session` socket update（旧版本客户端仍可能删除）。

### 终端：「关闭」语义

- 菜单项文案 `common.delete` → 新增 `common.close`（Close/关闭），图标 Trash2 → X，
  去掉 danger 红色（中性动作）。
- 确认弹窗改用新 key `terminal.closeTitle` / `terminal.closeMessage`：
  - EN: "Close terminal?" / "This ends the tmux session on the machine. The Claude
    conversation inside is saved on the machine — continue it in a new terminal with
    `claude --resume`."
  - zh-Hans: 「关闭终端？」/「结束机器上的 tmux 会话。其中的 claude 对话已保存在机器上，
    可在新终端里用 claude --resume 继续。」
  - confirm 按钮 `common.close`，`destructive: false`。
  - 旧 key `terminal.deleteTitle/deleteMessage` 从 `_default`/`zh-Hans` 移除（仅这两个文件
    定义过它们；小语种是 PartialTranslationStructure、从未有该 key，不受影响）。
- `confirmDeleteTerminal` 改名 `confirmCloseTerminal`（概念改名要落到代码名上），
  行为不变：仍 `machineKillTerminal`（tmux 真 kill）+ overlay 隐藏 + push 缺席确认；
  kill 失败仍如实报错不吞。
- board 终端卡的「✓ 标记完成」内部走同一 close 流程（带确认，不变）。

### 终端「已结束」记录：现状做不到，代价与方案（本批不做）

现状终端关闭后凭空消失，因为列表的单一真相是「机器上活着的 tmux 会话」。要留下可见的
「已结束」记录，候选：

1. **daemon 侧记录**（推荐）：`killSession` 时把 `{id,title,cwd,closedAt}` 追加进 daemon
   本地 JSON（tombstones 同款存储），并入 push 的新字段 `closedTerminals`（旧 web 忽略新
   字段，双向兼容）；web 侧栏「归档」段/board 尾部渲染。代价：CLI+web 两包协同发版、
   push payload 增长（需上限如最近 20 条）、跨机器聚合仍受「机器离线看不到最新 push」限制
   （server 持久化 lastState 可缓解）。
2. **web 本地记录**：关闭时写 localStorage。代价小但**跨设备不可见**、清缓存即失，与
   「记录」的诉求貌合神离。不推荐。
3. 顺带机会：daemon 若在记录里带上 cwd，web 能给「已结束」条目一个「在同目录开新终端」
   按钮，把 `--resume` 的手动成本降到一步。

本批只改概念与文案（方案 1 需 spec 定稿 + CLI 发版节奏，另立 backlog 事项）。

## 兼容矩阵与发布顺序

- 纯 web 改动，零协议变化。server DELETE 端点、`delete-session` update 处理、daemon
  kill-terminal RPC 全部原样。
- 旧 web / 旧客户端仍可删除（端点在）；新 web 只是不再提供入口。回滚 = revert web。

## 风险

1. 用户想真删敏感会话没入口了 → 接受：Owner 单人产品，明确要求；极端情况可 API 直调。
   B-025 保留策略会给「过期清理」正路。
2. 归档视图只回传最近 150 条会话，归档多了会「看不到老归档」 → 既有限制，非本次引入；
   记入 backlog 备注。
3. i18n key 改名漏改调用点 → tsc + vitest 门禁兜底（key 是类型化的）。

## 验收标准

- [ ] 侧栏会话行菜单无「删除」，仅剩 归档（终端行为「关闭」）；board 卡片同。
- [ ] grep `confirmDeleteSession` 无调用方；`ops.sessionDelete` 保留且注释更新。
- [ ] 终端关闭弹窗新文案（EN/zh-Hans），确认按钮中性；行为仍 kill tmux、失败报错。
- [ ] 归档会话在侧栏「归档」视图可见可打开（现状核实）。
- [ ] web 门禁三连绿（vitest / vite build / tsc 零新增）。

## 留真机验证项

- 侧栏/board 右键与「…」菜单在触屏上的新文案观感（zh/EN 切换）。
- 关闭一个正跑着 claude 的终端后，在同 cwd 新终端 `claude --resume` 能找回对话（真机）。
