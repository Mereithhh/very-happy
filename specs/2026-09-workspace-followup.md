# 工作台反馈修复：归档与上下文读数

状态：Final · 2026-09-10 · B-435

## 已核实现状

- Web `AgentInput.tsx` 从 reducer.latestUsage 计算上下文，缺失回退 0；`contextWindow.ts` 对所有非 1M 模型猜 200k。
- CLI `runAcp.ts` 仅将 ACP prompt usage 送累计计费；本机 pi-acp 的 prompt 只返回 stopReason。pi 的 `ctx.getContextUsage()` 返回当前估算 tokens（压缩后可为 null）及真实 contextWindow。
- `teams/reducer.ts` 归档前禁止未完成任务、调度和清理；顶层又禁止归档后所有操作。`store.ts` 的 machine 查询排除归档团队，不能只移除按钮限制。

## 实现约定

pi extension 在 session/model/turn/compaction 事件读取 getContextUsage，通过本会话独立随机凭据的 loopback telemetry URL 上报。非模型工具，不注册为 MCP tool；限制 JSON 大小、数值、来源。CLI 写 agentState.contextUsage（source、tokens nullable、contextWindow、updatedAt）；Web 对 pi 只用此字段，不借用累计计费或旧消息用量；缺失/压缩未知显示 —，估算显示 ≈。旧 CLI 没有字段时诚实缺省。其他 backend 不改计费语义；非 Claude 且没有明确容量标记的模型不再猜 200k 分母，只展示已知 token 数。

归档是 owner 显式操作：取消未完成任务及未来调度，阻止新任务，按既有 managed 标记安排停止；不停止用户自己接入的 session，不删除工作目录。已认领 spawn 的晚到完成仍可入库并生成 stop。归档团队从普通列表隐藏，但 daemon 仍能读取、认领/完成/失败/人工解决原有操作并回报 session-event。详情保留清理状态和恢复操作，归档不等于清理成功。

文件入口默认目录浏览；保留预览、目录选择、排序、隐藏文件、错误与全屏能力。增加加载式文件树与当前已加载条目过滤，预览与树可并排，窄屏回退单栏。

## 兼容与顺序

无数据库迁移。agentState 新字段可选，旧 Web 忽略；新 Web + 旧 CLI 显示未知。新 server 继续兼容旧 daemon 的既有 action；归档团队的待执行操作仅发给 query teamArchiveVersion=1 的新 daemon，新 daemon 停止会话但保留工作树（旧 daemon 可能清理干净工作树，故不能执行新归档操作）；先 server/Web 后 CLI，最后更新 daemon，新 pi 会话加载新 extension，已有 wrapper 不热换。

## 验证

覆盖归档取消与保留、晚到 spawn、stop 回执、离线清理、未管理 session；pi 未知/压缩/模型切换与异常上报；UI 明暗、桌面、320/390 coarse 的对齐、菜单、文件树/预览与状态保存。发布使用完整门禁及精确 SHA 验收。

## 本地验收记录

- Web 2,740、CLI 2,082、wire 82、server 644 项通过（server 原有条件跳过 1 项）；四包构建/类型检查通过。数据库初始化的并发负载超时在单独重跑后消失，没有放宽超时门槛。
- Chromium 明暗主题 × 1280/390/320：真实登录态下的侧栏搜索、新建菜单、团队归档与刷新后持久化通过；菜单贴合触发器，页面无横向溢出。
- 文件树/筛选/返回预览的组件浏览器验证使用明确的本地 RPC 示例；目录选择与视图隔离回归通过。加载槽在真实 ChatList 中不跳动，自动跟随与用户上翻暂停均通过。
- CSS probe：状态行桌面从左右各越出 26px 改为 0，手机同输入区 12px 内边距；负责人聊天按钮从 41px 改为 32px，触屏保留 44px。Pi 浏览器验证：32,768/131,072 → 25%，压缩未知 → —，换 1M 容量 → 重新计算。

## 回滚边界

Web/server 可切回上一完整镜像，CLI 可重新安装上一固定版本；不回写团队记录、不撤销已完成的取消/停止。若新归档尚有待清理操作，旧 server 的归档门禁不会继续派发它们：保留记录，恢复支持本协议的镜像后继续清理；不能以解除 archivedAt 或删除 operation 代替恢复。已经在归档前开始的旧清理仍按原有授权执行，保留工作树约定针对本次归档新发起的停止操作。
