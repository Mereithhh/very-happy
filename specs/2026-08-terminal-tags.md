# tmux 终端标签

> 状态：Final
> 日期：2026-08-26 ｜ 关联 backlog：B-216

## 背景

普通结构化会话的重命名弹窗可以编辑标签，但 tmux 终端仍被限制为仅改标题，导致同一侧栏里的两类工作会话无法用同一套标签筛选、分组和识别。

## 目标

- 新 daemon 管理的 tmux 终端可跨设备编辑、展示、筛选和按首个标签分组。
- 侧栏与 Task Board 复用现有标题 + 标签弹窗和保存路径。
- 新旧 Web/CLI 任意升级顺序都安全；旧 daemon 不收到未知 RPC。

## 非目标

- 不把标签写入数据库、账号 KV 或 closed-terminal 历史。
- 不改变结构化会话的 metadata.tags 语义。
- 不给裸的非 `vh-*` tmux session 增加管理能力。

## 现状事实（代码已确认）

| 事实 | 位置 |
|---|---|
| terminal 标题以 tmux `@vh_title` 为跨设备事实源，并由 daemon push 回 Web | `packages/happy-cli/src/terminal/webTerminal.ts:2696`、`packages/happy-web-v2/src/sync/terminalSessions.ts:19` |
| terminal list 同时用于 daemonState push 与旧 `list-terminals` RPC | `packages/happy-cli/src/terminal/webTerminal.ts:545`、`packages/happy-cli/src/api/apiMachine.ts:441` |
| Web 用可选 terminal item 字段兼容未知 daemon 版本 | `packages/happy-web-v2/src/sync/ops.ts:647`、`packages/happy-web-v2/src/sync/terminalPushOps.ts:94` |
| 当前弹窗以 `tags === undefined` 判定“不支持标签”，terminal 调用方刻意传 undefined | `packages/happy-web-v2/src/screens/sessions/RenameModal.tsx:28`、`packages/happy-web-v2/src/screens/sessions/Sidebar.tsx:1100` |
| 当前菜单、保存路径明确把 terminal 限制为 title-only | `packages/happy-web-v2/src/screens/sessions/sidebarRowMenu.ts:1`、`packages/happy-web-v2/src/app/rowActions.ts:151` |

## 设计

1. tmux session user option `@vh_tags` 保存 JSON string array；缺失、空值或损坏内容读取为 `[]`，写入仅接受现有 Web 规范产生的非空、最长 24 字符、大小写不重复标签，并限制总数与序列化大小。
2. `LIST_SESSIONS_FORMAT` 在最后的 `pane_title` 之前加入 `#{@vh_tags}`；解析结果进入 `TerminalListItem.tags`，并参与 terminal list signature，确保改标签立即触发 daemonState push。
3. 新 RPC `set-terminal-tags {terminalId,tags}` 写入 tmux option，成功后 kick list refresh。Web 使用独立的 title/tags RPC，仅写变化项；任一失败都让 optimistic overlay 在 TTL 后诚实回退。
4. 新 daemon 对每个 terminal 始终 push `tags: [] | string[]`。Web 将“字段存在”作为能力标记：`undefined` 表示旧 daemon、继续 title-only；空数组表示支持编辑但当前无标签。
5. Sidebar/Board 的 terminal row 携带 tags，复用现有 TagChip、搜索、标签分组与 RenameModal；标签建议合并普通会话和 terminal 的现用标签。

## 兼容矩阵与发布顺序

| Web | daemon | 行为 |
|---|---|---|
| 旧 | 新 | 忽略可选 `tags` 字段；标题与终端正常工作。 |
| 新 | 旧 | terminal `tags` 缺失，UI 保持 title-only，不调用新 RPC。 |
| 新 | 新 | 完整编辑、push、展示、筛选和分组。 |

无 server/wire/数据库变更。发布采用 CLI → mac-office daemon → Web；回滚 Web 时 tmux 中的 `@vh_tags` 保留且无副作用，回滚 CLI 时新 Web 通过字段缺失自动降级。

## 风险

1. tmux option 内容可被本机用户手改损坏：解析失败闭合为空数组，绝不让整个 terminal list 失效。
2. 标题成功但标签失败造成部分保存：两项各自有确认 push 和 optimistic TTL，失败项回退，不伪装成功。
3. tag 变化未触发 push：将规范化 tags 纳入 list signature，并补回归测试。

## 验收标准

- [ ] 新 daemon 的空标签 terminal 也明确 push `tags: []`。
- [ ] tag RPC 可写入、清空并即时触发 list refresh；非法输入拒绝。
- [ ] Sidebar 与 Board 的 terminal 弹窗可编辑标签，行上展示 TagChip。
- [ ] terminal 标签参与 `#tag` 搜索与标签分组。
- [ ] 旧 daemon 快照仍只显示标题编辑，不调用未知 RPC。
- [ ] Web、CLI 完整门禁通过。

## 留真机验证项

- 多浏览器打开同一 terminal，一端修改标签后另一端无需刷新即更新。
