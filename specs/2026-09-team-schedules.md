# Agent Teams 持久定时

> 状态：Implementation（2026-09-09 Owner 授权 rollout 工作包 C）
> 基础：[Agent Teams](2026-09-agent-teams.md)

## 范围与语义

现有 server 持久保存 schedule，现有 daemon 每轮对账请求服务器推进本机到期项，不新增 scheduler 服务。每条 schedule 固定 Team、Bot 和 machine；Bot 换 session 后跟随同一 Bot 的新 generation，不回退最近窗口或其他机器。没有活会话时保留一条待投递消息，不自动创建替身。

支持一次性 UTC 毫秒时间戳与至少 60 秒的固定间隔，不引入 cron/timezone DSL。机器/daemon 离线后，错过多个周期合并为一次；周期仍按原到期锚点推进到服务器当前时间之后。每条最多一条未投递消息，不能因长时间离线堆积调用。积压消息 ACK 时若下一周期已过，再按原相位推进到当前时间之后，不能立刻补第二条追赶提醒。投递仍不等于模型已读或任务完成。

旧 10 分钟 tick 可迁移为指向明确负责人 Bot 的 inspect/决策提示；事实恢复仍由 daemon 每 5 秒对账。30 分钟 todo_digest 可迁移为指向同 Bot 的领域任务源提示，领域认证和 provider 映射仍属于外部 adapter，不进入 scheduler。

## 协议

TeamState 增加可选 schedules，旧记录按空数组读取。Schedule 包含 id/name/botId/machineId/body、status(active/paused/cancelled/completed)、version、nextRunAt、可选 intervalMs、pendingMessageId、lastFiredAt、fireCount 和 createdAt。每 Team 最多 64 条 active/paused 定时；另保留最近 64 条终态记录（finishedAt），总记录最多 128。旧创建 requestId 重放始终返回原 scheduleId、不重新创建；若终态记录已裁剪则 scheduleRecordRetained=false。

- schedule-create：name、botId、body、runAt（epoch ms）、可选 intervalMs。
- schedule-pause / schedule-resume / schedule-cancel：scheduleId、所见 version。
- root agent 仅能管理当前 Team 中自己 Bot 的 schedule；普通 worker 无管理权；owner 管理所有。
- POST /v1/teams/schedules/tick：账号认证、machineId；服务器时钟判定到期，事务内生成唯一消息并推进 schedule。不为无事件的轮询创建 request 记录。
- TeamMessage.taskId 允许 null，scheduleId 标识定时来源；仍使用稳定 message localId + Bot generation 和已有投递 ACK fencing。

pause/cancel 将尚未投递的对应消息标 cancelledAt，并使 daemon 停止后续投递。发送之前再读取权威消息状态；已在途的网络写不能撤回，因此暂停/取消并不承诺撤回已经送入 session 的内容。恢复周期任务从 now + intervalMs 重新计时；一次性任务若原时间已过则下轮触发。

到期消息、nextRunAt、pendingMessageId、fireCount 同一个 Serializable/CAS 事务提交。重复触发、响应丢失、daemon 重启不会重复生成同一轮。一次性 schedule 在投递 ACK 后完成；周期 schedule 收到 ACK 后允许未来轮次。归档 Team 前 schedule 必须 cancelled/completed。

## 长期运行与隔离

仅裁剪已 delivered/cancelled 的旧 schedule 消息，保留最近 64 条及所有未投递项；普通任务消息不删除。裁剪 SQL 必须同时限定 Team、scheduleId 和终态条件。schedule 保留累计 fireCount/lastFiredAt，旧消息不是无限审计仓。原有普通消息容量限制继续生效；单 Team 限额失败不阻断其他 Team 对账。

agent 仅看到自己的 schedule 与相关消息；不得因 taskId=null 放开任意收件正文。同账号其它 machine 的 tick 不推进本机 schedule。

## 兼容与验收

旧 Team 无 schedules 仍可读取。新 daemon 对旧 server 的 schedules/tick 404 只跳过定时推进，普通 Teams 对账继续；先发 server，再发 daemon，再创建 schedule。GET /v1/teams/operations 必须显式声明 schedulesVersion=1 才返回定时消息；旧 daemon 不会收到它不能正确处理的取消消息。旧 daemon 不支持新的定时投递，不能将配置成功算作已运行。

必要回归：一次性/周期时间、错过多轮、每项单待投递、并发到期幂等、重启恢复、pause/cancel 后不再新投递、旧版本操作拒绝、同 Bot 改绑、跨账号/机器/root权限、只裁剪终态定时消息、普通任务消息保留。真实旧 schedule 切换需独立停旧写者和两轮验收，本实现不操作生产定时器。
