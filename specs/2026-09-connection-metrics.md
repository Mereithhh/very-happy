# 连接诊断指标

状态：Final（B-386，主 agent 已确认实施方向）。基于浏览器连接诊断最小协议，指标是收到的浏览器遥测样本，不是所有用户连接的完整普查。

## 建议契约

新增可选字段：`relayRegion` 有限枚举 `central/sg/us/other/unknown`；`timing` 有限枚举 `active/background/censored/unknown`。旧事件缺省 unknown，旧的 300000ms 截断值不进入延迟 histogram。新客户端阶段计时使用 monotonic performance.now；唯一 resumeSync 入口调用 noteConnectionVisibility，不新增 visibility listener；期间任何页面隐藏将 timing 标成 background（保留整段墙钟意义的耗时但不混进 active 延迟），超过300000ms标censored，不假装等于300秒。

每个 attempt+stage 在浏览器仅允许一个终态 success/timeout/error/offline/cancelled；fallback是独立一次路径事件，不是第二个终态。服务端对 account+attempt+stage 的终态和 fallback 分别去重，Redis SET NX PX 900000跨副本共享，账号限频约束写入，key只含哈希并15分钟过期。Redis请求200ms硬期限，错误/不可用丢弃指标但正常接收诊断日志；配置Redis时不能降成本地计数。无Redis的独立部署用最多20000项本地TTL防重，容量满丢弃新指标且不逐出未过期项，明确仅best-effort单进程。TTL后重放仍可重新计数，故不是严格全历史SLO。timeout封口后恢复成功必须新attempt。

指标：`browser_connection_stage_results_total{stage,outcome,device_class,relay_region}`；`browser_connection_fallback_total{stage,device_class,relay_region}`；`browser_connection_stage_duration_seconds{stage,outcome,device_class,relay_region}`（只active准确值，其他timing计数单独记录）；`browser_connection_timing_samples_total{stage,timing,device_class,relay_region}`。连接成功率分别以control、relay_connect或terminal_open终态定义，不把不同阶段混成一个分母。terminal open P50/P95只统计成功active样本。回退比例按machine_rpc的fallback数 / machine_rpc终态数；仪表板明确队列丢失与不同窗口事件到达导致短窗口比例不精确。

## 兼容

新增字段全部optional。新浏览器收到旧strict server的400/422时，仅针对含扩展字段的批次降级为旧字段并重试一次（422可能是机器归属失败，无法准确识别旧schema，故最多一次兼容尝试）；403/404维持原停用策略，不改变连接业务。新server接受旧Web，timing与region为unknown，不使用旧耗时做active histogram。Web/server仍同镜像发布，兼容旧service worker与回滚。

## 安全和验证

所有Prometheus label来自枚举，不含用户/机器/attempt/SHA。防重Map只驻内存、使用哈希键、TTL清理和容量上限。保持原账号限频与归属校验先于聚合。行为测试覆盖重复终态、timeout后success、fallback重试、容量溢出、TTL、新旧字段、后台计时与截断；本地真实metrics HTTP抓取验证指标输出。提供PromQL，不声称生产Grafana已安装。

## 实际路由与查询

machine_rpc终态将实际执行路由写入同epoch attempt缓存，terminal_open终态继承；回退事件的尝试路由不能覆盖最终中央执行路由。缓存最多256项、5分钟TTL，账号/endpoint切换清空，无实际RPC完成的terminal attempt仍unknown。

```promql
# 终端打开成功率（收到且去重的终态，不含started/fallback）
sum by (device_class, relay_region) (rate(browser_connection_stage_results_total{stage="terminal_open",outcome="success"}[15m]))
/ sum by (device_class, relay_region) (rate(browser_connection_stage_results_total{stage="terminal_open"}[15m]))

# 活跃前台成功打开P95；P50把0.95换0.50
histogram_quantile(0.95, sum by (le, device_class, relay_region) (rate(browser_connection_stage_duration_seconds_bucket{stage="terminal_open",outcome="success"}[15m])))

# 阶段失败
sum by (stage, outcome, device_class, relay_region) (rate(browser_connection_stage_results_total{outcome!="success"}[15m]))

# machine RPC回退比（按设备，fallback尝试region与最终执行region不能直接同维度相除）
sum by (device_class) (rate(browser_connection_fallback_total{stage="machine_rpc"}[15m]))
/ sum by (device_class) (rate(browser_connection_stage_results_total{stage="machine_rpc"}[15m]))

# 回退按尝试region归因
sum by (device_class, relay_region) (rate(browser_connection_fallback_total{stage="machine_rpc"}[15m]))

# 后台/旧端/截断的样本单独展示，不能当作真实前台延迟
sum by (stage, timing, device_class, relay_region) (rate(browser_connection_timing_samples_total[15m]))
```

并未部署Grafana仪表板。以上PromQL可应用于已配置抓取的Prometheus。

聚合丢弃另由 `browser_connection_metrics_skipped_total{code}` 呈现：`coordination_unavailable`、`coordination_timeout`与`unclaimed`（重复或本地容量）。诊断endpoint以Promise.all并发聚合32项，Redis200ms是批次并发上限而非逐项累加。

回退定义为machine_rpc尝试regional而最终走central的兼容路径比例，包含discovery失败、连接失败、cooldown、无assignment或preflight失败；不是故障率，无assignment不能推断故障。未知尝试region=unknown，终态actualRegion=central。

可导入看板：`docs/monitoring/connection-quality.dashboard.json`（10个面板），采集接线及口径见同目录 README。提供配置不等于生产Grafana已接入。
