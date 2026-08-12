# specs/ — 设计文档（spec）规范

> 本目录承载 very-happy 自己的设计文档，对应 `docs/PROCESS.md` §2 的
> 「大改动前置设计」环节。上游遗留的 `docs/plans/` 是只读历史档案，
> 新 spec 一律写在这里。

## 什么改动需要 spec

满足任一条就先出 spec、主 agent（或 Owner）定稿后再派实现：

- 动**协议 / 状态模型 / 存储语义**（wire 字段、KV schema、metadata 字段、同步语义）；
- **跨包改动**（web + cli + server 至少两个包要协同发布）；
- 引入**新数据流 / 新轮询 / 新常驻进程**；
- 方案有多个候选、需要 Owner 拍板取舍的。

小改（单包 bugfix、UI 微调、纯函数重构）不需要 spec，直接做。

## 命名与生命周期

- 文件名：`YYYY-MM-<slug>.md`（如 `2026-08-task-board.md`），一个特性一个文件。
- 每个 spec 头部维护状态行，生命周期单向流动，**留档不删**：

| 状态 | 含义 |
|---|---|
| `Draft` | Plan agent / 主 agent 起草中，内容可推翻 |
| `Final` | 定稿。实现 agent 以此开工；实现中发现 spec 错了，先改 spec 再改码 |
| `Shipped` | 实现已合并。回标状态并附 merge commit；「留真机验证项」转入 `docs/verify-queue.md` |
| `Superseded` | 被新 spec 取代，头部注明指向 |

- 模板：`specs/TEMPLATE.md`。其中「现状事实（代码已确认）」一节是硬要求——
  spec 里的每个关键断言都要有代码位置背书，这是 2026-08 task-board plan
  被证明有效的实践（实现 agent 零返工）。

## 与其他文档的关系

- 需求从 `docs/backlog.md` 来（spec 头部写关联 backlog id）；
- 验收标准在 spec 里写，shipped 后未清的真机项登记进 `docs/verify-queue.md`；
- 流程本身见 `docs/PROCESS.md`。
