# B-384：前台探活的可见性代次

状态：Final（主 agent 已确认限定状态扩展）；2026-09-08。

## 已确认机制与边界

`checkLiveness` 全局共享在途 Promise；5s 探活完成时不检查可见性。
因此探活中隐藏页面可触发后台主动断线；隐藏后再次显示又复用旧探活，旧结算可能干扰新前台。
这是可复现代码机制，不是 Rock 历史桌面超时的已证实根因。

## 设计

唯一 DOM 入口 `resumeSync.attachResumeListeners` 在可见性变化时递增模块内代次。
`apiSocket` 每次探活捕获代次；仅同代次且页面可见允许主动控制重连或 relay 重建。
同代次共享在途探活；新代次可以开始新探活，旧 Promise finally 不得清掉新在途记录。
真实 hidden→visible 边沿不受跨事件 1s 去抖，伴随 pageshow/online/resume 仍去抖；快速切 tab 会多一次有界刷新。
保留既有 disconnected → manager 自动恢复策略，不修改 backoff 或重放 RPC。
不用 document.hasFocus 判定，不增加 screen/平行 DOM 监听。

## 兼容、风险与验证

无 wire、server、CLI 或存储变化；旧版行为兼容，随完整镜像发布，回滚上一镜像。
既有 Socket.IO 自身后台 ping timeout 仍可断线，此变更只约束客户端主动探活动作。
测试覆盖 hidden 超时、hidden→visible 新代次、旧 finally、新前台健康不被旧 timeout 断开、relay 相同约束。
真实 Socket.IO 服务器验证旧超时被忽略后新前台 ping 成功与 socket 身份不变。

## 验证结果

- 2026-09-08：恢复/relay 四个测试文件 38 项通过，Web tsc 零错误（临时合入同批 metrics 接口验证，依赖由主 agent 集成）。
- 真实 Socket.IO：第一次 ping 不 ack，快速隐藏/显示后第二次 ping 正常；旧探活 5s 超时不触发断开，5.3s 在途 RPC 成功且 socket id 不变。
- 原真实集成测试同时覆盖断线 backoff 自动恢复、ping 过期与 recovered 语义；无证据要求改变现有 backoff 参数。
- relay 后台超时不重建；旧 finally 不清新在途；快速可见性边沿不被去抖吞掉。
- 仅检验本地机制；不能将其写成 Rock 历史故障根因，也未宣称已真机验证所有休眠模式。
