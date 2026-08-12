# Backlog — 产品迭代项事实源

> 全部输入（实报 bug / 想法 / 评审发现 / 技术债）落这里，一项一行。
> **单写者纪律：只有主 agent（或 Owner 本人）改这个文件**——Owner 在对话里
> 说的需求，主 agent 当场记入（不靠记忆）；实现 agent 只读不写。
> 多会话并发时改前先 `git pull` / 看 `git status`，一行一项使冲突可解。
>
> 为什么是文件不是 GitHub Issues：状态变更与代码同 commit（任意历史点
> backlog 与代码一致）、agent 零网络零凭据即可读写、可 grep；单人私有 repo
> 下 Issues 的通知/协作红利全部落空——2026-08 实证：PROCESS.md 曾规定用
> Issues，结果零 issue 零 label，流程从未跑通。若未来上全自动派工流水线，
> 再考虑单向导出 Issues，事实源仍在此文件。
>
> 字段口径：类型 = bug / ux / feat / debt；状态 = todo / doing / done / dropped。
> done/dropped 项在批次沉淀时移入底部「近期完成」，攒多了直接删（历史在 git）。
> 真机验证项不进这里，进 `docs/verify-queue.md`。大改动的设计进 `specs/`。

## 活跃

| id | 标题 | 类型 | 来源 | 状态 | 备注 |
|---|---|---|---|---|---|
| B-001 | daemon 重连后 setRPCHandlers 方法不重注册——根治后删除「server 部署后必须 vh-update」流程项 | bug | PROCESS.md §4 | todo | reconnect 时重注册 open-terminal 等 |
| B-002 | `[happy]` 下发的任务在 task board 标注来源（P3） | feat | specs/2026-08-tanka-channel.md | todo | |
| B-003 | RpcHandlerManager 把 handler 错误编码为 `{error}` 正常响应——多数 ops 封装当成功（假 ack 面） | bug | 车道退役批遗留观察 | todo | 已修 openTerminal/killTerminal 两处，其余 RPC 封装待收口 |
| B-004 | 终端会话标签（@vh_tags 走 daemon 链路） | feat | 置顶标签批遗留 | todo | RenameModal 已留位 |
| B-005 | 渲染层 ghostty-web spike 复查 | debt | 渲染调研定论 | todo | 触发条件：0.5.0 发版+IME issue 关闭+内存损坏关闭 |
| B-006 | 看板任务生命周期重构（哲学：以任务完成管理，不以 claude 状态管理） | feat | Owner 2026-08-13 | done | Shipped 2026-08-13，见 spec |
| B-007 | dida365（滴答清单）任务双向联动 | feat | Owner 2026-08-13 | todo | 等 Owner 的 dida365 skill/CLI 就绪；走 channels 适配器模式 |
| B-008 | 更好的通知系统（分级/聚合） | feat | Owner 2026-08-13 | todo | 与 B-006/B-007 一体规划 |
| B-009 | `--version` 不提前退出会继续 daemon 流程——worktree 冒烟劫持生产 daemon（2026-08-13 真实事故：daemon 从已删 worktree 跑→posix_spawnp failed） | bug | 事故复盘 | todo | 修 CLI 让 --version 立即退出；冒烟命令已在 CLAUDE.md 改为 HAPPY_HOME_DIR 隔离 |
| B-010 | 侧边栏双形态：列表(手动序)/状态(生命周期分组)三段切换 + 删搜索框(⌘K 覆盖，移动端留搜索图标唤起) | ux | Owner 2026-08-13 | todo | 复用看板 lifecycle 分类器；等 B 全序排序合并后实施 |

## 近期完成

| id | 标题 | 类型 | 状态 | 备注 |
|---|---|---|---|---|
