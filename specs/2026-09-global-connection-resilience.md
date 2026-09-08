# 全球连接稳定性与端到端选路

> 状态：Draft（目标架构已选；新协议与各阶段开工前分别定稿）
> 日期：2026-09-08 ｜ 关联 backlog：B-380、B-381、B-382、B-383
> 授权：Owner允许重大架构升级；目标覆盖美国/新加坡用户访问美国/新加坡/马来西亚/印度机器。生产写入仍按精确目标、恢复路径和发布验收执行。

## 背景与决策

当前“daemon选一个relay，所有浏览器跟随”的模型不能同时表达两个地区浏览器的网络可达性。连接错误还混有旧机器目标、首次打开失败不能恢复等应用问题。先将身份、活性、路由与操作结果分清，再增加路径；不能用增加节点掩盖错误目标，也不能通过自动重放让一次操作变成两次。

推荐目标是**每浏览器独立选路 + daemon尝试维持两条区域路径（单可达时降级继续服务） + 执行端幂等**。首轮复用现有US/SG relay和中央路径；节点增加由美国/新加坡两侧到四类目标机器的测量决定。后续按故障域增加冗余，不把两个同宿主容器当高可用。

## 现状事实（代码已确认）

| 事实 | 位置 |
| --- | --- |
| machine relay只按daemon HTTP health的RTT选，20轮/50ms/30%迟滞；discovery与claim原先无整体deadline | `packages/happy-cli/src/api/relaySelection.ts` |
| refresh共享一个inflight promise；先关闭旧socket再建新socket | `packages/happy-cli/src/api/apiMachine.ts:1393` |
| Web machineRPC先等discovery，再做relay-ping，再发操作；丢ACK后不自动重放 | `packages/happy-web-v2/src/sync/apiSocket.ts:341` |
| relay-ping由relay自身直接应答，没有经过目标daemon | `packages/happy-server/sources/relay.ts:124`（以当前代码位置为准） |
| 每machine只有一个lease，Web只能取得这一个assignment | `packages/happy-server/sources/app/api/routes/relayRoutes.ts:63` |
| **现有云端lease已存Redis**，只有无Redis环境才内存回退；旧multi-region spec关于云端纯内存的描述已过时 | `packages/happy-server/sources/app/relay/relayRegistry.ts:64` |
| lease75秒，token10分钟，重取依赖控制面 | `packages/happy-server/sources/app/relay/relayConfig.ts`、`relayToken.ts` |
| session wrapper已连relay就直接return，不跟随daemon重新选择 | `packages/happy-cli/src/api/apiSession.ts:653` |
| terminalId仅首次open成功后赋值；首次失败后catchUp因空id直接退出 | `packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx:623,1380,1648,1677` |
| 离线机器依旧提供持久化终端条目；不同host不能合并为同一安装 | `packages/happy-web-v2/src/sync/terminalSync.ts`、`supersededMachines.ts` |
| production standalone→index启动入口原来没有启动metrics，尽管compose显式打开 | `packages/happy-server/sources/index.ts`、`ops/production/docker-compose.blue-green.yml` |
| 当前terminal output向control与一个relay双发，不能直接扩大成向所有relay广播 | `packages/happy-cli/src/api/apiMachine.ts:197` |

事故的账号、机器ID、主机名及具体活动时间只保存在任务私有报告，不进公开repo。

## 分阶段交付

### 0. 有界恢复与证据基础

B-380当前本地实现：Web discovery headers/body共用3秒；CLI discovery→并行probe→claim共用8秒（probe各2秒），取消能释放inflight，晚到响应不能驱动本地切换。claim请求已抵达服务器的远端效果不能靠客户端abort撤销，下一轮续租必须修正；新协议会把发token和发布ready lease分开。

控制/relay默认记录认证后的连接生命周期；RPC失败记录限定method、结果分类、耗时。关联id经logSafety哈希；Web版本是SHA、CLI是semver。默认无终端内容、命令、密钥、IP或UA原文。metrics按显式配置启动。此阶段不改变wire字段，旧端兼容。

下一项客户端诊断协议需要独立schema：事件由认证账号提交，目标机器所有权校验，有限enum、数值上限、严格丢弃未知字段；每次连接attemptId贯穿阶段，最多保留最近32个小事件，离线暂存恢复后合批发送；每账号/客户端限频、去重、保留期限明确。状态只记页面可见/隐藏、网络切换提示、构建版本、候选route、耗时与失败分类，不记录浏览内容。服务端没收到事件意味着未知，不意味着成功。

### 1. 目标身份、首次连接与操作恢复

UI连接状态区分：同步中、控制面未知、目标明确离线、路线不可达、目标RPC不可用、恢复中、可交互。已缓存active不是持续心跳；主站断线时进入unknown，而非把所有机器宣布死亡。

对长时间离线旧机器：保留记录，显示主机名/最后心跳与“选择在线机器”；**绝不把终端静默跳到另一台DSW**。新主机名不证明它替代旧主机。直接URL同样经过状态判定。

首次已有终端attach失败可在明确网络恢复后有界重试。阶段1独立Web交付对旧端的fresh-create ACK丢失只能标记结果未知、刷新资源列表并让用户核对，不自动重发新建意图；阶段2结果查询能力上线后才按capability自动查询和恢复。停止/输入/权限等操作各定义恢复语义。所有前台恢复仍走resumeSync统一入口，不给screen增加独立重连器。

### 2. 执行端幂等与结果查询

新操作envelope包含operationId、target machine/session、generation、method与参数digest。去重位于真正执行的daemon/wrapper，不能只在浏览器或relay内存完成。状态为pending/completed/indeterminate，重复id同digest复用结果，不同digest拒绝。

持久化边界先限定在创建/恢复终端等可核对资源身份的操作；进程在“执行成功但落盘前”死亡无法泛化成exactly-once。此时通过目标资源查询收敛，无法核对则返回indeterminate。每种操作的TTL、磁盘容量和跨generation策略独立定稿。

terminal输入单独使用writerId+inputSeq+ACK，当前活执行进程内去重，未确认输入只在该同generation且保证去重时重发。PTY写入和去重记录不能原子提交：执行端每次进程重启必须换generation，写成功而记账/ACK前崩溃时结果不确定，禁止沿用旧generation或跨generation盲目重发。输出继续seq/snapshot补洞。新建、stop、shell输入不能拿“接口超时”当作未执行。

Socket.IO本身的默认送达保证不能替代应用幂等：[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)。连接状态恢复也会失败，仍需应用补同步：[connection state recovery](https://socket.io/docs/v4/connection-state-recovery/)。

### 3. 每浏览器独立选路与先连后切

候选集合包含central以及daemon已ready的regional routes。daemon先同时维护US/SG两条控制连接，wrapper同样兼容这些路径；节点更多时限制常驻数，按需准备新路径。没有wrapper支持时session RPC继续central，不冒充daemon已升级等于所有wrapper升级。

把token签发与route可用发布分开：prepare取得限权token→连接relay→注册handlers→真实daemon probe成功→发布ready lease。lease按(machineId,generation,relayId)存Redis；generation由持机器执法锁的新执行进程取得受控epoch，控制面以CAS/fencing推进当前epoch。续租/注销必须匹配当前epoch，旧daemon晚到claim或注销不得覆盖/删除新generation；准备中的候选不能抢占ready路径，epoch变更与旧lease失效必须原子校验。旧单assignment继续作为兼容投影。

浏览器只对**无副作用的端到端probe**并行竞速，测 browser→relay→daemon→relay→browser。记录RTT分布、失败率和新鲜度；优先可达，再在稳定候选中选低延迟。不得把一次health请求的DNS/TLS耗时称作键入延迟，也不得以国别/IP定位替代测量。

每个浏览器独立决策，不重写整台机器assignment。不同浏览器能选不同relay；正常请求只发一路，故障后持原operationId查询/恢复。替代连接和订阅就绪、seq边界确认后切流，再关闭旧连接；避免重建间隙，也避免双写。

输出按实际订阅发往活跃路径，备用路径只有探活与必要控制流；会话共享输出可按relay聚合，但按用户授权隔离。慢消费者有界缓冲，落后则snapshot，不无限积压。旧端保留双发去重直到兼容窗口结束。

### 4. 控制面与节点故障容忍

分别定义SLO：已授权终端继续交互、已有授权重连、新登录/新授权、持久消息写入。已有浏览器可缓存未过期且限账号/机器/区域的凭据和候选；token过期不绕过认证。主站故障期间不能承诺新登录和写库正常。

控制面同region跨AZ部署、负载均衡、共享Redis协调以及DB/Redis failover是独立升级项。蓝绿同宿主只是发布隔离，不是宿主HA。保留polling fallback时，多实例需会话亲和与共享adapter配套：[using multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)。数据库不先引入跨洲双写；避免为终端低延迟引入新的数据冲突模型。

relay增设优先消除单地域单故障域，再根据Malaysia/India机器到US/SG的实测决定是否需要当地入口。WebRTC作为后续可关闭实验，与基线relay方案比较真实可达率及p95收益；不承担首轮可靠性承诺。

## 兼容矩阵与发布顺序

| control/relay | web | daemon/wrapper | 行为 |
| --- | --- | --- | --- |
| 旧 | 新 | 任意 | 404/缺capability退现有单路径；所有发现有deadline |
| 新 | 旧 | 新 | 保留旧single-assignment与旧event；新路径不改变旧浏览器行为 |
| 新 | 新 | 旧 | 单路径+central；禁止把旧端当作支持operationId重试 |
| 新 | 新 | 新daemon+旧wrapper | machine操作按daemon能力，session操作按wrapper能力，分别选路 |
| 新 | 新 | 新 | 多route/端到端probe/幂等操作/seq恢复 |

阶段0可先发布server/web，再单独CLI；阶段1独立Web批次。阶段2/3先部署支持新旧协议的server+relay，再Web能力门控，再CLI及新wrapper，最后按小批账号开启。每阶段feature flag与回滚到旧transport；ACK结果未知的操作不会因回滚再执行。新增权限/预算/端口/资源的生产配置在切换前列清单与恢复路径。

## 验收与目标

以下是待实测校准的验收目标，不是当前已达成的SLA：正常已认证、有可用机器与至少一条可达路径时，首次可交互p95目标≤5秒；故障后重新前台且网络可用时恢复p95目标≤10秒。跨洲键入延迟不承诺固定100ms，比较同场景最优实测路线，p95额外开销目标≤max(50ms,最优路线的20%)。

- [ ] 美国/新加坡浏览器 × 美国/新加坡/马来西亚/印度目标：每格报告样本数、首次成功率、首次交互p50/p95、echo p50/p95、重连p95。先测基线再比较升级。
- [ ] 真实浏览器：断网恢复、Wi-Fi/蜂窝切换、锁屏恢复、冷开旧URL、旧shell、首次open失败恢复。
- [ ] blackhole分别施加在browser-relay、relay-daemon、browser-control，不能只kill relay进程制造容易识别的失败。
- [ ] ACK丢失、执行端崩溃、重复operationId、digest冲突；不重复创建，不重放未知输入。
- [ ] 两个浏览器不同路径、快慢消费者、旧wrapper、token过期、控制面重启/短暂故障。
- [ ] 新路径证明ready后才公布和切换；采实际daemon probe而非relay-only ping。
- [ ] metrics真实非空可抓取且采集器命中当前host/slot，日志经过脱敏后字段仍可用于关联。
- [ ] 生产用小流量/限定账号canary，核对版本身份与实际路径；任何退化有独立回滚开关。

自动化网络故障注入用隔离本地环境；手机OS冻结/真实蜂窝切换在可重复脚本基础上补真机。缺少某地区真实测试端即标为coverage缺口，不用云主机curl冒充手机验收。
