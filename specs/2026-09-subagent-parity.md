# 子代理模型与执行过程对齐

状态：实现已合入 [PR #352](https://github.com/Mereithhh/very-happy/pull/352)，Web/Server 于 2026-09-11 上线 `f726b440`；CLI 发布标签 `v0.2.135` 指向同一提交。

## 数据约定

- `text.actualModel?: string` 仅来自有明确 parent linkage 的 assistant.message.model，不从主会话模型猜测。
- 请求模型从原始 Agent/Task tool input.model 读取，界面明确标为请求模型；没有值不猜默认模型。
- SDK 开启 forwardSubagentText，保留 parent_tool_use_id 归属；子代理 partial 不注入主对话草稿。最终文本块通过既有归属映射呈现。
- 主链路和子代理复用 ActivityMessages：相邻完成命令合并；运行、失败与中间正文独立展示。

## 双向兼容与发布顺序

actualModel 为可选字符串。旧 Web 忽略新字段，新 Web 对旧 CLI 不显示实际模型；不迁移历史数据。先 Server/Web 后 CLI。模型随子代理正文进入消息元数据 reportedModel，不发伪造 start；生命周期状态不因补模型字段改变，重复/乱序事件保留新状态。

## 核验范围

Claude SDK 与 CLI print-mode 先前各一次后台 Bash 测试成功，不等于交互 CLI 全能力对齐。Codex 父调用基础映射与 Pi 普通 tool-call 不是完整子代理支持；需核验运行时事件后再扩展，不按工具名随意伪造父子关系或完成状态。

## 2026-09-11 实测与边界

SDK 0.3.232 隔离 query 单次实跑：主助手 model=claude-opus-5；Agent definition 请求 haiku；带 parent_tool_use_id 的 assistant 回报 claude-haiku-4-5-20251001，包含 47 字符 thinking 和 11 字符正文，最终 success。证明 forwardSubagentText 能提供子代理内容及实际模型；不表示所有提供方均返回 thinking。

本机 Codex 生成的 app-server schema 明确区分 collabAgentToolCall.status 与 agentsStates。补齐 live/history 的协作工具调用展示，model 标作请求字段；不会将 spawn 调用 completed 伪装为子代理 completed。子线程按需通过 codex-child-read RPC 读取并每 5 秒刷新，先验证当前父线程的明确关联，禁止任意账户线程读取。正文及工具复用主链路 ActivityMessages。

本机 /opt/homebrew/lib/node_modules/pi-acp/dist/index.js 将 tool_execution_* 转成普通 tool_call/update，未找到统一 parent/subagent 事件。Pi 子代理需要按实际扩展协议适配；已向用户询问扩展/会话，不按名字或自由文本伪造结构化子代理状态。

本地验证：Web 2798 项、wire 82 项、相关 CLI 48 项通过；Web/CLI 类型检查与构建通过，320/390px coarse 及桌面明暗主题验证模型标签和任务说明无横向溢出。尚未发布；Pi 扩展事件仍未适配，不得在更新说明中声称全 Agent 子代理能力对齐。后续新增实现与核验见下文。

后台 Bash 补充：隔离 SDK 实跑再次确认 local_bash task_started/tool_use_id 与 Bash call id 一致，task_notification 使用相同关联。现在仅登记本进程见过的 Bash，并在收到明确 local_bash start 后启用生命周期；通过既有可选 subagentType=background-command 区分任务种类。启动 tool_result 不发 stop；主会话的停止事件也不推断后台进程已结束。任务条以后台命令标识，不计入子代理数量。完成通知关闭运行入口，未知调用保持忽略。旧 Web 可能仍将生命周期文字称为子代理，发布先 Web 后 CLI。

预览入口：open_preview 工具调用特化为现有文件预览按钮；会话输入区保留预览记录，来源为持久化 tool calls，按路径去重并递归子代理。已发现路径在本设备按 session id 缓存，关闭 overlay 不删除入口；不同设备和从未加载的旧页不冒充已完整索引。使用原有 machine RPC 权限和文件预览，不保存文件正文。localStorage 不可用时仍可查看当前已加载记录。

Codex 真实 app-server 隔离探针：当前原生子代理由 subAgentActivity.agentThreadId 暴露，等待调用可能 receiverThreadIds=[]。新增此关联兼容；n=1 成功读取子线程 agentMessage（11 字符），父任务 completed。子线程 archive 返回 no rollout，说明该子线程不能视为已持久化：本实现依赖原 wrapper 的 app-server 可读取性，关闭后可能无法重开。读取失败显式显示错误，不伪造空成功。浏览器模拟 RPC 验证正文及运行命令在 320/390px coarse、1200px、明暗主题展示，无横向溢出；不冒充生产 RPC 实测。

最终本地回归：Web 2801 项通过；本次 Codex reader/mapper 与 Claude lifecycle 21 项通过，之前 SDK forward/model 等相关 48 项及 wire 82 项通过。Web/CLI tsc 退出码 0，Web 构建通过，CLI 构建产物 --version 可运行。代码未发布。

2026-09-11 后续核验：通过 SSH 在 mac-office 的 settings.packages 确认 npm:pi-subagents，并核对安装 package.json 为 0.66.0、入口 index.ts、仓库 nicobailon/pi-subagents；开发机未安装此扩展。适配对象已明确，不再依赖用户提供扩展名。当前本机 pi-acp 会在普通工具更新中透传 rawOutput，因此应检查扩展的结构化 details，再做映射；不能把 ACP 没有原生 subagent 类型推断成扩展数据必然不可用。尚未完成此扩展的生命周期适配。
字号核验：任务名称与运行状态由 12/11px 改为 conversation-size，css-probe 确认桌面 14px、320/390px coarse 15px，浏览器三尺寸明暗主题交互无溢出。

发布前链路回归：SDK converter → OutgoingMessageQueue → mapper 按顺序透传 task_started/updated/progress/notification，其他 system 帧仍过滤；延迟的 tool call 不被生命周期事件超越。Codex live 开始/完成快照用不同 envelope ID，保留相同 call ID；Web 更新已知接收线程列表，历史回填不擦掉新快照。嵌套子线程仅展示本地可读详情，不把其局部消息 ID 送入父会话索引。运行入口复用当前 turn、在线/心跳与归档判据，失活时隐藏入口，不推断任务已完成。

发布核验：完整镜像切换成功，线上 entry 与本批预览/运行控制资源均为 f726b440；保留旧页面实测 controllerchange 后加载新 entry，无 pageerror。回滚保留 4d267c4d 镜像。CLI 由 [tag publish workflow](https://github.com/Mereithhh/very-happy/actions/runs/34513241036) 与 [六平台 smoke](https://github.com/Mereithhh/very-happy/actions/runs/34513241048) 发布和提升推荐版本；自动安装 pin 独立，现有 wrapper 不热加载。上述本地验证记录均为发布前证据，不等同于官方 CLI 全能力等价。
