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

## 近期完成

| id | 标题 | 类型 | 状态 | 备注 |
|---|---|---|---|---|
